import type { AgentFinding, AgentSession, AuditScope, CommandRunRecord } from "./tools.js";
import { latestScopeOutcomes, scopeOutcomeNeedsCoverage, type ScopeOutcome } from "./scope-outcomes.js";

export const COVERAGE_GAPS_FILE = "coverage_gaps.json";
export const RESOURCE_REQUESTS_FILE = "resource_requests.json";
export const FOLLOWUP_SCOPES_FILE = "followup_scopes.json";
export const RUN_HEALTH_FILE = "run_health.json";

export type DiscoveryArtifactStatus = "open" | "resolved" | "stale";

export interface CoverageGap {
  id: string;
  status: DiscoveryArtifactStatus;
  phase?: string;
  scopeId?: string;
  region?: string;
  obligation: string;
  reason: string;
  nextAction?: string;
  severity?: string;
}

export interface ResourceRequest {
  id: string;
  status: DiscoveryArtifactStatus;
  /** Trusted framework provenance. Model-authored requests intentionally omit this. */
  origin?: "framework-prepare";
  kind: "toolchain" | "dependency" | "sandbox-image" | "network" | "credential" | "artifact" | "environment" | "other";
  scopeId?: string;
  findingId?: string;
  needed: string;
  reason: string;
  unblock?: string;
  retryCommand?: string;
  priority?: "low" | "medium" | "high";
}

export interface DiscoveryArtifacts {
  coverageGaps: CoverageGap[];
  resourceRequests: ResourceRequest[];
  followupScopes: AuditScope[];
}

export type RunHealthStatus = "healthy" | "needs-coverage" | "needs-resource" | "shallow" | "infra-failed";

export interface RunHealth {
  status: RunHealthStatus;
  reasons: string[];
  signals: {
    stoppedReason: string;
    toolSteps: number;
    modelErrorSteps: number;
    parseErrorSteps: number;
    commandRuns: number;
    confirmRuns: number;
    scopesTotal: number;
    scopesAudited: number;
    scopesPending: number;
    findingsConfirmed: number;
    hypotheses: number;
    coverageGaps: number;
    resourceRequests: number;
    followupScopes: number;
    findingParseErrors: number;
    infraErrors: number;
    scopeOutcomes: number;
    scopeOutcomesIncomplete: number;
    mapSamples: number;
    mapScopesWithAgreement: number;
  };
}

export function readDiscoveryArtifacts(session: AgentSession): DiscoveryArtifacts {
  return {
    coverageGaps: readScratchCoverageGaps(session),
    resourceRequests: readScratchResourceRequests(session),
    followupScopes: readScratchFollowupScopes(session),
  };
}

export function readScratchCoverageGaps(session: AgentSession): CoverageGap[] {
  return dedupeByKey(readScratchObjects(session, COVERAGE_GAPS_FILE, ["coverage_gaps", "gaps"]).map(normalizeCoverageGap).filter((gap): gap is CoverageGap => Boolean(gap)), gapKey);
}

export function readScratchResourceRequests(session: AgentSession): ResourceRequest[] {
  return dedupeByKey(readScratchObjects(session, RESOURCE_REQUESTS_FILE, ["resource_requests", "requests", "resources"]).map(normalizeResourceRequest).filter((request): request is ResourceRequest => Boolean(request)), resourceKey);
}

export function readScratchFollowupScopes(session: AgentSession): AuditScope[] {
  const raw = readScratchObjects(session, FOLLOWUP_SCOPES_FILE, ["followup_scopes", "scopes", "followups"]);
  const scopes = raw.map(normalizeFollowupScope).filter((scope): scope is AuditScope => Boolean(scope));
  return dedupeByKey(scopes, (scope) => `${scope.region.trim().toLowerCase()}::${scope.obligation.trim().toLowerCase()}`);
}

export function mergeFollowupScopes(inventory: AuditScope[], followups: AuditScope[]): { scopes: AuditScope[]; added: number } {
  if (followups.length === 0) return { scopes: inventory, added: 0 };
  const out = [...inventory];
  const existingIds = new Set(out.map((scope) => scope.id.toLowerCase()));
  const existingShape = new Set(out.map((scope) => `${scope.region.trim().toLowerCase()}::${scope.obligation.trim().toLowerCase()}`));
  let added = 0;
  for (const followup of followups) {
    const shape = `${followup.region.trim().toLowerCase()}::${followup.obligation.trim().toLowerCase()}`;
    if (existingShape.has(shape)) continue;
    let id = followup.id.trim() || `FU${added + 1}`;
    if (existingIds.has(id.toLowerCase())) id = nextFollowupId(existingIds, id);
    existingIds.add(id.toLowerCase());
    existingShape.add(shape);
    out.push({ ...followup, id, status: "pending", source: "followup" });
    added += 1;
  }
  return { scopes: out, added };
}

