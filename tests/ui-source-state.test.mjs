import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

async function loadDomainModule() {
  const source = readFileSync(new URL("../src/server/ui/src/domain.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "domain.ts",
    reportDiagnostics: true,
  });
  const diagnostics = compiled.diagnostics?.filter((entry) => entry.category === ts.DiagnosticCategory.Error) ?? [];
  assert.deepEqual(diagnostics, []);
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);
}

const { phaseState, projectSourceState, runProgress, sortConfirmDecisionsForSubmission } = await loadDomainModule();

test("ui: source setup is ready when configured source paths exist", () => {
  assert.deepEqual(projectSourceState(null, ["src"]), { kind: "configured", ok: true });
});

test("ui: source setup is ready when prepare produced an audit-ready workspace", () => {
  const detail = {
    prepareSummary: {
      quality: "ready",
      auditReady: true,
      workspace: { exists: true },
    },
  };
  assert.deepEqual(projectSourceState(detail, []), { kind: "prepared", ok: true });
});

test("ui: source setup stays missing when prepared workspace is unavailable or not audit-ready", () => {
  assert.deepEqual(projectSourceState({ prepareSummary: { quality: "ready", auditReady: true, workspace: { exists: false } } }, []), { kind: "missing", ok: false });
  assert.deepEqual(projectSourceState({ prepareSummary: { quality: "preparing", auditReady: false, workspace: { exists: true } } }, []), { kind: "missing", ok: false });
});

test("ui: phase cards count report packages by reproduced decision, not linked findings", () => {
  const detail = {
    runs: [],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 3,
    statusCounts: {},
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kalpha", status: "confirmed-executable", confirm_status: "reproduced", has_report: true },
      { id: 2, finding_key: "kbeta", status: "confirmed-differential", confirm_status: "reproduced", has_report: true },
      { id: 3, finding_key: "kgamma", status: "confirmed-differential", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [
      { bug: "same root cause", reproduced: "yes", recommendation: "submit-candidate", members_json: JSON.stringify(["kalpha", "kbeta"]) },
    ],
  };
  const phases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.confirm.stat, "1/1 reproduced · 1 finding waiting");
  assert.equal(phases.report.stat, "1 waiting for formal report · 1 submit candidate");
  detail.confirmDecisions[0].has_report = true;
  const readyPhases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(readyPhases.report.stat, "1/1 report ready · 1 submission");
});

test("ui: phase cards do not double-count findings already covered by decisions", () => {
  const detail = {
    runs: [],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 2,
    statusCounts: {},
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kone", status: "confirmed-differential", confirm_status: null, has_report: false },
      { id: 2, finding_key: "ktwo", status: "confirmed-differential", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [
      { bug: "submit root cause", reproduced: "yes", recommendation: "submit-candidate", members_json: JSON.stringify(["kone"]) },
      { bug: "setup blocker", reproduced: "could-not-set-up", recommendation: "needs-human", members_json: JSON.stringify(["ktwo"]) },
    ],
  };
  const phases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.confirm.stat, "1/2 reproduced · 1 need human");
  assert.equal(phases.report.stat, "1 waiting for formal report · 1 submit candidate");
});

test("ui: real-target decisions rank by submit readiness, severity, and confidence", () => {
  const ordered = sortConfirmDecisionsForSubmission([
    { id: 1, bug: "medium submit", reproduced: "yes", recommendation: "submit-candidate", severity: "medium", submission_confidence: "high", evidence_level: "fork-reproduced" },
    { id: 2, bug: "critical human gate", reproduced: "could-not-set-up", recommendation: "needs-human", severity: "critical", submission_confidence: "medium", evidence_level: "source-supported" },
    { id: 3, bug: "critical submit", reproduced: "yes", recommendation: "submit-candidate", severity: "critical", submission_confidence: "medium", evidence_level: "fork-reproduced" },
    { id: 4, bug: "high non-submit reproduced", reproduced: "yes", recommendation: "needs-human", severity: "high", submission_confidence: "high", evidence_level: "fork-reproduced" },
    { id: 5, bug: "critical drop", reproduced: "yes", recommendation: "drop", severity: "critical", submission_confidence: "high", evidence_level: "fork-reproduced" },
    { id: 6, bug: "source-only submit", reproduced: "yes", recommendation: "submit-candidate", severity: "critical", submission_confidence: "low", evidence_level: "source-only-local-confirmed" },
  ]).map((decision) => decision.bug);
  assert.deepEqual(ordered, [
    "critical submit",
    "medium submit",
    "source-only submit",
    "high non-submit reproduced",
    "critical human gate",
    "critical drop",
  ]);
});

