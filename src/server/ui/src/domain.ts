import type { ConfirmDecision, ContestStrategy, Coverage, EngagementConfig, FindingRow, PhaseConfig, ProjectDetail, ProjectSnapshot, RunRow, ScopeRow } from "./api";

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
  dig: "Discover scope findings and attempt local proof",
  synthesis: "Synthesize findings into distinct bug candidates",
  verify: "Settle unresolved candidates by local execution",
  confirm: "Reproduce confirmed findings on the real target",
  report: "Prepare one submission package per bug",
};

export const BUG_BOUNTY_CONTEST_KIND = "bug-bounty-contest";
export const BUG_BOUNTY_KIND = "bug-bounty";
export const DEFAULT_CONTEST_BATCH_SCOPES = 10;
export const DEFAULT_CONTEST_DIG_CONCURRENCY = 5;

/** Activity is plain text in the product UI. Remove transport-only model markers
 * instead of exposing HTML comments and raw Markdown emphasis to operators. */
export function normalizeActivityBody(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trimStart();
}

/** Providers may stream several human-readable reasoning summaries in one
 * response block, separated by transport-only HTML comments. Keep those as
 * separate timeline entries instead of presenting one oversized pseudo-CoT. */
export function splitActivitySummaries(value: string): string[] {
  const segments = value
    .split(/<!--[\s\S]*?-->/g)
    .map((segment) => normalizeActivityBody(segment).trim())
    .filter(Boolean);
  if (segments.length > 0) return segments;
  const normalized = normalizeActivityBody(value).trim();
  return normalized ? [normalized] : [];
}

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

export function needsRealTargetConfirmation(detail: ProjectDetail | ProjectSnapshot | null | undefined): boolean {
  if (!detail) return true;
  const cfg = "project" in detail ? projectConfig(detail).cfg : detail.config ?? {};
  if (contestStrategy(cfg).skipRealTargetConfirm) return false;
  return ("prepareSummary" in detail ? detail.prepareSummary : undefined)?.realTarget?.requiresConfirmation !== false;
}

export function isExecutionConfirmedFinding(finding: FindingRow): boolean {
  return finding.status === "confirmed-executable" || finding.status === "confirmed-differential";
}

