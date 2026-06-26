import type { ConfirmDecision, Coverage, FindingRow, PhaseConfig, ProjectDetail, RunRow, ScopeRow } from "./api";

export const STATUSES = ["confirmed-differential", "confirmed-executable", "confirmed-source", "needs-evidence", "suspected", "discharged", "refuted"] as const;
export const TRACKING = ["open", "triaging", "submitted", "accepted", "fixed", "duplicate", "rejected", "ignored"] as const;
export const PROVIDER_PHASES = ["prepare", "map", "dig", "confirm"] as const;
export const PHASES = ["prepare", "map", "dig", "synthesis", "verify", "confirm", "report"] as const;
export type ProviderPhase = (typeof PROVIDER_PHASES)[number];
export type ProjectPhase = (typeof PHASES)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const PHASE_DESC: Record<(typeof PHASES)[number], string> = {
  prepare: "Stage source and warm the build sandbox",
  map: "Build the scope inventory",
  dig: "Audit mapped scopes and confirm locally",
  synthesis: "Synthesize findings into distinct bug candidates",
  verify: "Confirm or refute candidates by local execution",
  confirm: "Reproduce confirmed findings on the real target",
  report: "Prepare one submission package per bug",
};

const STATUS_RANK: Record<string, number> = {
  "confirmed-differential": 5,
  "confirmed-executable": 4,
  "confirmed-source": 3,
  "needs-evidence": 1,
  suspected: 2,
  discharged: 0,
  refuted: -1,
};

const SEV_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export interface PhaseInfo {
  status: string;
  stat: string;
  dur: string;
}

export type PhaseState = Record<(typeof PHASES)[number], PhaseInfo>;

function needsRealTargetConfirmation(detail: ProjectDetail): boolean {
  return detail.prepareSummary?.realTarget?.requiresConfirmation !== false;
}

function isExecutionConfirmedFinding(finding: FindingRow): boolean {
  return finding.status === "confirmed-executable" || finding.status === "confirmed-differential";
}

function confirmDecisionMemberKeys(decision: ConfirmDecision): string[] {
  const members = parseJsonArray(decision.members_json);
  const keys = new Set<string>();
  const add = (value: string) => {
    const key = value.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (/^k[0-9a-z]+$/.test(key)) keys.add(key);
  };
  for (const member of members) {
    if (typeof member !== "string") continue;
    const cleaned = member.trim();
    add(cleaned);
    add(cleaned.split(/\s+/)[0] ?? "");
    const bracketed = cleaned.match(/^\[(k[0-9a-z]+)\]/i)?.[1];
    if (bracketed) add(bracketed);
    const embedded = cleaned.match(/\b(k[0-9a-z]+)\b/i)?.[1];
    if (embedded) add(embedded);
  }
  return [...keys];
}