test("ui: confirm phase surfaces latest confirm run errors", () => {
  const detail = {
    runs: [
      {
        id: 12,
        kind: "confirm",
        status: "error",
        started_at: "2026-06-26T00:00:00.000Z",
        ended_at: "2026-06-26T00:00:05.000Z",
        job_error: "No OCI sandbox is available",
      },
    ],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 1,
    statusCounts: { "confirmed-differential": 1 },
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kconfirmed", status: "confirmed-differential", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [],
  };
  const phases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.confirm.status, "error");
  assert.equal(phases.confirm.stat, "Confirm blocked");
});

test("ui: phase durations stay anchored to the primary coverage run after follow-up audit starts confirm", () => {
  const detail = {
    runs: [
      {
        id: 108,
        kind: "confirm",
        status: "running",
        started_at: "2026-06-30T12:31:29.845Z",
        ended_at: null,
      },
      {
        id: 107,
        kind: "audit",
        status: "done",
        started_at: "2026-06-30T12:12:15.724Z",
        dig_started_at: "2026-06-30T12:12:15.725Z",
        ended_at: "2026-06-30T12:31:29.835Z",
        run_scopes_done: 2,
        run_scopes_target: 2,
      },
      {
        id: 106,
        kind: "run",
        status: "done",
        started_at: "2026-06-30T03:40:22.921Z",
        dig_started_at: "2026-06-30T04:29:34.935Z",
        ended_at: "2026-06-30T12:12:11.394Z",
        run_scopes_done: 30,
        run_scopes_target: 30,
        scopes_total: 129,
        scopes_audited: 30,
        stages_json: JSON.stringify({
          synthesis: {
            scopes: 127,
            pool: 19,
            status: "done",
            startedAt: "2026-06-30T11:41:31.513Z",
            at: "2026-06-30T11:55:03.175Z",
            produced: 1,
          },
        }),
      },
    ],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 18,
    statusCounts: { "confirmed-executable": 18 },
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kconfirmed", status: "confirmed-executable", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [],
  };
  const phases = phaseState(detail, { total: 127, audited: 30, deferred: 0, pending: 97 });
  assert.equal(phases.map.dur, "49m 12s");
  assert.equal(phases.dig.dur, "7h 11m");
  assert.equal(phases.dig.status, "done");
  assert.equal(phases.synthesis.dur, "13m 31s");
});

test("ui: running confirm surfaces command progress before decision rows exist", () => {
  const run = {
    id: 108,
    kind: "confirm",
    status: "running",
    started_at: "2026-06-30T12:31:29.845Z",
    ended_at: null,
    stages_json: JSON.stringify({
      confirm: {
        status: "running",
        findings: 14,
        commandRuns: 8,
        confirmRuns: 3,
        passed: 1,
        failed: 2,
      },
    }),
  };
  const detail = {
    runs: [run],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 14,
    statusCounts: { "confirmed-executable": 14 },
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kconfirmed", status: "confirmed-executable", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [],
  };
  const phases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.confirm.status, "running");
  assert.equal(phases.confirm.stat, "3 real-target checks · 1 passed · 2 failed");
  assert.equal(runProgress(run, []), "3 real-target checks · 1 passed · 2 failed");
});

test("ui: verify card treats external-evidence leads as reviewed, not waiting", () => {
  const detail = {
    runs: [],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 3,
    statusCounts: { "confirmed-differential": 1, "needs-evidence": 2 },
    prepareSummary: { realTarget: { requiresConfirmation: true } },
    allFindings: [
      { id: 1, finding_key: "kconfirmed", status: "confirmed-differential", confirm_status: null, has_report: false },
      { id: 2, finding_key: "kevidence1", status: "needs-evidence", confirm_status: null, has_report: false },
      { id: 3, finding_key: "kevidence2", status: "needs-evidence", confirm_status: null, has_report: false },
    ],
    confirmDecisions: [],
  };
  const phases = phaseState(detail, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.verify.status, "done");
  assert.equal(phases.verify.stat, "1 locally verified · 2 need evidence");
  assert.equal(phases.confirm.stat, "1 waiting for real-target confirmation");
});