export function confirmDecisionMemberKeys(decision: ConfirmDecision): string[] {
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

export function activeFindings(rows: FindingRow[] | undefined): FindingRow[] {
  return (rows ?? []).filter((finding) => (finding.tracking_status ?? "open") !== "ignored");
}

export function pendingConfirmFindings(rows: FindingRow[] | undefined, requiresConfirmation = true, decisions?: ConfirmDecision[]): FindingRow[] {
  if (!requiresConfirmation) return [];
  const decidedFindingKeys = new Set((decisions ?? []).flatMap(confirmDecisionMemberKeys));
  return activeFindings(rows).filter((finding) =>
    isExecutionConfirmedFinding(finding)
    && !finding.confirm_status
    && !(finding.finding_key && decidedFindingKeys.has(finding.finding_key.toLowerCase()))
  );
}

export function localVerifiedFindings(rows: FindingRow[] | undefined): FindingRow[] {
  return activeFindings(rows).filter(isExecutionConfirmedFinding);
}

export function pendingVerifyFindings(rows: FindingRow[] | undefined): FindingRow[] {
  return topCandidateFindings(activeFindings(rows).filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source"));
}

export function rawPendingVerifyCount(rows: FindingRow[] | undefined): number {
  return activeFindings(rows).filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source").length;
}

export function reportableFindings(rows: FindingRow[] | undefined, requiresConfirmation = true): FindingRow[] {
  return activeFindings(rows).filter((finding) => requiresConfirmation ? finding.confirm_status === "reproduced" : isExecutionConfirmedFinding(finding));
}

export function pendingFormalReports(rows: FindingRow[] | undefined, requiresConfirmation = true): FindingRow[] {
  return reportableFindings(rows, requiresConfirmation).filter((finding) => !finding.has_report);
}

export function reportableDecisions(decisions: ConfirmDecision[] | undefined): ConfirmDecision[] {
  return sortConfirmDecisionsForSubmission(decisions).filter(isSubmissionReadyDecision);
}

export function pendingDecisionReports(decisions: ConfirmDecision[] | undefined): ConfirmDecision[] {
  return reportableDecisions(decisions).filter((decision) => !decision.has_report);
}

function severityScore(finding: FindingRow): number {
  const severity = SEV_RANK[finding.severity ?? ""] ?? 0;
  const status = finding.status.startsWith("confirmed") ? 2 : finding.status === "suspected" ? 1 : 0;
  return status * 100 + severity * 10 + (finding.confidence ?? 0);
}

export function topCandidateFindings(rows: FindingRow[] | undefined): FindingRow[] {
  const ranked = rankCandidates(rows);
  if (ranked.length) return ranked.slice(0, 8);
  return [...(rows ?? [])]
    .filter((finding) => finding.status.startsWith("confirmed") || finding.status === "suspected")
    .sort((a, b) => severityScore(b) - severityScore(a))
    .slice(0, 8);
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

function parseJsonObject(raw?: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function decisionObject(decision: ConfirmDecision, objectKey: "engagement_profile" | "adjudication", jsonKey: "engagement_profile_json" | "adjudication_json"): Record<string, unknown> | undefined {
  const direct = decision[objectKey];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  return parseJsonObject(decision[jsonKey]);
}

function normalizedWord(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function stringField(obj: Record<string, unknown> | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function gateStatus(adjudication: Record<string, unknown> | undefined, needles: string[], fallbackKeys: string[]): string {
  const gates = Array.isArray(adjudication?.gates) ? adjudication.gates : [];
  for (const gate of gates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
    const record = gate as Record<string, unknown>;
    const id = normalizedWord(record.id ?? record.key ?? record.name ?? record.gate);
    if (needles.some((needle) => id.includes(needle))) return String(record.status ?? record.result ?? record.state ?? "").trim();
  }
  return stringField(adjudication, fallbackKeys);
}

function isNegativeGateStatus(status: string): boolean {
  const normalized = normalizedWord(status);
  return [
    "fail",
    "failed",
    "unknown",
    "needs_human",
    "blocked",
    "missing",
    "unsettled",
    "unfunded",
    "not_funded",
    "not_live",
    "no_live",
    "no_funds",
    "not_novel",
    "already_disclosed",
    "duplicate",
    "disclosed",
  ].some((token) => normalized === token || normalized.startsWith(`${token}_`));
}

function isPassingGateStatus(status: string): boolean {
  const normalized = normalizedWord(status);
  if (!normalized || isNegativeGateStatus(normalized)) return false;
  return ["pass", "passed", "satisfied", "confirmed", "established", "eligible", "ok", "yes", "in_scope", "funded", "live_funded", "novel", "estimated", "collectible", "not_duplicate", "not_disclosed"].some((token) => normalized === token || normalized.startsWith(`${token}_`));
}

function decisionHasOpenSubmissionGate(decision: ConfirmDecision): boolean {
  const text = (decision.human_gates ?? "").trim().toLowerCase();
  if (text && !/^(?:none|n\/a|not applicable|no remaining gates?|no human gates?)\.?$/.test(text)) {
    if (!/\b(?:no|none)\b.{0,32}\b(?:remaining|open|unsettled|human)\b.{0,24}\b(?:gate|gates|blocker|blockers)\b/.test(text)) {
      if (/\b(?:scope|venue|eligib|bounty|reward|payout|collectible|live|funded|funds|deployment|production|current|human gate|needs?|requires?|not established|not confirmed|unknown|unclear|unverified|pending|review|cannot be settled|must)\b/.test(text)) return true;
    }
  }
  const adjudication = decisionObject(decision, "adjudication", "adjudication_json");
  const directStatuses = [
    gateStatus(adjudication, ["scope", "venue", "eligib", "asset"], ["scope_status", "scopeStatus"]),
    gateStatus(adjudication, ["live", "impact", "fund", "exposure", "deployment"], ["live_impact_status", "liveImpactStatus", "funds_status", "fundsStatus"]),
    gateStatus(adjudication, ["known", "novel", "duplicate", "disclos"], ["known_issue_status", "knownIssueStatus", "novelty_status", "noveltyStatus"]),
    gateStatus(adjudication, ["payout", "reward", "collectible", "bounty"], ["payout_status", "payoutStatus", "reward_status", "rewardStatus"]),
  ].filter(Boolean);
  return directStatuses.some((status) => !isPassingGateStatus(status));
}

function hasRealTargetEvidence(decision: ConfirmDecision): boolean {
  const normalized = normalizedWord(decision.evidence_level);
  return normalized === "real_target_reproduced" || normalized === "fork_reproduced" || normalized === "local_fork_reproduced";
}

export function isSubmissionReadyDecision(decision: ConfirmDecision): boolean {
  return decision.reproduced === "yes" && decision.recommendation === "submit-candidate" && hasRealTargetEvidence(decision) && !decisionHasOpenSubmissionGate(decision);
}

export function needsSubmissionReadinessWork(decision: ConfirmDecision): boolean {
  return decision.reproduced === "yes" && decision.recommendation !== "drop" && !isSubmissionReadyDecision(decision) && (decision.recommendation === "submit-candidate" || decisionHasOpenSubmissionGate(decision));
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
  return (rows ?? []).filter((row) => row.reproduced === "yes" && hasRealTargetEvidence(row));
}

const DECISION_RECOMMENDATION_RANK: Record<string, number> = {
  "submit-candidate": 4,
  "needs-human": 2,
  drop: 0,
};

const DECISION_REPRODUCTION_RANK: Record<string, number> = {
  yes: 4,
  pending: 2,
  "could-not-set-up": 2,
  no: 1,
};

const DECISION_SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const DECISION_CONFIDENCE_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, unknown: 1 };
const DECISION_EVIDENCE_RANK: Record<string, number> = {
  "real-target-reproduced": 5,
  "fork-reproduced": 4,
  "local-fork-reproduced": 4,
  "execution-reproduced": 3,
  "locally-reproduced": 3,
  "source-only-local-confirmed": 3,
  "source-supported": 2,
  "reasoned": 1,
};

function rankToken(value?: string | null): string {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
}

function confirmDecisionPriority(decision: ConfirmDecision): number {
  const recommendation = rankToken(decision.recommendation);
  const reproduced = rankToken(decision.reproduced);
  const evidenceLevel = rankToken(decision.evidence_level);
  const realTargetEvidence = evidenceLevel === "real-target-reproduced" || evidenceLevel === "fork-reproduced" || evidenceLevel === "local-fork-reproduced";
  const group = recommendation === "drop"
    ? 0
    : reproduced === "yes" && recommendation === "submit-candidate" && realTargetEvidence
      ? 5
      : reproduced === "yes"
        ? 4
        : recommendation === "needs-human"
          ? 3
          : reproduced === "pending" || reproduced === "could-not-set-up"
            ? 2
            : reproduced === "no"
              ? 1
              : 2;
  const severity = (DECISION_SEVERITY_RANK[rankToken(decision.severity)] ?? 0) * 10000;
  const confidence = (DECISION_CONFIDENCE_RANK[rankToken(decision.submission_confidence)] ?? 0) * 1000;
  const evidence = (DECISION_EVIDENCE_RANK[rankToken(decision.evidence_level)] ?? 0) * 100;
  const recommendationRank = (DECISION_RECOMMENDATION_RANK[recommendation] ?? 1) * 10;
  const reproduction = DECISION_REPRODUCTION_RANK[reproduced] ?? 0;
  return group * 100000 + severity + confidence + evidence + recommendationRank + reproduction;
}

export function sortConfirmDecisionsForSubmission(rows: ConfirmDecision[] | undefined): ConfirmDecision[] {
  return [...(rows ?? [])].sort((a, b) => {
    const priority = confirmDecisionPriority(b) - confirmDecisionPriority(a);
    if (priority !== 0) return priority;
    const aId = typeof a.id === "number" ? a.id : Number.MAX_SAFE_INTEGER;
    const bId = typeof b.id === "number" ? b.id : Number.MAX_SAFE_INTEGER;
    if (aId !== bId) return aId - bId;
    const aBug = a.bug ?? "";
    const bBug = b.bug ?? "";
    return aBug.localeCompare(bBug);
  });
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
  const reproduced = decisions.filter(isSubmissionReadyDecision);
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
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  return {
    ...detail,
    progress,
    statusCounts: refreshing ? {} : detail.statusCounts,
    findingsTotal: allFindings.length,
    auditConfirmedFindings,
    reproducedBugs,
    confirmedBugs: requiresConfirmation ? reproducedBugs : auditConfirmedFindings,
    confirmDecisions,
    allFindings,
  };
}

export function projectConfig(detail: ProjectDetail | null): { cfg: ProjectConfigShape; sourcePaths: string[]; buildRoot: string; corpusPaths: string[] } {
  const project = detail?.project;
  if (!project) return { cfg: {}, sourcePaths: [], buildRoot: "", corpusPaths: [] };
  return {
    cfg: parseJson<ProjectConfigShape>(project.config_json, {}),
    sourcePaths: parseJson<string[]>(project.source_paths, []),
    buildRoot: project.build_root ?? "",
    corpusPaths: parseJson<string[]>(project.corpus_paths, []),
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
  mapSamples?: number;
  digSteps?: number;
  digSamples?: number;
  digMaxSamples?: number;
  adaptiveDig?: boolean;
  eagerPrepare?: boolean;
  digConcurrency?: number;
  verifyConcurrency?: number;
  phases?: PhaseConfig;
  phaseProviders?: Partial<Record<ProviderPhase, number>>;
  engagement?: EngagementConfig;
}

export interface NormalizedContestStrategy {
  enabled: boolean;
  batchScopes: number;
  digConcurrency: number;
  appendMapWhenExhausted: boolean;
  skipRealTargetConfirm: boolean;
  stopAfterHours?: number;
}

export interface ContestReviewState {
  kind: "review-due" | "low-yield" | "inventory-exhausted";
  tone: "info" | "warning";
  label: string;
  detail: string;
  recentAuditedScopes?: number;
  recentConfirmedFindings?: number;
  elapsedHours?: number;
}

export function isBugBountyContestConfig(cfg: Pick<ProjectConfigShape, "engagement"> | undefined): boolean {
  const kind = cfg?.engagement?.kind;
  return kind === BUG_BOUNTY_CONTEST_KIND || kind === "contest";
}

export function isBugBountyConfig(cfg: Pick<ProjectConfigShape, "engagement"> | undefined): boolean {
  const kind = cfg?.engagement?.kind;
  return kind === BUG_BOUNTY_KIND || kind === BUG_BOUNTY_CONTEST_KIND || kind === "contest";
}

export function bugBountyEngagementLabel(cfg: Pick<ProjectConfigShape, "engagement"> | undefined): string {
  if (isBugBountyContestConfig(cfg)) return "Contest";
  return isBugBountyConfig(cfg) ? "Bounty" : "";
}

export function contestStrategy(cfg: Pick<ProjectConfigShape, "engagement"> | undefined): NormalizedContestStrategy {
  const enabled = isBugBountyContestConfig(cfg);
  const strategy: ContestStrategy = cfg?.engagement?.strategy ?? {};
  const positive = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const optionalPositive = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  return {
    enabled,
    batchScopes: positive(strategy.batchScopes, DEFAULT_CONTEST_BATCH_SCOPES),
    digConcurrency: positive(strategy.digConcurrency, DEFAULT_CONTEST_DIG_CONCURRENCY),
    appendMapWhenExhausted: strategy.appendMapWhenExhausted !== false,
    skipRealTargetConfirm: enabled && strategy.skipRealTargetConfirm !== false,
    stopAfterHours: optionalPositive(strategy.stopAfterHours),
  };
}

export function contestReviewState(detail: Pick<ProjectDetail, "project" | "runs" | "allFindings" | "progress">, cfg: ProjectConfigShape): ContestReviewState | null {
  const contest = contestStrategy(cfg);
  if (!contest.enabled) return null;
  const lowYield = recentContestYield(detail, contest.batchScopes);
  if (lowYield) {
    return {
      kind: "low-yield",
      tone: "warning",
      label: "Low marginal yield",
      detail: `The latest ${lowYield.recentAuditedScopes} audited scopes produced no locally confirmed findings. Review duplicate rate, map expansion quality, and whether this contest campaign should pause or change direction.`,
      ...lowYield,
    };
  }
  const elapsedHours = contestElapsedHours(detail, cfg);
  if (contest.stopAfterHours !== undefined && elapsedHours !== undefined && elapsedHours >= contest.stopAfterHours) {
    return {
      kind: "review-due",
      tone: "warning",
      label: "Contest review due",
      detail: `${contest.stopAfterHours}h review window elapsed. Check submitted duplicates, report backlog, and recent yield before opening more scopes.`,
      elapsedHours,
    };
  }
  const progress = detail.progress;
  if (contest.appendMapWhenExhausted && progress.total > 0 && progress.pending === 0) {
    return {
      kind: "inventory-exhausted",
      tone: "info",
      label: "Map expansion ready",
      detail: `The current inventory is exhausted. Continue will append novel scopes before auditing the next ${contest.batchScopes}-scope contest batch.`,
    };
  }
  return null;
}

function contestElapsedHours(detail: Pick<ProjectDetail, "project" | "runs">, cfg: Pick<ProjectConfigShape, "engagement">): number | undefined {
  const startedAt = timestampMs(cfg.engagement?.startsAt)
    ?? timestampMs(detail.project.created_at)
    ?? oldestRunStartedAt(detail.runs);
  if (startedAt === undefined) return undefined;
  return Math.floor((Date.now() - startedAt) / 3_600_000);
}

function oldestRunStartedAt(runs: RunRow[] | undefined): number | undefined {
  const values = (runs ?? []).flatMap((run) => {
    const value = timestampMs(run.started_at);
    return value === undefined ? [] : [value];
  });
  return values.length ? Math.min(...values) : undefined;
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function recentContestYield(
  detail: Pick<ProjectDetail, "runs" | "allFindings" | "progress">,
  batchScopes: number,
): Pick<ContestReviewState, "recentAuditedScopes" | "recentConfirmedFindings"> | null {
  const minimumScopes = Math.max(1, batchScopes * 2);
  if (detail.progress.audited < minimumScopes) return null;
  const recentRunIds = new Set<number>();
  let recentAuditedScopes = 0;
  const runs = [...(detail.runs ?? [])]
    .filter((run) => run.kind === "run" && run.status === "done" && !isVerifyRun(run))
    .sort((a, b) => (timestampMs(b.started_at) ?? 0) - (timestampMs(a.started_at) ?? 0));
  for (const run of runs) {
    const audited = runScopeCount(run);
    if (audited <= 0) continue;
    recentRunIds.add(run.id);
    recentAuditedScopes += audited;
    if (recentAuditedScopes >= minimumScopes) break;
  }
  if (recentAuditedScopes < minimumScopes) return null;
  const recentConfirmedFindings = (detail.allFindings ?? []).filter((finding) => {
    return finding.run_id != null && recentRunIds.has(finding.run_id) && isExecutionConfirmedFinding(finding);
  }).length;
  return recentConfirmedFindings === 0 ? { recentAuditedScopes, recentConfirmedFindings } : null;
}

function runScopeCount(run: RunRow): number {
  const done = Number(run.run_scopes_done);
  if (Number.isFinite(done) && done > 0) return Math.floor(done);
  const target = Number(run.run_scopes_target);
  return Number.isFinite(target) && target > 0 ? Math.floor(target) : 0;
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
  return Boolean(run && (run.kind === "verify" || parseJson<{ verify?: boolean }>(run.budgets_json, {}).verify === true));
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
  confirm?: {
    status?: string;
    findings?: number;
    rows?: number;
    reproducedYes?: number;
    submitCandidates?: number;
    needsHuman?: number;
    commandRuns?: number;
    confirmRuns?: number;
    passed?: number;
    failed?: number;
    startedAt?: string;
    at?: string;
  };
}

function stages(run: RunRow | undefined): RunStages {
  if (!run?.stages_json) return {};
  return parseJson<RunStages>(run.stages_json, {});
}

function latestRunWithStage(runs: RunRow[], stage: keyof RunStages): RunRow | undefined {
  return runs.find((run) => Boolean(stages(run)[stage]));
}

function latestCoverageTimelineRun(runs: RunRow[]): RunRow | undefined {
  return runs.find((run) => {
    if (run.kind === "map") return true;
    if (run.kind !== "run") return false;
    return Boolean(run.dig_started_at || run.scopes_total != null || run.run_scopes_target != null || stages(run).synthesis);
  }) ?? runs.find((run) => run.kind === "run" || run.kind === "map");
}

function boundedDurationMs(startMs: number, endMs: number): number {
  return startMs > 0 && endMs > startMs ? endMs - startMs : 0;
}

function runEndMs(run: RunRow, nowMs: number): number {
  if (run.status === "running") return nowMs;
  return startedAtMs(run.ended_at);
}

function coveragePhaseDurations(runs: RunRow[], nowMs = Date.now()): { mapMs: number; digMs: number } {
  let mapMs = 0;
  let digMs = 0;

  for (const run of runs) {
    if (isVerifyRun(run) || !["run", "audit", "map"].includes(run.kind)) continue;
    const startMs = startedAtMs(run.started_at);
    if (!startMs) continue;

    const endMs = runEndMs(run, nowMs);
    const digStartMs = startedAtMs(run.dig_started_at);
    const synthStartMs = startedAtMs(stages(run).synthesis?.startedAt);

    if (run.kind === "map") {
      mapMs += boundedDurationMs(startMs, endMs);
      continue;
    }

    if (run.kind === "run") {
      if (digStartMs > startMs) {
        mapMs += boundedDurationMs(startMs, digStartMs);
      } else if (!digStartMs && run.status === "done" && run.scopes_total != null && run.run_scopes_target == null) {
        mapMs += boundedDurationMs(startMs, endMs);
      }
    }

    const effectiveDigStartMs = digStartMs > 0 ? digStartMs : run.kind === "audit" ? startMs : 0;
    if (!effectiveDigStartMs) continue;
    const effectiveDigEndMs = synthStartMs > effectiveDigStartMs ? synthStartMs : endMs;
    digMs += boundedDurationMs(effectiveDigStartMs, effectiveDigEndMs);
  }

  return { mapMs, digMs };
}

function confirmProgressStat(run: RunRow | undefined): string {
  const progress = stages(run).confirm;
  if (!progress) return "";
  const rows = Number(progress.rows ?? 0);
  if (rows > 0) {
    const reproduced = Number(progress.reproducedYes ?? 0);
    const needsHuman = Number(progress.needsHuman ?? 0);
    const parts = [
      `${reproduced}/${rows} reproduced`,
      needsHuman > 0 ? `${needsHuman} need human` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const confirmRuns = Number(progress.confirmRuns ?? 0);
  if (confirmRuns > 0) {
    const passed = Number(progress.passed ?? 0);
    const failed = Number(progress.failed ?? 0);
    const parts = [
      `${confirmRuns} real-target ${confirmRuns === 1 ? "check" : "checks"}`,
      passed > 0 ? `${passed} passed` : "",
      failed > 0 ? `${failed} failed` : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const commandRuns = Number(progress.commandRuns ?? 0);
  if (commandRuns > 0) return `${commandRuns} ${commandRuns === 1 ? "command" : "commands"} run · preparing reproduction`;
  const findings = Number(progress.findings ?? 0);
  return findings > 0 ? `${findings} ${findings === 1 ? "finding" : "findings"} in confirmation` : "";
}

function completedScopeBatch(run: RunRow | undefined): boolean {
  return Boolean(run?.status === "done" && run.run_scopes_target != null && (run.run_scopes_done ?? 0) >= run.run_scopes_target);
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
    ? findings.filter((finding) => isExecutionConfirmedFinding(finding)
      && !finding.confirm_status
      && !findingCoveredByDecision(finding, decidedFindingKeys)).length
    : 0;
  const pendingVerify = findings.filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source").length;
  const locallyVerified = findings.filter(isExecutionConfirmedFinding).length;
  const needsEvidence = findings.filter((finding) => finding.status === "needs-evidence").length;
  const audit = runs.find((r) => r.status === "running" && ["run", "audit", "map", "verify"].includes(r.kind));
  const auditLatest = latest("run", "audit", "map");
  const coverageTimelineRun = latestCoverageTimelineRun(runs);
  const verifyLatest = runs.find((run) => isVerifyRun(run));
  const reportLatest = latest("report");
  const reportRunning = reportLatest?.status === "running";
  const reportError = reportLatest?.status === "error";
  const activeScope = (detail.activeScopeCount ?? 0) > 0 || Boolean((detail.scopes ?? []).some((scope) => scope.status === "auditing"));
  const isVerify = isVerifyRun(audit);
  const digStarted = Boolean(audit && audit.run_scopes_target != null);
  const mapRunning = Boolean(audit && !isVerify && audit.kind !== "audit" && !digStarted);
  const batchDone = runScopeBatchComplete(audit);
  const verifyProgress = verifyRunProgress(audit);
  const verifyRechecksConfirmed = verifyRunRechecksConfirmed(audit, pendingVerify, findings.length);
  const pendingConfirm = verifyRechecksConfirmed ? 0 : pendingConfirmRaw;
  const finalizingAudit = Boolean(batchDone && audit && !isVerify && !activeScope);
  const digRunning = Boolean(audit && !isVerify && (audit.kind === "audit" || digStarted) && !finalizingAudit);
  const synthesisWaiting = Boolean(audit && !isVerify && !finalizingAudit && !synthesis && progress.audited > 0);
  const thisRun = audit && audit.run_scopes_target != null
    ? batchDone
      ? " · finalizing"
      : ` · current run ${audit.run_scopes_done ?? 0}/${audit.run_scopes_target}`
    : "";
  const verifyStat = verifyProgress
    ? `Verifying ${verifyProgress.done}/${verifyProgress.target} findings${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
    : "";
  const finishedSelectedDigBatch = completedScopeBatch(coverageTimelineRun ?? auditLatest);
  const phaseDurations = coveragePhaseDurations(runs);
  const mapDur = progress.total > 0 || mapRunning ? fmtDur(phaseDurations.mapMs) : "";
  const digDur = progress.audited > 0 || digRunning ? fmtDur(phaseDurations.digMs) : "";
  const synthesisStartMs = synthesis?.startedAt ? new Date(synthesis.startedAt).getTime() : 0;
  const synthesisEndMs = synthesis?.at ? new Date(synthesis.at).getTime() : 0;
  const synthesisDur = finalizingAudit && synthesisStartMs
    ? fmtDur(Date.now() - synthesisStartMs)
    : synthesisStartMs && synthesisEndMs > synthesisStartMs
      ? fmtDur(synthesisEndMs - synthesisStartMs)
      : "";
  const reportPackages = reportPackageStats(findings, decisions, requiresConfirmation);
  const confirmRunningProgress = conf?.status === "running" ? confirmProgressStat(conf) : "";

  return {
    prepare: { status: prep ? prep.status : "none", stat: prep ? (prep.status === "done" ? "Source staged" : prep.status === "running" ? "Preparing source" : prep.status) : "Not started", dur: runDur(prep, prep?.status === "running") },
    map: { status: mapRunning ? "running" : progress.total > 0 ? "done" : "none", stat: progress.total > 0 ? `${progress.total} scopes mapped` : mapRunning ? "Mapping scopes" : "Not started", dur: mapDur },
    dig: {
      status: digRunning ? "running" : progress.audited > 0 ? (progress.pending > 0 && !finishedSelectedDigBatch ? "partial" : "done") : progress.total > 0 ? "pending" : "none",
      stat: finalizingAudit
          ? `Finalizing local evidence · ${progress.audited}/${progress.total} scopes audited${detail.findingsTotal ? ` · ${detail.findingsTotal} in project` : ""}`
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
          : synthesisWaiting
            ? "pending"
          : progress.audited > 0
            ? "done"
            : "none",
      stat: finalizingAudit
        ? "Synthesizing bug candidates"
        : synthesis
          ? `${synthesis.produced ?? 0} synthesized ${synthesis.produced === 1 ? "candidate" : "candidates"}`
          : synthesisWaiting
            ? "Waiting for dig to finish"
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
        : !requiresConfirmation
          ? "done"
        : decisions.length
          ? (repro === decisions.length && pendingConfirm === 0 && decisions.filter(needsSubmissionReadinessWork).length === 0 ? "done" : "partial")
          : pendingConfirm > 0
            ? "pending"
            : "none",
      stat: conf?.status === "error"
        ? "Confirm blocked"
        : !requiresConfirmation
        ? "Not required"
        : verifyRechecksConfirmed
          ? "Waiting for Verify to finish"
        : decisions.length
        ? `${repro}/${decisions.length} reproduced${confirmDecisionTail(decisions)}${pendingConfirm ? ` · ${pendingConfirm} ${pendingConfirm === 1 ? "finding" : "findings"} waiting` : ""}`
        : confirmRunningProgress
          ? confirmRunningProgress
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
              ? "No submission-ready bug yet"
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
    if (rows.length) return `${rows.filter((d) => d.reproduced === "yes").length}/${rows.length} reproduced`;
    return confirmProgressStat(run) || "No decisions recorded yet";
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
  if (run.status === "running") {
    if (isVerifyRun(run)) return "Preparing candidate verification";
    if (run.kind === "prepare") return "Preparing target";
    if (run.kind === "report") return "Generating reports";
    if (run.kind === "map" || run.kind === "run") return "Mapping project scope";
    if (run.kind === "audit") return run.dig_started_at ? "Starting scope audits" : "Preparing scope audit";
  }
  return run.findings_total != null ? `${run.findings_total} ${run.findings_total === 1 ? "finding" : "findings"}` : "No progress recorded yet";
}

export function reportFileForFinding(finding: FindingRow): string {
  const name = (finding.report_path ?? "").split("/").pop() ?? "";
  return /^report_[a-z0-9_.-]+\.md$/.test(name) ? name : "audit_report.md";
}
