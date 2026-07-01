import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toFindingRow } from "../dist/db/record.js";
import { MetadataStore } from "../dist/db/store.js";

// The SQLite metadata store is the system of record for run TRACKING: projects, run
// lifecycle, scope coverage, findings, and their status transitions. These pin that a
// run's metadata is queryable and that status changes land on a timeline.

async function tempDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-db-"));
  return new MetadataStore(path.join(dir, "flounder.db"));
}

async function tempDbPath() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-db-"));
  return { dir, dbPath: path.join(dir, "flounder.db") };
}

test("store: project + run lifecycle is recorded and queryable", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "acme", sourcePaths: ["./src"], buildRoot: ".", config: { model: "gpt-5.5", thinking: "xhigh" } });
  const project = db.getProject("acme");
  assert.match(String(project.uuid), /^[0-9a-f-]{36}$/);
  assert.equal(project.dir, project.uuid);
  assert.equal(db.getProjectByRef(String(project.uuid)).id, projectId);
  assert.equal(db.getProjectByRef("acme"), undefined); // public project refs are UUID-only
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/acme-1", provider: "openai-codex", model: "gpt-5.5" });

  let runs = db.listRuns(projectId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "running");
  assert.equal(runs[0].ended_at, null);

  db.finishRun(runId, "done", { total: 10, audited: 4, pending: 6 }, 3);
  runs = db.listRuns(projectId);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].scopes_audited, 4);
  assert.equal(runs[0].findings_total, 3);
  assert.ok(runs[0].ended_at);

  // upsertProject is idempotent by name (refreshes config, keeps the id)
  const uuid = String(project.uuid);
  assert.equal(db.upsertProject({ name: "acme", config: { model: "opus" } }), projectId);
  assert.equal(db.getProjectById(projectId).uuid, uuid);
  assert.equal(db.getProjectById(projectId).dir, uuid);
  assert.equal(db.listProjects().length, 1);
  db.close();
});

test("store: scope coverage tracks mapped vs audited", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  db.upsertScopes(projectId, [
    { scopeId: "s1", title: "decode", status: "audited" },
    { scopeId: "s2", title: "settle", status: "pending" },
    { scopeId: "s3", title: "withdraw", status: "pending" },
    { scopeId: "s4", title: "execute", status: "auditing" },
  ]);
  assert.deepEqual(db.scopeProgress(projectId), { total: 4, audited: 1, pending: 3, deferred: 0 });
  assert.equal(db.countScopesByStatus(projectId, "auditing"), 1);

  // re-mapping the same scope id updates it in place (one row per project+scope)
  db.upsertScopes(projectId, [{ scopeId: "s2", title: "settle", status: "audited" }]);
  assert.deepEqual(db.scopeProgress(projectId), { total: 4, audited: 2, pending: 2, deferred: 0 });
  db.close();
});

test("store: stage timing preserves startedAt across updates", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/p-1" });

  db.recordStage(runId, "synthesis", { status: "running", scopes: 12, pool: 4 });
  const running = JSON.parse(String(db.listRuns(projectId)[0].stages_json)).synthesis;
  assert.equal(running.status, "running");
  assert.equal(running.scopes, 12);
  assert.equal(running.pool, 4);
  assert.ok(running.startedAt);

  db.recordStage(runId, "synthesis", { status: "done", produced: 2 });
  const done = JSON.parse(String(db.listRuns(projectId)[0].stages_json)).synthesis;
  assert.equal(done.status, "done");
  assert.equal(done.produced, 2);
  assert.equal(done.scopes, 12);
  assert.equal(done.pool, 4);
  assert.equal(done.startedAt, running.startedAt);
  assert.ok(done.at);
  db.close();
});