export function buildRunHealth(input: {
  stoppedReason: string;
  steps: Array<{ tool: string }>;
  commandRuns: CommandRunRecord[];
  scopes: AuditScope[];
  confirmed: AgentFinding[];
  hypotheses: AgentFinding[];
  coverageGaps: CoverageGap[];
  resourceRequests: ResourceRequest[];
  followupScopes: AuditScope[];
  scopeOutcomes?: ScopeOutcome[];
  findingParseErrors?: number;
  infraErrors?: number;
  mode?: "breadth" | "map" | "map-dig" | "verify" | "dig" | "confirm";
}): RunHealth {
  const modelErrorSteps = input.steps.filter((step) => step.tool === "(model-error)" || step.tool === "(session-error)").length;
  const parseErrorSteps = input.steps.filter((step) => step.tool === "(parse-error)").length;
  const toolSteps = input.steps.filter((step) => !String(step.tool).startsWith("(")).length;
  const commandRuns = input.commandRuns.length;
  const confirmRuns = input.commandRuns.filter((run) => run.purpose === "confirm" || run.successPatterns.length > 0).length;
  const scopesAudited = input.scopes.filter((scope) => scope.status === "audited").length;
  const scopesPending = input.scopes.filter((scope) => scope.status !== "audited" && scope.status !== "deferred").length;
  const openGaps = input.coverageGaps.filter((gap) => gap.status !== "resolved").length;
  const openResources = input.resourceRequests.filter((request) => request.status !== "resolved").length;
  const followupScopes = input.followupScopes.length;
  const findingParseErrors = input.findingParseErrors ?? 0;
  const infraErrors = input.infraErrors ?? 0;
  const scopeOutcomes = latestScopeOutcomes(input.scopeOutcomes ?? []);
  const scopeOutcomesIncomplete = scopeOutcomes.filter(scopeOutcomeNeedsCoverage).length;
  const mapSamples = input.scopes.reduce((maximum, scope) => Math.max(maximum, ...(scope.mapSamples ?? [0])), 0);
  const mapScopesWithAgreement = input.scopes.filter((scope) => (scope.mapAgreement ?? 0) > 1).length;

  const reasons: string[] = [];
  let status: RunHealthStatus = "healthy";
  const setStatus = (next: RunHealthStatus, reason: string): void => {
    if (status === "healthy") status = next;
    reasons.push(reason);
  };

  if (input.stoppedReason === "error" || input.stoppedReason === "stalled") {
    setStatus("infra-failed", `run stopped as ${input.stoppedReason} or recorded model/session errors`);
  }
  if (infraErrors > 0) {
    if (status === "healthy") status = "infra-failed";
    reasons.push(`${infraErrors} post-dig infrastructure error(s) prevented a required verdict`);
  }
  if (findingParseErrors > 0 || parseErrorSteps > 0) {
    if (status === "healthy") status = "infra-failed";
    reasons.push("the model wrote malformed action or finding JSON");
  }
  if (status === "healthy" && openResources > 0) {
    setStatus("needs-resource", `${openResources} resource request(s) block deeper exploration or confirmation`);
  }
  if (status === "healthy" && (input.mode === "map" || input.mode === "map-dig") && input.scopes.length === 0) {
    setStatus("shallow", "map/dig run ended without a scope inventory");
  }
  if (status === "healthy" && toolSteps < 4 && input.confirmed.length === 0 && input.hypotheses.length === 0 && openGaps === 0 && openResources === 0 && followupScopes === 0) {
    setStatus("shallow", "run ended after very little tool-backed exploration and produced no actionable backlog");
  }
  if (status === "healthy" && (openGaps > 0 || followupScopes > 0)) {
    setStatus("needs-coverage", `${openGaps} coverage gap(s) and ${followupScopes} follow-up scope(s) remain`);
  }
  if (status === "healthy" && scopeOutcomesIncomplete > 0) {
    setStatus("needs-coverage", `${scopeOutcomesIncomplete} scope outcome(s) remain incomplete`);
  }

  if (reasons.length === 0) reasons.push("no framework health blocker detected");

  return {
    status,
    reasons,
    signals: {
      stoppedReason: input.stoppedReason,
      toolSteps,
      modelErrorSteps,
      parseErrorSteps,
      commandRuns,
      confirmRuns,
      scopesTotal: input.scopes.length,
      scopesAudited,
      scopesPending,
      findingsConfirmed: input.confirmed.length,
      hypotheses: input.hypotheses.length,
      coverageGaps: openGaps,
      resourceRequests: openResources,
      followupScopes,
      findingParseErrors,
      infraErrors,
      scopeOutcomes: scopeOutcomes.length,
      scopeOutcomesIncomplete,
      mapSamples,
      mapScopesWithAgreement,
    },
  };
}

