import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("store: pre-release evaluation tables upgrade before current indexes are created", async () => {
  const { dbPath } = await tempDbPath();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE run_group(
      id INTEGER PRIMARY KEY,
      uuid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      config_json TEXT,
      budget_json TEXT,
      summary_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE work_item(
      id INTEGER PRIMARY KEY,
      uuid TEXT NOT NULL UNIQUE,
      run_group_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      outcome TEXT,
      target_bundle_json TEXT,
      material_policy_json TEXT,
      evidence_gate_json TEXT,
      result_json TEXT,
      project_id INTEGER,
      run_id INTEGER,
      finding_id INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(run_group_id, item_key)
    );
    CREATE TABLE work_item_attempt(
      id INTEGER PRIMARY KEY,
      work_item_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      job_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_item_id, attempt_number),
      UNIQUE(job_id)
    );
    INSERT INTO run_group(id, uuid, name, kind, state, created_at, updated_at, finished_at)
    VALUES (1, 'legacy-group', 'legacy evaluation', 'evaluation', 'finished', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z');
    INSERT INTO work_item(id, uuid, run_group_id, item_key, kind, state, outcome, target_bundle_json, material_policy_json, evidence_gate_json, result_json, created_at, updated_at, finished_at)
    VALUES (1, 'legacy-item', 1, 'case-1', 'benchmark-case', 'finished', 'no_findings',
      '{"target":"legacy","targetClass":"logic","sourcePaths":["src"],"corpusPaths":[]}',
      '{"posture":"blind","materials":[]}',
      '{"kind":"benchmark-oracle","expectedOutcome":"reject-positive","requiresDifferential":false,"requiresRefutation":true,"networkPolicy":"sealed"}',
      '{"accepted":true}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z');
  `);
  legacy.close();

  const store = new MetadataStore(dbPath);
  const group = store.getRunGroupByUuid("legacy-group");
  assert.equal(group.parallelism, 1);
  assert.equal(group.ended_at, "2026-01-01T00:01:00.000Z");
  const item = store.getWorkItem(1);
  assert.equal(item.job_id, null);
  assert.equal(item.ended_at, "2026-01-01T00:01:00.000Z");
  assert.match(String(item.evidence_contract_json), /reject-positive/);
  assert.deepEqual(store.listWorkItemAttempts(1), []);
  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  const attemptColumns = migrated.prepare("PRAGMA table_info(work_item_attempt)").all().map((row) => row.name);
  migrated.close();
  assert.equal(attemptColumns.includes("run_id"), true);
  store.close();
});

test("store: harness score settlement cannot overwrite a replaced candidate", async () => {
  const db = await tempDb();
  const baseline = db.createRunGroup({ name: "harness baseline" });
  const firstCandidate = db.createRunGroup({ name: "harness candidate one" });
  const replacement = db.createRunGroup({ name: "harness candidate two" });
  const experiment = db.createHarnessExperiment({
    name: "candidate replacement race",
    baselineRunGroupId: baseline.id,
    candidateRunGroupId: firstCandidate.id,
    editableFiles: ["src/agent/prompts.ts"],
    promotionPolicy: { minimumSamplesPerClass: 2, minimumImprovedCases: 1, requireAllControlsPass: true, maxBlockedRate: 0, maxDurationRatio: 1.25, maxAttemptRatio: 1.25 },
    failurePatterns: [],
    preservedBehaviors: [],
    state: "evaluating",
  });

  assert.equal(db.attachHarnessExperimentCandidate(experiment.id, replacement.id), true);
  assert.equal(db.settleHarnessExperiment(experiment.id, firstCandidate.id, { decision: "promote" }, "promote"), false);
  assert.equal(db.getHarnessExperimentById(experiment.id).decision, null);
  assert.equal(db.settleHarnessExperiment(experiment.id, replacement.id, { decision: "reject" }, "reject"), true);
  assert.equal(db.getHarnessExperimentById(experiment.id).decision, "reject");
  db.close();
});

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`concurrent store process failed (${signal ?? code}): ${stderr}`));
    });
  });
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

test("store: evaluation tracking projects are isolated from the default project list", async () => {
  const db = await tempDb();
  db.upsertProject({ name: "operator-project" });
  db.upsertProject({ name: "evaluation:item-1", origin: "evaluation" });

  assert.deepEqual(db.listProjects().map((project) => project.name), ["operator-project"]);
  assert.deepEqual(db.listProjects({ origin: "evaluation" }).map((project) => project.name), ["evaluation:item-1"]);
  assert.equal(db.countProjects({ origin: "all" }), 2);
  db.close();
});

test("store: global findings are source-filtered with evaluation provenance", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "product" });
  const projectRun = db.startRun({ projectId, kind: "run", runDir: "/runs/product" });
  db.upsertFindings(projectId, projectRun, [{ findingKey: "product-finding", title: "Product finding", status: "confirmed-executable" }]);

  const evaluationId = db.upsertProject({ name: "evaluation:item-2", origin: "evaluation" });
  const evaluationRun = db.startRun({ projectId: evaluationId, kind: "verify", runDir: "/runs/evaluation" });
  db.upsertFindings(evaluationId, evaluationRun, [{ findingKey: "evaluation-finding", title: "Evaluation finding", status: "confirmed-differential" }]);

  assert.deepEqual(db.listGlobalFindings().map((finding) => finding.finding_key), ["product-finding"]);
  assert.deepEqual(db.listGlobalFindings({ source: "evaluation" }).map((finding) => finding.finding_key), ["evaluation-finding"]);
  assert.equal(db.listGlobalFindings({ source: "evaluation" })[0].source, "evaluation");
  assert.equal(db.listGlobalFindings({ source: "all" }).length, 2);
  db.close();
});

test("store: startup hides pre-isolation projects that contain only evaluation runs", async () => {
  const { dbPath } = await tempDbPath();
  let db = new MetadataStore(dbPath);
  const projectId = db.upsertProject({ name: "legacy-evaluation-target" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/legacy-evaluation" });
  const group = db.createRunGroup({ name: "legacy-evaluation" });
  const [workItem] = db.addWorkItems(group.id, [{ itemKey: "legacy", kind: "benchmark-case", targetBundle: {}, materialPolicy: {}, evidenceContract: {} }]);
  const jobId = db.enqueueJob("legacy-evaluation-target", { verb: "run" });
  assert.equal(db.attachWorkItemJob(workItem.id, jobId), true);
  assert.equal(db.claimJob(db.createDaemonToken("legacy-evaluation-daemon").id)?.id, jobId);
  db.setJobRun(jobId, runId);
  db.close();

  db = new MetadataStore(dbPath);
  assert.equal(db.getProject("legacy-evaluation-target").origin, "evaluation");
  assert.equal(db.listProjects().length, 0);
  assert.equal(db.listProjects({ origin: "evaluation" }).length, 1);
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

test("store: a newer backlog snapshot supersedes only the identical open action", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "backlog-reconciliation" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/reconcile-1" });
  db.replaceDiscoveryBacklog(projectId, runId, [
    { kind: "coverage-gap", status: "open", scopeId: "S1", title: "Complete S1", location: "dig", reason: "Incomplete" },
    { kind: "coverage-gap", status: "open", scopeId: "S1", title: "Review authority edge", location: "dig", reason: "Unresolved" },
  ]);

  const nextRunId = db.startRun({ projectId, kind: "run", runDir: "/runs/reconcile-2" });
  db.replaceDiscoveryBacklog(projectId, nextRunId, [
    { kind: "coverage-gap", status: "resolved", scopeId: "S1", title: "Complete S1", location: "dig", reason: "Complete" },
  ]);

  const all = db.listDiscoveryBacklog(projectId, { status: "all" });
  assert.equal(all.filter((row) => row.title === "Complete S1" && row.status === "open").length, 0);
  assert.equal(all.filter((row) => row.title === "Complete S1" && row.status === "resolved").length, 2);
  assert.equal(all.filter((row) => row.title === "Review authority edge" && row.status === "open").length, 1);
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

test("store: duplicate tracking preserves the canonical finding link", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "duplicates" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/duplicates-1" });
  db.upsertFindings(projectId, runId, [
    { findingKey: "canonical", title: "router payment helper reentry", status: "confirmed-executable" },
    { findingKey: "variant", title: "alternate reentry path", status: "confirmed-executable" },
  ]);

  const findings = db.listFindings(projectId).sort((a, b) => String(a.finding_key).localeCompare(String(b.finding_key)));
  const canonical = findings.find((finding) => finding.finding_key === "canonical");
  const variant = findings.find((finding) => finding.finding_key === "variant");
  assert.ok(canonical);
  assert.ok(variant);

  assert.equal(db.setFindingTracking(variant.id, "duplicate", canonical.id), true);
  const duplicate = db.getFinding(variant.id);
  assert.equal(duplicate.tracking_status, "duplicate");
  assert.equal(duplicate.duplicate_of_finding_id, canonical.id);

  assert.equal(db.setFindingTracking(variant.id, "triaging"), true);
  const reopened = db.getFinding(variant.id);
  assert.equal(reopened.tracking_status, "triaging");
  assert.equal(reopened.duplicate_of_finding_id, null);
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

test("store: concurrent startup serializes additive schema migrations", async () => {
  const { dir, dbPath } = await tempDbPath();
  const startFile = path.join(dir, "start");
  const store = new MetadataStore(dbPath);
  store.close();

  const legacy = new DatabaseSync(dbPath);
  legacy.exec("ALTER TABLE daemon DROP COLUMN workspace");
  legacy.close();

  const moduleUrl = new URL("../dist/db/store.js", import.meta.url).href;
  const childSource = `
    import { existsSync } from "node:fs";
    import { MetadataStore } from ${JSON.stringify(moduleUrl)};
    while (!existsSync(process.env.START_FILE)) {}
    const store = new MetadataStore(process.env.DB_PATH);
    store.close();
  `;
  const children = Array.from({ length: 8 }, () => spawn(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    { env: { ...process.env, DB_PATH: dbPath, START_FILE: startFile }, stdio: ["ignore", "ignore", "pipe"] },
  ));
  const completions = children.map(waitForChild);
  await writeFile(startFile, "go");
  await Promise.all(completions);

  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  const columns = migrated.prepare("PRAGMA table_info(daemon)").all().map((row) => row.name);
  migrated.close();
  assert.equal(columns.includes("workspace"), true);
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

test("store: daemon tokens + job queue prioritizes project work and stays FIFO within each class", async () => {
  const db = await tempDb();
  const { token } = db.createDaemonToken("local");
  const { token: otherToken } = db.createDaemonToken("remote");
  assert.ok(db.getDaemonByToken(token)); // valid token authenticates
  assert.equal(db.getDaemonByToken("nope"), undefined); // unknown token rejected
  const daemonId = Number(db.getDaemonByToken(token).id);
  const otherDaemonId = Number(db.getDaemonByToken(otherToken).id);

  const group = db.createRunGroup({ name: "background-evaluation" });
  const [workItem] = db.addWorkItems(group.id, [{
    itemKey: "case-1",
    kind: "benchmark-case",
    targetBundle: {},
    materialPolicy: {},
    evidenceContract: {},
  }]);
  const evaluationJob = db.enqueueJob("evaluation:item-1", { verb: "run" });
  assert.equal(db.attachWorkItemJob(workItem.id, evaluationJob), true);
  const j1 = db.enqueueJob("proj", { verb: "run" });
  const pinned = db.enqueueJob("proj", { verb: "audit" }, otherDaemonId);
  const j2 = db.enqueueJob("proj", { verb: "map" });
  const claim1 = db.claimJob(daemonId);
  assert.equal(claim1.id, j1); // FIFO
  assert.deepEqual(claim1.spec, { verb: "run" });
  assert.equal(db.getJob(j1).status, "dispatched");
  assert.equal(db.claimJob(daemonId).id, j2);
  assert.equal(db.claimJob(daemonId).id, evaluationJob); // background work resumes after project FIFO drains
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

test("store: daemon terminal updates cannot overwrite an operator cancellation", async () => {
  const db = await tempDb();
  const { id: daemonId } = db.createDaemonToken("terminal-race");
  const jobId = db.enqueueJob("proj", { verb: "run" }, daemonId);
  assert.equal(db.claimJob(daemonId)?.id, jobId);
  assert.equal(db.cancelJob(jobId), true);
  assert.equal(db.setActiveJobTerminalStatus(jobId, "done"), false);
  assert.equal(db.getJob(jobId).status, "canceled");
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

test("store: execution-equivalent confirm rows collapse linked findings without overriding operator tracking", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "execution-equivalent" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/equivalent-audit" });
  db.upsertFindings(projectId, auditRun, [
    { findingKey: "kpatha", title: "Variant A", status: "confirmed-differential" },
    { findingKey: "kpathb", title: "Variant B", status: "confirmed-differential" },
    { findingKey: "kpathc", title: "Variant C", status: "confirmed-differential" },
  ]);
  const before = db.listFindings(projectId);
  const submitted = before.find((finding) => finding.finding_key === "kpathb");
  const ignored = before.find((finding) => finding.finding_key === "kpathc");
  db.setFindingTracking(submitted.id, "submitted");
  db.setFindingTracking(ignored.id, "ignored");

  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/equivalent-confirm" });
  db.upsertConfirmDecisions(projectId, confirmRun, [{
    bug: "One execution-equivalent bug",
    reproduced: "yes",
    recommendation: "needs-human",
    members: ["kpatha", "kpathb", "kpathc"],
    mergedFrom: ["Variant A", "Variant B", "Variant C"],
    evidenceLevel: "real-target-reproduced",
    reproEvidence: "one fix neutralized every linked PoC against the real target",
  }]);

  const after = db.listFindings(projectId);
  const openVariant = after.find((finding) => finding.finding_key === "kpatha");
  const submittedAfter = after.find((finding) => finding.finding_key === "kpathb");
  const ignoredAfter = after.find((finding) => finding.finding_key === "kpathc");
  assert.equal(submittedAfter.tracking_status, "submitted");
  assert.equal(submittedAfter.duplicate_of_finding_id, null);
  assert.equal(openVariant.tracking_status, "duplicate");
  assert.equal(openVariant.duplicate_of_finding_id, submittedAfter.id);
  assert.equal(ignoredAfter.tracking_status, "ignored", "explicit operator decisions remain authoritative");
  assert.equal(ignoredAfter.duplicate_of_finding_id, null);
  db.close();
});

test("store: consolidation prefers an actionable canonical finding over an ignored variant", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "execution-equivalent-ignored" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/equivalent-ignored-audit" });
  db.upsertFindings(projectId, auditRun, [
    { findingKey: "kignored", title: "Ignored variant", status: "confirmed-differential" },
    { findingKey: "kactionable", title: "Actionable variant", status: "confirmed-differential" },
  ]);
  const before = db.listFindings(projectId);
  db.setFindingTracking(before.find((finding) => finding.finding_key === "kignored").id, "ignored");
  const actionable = before.find((finding) => finding.finding_key === "kactionable");

  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/equivalent-ignored-confirm" });
  db.upsertConfirmDecisions(projectId, confirmRun, [{
    bug: "One bug",
    reproduced: "yes",
    recommendation: "needs-human",
    members: ["kignored", "kactionable"],
    mergedFrom: ["Ignored variant", "Actionable variant"],
    evidenceLevel: "real-target-reproduced",
    reproEvidence: "one fix neutralized both PoCs",
  }]);

  const after = db.listFindings(projectId);
  assert.equal(after.find((finding) => finding.finding_key === "kignored").tracking_status, "ignored");
  assert.equal(after.find((finding) => finding.finding_key === "kactionable").duplicate_of_finding_id, null);
  assert.equal(after.find((finding) => finding.finding_key === "kactionable").id, actionable.id);
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
      engagementProfile: {
        policy_kind: "bug_bounty",
        platform: "custom bounty portal",
        selected_by: "Official policy page was supplied with the target.",
      },
      adjudication: {
        gates: [
          { id: "scope", status: "pass", evidence: "Asset is listed in scope." },
          { id: "live_impact", status: "unknown", evidence: "Live funded exposure was not established." },
        ],
        payout_estimate: { status: "unknown", confidence: "low", basis: "Live impact gate is unresolved." },
      },
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
  assert.match(decision.human_gates, /venue scope still needs human review/);
  assert.match(decision.human_gates, /Framework blocked submit-candidate/);
  assert.equal(decision.recommendation, "needs-human");
  assert.equal(JSON.parse(decision.engagement_profile_json).policy_kind, "bug_bounty");
  assert.equal(JSON.parse(decision.adjudication_json).gates[1].status, "unknown");
  assert.equal(decision.severity, "high");
  assert.equal(decision.evidence_level, "real-target-reproduced");
  assert.equal(decision.submission_confidence, "medium");
  assert.match(decision.report_markdown, /^# Missing verifier binding/);
  db.close();
});

test("store: structured adjudication gates keep bounty confidence conservative", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/p-audit-1" });
  db.upsertFindings(projectId, auditRun, [
    {
      findingKey: "kbounty",
      title: "Live-funded bounty candidate",
      severity: "critical",
      status: "confirmed-executable",
    },
  ]);
  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/p-confirm-1" });
  db.upsertConfirmDecisions(projectId, confirmRun, [
    {
      bug: "Live-funded bounty candidate",
      reproduced: "yes",
      recommendation: "submit-candidate",
      members: ["kbounty"],
      reproEvidence: "purpose=confirm command cmd_2 reproduced the real target effect on a local fork of the current deployment",
      reproCommandId: "cmd_2",
      novelty: "novel",
      engagementProfile: { policy_kind: "bug_bounty", confidence: "medium" },
      adjudication: {
        gates: [
          { id: "scope", status: "pass", evidence: "Listed asset." },
          { id: "live_impact", status: "needs-human", evidence: "Funds at risk still need exact on-chain sizing." },
        ],
        payout_estimate: { status: "unknown", basis: "Do not estimate until live impact is sized." },
      },
    },
  ]);

  const [decision] = db.listConfirmDecisions(projectId);
  assert.equal(decision.recommendation, "needs-human");
  assert.match(decision.human_gates, /Framework blocked submit-candidate/);
  assert.equal(decision.evidence_level, "local-fork-reproduced");
  assert.equal(decision.submission_confidence, "medium");
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
  assert.equal(decision.recommendation, "needs-human");
  assert.match(decision.human_gates, /evidence level is source_only_local_confirmed|source-only-local-confirmed/);
  const [finding] = db.listFindings(projectId);
  assert.equal(finding.confirm_status, null);
  db.close();
});

test("store: ambiguous reproduced decisions do not default to real-target evidence", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "p" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/p-audit-1" });
  db.upsertFindings(projectId, auditRun, [
    {
      findingKey: "kambiguous",
      title: "Ambiguous reproduction",
      severity: "high",
      status: "confirmed-executable",
    },
  ]);
  const confirmRun = db.startRun({ projectId, kind: "confirm", runDir: "/runs/p-confirm-1" });
  db.upsertConfirmDecisions(projectId, confirmRun, [
    {
      bug: "Ambiguous reproduction",
      reproduced: "yes",
      recommendation: "submit-candidate",
      members: ["kambiguous"],
      reproEvidence: "Prior settled row carried forward: cmd28 testAmbiguousPoC passed.",
      reproCommandId: "cmd28",
    },
  ]);

  const [decision] = db.listConfirmDecisions(projectId);
  assert.equal(decision.evidence_level, "source-only-local-confirmed");
  assert.equal(decision.submission_confidence, "low");
  assert.equal(decision.recommendation, "needs-human");
  const [finding] = db.listFindings(projectId);
  assert.equal(finding.confirm_status, null);
  assert.equal(db.countConfirmedBugs(projectId), 0);
  db.close();
});

test("store: exact findings across runs keep one canonical row with occurrence and alias provenance", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "canonical" });
  const firstRun = db.startRun({ projectId, kind: "run", runDir: "/runs/canonical-1", materialFingerprint: "sha256:same" });
  assert.equal(db.getRun(firstRun).material_fingerprint, "sha256:same");
  db.upsertFindings(projectId, firstRun, [{ findingKey: "kfirst", title: "Recipient is not bound", location: "src/Vault.sol:41", severity: "high", status: "suspected" }]);
  const secondRun = db.startRun({ projectId, kind: "audit", runDir: "/runs/canonical-2", materialFingerprint: "sha256:same" });
  db.upsertFindings(projectId, secondRun, [{ findingKey: "ksecond", title: "Recipient is not bound", location: "src/Vault.sol:41", severity: "high", status: "confirmed-executable" }]);

  const rows = db.listFindings(projectId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].finding_key, "kfirst", "the canonical key stays immutable");
  assert.equal(rows[0].status, "confirmed-executable");
  assert.equal(rows[0].occurrence_count, 2);
  assert.equal(db.findingOccurrences(Number(rows[0].id)).length, 2);
  assert.equal(db.setFindingConfirmStatus(projectId, "ksecond", "reproduced"), true, "a later occurrence key resolves through aliases");
  assert.equal(db.getFinding(Number(rows[0].id)).confirm_status, "reproduced");
  db.close();
});

test("store: completed finding identity migrations do not rewrite alias provenance on restart", async () => {
  const { dbPath } = await tempDbPath();
  const db = new MetadataStore(dbPath);
  const projectId = db.upsertProject({ name: "stable-identity-migration" });
  const runId = db.startRun({ projectId, kind: "run", runDir: "/runs/stable-identity" });
  db.upsertFindings(projectId, runId, [{ findingKey: "stable-key", title: "Stable finding", location: "src/x.ts:1", status: "suspected" }]);
  db.close();

  const before = new DatabaseSync(dbPath);
  before.prepare("UPDATE finding_key_alias SET updated_at = 'provenance-sentinel' WHERE alias_key = 'stable-key'").run();
  before.close();

  const reopened = new MetadataStore(dbPath);
  reopened.close();
  const after = new DatabaseSync(dbPath);
  const alias = after.prepare("SELECT updated_at FROM finding_key_alias WHERE alias_key = 'stable-key'").get();
  after.close();
  assert.equal(alias.updated_at, "provenance-sentinel");
});

test("store: blocked finding phases are idempotent until inputs change or an operator requests retry", async () => {
  const db = await tempDb();
  const projectId = db.upsertProject({ name: "attempts" });
  const auditRun = db.startRun({ projectId, kind: "run", runDir: "/runs/attempts-audit" });
  db.upsertFindings(projectId, auditRun, [{ findingKey: "kblocked", title: "Blocked claim", location: "x.ts:1", severity: "high", status: "suspected" }]);
  const finding = db.listFindings(projectId)[0];
  const verifyRun = db.startRun({ projectId, kind: "verify", runDir: "/runs/attempts-verify" });
  db.recordFindingPhaseAttempt(projectId, verifyRun, { subjectType: "finding", subjectId: Number(finding.id), phase: "verify", inputFingerprint: "sha256:input-a", state: "blocked", outcome: "no-verdict", blocker: "toolchain unavailable" });

  assert.equal(db.phaseEligible(projectId, "finding", Number(finding.id), "verify", "sha256:input-a"), false);
  assert.equal(db.phaseEligible(projectId, "finding", Number(finding.id), "verify", "sha256:input-b"), true, "changed materials reopen the phase automatically");
  assert.equal(db.requestFindingPhaseRetry(projectId, "finding", Number(finding.id), "verify"), true);
  assert.equal(db.phaseEligible(projectId, "finding", Number(finding.id), "verify", "sha256:input-a"), true);

  const retryRun = db.startRun({ projectId, kind: "verify", runDir: "/runs/attempts-retry" });
  db.recordFindingPhaseAttempt(projectId, retryRun, { subjectType: "finding", subjectId: Number(finding.id), phase: "verify", inputFingerprint: "sha256:input-a", state: "running" });
  db.recordFindingPhaseAttempt(projectId, retryRun, { subjectType: "finding", subjectId: Number(finding.id), phase: "verify", inputFingerprint: "sha256:input-a", state: "settled", outcome: "refuted" });
  const attempts = db.listFindingPhaseAttempts("finding", Number(finding.id));
  assert.deepEqual(attempts.map((attempt) => [attempt.attempt_number, attempt.state]), [[1, "blocked"], [2, "settled"]]);
  db.close();
});