test("store: discovery health and backlog are persisted and operator-actionable", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "discovery-project" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/discovery-1" });

  db.recordRunHealth(runId, {
    status: "needs-resource",
    reasons: ["1 resource request blocks confirmation"],
    signals: { toolSteps: 9, resourceRequests: 1 },
  });
  db.replaceScopes(projectId, [
    { scopeId: "S1", title: "Withdrawals must bind signer", location: "src/Vault.sol:10", status: "pending", source: "followup", parentScopeId: "S0" },
  ]);
  db.replaceDiscoveryBacklog(projectId, runId, [
    { kind: "coverage-gap", status: "open", scopeId: "S1", title: "Replay domain not audited", location: "src/Vault.sol:10", reason: "Budget ended first", nextAction: "Dig the follow-up scope", priority: "high", payload: { id: "G1" } },
    { kind: "resource-request", status: "open", title: "Foundry cache", location: "dependency", reason: "Build needs dependency install", nextAction: "Run forge install", priority: "high", payload: { id: "R1" } },
  ]);

  const health = db.latestRunHealth(projectId);
  assert.equal(health.health_status, "needs-resource");
  assert.deepEqual(JSON.parse(health.health_reasons_json), ["1 resource request blocks confirmation"]);
  assert.equal(JSON.parse(health.health_signals_json).toolSteps, 9);

  const scope = db.listScopes(projectId)[0];
  assert.equal(scope.source, "followup");
  assert.equal(scope.parent_scope_id, "S0");

  assert.deepEqual(db.discoveryBacklogCounts(projectId), {
    total: 2,
    open: 2,
    "coverage-gap:open": 1,
    "coverage-gap": 1,
    "resource-request:open": 1,
    "resource-request": 1,
  });
  const resource = db.listDiscoveryBacklog(projectId, { kind: "resource-request", status: "open" })[0];
  assert.equal(resource.title, "Foundry cache");
  assert.equal(JSON.parse(resource.payload_json).id, "R1");

  assert.equal(db.setDiscoveryBacklogStatus(resource.id, "resolved"), true);
  assert.equal(db.discoveryBacklogCounts(projectId)["resource-request:resolved"], 1);
  assert.equal(db.discoveryBacklogCounts(projectId).open, 1);

  db.deleteRun(runId);
  assert.equal(db.latestRunHealth(projectId), undefined);
  assert.equal(db.discoveryBacklogCounts(projectId).total, 0);
  assert.equal(db.listScopes(projectId).length, 1);
  db.close();
});

test("store: finding status transitions land on a timeline", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/p-1" });

  // first sighting → suspected (from null)
  db.upsertFindings(projectId, runId, [{ findingKey: "F1", title: "unbound input", status: "suspected" }]);
  // promoted by the differential gate
  db.upsertFindings(projectId, runId, [{ findingKey: "F1", title: "unbound input", status: "confirmed-differential" }], "differential passed");
  // later refuted by the skeptic
  db.upsertFindings(projectId, runId, [{ findingKey: "F1", title: "unbound input", status: "refuted" }], "vacuous PoC");

  const findings = db.listFindings(projectId);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "refuted");

  const timeline = db.findingTimeline(findings[0].id);
  assert.deepEqual(timeline.map((e) => [e.from_status, e.to_status]), [
    [null, "suspected"],
    ["suspected", "confirmed-differential"],
    ["confirmed-differential", "refuted"],
  ]);
  // an unchanged re-upsert adds no event
  db.upsertFindings(projectId, runId, [{ findingKey: "F1", title: "unbound input", status: "refuted" }]);
  assert.equal(db.findingTimeline(findings[0].id).length, 3);
  db.close();
});

test("record: verify REFUTED verdicts become structured refuted rows", () => {
  const base = {
    id: "f1",
    severity: "info",
    location: "src/Foo.sol:1",
    description: "description",
    evidence: "evidence",
    exploitSketch: "exploit",
    fix: "fix",
    confidence: 0.8,
    confirmationStatus: "suspected",
  };
  const refuted = toFindingRow({ ...base, title: "REFUTED: Unbound input is guarded" }, "/runs/verify");
  const clean = toFindingRow({ ...base, title: "Unbound input is guarded" }, "/runs/verify");

  assert.equal(refuted.status, "refuted");
  assert.equal(refuted.title, "Unbound input is guarded");
  assert.equal(refuted.findingKey, clean.findingKey);

  const needsEvidence = toFindingRow({ ...base, title: "External key provenance is unresolved", originId: 123 }, "/runs/verify");
  assert.equal(needsEvidence.status, "needs-evidence");
});

