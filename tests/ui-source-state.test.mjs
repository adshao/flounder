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

const { phaseState, projectSourceState } = await loadDomainModule();

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
