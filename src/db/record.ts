// Bridges a live audit/confirm run to the SQLite metadata store. Maps the kernel's
// in-memory types (AuditScope, AgentFinding, confirm rows) to store rows and writes them
// as the run progresses. Every method is FAILURE-ISOLATED: a DB hiccup disables further
// writes and emits a `db_record_error` event, but never throws into the audit — the
// run's evidentiary files remain the source of the content regardless.

import path from "node:path";
import { renderDisclosure, reportArtifactName } from "../reports/disclosure.js";
import { findingContentKey } from "../util/finding-key.js";
import type { AuditorConfig } from "../config.js";
import type { AgentFinding, AuditScope } from "../agent/tools.js";
import type { CoverageGap, ResourceRequest, RunHealth } from "../agent/discovery-artifacts.js";
import type { RankedFinding } from "../types.js";
import { MetadataStore, type Coverage, type DiscoveryBacklogInput, type FindingRow, type FindingStatus, type RunKind, type RunStatus, type ScopeRow } from "./store.js";

export interface RunLoggerLike {
  event(kind: string, data?: Record<string, unknown>): Promise<void>;
}

export interface ConfirmDecisionInput {
  bug: string;
  reproduced?: string | undefined;
  recommendation?: string | undefined;
  members?: string[] | undefined;
  severity?: string | undefined;
  evidenceLevel?: string | undefined;
  submissionConfidence?: string | undefined;
  distinctFix?: string | undefined;
  reproEvidence?: string | undefined;
  corroboration?: string | undefined;
  novelty?: string | undefined;
  humanGates?: string | undefined;
  engagementProfile?: unknown;
  adjudication?: unknown;
  mergedFrom?: string[] | undefined;
  reproCommandId?: string | undefined;
  reportMarkdown?: string | undefined;
}

export interface FindingReportInput {
  findingId?: number;
  decisionId?: number;
  markdown: string;
}

// What runAudit/runConfirm need to report a run's progress. The default impl (RunRecorder)
// writes the local SQLite store; a daemon can supply a remote impl that POSTs to a server
// (so execution can live on a different machine from the control plane / DB).
export interface RunTracker {
  readonly runDbId: number | undefined;
  scopes(scopes: AuditScope[]): void;
  /** This run's dig batch: how many scopes it is digging (target) + how many done so far. */
  runScopes(done: number, target: number): void;
  findings(findings: AgentFinding[], runDir: string, reason?: string): void;
  /** Record one post-dig stage's outcome (synthesis / differential / refutation / discharge-challenge). */
  stage(name: string, info: Record<string, unknown>): void;
  /** Persist the run-health verdict used by the dashboard and API. */
  health?(health: RunHealth): void;
  /** Replace this run's discovery backlog rows (coverage gaps, resource requests, follow-up scopes). */
  backlog?(rows: DiscoveryBacklogInput[]): void;
  confirmDecisions(rows: ConfirmDecisionInput[], decisionPath?: string): void;
  findingReports(reports: FindingReportInput[]): void;
  finish(status: RunStatus, coverage?: Coverage, findingsTotal?: number): void;
}

export type RunTrackerFactory = (cfg: AuditorConfig, runDir: string, kind: RunKind, logger?: RunLoggerLike) => RunTracker;

export class RunRecorder implements RunTracker {
  private store: MetadataStore | undefined;
  private projectId: number | undefined;
  private runId: number | undefined;
  private readonly logger: RunLoggerLike | undefined;
  private readonly targetName: string;

  private constructor(targetName: string, logger?: RunLoggerLike) {
    this.targetName = targetName;
    this.logger = logger;
  }

  /** Open the store and record the project + a running run. Returns a recorder that is a
   * no-op if the DB could not be opened. */
  static start(cfg: AuditorConfig, runDir: string, kind: RunKind, logger?: RunLoggerLike): RunRecorder {
    const recorder = new RunRecorder(cfg.targetName, logger);
    try {
      recorder.store = MetadataStore.openForOutput(cfg.outputDir);
      recorder.projectId = recorder.store.upsertProject({
        name: cfg.targetName,
        sourcePaths: cfg.sourcePaths,
        buildRoot: cfg.buildRoot,
        corpusPaths: cfg.corpusPaths,
        config: configSnapshot(cfg),
      });
      recorder.runId = recorder.store.startRun({
        projectId: recorder.projectId,
        kind,
        runDir,
        provider: cfg.provider,
        model: cfg.auditModel,
        thinking: cfg.thinkingLevel,
        // Mark a verify run (in the run's budgets only, not the project config) so the dashboard can
        // show "verifying N/M findings" instead of mislabeling it as a dig.
        budgets: cfg.auditVerify ? { ...configSnapshot(cfg), verify: true, ...(cfg.auditVerifyFromStart ? { verifyFromStart: true } : {}) } : configSnapshot(cfg),
        // The OS pid lets a supervising run-manager correlate this DB row to the process
        // it spawned (and reconcile status if the process dies before finalize).
        pid: process.pid,
      });
    } catch (error) {
      recorder.disable("start", error);
    }
    return recorder;
  }

