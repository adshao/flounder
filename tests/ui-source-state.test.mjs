import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

async function loadTsModule(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  const diagnostics = compiled.diagnostics?.filter((entry) => entry.category === ts.DiagnosticCategory.Error) ?? [];
  assert.deepEqual(diagnostics, []);
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);
}

const { bugBountyEngagementLabel, contestReviewState, decisionHasUnresolvedEvidenceConflict, hasUnresolvedEvidenceConflict, isVerifyRun, normalizeActivityBody, pendingConfirmFindings, splitActivitySummaries, phaseState, projectSourceState, reportableDecisions, reportableFindings, runProgress, sortConfirmDecisionsForSubmission } = await loadTsModule("../src/server/ui/src/domain.ts");
const { nextDialogFocusIndex } = await loadTsModule("../src/server/ui/src/dialog-focus.ts");
const appSource = readFileSync(new URL("../src/server/ui/src/App.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../src/server/ui/src/styles.css", import.meta.url), "utf8");

test("ui: modal focus traversal wraps in both directions", () => {
  assert.equal(nextDialogFocusIndex(0, 3, false), 1);
  assert.equal(nextDialogFocusIndex(2, 3, false), 0);
  assert.equal(nextDialogFocusIndex(0, 3, true), 2);
  assert.equal(nextDialogFocusIndex(-1, 3, false), 0);
  assert.equal(nextDialogFocusIndex(-1, 3, true), 2);
  assert.equal(nextDialogFocusIndex(0, 0, false), -1);
});

test("ui: source setup is ready when configured source paths exist", () => {
  assert.deepEqual(projectSourceState(null, ["src"]), { kind: "configured", ok: true });
});

test("ui: verify runs use the explicit run kind while preserving legacy metadata", () => {
  assert.equal(isVerifyRun({ kind: "verify", status: "running" }), true);
  assert.equal(isVerifyRun({ kind: "audit", status: "done", budgets_json: JSON.stringify({ verify: true }) }), true);
  assert.equal(isVerifyRun({ kind: "audit", status: "done", budgets_json: "{}" }), false);

  const phases = phaseState({
    runs: [{ id: 2, kind: "verify", status: "running", run_scopes_target: 2, run_scopes_done: 1 }],
    material: {},
    scopes: [],
    activeScopeCount: 0,
    findingsTotal: 1,
    statusCounts: { suspected: 1 },
    allFindings: [{ id: 1, status: "suspected" }],
    confirmDecisions: [],
  }, { total: 0, audited: 0, deferred: 0, pending: 0 });
  assert.equal(phases.verify.status, "running");
  assert.match(phases.verify.stat, /Verifying 1\/2 findings/);
});

test("ui: global findings default to project evidence and expose explicit evaluation provenance", () => {
  assert.match(appSource, /useState<"project" \| "evaluation" \| "all">\("project"\)/);
  assert.match(appSource, /<option value="evaluation">Evaluation evidence<\/option>/);
  assert.match(appSource, /finding\.source === "evaluation"/);
  assert.match(appSource, />Evaluation only<\/span>/);
});

test("ui: findings expose a compact lifecycle summary and focused blocked-phase retry", () => {
  assert.match(appSource, /function FindingLifecycleRail/);
  assert.match(appSource, /Found.*Local.*Target.*Report.*Disclose/s);
  assert.match(appSource, /lifecycle-summary-button/);
  assert.doesNotMatch(appSource, /className="lifecycle-rail"/);
  assert.match(appSource, /function LifecycleEvidencePanel/);
  assert.match(appSource, /api\.retryFindingPhase/);
  assert.match(appSource, /will run on the next Continue/);
});

test("ui: storage pressure is visible and project cleanup keeps database records", () => {
  assert.match(appSource, /function StorageWarningBanner/);
  assert.match(appSource, /Storage running low/);
  assert.match(appSource, /function StoragePane/);
  assert.match(appSource, /api\.storageDisk\(\)\.then/);
  assert.match(appSource, /Keep metadata only/);
  assert.match(appSource, /Project, run, scope, finding, and decision records remain/);
  assert.match(appSource, /api\.cleanupProjectStorage/);
  assert.match(stylesSource, /\.storage-warning/);
  assert.match(stylesSource, /\.storage-project-card/);
});