test("store: startup migration repairs verify artifact refutations and report run ids", async () => {
  const { dir, dbPath } = await tempDbPath();
  const oldRunDir = path.join(dir, "old-run");
  const verifyRunDir = path.join(dir, "verify-run");

  let db = new MetadataStore(dbPath);
  const projectId = db.upsertProject({ name: "legacy-verify-project" });
  const oldRunId = db.startRun({ projectId, kind: "run", runDir: oldRunDir });
  const verifyRunId = db.startRun({ projectId, kind: "audit", runDir: verifyRunDir, budgets: { verify: true } });
  db.finishRun(oldRunId, "done");
  db.finishRun(verifyRunId, "done");
  db.upsertFindings(projectId, oldRunId, [
    { findingKey: "legacy-refuted", title: "Opaque libraries are bytecode-only", location: "manifest.json:1", severity: "high", status: "suspected" },
    { findingKey: "legacy-evidence", title: "Verifier key provenance is unresolved", location: "manifest.json:2", severity: "high", status: "suspected" },
    {
      findingKey: "legacy-confirmed",
      title: "Confirmed rerun finding",
      location: "src/Foo.sol:2",
      severity: "medium",
      status: "confirmed-differential",
      reportPath: path.join(verifyRunDir, "report_f2.md"),
    },
  ]);
  const refutedBefore = db.queryFindings(projectId, { search: "Opaque libraries" })[0];
  const needsEvidenceBefore = db.queryFindings(projectId, { search: "Verifier key provenance" })[0];
  const confirmedBefore = db.queryFindings(projectId, { search: "Confirmed rerun" })[0];
  assert.equal(refutedBefore.status, "suspected");
  assert.equal(needsEvidenceBefore.status, "suspected");
  assert.equal(confirmedBefore.run_id, oldRunId);

  await mkdir(verifyRunDir, { recursive: true });
  await writeFile(
    path.join(verifyRunDir, "audit_hypotheses.json"),
    JSON.stringify([
      {
        id: "h1",
        originId: Number(refutedBefore.id),
        title: "REFUTED: Opaque libraries are bytecode-only",
        severity: "info",
        location: "manifest.json:1",
        description: "The library source and generated bytecode match.",
        evidence: "Local regeneration matched the deployed bytecode.",
        exploitSketch: "No attacker-triggerable issue.",
        fix: "No security fix required.",
        confidence: 0.92,
      },
      {
        id: "h2",
        originId: Number(needsEvidenceBefore.id),
        title: "Verifier key provenance is unresolved",
        severity: "high",
        location: "manifest.json:2",
        description: "The local source was reviewed but the deployed key cannot be bound without setup artifacts.",
        evidence: "The verify artifact records the exact missing external evidence.",
        exploitSketch: "If the key was generated from another circuit, invalid proofs may verify.",
        fix: "Publish the R1CS/zkey/vkey/proving transcript hashes.",
        confidence: 0.81,
        confirmationStatus: "suspected",
      },
    ]),
  );
  db.close();

  db = new MetadataStore(dbPath);
  const refutedAfter = db.getFinding(Number(refutedBefore.id));
  assert.equal(refutedAfter.status, "refuted");
  assert.equal(refutedAfter.title, "Opaque libraries are bytecode-only");
  assert.equal(refutedAfter.severity, "info");
  assert.equal(refutedAfter.run_id, verifyRunId);
  assert.equal(refutedAfter.evidence, "Local regeneration matched the deployed bytecode.");
  assert.ok(db.findingTimeline(Number(refutedBefore.id)).some((event) => event.from_status === "suspected" && event.to_status === "refuted"));

  const needsEvidenceAfter = db.getFinding(Number(needsEvidenceBefore.id));
  assert.equal(needsEvidenceAfter.status, "needs-evidence");
  assert.equal(needsEvidenceAfter.run_id, verifyRunId);
  assert.equal(needsEvidenceAfter.evidence, "The verify artifact records the exact missing external evidence.");
  assert.ok(db.findingTimeline(Number(needsEvidenceBefore.id)).some((event) => event.from_status === "suspected" && event.to_status === "needs-evidence"));

  const confirmedAfter = db.getFinding(Number(confirmedBefore.id));
  assert.equal(confirmedAfter.run_id, verifyRunId);
  db.close();
});

test("store: finding aggregates + pagination + filter scale to many findings", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "big" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/big-1" });
  const statuses = ["confirmed-differential", "suspected", "refuted"];
  const rows = [];
  for (let i = 0; i < 120; i++) rows.push({ findingKey: "f" + i, title: "finding " + i + " in gadget", location: "src/c.rs:" + i, status: statuses[i % 3] });
  db.upsertFindings(projectId, runId, rows);

  // aggregate counts (one GROUP BY, used by the dashboard snapshot)
  assert.equal(db.countFindings(projectId), 120);
  assert.equal(db.findingStatusCounts(projectId)["suspected"], 40);

  // pagination: first page of 50, then the next page
  assert.equal(db.queryFindings(projectId, { limit: 50, offset: 0 }).length, 50);
  assert.equal(db.queryFindings(projectId, { limit: 50, offset: 100 }).length, 20);

  // status filter + filtered total
  assert.equal(db.countFindings(projectId, { status: "refuted" }), 40);
  assert.ok(db.queryFindings(projectId, { status: "refuted", limit: 10 }).every((r) => r.status === "refuted"));

  // text search over title/location
  assert.equal(db.countFindings(projectId, { search: "gadget" }), 120);
  assert.equal(db.countFindings(projectId, { search: "src/c.rs:7" }), 11); // :7, :70..:79
  db.close();
});