  get runDbId(): number | undefined {
    return this.runId;
  }

  /** Upsert the current scope inventory and refresh this run's live coverage. */
  scopes(scopes: AuditScope[]): void {
    if (!this.ready()) return;
    try {
      this.store!.replaceScopes(this.projectId!, scopes.map(toScopeRow));
      this.store!.updateRunCoverage(this.runId!, this.store!.scopeProgress(this.projectId!));
    } catch (error) {
      this.disable("scopes", error);
    }
  }

  /** Record this run's dig batch progress (target = scopes this run will dig, done = completed). */
  runScopes(done: number, target: number): void {
    if (!this.ready()) return;
    try {
      this.store!.updateRunScopes(this.runId!, done, target);
    } catch (error) {
      this.disable("run-scopes", error);
    }
  }

  /** Upsert findings (recording any status transition on the timeline). */
  findings(findings: AgentFinding[], runDir: string, reason?: string): void {
    if (!this.ready() || findings.length === 0) return;
    try {
      this.store!.upsertFindings(this.projectId!, this.runId!, findings.map((finding) => toFindingRow(finding, runDir, this.targetName)), reason);
    } catch (error) {
      this.disable("findings", error);
    }
  }

  stage(name: string, info: Record<string, unknown>): void {
    if (!this.ready()) return;
    try {
      this.store!.recordStage(this.runId!, name, info);
    } catch (error) {
      this.disable("stage", error);
    }
  }

  health(health: RunHealth): void {
    if (!this.ready()) return;
    try {
      this.store!.recordRunHealth(this.runId!, health);
    } catch (error) {
      this.disable("health", error);
    }
  }

  backlog(rows: DiscoveryBacklogInput[]): void {
    if (!this.ready()) return;
    try {
      this.store!.replaceDiscoveryBacklog(this.projectId!, this.runId!, rows);
    } catch (error) {
      this.disable("backlog", error);
    }
  }

  confirmDecisions(rows: ConfirmDecisionInput[], decisionPath?: string): void {
    if (!this.ready() || rows.length === 0) return;
    try {
      this.store!.upsertConfirmDecisions(this.projectId!, this.runId!, rows, decisionPath);
    } catch (error) {
      this.disable("confirm-decisions", error);
    }
  }

  findingReports(reports: FindingReportInput[]): void {
    if (!this.ready() || reports.length === 0) return;
    try {
      for (const report of reports) {
        if (typeof report.decisionId === "number") {
          this.store!.setConfirmDecisionReport(this.projectId!, report.decisionId, report.markdown);
        } else if (typeof report.findingId === "number") {
          this.store!.setFindingReport(this.projectId!, report.findingId, report.markdown);
        }
      }
    } catch (error) {
      this.disable("finding-reports", error);
    }
  }

  /** Mark the run done/error and persist its final coverage + finding count. */
  finish(status: RunStatus, coverage?: Coverage, findingsTotal?: number): void {
    if (!this.ready()) return;
    try {
      this.store!.finishRun(this.runId!, status, coverage, findingsTotal);
    } catch (error) {
      this.disable("finish", error);
    } finally {
      this.tryClose();
    }
  }

  private ready(): boolean {
    return this.store !== undefined && this.projectId !== undefined && this.runId !== undefined;
  }