test("ui: unresolved local and real-target evidence conflicts require review and are not reportable", () => {
  const finding = {
    id: 7,
    finding_key: "kconflict",
    status: "confirmed-executable",
    confirm_status: "reproduced",
    refutation_status: "conflict",
  };
  const decision = {
    id: 11,
    bug: "Conflicted bug",
    members_json: JSON.stringify(["kconflict"]),
    reproduced: "yes",
    recommendation: "submit-candidate",
    evidence_level: "real-target-reproduced",
  };

  assert.equal(hasUnresolvedEvidenceConflict(finding), true);
  assert.equal(decisionHasUnresolvedEvidenceConflict(decision, [finding]), true);
  assert.deepEqual(reportableFindings([finding]), []);
  assert.deepEqual(reportableDecisions([decision], [finding]), []);
  assert.match(appSource, /Resolve evidence conflict/);
  assert.match(appSource, /Local verification conflicts with real-target reproduction/);
  assert.match(appSource, /Evidence conflict/);
  assert.match(appSource, /Report held/);
  assert.match(appSource, /Retry Verify/);
  assert.match(appSource, /Retry Confirm/);
  assert.match(appSource, /Reporting stays held until the evidence agrees/);
  assert.match(stylesSource, /\.refutation-conflict/);
});

test("ui: independently refuted confirmations do not advance to confirm or report", () => {
  const finding = {
    id: 8,
    finding_key: "kreviewrefuted",
    status: "confirmed-differential",
    confirm_status: null,
    refutation_status: "refuted",
  };

  assert.deepEqual(pendingConfirmFindings([finding], true, []), []);
  assert.deepEqual(reportableFindings([finding], false), []);
});