function parseJsonArray(raw?: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findingCoveredByDecision(finding: FindingRow, decidedFindingKeys: Set<string>): boolean {
  return Boolean(finding.finding_key && decidedFindingKeys.has(finding.finding_key.toLowerCase()));
}

function confirmDecisionTail(decisions: ConfirmDecision[]): string {
  const pending = decisions.filter((decision) => !decision.reproduced || decision.reproduced === "pending").length;
  const needsHuman = decisions.filter((decision) => decision.recommendation === "needs-human").length;
  const notReproduced = decisions.filter((decision) => decision.reproduced === "no" && decision.recommendation !== "needs-human").length;
  const parts = [
    pending ? `${pending} pending` : "",
    needsHuman ? `${needsHuman} need human` : "",
    notReproduced ? `${notReproduced} not reproduced` : "",
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export function rankCandidates(rows: FindingRow[] | undefined): FindingRow[] {
  return [...(rows ?? [])]
    .filter((f) => (STATUS_RANK[f.status] ?? 0) >= 2 && (SEV_RANK[f.severity ?? ""] ?? 0) >= 2)
    .map((f) => ({ f, key: (STATUS_RANK[f.status] ?? 0) * 100 + (SEV_RANK[f.severity ?? ""] ?? 0) * 10 + (Number(f.confidence) || 0) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.f);
}

export function sortScopes(scopes: ScopeRow[]): ScopeRow[] {
  return [...scopes].sort((a, b) => {
    const ga = a.status === "audited" || a.status === "deferred" ? 1 : 0;
    const gb = b.status === "audited" || b.status === "deferred" ? 1 : 0;
    return ga !== gb ? ga - gb : ((b.priority ?? 0) - (a.priority ?? 0)) || ((b.score ?? 0) - (a.score ?? 0));
  });
}

export function confirmedDecisions(rows: ConfirmDecision[] | undefined): ConfirmDecision[] {
  return (rows ?? []).filter((row) => row.reproduced === "yes");
}

function reportPackageStats(findings: FindingRow[], decisions: ConfirmDecision[], requiresConfirmation: boolean): { ready: number; total: number; submissions: number } {
  if (!requiresConfirmation) {
    const reportable = findings.filter(isExecutionConfirmedFinding);
    return {
      ready: reportable.filter((finding) => finding.has_report).length,
      total: reportable.length,
      submissions: 0,
    };
  }
  const reproduced = decisions.filter((decision) => decision.reproduced === "yes" && decision.recommendation !== "drop");
  return {
    ready: reproduced.filter((decision) => decision.has_report).length,
    total: reproduced.length,
    submissions: reproduced.filter((decision) => decision.recommendation === "submit-candidate").length,
  };
}

export function materialRefreshInProgress(material?: ProjectDetail["material"]): boolean {
  return Boolean(material?.activePrepareRefreshStartedAt || material?.currentPrepareStatus === "running");
}

export function currentMaterialProgress(detail: ProjectDetail): Coverage {
  return materialRefreshInProgress(detail.material) ? { total: 0, audited: 0, deferred: 0, pending: 0 } : detail.progress;
}

export function currentMaterialFindings(detail: ProjectDetail): FindingRow[] {
  return materialRefreshInProgress(detail.material) ? [] : detail.allFindings ?? [];
}

export function currentMaterialConfirmDecisions(detail: ProjectDetail): ConfirmDecision[] {
  return materialRefreshInProgress(detail.material) ? [] : detail.confirmDecisions;
}

export function currentMaterialDetail(detail: ProjectDetail): ProjectDetail {
  const refreshing = materialRefreshInProgress(detail.material);
  const progress = currentMaterialProgress(detail);
  const allFindings = currentMaterialFindings(detail);
  const confirmDecisions = currentMaterialConfirmDecisions(detail);
  const auditConfirmedFindings = allFindings.filter(isExecutionConfirmedFinding).length;
  const reproducedBugs = confirmedDecisions(confirmDecisions).length;
  return {
    ...detail,
    progress,
    statusCounts: refreshing ? {} : detail.statusCounts,
    findingsTotal: allFindings.length,
    auditConfirmedFindings,
    reproducedBugs,
    confirmedBugs: reproducedBugs,
    confirmDecisions,
    allFindings,
  };
}

export function projectConfig(detail: ProjectDetail | null): { cfg: ProjectConfigShape; sourcePaths: string[]; buildRoot: string; corpusPaths: string[] } {
  if (!detail) return { cfg: {}, sourcePaths: [], buildRoot: "", corpusPaths: [] };
  return {
    cfg: parseJson<ProjectConfigShape>(detail.project.config_json, {}),
    sourcePaths: parseJson<string[]>(detail.project.source_paths, []),
    buildRoot: detail.project.build_root ?? "",
    corpusPaths: parseJson<string[]>(detail.project.corpus_paths, []),
  };
}

export type ProjectSourceState = { kind: "configured" | "prepared" | "missing"; ok: boolean };

export function projectSourceState(detail: Pick<ProjectDetail, "prepareSummary"> | null | undefined, sourcePaths: string[]): ProjectSourceState {
  if (sourcePaths.length > 0) return { kind: "configured", ok: true };
  const summary = detail?.prepareSummary;
  const preparedWorkspaceReady = Boolean(summary?.workspace?.exists && (summary.auditReady || summary.quality === "ready" || summary.quality === "limited"));
  if (preparedWorkspaceReady) return { kind: "prepared", ok: true };
  return { kind: "missing", ok: false };
}

export interface ProjectConfigShape {
  projectIntent?: string;
  prepareClue?: string;
  scopeCoverageMode?: "focused" | "standard" | "half" | "full" | "custom";
  maxScopes?: number;
  mapSteps?: number;
  digSteps?: number;
  digSamples?: number;
  digConcurrency?: number;
  phases?: PhaseConfig;
  phaseProviders?: Partial<Record<ProviderPhase, number>>;
}

export function parseJson<T>(input: unknown, fallback: T): T {
  if (typeof input !== "string" || !input.trim()) return fallback;
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function fmtTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDur(ms: number): string {
  if (!(ms > 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs ? ` ${rs}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function runDur(run: RunRow | undefined, live?: boolean): string {
  if (!run?.started_at) return "";
  const start = new Date(run.started_at).getTime();
  const end = live ? Date.now() : run.ended_at ? new Date(run.ended_at).getTime() : 0;
  return end ? fmtDur(end - start) : "";
}

function durSince(value: string | null | undefined): string {
  if (!value) return "";
  const start = new Date(value).getTime();
  return Number.isFinite(start) ? fmtDur(Date.now() - start) : "";
}

export function isVerifyRun(run: RunRow | undefined): boolean {
  return Boolean(run && parseJson<{ verify?: boolean }>(run.budgets_json, {}).verify === true);
}

export function isVerifyFromStartRun(run: RunRow | undefined): boolean {
  return Boolean(run && parseJson<{ verifyFromStart?: boolean }>(run.budgets_json, {}).verifyFromStart === true);
}

export function verifyRunProgress(run: RunRow | undefined): { done: number; target: number; remaining: number } | null {
  if (!isVerifyRun(run) || run?.run_scopes_target == null) return null;
  const target = Math.max(0, run.run_scopes_target);
  const done = Math.min(target, Math.max(0, run.run_scopes_done ?? 0));
  return { done, target, remaining: Math.max(0, target - done) };
}

export function verifyRunRechecksConfirmed(run: RunRow | undefined, pendingVerifyCount: number, totalFindingCount = 0): boolean {
  const progress = verifyRunProgress(run);
  if (!progress) return false;
  return isVerifyFromStartRun(run)
    || (totalFindingCount > 0 && progress.target >= totalFindingCount)
    || progress.target > Math.max(0, pendingVerifyCount) + progress.done;
}

export function runScopeBatchComplete(run: RunRow | undefined): boolean {
  return Boolean(run?.status === "running" && run.run_scopes_target != null && (run.run_scopes_done ?? 0) >= run.run_scopes_target);
}

export function pct(a: number | null | undefined, t: number | null | undefined): number {
  return t && t > 0 ? Math.round(((a ?? 0) / t) * 100) : 0;
}

interface RunStages {
  synthesis?: { scopes?: number; produced?: number; pool?: number; status?: string; startedAt?: string; at?: string };
}

function stages(run: RunRow | undefined): RunStages {
  if (!run?.stages_json) return {};
  return parseJson<RunStages>(run.stages_json, {});
}

function latestRunWithStage(runs: RunRow[], stage: keyof RunStages): RunRow | undefined {
  return runs.find((run) => Boolean(stages(run)[stage]));
}

function startedAtMs(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function currentMaterialRuns(runs: RunRow[] | undefined, material?: ProjectDetail["material"]): RunRow[] {
  const current = (runs ?? []).filter((run) => !run.material_stale);
  const prepareRefreshStartedAt = material?.activePrepareRefreshStartedAt
    ?? (material?.currentPrepareStatus === "running" ? material.currentPrepareStartedAt ?? undefined : undefined);
  if (!prepareRefreshStartedAt && !material?.currentScopeInventoryStartedAt) return current;
  if (!prepareRefreshStartedAt) {
    const boundaryMs = startedAtMs(material?.currentScopeInventoryStartedAt);
    return current.filter((run) => run.kind === "prepare" || startedAtMs(run.started_at) >= boundaryMs);
  }
  const boundaryMs = startedAtMs(prepareRefreshStartedAt);
  return current.filter((run) => run.kind === "prepare" && startedAtMs(run.started_at) >= boundaryMs);
}

export function phaseState(detail: ProjectDetail, progress: Coverage): PhaseState {
  const runs = currentMaterialRuns(detail.runs, detail.material);
  const findings = currentMaterialFindings(detail);
  const decisions = currentMaterialConfirmDecisions(detail);
  const latest = (...kinds: string[]) => runs.find((r) => kinds.includes(r.kind));
  const prep = latest("prepare");
  if (materialRefreshInProgress(detail.material)) {
    const prepareDur = runDur(prep, prep?.status === "running")
      || durSince(detail.material?.activePrepareRefreshStartedAt ?? detail.material?.currentPrepareStartedAt);
    const empty = (stat = "Not started"): PhaseInfo => ({ status: "none", stat, dur: "" });
    return {
      prepare: {
        status: "running",
        stat: prep?.status === "running" || !prep ? "Preparing source" : prep.status,
        dur: prepareDur,
      },
      map: empty(),
      dig: empty(),
      synthesis: empty(),
      verify: empty(),
      confirm: empty(),
      report: empty(),
    };
  }
  const repro = confirmedDecisions(decisions).length;
  const conf = latest("confirm");
  const synthesis = stages(latestRunWithStage(runs, "synthesis")).synthesis;
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  const decidedFindingKeys = new Set(decisions.flatMap(confirmDecisionMemberKeys));
  const pendingConfirmRaw = requiresConfirmation
    ? findings.filter((finding) => isExecutionConfirmedFinding(finding) && !finding.confirm_status && !findingCoveredByDecision(finding, decidedFindingKeys)).length
    : 0;
  const pendingVerify = findings.filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source").length;
  const locallyVerified = findings.filter(isExecutionConfirmedFinding).length;
  const needsEvidence = findings.filter((finding) => finding.status === "needs-evidence").length;
  const audit = runs.find((r) => r.status === "running" && ["run", "audit", "map"].includes(r.kind));
  const auditLatest = latest("run", "audit", "map");
  const verifyLatest = runs.find((run) => isVerifyRun(run));
  const reportLatest = latest("report");
  const reportRunning = reportLatest?.status === "running";
  const reportError = reportLatest?.status === "error";
  const activeScope = (detail.activeScopeCount ?? 0) > 0 || Boolean((detail.scopes ?? []).some((scope) => scope.status === "auditing"));
  const digStarted = Boolean(audit && audit.run_scopes_target != null);
  const mapRunning = Boolean(audit && audit.kind !== "audit" && !digStarted);
  const batchDone = runScopeBatchComplete(audit);
  const isVerify = isVerifyRun(audit);
  const verifyProgress = verifyRunProgress(audit);
  const verifyRechecksConfirmed = verifyRunRechecksConfirmed(audit, pendingVerify, findings.length);
  const pendingConfirm = verifyRechecksConfirmed ? 0 : pendingConfirmRaw;
  const finalizingAudit = Boolean(batchDone && audit && !isVerify && !activeScope);
  const digRunning = Boolean(audit && !isVerify && (audit.kind === "audit" || digStarted) && !finalizingAudit);
  const thisRun = audit && audit.run_scopes_target != null
    ? batchDone
      ? " · finalizing"
      : ` · current run ${audit.run_scopes_done ?? 0}/${audit.run_scopes_target}`
    : "";
  const verifyStat = verifyProgress
    ? `Verifying ${verifyProgress.done}/${verifyProgress.target} findings${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
    : "";
  const auditRun = audit ?? auditLatest;
  const startMs = auditRun?.started_at ? new Date(auditRun.started_at).getTime() : 0;
  const endMs = auditLatest?.ended_at ? new Date(auditLatest.ended_at).getTime() : 0;
  const boundMs = auditRun?.dig_started_at ? new Date(auditRun.dig_started_at).getTime() : 0;
  const mapDur = mapRunning
    ? runDur(audit, true)
    : progress.total > 0 && auditLatest?.kind === "map"
      ? runDur(auditLatest, false)
      : progress.total > 0 && startMs && boundMs > startMs
        ? fmtDur(boundMs - startMs)
        : "";
  const digDur = digRunning
    ? boundMs
      ? fmtDur(Date.now() - boundMs)
      : runDur(audit, true)
    : progress.audited > 0
      ? boundMs && endMs > boundMs
        ? fmtDur(endMs - boundMs)
        : runDur(auditLatest, false)
      : "";
  const synthesisStartMs = synthesis?.startedAt ? new Date(synthesis.startedAt).getTime() : 0;
  const synthesisEndMs = synthesis?.at ? new Date(synthesis.at).getTime() : 0;
  const synthesisDur = finalizingAudit && synthesisStartMs
    ? fmtDur(Date.now() - synthesisStartMs)
    : synthesisStartMs && synthesisEndMs > synthesisStartMs
      ? fmtDur(synthesisEndMs - synthesisStartMs)
      : "";
  const reportPackages = reportPackageStats(findings, decisions, requiresConfirmation);

  return {
    prepare: { status: prep ? prep.status : "none", stat: prep ? (prep.status === "done" ? "Source staged" : prep.status === "running" ? "Preparing source" : prep.status) : "Not started", dur: runDur(prep, prep?.status === "running") },
    map: { status: mapRunning ? "running" : progress.total > 0 ? "done" : "none", stat: progress.total > 0 ? `${progress.total} scopes mapped` : mapRunning ? "Mapping scopes" : "Not started", dur: mapDur },
    dig: {
      status: digRunning ? "running" : progress.audited > 0 ? (progress.pending > 0 ? "partial" : "done") : progress.total > 0 ? "pending" : "none",
      stat: finalizingAudit
          ? `Verifying candidates · ${progress.audited}/${progress.total} scopes audited${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
          : progress.total > 0
            ? `${progress.audited}/${progress.total} scopes audited · ${progress.pending} pending${detail.findingsTotal ? ` · ${detail.findingsTotal} ${detail.findingsTotal === 1 ? "finding" : "findings"}` : ""}${thisRun}`
            : "Not started",
      dur: digDur,
    },
    synthesis: {
      status: finalizingAudit
        ? "running"
        : synthesis
          ? "done"
          : progress.audited > 0
            ? "done"
            : "none",
      stat: finalizingAudit
        ? "Synthesizing bug candidates"
        : synthesis
          ? `${synthesis.produced ?? 0} synthesized ${synthesis.produced === 1 ? "candidate" : "candidates"}`
          : progress.audited > 0
            ? "No cross-scope candidate"
            : "Not started",
      dur: synthesisDur,
    },
    verify: {
      status: isVerify
        ? "running"
        : pendingVerify > 0
          ? "pending"
          : locallyVerified > 0 || needsEvidence > 0
            ? "done"
            : "none",
      stat: isVerify
        ? verifyStat
        : pendingVerify > 0
          ? `${pendingVerify} ${pendingVerify === 1 ? "candidate" : "candidates"} waiting`
          : locallyVerified > 0 || needsEvidence > 0
            ? `${locallyVerified} locally verified${needsEvidence ? ` · ${needsEvidence} need evidence` : ""}`
            : "Not started",
      dur: runDur(verifyLatest, verifyLatest?.status === "running"),
    },
    confirm: {
      status: conf?.status === "error"
        ? "error"
        : conf?.status === "running"
        ? "running"
        : verifyRechecksConfirmed
          ? "pending"
        : !requiresConfirmation && locallyVerified > 0
          ? "done"
          : decisions.length
          ? (repro === decisions.length && pendingConfirm === 0 ? "done" : "partial")
          : pendingConfirm > 0
            ? "pending"
            : "none",
      stat: conf?.status === "error"
        ? "Confirm blocked"
        : !requiresConfirmation && locallyVerified > 0
        ? "Not required"
        : verifyRechecksConfirmed
          ? "Waiting for Verify to finish"
        : decisions.length
        ? `${repro}/${decisions.length} reproduced${confirmDecisionTail(decisions)}${pendingConfirm ? ` · ${pendingConfirm} ${pendingConfirm === 1 ? "finding" : "findings"} waiting` : ""}`
        : pendingConfirm > 0
          ? `${pendingConfirm} waiting for real-target confirmation`
          : "Not started",
      dur: runDur(conf, conf?.status === "running"),
    },
    report: {
      status: reportError ? "error" : reportRunning ? "running" : reportPackages.ready > 0 ? (reportPackages.ready === reportPackages.total ? "ready" : "partial") : reportPackages.total > 0 ? "pending" : decisions.length > 0 ? "pending" : "none",
      stat: reportError
        ? "Report failed"
        : reportRunning
        ? "Writing formal reports"
        : reportPackages.ready > 0
          ? `${reportPackages.ready}/${reportPackages.total} ${reportPackages.total === 1 ? "report" : "reports"} ready${reportPackages.submissions ? ` · ${reportPackages.submissions} ${reportPackages.submissions === 1 ? "submission" : "submissions"}` : ""}`
          : reportPackages.total > 0
            ? `${reportPackages.total} waiting for formal report${reportPackages.submissions ? ` · ${reportPackages.submissions} ${reportPackages.submissions === 1 ? "submit candidate" : "submit candidates"}` : ""}`
            : decisions.length > 0
              ? "No reproduced bug yet"
              : "Not started",
      dur: runDur(reportLatest, reportRunning),
    },
  };
}

export function reportName(kind: string): string {
  if (kind === "confirm") return "confirm_report.md";
  if (kind === "prepare") return "prepare_manifest.json";
  return "audit_report.md";
}

export function runProgress(run: RunRow, decisions: ConfirmDecision[]): string {
  if (run.kind === "confirm") {
    const rows = decisions.filter((d) => d.run_id === run.id);
    return rows.length ? `${rows.filter((d) => d.reproduced === "yes").length}/${rows.length} reproduced` : "No decisions recorded yet";
  }
  if (isVerifyRun(run) && run.run_scopes_target != null) {
    if (runScopeBatchComplete(run)) return `Finalizing verification after ${run.run_scopes_done ?? 0}/${run.run_scopes_target} findings`;
    return `${run.run_scopes_done ?? 0}/${run.run_scopes_target} findings checked`;
  }
  if (run.run_scopes_target != null) {
    if (runScopeBatchComplete(run)) {
      return `Finalizing audit after ${run.run_scopes_done ?? 0}/${run.run_scopes_target} scopes${run.scopes_total != null ? ` · ${run.scopes_audited ?? 0}/${run.scopes_total} total audited` : ""}`;
    }
    return `${run.run_scopes_done ?? 0}/${run.run_scopes_target} scopes in this batch${run.scopes_total != null ? ` · ${run.scopes_audited ?? 0}/${run.scopes_total} total audited` : ""}`;
  }
  if (run.scopes_total != null) return `${run.scopes_audited ?? 0}/${run.scopes_total} scopes audited`;
  return run.findings_total != null ? `${run.findings_total} ${run.findings_total === 1 ? "finding" : "findings"}` : "No progress recorded yet";
}

export function reportFileForFinding(finding: FindingRow): string {
  const name = (finding.report_path ?? "").split("/").pop() ?? "";
  return /^report_[a-z0-9_.-]+\.md$/.test(name) ? name : "audit_report.md";
}