  private disable(where: string, error: unknown): void {
    this.tryClose();
    this.store = undefined;
    void this.logger?.event("db_record_error", { where, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }

  private tryClose(): void {
    try {
      this.store?.close();
    } catch {
      // closing a broken handle is best-effort
    }
  }
}

// The DB status is the kernel's confirmationStatus, except a skeptic-disputed finding or a
// verify-mode REFUTED verdict is surfaced as structured "refuted" state instead of leaving it
// in the suspected queue with a status prefix embedded in the title.
function toFindingStatus(finding: AgentFinding): FindingStatus {
  if (finding.disputed || isRefutedTitle(finding.title)) return "refuted";
  if (finding.originId != null && finding.confirmationStatus === "suspected") return "needs-evidence";
  return finding.confirmationStatus as FindingStatus;
}

function isRefutedTitle(title: string): boolean {
  return /^\s*REFUTED\s*:/i.test(title);
}

function stripFindingStatusPrefix(title: string): string {
  return title.replace(/^\s*(?:REFUTED|CONFIRMED|DISCHARGED)\s*:\s*/i, "").trim() || title.trim();
}

function isConfirmedLike(status: string): boolean {
  return status === "confirmed-source" || status === "confirmed-executable" || status === "confirmed-differential";
}

// A CONTENT-stable dedup key (shared with the confirm phase via util/finding-key): the display id
// (f1..fN) is renumbered at finalize, so keying the DB row on it would orphan rows when findings are
// persisted incrementally (per scope, then re-persisted with updated statuses through differential /
// refutation / appeal). Hashing scope+location+title keeps the SAME row across those updates.
function stableFindingKey(finding: AgentFinding): string {
  const key = findingContentKey(finding.scopeId, finding.location, stripFindingStatusPrefix(finding.title));
  return key === "k0" ? finding.id : key;
}

export function toFindingRow(finding: AgentFinding, runDir: string, targetName = "Flounder audit target"): FindingRow {
  return {
    findingKey: stableFindingKey(finding),
    title: stripFindingStatusPrefix(finding.title),
    location: finding.location,
    severity: finding.severity,
    status: toFindingStatus(finding),
    // Only confirmed findings get a disclosure report artifact (written at finalize under the final id).
    reportPath: finding.id && isConfirmedLike(finding.confirmationStatus) ? path.join(runDir, reportArtifactName(finding.id)) : undefined,
    reportMarkdown: renderFindingDisclosure(targetName, finding),
    scopeId: finding.scopeId,
    // The rich content, so the DB holds the finding in full (the verify/confirm pipeline + UI read
    // it from here instead of scraping the run dir's audit_hypotheses / audit_findings artifacts).
    description: finding.description,
    evidence: finding.evidence,
    exploitSketch: finding.exploitSketch,
    fix: finding.fix,
    confidence: finding.confidence,
    // VERIFY provenance: when set, the verdict flips the original suspected row instead of inserting.
    originId: finding.originId,
  };
}

function renderFindingDisclosure(targetName: string, finding: AgentFinding): string {
  return renderDisclosure(targetName, {
    id: finding.id,
    location: finding.location,
    failureMode: "autonomous",
    title: finding.title,
    severity: finding.severity,
    hitRate: 1,
    confidence: finding.confidence,
    score: finding.confidence,
    description: finding.description,
    evidence: finding.evidence,
    exploitSketch: finding.exploitSketch,
    fix: finding.fix,
    confirmationStatus: finding.confirmationStatus,
    commandRunId: finding.commandRunId,
    patchedSuccessPatterns: finding.patchedSuccessPatterns,
    disputed: finding.disputed,
    refutationReason: finding.refutation?.reason,
  } as RankedFinding);
}

export function toScopeRow(scope: AuditScope): ScopeRow {
  const status = scope.status === "audited" ? "audited" : scope.status === "deferred" ? "deferred" : scope.status === "auditing" ? "auditing" : "pending";
  return {
    scopeId: scope.id,
    title: scope.obligation,
    location: scope.region,
    score: scope.score,
    status,
    digSeconds: scope.digSeconds,
    priority: scope.priority,
    source: scope.source,
    parentScopeId: scope.parentScopeId,
  };
}

export function toDiscoveryBacklogRows(input: {
  coverageGaps?: CoverageGap[];
  resourceRequests?: ResourceRequest[];
  followupScopes?: AuditScope[];
}): DiscoveryBacklogInput[] {
  const rows: DiscoveryBacklogInput[] = [];
  for (const gap of input.coverageGaps ?? []) {
    rows.push({
      kind: "coverage-gap",
      status: discoveryStatus(gap.status),
      scopeId: gap.scopeId,
      title: gap.obligation,
      location: gap.region ?? gap.phase,
      reason: gap.reason,
      nextAction: gap.nextAction,
      priority: gap.severity,
      payload: gap,
    });
  }
  for (const request of input.resourceRequests ?? []) {
    rows.push({
      kind: "resource-request",
      status: discoveryStatus(request.status),
      scopeId: request.scopeId,
      title: request.needed,
      location: request.kind,
      reason: request.reason,
      nextAction: request.unblock ?? request.retryCommand,
      priority: request.priority,
      payload: request,
    });
  }
  for (const scope of input.followupScopes ?? []) {
    rows.push({
      kind: "followup-scope",
      status: "open",
      scopeId: scope.id,
      title: scope.obligation,
      location: scope.region,
      reason: scope.parentScopeId ? `Follow-up proposed from ${scope.parentScopeId}.` : "Follow-up scope proposed by the audit run.",
      nextAction: "Dig this pending scope.",
      priority: scope.score,
      payload: scope,
    });
  }
  return rows;
}

function discoveryStatus(status: string | undefined): "open" | "resolved" | "stale" {
  return status === "resolved" || status === "stale" ? status : "open";
}

// A readable snapshot of the per-project settings a UI can display/edit. Unbounded
// (non-finite) budgets are stored as null so the UI reads null = "no cap".
export function configSnapshot(cfg: AuditorConfig): Record<string, unknown> {
  const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);
  return {
    provider: cfg.provider,
    model: cfg.auditModel,
    thinking: cfg.thinkingLevel,
    maxSteps: finite(cfg.auditMaxSteps),
    mapSteps: finite(cfg.auditMapSteps),
    digSteps: finite(cfg.auditDigSteps),
    maxScopes: finite(cfg.auditMaxScopes),
    digSamples: cfg.auditDigSamples,
    digConcurrency: cfg.auditDigConcurrency,
  };
}
