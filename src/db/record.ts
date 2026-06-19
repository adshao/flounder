// Bridges a live audit/confirm run to the SQLite metadata store. Maps the kernel's
// in-memory types (AuditScope, AgentFinding, confirm rows) to store rows and writes them
// as the run progresses. Every method is FAILURE-ISOLATED: a DB hiccup disables further
// writes and emits a `db_record_error` event, but never throws into the audit — the
// run's evidentiary files remain the source of the content regardless.

import path from "node:path";
import { reportArtifactName } from "../reports/disclosure.js";
import { findingContentKey } from "../util/finding-key.js";
import type { AuditorConfig } from "../config.js";
import type { AgentFinding, AuditScope } from "../agent/tools.js";
import { MetadataStore, type Coverage, type FindingRow, type FindingStatus, type RunKind, type RunStatus, type ScopeRow } from "./store.js";

export interface RunLoggerLike {
  event(kind: string, data?: Record<string, unknown>): Promise<void>;
}

export interface ConfirmDecisionInput {
  bug: string;
  reproduced?: string | undefined;
  recommendation?: string | undefined;
  members?: string[] | undefined;
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
  confirmDecisions(rows: ConfirmDecisionInput[], decisionPath?: string): void;
  finish(status: RunStatus, coverage?: Coverage, findingsTotal?: number): void;
}

export type RunTrackerFactory = (cfg: AuditorConfig, runDir: string, kind: RunKind, logger?: RunLoggerLike) => RunTracker;

export class RunRecorder implements RunTracker {
  private store: MetadataStore | undefined;
  private projectId: number | undefined;
  private runId: number | undefined;
  private readonly logger: RunLoggerLike | undefined;

  private constructor(logger?: RunLoggerLike) {
    this.logger = logger;
  }

  /** Open the store and record the project + a running run. Returns a recorder that is a
   * no-op if the DB could not be opened. */
  static start(cfg: AuditorConfig, runDir: string, kind: RunKind, logger?: RunLoggerLike): RunRecorder {
    const recorder = new RunRecorder(logger);
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
        budgets: configSnapshot(cfg),
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
      this.store!.upsertScopes(this.projectId!, scopes.map(toScopeRow));
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
      this.store!.upsertFindings(this.projectId!, this.runId!, findings.map((finding) => toFindingRow(finding, runDir)), reason);
    } catch (error) {
      this.disable("findings", error);
    }
  }

  confirmDecisions(rows: Array<{ bug: string; reproduced?: string; recommendation?: string; members?: string[] }>, decisionPath?: string): void {
    if (!this.ready() || rows.length === 0) return;
    try {
      this.store!.upsertConfirmDecisions(this.projectId!, this.runId!, rows, decisionPath);
    } catch (error) {
      this.disable("confirm-decisions", error);
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

// The DB status is the kernel's confirmationStatus, except a skeptic-disputed finding is
// surfaced as "refuted" (it is execution-proven but flagged for humans).
function toFindingStatus(finding: AgentFinding): FindingStatus {
  if (finding.disputed) return "refuted";
  return finding.confirmationStatus as FindingStatus;
}

function isConfirmedLike(status: string): boolean {
  return status === "confirmed-source" || status === "confirmed-executable" || status === "confirmed-differential";
}

// A CONTENT-stable dedup key (shared with the confirm phase via util/finding-key): the display id
// (f1..fN) is renumbered at finalize, so keying the DB row on it would orphan rows when findings are
// persisted incrementally (per scope, then re-persisted with updated statuses through differential /
// refutation / appeal). Hashing scope+location+title keeps the SAME row across those updates.
function stableFindingKey(finding: AgentFinding): string {
  const key = findingContentKey(finding.scopeId, finding.location, finding.title);
  return key === "k0" ? finding.id : key;
}

export function toFindingRow(finding: AgentFinding, runDir: string): FindingRow {
  return {
    findingKey: stableFindingKey(finding),
    title: finding.title,
    location: finding.location,
    severity: finding.severity,
    status: toFindingStatus(finding),
    // Only confirmed findings get a disclosure report artifact (written at finalize under the final id).
    reportPath: finding.id && isConfirmedLike(finding.confirmationStatus) ? path.join(runDir, reportArtifactName(finding.id)) : undefined,
    scopeId: finding.scopeId,
  };
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
  };
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
    maxScopes: cfg.auditMaxScopes,
    digSamples: cfg.auditDigSamples,
    digConcurrency: cfg.auditDigConcurrency,
  };
}