test("ui: duplicate confirmations stay visible but do not become new work", () => {
  const finding = {
    id: 9,
    finding_key: "kduplicate",
    status: "confirmed-executable",
    confirm_status: null,
    tracking_status: "duplicate",
  };

  assert.deepEqual(pendingConfirmFindings([finding], true, []), []);
  assert.deepEqual(reportableFindings([finding], false), []);
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

test("ui: contest review state flags elapsed review windows", () => {
  const state = contestReviewState({
    project: { created_at: "2000-01-01T00:00:00.000Z" },
    runs: [],
    allFindings: [],
    progress: { total: 0, audited: 0, pending: 0 },
  }, {
    engagement: {
      kind: "bug-bounty-contest",
      strategy: { stopAfterHours: 48 },
    },
  });
  assert.equal(state.kind, "review-due");
  assert.equal(state.tone, "warning");
});

test("ui: normal bug bounty engagement keeps contest review disabled", () => {
  const cfg = { engagement: { kind: "bug-bounty" } };
  assert.equal(bugBountyEngagementLabel(cfg), "Bounty");
  assert.equal(contestReviewState({
    project: { created_at: "2000-01-01T00:00:00.000Z" },
    runs: [],
    allFindings: [],
    progress: { total: 20, audited: 20, pending: 0 },
  }, cfg), null);
});

test("ui: contest review state detects low marginal yield over recent batches", () => {
  const state = contestReviewState({
    project: { created_at: "2099-01-01T00:00:00.000Z" },
    runs: [
      { id: 3, kind: "run", status: "done", run_scopes_done: 10, started_at: "2026-01-03T00:00:00.000Z" },
      { id: 2, kind: "run", status: "done", run_scopes_done: 10, started_at: "2026-01-02T00:00:00.000Z" },
      { id: 1, kind: "run", status: "done", run_scopes_done: 10, started_at: "2026-01-01T00:00:00.000Z" },
    ],
    allFindings: [
      { id: 1, run_id: 1, status: "confirmed-executable" },
      { id: 2, run_id: 3, status: "suspected" },
    ],
    progress: { total: 30, audited: 30, pending: 0 },
  }, {
    engagement: {
      kind: "bug-bounty-contest",
      strategy: { batchScopes: 10, appendMapWhenExhausted: true },
    },
  });
  assert.equal(state.kind, "low-yield");
  assert.equal(state.recentAuditedScopes, 20);
  assert.equal(state.recentConfirmedFindings, 0);
});

test("ui: contest review state surfaces exhausted inventory before append-map expansion", () => {
  const state = contestReviewState({
    project: { created_at: "2099-01-01T00:00:00.000Z" },
    runs: [
      { id: 1, kind: "run", status: "done", run_scopes_done: 10, started_at: "2026-01-01T00:00:00.000Z" },
    ],
    allFindings: [],
    progress: { total: 10, audited: 10, pending: 0 },
  }, {
    engagement: {
      kind: "bug-bounty-contest",
      strategy: { batchScopes: 10, appendMapWhenExhausted: true },
    },
  });
  assert.equal(state.kind, "inventory-exhausted");
  assert.equal(state.tone, "info");
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
      { bug: "same root cause", reproduced: "yes", recommendation: "submit-candidate", evidence_level: "fork-reproduced", members_json: JSON.stringify(["kalpha", "kbeta"]) },
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
      { bug: "submit root cause", reproduced: "yes", recommendation: "submit-candidate", evidence_level: "fork-reproduced", members_json: JSON.stringify(["kone"]) },
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
        job_error: "No sandbox backend is available",
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

test("ui: phase durations accumulate coverage runs and ignore confirm", () => {
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
  assert.equal(phases.dig.dur, "7h 31m");
  assert.equal(phases.dig.status, "done");
  assert.equal(phases.synthesis.dur, "13m 31s");
});

test("ui: running continuation dig adds to prior map and dig duration", () => {
  const originalNow = Date.now;
  Date.now = () => new Date("2026-06-30T14:11:00.000Z").getTime();
  try {
    const detail = {
      runs: [
        {
          id: 109,
          kind: "run",
          status: "running",
          started_at: "2026-06-30T13:00:00.000Z",
          dig_started_at: "2026-06-30T13:00:00.000Z",
          ended_at: null,
          run_scopes_done: 4,
          run_scopes_target: 62,
        },
        {
          id: 108,
          kind: "confirm",
          status: "done",
          started_at: "2026-06-30T12:31:29.845Z",
          ended_at: "2026-06-30T12:50:00.000Z",
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
      scopes: [{ id: 1, status: "auditing" }],
      activeScopeCount: 1,
      findingsTotal: 30,
      statusCounts: { "confirmed-executable": 16, suspected: 12 },
      prepareSummary: { realTarget: { requiresConfirmation: true } },
      allFindings: [],
      confirmDecisions: [],
    };
    const phases = phaseState(detail, { total: 92, audited: 34, deferred: 0, pending: 58 });
    assert.equal(phases.map.dur, "49m 12s");
    assert.equal(phases.dig.dur, "8h 42m");
    assert.equal(phases.dig.status, "running");
  } finally {
    Date.now = originalNow;
  }
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

test("ui: live activity hides transport markers and describes active mapping", () => {
  assert.equal(normalizeActivityBody("**Planning deep code audit**\n\n<!-- -->"), "Planning deep code audit\n");
  assert.deepEqual(
    splitActivitySummaries("**Planning deep code audit**\n\n<!-- -->\n\n**Checking the invariant**\n\n<!-- -->"),
    ["Planning deep code audit", "Checking the invariant"],
  );
  assert.equal(runProgress({ id: 246, kind: "run", status: "running" }, []), "Mapping project scope");
  assert.equal(runProgress({ id: 247, kind: "report", status: "running" }, []), "Generating reports");
  assert.doesNotMatch(appSource, /Streaming reasoning summaries/);
  assert.doesNotMatch(appSource, /Detailed reasoning summaries and tool events/);
  assert.doesNotMatch(appSource, /activity-provider-state/);
  assert.doesNotMatch(appSource, /void api\.runLog\(run\.id, 120\)/);
  assert.match(appSource, /line\.streamId \? <span>\{line\.streamId\}<\/span>/);
  assert.match(appSource, /Live\$\{displayedActiveStreams\.length \? ` · \$\{displayedActiveStreams\.length\} active`/);
  assert.match(appSource, /aria-label="Concurrent audit streams"/);
  assert.match(appSource, /lines\.filter\(\(line\) => line\.streamId === effectiveLane\)/);
  assert.match(appSource, /detail\.activeScopeIds\s*\?\?/);
  assert.match(stylesSource, /\.activity-lanes\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(stylesSource, /\.activity-entry\.thinking \.activity-kicker\s*\{[^}]*display:\s*none;/s);
  assert.match(appSource, /if \(!normalizedDelta\.trim\(\)\) return;/);
  assert.match(appSource, /normalizeActivityBody\(`\$\{last\.body\}\$\{delta\}`\)/);
  assert.match(appSource, /nonEmptyVisibleLines\.length \? \(/);
});

test("ui: the dense control-plane base scale stays compact while touch targets remain large", () => {
  assert.match(stylesSource, /body\s*\{[^}]*font:\s*13\.5px\/1\.5 var\(--sans\);/s);
  assert.match(stylesSource, /\.tabs button\s*\{[^}]*font-size:\s*inherit;/s);
  assert.match(stylesSource, /@media \(pointer:\s*coarse\)[\s\S]*min-height:\s*44px;/);
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