function readScratchObjects(session: AgentSession, basename: string, keys: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of scratchEntries(session, basename)) {
    let raw: unknown;
    try {
      raw = JSON.parse(entry.content);
    } catch {
      continue;
    }
    const items = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? keys.flatMap((key) => {
            const value = (raw as Record<string, unknown>)[key];
            return Array.isArray(value) ? value : [];
          })
        : [];
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

function scratchEntries(session: AgentSession, basename: string): Array<{ path: string; content: string }> {
  return [...session.scratchFiles.entries()]
    .filter(([filePath]) => filePath === basename || filePath.endsWith(`/${basename}`))
    .map(([filePath, content]) => ({ path: filePath, content }));
}

function normalizeCoverageGap(row: Record<string, unknown>, index: number): CoverageGap | undefined {
  const obligation = asString(row.obligation) ?? asString(row.title) ?? asString(row.gap);
  const reason = asString(row.reason) ?? asString(row.why) ?? asString(row.evidence);
  if (!obligation || !reason) return undefined;
  const out: CoverageGap = {
    id: asString(row.id) ?? `G${index + 1}`,
    status: artifactStatus(row.status),
    obligation,
    reason,
  };
  const phase = asString(row.phase);
  const scopeId = asString(row.scope_id) ?? asString(row.scopeId);
  const region = asString(row.region) ?? asString(row.location);
  const nextAction = asString(row.next_action) ?? asString(row.nextAction);
  const severity = asString(row.severity);
  if (phase) out.phase = phase;
  if (scopeId) out.scopeId = scopeId;
  if (region) out.region = region;
  if (nextAction) out.nextAction = nextAction;
  if (severity) out.severity = severity;
  return out;
}

function normalizeResourceRequest(row: Record<string, unknown>, index: number): ResourceRequest | undefined {
  const needed = asString(row.needed) ?? asString(row.need) ?? asString(row.resource);
  const reason = asString(row.reason) ?? asString(row.why);
  if (!needed || !reason) return undefined;
  const rawKind = (asString(row.kind) ?? "other").toLowerCase();
  const kind = ["toolchain", "dependency", "sandbox-image", "network", "credential", "artifact", "environment"].includes(rawKind)
    ? rawKind as ResourceRequest["kind"]
    : "other";
  const priority = asEnum(row.priority, ["low", "medium", "high"]);
  const out: ResourceRequest = {
    id: asString(row.id) ?? `R${index + 1}`,
    status: artifactStatus(row.status),
    kind,
    needed,
    reason,
  };
  const scopeId = asString(row.scope_id) ?? asString(row.scopeId);
  const findingId = asString(row.finding_id) ?? asString(row.findingId);
  const unblock = asString(row.unblock) ?? asString(row.unblocks);
  const retryCommand = asString(row.retry_command) ?? asString(row.retryCommand);
  if (scopeId) out.scopeId = scopeId;
  if (findingId) out.findingId = findingId;
  if (unblock) out.unblock = unblock;
  if (retryCommand) out.retryCommand = retryCommand;
  if (priority) out.priority = priority;
  return out;
}

function normalizeFollowupScope(row: Record<string, unknown>, index: number): AuditScope | undefined {
  const region = asString(row.region) ?? asString(row.location);
  const obligation = asString(row.obligation) ?? asString(row.title) ?? asString(row.scope);
  if (!region || !obligation) return undefined;
  const scoreNum = typeof row.score === "number" ? row.score : Number.parseFloat(asString(row.score) ?? "");
  const out: AuditScope = {
    id: asString(row.id) ?? `FU${index + 1}`,
    obligation,
    region,
    lenses: asStringList(row.lenses),
    exposure: asString(row.exposure) ?? "unknown",
    difficulty: asString(row.difficulty) ?? "unknown",
    score: Number.isFinite(scoreNum) ? scoreNum : 0,
    why: asString(row.why) ?? asString(row.reason) ?? "model-proposed follow-up scope",
    status: "pending",
    source: "followup",
  };
  const parentScopeId = asString(row.parent_scope_id) ?? asString(row.parentScopeId);
  if (parentScopeId) out.parentScopeId = parentScopeId;
  return out;
}

function artifactStatus(value: unknown): DiscoveryArtifactStatus {
  const raw = asString(value)?.toLowerCase();
  return raw === "resolved" || raw === "stale" ? raw : "open";
}

function gapKey(gap: CoverageGap): string {
  return `${gap.scopeId ?? ""}::${gap.region ?? ""}::${gap.obligation}::${gap.reason}`.toLowerCase();
}

function resourceKey(request: ResourceRequest): string {
  return `${request.kind}::${request.scopeId ?? ""}::${request.needed}::${request.reason}`.toLowerCase();
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function nextFollowupId(existingIds: Set<string>, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "FU";
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${clean}-followup-${i}`;
    if (!existingIds.has(candidate.toLowerCase())) return candidate;
  }
  return `FU-${Date.now()}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const raw = asString(value);
  return raw && (allowed as readonly string[]).includes(raw) ? raw as T : undefined;
}