test("store: startup reconciles orphaned running runs (in-process runs don't survive a restart)", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  db.startRun({ projectId, kind: "run", runDir: "/runs/p-1" }); // left running
  db.finishRun(db.startRun({ projectId, kind: "run", runDir: "/runs/p-2" }), "done");
  assert.equal(db.reconcileOrphanedRuns(), 1); // only the still-running one
  assert.equal(db.listRuns(projectId).filter((r) => r.status === "running").length, 0);
  assert.equal(db.reconcileOrphanedRuns(), 0); // idempotent
  db.close();
});

test("store: deleteRun removes run-scoped data but keeps the project's scopes", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  db.upsertScopes(projectId, [{ scopeId: "s1", status: "audited" }, { scopeId: "s2", status: "pending" }]);
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/p-1" });
  db.upsertFindings(projectId, runId, [{ findingKey: "f1", title: "x", status: "suspected" }]);
  db.finishRun(runId, "done");

  assert.equal(db.deleteRun(runId), true);
  assert.equal(db.listRuns(projectId).length, 0);
  assert.equal(db.countFindings(projectId), 0); // run-scoped findings gone
  assert.equal(db.scopeProgress(projectId).total, 2); // project scopes kept
  assert.equal(db.deleteRun(runId), false); // already gone
  db.close();
});

test("store: setScopeStatus marks a scope deferred (skipped) and counts it", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  db.upsertScopes(projectId, [{ scopeId: "s1", status: "pending" }, { scopeId: "s2", status: "pending" }]);
  assert.equal(db.setScopeStatus(projectId, "s1", "deferred"), 1);
  assert.deepEqual(db.scopeProgress(projectId), { total: 2, audited: 0, pending: 1, deferred: 1 });
  db.close();
});

test("store: daemon tokens + job queue (claim is FIFO and one-shot; cancel is observable)", async () => {
  const db = await tempDb();
  const { token } = db.createDaemonToken("local");
  const { token: otherToken } = db.createDaemonToken("remote");
  assert.ok(db.getDaemonByToken(token)); // valid token authenticates
  assert.equal(db.getDaemonByToken("nope"), undefined); // unknown token rejected
  const daemonId = Number(db.getDaemonByToken(token).id);
  const otherDaemonId = Number(db.getDaemonByToken(otherToken).id);

  const j1 = db.enqueueJob("proj", { verb: "run" });
  const pinned = db.enqueueJob("proj", { verb: "audit" }, otherDaemonId);
  const j2 = db.enqueueJob("proj", { verb: "map" });
  const claim1 = db.claimJob(daemonId);
  assert.equal(claim1.id, j1); // FIFO
  assert.deepEqual(claim1.spec, { verb: "run" });
  assert.equal(db.getJob(j1).status, "dispatched");
  assert.equal(db.claimJob(daemonId).id, j2);
  assert.equal(db.claimJob(daemonId), undefined); // queue drained
  assert.equal(db.claimJob(otherDaemonId).id, pinned); // pinned work waits for its selected daemon

  db.requestJobCancel(j1);
  assert.deepEqual(db.canceledJobIds(), [j1]); // a daemon polls this to abort
  db.setJobStatus(j1, "killed");
  assert.deepEqual(db.canceledJobIds(), []); // no longer running → not reported
  assert.equal(db.cancelJob(pinned), true); // queued/dispatched/running jobs are operator-cancelable
  assert.equal(db.getJob(pinned).status, "canceled");
  db.close();
});

test("store: local auto-daemon token is stable across UI restarts", async () => {
  const db = await tempDb();
  const first = db.getOrCreateLocalDaemonToken();
  assert.equal(first.reused, false);
  const again = db.getOrCreateLocalDaemonToken();
  assert.equal(again.reused, true);
  assert.equal(again.id, first.id);
  assert.equal(again.token, first.token);
  db.close();
});

test("store: local auto-daemon reuse prefers the daemon selected by projects", async () => {
  const db = await tempDb();
  const selected = db.createDaemonToken("local-100");
  const newer = db.createDaemonToken("local-200");
  db.upsertProject({ name: "pinned", daemonId: selected.id });
  const picked = db.getOrCreateLocalDaemonToken();
  assert.equal(picked.id, selected.id);
  assert.equal(picked.token, selected.token);
  assert.notEqual(picked.id, newer.id);
  db.close();
});

test("store: daemons list newest heartbeat first so UI defaults to an online executor", async () => {
  const db = await tempDb();
  const { token: staleToken } = db.createDaemonToken("stale-local");
  const { token: currentToken } = db.createDaemonToken("current-local");
  const staleId = Number(db.getDaemonByToken(staleToken).id);
  const currentId = Number(db.getDaemonByToken(currentToken).id);
  db.touchDaemon(staleId, { providers: [] }, "/tmp/stale");
  await new Promise((resolve) => setTimeout(resolve, 5));
  db.touchDaemon(currentId, { providers: [] }, "/tmp/current");

  const daemons = db.listDaemons();
  assert.equal(daemons[0].id, currentId);
  assert.equal(daemons[1].id, staleId);
  db.close();
});

test("store: confirm decisions are replaced per run, not duplicated", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const runId = db.startRun({ projectId, kind: "confirm", runDir: "/runs/p-confirm-1" });
  db.upsertConfirmDecisions(projectId, runId, [
    { bug: "A", reproduced: "yes", recommendation: "submit-candidate" },
    { bug: "B", reproduced: "no", recommendation: "drop" },
  ], "/runs/p-confirm-1/confirm_report.md");
  assert.equal(db.listConfirmDecisions(projectId).length, 2);
  // a re-run of confirm rewrites the sheet wholesale
  db.upsertConfirmDecisions(projectId, runId, [{ bug: "A", reproduced: "yes", recommendation: "submit-candidate" }]);
  assert.equal(db.listConfirmDecisions(projectId).length, 1);
  db.close();
});

test("store: confirm decisions persist decision reports without overwriting linked finding reports", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/p-audit-1" });
  db.upsertFindings(projectId, auditRun, [
    {
      findingKey: "kabc123",
      title: "Missing verifier binding",
      severity: "high",
      status: "confirmed-executable",
      description: "The verifier accepts an unbound value.",
    },
  ]);
  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/p-confirm-1" });
  db.upsertConfirmDecisions(projectId, confirmRun, [
    {
      bug: "Missing verifier binding",
      reproduced: "yes",
      recommendation: "submit-candidate",
      members: ["kabc123"],
      reproEvidence: "purpose=confirm command cmd_1 reproduced the real target effect",
      reproCommandId: "cmd_1",
      novelty: "novel",
      humanGates: "venue scope still needs human review",
      reportMarkdown: "# Missing verifier binding\n\n## Summary\nFormal report.",
    },
  ]);

  const [finding] = db.listFindings(projectId);
  assert.equal(finding.confirm_status, "reproduced");
  assert.equal(finding.report_markdown, null);
  const [decision] = db.listConfirmDecisionsForFinding(projectId, "kabc123");
  assert.equal(decision.repro_evidence, "purpose=confirm command cmd_1 reproduced the real target effect");
  assert.equal(decision.repro_command_id, "cmd_1");
  assert.equal(decision.novelty, "novel");
  assert.equal(decision.human_gates, "venue scope still needs human review");
  assert.equal(decision.severity, "high");
  assert.equal(decision.evidence_level, "real-target-reproduced");
  assert.equal(decision.submission_confidence, "medium");
  assert.match(decision.report_markdown, /^# Missing verifier binding/);
  db.close();
});

test("store: source-level confirm evidence is not promoted to real-target submission confidence", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/p-audit-1" });
  db.upsertFindings(projectId, auditRun, [
    {
      findingKey: "ksourceonly",
      title: "Mock-backed source reproduction",
      severity: "high",
      status: "confirmed-executable",
    },
  ]);
  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/p-confirm-1" });
  db.upsertConfirmDecisions(projectId, confirmRun, [
    {
      bug: "Mock-backed source reproduction",
      reproduced: "yes",
      recommendation: "submit-candidate",
      members: ["ksourceonly"],
      reproEvidence: "Forge harness used published source and constrained mocks; this was source-level execution, not a live fork.",
      humanGates: "Needs current deployment review and bounty eligibility confirmation.",
    },
  ]);

  const [decision] = db.listConfirmDecisions(projectId);
  assert.equal(decision.evidence_level, "source-only-local-confirmed");
  assert.equal(decision.submission_confidence, "low");
  const [finding] = db.listFindings(projectId);
  assert.equal(finding.confirm_status, null);
  db.close();
});
