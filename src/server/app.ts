// Control-plane server + REST API for tracking/driving audits across projects. Every
// workflow resource (project, run, scope, finding, confirm decision) is a REST resource,
// and every operation the UI performs is an API call — so an AI agent can drive the whole
// workflow without the UI by fetching GET /api (a self-describing catalog of all endpoints)
// and calling them. The UI is just one client of this API.
//
// Execution is DECOUPLED: this server owns the SQLite DB and a job queue but never runs an
// audit itself. One or more `flounder daemon` processes (possibly on other machines) connect,
// claim queued jobs, run runAudit/runConfirm locally (code + provider keys stay on the
// daemon), and report progress back over HTTP. Server→daemon nudges (poll/cancel) ride an
// SSE stream; daemon→server updates are POSTs. The server stays dependency-light (Node's
// built-in http) and serves the compiled React/Vite dashboard bundle. Bind to localhost
// unless a per-daemon bearer token is configured.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUDIT_MODEL, defaultOutputDir } from "../config.js";
import { MetadataStore, type RunKind, type Coverage, type DiscoveryBacklogFilter, type DiscoveryBacklogKind, type DiscoveryBacklogStatus, type ProviderInput, type ProviderProfile, type ProjectInput, type ProjectListOptions, type ProviderRoles, type RoleOverride } from "../db/store.js";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getProviders, getModels } from "@earendil-works/pi-ai/compat";
import { type LaunchSpec, ActivityBus, type Activity, type ReportFindingSpec, type ConfirmSettledRow } from "./run-manager.js";
import { THINKING_LEVELS } from "../config.js";
import { projectHistoryDir } from "../trace/history.js";
import { positiveIntegerId } from "../util/ids.js";
import { loadScopeInventory, saveScopeInventory } from "../agent/scope-store.js";
import { deriveScopeNote } from "../scope-note.js";
import { confirmSelectorsForFinding } from "../util/confirm-selector.js";
import { phaseInputFingerprint } from "../util/material-fingerprint.js";
import { isResumeSettledDecision, isSubmissionReadyDecision, needsSubmissionReadinessWork } from "../util/submission-readiness.js";
import { isSandboxBackend, type SandboxBackend } from "../security/sandbox.js";
import { normalizeRunGroupManifest, normalizeWorkItemInput } from "../evaluation/contracts.js";
import { buildWorkItemLaunchSpec, evaluationTrackingProjectName, renderRunGroupReport, settleWorkItem } from "../evaluation/run-groups.js";
import {
  buildHarnessCandidateProposal,
  harnessEvidenceItemFromRow,
  mineHarnessWeaknesses,
  minePreservedBehaviors,
  normalizeHarnessExperimentInput,
  normalizeHarnessProposal,
  renderHarnessCandidateBrief,
  scoreHarnessExperiment,
  type HarnessCandidateProposal,
  type HarnessFailurePattern,
  type HarnessGroupSnapshot,
  type HarnessPromotionPolicy,
} from "../evaluation/harness-experiments.js";

const UI_HTML_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));
const UI_PUBLIC_DIR = path.dirname(UI_HTML_PATH);
const PROJECT_STREAM_LIMIT = 100;
const DAEMON_JOB_HEARTBEAT_TTL_MS = 45_000;
const DAEMON_OFFLINE_RECONCILE_GRACE_MS = DAEMON_JOB_HEARTBEAT_TTL_MS * 2;
const PROJECT_STATUS_FILTERS = ["running", "needs-work", "done", "failed", "not-started"] as const;
const PERSISTED_ACTIVITY_TAIL_BYTES = 16 * 1024 * 1024;
const BUG_BOUNTY_CONTEST_KIND = "bug-bounty-contest";
const DEFAULT_CONTEST_BATCH_SCOPES = 10;
const DEFAULT_CONTEST_DIG_CONCURRENCY = 5;
const VERIFY_ARTIFACT_RECONCILIATION_VERSION = 1;
const VERIFY_ARTIFACT_RECONCILIATION_LIMIT = 50;
const MAX_VERIFY_ARTIFACT_REPLAY_ROWS = 1_000;
const MAX_VERIFY_ARTIFACT_REPLAY_BYTES = 8 * 1024 * 1024;
type ProjectStatusFilter = (typeof PROJECT_STATUS_FILTERS)[number];
type ProjectStatusCounts = Record<"all" | ProjectStatusFilter, number>;

function loadUiHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:2rem'>flounder UI asset missing — run <code>npm run build</code>.</body>";
  }
}

export interface UiServerOptions {
  out?: string;
  port?: number;
  host?: string;
  operatorToken?: string;
  /** Enables Flounder-maintainer surfaces that can propose changes to Flounder itself. */
  maintainerMode?: boolean;
}

// The control plane: the live registry of connected daemons (for server→daemon nudges) and
// a per-run activity bus (fed by daemon activity POSTs, read by the UI's SSE log stream).
// It holds NO execution state — the DB job queue is the system of record for dispatch.
class ControlPlane {
  private readonly daemons = new Map<ServerResponse, number>();
  private readonly buses = new Map<number, ActivityBus>();
  private readonly daemonJobHeartbeats = new Map<string, { daemonId: number; activeJobIds: Set<number>; at: number }>();

  addDaemon(res: ServerResponse, daemonId: number): void {
    this.daemons.set(res, daemonId);
  }
  removeDaemon(res: ServerResponse): void {
    this.daemons.delete(res);
  }
  daemonCount(daemonId?: number): number {
    const ids = new Set(this.daemons.values());
    if (daemonId === undefined) return ids.size;
    return ids.has(daemonId) ? 1 : 0;
  }
  hasDaemon(daemonId: number): boolean {
    return this.daemonCount(daemonId) > 0;
  }
  hasDaemonSignal(daemonId: number): boolean {
    return this.hasDaemon(daemonId) || this.hasFreshJobHeartbeat(daemonId);
  }
  updateDaemonJobs(daemonId: number, instanceId: string, activeJobIds: number[]): void {
    this.daemonJobHeartbeats.set(`${daemonId}:${instanceId}`, {
      daemonId,
      activeJobIds: new Set(activeJobIds),
      at: Date.now(),
    });
    this.pruneDaemonJobHeartbeats();
  }
  hasFreshJobHeartbeat(daemonId: number): boolean {
    this.pruneDaemonJobHeartbeats();
    for (const heartbeat of this.daemonJobHeartbeats.values()) if (heartbeat.daemonId === daemonId) return true;
    return false;
  }
  daemonHoldsJob(daemonId: number, jobId: number): boolean {
    this.pruneDaemonJobHeartbeats();
    for (const heartbeat of this.daemonJobHeartbeats.values()) {
      if (heartbeat.daemonId === daemonId && heartbeat.activeJobIds.has(jobId)) return true;
    }
    return false;
  }
  private pruneDaemonJobHeartbeats(): void {
    const cutoff = Date.now() - DAEMON_JOB_HEARTBEAT_TTL_MS;
    for (const [key, heartbeat] of this.daemonJobHeartbeats) if (heartbeat.at < cutoff) this.daemonJobHeartbeats.delete(key);
  }

  /** Nudge every connected daemon to (re)claim queued jobs. */
  nudge(): void {
    this.broadcast({ type: "poll" });
  }
  /** Ask whichever daemon holds this job to abort it (others ignore an unknown jobId). */
  cancel(jobId: number): void {
    this.broadcast({ type: "cancel", jobId });
  }
  /** Adjust how many auto-selected scopes the running job should dig in this batch. */
  setRunScopesTarget(jobId: number, target: number): void {
    this.broadcast({ type: "set-run-scopes-target", jobId, target });
  }
  private broadcast(ev: unknown): void {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.daemons.keys()) {
      try {
        res.write(frame);
      } catch {
        this.daemons.delete(res);
      }
    }
  }

  /** The activity bus for a run (created on first use); daemon activity POSTs push into it,
   * the UI's GET /api/runs/:id/log streams out of it. */
  bus(runId: number): ActivityBus {
    let bus = this.buses.get(runId);
    if (!bus) {
      bus = new ActivityBus();
      this.buses.set(runId, bus);
    }
    return bus;
  }
  lastActivityAt(runId: number): string | undefined {
    return this.buses.get(runId)?.snapshot(1)[0]?.ts;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  store: MetadataStore;
  plane: ControlPlane;
  out: string;
  maintainerMode: boolean;
}

interface Route {
  method: string;
  path: string; // template, e.g. /api/projects/:uuid/runs
  summary: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
  handler: (c: Ctx) => Promise<void> | void;
  hidden?: boolean; // omit from the catalog (the UI page + the catalog itself)
  maintainerOnly?: boolean; // hidden and forbidden unless the server explicitly enables maintainer mode
  regex: RegExp;
  paramNames: string[];
}

function route(def: Omit<Route, "regex" | "paramNames">): Route {
  const paramNames: string[] = [];
  const regex = new RegExp(
    "^" +
      def.path.replace(/:[A-Za-z0-9_]+/g, (m) => {
        paramNames.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  return { ...def, regex, paramNames };
}

// ---- the API surface (data-driven, so GET /api can describe it) -----------------------

const ROUTES: Route[] = [
  route({ method: "GET", path: "/", summary: "The web dashboard (HTML).", hidden: true, handler: (c) => { c.res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); c.res.end(loadUiHtml()); } }),
  route({ method: "GET", path: "/api", summary: "This catalog: every enabled resource and operation, so an agent can self-learn and drive the workflow without the UI.", handler: (c) => sendJson(c.res, 200, apiCatalog(c.maintainerMode)) }),

  route({
    method: "GET", path: "/api/projects",
    summary: "List operator projects with a live snapshot (scope coverage, finding counts, confirmed-bug count, latest run, active runs). Evaluation tracking projects are hidden by default; pass ?origin=evaluation|all only for provenance/debugging.",
    query: {
      archived: "boolean? — when true, return archived projects instead of active projects",
      limit: "number? (default 100)",
      offset: "number? (default 0)",
      q: "string? — case-insensitive project-name search",
      status: "string? — one of running, needs-work, done, failed, not-started",
      origin: "project|evaluation|all? — default project; evaluation rows are internal tracking",
    },
    handler: async (c) => {
      const limit = clampInt(c.url.searchParams.get("limit"), 100, 1, 500);
      const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
      const origin = normalizeProjectOriginFilter(c.url.searchParams.get("origin"));
      if (!origin) return sendJson(c.res, 400, { error: "origin must be project, evaluation, or all" });
      const options: ProjectListOptions = {
        archived: truthyParam(c.url.searchParams.get("archived")),
        origin,
        limit,
        offset,
        search: c.url.searchParams.get("q") ?? undefined,
      };
      reconcileLostExecutorJobs(c.store, c.plane);
      await reconcileAllStaleAuditingScopes(c);
      sendJson(c.res, 200, projectListResponse(c.store, options, normalizeProjectStatusFilter(c.url.searchParams.get("status"))));
    },
  }),
  route({
    method: "PATCH", path: "/api/projects/order",
    summary: "Persist the visible project rail order after a drag-and-drop reorder. Pinned projects still sort above unpinned projects.",
    body: { uuids: "string[] — active project UUIDs in desired display order" },
    handler: projectOrderUpdate,
  }),
  route({
    method: "POST", path: "/api/projects",
    summary: "Create a project (no run starts). A project selects exactly one execution daemon and one default provider profile; config.prepareClue can store the user's target clue/task for later Prepare. Rejects a duplicate name.",
    body: {
      name: "string (required, unique)",
      daemonId: "number (required for normal use) — execution daemon that claims this project's jobs",
      providerId: "number (required for normal use) — default provider profile; phase overrides live in config.phaseProviders",
      dir: "string? — project directory under the selected daemon workspace; defaults to the project UUID",
      sourcePaths: "string[] — code paths relative to dir",
      buildRoot: "string? — buildable root relative to dir",
      corpusPaths: "string[]? — specs/docs relative to dir",
      config: "object? — { prepareClue, projectIntent, phaseProviders, scopeCoverageMode, maxScopes, mapSteps, mapSamples, digSteps, digSamples, digMaxSamples, adaptiveDig, eagerPrepare, digConcurrency, engagement, sandbox... }. Default coverage is Standard. engagement.kind='bug-bounty' records normal bounty submission context and keeps real-target confirmation by default; engagement.kind='bug-bounty-contest' enables short settled rounds, source-only reportability by default, and optional append-map expansion.",
    },
    handler: projectCreate,
  }),
  route({
    method: "GET", path: "/api/projects/:uuid",
    summary: "Project detail: config, prepare-material summary (prepareSummary.quality = ready|limited|preparing|needs-review|missing|invalid), scope coverage, finding/run/confirmed counts, recent runs, confirm decisions.",
    params: { uuid: "project UUID" },
    handler: projectGet,
  }),
  route({
    method: "PATCH", path: "/api/projects/:uuid",
    summary: "Update a project's daemon, provider, project-relative materials, config, or display state (archive, pin, manual order). No run starts.",
    params: { uuid: "project UUID" },
    body: { daemonId: "number?", providerId: "number?", dir: "string?", sourcePaths: "string[]?", buildRoot: "string?", corpusPaths: "string[]?", config: "object?", archived: "boolean?", pinned: "boolean?", sortOrder: "number|null?" },
    handler: projectUpdate,
  }),
  route({
    method: "DELETE", path: "/api/projects/:uuid",
    summary: "Delete a project and everything under it (runs, scopes, findings, confirm decisions). On-disk run artifacts are left untouched.",
    params: { uuid: "project UUID" },
    handler: projectDelete,
  }),

  route({
    method: "GET", path: "/api/projects/:uuid/runs",
    summary: "List a project's runs (newest first), including job error summaries when available.",
    params: { uuid: "project UUID" }, query: { limit: "number? — cap rows" },
    handler: (c) => withProject(c, (id) => sendJson(c.res, 200, { runs: runApiRows(c.store, c.store.listRuns(id, clampInt(c.url.searchParams.get("limit"), 200, 1, 1000)), c.plane) })),
  }),
  route({
    method: "POST", path: "/api/projects/:uuid/runs",
    summary: "Queue project work (Run/Continue pipeline, map, audit a region/scope, verify, confirm, report, or prepare). The job is dispatched to a connected daemon, which executes it and reports back. Uses the project's stored materials + config unless overridden. This is the single action behind the UI's primary and More actions controls.",
    params: { uuid: "project UUID" },
    body: {
      verb: "'run' | 'map' | 'audit' | 'confirm' | 'report' | 'prepare' (default 'run'; project run = prepare-if-needed→map/dig→synthesize→verify→confirm→report; source run = map→dig→synthesize→verify)",
      remap: "boolean? — re-enumerate scopes (restart)", appendMap: "boolean? — expand the existing scope inventory by appending novel scopes", appendMapSeedPaths: "string[]? — extra prior scope inventories used only as append-map covered-reference seed", fresh: "boolean? — confirm: ignore a prior interrupted confirm",
      quick: "boolean? — run: single breadth pass", mockLlm: "boolean? — offline mock model",
      verifyFromStart: "boolean? — run/continue pipeline: re-run Verify from the beginning instead of only pending candidates",
      region: "string? — audit: pinned region e.g. src/Foo.sol:120-180", scope: "string? — audit: scope id(s)", verifyFindings: "object|array? — audit: inline suspected finding(s) to confirm-or-refute by execution; project finding rows with id are linked back to that original row",
      allowMaterialDrift: "boolean? — expert override for verifyFindings when a newer Prepare run changed project materials after the selected findings were produced",
      regenerateReports: "boolean? — report: include findings that already have formal reports; selected findingIds are always regenerated",
      continueCoverage: "boolean? — explicit opt-in to open the next mapped scope batch after the current pipeline round is fully settled",
      scopeCoverageMode: "focused|standard|half|full|custom? — one-off coverage mode for this run; standard means audit until the project has 30 audited scopes; pass continueCoverage:true to explicitly start another scope batch after verify/confirm/report are settled. Bug-bounty contest projects default to short custom batches unless overridden.",
      maxScopes: "number? — one-off scope cap for this run, or the custom target when scopeCoverageMode=custom", mapSteps: "number? — one-off map turn cap", mapSamples: "number? — independent Map inventories to union without dropping singleton scopes", digSteps: "number? — one-off per-scope dig turn cap",
      maxSteps: "number? — one-off global turn cap", digSamples: "number? — minimum independent samples per scope", digMaxSamples: "number? — adaptive per-scope sample ceiling", adaptiveDig: "boolean? — add bounded samples only for incomplete/uncertain outcomes", eagerPrepare: "boolean? — warm the build before Dig and surface repairable resource blockers", digConcurrency: "number? — one-off parallel scopes", verifyConcurrency: "number? — one-off parallel Verify findings (isolated workspaces)",
      findingId: "number? — confirm/report: reproduce or report one selected finding",
      findingIds: "number[]? — confirm/report: reproduce selected pending audit-confirmed findings, or generate/regenerate formal reports for selected reproduced findings. Report without selection only generates missing reports.",
      inputRunDir: "string? — confirm: the finished run dir to reproduce",
      clue: "string? — prepare: the tx / address / project / link to acquire from",
      posture: "string? — prepare: 'blind' | 'informed'", matchDeployed: "boolean? — prepare: prove staged source matches the live deployment (default true)", endpoint: "string? — prepare: read-only access hint (e.g. RPC URL)",
      overrides: "object? — { sourcePaths, buildRoot, corpusPaths, config } one-off overrides of the stored project",
    },
    handler: runLaunch,
  }),
  route({
    method: "GET", path: "/api/projects/:uuid/scopes",
    summary: "List the project's scope inventory (audited / pending / deferred) — the map output. Paginated with ?limit/&offset for large inventories.",
    params: { uuid: "project UUID" },
    query: { limit: "number? (default 50)", offset: "number? (default 0)" },
    handler: projectScopesGet,
  }),
  route({
    method: "GET", path: "/api/projects/:uuid/backlog",
    summary: "List discovery backlog rows for a project: coverage gaps, resource requests, and follow-up scopes from audit runs. Rows include agent-owned actionability metadata so agents can continue coverage, resolve setup/resource blockers, or route ambiguous work before asking the operator for explicit credentials, authorization, or unavailable external resources. Filter with ?kind=coverage-gap|resource-request|followup-scope and ?status=open|resolved|stale|ignored|all.",
    params: { uuid: "project UUID" },
    query: { kind: "coverage-gap|resource-request|followup-scope?", status: "open|resolved|stale|ignored|all? (default open)", limit: "number? (default 100)", offset: "number? (default 0)" },
    handler: projectBacklogGet,
  }),
  route({
    method: "PATCH", path: "/api/projects/:uuid/scopes/:scopeId",
    summary: "Edit a mapped scope queue item. Use {prioritize:true} to move it to the top of the next auto-dig batch, or set status=`deferred` to skip it / `pending` to resume it. Updates the persisted inventory the audit reads, so the next run honors it.",
    params: { uuid: "project UUID", scopeId: "scope id from the inventory" },
    body: { prioritize: "boolean? — move this pending scope to the top of the dig queue", status: "'deferred' (skip) | 'pending' (resume) | 'audited'" },
    handler: scopeSetStatus,
  }),
  route({
    method: "PATCH", path: "/api/backlog/:id",
    summary: "Update one discovery backlog row's operator state. Use resolved when the missing resource/coverage is handled; ignored hides a non-actionable item without deleting provenance.",
    params: { id: "backlog row id" },
    body: { status: "open|resolved|stale|ignored" },
    handler: backlogUpdate,
  }),
  route({
    method: "GET", path: "/api/projects/:uuid/findings",
    summary: "List current-material findings, paginated + filterable, each with its status timeline (suspect→confirm→refute). Pass ?includeStale=true to inspect findings from older prepared material snapshots.",
    params: { uuid: "project UUID" },
    query: { status: "string? — exact status or execution-confirmed alias", tracking: "string? — tracking state or active to hide ignored findings", q: "string? — text search (title/location) or #finding-id", includeStale: "boolean? — include findings from older prepared material snapshots", limit: "number? (default 50)", offset: "number? (default 0)" },
    handler: findingsList,
  }),
  route({
    method: "GET", path: "/api/findings/:id/report",
    summary: "Read one finding's submission report markdown from DB-backed finding data. Local run artifacts are provenance only, not the UI source of truth.",
    params: { id: "finding id" },
    handler: findingReport,
  }),
  route({
    method: "GET", path: "/api/findings/:id/lifecycle",
    summary: "Read one canonical finding's occurrences, status timeline, and per-phase Verify/Confirm/Report attempts.",
    params: { id: "finding id" },
    handler: findingLifecycle,
  }),
  route({
    method: "POST", path: "/api/findings/:id/retry",
    summary: "Explicitly reopen one blocked finding lifecycle phase. The next Continue retries only that phase against the same inputs; changed inputs are eligible automatically.",
    params: { id: "finding id" },
    body: { phase: "verify|confirm|report" },
    handler: findingPhaseRetry,
  }),
  route({
    method: "GET", path: "/api/confirm-decisions/:id/report",
    summary: "Read one decision's final submission report markdown. This is the real-target bug-level report; linked finding reports remain evidence summaries.",
    params: { id: "confirm decision id" },
    handler: confirmDecisionReport,
  }),
  route({
    method: "GET", path: "/api/projects/:uuid/confirm-decisions",
    summary: "List current-material confirm decisions (one per distinct bug). Filter ?reproduced=yes for bugs reproduced on the real target; pass ?includeStale=true to inspect decisions from older prepared material snapshots.",
    params: { uuid: "project UUID" },
    query: { reproduced: "string? — e.g. 'yes' for confirmed bugs", includeStale: "boolean? — include decisions from older prepared material snapshots" },
    handler: confirmDecisionsList,
  }),

  route({
    method: "GET", path: "/api/run-groups",
    summary: "List durable run groups for benchmark evaluation, repeated samples, regression replay, and multi-target campaigns. Lifecycle state is separate from each item's security/scoring outcome.",
    query: { limit: "number? (default 100)", offset: "number? (default 0)" },
    handler: runGroupList,
  }),
  route({
    method: "POST", path: "/api/run-groups",
    summary: "Create a durable run group, optionally with its initial work items. Target bundles and evidence contracts are schema-validated; manifest commands are metadata only and never bypass Flounder's sandbox or confirmation policy.",
    body: {
      name: "string (required, unique)",
      kind: "string? — evaluation|campaign|batch|custom display category",
      parallelism: "positive integer? (default 1)",
      config: "object? — shared provider/model/thinking defaults",
      budget: "object? — persisted accounting limits/notes; never a security outcome",
      items: "work-item[]? — audit-target, verify-claim, benchmark-case, or regression-replay items",
    },
    handler: runGroupCreate,
  }),
  route({
    method: "GET", path: "/api/run-groups/:uuid",
    summary: "Read one run group with every independently resumable work item, attempts, linked job/run, outcome, and stored evidence result.",
    params: { uuid: "run-group UUID" },
    handler: runGroupGet,
  }),
  route({
    method: "POST", path: "/api/run-groups/:uuid/items",
    summary: "Append validated work items to a draft or paused run group without replacing prior attempts or evidence.",
    params: { uuid: "run-group UUID" },
    body: { items: "work-item[] (required) — each has itemKey, kind, targetBundle, materialPolicy, and evidenceContract" },
    handler: runGroupItemsAdd,
  }),
  route({
    method: "POST", path: "/api/run-groups/:uuid/start",
    summary: "Start or resume a run group and queue only enough existing Flounder jobs to satisfy its parallelism. The scheduler survives server restarts because group/item/job state is stored in SQLite.",
    params: { uuid: "run-group UUID" },
    body: { parallelism: "positive integer? — override the group's durable concurrency" },
    handler: runGroupStart,
  }),
  route({
    method: "POST", path: "/api/run-groups/:uuid/pause",
    summary: "Pause future work-item dispatch. Already queued/claimed/running jobs finish and keep their evidence; start resumes remaining items.",
    params: { uuid: "run-group UUID" },
    handler: runGroupPause,
  }),
  route({
    method: "POST", path: "/api/run-groups/:uuid/cancel",
    summary: "Cancel a run group and all queued/claimed/running work-item jobs while preserving completed evidence and attempt history.",
    params: { uuid: "run-group UUID" },
    handler: runGroupCancel,
  }),
  route({
    method: "GET", path: "/api/run-groups/:uuid/report",
    summary: "Regenerate a run-group score/outcome report entirely from persisted work-item results without rerunning model work.",
    params: { uuid: "run-group UUID" },
    handler: runGroupReport,
  }),
  route({
    method: "GET", path: "/api/work-items/:id",
    summary: "Read one durable work item, including lifecycle state, security/scoring outcome, immutable attempt history, linked job/run, and evidence result.",
    params: { id: "work-item id" },
    handler: workItemGet,
  }),
  route({
    method: "POST", path: "/api/work-items/:id/retry",
    summary: "Retry only a blocked/failed work item while preserving its prior attempt evidence. Benchmark misses are independent results and cannot be rewritten as retries.",
    params: { id: "work-item id" },
    handler: workItemRetry,
  }),

  route({
    method: "GET", path: "/api/harness-experiments",
    summary: "List governed harness-improvement experiments. Each experiment links a finished baseline Evaluation to a bounded candidate and keeps the promotion decision outside the editable harness surface.",
    query: { limit: "number? (default 100)", offset: "number? (default 0)" },
    handler: harnessExperimentList,
    maintainerOnly: true,
  }),
  route({
    method: "POST", path: "/api/harness-experiments",
    summary: "Mine verifier-grounded baseline weaknesses and create a bounded harness-candidate proposal. Editable files are allowlisted; evaluator, material policy, sandbox, confirmation, tests, and promotion policy cannot be proposed as edits.",
    body: {
      name: "string (required, unique)",
      baselineRunGroupUuid: "finished run-group UUID (required)",
      candidateRunGroupUuid: "run-group UUID? — optional paired candidate Evaluation",
      editableFiles: "repository-relative string[] (required) — bounded prompts/skills or approved agent harness files",
      promotionPolicy: "object? — minimum samples/improvements plus blocked, duration, and attempt budgets",
    },
    handler: harnessExperimentCreate,
    maintainerOnly: true,
  }),
  route({
    method: "GET", path: "/api/harness-experiments/:uuid",
    summary: "Read one harness experiment with failure patterns, preserved passing behavior, bounded proposal, paired Evaluation groups, and deterministic scorecard.",
    params: { uuid: "harness experiment UUID" },
    handler: harnessExperimentGet,
    maintainerOnly: true,
  }),
  route({
    method: "PATCH", path: "/api/harness-experiments/:uuid/proposal",
    summary: "Refine the candidate proposal inside its original editable-file and verifier-pattern bounds. This cannot widen the trusted boundary or alter evaluation evidence.",
    params: { uuid: "harness experiment UUID" },
    body: { proposal: "bounded harness candidate proposal" },
    handler: harnessExperimentProposalUpdate,
    maintainerOnly: true,
  }),
  route({
    method: "POST", path: "/api/harness-experiments/:uuid/candidate",
    summary: "Attach or replace the candidate Evaluation group. Baseline and candidate remain separate immutable run groups and must use stable paired work-item keys.",
    params: { uuid: "harness experiment UUID" },
    body: { candidateRunGroupUuid: "run-group UUID (required)" },
    handler: harnessExperimentCandidateAttach,
    maintainerOnly: true,
  }),
  route({
    method: "POST", path: "/api/harness-experiments/:uuid/evaluate",
    summary: "Run the deterministic promotion gate over persisted baseline/candidate evidence. It returns promote, reject, or needs-more-samples and never changes code, merges, or deploys.",
    params: { uuid: "harness experiment UUID" },
    handler: harnessExperimentEvaluate,
    maintainerOnly: true,
  }),
  route({
    method: "GET", path: "/api/harness-experiments/:uuid/brief",
    summary: "Export a public-safe candidate brief containing only verifier-grounded failures, bounded editable files, behaviors to preserve, and the external promotion gate.",
    params: { uuid: "harness experiment UUID" },
    handler: harnessExperimentBrief,
    maintainerOnly: true,
  }),

  route({
    method: "GET", path: "/api/providers",
    summary: "List saved provider profiles — a reusable model strategy (provider + model + thinking, with optional per-phase map/dig/refute overrides) that a project selects.",
    handler: (c) => sendJson(c.res, 200, { providers: c.store.listProviders() }),
  }),
  route({
    method: "POST", path: "/api/providers",
    summary: "Create a provider profile.",
    body: { name: "string (unique)", provider: "pi-ai provider id, or claude-code / codex-cli / mock", model: "string? — default model", thinking: "off|minimal|low|medium|high|xhigh?", roles: "object? — per-phase overrides { map|dig|refute: { provider?, model?, thinking? } }" },
    handler: providerCreate,
  }),
  route({
    method: "GET", path: "/api/pi/providers",
    summary: "Providers pi-ai can drive (for the profile editor), plus the CLI fallbacks. Discovery, not the saved resource.",
    handler: (c) => sendJson(c.res, 200, { providers: availableProviders() }),
  }),
  route({
    method: "GET", path: "/api/pi/models/:provider",
    summary: "Models pi-ai exposes for a provider (id, name, reasoning, thinkingLevels) — for the model dropdown.",
    params: { provider: "provider id" },
    handler: (c) => sendJson(c.res, 200, { models: availableModels(c.params.provider ?? "") }),
  }),
  route({
    method: "GET", path: "/api/providers/:id",
    summary: "A single provider profile.",
    params: { id: "provider id" },
    handler: (c) => { const p = c.store.getProvider(Number(c.params.id)); p ? sendJson(c.res, 200, { provider: p }) : sendJson(c.res, 404, { error: "no such provider" }); },
  }),
  route({
    method: "PATCH", path: "/api/providers/:id",
    summary: "Update a provider profile.",
    params: { id: "provider id" },
    body: { name: "string?", provider: "string?", model: "string?", thinking: "string?", roles: "object?" },
    handler: providerUpdate,
  }),
  route({
    method: "DELETE", path: "/api/providers/:id",
    summary: "Delete a provider profile.",
    params: { id: "provider id" },
    handler: (c) => { const ok = c.store.deleteProvider(Number(c.params.id)); ok ? sendJson(c.res, 200, { ok: true, deleted: Number(c.params.id) }) : sendJson(c.res, 404, { error: "no such provider" }); },
  }),

  route({
    method: "GET", path: "/api/daemons",
    summary: "Registered execution-plane daemons with provider-auth summaries — no tokens. Pass ?include=capabilities for the raw daemon capability report.",
    query: { include: "'capabilities'? — include raw capability details such as expected auth env vars" },
    handler: (c) => sendJson(c.res, 200, { daemons: daemonRows(c) }),
  }),
  route({
    method: "POST", path: "/api/daemons",
    summary: "Register a daemon and mint its bearer token (shown ONCE). Configure it on the daemon: flounder daemon start --server <url> --token <token>.",
    body: { name: "string (required) — a label for this executor" },
    handler: daemonCreate,
  }),
  route({
    method: "PATCH", path: "/api/daemons/:id",
    summary: "Rename a daemon (the token is unchanged).",
    params: { id: "daemon id" },
    body: { name: "string (required)" },
    handler: daemonRename,
  }),
  route({
    method: "DELETE", path: "/api/daemons/:id",
    summary: "Revoke a daemon registration (its token stops working; past jobs keep their history).",
    params: { id: "daemon id" },
    handler: (c) => { const ok = c.store.deleteDaemon(Number(c.params.id)); ok ? sendJson(c.res, 200, { ok: true, deleted: Number(c.params.id) }) : sendJson(c.res, 404, { error: "no such daemon" }); },
  }),

  route({
    method: "GET", path: "/api/bugs",
    summary: "Findings across operator projects plus aggregate stats, including execution-confirmed evidence. Evaluation findings are excluded by default; pass ?source=evaluation|all to inspect benchmark evidence with explicit provenance.",
    query: { project: "string? — project uuid to scope findings and stats", source: "project|evaluation|all? — default project", status: "string? — exact status or execution-confirmed alias", tracking: "string? — tracking state, or active to hide ignored findings", limit: "number? (default 200)", offset: "number? (default 0)" },
    handler: (c) => {
      const projectUuid = c.url.searchParams.get("project") || c.url.searchParams.get("projectUuid") || undefined;
      const status = c.url.searchParams.get("status") || undefined;
      const tracking = c.url.searchParams.get("tracking") || undefined;
      const source = normalizeFindingSourceFilter(c.url.searchParams.get("source"));
      if (!source) return sendJson(c.res, 400, { error: "source must be project, evaluation, or all" });
      const limit = clampInt(c.url.searchParams.get("limit"), 200, 1, 500);
      const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
      const filter = { projectUuid, source, status, tracking };
      const findings = c.store.listGlobalFindings({ ...filter, limit, offset });
      const total = c.store.countGlobalFindings(filter);
      const rawStats = c.store.globalFindingStats({ projectUuid, source });
      const stats = { ...rawStats, active: rawStats.total - (rawStats.byTracking.ignored ?? 0) };
      sendJson(c.res, 200, { findings: withLatestFindingAttempts(c.store, findings).map(findingSummaryRow), total, limit, offset, stats });
    },
  }),
  route({
    method: "PATCH", path: "/api/findings/:id/tracking",
    summary: "Set a finding's submission-tracking state (open|triaging|submitted|accepted|fixed|duplicate|rejected|ignored) — for following a bug from discovery to vendor disclosure. Duplicate status always requires a direct link to a canonical finding in the same project.",
    params: { id: "finding id" },
    body: { status: "open|triaging|submitted|accepted|fixed|duplicate|rejected|ignored", duplicateOfFindingId: "number — required canonical finding id when status is duplicate" },
    handler: findingTracking,
  }),

  route({
    method: "POST", path: "/api/launch",
    summary: "Queue an ad-hoc run from a full launch spec (absolute materials, no project staging) — the entry point the CLI drives. Upserts a project row keyed by `target` so the run is grouped + visible, enqueues the job, and nudges daemons. Use POST /api/projects/:uuid/runs instead to launch a UI-configured project.",
    body: {
      verb: "'run' | 'map' | 'audit' | 'confirm' | 'prepare' (required)", target: "string (required) — run/project name",
      sourcePaths: "string[] — ABSOLUTE code paths the daemon reads", corpusPaths: "string[]? — ABSOLUTE design/reference paths", buildRoot: "string? — ABSOLUTE buildable root",
      provider: "string?", model: "string?", thinking: "string?",
      scopeCoverageMode: "focused|standard|half|full|custom? — standard/focused are cumulative project targets, not per-run additions", maxScopes: "number?", mapSteps: "number?", digSteps: "number?", maxSteps: "number?", digSamples: "number?", digConcurrency: "number?",
      sandboxBackend: "'auto'|'oci'|'apple-container'|'host'?", sandboxImage: "string?", sandboxAllowHostFallback: "boolean?", sandboxPrepareNetwork: "'none'|'enabled'?", sandboxConfirmNetwork: "'none'|'enabled'?",
      remap: "boolean?", appendMap: "boolean? — expand existing scope inventory by appending novel scopes", appendMapSeedPaths: "string[]? — extra prior scope inventories used only as append-map covered-reference seed", quick: "boolean?", mockLlm: "boolean?", pipeline: "boolean? — run clue pipeline: prepare if needed -> map/dig -> synthesize -> verify -> confirm -> report", continueCoverage: "boolean? — explicit opt-in to open the next mapped scope batch after the current pipeline round is fully settled", verifyFromStart: "boolean? — pipeline: re-run Verify from the beginning instead of only pending candidates", region: "string?", scope: "string?", scopeNote: "string? — map/audit: 'authorized scope note' that focuses map on the in-scope target (the pipeline auto-derives it from prepare's manifest)", verifyFindings: "object|array? — audit: inline suspected finding(s) to confirm-or-refute by execution",
      inputRunDir: "string? — confirm", fresh: "boolean? — confirm",
      clue: "string? — prepare", posture: "string? — prepare", matchDeployed: "boolean? — prepare", endpoint: "string? — prepare",
    },
    handler: launch,
  }),
  route({
    method: "GET", path: "/api/jobs/:id",
    summary: "A queued/dispatched/running job (status, run_id for the current active phase once a daemon starts it, error). Poll after POST /api/launch to follow a CLI-launched run.",
    params: { id: "job id" },
    handler: (c) => { const job = c.store.getJob(Number(c.params.id)); job ? sendJson(c.res, 200, { job }) : sendJson(c.res, 404, { error: "no such job" }); },
  }),
  route({
    method: "POST", path: "/api/jobs/:id/cancel",
    summary: "Cancel a queued/dispatched/running job before or after a daemon starts it. Use this for queued jobs that do not yet have a run id.",
    params: { id: "job id" },
    handler: (c) => {
      const id = Number(c.params.id);
      const job = c.store.getJob(id);
      if (!job) return sendJson(c.res, 404, { error: "no such job" });
      const ok = c.store.cancelJob(id);
      c.plane.cancel(id);
      sendJson(c.res, 200, { ok, canceled: id });
    },
  }),
  route({
    method: "GET", path: "/api/runs/:id",
    summary: "A single run (status, kind, coverage, finding count, run dir, timestamps, and job error summary when available).",
    params: { id: "run id" },
    handler: (c) => {
      const run = c.store.getRun(Number(c.params.id));
      run ? sendJson(c.res, 200, { run: runApiRow(c.store, run, c.plane) }) : sendJson(c.res, 404, { error: "no such run" });
    },
  }),
  route({
    method: "PATCH", path: "/api/runs/:id",
    summary: "Adjust a running run. `runScopesTarget` changes only this run's auto-selected dig batch target; `scopeCoverageMode`/`coverageTarget` use project-cumulative targets such as Standard until 30 audited scopes. The daemon applies it at the next scope boundary.",
    params: { id: "run id" },
    body: {
      runScopesTarget: "number? — new current-run scope target, minimum 1",
      scopeCoverageMode: "focused|standard|half|full|custom? — focused/standard are project-cumulative targets; full means every pending scope; custom uses maxScopes/runScopesTarget",
      coverageTarget: "number? — project-cumulative audited-scope target, e.g. 30 means run until 30 project scopes are audited",
      maxScopes: "number? — direct current-run target, or custom target when scopeCoverageMode=custom",
    },
    handler: runUpdate,
  }),
  route({
    method: "POST", path: "/api/runs/:id/stop",
    summary: "Stop a running run: flags its job for cancel and nudges the executing daemon to abort. The run is reconciled to 'killed'.",
    params: { id: "run id" },
    handler: runStop,
  }),
  route({
    method: "DELETE", path: "/api/runs/:id",
    summary: "Delete a run and its run-scoped data (findings + status events, confirm decisions). Scopes (the project inventory) and on-disk artifacts are left intact.",
    params: { id: "run id" },
    handler: (c) => { const ok = c.store.deleteRun(Number(c.params.id)); ok ? sendJson(c.res, 200, { ok: true, deleted: Number(c.params.id) }) : sendJson(c.res, 404, { error: "no such run" }); },
  }),
  route({
    method: "GET", path: "/api/runs/:id/artifact",
    summary: "Read a run's report artifact (text) from its run dir — the detailed report behind a run/decision. Allowlisted names only.",
    params: { id: "run id" }, query: { name: "artifact filename (audit_report.md | confirm_report.md | report_<finding>.md | prepare_manifest.json | confirm_decision.json | impact_inventory.json | confirm_provenance.json)" },
    handler: runArtifact,
  }),
  route({
    method: "GET", path: "/api/runs/:id/log",
    summary: "Run live activity. Default is an SSE stream for the dashboard; pass ?tail=N or ?format=json for a bounded JSON snapshot of recent events.",
    params: { id: "run id" },
    query: { tail: "number? — return JSON with the latest N events instead of opening SSE", format: "'json'? — return a bounded JSON snapshot; defaults to tail=200 when tail is omitted" },
    handler: runLog,
  }),

  route({ method: "GET", path: "/api/active", summary: "In-flight jobs (queued/dispatched/running) across all daemons.", handler: (c) => {
    reconcileLostExecutorJobs(c.store, c.plane);
    sendJson(c.res, 200, { active: activeRuns(c.store, c.plane), daemons: daemonStatusRows(c) });
  } }),
  route({ method: "GET", path: "/api/stream", summary: "Server-sent events: the project snapshot + active list, pushed ~1/s for live updates.", handler: (c) => streamSnapshots(c.res, c.store, c.plane) }),

  // ---- execution plane: daemon ↔ server (hidden from the agent catalog) ----------------
  route({ method: "POST", path: "/api/daemon/register", summary: "(daemon) Register/heartbeat. Bearer token required.", hidden: true, handler: daemonRegister }),
  route({ method: "POST", path: "/api/daemon/heartbeat", summary: "(daemon) Heartbeat with the job ids this daemon instance currently holds.", hidden: true, handler: daemonHeartbeat }),
  route({ method: "GET", path: "/api/daemon/stream", summary: "(daemon) SSE: poll/cancel nudges from the server.", hidden: true, handler: daemonStream }),
  route({ method: "POST", path: "/api/daemon/claim", summary: "(daemon) Atomically claim the oldest queued job.", hidden: true, handler: daemonClaim }),
  route({ method: "POST", path: "/api/daemon/runs", summary: "(daemon) Start a run row for a claimed job; links job→run.", hidden: true, handler: daemonRunStart }),
  route({ method: "POST", path: "/api/daemon/reconciliation/worklist", summary: "(daemon) List terminal verify artifacts owned by this daemon that need semantic replay.", hidden: true, handler: daemonReconciliationWorklist }),
  route({ method: "POST", path: "/api/daemon/reconciliation/runs/:id", summary: "(daemon) Replay bounded terminal verify verdict artifacts through canonical lifecycle reconciliation.", hidden: true, handler: daemonReconcileRunArtifacts }),
  route({ method: "PATCH", path: "/api/daemon/runs/:id", summary: "(daemon) Report run progress: scopes / findings / confirm-decisions / finish.", hidden: true, handler: daemonRunUpdate }),
  route({ method: "POST", path: "/api/daemon/runs/:id/activity", summary: "(daemon) Push a batch of token-level activity events for the live log.", hidden: true, handler: daemonRunActivity }),
  route({ method: "POST", path: "/api/daemon/pipeline-worklist", summary: "(daemon) Resolve verify/confirm/report work for an in-process pipeline job.", hidden: true, handler: daemonPipelineWorklist }),
  route({ method: "POST", path: "/api/daemon/jobs/:id/status", summary: "(daemon) Report a job's terminal status (done/error/canceled).", hidden: true, handler: daemonJobStatus }),
];

export function apiCatalog(maintainerMode = false): {
  name: string;
  description: string;
  maintainerMode: boolean;
  resources: string[];
  endpoints: Array<Record<string, unknown>>;
} {
  return {
    name: "flounder",
    description: maintainerMode
      ? "REST API for white-hat audits, durable evaluations, and explicitly enabled Flounder-maintainer experiments."
      : "REST API for tracking and driving white-hat audits and durable evaluation groups. Maintainer-only source-improvement surfaces are disabled.",
    maintainerMode,
    resources: ["project", "provider", "daemon", "run", "run-group", "work-item", ...(maintainerMode ? ["harness-experiment"] : []), "scope", "discovery-backlog", "finding", "confirm-decision"],
    endpoints: ROUTES.filter((r) => !r.hidden && (!r.maintainerOnly || maintainerMode)).map((r) => ({
      method: r.method,
      path: r.path,
      summary: r.summary,
      ...(r.params ? { params: r.params } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.body ? { body: r.body } : {}),
    })),
  };
}

export function startUiServer(options: UiServerOptions = {}): ReturnType<typeof createServer> {
  const out = options.out ?? defaultOutputDir();
  const port = options.port ?? 4500;
  const host = options.host ?? "127.0.0.1"; // localhost by default; exposing the control plane requires operator auth
  const loopback = isLoopbackHost(host);
  const operatorToken = options.operatorToken ?? (loopback ? undefined : process.env.FLOUNDER_UI_TOKEN);
  const maintainerMode = options.maintainerMode === true;
  if (!isLoopbackHost(host) && !operatorToken) {
    throw new Error("Refusing to bind flounder ui to a non-loopback host without operator auth. Set FLOUNDER_UI_TOKEN and send Authorization: Bearer <token> for control-plane API access.");
  }
  const store = MetadataStore.openForOutput(out);
  // Seed a couple of starter profiles so a fresh install has something to select (no-op if any exist).
  store.seedProviders([
    { name: `openai-codex · ${DEFAULT_AUDIT_MODEL} · xhigh`, provider: "openai-codex", model: DEFAULT_AUDIT_MODEL, thinking: "xhigh" },
    { name: "claude-code · opus 4.8 max", provider: "claude-code", model: "claude-opus-4-8", thinking: "xhigh" },
  ]);
  const artifactReconciled = reconcileSuccessfulArtifactRuns(store);
  if (artifactReconciled > 0) console.log(`[flounder ui] reconciled ${artifactReconciled} completed run artifact${artifactReconciled === 1 ? "" : "s"}`);
  const plane = new ControlPlane();
  reconcileTerminalRunGroupItems(store, plane);
  for (const group of store.listRunGroups(10_000, 0)) {
    if (group.state === "running") scheduleRunGroupWith(store, plane, Number(group.id));
  }
  // NOTE: we do NOT reconcile `running` rows on startup — runs execute on daemons, which
  // survive a server restart. Blind-killing them here would be wrong. (A future daemon
  // heartbeat can reconcile rows whose daemon has gone stale.)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const match = r.regex.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1] ?? "")));
      if (operatorToken && !isDaemonRoute(r.path) && !operatorAuth(req, operatorToken)) {
        sendJson(res, 401, { error: "unauthorized: a valid operator bearer token is required" });
        return;
      }
      if (r.maintainerOnly && !maintainerMode) {
        sendJson(res, 403, { error: "maintainer mode required: restart the control plane with `flounder ui --maintainer`" });
        return;
      }
      // .then(run) (not Promise.resolve(run())) so a SYNCHRONOUS throw in a handler becomes a
      // rejection we can turn into a 500 — never an uncaught exception that kills the server.
      Promise.resolve()
        .then(() => r.handler({ req, res, params, url, store, plane, out, maintainerMode }))
        .catch((error) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) });
          else res.end();
      });
      return;
    }
    if (method === "GET" && isUiAssetPath(url.pathname)) {
      if (operatorToken && !operatorAuth(req, operatorToken)) {
        sendJson(res, 401, { error: "unauthorized: a valid operator bearer token is required" });
        return;
      }
      serveUiAsset(url.pathname, res);
      return;
    }
    if (method === "GET" && !url.pathname.startsWith("/api")) {
      if (operatorToken && !operatorAuth(req, operatorToken)) {
        sendJson(res, 401, { error: "unauthorized: a valid operator bearer token is required" });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(loadUiHtml());
      return;
    }
    sendJson(res, 404, { error: "not found", hint: "GET /api lists every endpoint" });
  });
  let storeClosed = false;
  server.on("close", () => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  });
  server.listen(port, host, () => {
    console.log(`[flounder ui] http://${host}:${port}  (API catalog: http://${host}:${port}/api · store: ${out}/flounder.db${maintainerMode ? " · maintainer mode" : ""})`);
  });
  return server;
}

function reconcileSuccessfulArtifactRuns(store: MetadataStore): number {
  let changed = 0;
  for (const run of store.listRuns()) {
    if (String(run.status) !== "error") continue;
    const runId = Number(run.id);
    if (!Number.isFinite(runId) || !hasSuccessfulTerminalEvent(run)) continue;
    changed += store.reconcileTerminalRun(runId, "done");
  }
  return changed;
}

function hasSuccessfulTerminalEvent(run: Record<string, unknown>): boolean {
  const runDir = stringValue(run.run_dir);
  if (!runDir) return false;
  const eventsPath = path.join(path.resolve(runDir), "events.jsonl");
  if (!existsSync(eventsPath)) return false;
  try {
    const lines = readTailLines(eventsPath, 500);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const kind = stringValue(event.kind);
      if (kind === "audit_done" || kind === "audit_confirm_done") {
        const stoppedReason = stringValue(event.stoppedReason);
        return !stoppedReason || stoppedReason === "finished";
      }
      if (kind === "audit_prepare_done") return true;
    }
  } catch {
    return false;
  }
  return false;
}

function readTailLines(file: string, limit: number, maxBytes = PERSISTED_ACTIVITY_TAIL_BYTES): string[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  const safeMaxBytes = Math.max(0, Math.floor(maxBytes));
  if (safeLimit <= 0 || safeMaxBytes <= 0) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    let position = size;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= safeLimit && bytesReadTotal < safeMaxBytes) {
      const readLength = Math.min(chunkSize, position, safeMaxBytes - bytesReadTotal);
      if (readLength <= 0) break;
      position -= readLength;
      const buffer = Buffer.allocUnsafe(readLength);
      const bytesRead = readSync(fd, buffer, 0, readLength, position);
      if (bytesRead <= 0) break;
      const chunk = bytesRead === readLength ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytesReadTotal += bytesRead;
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1;
      }
    }
    if (chunks.length === 0) return [];
    return Buffer.concat(chunks, bytesReadTotal).toString("utf8").split(/\n+/).filter(Boolean).slice(-safeLimit);
  } finally {
    closeSync(fd);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isDaemonRoute(routePath: string): boolean {
  return routePath.startsWith("/api/daemon/");
}

function operatorAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const UI_ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isUiAssetPath(pathname: string): boolean {
  return pathname === "/favicon.svg" || pathname === "/favicon.png" || pathname === "/flounder-black.png" || pathname === "/flounder-white.png" || pathname.startsWith("/assets/");
}

function serveUiAsset(pathname: string, res: ServerResponse): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "bad asset path" });
    return;
  }
  if (decoded.includes("\0")) {
    sendJson(res, 400, { error: "bad asset path" });
    return;
  }
  const file = path.resolve(UI_PUBLIC_DIR, `.${decoded}`);
  const root = path.resolve(UI_PUBLIC_DIR);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    sendJson(res, 400, { error: "bad asset path" });
    return;
  }
  const type = UI_ASSET_TYPES[path.extname(file).toLowerCase()];
  if (!type) {
    sendJson(res, 404, { error: "asset not found" });
    return;
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "asset not found" });
  }
}

// ---- handlers -------------------------------------------------------------------------

function withProject(c: Ctx, fn: (projectId: number, project: Record<string, unknown>) => void): void {
  const uuid = c.params.uuid ?? "";
  const project = c.store.getProjectByRef(uuid);
  if (!project) {
    sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
    return;
  }
  fn(Number(project.id), project);
}

async function withProjectAsync(c: Ctx, fn: (projectId: number, project: Record<string, unknown>) => Promise<void>): Promise<void> {
  const uuid = c.params.uuid ?? "";
  const project = c.store.getProjectByRef(uuid);
  if (!project) {
    sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
    return;
  }
  await fn(Number(project.id), project);
}

async function reconcileAllStaleAuditingScopes(c: Ctx): Promise<void> {
  for (const project of c.store.listProjects({ archived: "all" })) await reconcileStaleAuditingScopes(c, project);
}

async function reconcileStaleAuditingScopes(c: Ctx, project: Record<string, unknown>): Promise<void> {
  const projectName = String(project.name ?? "");
  const hasInFlightJob = c.store.runningJobs().some((job) => String(job.project ?? "") === projectName);
  if (hasInFlightJob) return;

  const projectId = Number(project.id);
  if (!Number.isFinite(projectId)) return;
  c.store.resetAuditingScopes(projectId);

  const inventoryDir = projectHistoryDir({ outputDir: c.out, targetName: projectName });
  let inventory: Awaited<ReturnType<typeof loadScopeInventory>>;
  try {
    inventory = await loadScopeInventory(inventoryDir);
  } catch (error) {
    // Old releases wrote scopes.json in place, so a process interruption may
    // leave one historical inventory truncated. Keep strict loading for audit
    // resume, but isolate dashboard reconciliation to this project so one bad
    // checkpoint cannot make every project listing fail.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[flounder ui] skipped corrupt scope inventory for ${JSON.stringify(projectName)}: ${detail}`);
    return;
  }
  const resetScopeIds: string[] = [];
  for (const scope of inventory) {
    if (scope.status !== "auditing") continue;
    scope.status = "pending";
    resetScopeIds.push(scope.id);
  }
  if (resetScopeIds.length > 0) await saveScopeInventory(inventoryDir, inventory, { forceStatusIds: resetScopeIds });
}

// The editable project fields shared by create + update (materials are relative paths now;
// providerId selects a profile; dir is the subdir under the daemon workspace).
interface ProjectBody {
  sourcePaths?: string[];
  buildRoot?: string;
  corpusPaths?: string[];
  config?: unknown;
  providerId?: number | null;
  daemonId?: number | null;
  dir?: string;
  archived?: boolean;
  pinned?: boolean;
  sortOrder?: number | null;
}
function projectFields(body: ProjectBody): Omit<ProjectInput, "name"> {
  return {
    sourcePaths: body.sourcePaths,
    buildRoot: body.buildRoot,
    corpusPaths: body.corpusPaths,
    config: body.config,
    providerId: typeof body.providerId === "number" ? body.providerId : undefined,
    daemonId: typeof body.daemonId === "number" ? body.daemonId : undefined,
    dir: typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : undefined,
  };
}

async function projectCreate(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as ProjectBody & { name?: string };
  const name = (body.name ?? "").trim();
  if (!name) return sendJson(c.res, 400, { error: "project name is required" });
  if (c.store.getProject(name)) return sendJson(c.res, 409, { error: `a project named "${name}" already exists` });
  const id = c.store.upsertProject({ name, ...projectFields(body) });
  const project = c.store.getProjectById(id);
  sendJson(c.res, 200, { ok: true, id, uuid: project?.uuid, name });
}

async function projectGet(c: Ctx): Promise<void> {
  await withProjectAsync(c, async (id, project) => {
    reconcileLostExecutorJobs(c.store, c.plane);
    await reconcileStaleAuditingScopes(c, project);
    const allRunsRaw = c.store.listRuns(id);
    const materialBoundary = latestPrepareRun(allRunsRaw);
    const activePrepareRefresh = activePrepareRefreshStartedAt(c.store, project, materialBoundary);
    const viewBoundary = materialViewBoundary(materialBoundary, activePrepareRefresh);
    const currentRunsRaw = currentVisibleRuns(allRunsRaw, materialBoundary, activePrepareRefresh);
    const scopeBoundary = latestScopeInventoryBoundaryRun(currentRunsRaw);
    const currentResultRunsRaw = currentResultRuns(currentRunsRaw, scopeBoundary);
    const currentRunIds = runIdSet(currentResultRunsRaw);
    const runs = runApiRows(c.store, allRunsRaw.slice(0, 50), c.plane, viewBoundary);
    const scopeView = currentScopeView(c.store, id, currentRunsRaw, activePrepareRefresh, scopeBoundary, !materialBoundary);
    const scopes = scopeApiRows(scopeView.scopes.slice(0, 50));
    const progress = scopeView.progress;
    const allFindings = activePrepareRefresh
      ? []
      : reportableFindings(c.store.listFindings(id).filter((row) => rowBelongsToCurrentMaterial(row, currentRunIds, materialBoundary)));
    const activeFindings = allFindings.filter((finding) => !isIgnoredFinding(finding));
    const findingSummaries = withLatestFindingAttempts(c.store, allFindings)
      .map((finding) => findingSummaryRow({ ...finding, timeline: c.store.findingTimeline(Number(finding.id)) }));
    const auditConfirmedFindings = countAuditConfirmedFindings(activeFindings);
    const confirmDecisions = activePrepareRefresh
      ? []
      : currentConfirmDecisions(c.store.listConfirmDecisions(id).filter((row) => rowBelongsToCurrentMaterial(row, currentRunIds, materialBoundary)));
    const reproducedBugs = confirmDecisions.filter((row) => row.reproduced === "yes" && isRealTargetDecisionEvidence(stringValue(row.evidence_level))).length;
    const requiresRealTargetConfirmation = projectRequiresRealTargetConfirmation(project, allRunsRaw);
    const mappedScopeIds = new Set(scopeView.scopes.map((scope) => stringValue(scope.scope_id)).filter(Boolean));
    sendJson(c.res, 200, {
      project,
      progress,
      statusCounts: findingCounts(activeFindings),
      findingsTotal: activeFindings.length,
      auditConfirmedFindings,
      reproducedBugs,
      confirmedBugs: requiresRealTargetConfirmation ? reproducedBugs : auditConfirmedFindings,
      runs,
      runsTotal: c.store.countRuns(id),
      currentRunsTotal: currentResultRunsRaw.length,
      activeScopeCount: scopeView.hasInventory ? c.store.countScopesByStatus(id, "auditing") : 0,
      activeScopeIds: scopeView.hasInventory
        ? c.store.listScopes(id).filter((scope) => scope.status === "auditing").map((scope) => stringValue(scope.scope_id)).filter(Boolean)
        : [],
      confirmDecisions: confirmDecisions.map(confirmDecisionDisplayRow),
      scopes,
      latestRunHealth: runHealthDisplayRow(c.store.latestRunHealth(id)),
      backlogCounts: c.store.discoveryBacklogCounts(id),
      discoveryBacklog: c.store.listDiscoveryBacklog(id, { status: "open", limit: 50 }).map((row) => discoveryBacklogDisplayRow(row, mappedScopeIds)),
      openResourceRequests: c.store.listDiscoveryBacklog(id, { kind: "resource-request", status: "open", limit: 10 }).map((row) => discoveryBacklogDisplayRow(row, mappedScopeIds)),
      allFindings: findingSummaries,
      prepareSummary: activePrepareRefresh && currentRunsRaw.length === 0 ? null : latestPrepareSummary(runs),
      material: materialSummary(allRunsRaw, materialBoundary, activePrepareRefresh),
    });
  });
}

function runApiRows(store: MetadataStore, runs: Array<Record<string, unknown>>, plane?: ControlPlane, materialBoundary?: Record<string, unknown>): Array<Record<string, unknown>> {
  return runs.map((run) => runApiRow(store, run, plane, materialBoundary));
}

function runApiRow(store: MetadataStore, run: Record<string, unknown>, plane?: ControlPlane, materialBoundary?: Record<string, unknown>): Record<string, unknown> {
  const runId = Number(run.id);
  const job = Number.isFinite(runId) ? store.getJobByRun(runId) : undefined;
  const activity = runActivityFields(store, plane, run);
  const material = materialStaleness(run, materialBoundary);
  const health = run.health_status ? { runHealth: runHealthDisplayRow(run) } : {};
  if (!job) return { ...run, ...activity, ...material, ...health };
  const runStatus = typeof run.status === "string" ? run.status : "";
  const jobError = runStatus === "done" ? undefined : stringValue(job.error) || undefined;
  return {
    ...run,
    ...activity,
    ...material,
    ...health,
    job_id: job.id,
    job_status: job.status,
    job_error: jobError,
  };
}

const RUN_STALE_ACTIVITY_MS = 15 * 60 * 1000;
const DAEMON_LOST_JOB_GRACE_MS = 30 * 1000;

function runActivityFields(store: MetadataStore, plane: ControlPlane | undefined, run: Record<string, unknown>): Record<string, unknown> {
  if (run.status !== "running") return {};
  const runId = Number(run.id);
  if (!Number.isFinite(runId)) return {};
  const lastActivityAt = latestRunActivityAt(store, plane, runId);
  const activity = runInactivity(lastActivityAt);
  return {
    ...(lastActivityAt ? { last_activity_at: lastActivityAt } : {}),
    ...(activity ? { inactive_seconds: activity.inactiveSeconds, stale_activity: activity.staleActivity } : {}),
  };
}

function emptyProgress(): Coverage {
  return { total: 0, audited: 0, deferred: 0, pending: 0 };
}

function latestPrepareRun(runs: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return runs.find(isSuccessfulPrepareRun);
}

function isSuccessfulPrepareRun(entry: Record<string, unknown>): boolean {
  return entry.kind === "prepare" && entry.status === "done" && typeof entry.started_at === "string";
}

function latestScopeInventoryBoundaryRun(runs: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return runs.find((entry) => entry.kind === "map" && typeof entry.started_at === "string");
}

function isCurrentMaterialRun(run: Record<string, unknown>, boundary?: Record<string, unknown>): boolean {
  if (!boundary) return true;
  const boundaryFingerprint = stringValue(boundary.material_fingerprint);
  const runFingerprint = stringValue(run.material_fingerprint);
  if (boundaryFingerprint && runFingerprint) return boundaryFingerprint === runFingerprint || Number(run.id) === Number(boundary.id);
  const runStarted = stringValue(run.started_at);
  const boundaryStarted = stringValue(boundary.started_at);
  if (!runStarted || !boundaryStarted) return true;
  return runStarted >= boundaryStarted;
}

function currentResultRuns(runs: Array<Record<string, unknown>>, boundary?: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!boundary) return runs;
  const boundaryStarted = stringValue(boundary.started_at);
  if (!boundaryStarted) return runs;
  return runs.filter((run) => {
    const runStarted = stringValue(run.started_at);
    return Boolean(runStarted && runStarted >= boundaryStarted);
  });
}

function currentMaterialRuns(runs: Array<Record<string, unknown>>, boundary?: Record<string, unknown>): Array<Record<string, unknown>> {
  return runs.filter((run) => isCurrentMaterialRun(run, boundary));
}

function currentVisibleRuns(runs: Array<Record<string, unknown>>, boundary?: Record<string, unknown>, activePrepareRefreshStartedAt?: string): Array<Record<string, unknown>> {
  const runningPrepareStartedAt = stringValue(boundary?.kind) === "prepare" && stringValue(boundary?.status) === "running"
    ? stringValue(boundary?.started_at)
    : undefined;
  const prepareRefreshStartedAt = activePrepareRefreshStartedAt ?? runningPrepareStartedAt;
  if (!prepareRefreshStartedAt) return currentMaterialRuns(runs, boundary);
  return runs.filter((run) => {
    if (stringValue(run.kind) !== "prepare") return false;
    const runStarted = stringValue(run.started_at);
    return Boolean(runStarted && runStarted >= prepareRefreshStartedAt);
  });
}

function activePrepareRefreshStartedAt(store: MetadataStore, project: Record<string, unknown>, boundary?: Record<string, unknown>, jobs?: Array<Record<string, unknown>>): string | undefined {
  const projectName = stringValue(project.name);
  if (!projectName) return undefined;
  const boundaryStarted = stringValue(boundary?.started_at);
  const job = (jobs ?? store.runningJobs()).find((entry) => {
    if (stringValue(entry.project) !== projectName) return false;
    const spec = safeParse(entry.spec_json) as { verb?: unknown } | null;
    if (spec?.verb === "prepare") return true;
    if (spec?.verb !== "run") return false;
    const runId = Number(entry.run_id);
    if (!Number.isFinite(runId)) return Boolean((spec as { pipeline?: unknown; clue?: unknown; sourcePaths?: unknown }).pipeline && stringValue((spec as { clue?: unknown }).clue));
    const run = store.getRun(runId);
    return stringValue(run?.kind) === "prepare" && stringValue(run?.status) === "running";
  });
  const startedAt = stringValue(job?.created_at);
  if (!startedAt) return undefined;
  return !boundaryStarted || startedAt >= boundaryStarted ? startedAt : undefined;
}

function materialViewBoundary(boundary: Record<string, unknown> | undefined, activePrepareRefreshStartedAt?: string): Record<string, unknown> | undefined {
  if (!activePrepareRefreshStartedAt) return boundary;
  return {
    ...(boundary ?? {}),
    status: "running",
    started_at: activePrepareRefreshStartedAt,
    active_prepare_refresh: true,
  };
}

function runIdSet(runs: Array<Record<string, unknown>>): Set<number> {
  return new Set(runs.map((run) => Number(run.id)).filter(Number.isFinite));
}

function rowBelongsToCurrentMaterial(row: Record<string, unknown>, currentRunIds: Set<number>, boundary?: Record<string, unknown>): boolean {
  if (!boundary) return true;
  const runId = Number(row.run_id);
  return Number.isFinite(runId) && currentRunIds.has(runId);
}

function currentConfirmDecisions(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ranked = rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const aCreated = stringValue(a.row.created_at);
    const bCreated = stringValue(b.row.created_at);
    if (aCreated !== bCreated) return bCreated.localeCompare(aCreated);
    const aRun = Number(a.row.run_id);
    const bRun = Number(b.row.run_id);
    if (Number.isFinite(aRun) && Number.isFinite(bRun) && aRun !== bRun) return bRun - aRun;
    return a.index - b.index;
  });
  const kept: Array<Record<string, unknown>> = [];
  const settledCovered = new Set<string>();
  const unsettledCovered = new Set<string>();
  for (const { row } of ranked) {
    if (!isSettledConfirmDecision(row)) continue;
    const keys = confirmDecisionMemberKeys(row);
    if (keys.length > 0 && keys.every((key) => settledCovered.has(key))) continue;
    kept.push(row);
    for (const key of keys) settledCovered.add(key);
  }
  for (const { row } of ranked) {
    if (isSettledConfirmDecision(row)) continue;
    const keys = confirmDecisionMemberKeys(row);
    if (keys.length > 0 && keys.every((key) => settledCovered.has(key) || unsettledCovered.has(key))) continue;
    kept.push(row);
    for (const key of keys) unsettledCovered.add(key);
  }
  return kept;
}

function isSettledConfirmDecision(row: Record<string, unknown>): boolean {
  return row.reproduced === "yes" || row.reproduced === "no";
}

function confirmSettledRows(rows: Array<Record<string, unknown>>): ConfirmSettledRow[] {
  return rows.filter((row) => isResumeSettledDecision(row)).map((row) => {
    const reproduced = row.reproduced === "yes" || row.reproduced === "no" ? row.reproduced : "unknown";
    const recommendationRaw = stringValue(row.recommendation);
    const recommendation: ConfirmSettledRow["recommendation"] =
      recommendationRaw === "submit-candidate" || recommendationRaw === "needs-human" || recommendationRaw === "drop" ? recommendationRaw : "unknown";
    const members = safeParse(row.members_json);
    const out: ConfirmSettledRow = {
      bug: stringValue(row.bug) || "(unnamed)",
      members: Array.isArray(members) ? members.filter((member): member is string => typeof member === "string" && member.trim().length > 0) : [],
      distinctFix: stringValue(row.distinct_fix),
      reproduced,
      reproEvidence: stringValue(row.repro_evidence),
      corroboration: stringValue(row.corroboration),
      novelty: stringValue(row.novelty),
      humanGates: stringValue(row.human_gates),
      recommendation,
    };
    const engagementProfile = safeParse(row.engagement_profile_json);
    if (engagementProfile) out.engagementProfile = engagementProfile;
    const adjudication = safeParse(row.adjudication_json);
    if (adjudication) out.adjudication = adjudication;
    const reproCommandId = stringValue(row.repro_command_id);
    if (reproCommandId) out.reproCommandId = reproCommandId;
    return out;
  });
}

function confirmDecisionMemberKeys(row: Record<string, unknown>): string[] {
  const members = safeParse(row.members_json);
  if (!Array.isArray(members)) return [];
  const keys = new Set<string>();
  const add = (value: string): void => {
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

function confirmDecisionKeySet(rows: Array<Record<string, unknown>>): Set<string> {
  return new Set(rows.flatMap(confirmDecisionMemberKeys));
}

function findingRowCoveredByDecision(row: Record<string, unknown>, decisionKeys: Set<string>): boolean {
  const key = stringValue(row.finding_key).toLowerCase();
  return Boolean(key && decisionKeys.has(key));
}

function linkedFindingsForDecision(store: MetadataStore, projectId: number, decision: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = new Set(confirmDecisionMemberKeys(decision));
  if (keys.size === 0) return [];
  return store.listFindings(projectId).filter((finding) => {
    const key = stringValue(finding.finding_key).toLowerCase();
    return key && keys.has(key);
  });
}

function isScopeInventoryRun(run: Record<string, unknown>): boolean {
  const kind = stringValue(run.kind);
  if (kind === "audit") {
    const budgets = safeParse(run.budgets_json) as { verify?: unknown } | null;
    if (budgets?.verify === true) return false;
  }
  return ["run", "map", "audit"].includes(kind);
}

function currentScopeView(
  store: MetadataStore,
  projectId: number,
  currentRuns: Array<Record<string, unknown>>,
  activePrepareRefreshStartedAt?: string,
  scopeBoundary?: Record<string, unknown>,
  allowDbFallback = true,
): { scopes: Array<Record<string, unknown>>; progress: Coverage; total: number; hasInventory: boolean } {
  if (activePrepareRefreshStartedAt) return { scopes: [], progress: emptyProgress(), total: 0, hasInventory: false };
  const latestRun = currentRuns.find(isScopeInventoryRun);
  if (!latestRun) {
    const total = store.countScopes(projectId);
    if (allowDbFallback && total > 0) {
      return {
        scopes: store.listScopes(projectId),
        progress: store.scopeProgress(projectId),
        total,
        hasInventory: true,
      };
    }
    return { scopes: [], progress: emptyProgress(), total: 0, hasInventory: false };
  }

  const checkpoint = latestScopeCheckpoint([latestRun]);
  if (checkpoint) return checkpointScopeView(store, projectId, checkpoint);

  // A running remap/map invalidates the prior inventory for the current view until it checkpoints.
  // A running audit is downstream of the inventory; before its first checkpoint, keep showing
  // the stored scope list rather than making the project look unmapped.
  if (stringValue(latestRun.status) === "running" && stringValue(latestRun.kind) === "map") {
    return { scopes: [], progress: emptyProgress(), total: 0, hasInventory: true };
  }

  const storedTotal = store.countScopes(projectId);
  if (storedTotal > 0) {
    return {
      scopes: store.listScopes(projectId),
      progress: store.scopeProgress(projectId),
      total: storedTotal,
      hasInventory: true,
    };
  }

  // The latest map is the current-material boundary, not necessarily the latest
  // inventory. Continue/append-map runs merge novel scopes into later full
  // checkpoints; preferring the original map here made the API and UI appear to
  // lose every appended scope. It is only a last-resort fallback when neither a
  // later checkpoint nor the active SQLite projection is available.
  const boundaryCheckpoint = scopeBoundary ? latestScopeCheckpoint([scopeBoundary]) : null;
  if (boundaryCheckpoint) return checkpointScopeView(store, projectId, boundaryCheckpoint);

  return {
    scopes: store.listScopes(projectId),
    progress: store.scopeProgress(projectId),
    total: store.countScopes(projectId),
    hasInventory: true,
  };
}

function isScopeInventoryVerb(verb: string | undefined): boolean {
  return verb === "run" || verb === "map" || verb === "audit";
}

function materialStaleness(run: Record<string, unknown>, boundary?: Record<string, unknown>): Record<string, unknown> {
  const prepareRefresh = Boolean(boundary?.active_prepare_refresh)
    || (stringValue(boundary?.kind) === "prepare" && stringValue(boundary?.status) === "running");
  if (prepareRefresh) {
    const boundaryStarted = stringValue(boundary?.started_at);
    const runStarted = stringValue(run.started_at);
    if (stringValue(run.kind) === "prepare" && (!boundaryStarted || !runStarted || runStarted >= boundaryStarted)) return {};
    return {
      material_stale: true,
      stale_since_prepare_run_id: boundary?.id,
      stale_since_prepare_started_at: boundary?.started_at,
    };
  }
  if (!boundary || isCurrentMaterialRun(run, boundary)) return {};
  return {
    material_stale: true,
    stale_since_prepare_run_id: boundary.id,
    stale_since_prepare_started_at: boundary.started_at,
  };
}

function materialSummary(runs: Array<Record<string, unknown>>, boundary?: Record<string, unknown>, activePrepareRefreshStartedAt?: string): Record<string, unknown> {
  const activePrepareFields = activePrepareRefreshStartedAt
    ? {
      currentPrepareStatus: "running",
      currentPrepareStartedAt: activePrepareRefreshStartedAt,
      activePrepareRefreshStartedAt,
    }
    : {};
  if (!boundary) return { currentPrepareRunId: null, staleRunCount: 0, ...activePrepareFields };
  const scopeBoundary = latestScopeInventoryBoundaryRun(currentVisibleRuns(runs, boundary, activePrepareRefreshStartedAt));
  const staleRunCount = runs.filter((run) => !isCurrentMaterialRun(run, boundary)).length;
  return {
    currentPrepareRunId: boundary.id,
    currentPrepareStatus: activePrepareRefreshStartedAt ? "running" : boundary.status,
    currentPrepareStartedAt: activePrepareRefreshStartedAt ?? boundary.started_at,
    ...(scopeBoundary ? {
      currentScopeInventoryRunId: scopeBoundary.id,
      currentScopeInventoryStatus: scopeBoundary.status,
      currentScopeInventoryStartedAt: scopeBoundary.started_at,
    } : {}),
    staleRunCount,
    ...(activePrepareRefreshStartedAt ? { activePrepareRefreshStartedAt } : {}),
  };
}

async function projectScopesGet(c: Ctx): Promise<void> {
  await withProjectAsync(c, async (id, project) => {
    await reconcileStaleAuditingScopes(c, project);
    const allRuns = c.store.listRuns(id);
    const materialBoundary = latestPrepareRun(allRuns);
    const activePrepareRefresh = activePrepareRefreshStartedAt(c.store, project, materialBoundary);
    const currentRuns = currentVisibleRuns(allRuns, materialBoundary, activePrepareRefresh);
    const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
    const scopeView = currentScopeView(c.store, id, currentRuns, activePrepareRefresh, scopeBoundary, !materialBoundary);
    if (!scopeView.hasInventory) {
      return sendJson(c.res, 200, {
        scopes: [],
        progress: emptyProgress(),
        total: 0,
        limit: clampInt(c.url.searchParams.get("limit"), 50, 1, 500),
        offset: clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000),
        material: materialSummary(allRuns, materialBoundary, activePrepareRefresh),
      });
    }
    const limit = clampInt(c.url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
    sendJson(c.res, 200, {
      scopes: scopeApiRows(scopeView.scopes.slice(offset, offset + limit)),
      progress: scopeView.progress,
      total: scopeView.total,
      limit,
      offset,
      material: materialSummary(allRuns, materialBoundary, activePrepareRefresh),
    });
  });
}

function projectBacklogGet(c: Ctx): void {
  withProject(c, (id) => {
    const filter: DiscoveryBacklogFilter = {
      limit: clampInt(c.url.searchParams.get("limit"), 100, 1, 500),
      offset: clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000),
    };
    const kind = discoveryBacklogKind(c.url.searchParams.get("kind"));
    const status = discoveryBacklogStatus(c.url.searchParams.get("status") ?? "open", true);
    if (kind) filter.kind = kind;
    if (status) filter.status = status;
    const mappedScopeIds = new Set(c.store.listScopes(id).map((scope) => stringValue(scope.scope_id)).filter(Boolean));
    sendJson(c.res, 200, {
      backlog: c.store.listDiscoveryBacklog(id, filter).map((row) => discoveryBacklogDisplayRow(row, mappedScopeIds)),
      counts: c.store.discoveryBacklogCounts(id),
      total: c.store.countDiscoveryBacklog(id, filter),
      limit: filter.limit,
      offset: filter.offset,
    });
  });
}

function scopeApiRows(scopes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return scopes.map((scope) => {
    const title = stringValue(scope.title) || stringValue(scope.scope_id);
    const location = stringValue(scope.location);
    return {
      ...scope,
      obligation: stringValue(scope.obligation) || title,
      region: stringValue(scope.region) || location,
    };
  });
}

function discoveryBacklogDisplayRow(row: Record<string, unknown>, mappedScopeIds: Set<string>): Record<string, unknown> {
  const payload = safeParse(row.payload_json);
  return {
    ...row,
    payload,
    ...discoveryBacklogActionMeta(row, payload, mappedScopeIds),
  };
}

function discoveryBacklogActionMeta(row: Record<string, unknown>, payload: unknown, mappedScopeIds: Set<string>): Record<string, unknown> {
  const kind = stringValue(row.kind);
  const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const scopeId = stringValue(row.scope_id) || stringValue(payloadRecord.scope_id ?? payloadRecord.scopeId ?? payloadRecord.id);
  const mappedScope = Boolean(scopeId && mappedScopeIds.has(scopeId));
  if (kind === "resource-request") {
    return {
      actionability: "agent-resource",
      action_owner: "agent",
      recommended_action: "resolve-resource",
      primary_action_label: "Fix setup",
      autonomous: true,
      action_reason: "The agent should inspect the missing resource, retry safe setup work, and ask only for explicit credentials or authorization when required.",
    };
  }
  if (kind === "coverage-gap") {
    return {
      actionability: "agent-runnable",
      action_owner: "agent",
      recommended_action: mappedScope ? "prioritize-scope" : "expand-map",
      primary_action_label: mappedScope ? "Prioritize scope" : "Expand map",
      autonomous: true,
      action_reason: mappedScope ? "The agent can prioritize this mapped gap for the next dig batch." : "The agent can append map coverage to turn this gap into a current mapped scope.",
    };
  }
  if (kind === "followup-scope") {
    return {
      actionability: "agent-runnable",
      action_owner: "agent",
      recommended_action: mappedScope ? "prioritize-scope" : "expand-map",
      primary_action_label: mappedScope ? "Prioritize scope" : "Expand map",
      autonomous: true,
      action_reason: mappedScope ? "The agent can move this follow-up scope to the front of the dig queue." : "The agent can append map coverage so this follow-up becomes runnable in the current inventory.",
    };
  }
  return {
    actionability: "agent-review",
    action_owner: "agent",
    recommended_action: "review-and-route",
    primary_action_label: "Run agent",
    autonomous: true,
    action_reason: "The agent should inspect this backlog row and decide the next safe workflow action.",
  };
}

function runHealthDisplayRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    runId: row.id,
    runKind: row.kind,
    runStatus: row.run_status ?? row.status,
    status: row.health_status,
    reasons: parseStringArray(row.health_reasons_json),
    signals: safeParse(row.health_signals_json) ?? {},
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  };
}

function latestPrepareSummary(runs: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const run = runs.find((entry) => entry.kind === "prepare" && typeof entry.run_dir === "string");
  if (!run) return null;
  return readPrepareSummary(run);
}

function readPrepareManifestObject(run: Record<string, unknown>): Record<string, unknown> | undefined {
  const runDirValue = stringValue(run.run_dir);
  if (!runDirValue) return undefined;
  const runDir = path.resolve(runDirValue);
  const workspaceDir = path.join(runDir, "prepare", "workspace");
  const manifestPath = resolvePrepareManifestPath(runDir, workspaceDir);
  if (!manifestPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function latestScopeCheckpoint(runs: Array<Record<string, unknown>>): { scopes: Array<Record<string, unknown>>; progress: Coverage } | null {
  const run = runs.find((entry) => ["run", "map", "audit"].includes(String(entry.kind)) && typeof entry.run_dir === "string");
  if (!run) return null;
  const runDir = path.resolve(String(run.run_dir));
  const finalScopes = path.join(runDir, "audit_scopes.json");
  const workspaceScopes = path.join(runDir, "audit", "workspace", "scopes.json");
  const candidates = stringValue(run.status) === "running"
    ? [workspaceScopes, finalScopes, path.join(runDir, "scopes.json"), path.join(runDir, "inventory", "scopes.json")]
    : [finalScopes, workspaceScopes, path.join(runDir, "scopes.json"), path.join(runDir, "inventory", "scopes.json")];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const rawScopes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).scopes)
        ? ((parsed as Record<string, unknown>).scopes as unknown[])
        : [];
    const scopes = rawScopes
      .map((entry, index) => scopeCheckpointRow(entry, index))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    if (scopes.length === 0) return null;
    const audited = scopes.filter((scope) => ["audited", "done", "complete", "completed"].includes(String(scope.status))).length;
    const deferred = scopes.filter((scope) => scope.status === "deferred").length;
    return { scopes, progress: { total: scopes.length, audited, deferred, pending: Math.max(0, scopes.length - audited - deferred) } };
  } catch {
    return null;
  }
}

function scopeCheckpointRow(entry: unknown, index: number): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const scope = entry as Record<string, unknown>;
  const scopeId = stringValue(scope.scope_id ?? scope.id) || `checkpoint-${index + 1}`;
  const title = stringValue(scope.title ?? scope.obligation ?? scope.scope ?? scope.name) || scopeId;
  const obligation = stringValue(scope.obligation) || composeCheckpointObligation(scope) || title;
  const status = stringValue(scope.status) || "pending";
  return {
    scope_id: scopeId,
    title,
    location: stringValue(scope.location ?? scope.region),
    obligation,
    region: stringValue(scope.region ?? scope.location),
    score: numericValue(scope.score) ?? scoreFromCheckpointExposure(scope.exposure),
    priority: numericValue(scope.priority),
    status,
  };
}

function composeCheckpointObligation(scope: Record<string, unknown>): string | undefined {
  const spec = stringValue(scope.spec);
  const value = stringValue(scope.value);
  const inputs = stringValue(scope.inputs);
  if (!spec && !value && !inputs) return undefined;
  return [
    spec ? `Spec: ${spec}` : undefined,
    value ? `Value at risk: ${value}` : undefined,
    inputs ? `Inputs/trust boundary: ${inputs}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function scoreFromCheckpointExposure(exposure: unknown): number | null {
  const value = stringValue(exposure).toLowerCase();
  if (value === "critical") return 100;
  if (value === "high") return 80;
  if (value === "medium" || value === "moderate") return 50;
  if (value === "low") return 20;
  if (value === "info" || value === "informational") return 10;
  return null;
}

function checkpointScopeView(
  store: MetadataStore,
  projectId: number,
  checkpoint: { scopes: Array<Record<string, unknown>>; progress: Coverage },
): { scopes: Array<Record<string, unknown>>; progress: Coverage; total: number; hasInventory: boolean } {
  const stored = new Map(store.listScopes(projectId).map((scope) => [stringValue(scope.scope_id), scope]));
  const scopes = checkpoint.scopes.map((scope) => {
    const scopeId = stringValue(scope.scope_id);
    const row = stored.get(scopeId);
    if (!row) return scope;
    return {
      ...scope,
      id: row.id,
      project_id: row.project_id,
      status: stringValue(row.status) || stringValue(scope.status) || "pending",
      priority: numericValue(row.priority) ?? numericValue(scope.priority),
      dig_seconds: row.dig_seconds,
      updated_at: row.updated_at,
    };
  }).sort(scopeDisplaySort);
  return { scopes, progress: progressForScopeRows(scopes), total: scopes.length, hasInventory: true };
}

function scopeDisplaySort(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (numberValue(b.priority) - numberValue(a.priority))
    || (numberValue(b.score) - numberValue(a.score))
    || String(a.status).localeCompare(String(b.status));
}

function progressForScopeRows(scopes: Array<Record<string, unknown>>): Coverage {
  const audited = scopes.filter((scope) => scope.status === "audited").length;
  const deferred = scopes.filter((scope) => scope.status === "deferred").length;
  return { total: scopes.length, audited, deferred, pending: Math.max(0, scopes.length - audited - deferred) };
}

function readPrepareSummary(run: Record<string, unknown>): Record<string, unknown> {
  const runDir = path.resolve(String(run.run_dir));
  const workspaceDir = path.join(runDir, "prepare", "workspace");
  const manifestPath = resolvePrepareManifestPath(runDir, workspaceDir);
  const workspace = summarizePreparedWorkspace(workspaceDir);
  const issues: string[] = [];
  let manifest: Record<string, unknown> | undefined;
  let manifestStatus: "present" | "missing" | "invalid" = "missing";
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
        manifestStatus = "present";
      } else {
        manifestStatus = "invalid";
        issues.push("prepare_manifest.json is not a JSON object");
      }
    } catch (error) {
      manifestStatus = "invalid";
      issues.push(`prepare_manifest.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    issues.push("prepare_manifest.json has not been written yet");
  }

  const components = Array.isArray(manifest?.components) ? (manifest.components as Array<Record<string, unknown>>) : [];
  if (manifestStatus === "present" && components.length === 0) {
    const workspaceFiles = typeof workspace.files === "number" ? workspace.files : 0;
    issues.push(workspaceFiles > 0 ? "manifest lists no components" : "prepared workspace is empty");
  }
  let matched = 0;
  let unverified = 0;
  let sourcePinned = 0;
  let inScope = 0;
  const componentRows = components.slice(0, 8).map((component) => summarizePrepareComponent(component));
  const openPrepareGaps = hasOpenPrepareGaps(manifest?.gaps);
  for (const component of components) {
    const summary = summarizePrepareComponent(component);
    const unresolvedFields = pendingPrepareComponentPlaceholderFields(component, summary);
    if (summary.inScope) inScope += 1;
    if (summary.deployed && summary.match === "matched") matched += 1;
    else if (summary.deployed && summary.match === "unverified") unverified += 1;
    const revisionPinned = Boolean(summary.revision) && !isPendingPreparePlaceholder(summary.revision);
    if (revisionPinned) sourcePinned += 1;
    if (unresolvedFields.length > 0) issues.push(`${summary.identity}: unresolved prepare placeholder(s): ${unresolvedFields.join(", ")}`);
    if (summary.deployed && summary.match !== "matched" && summary.match !== "unverified") {
      issues.push(`${summary.identity}: deployed on ${summary.platform || "unknown platform"} but match is ${summary.match || "missing"}`);
    }
    if (!summary.deployed && !revisionPinned) {
      issues.push(`${summary.identity}: source origin is not pinned`);
    }
  }
  if (unverified > 0) issues.push(`${unverified} deployed component(s) are unverified and should be treated as trust boundaries`);
  if (openPrepareGaps) issues.push("prepare manifest has unresolved material gaps");

  const rawManifestState = stringValue(manifest?.status);
  const runStatus = stringValue(run.status);
  const unsuccessfulTerminalPrepare = Boolean(runStatus && runStatus !== "running" && runStatus !== "done");
  if (unsuccessfulTerminalPrepare) {
    issues.push(`prepare run ended with status ${runStatus}; staged materials are not reusable until Prepare completes successfully`);
  }

  const posture = stringValue(manifest?.posture);
  const answerFirewall = describeAnswerFirewall(manifest?.answer_firewall, posture);
  if (!isNonBlockingAnswerFirewall(answerFirewall)) {
    issues.push(`answer firewall is ${answerFirewall}`);
  }
  const realTarget = summarizePrepareRealTarget(manifest?.real_target ?? manifest?.realTarget);
  if (manifestStatus === "present") {
    if (!realTarget.reported) issues.push("real-target verification plan is missing");
    for (const issue of realTarget.issues) issues.push(issue);
  }

  const terminalPrepareRun = runStatus !== "running";
  const rawManifestStateLower = rawManifestState.toLowerCase();
  let manifestState = rawManifestState;
  const terminalManifestState = ["ready", "done", "complete", "completed", "verified"].includes(rawManifestStateLower);
  if (manifestStatus === "present" && manifestState && !["ready", "done", "complete", "completed", "verified", "partial"].includes(manifestState.toLowerCase())) {
    issues.push(`prepare manifest status is ${manifestState}; treat staged materials as not fully resolved`);
  }
  if (manifestStatus === "present" && terminalPrepareRun && (rawManifestStateLower === "in_progress" || terminalManifestState) && issues.length > 0) {
    manifestState = "partial";
    if (rawManifestStateLower === "in_progress") {
      issues.push("prepare run ended before all material gaps were closed; staged materials are usable but partial");
    } else {
      issues.push("prepare run ended with unresolved gaps, placeholders, or validation issues; staged materials are usable but partial");
    }
  }

  const summaryIssues = uniqueStrings(issues).slice(0, 12);
  const summaryGaps = summarizePrepareGaps(manifest?.gaps);
  const quality = prepareSummaryQuality({
    runStatus,
    manifestStatus,
    manifestState,
    issues: summaryIssues,
    gaps: summaryGaps,
  });
  const blockingIssues = summaryIssues.filter(isBlockingPrepareIssue);
  const softIssues = summaryIssues.filter((issue) => !isBlockingPrepareIssue(issue));
  const caveats = uniqueStrings([...softIssues, ...summaryGaps]).slice(0, 16);
  const auditReady = quality === "ready" || quality === "limited";

  return {
    runId: run.id,
    status: run.status,
    quality,
    auditReady,
    blocked: !auditReady && quality !== "preparing",
    blockingIssues,
    caveats,
    manifestStatus,
    manifestState: manifestState || undefined,
    manifestArtifact: manifestPath ? "prepare_manifest.json" : undefined,
    clue: stringValue(manifest?.clue),
    posture,
    scopeDeclaration: stringValue(manifest?.scope_declaration),
    answerFirewall,
    componentsTotal: components.length,
    components: componentRows,
    inScope,
    matched,
    unverified,
    sourcePinned,
    gaps: summaryGaps,
    offscope: summarizePrepareGaps(manifest?.offscope),
    realTarget,
    issues: summaryIssues,
    workspace,
  };
}

function prepareSummaryQuality(input: {
  runStatus: string;
  manifestStatus: "present" | "missing" | "invalid";
  manifestState: string;
  issues: string[];
  gaps: string[];
}): "ready" | "limited" | "preparing" | "needs-review" | "missing" | "invalid" {
  if (input.manifestStatus === "invalid") return "invalid";
  if (input.manifestStatus === "missing") return input.runStatus === "running" ? "preparing" : "missing";
  if (input.runStatus === "running") return "preparing";
  const state = input.manifestState.trim().toLowerCase();
  if (input.issues.some(isBlockingPrepareIssue)) return "needs-review";
  if (state === "partial" || input.issues.length > 0 || input.gaps.length > 0) return "limited";
  return "ready";
}

function isBlockingPrepareIssue(issue: string): boolean {
  const raw = issue.toLowerCase();
  if (raw.includes("answer firewall is")) {
    const firewall = issue.replace(/^.*?\banswer firewall is\b/i, "").trim();
    return !isNonBlockingAnswerFirewall(firewall);
  }
  return raw.includes("prepare_manifest.json has not been written")
    || raw.includes("prepare_manifest.json could not be parsed")
    || raw.includes("prepare_manifest.json is not a json object")
    || raw.includes("manifest lists no components")
    || raw.includes("prepared workspace is empty")
    || raw.includes("prepare run ended with status");
}

function summarizePrepareComponent(component: Record<string, unknown>): Record<string, unknown> {
  const origin = objectValue(component.origin) ?? objectValue(component.provenance);
  const deploymentMatch = objectValue(component.deployment_match);
  const platform = stringValue(component.platform);
  const normalizedPlatform = platform.trim().toLowerCase();
  const type = stringValue(component.type);
  const deployed = isPreparedDeployment(component, type, normalizedPlatform);
  const originSource = stringValue(component.source) || stringValue(origin?.url) || stringValue(origin?.repo_url);
  const originRevision = stringValue(component.revision)
    || stringValue(origin?.revision)
    || stringValue(origin?.commit)
    || stringValue(origin?.tag)
    || stringValue(origin?.ref)
    || stringValue(origin?.branch)
    || stringValue(origin?.repo_revision)
    || stringValue(origin?.source_pin)
    || stringValue(origin?.source_verifier)
    || stringValue(origin?.metadata)
    || stringValue(objectValue(origin?.code_digest)?.sha256);
  const stagedPath = stringValue(component.staged_path) || stringValue(component.path);
  const identity = stringValue(component.identity) || stagedPath || stringValue(component.id) || stringValue(component.name) || "unknown component";
  const match = normalizePrepareMatchStatus(stringValue(component.match) || stringValue(deploymentMatch?.status));
  return {
    role: stringValue(component.role) || stringValue(component.security_role) || stringValue(component.component_type) || type || "component",
    identity,
    platform,
    revision: originRevision,
    source: originSource,
    stagedPath,
    inScope: component.in_scope === true,
    match: match.toLowerCase(),
    matchEvidence: stringValue(component.match_evidence) || stringValue(deploymentMatch?.evidence) || stringValue(deploymentMatch?.reason) || stringValue(deploymentMatch?.note),
    deployed,
  };
}

function isPreparedDeployment(component: Record<string, unknown>, type: string, normalizedPlatform: string): boolean {
  if (stringValue(component.address)) return true;
  const addresses = objectValue(component.addresses);
  if (addresses && Object.keys(addresses).length > 0) return true;
  const normalizedType = type.toLowerCase();
  if (normalizedType.includes("ethereum_contract") || normalizedType.includes("deployed_contract") || normalizedType.includes("deployment")) return true;
  return isDeploymentPlatform(normalizedPlatform);
}

function isDeploymentPlatform(platform: string): boolean {
  if (!platform || platform === "none" || platform === "n/a") return false;
  if (platform.includes("github") || platform.includes("crates.io") || platform.includes("npm") || platform.includes("package")) return false;
  if (platform.includes("documentation") || platform.includes("docs") || platform.includes("spec")) return false;
  return [
    "ethereum",
    "evm",
    "mainnet",
    "sepolia",
    "testnet",
    "chain",
    "sourcify",
    "etherscan",
    "contract",
    "deployed",
    "l1",
    "l2",
  ].some((needle) => platform.includes(needle));
}

function normalizePrepareMatchStatus(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  if (raw === "na" || raw === "none" || raw.startsWith("n/a") || raw.includes("not_applicable") || raw.includes("not-applicable")) return "n/a";
  if (raw.includes("unverified") || raw.includes("not_verified") || raw.includes("no_match")) return "unverified";
  if (raw === "matched" || raw.includes("verified") || raw.includes("matched") || raw.includes("sourcify")) return "matched";
  return raw;
}

function pendingPrepareComponentPlaceholderFields(component: Record<string, unknown>, summary: Record<string, unknown>): string[] {
  const origin = objectValue(component.origin) ?? objectValue(component.provenance);
  const deploymentMatch = objectValue(component.deployment_match);
  const revision = component.revision
    ?? origin?.revision
    ?? origin?.commit
    ?? origin?.tag
    ?? origin?.ref
    ?? origin?.branch
    ?? origin?.repo_revision
    ?? origin?.source_pin
    ?? origin?.source_verifier
    ?? origin?.metadata
    ?? objectValue(origin?.code_digest)?.sha256;
  const fields: Array<[string, unknown]> = [
    ["revision", revision],
    ["staged_path", component.staged_path ?? component.stagedPath ?? component.path ?? summary.stagedPath],
    ["match", component.match ?? deploymentMatch?.status ?? summary.match],
  ];
  return fields.filter(([, value]) => isPendingPreparePlaceholder(value)).map(([label]) => label);
}

function hasOpenPrepareGaps(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((gap) => {
    if (gap === undefined || gap === null) return false;
    if (typeof gap === "string") return isPendingPreparePlaceholder(gap);
    if (typeof gap !== "object" || Array.isArray(gap)) return true;
    const row = gap as Record<string, unknown>;
    if (row.resolved === true) return false;
    const status = stringValue(row.status).toLowerCase();
    if (["closed", "resolved", "complete", "completed", "done", "verified"].includes(status)) return false;
    if (["open", "pending", "partial", "unresolved", "blocked"].includes(status)) return true;
    return isPendingPreparePlaceholder(row.id) || isPendingPreparePlaceholder(row.kind) || isPendingPreparePlaceholder(row.description) || isPendingPreparePlaceholder(row.note) || isPendingPreparePlaceholder(row.where);
  });
}

function isPendingPreparePlaceholder(value: unknown): boolean {
  const raw = stringValue(value).toLowerCase();
  if (!raw) return false;
  if (["pending", "pending resolution", "unresolved", "unknown", "tbd", "todo", "open"].includes(raw)) return true;
  if (raw.includes("n/a-source-only-pending")) return true;
  return raw.includes("pending resolution")
    || raw.includes("still being resolved")
    || raw.includes("to be resolved")
    || raw.includes("not yet resolved")
    || raw.includes("unresolved")
    || raw.includes("unverified placeholder");
}

interface PrepareGroundTruthSummary {
  kind: string;
  network: string;
  chainId?: number | undefined;
  address: string;
  role: string;
  block: string;
  sourceMatch: string;
  evidence: string;
  stagedComponent: string;
}

interface PrepareRealTargetSummary {
  reported: boolean;
  requiresConfirmation?: boolean | undefined;
  mode?: string;
  reason?: string;
  groundTruth: PrepareGroundTruthSummary[];
  guidance?: {
    required?: boolean | undefined;
    allowedNetworkActions: string;
    recommendedMethod: string;
    notRequiredReason: string;
  };
  issues: string[];
}

function summarizePrepareRealTarget(value: unknown): PrepareRealTargetSummary {
  const row = objectValue(value);
  if (!row) return { reported: false, groundTruth: [], issues: [] };
  const requiredRaw = row.requires_confirmation ?? row.requiresConfirmation ?? row.requires_real_target_confirmation;
  const requiresConfirmation = typeof requiredRaw === "boolean" ? requiredRaw : undefined;
  const issues: string[] = [];
  if (requiresConfirmation === undefined) issues.push("real_target.requires_confirmation is missing");
  const explicitMode = stringValue(row.mode);
  const mode = explicitMode || (requiresConfirmation === true ? "deployed" : requiresConfirmation === false ? "source-only" : "");
  if (!mode) issues.push("real_target.mode is missing");
  const guidance = objectValue(row.confirm_guidance) ?? objectValue(row.confirmGuidance);
  const guidanceText = stringValue(row.confirm_guidance ?? row.confirmGuidance);
  const methodFallback = stringValue(row.method ?? row.read_only_method ?? row.readOnlyMethod) || guidanceText;
  if (requiresConfirmation !== false && !guidance && !methodFallback) issues.push("real_target.confirm_guidance is missing");
  const ground = Array.isArray(row.ground_truth)
    ? row.ground_truth
    : Array.isArray(row.groundTruth)
      ? row.groundTruth
      : [];
  if (requiresConfirmation === true && ground.length === 0) issues.push("real_target requires confirmation but lists no ground truth");
  if (requiresConfirmation === false) {
    const reason = stringValue(row.not_required_reason ?? row.reason ?? guidance?.not_required_reason ?? guidance?.notRequiredReason);
    if (!reason) issues.push("real_target says confirmation is not required but gives no reason");
  }
  const groundTruth = ground.slice(0, 12).map((entry) => summarizePrepareGroundTruth(entry));
  for (const entry of groundTruth) {
    if (!entry.kind) issues.push(`${entry.role || "ground truth entry"} missing kind`);
    if (!entry.role) issues.push(`${entry.kind || "ground truth entry"} missing role`);
    if (!entry.sourceMatch) issues.push(`${entry.role || entry.kind || "ground truth entry"} missing source match`);
    if (entry.kind === "chain") {
      if (!entry.network) issues.push(`${entry.role || "chain entry"} missing network`);
      if (entry.chainId === undefined) issues.push(`${entry.role || "chain entry"} missing chain id`);
      if (!entry.address) issues.push(`${entry.role || "chain entry"} missing address`);
    }
  }
  const summary: PrepareRealTargetSummary = {
    reported: true,
    requiresConfirmation,
    mode,
    reason: stringValue(row.reason ?? row.not_required_reason ?? guidance?.not_required_reason ?? guidance?.notRequiredReason),
    groundTruth,
    issues: uniqueStrings(issues),
  };
  if (guidance) {
    summary.guidance = {
      required: typeof guidance.required === "boolean" ? guidance.required : undefined,
      allowedNetworkActions: stringValue(guidance.allowed_network_actions ?? guidance.allowedNetworkActions),
      recommendedMethod: stringValue(guidance.recommended_method ?? guidance.recommendedMethod),
      notRequiredReason: stringValue(guidance.not_required_reason ?? guidance.notRequiredReason),
    };
  } else if (methodFallback) {
    summary.guidance = {
      required: requiresConfirmation,
      allowedNetworkActions: "",
      recommendedMethod: methodFallback,
      notRequiredReason: "",
    };
  } else if (requiresConfirmation === false) {
    summary.guidance = {
      required: false,
      allowedNetworkActions: "none",
      recommendedMethod: "",
      notRequiredReason: summary.reason ?? "",
    };
  }
  return summary;
}

function summarizePrepareGroundTruth(value: unknown): PrepareGroundTruthSummary {
  const row = objectValue(value) ?? {};
  const chainIdValue = numericValue(row.chain_id ?? row.chainId);
  const network = stringValue(row.network);
  const address = stringValue(row.address);
  const kind = stringValue(row.kind) || (network && address ? "chain" : "");
  return {
    kind,
    network,
    chainId: chainIdValue === null ? undefined : chainIdValue,
    address,
    role: stringValue(row.role),
    block: stringValue(row.block ?? row.block_number ?? row.blockNumber),
    sourceMatch: stringValue(row.source_match ?? row.sourceMatch ?? row.deployment_match_status ?? row.deploymentMatchStatus),
    evidence: stringValue(row.evidence),
    stagedComponent: stringValue(row.staged_component ?? row.stagedComponent),
  };
}

function summarizePreparedWorkspace(workspaceDir: string): Record<string, unknown> {
  if (!existsSync(workspaceDir)) return { exists: false, files: 0, gitDirs: 0, sampleFiles: [] };
  const stack = [""];
  const sampleFiles: string[] = [];
  const fileLimit = 5000;
  let files = 0;
  let gitDirs = 0;
  while (stack.length && files < fileLimit) {
    const rel = stack.pop() ?? "";
    const abs = path.join(workspaceDir, rel);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (path.basename(abs) === ".git") {
        gitDirs += 1;
        continue;
      }
      let children: string[] = [];
      try {
        children = readdirSync(abs);
      } catch {
        children = [];
      }
      for (const child of children) stack.push(path.join(rel, child));
      continue;
    }
    files += 1;
    if (path.basename(rel) === "prepare_manifest.json") continue;
    if (sampleFiles.length < 12) sampleFiles.push(rel);
  }
  return { exists: true, files, fileLimit, filesTruncated: stack.length > 0, gitDirs, sampleFiles };
}

function describeAnswerFirewall(value: unknown, posture = ""): string {
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (text.toLowerCase() === "clean") return "clean";
    const notes = splitAnswerFirewallNotes(text);
    if (notes.length > 1 && notes.every(isCleanFirewallNote)) {
      return `clean · ${notes.length} guardrail note${notes.length === 1 ? "" : "s"}`;
    }
    return isCleanFirewallNote(text) ? `clean · ${text}` : text;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "clean (empty list)";
    const notes = value.map((entry) => stringValue(entry)).filter(Boolean);
    if (notes.every(isCleanFirewallNote)) return `clean · ${value.length} guardrail note${value.length === 1 ? "" : "s"}`;
    return notes.join("; ");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const posture = stringValue(obj.posture) || stringValue(obj.policy);
    const notes = stringValue(obj.notes);
    const excluded = Array.isArray(obj.excluded_material) ? obj.excluded_material.length : undefined;
    const parts = [posture, excluded !== undefined ? `${excluded} excluded material${excluded === 1 ? "" : "s"}` : "", notes].filter(Boolean);
    const text = parts.length ? parts.join(" · ") : "reported";
    return isCleanFirewallNote(text) ? `clean · ${text}` : text;
  }
  if (posture.trim().toLowerCase() === "blind") return "clean · blind posture";
  return "not reported";
}

function splitAnswerFirewallNotes(text: string): string[] {
  return text.split(";").map((part) => part.trim()).filter(Boolean);
}

function isNonBlockingAnswerFirewall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "not reported") return true;
  return isCleanFirewallNote(trimmed);
}

function isCleanFirewallNote(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower === "clean" || lower.startsWith("clean ")) return true;
  if (hasUnnegatedAnswerFirewallInclusion(lower)) return false;
  if (lower.includes("blind")) return true;
  if (/(^|[.;:]\s*)(no|not|never|without)\b[^.;:]*(material|vulnerability|exploit|poc|proof|incident|post-mortem|bug writeup|opened|staged|fetched|copied|included)/.test(lower)) return true;
  if (lower.includes("not fetched") || lower.includes("not staged") || lower.includes("not copied")) return true;
  if (lower.includes("skipped") || lower.includes("excluded") || lower.includes("removed")) return true;
  return false;
}

function hasUnnegatedAnswerFirewallInclusion(lower: string): boolean {
  return lower
    .split(/[.;]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      if (!part.includes("included")) return false;
      return !/\b(no|not|never|without)\b[^.;:]*\bincluded\b/.test(part)
        && !/\bincluded\b[^.;:]*\b(no|not|never|without)\b/.test(part);
    });
}

function summarizePrepareGaps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 8)
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const id = stringValue(obj.id ?? obj.kind);
        const desc = stringValue(obj.description ?? obj.note ?? obj.where);
        return [id, desc].filter(Boolean).join(": ");
      }
      return stringValue(entry);
    })
    .filter(Boolean);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function confirmableRunDir(row: Record<string, unknown>): string {
  const reportPath = stringValue(row.report_path);
  if (reportPath) return path.dirname(reportPath);
  return stringValue(row.run_dir);
}

function confirmFindingSeeds(store: MetadataStore, projectId: number, rows: Array<{ id?: unknown }>): Array<Record<string, unknown>> {
  const seeds: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    const finding = store.getFinding(id);
    if (!finding || Number(finding.project_id) !== projectId) continue;
    seeds.push(confirmFindingSeed(finding));
  }
  return seeds;
}

function confirmFindingSeed(row: Record<string, unknown>): Record<string, unknown> {
  const seed: Record<string, unknown> = {
    id: stringValue(row.finding_key) || `finding-${stringValue(row.id)}`,
    originId: numericValue(row.id) ?? undefined,
    title: stringValue(row.title),
    location: stringValue(row.location) || undefined,
    severity: stringValue(row.severity) || undefined,
    confirmationStatus: stringValue(row.status) || undefined,
    scopeId: stringValue(row.scope_id) || undefined,
    description: stringValue(row.description) || undefined,
    evidence: stringValue(row.evidence) || undefined,
    exploitSketch: stringValue(row.exploit_sketch) || undefined,
    fix: stringValue(row.fix) || undefined,
    confidence: numericValue(row.confidence) ?? undefined,
  };
  for (const key of Object.keys(seed)) if (seed[key] === undefined || seed[key] === "") delete seed[key];
  return seed;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed.map((entry) => stringValue(entry)).filter(Boolean) : [];
}

function discoveryBacklogKind(value: unknown): DiscoveryBacklogKind | undefined {
  return value === "coverage-gap" || value === "resource-request" || value === "followup-scope" ? value : undefined;
}

function discoveryBacklogStatus(value: unknown, allowAll: true): DiscoveryBacklogStatus | "all" | undefined;
function discoveryBacklogStatus(value: unknown, allowAll: false): DiscoveryBacklogStatus | undefined;
function discoveryBacklogStatus(value: unknown, allowAll: boolean): DiscoveryBacklogStatus | "all" | undefined {
  if (allowAll && value === "all") return "all";
  return value === "open" || value === "resolved" || value === "stale" || value === "ignored" ? value : undefined;
}

async function projectUpdate(c: Ctx): Promise<void> {
  const uuid = c.params.uuid ?? "";
  const project = c.store.getProjectByRef(uuid);
  if (!project) return sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
  const body = (await readBody(c.req)) as ProjectBody;
  const fields = projectFields(body);
  c.store.upsertProject({
    name: String(project.name),
    sourcePaths: fields.sourcePaths ?? ((safeParse(project.source_paths) as string[] | null) ?? []),
    buildRoot: fields.buildRoot ?? (typeof project.build_root === "string" ? project.build_root : undefined),
    corpusPaths: fields.corpusPaths ?? ((safeParse(project.corpus_paths) as string[] | null) ?? []),
    config: fields.config ?? ((safeParse(project.config_json) as Record<string, unknown> | null) ?? {}),
    providerId: fields.providerId ?? (typeof project.provider_id === "number" ? project.provider_id : undefined),
    daemonId: fields.daemonId ?? (typeof project.daemon_id === "number" ? project.daemon_id : undefined),
    dir: fields.dir ?? (typeof project.dir === "string" ? project.dir : undefined),
  });
  if (typeof body.archived === "boolean") c.store.setProjectArchived(uuid, body.archived);
  if (typeof body.pinned === "boolean") c.store.setProjectPinned(uuid, body.pinned);
  if (body.sortOrder === null || typeof body.sortOrder === "number") c.store.setProjectSortOrder(uuid, body.sortOrder);
  sendJson(c.res, 200, { ok: true });
}

function projectDelete(c: Ctx): void {
  const uuid = c.params.uuid ?? "";
  const removed = c.store.deleteProject(uuid);
  removed ? sendJson(c.res, 200, { ok: true, deleted: uuid }) : sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
}

async function projectOrderUpdate(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as { uuids?: unknown };
  if (!Array.isArray(body.uuids)) return sendJson(c.res, 400, { error: "uuids must be an array" });
  const uuids = uniqueStrings(body.uuids.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()));
  if (uuids.length === 0) return sendJson(c.res, 400, { error: "uuids must include at least one project uuid" });
  const changed = c.store.reorderProjects(uuids);
  sendJson(c.res, 200, { ok: true, changed });
}

async function scopeSetStatus(c: Ctx): Promise<void> {
  const uuid = c.params.uuid ?? "";
  const project = c.store.getProjectByRef(uuid);
  if (!project) return sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
  const body = (await readBody(c.req)) as { status?: string; prioritize?: boolean };
  const scopeId = c.params.scopeId ?? "";
  // Both branches must write the persisted inventory the AUDIT reads (history-dir scopes.json) AND
  // the UI's SQLite projection — the dig (resume/--remap) re-reads the inventory file, so a DB-only
  // change wouldn't reach it.
  const inventoryDir = projectHistoryDir({ outputDir: c.out, targetName: String(project.name) });
  const inventory = await loadScopeInventory(inventoryDir);
  const scope = inventory.find((s) => s.id === scopeId);

  // Prioritize: bump this scope's score above all others so the dig - which audits the highest-
  // scored un-audited scopes first — picks it next. Lets the operator hand-order the dig queue
  // (e.g. push the escape-hatch scope to the front) without touching its status.
  if (body.prioritize) {
    const top = inventory.reduce((m, s) => Math.max(m, Number(s.priority) || 0), 0);
    if (scope) { scope.priority = top + 1; await saveScopeInventory(inventoryDir, inventory); } // bump priority, leave score
    const ok = c.store.prioritizeScope(Number(project.id), scopeId);
    return sendJson(c.res, ok || scope ? 200 : 404, ok || scope ? { ok: true, scopeId, prioritized: true, priority: top + 1 } : { error: "no such scope" });
  }

  const status = body.status;
  if (status !== "pending" && status !== "audited" && status !== "deferred") {
    return sendJson(c.res, 400, { error: "status must be one of pending | audited | deferred, or pass prioritize:true" });
  }
  if (scope) {
    scope.status = status;
    await saveScopeInventory(inventoryDir, inventory, { forceStatusIds: [scopeId] });
  }
  c.store.setScopeStatus(Number(project.id), scopeId, status);
  sendJson(c.res, 200, { ok: true, scopeId, status });
}

async function backlogUpdate(c: Ctx): Promise<void> {
  const id = Number(c.params.id);
  if (!Number.isFinite(id) || id <= 0) return sendJson(c.res, 400, { error: "invalid backlog id" });
  const body = (await readBody(c.req)) as { status?: unknown };
  const status = discoveryBacklogStatus(body.status, false);
  if (!status) return sendJson(c.res, 400, { error: "status must be open, resolved, stale, or ignored" });
  const ok = c.store.setDiscoveryBacklogStatus(id, status);
  ok ? sendJson(c.res, 200, { ok: true, id, status }) : sendJson(c.res, 404, { error: "no such backlog row" });
}

// Queue a run for the project. The job lands in the DB queue; connected daemons are nudged
// to claim it. Returns the job id (the run id appears once a daemon starts it).
async function runLaunch(c: Ctx): Promise<void> {
  const uuid = c.params.uuid ?? "";
  const project = c.store.getProjectByRef(uuid);
  if (!project) return sendJson(c.res, 404, { error: `no project with uuid ${uuid}` });
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const profile = project.provider_id != null ? c.store.getProvider(Number(project.provider_id)) : undefined;
  const phaseProfiles = phaseProviderProfiles(project, c.store);
  const projectId = Number(project.id);
  const allRuns = c.store.listRuns(projectId);
  const runs = allRuns.slice(0, 50);
  const materialBoundary = latestPrepareRun(allRuns);
  const currentRuns = currentMaterialRuns(allRuns, materialBoundary);
  const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
  const currentResultRunIds = runIdSet(currentResultRuns(currentRuns, scopeBoundary));
  const scopeView = currentScopeView(c.store, projectId, currentRuns, undefined, scopeBoundary, !materialBoundary);
  const progress = scopeView.hasInventory ? scopeView.progress : emptyProgress();
  const spec = launchSpec(c.store, project, body, c.out, profile, progress, phaseProfiles);
  const currentMaterialFingerprint = currentResultRuns(currentRuns, scopeBoundary).map((run) => stringValue(run.material_fingerprint)).find(Boolean)
    || stringValue(materialBoundary?.material_fingerprint);
  if (currentMaterialFingerprint) spec.materialFingerprint = currentMaterialFingerprint;
  if (spec.verb === "run") {
    if (spec.sourcePaths.length > 0) {
      applyProjectSourceDefaults(spec, project);
      if (!spec.pipeline) spec.pipeline = false;
    } else {
      applyProjectPrepareDefaults(spec, project, runs);
      spec.pipeline = true;
      const prepared = latestPreparedWorkspace(runs);
      if (prepared) {
        spec.dir = undefined;
        spec.sourcePaths = [prepared.workspaceDir];
        spec.buildRoot = prepared.workspaceDir;
        spec.clue = undefined;
        if (!spec.scopeNote && prepared.scopeNote) spec.scopeNote = prepared.scopeNote;
      } else if (spec.clue && spec.sourcePaths.length === 0) {
        resetPipelineCoverageForUnknownInventory(spec);
      }
    }
  } else if (spec.verb === "prepare") {
    applyProjectPrepareDefaults(spec, project, runs);
  }
  const prepared = applyPreparedWorkspaceIfNeeded(spec, runs);
  if (!prepared.ok) return sendJson(c.res, 400, { error: prepared.error });
  const requiresRealTargetConfirmation = projectRequiresRealTargetConfirmation(project, runs);
  applyContestRunDefaults(spec, project, body, progress, c.store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation, runs);
  resumeInterruptedCoverageBatch(spec, progress, runs);
  promoteSettledPipelineCoverageBatch(spec, c.store, projectId, progress, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation);
  const nextActions = projectNextActions(c.store, projectId);
  if (nextActions.length > 0) {
    spec.nextActions = nextActions;
    applyNextActionRunDefaults(spec, nextActions, progress);
  }
  if ((spec.verb === "run" || spec.verb === "audit") && currentResultRunIds.size > 0) {
    spec.synthesisContext = reportableFindings(c.store.listFindings(projectId)
      .filter((finding) => rowBelongsToCurrentMaterial(finding, currentResultRunIds, materialBoundary)))
      .map((finding) => ({
        id: finding.id,
        canonical_key: finding.canonical_key,
        finding_key: finding.finding_key,
        title: finding.title,
        location: finding.location,
        status: finding.status,
        description: finding.description,
        exploit_sketch: finding.exploit_sketch,
      }));
  }
  if (
    spec.verb === "run"
    && spec.pipeline
    && spec.maxScopes === 0
    && pipelinePostAuditWorkPending(c.store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation)
  ) {
    // Continue the evidence tail directly. Starting runAudit with maxScopes=0 still copies and
    // initializes the target and records a misleading empty Dig run before Verify/Confirm/Report.
    spec.pipelineStart = "settle";
    spec.maxScopes = 0;
  }
  if (hasInvalidVerifyOriginId(spec.verifyFindings)) {
    return sendJson(c.res, 400, { error: "verifyFindings originId/origin_id must be a positive integer" });
  }
  const materialDrift = verifyMaterialDrift(c.store, projectId, spec.verifyFindings, body.allowMaterialDrift === true);
  if (materialDrift) return sendJson(c.res, 409, materialDrift);
  if (spec.verb === "run" && spec.pipeline && pipelineRoundComplete(spec, progress, c.store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation)) {
    return sendJson(c.res, 409, {
      error: "Current pipeline round is complete. Pass continueCoverage:true, choose a coverage mode, or use Dig pending scopes to start another scope batch.",
      roundComplete: true,
      continueCoverageRequired: true,
      coverageMode: spec.coverageMode,
      coverageTarget: spec.coverageTarget,
      progress,
    });
  }
  if (coverageTargetReached(spec) && !(spec.verb === "run" && spec.pipeline)) {
    const target = spec.coverageTarget;
    const denominator = target ? Math.min(target, progress.total || target) : progress.total;
    const nextAction = spec.coverageMode === "full" ? "Select specific scopes to re-audit." : "Choose Full, Custom, or select specific scopes to continue.";
    return sendJson(c.res, 409, {
      error: `${coverageModeLabel(spec.coverageMode)} coverage is already complete for this project (${progress.audited}/${denominator} audited scopes). ${nextAction}`,
      coverageMode: spec.coverageMode,
      coverageTarget: spec.coverageTarget,
      progress,
    });
  }
  // Confirm is finding-grained + resumable, but its distinct-bug consolidation must see the
  // full current confirmed-finding context. The pending rows decide whether there is work to do;
  // the context rows decide what the confirm agent can consolidate against across batches.
  if (spec.verb === "confirm" && !spec.inputRunDir && !(spec.inputRunDirs && spec.inputRunDirs.length > 0)) {
    const findingIds = selectedFindingIds(body);
    if (findingIds.length > 0) {
      const selected = findingIds.map((id) => ({ id, row: c.store.getConfirmable(Number(project.id), id) }));
      const trackingBlocked = selected
        .filter((entry) => findingTrackingBlocksProgress(c.store.getFinding(entry.id)))
        .map((entry) => entry.id);
      if (trackingBlocked.length > 0) {
        return sendJson(c.res, 400, { error: `finding ${trackingBlocked.join(", ")} is not independent work; use its canonical finding instead` });
      }
      const reviewBlocked = selected
        .filter((entry) => findingIndependentReviewBlocksProgress(c.store.getFinding(entry.id)))
        .map((entry) => entry.id);
      if (reviewBlocked.length > 0) {
        return sendJson(c.res, 400, { error: `finding ${reviewBlocked.join(", ")} did not pass independent review` });
      }
      const missing = selected.filter((entry) => !entry.row || !confirmableRunDir(entry.row as unknown as Record<string, unknown>)).map((entry) => entry.id);
      if (missing.length > 0) return sendJson(c.res, 400, { error: `finding ${missing.join(", ")} is not pending confirm for this project, or has no source run dir` });
      const stale = selected.filter((entry) => entry.row && !rowBelongsToCurrentMaterial(entry.row as unknown as Record<string, unknown>, currentResultRunIds, materialBoundary)).map((entry) => entry.id);
      if (stale.length > 0 && body.allowMaterialDrift !== true) {
        return sendJson(c.res, 409, {
          error: `finding ${stale.join(", ")} belongs to an older prepared material snapshot. Re-run Map/Dig on the current prepared source, or pass allowMaterialDrift:true only to inspect historical results.`,
          materialDrift: true,
          staleFindings: stale,
          material: materialSummary(allRuns, materialBoundary),
        });
      }
      const rows = selected.flatMap((entry) => entry.row ? [entry.row] : []);
      spec.inputRunDirs = [...new Set(rows.map((row) => confirmableRunDir(row as unknown as Record<string, unknown>)).filter(Boolean))];
      spec.inputRunDir = spec.inputRunDirs[0];
      spec.confirmKeys = rows.flatMap((row) => confirmSelectorsForFinding(row as unknown as { id?: unknown; finding_key?: unknown }));
      spec.confirmFindings = confirmFindingSeeds(c.store, Number(project.id), rows);
    } else {
      const currentDecisions = currentConfirmDecisions(c.store.listConfirmDecisions(Number(project.id)).filter((row) => rowBelongsToCurrentMaterial(row, currentResultRunIds, materialBoundary)));
      const pending = confirmWorkRows(c.store, Number(project.id), currentResultRunIds, materialBoundary, currentDecisions);
      if (pending.length === 0) return sendJson(c.res, 400, { error: "nothing to confirm — every audit-confirmed finding already has a real-target decision (use --fresh to redo)" });
      const context = c.store.confirmableContext(Number(project.id))
        .filter((p) => !findingTrackingBlocksProgress(c.store.getFinding(Number(p.id))))
        .filter((p) => !findingIndependentReviewBlocksProgress(p)
          || (p.refutation_status === "conflict" && c.store.hasFindingPhaseRetry(Number(project.id), "finding", Number(p.id), "confirm")))
        .filter((p) => confirmableRunDir(p as unknown as Record<string, unknown>))
        .filter((p) => rowBelongsToCurrentMaterial(p as unknown as Record<string, unknown>, currentResultRunIds, materialBoundary));
      const rows = context.length > 0 ? context : pending;
      spec.inputRunDirs = [...new Set(rows.map((p) => confirmableRunDir(p as unknown as Record<string, unknown>)).filter(Boolean))];
      spec.inputRunDir = spec.inputRunDirs[0];
      spec.confirmKeys = rows.flatMap((p) => confirmSelectorsForFinding(p as unknown as { id?: unknown; finding_key?: unknown }));
      spec.confirmFindings = confirmFindingSeeds(c.store, Number(project.id), rows);
      spec.confirmSettledRows = confirmSettledRows(currentDecisions);
    }
  }
  if (spec.verb === "report") {
    const selected = selectedFindingIds(body);
    const reports = reportWorklist(c.store, Number(project.id), selected, currentResultRunIds, materialBoundary, projectRequiresRealTargetConfirmation(project, runs), body.regenerateReports === true);
    if (reports.error) return sendJson(c.res, 400, { error: reports.error });
    spec.reportFindings = reports.findings;
  }
  const daemonId = project.daemon_id != null ? Number(project.daemon_id) : undefined;
  const allowOfflineQueue = body.allowOfflineQueue === true;
  if (daemonId !== undefined && !allowOfflineQueue && !c.plane.hasDaemon(daemonId)) {
    const daemon = c.store.getDaemon(daemonId);
    const label = daemon?.name ? String(daemon.name) : `daemon-${daemonId}`;
    return sendJson(c.res, 409, {
      error: `${label} is not connected. Start that daemon, select an online daemon for this project, or pass allowOfflineQueue:true to queue for an offline remote executor.`,
      daemonId,
      daemonOnline: false,
    });
  }
  if (spec.verb === "prepare" || (spec.verb === "run" && spec.pipeline && spec.clue) || (isScopeInventoryVerb(spec.verb) && !scopeView.hasInventory)) await resetCurrentScopeProjection(c, project);
  const jobId = c.store.enqueueJob(spec.target, spec, daemonId);
  c.plane.nudge();
  sendJson(c.res, 200, { jobId, verb: spec.verb, queued: true, daemons: c.plane.daemonCount(daemonId), daemonId });
}

function applyProjectPrepareDefaults(spec: LaunchSpec, project: Record<string, unknown>, runs: Array<Record<string, unknown>>): void {
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  const previousPrepare = latestPrepareSummary(runs);
  if (!spec.clue) {
    spec.clue = stringValue(cfg.prepareClue) || stringValue(cfg.projectIntent) || stringValue(previousPrepare?.clue) || stringValue(project.name) || stringValue(project.dir);
  }
  if (!spec.posture) {
    spec.posture = stringValue(previousPrepare?.posture) || "blind";
  }
  if (spec.matchDeployed === undefined) spec.matchDeployed = true;
}

function applyProjectSourceDefaults(spec: LaunchSpec, project: Record<string, unknown>): void {
  if (spec.scopeNote) return;
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  spec.scopeNote = stringValue(cfg.scopeNote) || stringValue(cfg.projectIntent) || stringValue(cfg.prepareClue);
}

function resetPipelineCoverageForUnknownInventory(spec: LaunchSpec): void {
  if (spec.coverageMode === "focused") {
    spec.coverageTarget = 10;
    spec.maxScopes = 10;
  } else if (spec.coverageMode === "standard") {
    spec.coverageTarget = 30;
    spec.maxScopes = 30;
  } else if (spec.coverageMode === "half") {
    spec.coverageTarget = undefined;
    spec.maxScopes = 30;
  } else if (spec.coverageMode === "full") {
    spec.coverageTarget = undefined;
    spec.maxScopes = undefined;
  }
}

function applyContestRunDefaults(
  spec: LaunchSpec,
  project: Record<string, unknown>,
  body: Record<string, unknown>,
  progress: Coverage,
  store: MetadataStore,
  projectId: number,
  currentResultRunIds: Set<number>,
  materialBoundary: Record<string, unknown> | undefined,
  requiresRealTargetConfirmation: boolean,
  runs: Array<Record<string, unknown>>,
): void {
  if (!isBugBountyContestProject(project)) return;
  if (spec.digConcurrency === undefined && !runBodyHasConfigOverride(body, "digConcurrency")) {
    spec.digConcurrency = contestDigConcurrency(project);
  }
  if (spec.verb !== "run" || !spec.pipeline) return;
  if (spec.scope || spec.region || spec.verifyFindings !== undefined) return;
  if (runBodyHasConfigOverride(body, "scopeCoverageMode") || runBodyHasConfigOverride(body, "maxScopes")) return;

  const pendingPostAudit = pipelinePostAuditWorkPending(store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation);
  const pending = Math.max(0, Math.floor(progress.pending));
  const interrupted = latestInterruptedCoverageBatchRemainder(runs);
  const batch = contestBatchScopes(project);

  spec.coverageMode = "custom";
  spec.coverageTarget = undefined;

  if (interrupted > 0 && pending > 0) {
    spec.maxScopes = Math.min(pending, interrupted);
    spec.continueCoverage = true;
    return;
  }
  if (pendingPostAudit) {
    spec.maxScopes = 0;
    return;
  }
  if (pending > 0) {
    spec.maxScopes = Math.min(batch, pending);
    spec.continueCoverage = true;
    return;
  }

  const hasInventory = Math.max(0, Math.floor(progress.total)) > 0;
  if (hasInventory && contestAppendMapWhenExhausted(project)) spec.appendMap = true;
  spec.maxScopes = hasInventory && !spec.appendMap ? 0 : batch;
  spec.continueCoverage = true;
}

function runBodyHasConfigOverride(body: Record<string, unknown>, key: string): boolean {
  if (body[key] !== undefined) return true;
  const overrides = objectValue(body.overrides);
  const config = objectValue(overrides?.config);
  return config?.[key] !== undefined;
}

function resumeInterruptedCoverageBatch(spec: LaunchSpec, progress: Coverage, runs: Array<Record<string, unknown>>): void {
  if (spec.verb !== "run" && spec.verb !== "audit") return;
  if (spec.scope || spec.region || spec.verifyFindings !== undefined) return;
  if (spec.maxScopes !== 0) return;
  const pending = Math.max(0, Math.floor(progress.pending));
  if (pending <= 0) return;
  const remaining = latestInterruptedCoverageBatchRemainder(runs);
  if (remaining <= 0) return;
  spec.maxScopes = Math.min(pending, remaining);
}

function latestInterruptedCoverageBatchRemainder(runs: Array<Record<string, unknown>>): number {
  const ordered = [...runs].sort((a, b) => numberValue(b.id) - numberValue(a.id));
  for (const run of ordered) {
    const kind = stringValue(run.kind);
    if (kind !== "run" && kind !== "audit") continue;
    const status = stringValue(run.status);
    const target = Math.max(0, Math.floor(numberValue(run.run_scopes_target)));
    const done = Math.max(0, Math.floor(numberValue(run.run_scopes_done)));
    if (status === "done" && done > 0) return 0;
    if (status !== "killed" && status !== "error") continue;
    if (target > 0 && done < target) return target - done;
  }
  return 0;
}

function promoteSettledPipelineCoverageBatch(
  spec: LaunchSpec,
  store: MetadataStore,
  projectId: number,
  progress: Coverage,
  currentResultRunIds: Set<number>,
  materialBoundary: Record<string, unknown> | undefined,
  requiresRealTargetConfirmation: boolean,
): void {
  if (spec.verb !== "run" || !spec.pipeline) return;
  if (spec.coverageMode !== "standard" || spec.coverageTarget !== 30 || spec.maxScopes !== 0) return;
  if (!spec.continueCoverage) return;
  if (progress.pending <= 0) return;
  if (pipelinePostAuditWorkPending(store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation)) return;
  spec.maxScopes = Math.min(30, progress.pending);
}

function pipelineRoundComplete(
  spec: LaunchSpec,
  _progress: Coverage,
  store: MetadataStore,
  projectId: number,
  currentResultRunIds: Set<number>,
  materialBoundary: Record<string, unknown> | undefined,
  requiresRealTargetConfirmation: boolean,
): boolean {
  if ((spec.nextActions?.length ?? 0) > 0) return false;
  if (spec.continueCoverage) return false;
  if (spec.maxScopes !== 0) return false;
  if (!coverageTargetReached(spec)) return false;
  if (pipelinePostAuditWorkPending(store, projectId, currentResultRunIds, materialBoundary, requiresRealTargetConfirmation)) return false;
  return true;
}

function projectNextActions(store: MetadataStore, projectId: number): NonNullable<LaunchSpec["nextActions"]> {
  const mappedScopeIds = new Set(store.listScopes(projectId).map((scope) => stringValue(scope.scope_id)).filter(Boolean));
  return store.listDiscoveryBacklog(projectId, { status: "open", limit: 50 })
    .map((row) => discoveryBacklogDisplayRow(row, mappedScopeIds))
    .map((row) => {
      const out: NonNullable<LaunchSpec["nextActions"]>[number] = {
        kind: stringValue(row.kind) || "unknown",
      };
      const id = numberValue(row.id);
      if (Number.isFinite(id) && id > 0) out.id = id;
      const scopeId = stringValue(row.scope_id) || stringValue((row.payload as Record<string, unknown> | undefined)?.scope_id ?? (row.payload as Record<string, unknown> | undefined)?.scopeId);
      const actionability = stringValue(row.actionability);
      const recommendedAction = stringValue(row.recommended_action);
      const title = stringValue(row.title);
      const summary = stringValue(row.summary);
      const reason = stringValue(row.action_reason);
      if (actionability) out.actionability = actionability;
      if (recommendedAction) out.recommendedAction = recommendedAction;
      if (title) out.title = title;
      if (summary) out.summary = summary;
      if (scopeId) out.scopeId = scopeId;
      if (reason) out.reason = reason;
      return out;
    });
}

function applyNextActionRunDefaults(spec: LaunchSpec, nextActions: NonNullable<LaunchSpec["nextActions"]>, progress: Coverage): void {
  if (spec.verb !== "run" || !spec.pipeline || nextActions.length === 0) return;
  const pending = Math.max(0, Math.floor(progress.pending));
  const wantsMapExpansion = nextActions.some((action) => action.recommendedAction === "expand-map");
  if (wantsMapExpansion && !spec.remap && !spec.appendMap) {
    spec.appendMap = true;
    if (spec.maxScopes === 0) spec.maxScopes = undefined;
    spec.continueCoverage = true;
  }
  const wantsSetupOrRouting = nextActions.some((action) => action.actionability === "agent-resource" || action.actionability === "agent-review");
  if (wantsSetupOrRouting && pending === 0 && !spec.appendMap && spec.maxScopes === 0) {
    spec.quick = true;
    spec.maxScopes = undefined;
    spec.continueCoverage = true;
  }
}

function pipelinePostAuditWorkPending(
  store: MetadataStore,
  projectId: number,
  currentResultRunIds: Set<number>,
  materialBoundary: Record<string, unknown> | undefined,
  requiresRealTargetConfirmation: boolean,
): boolean {
  if (verifyWorklist(store, projectId, currentResultRunIds, materialBoundary).length > 0) return true;
  if (requiresRealTargetConfirmation) {
    const currentDecisions = currentConfirmDecisions(store.listConfirmDecisions(projectId).filter((row) => rowBelongsToCurrentMaterial(row, currentResultRunIds, materialBoundary)));
    const pending = confirmWorkRows(store, projectId, currentResultRunIds, materialBoundary, currentDecisions);
    if (pending.length > 0) return true;
  }
  const reports = reportWorklist(store, projectId, [], currentResultRunIds, materialBoundary, requiresRealTargetConfirmation);
  return Array.isArray(reports.findings) && reports.findings.length > 0;
}

function confirmWorkRows(
  store: MetadataStore,
  projectId: number,
  currentResultRunIds: Set<number>,
  materialBoundary: Record<string, unknown> | undefined,
  currentDecisions: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const settledKeys = confirmDecisionKeySet(currentDecisions.filter((row) => !needsSubmissionReadinessWork(row)));
  const pending = store.pendingConfirmable(projectId)
    .filter((row) => !findingTrackingBlocksProgress(store.getFinding(Number(row.id))))
    .filter((row) => !findingIndependentReviewBlocksProgress(store.getFinding(Number(row.id))))
    .filter((row) => confirmableRunDir(row as unknown as Record<string, unknown>))
    .filter((row) => rowBelongsToCurrentMaterial(row as unknown as Record<string, unknown>, currentResultRunIds, materialBoundary))
    .filter((row) => !findingRowCoveredByDecision(row as unknown as Record<string, unknown>, settledKeys));
  const readinessKeys = new Set(currentDecisions.filter((row) => needsSubmissionReadinessWork(row)).flatMap(confirmDecisionMemberKeys));
  const readiness = readinessKeys.size === 0 ? [] : store.confirmableContext(projectId)
    .filter((row) => !findingTrackingBlocksProgress(store.getFinding(Number(row.id))))
    .filter((row) => !findingIndependentReviewBlocksProgress(row))
    .filter((row) => confirmableRunDir(row as unknown as Record<string, unknown>))
    .filter((row) => rowBelongsToCurrentMaterial(row as unknown as Record<string, unknown>, currentResultRunIds, materialBoundary))
    .filter((row) => {
      const key = stringValue((row as Record<string, unknown>).finding_key).toLowerCase();
      return Boolean(key && readinessKeys.has(key));
    });
  const conflictRetries = store.confirmableContext(projectId)
    .filter((row) => row.refutation_status === "conflict")
    .filter((row) => !findingTrackingBlocksProgress(store.getFinding(Number(row.id))))
    .filter((row) => store.hasFindingPhaseRetry(projectId, "finding", Number(row.id), "confirm"))
    .filter((row) => confirmableRunDir(row as unknown as Record<string, unknown>))
    .filter((row) => rowBelongsToCurrentMaterial(row as unknown as Record<string, unknown>, currentResultRunIds, materialBoundary));
  return uniqueRowsByFindingKey([...pending, ...readiness, ...conflictRetries]).filter((row) => {
    const inputFingerprint = findingPhaseFingerprint(store, row, "confirm", materialBoundary);
    return store.phaseEligible(projectId, "finding", Number(row.id), "confirm", inputFingerprint);
  });
}

function uniqueRowsByFindingKey(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = stringValue(row.finding_key).toLowerCase() || String(row.id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function selectedFindingIds(body: Record<string, unknown>): number[] {
  const ids = new Set<number>();
  if (typeof body.findingId === "number" && Number.isInteger(body.findingId)) ids.add(body.findingId);
  if (Array.isArray(body.findingIds)) {
    for (const id of body.findingIds) {
      if (typeof id === "number" && Number.isInteger(id)) ids.add(id);
    }
  }
  return [...ids];
}

async function resetCurrentScopeProjection(c: Ctx, project: Record<string, unknown>): Promise<void> {
  const projectId = Number(project.id);
  c.store.clearScopes(projectId);
  const inventoryDir = projectHistoryDir({ outputDir: c.out, targetName: String(project.name) });
  try {
    await saveScopeInventory(inventoryDir, [], { replace: true });
  } catch {
    // The DB projection is the API source of truth; a missing history dir should not block prepare.
  }
}

function verifyMaterialDrift(store: MetadataStore, projectId: number, verifyFindings: unknown, allowOverride: boolean): Record<string, unknown> | null {
  if (allowOverride || verifyFindings === undefined) return null;
  const ids = extractVerifyOriginIds(verifyFindings);
  if (ids.length === 0) return null;
  const missing: number[] = [];
  const drifted: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const finding = store.getFinding(id);
    if (!finding || Number(finding.project_id) !== projectId) {
      missing.push(id);
      continue;
    }
    const runId = Number(finding.run_id);
    if (!Number.isFinite(runId)) continue;
    const newerPrepare = store.latestPrepareAfterRun(projectId, runId);
    if (!newerPrepare || !isSuccessfulPrepareRun(newerPrepare)) continue;
    const findingRun = store.getRun(runId);
    const findingFingerprint = stringValue(findingRun?.material_fingerprint);
    const prepareFingerprint = stringValue(newerPrepare.material_fingerprint);
    if (findingFingerprint && prepareFingerprint && findingFingerprint === prepareFingerprint) continue;
    drifted.push({
      findingId: id,
      title: stringValue(finding.title),
      findingRunId: runId,
      findingRunStartedAt: store.getRun(runId)?.started_at ?? null,
      prepareRunId: newerPrepare.id,
      prepareStartedAt: newerPrepare.started_at,
    });
  }
  if (missing.length > 0) {
    return {
      error: `verifyFindings references finding ${missing.join(", ")} outside this project or no longer present`,
      missingFindings: missing,
    };
  }
  if (drifted.length === 0) return null;
  return {
    error: "Cannot verify selected findings against the current project materials because a newer Prepare run exists after those findings were produced. Re-run Map/Dig on the current prepared materials, or pass allowMaterialDrift:true only if you intentionally want to verify old findings against the current workspace.",
    materialDrift: true,
    findings: drifted,
  };
}

function extractVerifyOriginIds(input: unknown): number[] {
  const out = new Set<number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    for (const key of ["originId", "origin_id", "id"]) {
      const id = positiveIntegerId(row[key]);
      if (id !== undefined) out.add(id);
    }
  };
  visit(input);
  return [...out];
}

function hasInvalidVerifyOriginId(input: unknown): boolean {
  if (Array.isArray(input)) return input.some(hasInvalidVerifyOriginId);
  if (!input || typeof input !== "object") return false;
  const row = input as Record<string, unknown>;
  for (const key of ["originId", "origin_id"]) {
    if (key in row && positiveIntegerId(row[key]) === undefined) return true;
  }
  return false;
}

function reportWorklist(
  store: MetadataStore,
  projectId: number,
  selectedIds: number[] = [],
  currentRunIds?: Set<number>,
  materialBoundary?: Record<string, unknown>,
  requiresRealTargetConfirmation = true,
  includeExistingReports = false,
): { findings: ReportFindingSpec[]; error?: undefined } | { findings?: undefined; error: string } {
  if (requiresRealTargetConfirmation) {
    return decisionReportWorklist(store, projectId, selectedIds, currentRunIds, materialBoundary, includeExistingReports);
  }
  const selected = selectedIds.length ? new Set(selectedIds) : undefined;
  const allRows = reportableFindings(store.listFindings(projectId));
  const rows = allRows.filter((row) => {
    if (selected && !selected.has(Number(row.id))) return false;
    if (findingTrackingBlocksProgress(row)) return false;
    if (findingIndependentReviewBlocksProgress(row)) return false;
    if (!selected && !includeExistingReports && rowHasFormalReport(row)) return false;
    if (!rowBelongsToCurrentMaterial(row, currentRunIds ?? new Set(), materialBoundary)) return false;
    if (!isExecutionConfirmedFindingStatus(String(row.status ?? "").toLowerCase())) return false;
    return Boolean(selected) || store.phaseEligible(projectId, "finding", Number(row.id), "report", findingPhaseFingerprint(store, row, "report", materialBoundary));
  });
  if (selected && rows.length !== selected.size) {
    const found = new Set(rows.map((row) => Number(row.id)));
    const missing = [...selected].filter((id) => !found.has(id));
    const duplicates = missing.filter((id) => allRows.some((row) => Number(row.id) === id && String(row.tracking_status ?? "") === "duplicate"));
    if (duplicates.length > 0) {
      return { error: `finding ${duplicates.join(", ")} is marked duplicate; report its canonical finding instead` };
    }
    const blocked = missing.filter((id) => allRows.some((row) => Number(row.id) === id && findingIndependentReviewBlocksProgress(row)));
    if (blocked.length > 0) {
      return { error: `finding ${blocked.join(", ")} did not pass independent review` };
    }
    const reason = "is not locally execution-confirmed for this source-only target";
    return { error: `finding ${missing.join(", ")} ${reason}` };
  }
  if (rows.length === 0) {
    return { error: "no locally execution-confirmed source-only findings are missing formal reports" };
  }
  return {
    findings: rows.map((row) => ({
      findingId: Number(row.id),
      unit: "finding",
      findingKey: String(row.finding_key ?? ""),
      evidenceMode: "source-only-local-confirmed",
      title: stringValue(row.title),
      location: stringValue(row.location) || undefined,
      severity: stringValue(row.severity) || undefined,
      status: stringValue(row.status) || undefined,
      confirmStatus: stringValue(row.confirm_status) || undefined,
      description: stringValue(row.description) || undefined,
      evidence: stringValue(row.evidence) || undefined,
      exploitSketch: stringValue(row.exploit_sketch) || undefined,
      fix: stringValue(row.fix) || undefined,
      confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : undefined,
      decisions: [],
      phaseInputFingerprint: findingPhaseFingerprint(store, row, "report", materialBoundary),
    })),
  };
}

function decisionReportWorklist(
  store: MetadataStore,
  projectId: number,
  selectedIds: number[] = [],
  currentRunIds?: Set<number>,
  materialBoundary?: Record<string, unknown>,
  includeExistingReports = false,
): { findings: ReportFindingSpec[]; error?: undefined } | { findings?: undefined; error: string } {
  const selected = selectedIds.length ? new Set(selectedIds) : undefined;
  const currentIds = currentRunIds ?? new Set<number>();
  const allFindings = reportableFindings(store.listFindings(projectId).filter((row) => rowBelongsToCurrentMaterial(row, currentIds, materialBoundary)));
  const findingsById = new Map(allFindings.map((row) => [Number(row.id), row]));
  const findingsByKey = new Map<string, Record<string, unknown>>();
  for (const row of allFindings) {
    const key = stringValue(row.finding_key).toLowerCase();
    if (key) findingsByKey.set(key, row);
  }
  const selectedCovered = new Set<number>();
  const decisions = currentConfirmDecisions(store.listConfirmDecisions(projectId).filter((row) => rowBelongsToCurrentMaterial(row, currentIds, materialBoundary)))
    .filter((decision) => isSubmissionReadyDecision(decision, { requireImpactInventory: false }))
    .filter((decision) => isRealTargetDecisionEvidence(stringValue(decision.evidence_level)))
    .filter((decision) => decisionLinkedFindingRows(decision, findingsByKey)
      .every((finding) => !findingIndependentReviewBlocksProgress(finding)))
    .filter((decision) => selected || includeExistingReports || !decisionHasFormalReport(decision))
    .filter((decision) => Boolean(selected) || store.phaseEligible(projectId, "decision", Number(decision.id), "report", decisionReportFingerprint(store, decision, materialBoundary)))
    .filter((decision) => {
      if (!selected) return true;
      const linked = decisionLinkedFindingRows(decision, findingsByKey).filter((finding) => !isIgnoredFinding(finding));
      const matched = linked.filter((finding) => selected.has(Number(finding.id)));
      for (const finding of matched) selectedCovered.add(Number(finding.id));
      return matched.length > 0;
    });
  if (selected) {
    const missing = [...selected].filter((id) => !selectedCovered.has(id));
    if (missing.length > 0) {
      const conflicted = missing.filter((id) => findingsById.get(id)?.refutation_status === "conflict");
      if (conflicted.length > 0) {
        const subject = conflicted.length === 1 ? "finding" : "findings";
        const verb = conflicted.length === 1 ? "has" : "have";
        return { error: `${subject} ${conflicted.join(", ")} ${verb} an unresolved local/real-target evidence conflict` };
      }
      const reviewBlocked = missing.filter((id) => findingIndependentReviewBlocksProgress(findingsById.get(id)));
      if (reviewBlocked.length > 0) {
        return { error: `finding ${reviewBlocked.join(", ")} did not pass independent review` };
      }
      const unknown = missing.filter((id) => !findingsById.has(id));
      const suffix = unknown.length > 0 ? " is not a current finding for this project" : " is not linked to a submission-ready decision";
      return { error: `finding ${missing.join(", ")}${suffix}` };
    }
  }
  if (decisions.length === 0) return { error: "no submission-ready decisions are missing formal reports" };

  return {
    findings: decisions.map((decision) => {
      const linkedFindings = decisionLinkedFindingRows(decision, findingsByKey).filter((finding) => !isIgnoredFinding(finding));
      const primary = linkedFindings[0];
      const decisionId = Number(decision.id);
      const severity = stringValue(decision.severity) || maxSeverityFromRows(linkedFindings) || undefined;
      const evidenceLevel = stringValue(decision.evidence_level) || "unknown";
      return {
        unit: "decision",
        decisionId,
        findingId: primary ? Number(primary.id) : undefined,
        findingKey: `decision-${decisionId}`,
        reportKey: `decision-${decisionId}`,
        evidenceMode: isRealTargetDecisionEvidence(evidenceLevel) ? "real-target-reproduced" : "source-only-local-confirmed",
        evidenceLevel,
        submissionConfidence: stringValue(decision.submission_confidence) || undefined,
        title: stringValue(decision.bug),
        location: primary ? stringValue(primary.location) || undefined : undefined,
        severity,
        status: primary ? stringValue(primary.status) || undefined : undefined,
        confirmStatus: "reproduced",
        description: linkedFindings.map((finding) => stringValue(finding.description)).filter(Boolean).join("\n\n") || undefined,
        evidence: linkedFindings.map((finding) => stringValue(finding.evidence)).filter(Boolean).join("\n\n") || undefined,
        exploitSketch: linkedFindings.map((finding) => stringValue(finding.exploit_sketch)).filter(Boolean).join("\n\n") || undefined,
        fix: linkedFindings.map((finding) => stringValue(finding.fix)).filter(Boolean).join("\n\n") || stringValue(decision.distinct_fix) || undefined,
        confidence: maxConfidenceFromRows(linkedFindings),
        decisions: [confirmDecisionDisplayRow(decision)],
        linkedFindings: linkedFindings.map(reportLinkedFindingRow),
        phaseInputFingerprint: decisionReportFingerprint(store, decision, materialBoundary),
      };
    }),
  };
}

function decisionReportFingerprint(store: MetadataStore, decision: Record<string, unknown>, boundary?: Record<string, unknown>): string {
  const runId = Number(decision.run_id);
  const run = Number.isFinite(runId) ? store.getRun(runId) : undefined;
  return phaseInputFingerprint({
    phase: "report",
    material: run?.material_fingerprint ?? boundary?.material_fingerprint ?? null,
    decisionId: Number(decision.id),
    reproduced: decision.reproduced,
    recommendation: decision.recommendation,
    evidenceLevel: decision.evidence_level,
    submissionConfidence: decision.submission_confidence,
    members: decision.members_json,
  });
}

function decisionLinkedFindingRows(decision: Record<string, unknown>, findingsByKey: Map<string, Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  for (const key of confirmDecisionMemberKeys(decision)) {
    const row = findingsByKey.get(key);
    if (!row) continue;
    const id = Number(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function isRealTargetDecisionEvidence(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "real-target-reproduced" || normalized === "fork-reproduced" || normalized === "local-fork-reproduced";
}

function maxSeverityFromRows(rows: Array<Record<string, unknown>>): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const row of rows) {
    const severity = stringValue(row.severity).toLowerCase();
    const severityRank = rank(FINDING_SEVERITY_RANK, severity);
    if (severityRank <= bestRank) continue;
    best = severity;
    bestRank = severityRank;
  }
  return best;
}

function maxConfidenceFromRows(rows: Array<Record<string, unknown>>): number | undefined {
  let best: number | undefined;
  for (const row of rows) {
    const value = Number(row.confidence);
    if (!Number.isFinite(value)) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

function reportLinkedFindingRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    finding_key: row.finding_key,
    title: cleanFindingTitle(row.title),
    location: row.location,
    severity: row.severity,
    status: row.status,
    confirm_status: row.confirm_status,
    description: row.description,
    evidence: row.evidence,
    exploit_sketch: row.exploit_sketch,
    fix: row.fix,
    confidence: row.confidence,
    has_report: rowHasFormalReport(row),
  };
}

function latestPrepareRequiresRealTargetConfirmation(runs: Array<Record<string, unknown>>): boolean {
  const run = runs.find((entry) => isSuccessfulPrepareRun(entry) && typeof entry.run_dir === "string");
  const manifest = run ? readPrepareManifestObject(run) : undefined;
  const realTarget = summarizePrepareRealTarget(manifest?.real_target ?? manifest?.realTarget);
  return !(realTarget.reported && realTarget.requiresConfirmation === false);
}

function projectConfigRecord(project: Record<string, unknown>): Record<string, unknown> {
  const cfg = safeParse(project.config_json);
  return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg as Record<string, unknown> : {};
}

function bugBountyContestEngagement(cfg: Record<string, unknown>): Record<string, unknown> | undefined {
  const engagement = objectValue(cfg.engagement);
  const kind = stringValue(engagement?.kind ?? engagement?.type ?? cfg.engagementKind ?? cfg.projectKind);
  if (kind !== BUG_BOUNTY_CONTEST_KIND && kind !== "contest") return undefined;
  return engagement ?? { kind: BUG_BOUNTY_CONTEST_KIND };
}

function contestStrategy(cfg: Record<string, unknown>): Record<string, unknown> {
  const engagement = bugBountyContestEngagement(cfg);
  return objectValue(engagement?.strategy) ?? engagement ?? {};
}

function contestPositiveInt(cfg: Record<string, unknown>, keys: string[], fallback: number): number {
  const engagement = bugBountyContestEngagement(cfg);
  const strategy = contestStrategy(cfg);
  for (const source of [strategy, engagement ?? {}]) {
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
  }
  return fallback;
}

function contestBoolean(cfg: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
  const engagement = bugBountyContestEngagement(cfg);
  const strategy = contestStrategy(cfg);
  for (const source of [strategy, engagement ?? {}]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") return value;
    }
  }
  return fallback;
}

function isBugBountyContestProject(project: Record<string, unknown>): boolean {
  return Boolean(bugBountyContestEngagement(projectConfigRecord(project)));
}

function contestBatchScopes(project: Record<string, unknown>): number {
  return contestPositiveInt(projectConfigRecord(project), ["batchScopes", "scopeBatchSize", "roundScopes"], DEFAULT_CONTEST_BATCH_SCOPES);
}

function contestDigConcurrency(project: Record<string, unknown>): number {
  return contestPositiveInt(projectConfigRecord(project), ["digConcurrency", "concurrency"], DEFAULT_CONTEST_DIG_CONCURRENCY);
}

function contestAppendMapWhenExhausted(project: Record<string, unknown>): boolean {
  return contestBoolean(projectConfigRecord(project), ["appendMapWhenExhausted", "appendMapAfterBatch", "expandMapWhenExhausted"], true);
}

function contestSkipsRealTargetConfirmation(project: Record<string, unknown>): boolean {
  if (!isBugBountyContestProject(project)) return false;
  return contestBoolean(projectConfigRecord(project), ["skipRealTargetConfirm", "skipRealTargetConfirmation", "skipConfirm"], true);
}

function projectRequiresRealTargetConfirmation(project: Record<string, unknown>, runs: Array<Record<string, unknown>>): boolean {
  if (contestSkipsRealTargetConfirmation(project)) return false;
  return latestPrepareRequiresRealTargetConfirmation(runs);
}

function applyPreparedWorkspaceIfNeeded(spec: LaunchSpec, runs: Array<Record<string, unknown>>): { ok: true } | { ok: false; error: string } {
  if (spec.verb === "prepare") return { ok: true };
  if (spec.verb === "run" && spec.pipeline) return { ok: true };
  if (spec.sourcePaths.length > 0) return { ok: true };
  const prepared = latestPreparedWorkspace(runs);
  if (!prepared) {
    return {
      ok: false,
      error: spec.verb === "confirm"
        ? "this project has no source paths and no prepared workspace to reproduce against. Run Prepare first, or configure source paths."
        : "this project has no source paths and no prepared workspace yet. Run Prepare first, or configure source paths.",
    };
  }
  spec.dir = undefined;
  spec.sourcePaths = [prepared.workspaceDir];
  spec.buildRoot = prepared.workspaceDir;
  if (!spec.scopeNote && prepared.scopeNote) spec.scopeNote = prepared.scopeNote;
  return { ok: true };
}

function latestPreparedWorkspace(runs: Array<Record<string, unknown>>): { workspaceDir: string; manifestPath: string; scopeNote?: string } | undefined {
  const run = runs.find((entry) => isSuccessfulPrepareRun(entry) && typeof entry.run_dir === "string");
  if (!run) return undefined;
  const runDir = path.resolve(String(run.run_dir));
  const workspaceDir = path.join(runDir, "prepare", "workspace");
  const manifestPath = resolvePrepareManifestPath(runDir, workspaceDir);
  if (!manifestPath || !existsSync(workspaceDir)) return undefined;
  let scopeNote: string | undefined;
  try {
    scopeNote = deriveScopeNote(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    scopeNote = undefined;
  }
  return { workspaceDir, manifestPath, ...(scopeNote ? { scopeNote } : {}) };
}

function resolvePrepareManifestPath(runDir: string, workspaceDir: string): string | undefined {
  const workspaceManifest = path.join(workspaceDir, "prepare_manifest.json");
  const rootManifest = path.join(runDir, "prepare_manifest.json");
  return existsSync(workspaceManifest) ? workspaceManifest : existsSync(rootManifest) ? rootManifest : undefined;
}

// Queue an ad-hoc run from a full launch spec — the CLI's enqueue entry point. Unlike
// runLaunch (which resolves a configured project's staged materials under a daemon workspace),
// this takes the spec as-is: ABSOLUTE materials, no `dir`, so the (co-located) daemon resolves
// them verbatim. A project row is upserted purely so the run is grouped + visible in the UI.
async function launch(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const target = String(body.target ?? "").trim();
  const verb = String(body.verb ?? "").trim();
  if (!target) return sendJson(c.res, 400, { error: "target is required" });
  if (!["run", "map", "audit", "confirm", "prepare"].includes(verb)) {
    return sendJson(c.res, 400, { error: "verb must be one of run | map | audit | confirm | prepare" });
  }
  const spec = normalizeLaunchSpec(body, target, verb as RunKind, c.out);
  if (!c.store.getProject(target)) {
    c.store.upsertProject({ name: target, sourcePaths: spec.sourcePaths, ...(spec.buildRoot ? { buildRoot: spec.buildRoot } : {}), corpusPaths: spec.corpusPaths ?? [], config: launchDisplayConfig(spec) });
  }
  const jobId = c.store.enqueueJob(target, spec);
  c.plane.nudge();
  sendJson(c.res, 200, { jobId, verb: spec.verb, queued: true, daemons: c.plane.daemonCount() });
}

// Coerce a /api/launch body into a clean LaunchSpec (drop non-finite/wrong-typed values; no
// `dir` — the CLI sends absolute paths). Mirrors the CLI's own spec build on the receiving end.
function normalizeLaunchSpec(body: Record<string, unknown>, target: string, verb: RunKind, out: string): LaunchSpec {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const backend = (v: unknown): SandboxBackend | undefined => isSandboxBackend(v) ? v : undefined;
  const network = (v: unknown): "none" | "enabled" | undefined => (v === "none" || v === "enabled" ? v : undefined);
  return {
    verb,
    target,
    sourcePaths: list(body.sourcePaths),
    corpusPaths: list(body.corpusPaths),
    buildRoot: str(body.buildRoot),
    provider: str(body.provider),
    model: str(body.model),
    thinking: str(body.thinking),
    maxScopes: num(body.maxScopes),
    mapSteps: num(body.mapSteps),
    mapSamples: num(body.mapSamples),
    digSteps: num(body.digSteps),
    maxSteps: num(body.maxSteps),
    digSamples: num(body.digSamples),
    digMaxSamples: num(body.digMaxSamples),
    adaptiveDig: bool(body.adaptiveDig),
    eagerPrepare: bool(body.eagerPrepare),
    digConcurrency: num(body.digConcurrency),
    sandboxBackend: backend(body.sandboxBackend),
    sandboxImage: str(body.sandboxImage),
    sandboxAllowHostFallback: bool(body.sandboxAllowHostFallback),
    sandboxPrepareNetwork: network(body.sandboxPrepareNetwork),
    sandboxConfirmNetwork: network(body.sandboxConfirmNetwork),
    sandboxMemoryMb: num(body.sandboxMemoryMb),
    sandboxCpus: num(body.sandboxCpus),
    remap: bool(body.remap),
    appendMap: bool(body.appendMap),
    appendMapSeedPaths: list(body.appendMapSeedPaths),
    fresh: bool(body.fresh),
    quick: bool(body.quick),
    mockLlm: bool(body.mockLlm),
    pipeline: bool(body.pipeline),
    continueCoverage: bool(body.continueCoverage),
    verifyFromStart: bool(body.verifyFromStart),
    region: str(body.region),
    scope: str(body.scope),
    scopeNote: str(body.scopeNote),
    ...(body.verifyFindings !== undefined ? { verifyFindings: body.verifyFindings } : {}),
    inputRunDir: str(body.inputRunDir),
    clue: str(body.clue),
    posture: str(body.posture),
    matchDeployed: bool(body.matchDeployed),
    endpoint: str(body.endpoint),
    out,
  };
}

// The project-row config_json for a launched ad-hoc run (display only; the daemon runs the spec).
function launchDisplayConfig(spec: LaunchSpec): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ provider: spec.provider, model: spec.model, thinking: spec.thinking, maxScopes: spec.maxScopes, mapSteps: spec.mapSteps, mapSamples: spec.mapSamples, digSteps: spec.digSteps, digSamples: spec.digSamples, digMaxSamples: spec.digMaxSamples, adaptiveDig: spec.adaptiveDig, eagerPrepare: spec.eagerPrepare, digConcurrency: spec.digConcurrency, verifyConcurrency: spec.verifyConcurrency, sandboxBackend: spec.sandboxBackend, sandboxImage: spec.sandboxImage, sandboxAllowHostFallback: spec.sandboxAllowHostFallback, sandboxPrepareNetwork: spec.sandboxPrepareNetwork, sandboxConfirmNetwork: spec.sandboxConfirmNetwork, sandboxMemoryMb: spec.sandboxMemoryMb, sandboxCpus: spec.sandboxCpus })) {
    if (v !== undefined) cfg[k] = v;
  }
  return cfg;
}

function findingsList(c: Ctx): void {
  withProject(c, (id, project) => {
    const status = c.url.searchParams.get("status") ?? undefined;
    const tracking = c.url.searchParams.get("tracking") ?? undefined;
    const search = c.url.searchParams.get("q") ?? undefined;
    const includeStale = c.url.searchParams.get("includeStale") === "true";
    const limit = clampInt(c.url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
    const allRuns = c.store.listRuns(id);
    const materialBoundary = latestPrepareRun(allRuns);
    const activePrepareRefresh = activePrepareRefreshStartedAt(c.store, project, materialBoundary);
    const currentRuns = currentVisibleRuns(allRuns, materialBoundary, activePrepareRefresh);
    const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
    const currentResultRunIds = runIdSet(currentResultRuns(currentRuns, scopeBoundary));
    const filter = {
      status,
      tracking,
      search,
      reportable: true,
      ...(!includeStale && (activePrepareRefresh || materialBoundary) ? { runIds: activePrepareRefresh ? [] : [...currentResultRunIds] } : {}),
    };
    const total = c.store.countFindings(id, filter);
    const rows = c.store.queryFindings(id, { ...filter, limit, offset })
      .map((finding) => annotateFindingMaterialStaleness(finding, currentResultRunIds, materialBoundary, activePrepareRefresh));
    const findings = withLatestFindingAttempts(c.store, rows)
      .map((finding) => findingDetailRow({ ...finding, timeline: c.store.findingTimeline(Number(finding.id)) }));
    sendJson(c.res, 200, { findings, total, limit, offset });
  });
}

function withLatestFindingAttempts(store: MetadataStore, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const attempts = store.latestFindingPhaseAttempts("finding", rows.map((row) => Number(row.id)));
  const byFinding = new Map<number, Array<Record<string, unknown>>>();
  for (const attempt of attempts) {
    const id = Number(attempt.subject_id);
    const current = byFinding.get(id) ?? [];
    current.push(attempt);
    byFinding.set(id, current);
  }
  return rows.map((row) => ({ ...row, phase_attempts: byFinding.get(Number(row.id)) ?? [] }));
}

function annotateFindingMaterialStaleness(row: Record<string, unknown>, currentRunIds: Set<number>, boundary?: Record<string, unknown>, activePrepareRefreshStartedAt?: string): Record<string, unknown> {
  if (!activePrepareRefreshStartedAt && rowBelongsToCurrentMaterial(row, currentRunIds, boundary)) return row;
  return {
    ...row,
    material_stale: true,
    ...(boundary?.id !== undefined ? { stale_since_prepare_run_id: boundary.id } : {}),
    stale_since_prepare_started_at: activePrepareRefreshStartedAt ?? boundary?.started_at,
  };
}

function reportableFindings(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  // Canonical identity and occurrence provenance are enforced when findings are
  // ingested. Read paths must not hide distinct claims with title-similarity guesses.
  return rows.filter(isReportableFinding);
}

function findingSummaryRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "id",
    "uuid",
    "project_id",
    "project_name",
    "project_uuid",
    "source",
    "evaluation_name",
    "evaluation_uuid",
    "run_id",
    "finding_key",
    "canonical_key",
    "occurrence_count",
    "title",
    "location",
    "severity",
    "status",
    "confirm_status",
    "duplicate_of_finding_id",
    "scope_id",
    "confidence",
    "refutation_status",
    "refutation_reason",
    "phase_attempts",
    "tracking_status",
    "created_at",
    "updated_at",
    "timeline",
  ]) {
    if (key in row) out[key] = row[key];
  }
  out.has_report = rowHasFormalReport(row);
  return findingDisplayRow(out);
}

function findingDetailRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  delete out.report_path;
  delete out.report_markdown;
  out.has_report = rowHasFormalReport(row);
  return findingDisplayRow(out);
}

function rowHasFormalReport(row: Record<string, unknown>): boolean {
  const reportMarkdown = stringValue(row.report_markdown).trimStart();
  return Boolean(reportMarkdown && !reportMarkdown.startsWith("# Security disclosure:"));
}

function confirmDecisionDisplayRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  delete out.report_markdown;
  const engagementProfile = safeParse(row.engagement_profile_json);
  if (engagementProfile) out.engagement_profile = engagementProfile;
  const adjudication = safeParse(row.adjudication_json);
  if (adjudication) out.adjudication = adjudication;
  out.has_report = decisionHasFormalReport(row);
  return out;
}

function confirmDecisionRunHealth(rows: Array<{ reproduced?: unknown; recommendation?: unknown }>): { status: string; reasons: string[]; signals: Record<string, unknown> } | undefined {
  if (rows.length === 0) return undefined;
  const couldNotSetUp = rows.filter((row) => row.reproduced === "could-not-set-up").length;
  const needsHuman = rows.filter((row) => row.recommendation === "needs-human").length;
  if (couldNotSetUp === 0 && needsHuman === 0) return undefined;
  const reproducedYes = rows.filter((row) => row.reproduced === "yes").length;
  const submitCandidates = rows.filter((row) => row.recommendation === "submit-candidate").length;
  return {
    status: couldNotSetUp > 0 ? "needs-resource" : "needs-human",
    reasons: couldNotSetUp > 0
      ? [`${couldNotSetUp} confirm decision(s) could not be set up; review toolchain, network, or environment blockers before reporting.`]
      : [`${needsHuman} confirm decision(s) still need human review before reporting.`],
    signals: {
      confirmDecisionRows: rows.length,
      reproducedYes,
      submitCandidates,
      needsHuman,
      couldNotSetUp,
    },
  };
}

function decisionHasFormalReport(row: Record<string, unknown>): boolean {
  const reportMarkdown = stringValue(row.report_markdown).trimStart();
  return Boolean(reportMarkdown && !reportMarkdown.startsWith("# Security disclosure:"));
}

function findingDisplayRow(row: Record<string, unknown>): Record<string, unknown> {
  if (!("title" in row)) return row;
  return { ...row, title: cleanFindingTitle(row.title) };
}

function findingReport(c: Ctx): void {
  const row = c.store.getFinding(Number(c.params.id));
  if (!row) return sendJson(c.res, 404, { error: "no such finding" });
  const display = findingDisplayRow(row);
  const stored = stringValue(display.report_markdown);
  const projectId = Number(display.project_id);
  const findingKey = stringValue(display.finding_key);
  const decisions = Number.isFinite(projectId) && findingKey ? c.store.listConfirmDecisionsForFinding(projectId, findingKey) : [];
  sendJson(c.res, 200, {
    markdown: stored || renderFindingReportMarkdown(display, decisions),
    source: stored ? "db" : "generated",
  });
}

function findingLifecycle(c: Ctx): void {
  const id = Number(c.params.id);
  const finding = c.store.getFinding(id);
  if (!finding) return sendJson(c.res, 404, { error: "no such finding" });
  const decisions = c.store.listConfirmDecisionsForFinding(Number(finding.project_id), String(finding.finding_key ?? ""));
  sendJson(c.res, 200, {
    finding: findingSummaryRow(finding),
    timeline: c.store.findingTimeline(id),
    occurrences: c.store.findingOccurrences(id),
    attempts: c.store.listFindingPhaseAttempts("finding", id),
    decisions: decisions.map((decision) => ({
      ...confirmDecisionDisplayRow(decision),
      attempts: c.store.listFindingPhaseAttempts("decision", Number(decision.id)),
    })),
  });
}

async function findingPhaseRetry(c: Ctx): Promise<void> {
  const id = Number(c.params.id);
  const finding = c.store.getFinding(id);
  if (!finding) return sendJson(c.res, 404, { error: "no such finding" });
  const body = (await readBody(c.req)) as { phase?: string };
  if (body.phase !== "verify" && body.phase !== "confirm" && body.phase !== "report") {
    return sendJson(c.res, 400, { error: "phase must be verify, confirm, or report" });
  }
  let subjectType: "finding" | "decision" = "finding";
  let subjectId = id;
  if (body.phase === "report") {
    const decisions = c.store.listConfirmDecisionsForFinding(Number(finding.project_id), String(finding.finding_key ?? ""));
    const decision = decisions.find((row) => c.store.latestFindingPhaseAttempt("decision", Number(row.id), "report")?.state === "blocked") ?? decisions[0];
    if (decision) {
      subjectType = "decision";
      subjectId = Number(decision.id);
    }
  }
  const ok = c.store.requestFindingPhaseRetry(Number(finding.project_id), subjectType, subjectId, body.phase);
  sendJson(c.res, ok ? 200 : 409, ok ? { ok: true, phase: body.phase, subjectType, subjectId } : { error: "phase retry could not be queued" });
}

function confirmDecisionReport(c: Ctx): void {
  const row = c.store.getConfirmDecision(Number(c.params.id));
  if (!row) return sendJson(c.res, 404, { error: "no such confirm decision" });
  const projectId = Number(row.project_id);
  const linkedFindings = Number.isFinite(projectId) ? linkedFindingsForDecision(c.store, projectId, row) : [];
  const stored = stringValue(row.report_markdown);
  sendJson(c.res, 200, {
    markdown: stored || renderDecisionReportMarkdown(row, linkedFindings),
    source: stored ? "db" : "generated",
  });
}

function renderFindingReportMarkdown(row: Record<string, unknown>, decisions: Array<Record<string, unknown>> = []): string {
  const title = stringValue(row.title) || "Finding report";
  const confidence = numberValue(row.confidence);
  const primaryDecision = decisions[0];
  const lines = [
    `# ${title}`,
    "",
    `- Project: ${stringValue(row.project_name) || "unknown"}`,
    `- Status: ${stringValue(row.status) || "unknown"}`,
    stringValue(row.confirm_status) ? `- Real-target status: ${stringValue(row.confirm_status)}` : "",
    primaryDecision ? `- Submit recommendation: ${stringValue(primaryDecision.recommendation) || "unknown"}` : "",
    stringValue(row.location) ? `- Location: \`${stringValue(row.location)}\`` : "",
    stringValue(row.severity) ? `- Severity: ${stringValue(row.severity)}` : "",
    confidence != null ? `- Confidence: ${Math.round(confidence * 100)}%` : "",
    "",
  ].filter(Boolean);
  const description = stringValue(row.description);
  const evidence = stringValue(row.evidence);
  const exploit = stringValue(row.exploit_sketch);
  const fix = stringValue(row.fix);
  if (description) lines.push("## Description", "", description, "");
  if (evidence) lines.push("## Evidence", "", "```", evidence, "```", "");
  if (exploit) lines.push("## Impact / Exploit", "", exploit, "");
  if (fix) lines.push("## Suggested Fix", "", fix, "");
  if (primaryDecision) {
    lines.push("## Real Target Decision", "");
    lines.push(`- Reproduced: ${stringValue(primaryDecision.reproduced) || "unknown"}`);
    lines.push(`- Recommendation: ${stringValue(primaryDecision.recommendation) || "unknown"}`);
    const reproEvidence = stringValue(primaryDecision.repro_evidence);
    const distinctFix = stringValue(primaryDecision.distinct_fix);
    const commandId = stringValue(primaryDecision.repro_command_id);
    const corroboration = stringValue(primaryDecision.corroboration);
    const novelty = stringValue(primaryDecision.novelty);
    const humanGates = stringValue(primaryDecision.human_gates);
    if (commandId) lines.push(`- Command evidence: \`${commandId}\``);
    if (reproEvidence) lines.push("", "### Reproduction Evidence", "", reproEvidence);
    if (distinctFix) lines.push("", "### Distinct Fix", "", distinctFix);
    if (corroboration || novelty || humanGates) {
      lines.push("", "### Novelty and Disclosure Notes", "");
      if (corroboration) lines.push(`- Corroboration: ${corroboration}`);
      if (novelty) lines.push(`- Novelty: ${novelty}`);
      if (humanGates) lines.push(`- Human gates: ${humanGates}`);
    }
  }
  return lines.join("\n").trim();
}

function uniqueTextValues(rows: Array<Record<string, unknown>>, key: string, limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = stringValue(row[key]).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function pushReportSection(lines: string[], title: string, body: string): void {
  lines.push(`## ${title}`, "", body.trim() || "Not established by the available evidence.", "");
}

function pushReportBullets(lines: string[], title: string, bullets: string[]): void {
  const visible = bullets.map((item) => item.trim()).filter(Boolean);
  lines.push(`## ${title}`, "");
  if (visible.length === 0) {
    lines.push("Not established by the available evidence.", "");
    return;
  }
  for (const item of visible) lines.push(`- ${item}`);
  lines.push("");
}

function renderDecisionReportMarkdown(decision: Record<string, unknown>, linkedFindings: Array<Record<string, unknown>>): string {
  const title = stringValue(decision.bug) || "Decision report";
  const reproduced = stringValue(decision.reproduced) || "unknown";
  const recommendation = stringValue(decision.recommendation) || "unknown";
  const severity = stringValue(decision.severity);
  const evidenceLevel = stringValue(decision.evidence_level);
  const confidence = stringValue(decision.submission_confidence);
  const commandId = stringValue(decision.repro_command_id);
  const evidence = stringValue(decision.repro_evidence);
  const fix = stringValue(decision.distinct_fix);
  const corroboration = stringValue(decision.corroboration);
  const novelty = stringValue(decision.novelty);
  const humanGates = stringValue(decision.human_gates);
  const engagementProfile = safeParse(decision.engagement_profile_json);
  const adjudication = safeParse(decision.adjudication_json);
  const locations = uniqueTextValues(linkedFindings, "location");
  const descriptions = uniqueTextValues(linkedFindings, "description", 4);
  const sourceEvidence = uniqueTextValues(linkedFindings, "evidence", 4);
  const exploitSketches = uniqueTextValues(linkedFindings, "exploit_sketch", 3);
  const sourceFixes = uniqueTextValues(linkedFindings, "fix", 3);

  const lines: string[] = [
    `# ${title}`,
    "",
  ];

  const confirmationNoun = isRealTargetDecisionEvidence(evidenceLevel) ? "real-target confirmation run" : "confirmation run";
  const summary = descriptions[0]
    || (evidence ? evidence.split(/\n\s*\n/)[0] : "")
    || `A ${confirmationNoun} evaluated "${title}" and recorded reproduction status "${reproduced}" with recommendation "${recommendation}".`;
  pushReportSection(lines, "Summary", summary);
  pushReportBullets(lines, "Evidence Basis", [
    `Reproduction status: ${reproduced}`,
    `Submit recommendation: ${recommendation}`,
    evidenceLevel ? `Evidence level: ${evidenceLevel}` : "",
    commandId ? `Local reproduction command: \`${commandId}\`` : "",
    locations.length ? `Source locations reviewed: ${locations.map((entry) => `\`${entry}\``).join(", ")}` : "",
  ]);
  pushReportBullets(lines, "Severity", [
    severity ? `Severity: ${severity}` : "",
    confidence ? `Submission confidence: ${confidence}` : "",
    evidenceLevel ? `Evidence basis: ${evidenceLevel}` : "",
  ]);
  const engagementNotes = [
    engagementProfile ? `Engagement profile: ${jsonOneLine(engagementProfile)}` : "",
    adjudication ? `Eligibility / payout adjudication: ${jsonOneLine(adjudication)}` : "",
  ].filter(Boolean);
  if (engagementNotes.length > 0) pushReportBullets(lines, "Engagement and Eligibility", engagementNotes);
  pushReportBullets(lines, "Affected Component", locations.map((entry) => `\`${entry}\``));
  pushReportSection(lines, "Root Cause", descriptions.join("\n\n"));
  pushReportSection(lines, "Attack Scenario", exploitSketches.join("\n\n"));
  pushReportSection(lines, "Impact", evidence || sourceEvidence[0] || "");
  pushReportSection(lines, "Reproduction Evidence", [
    commandId ? `Local reproduction command: \`${commandId}\`` : "",
    evidence,
  ].filter(Boolean).join("\n\n"));
  pushReportSection(lines, "Proof of Concept", exploitSketches.join("\n\n") || "Use the local-only reproduction evidence above. Do not broadcast or write to a live network while reproducing.");
  pushReportSection(lines, "Recommended Fix", [fix, ...sourceFixes].filter(Boolean).join("\n\n"));
  pushReportSection(lines, "Validation", [
    "Add a regression test that exercises the affected component and fails without the remediation.",
    commandId ? `Re-run the local reproduction represented by \`${commandId}\` or an equivalent maintainer-owned local test after applying the fix.` : "Re-run an equivalent maintainer-owned local reproduction after applying the fix.",
  ].join("\n"));
  if (sourceEvidence.length > 0) pushReportSection(lines, "Source-Level Technical Detail", sourceEvidence.join("\n\n"));
  if (corroboration || novelty || humanGates || engagementNotes.length > 0) {
    lines.push("## Novelty and Disclosure Notes", "");
    if (corroboration) lines.push(`- Corroboration: ${corroboration}`);
    if (novelty) lines.push(`- Novelty: ${novelty}`);
    if (humanGates) lines.push(`- Human gates: ${humanGates}`);
    if (engagementProfile) lines.push(`- Engagement profile: ${jsonOneLine(engagementProfile)}`);
    if (adjudication) lines.push(`- Eligibility / payout adjudication: ${jsonOneLine(adjudication)}`);
  }
  return lines.join("\n").trim();
}

function jsonOneLine(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function cleanFindingTitle(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/^\s*(?:UNMET|SUSPECTED|CONFIRMED|REFUTED|DISPUTED|FINDING|BUG)\s*:\s*/i, "").trim();
}

function isReportableFinding(row: Record<string, unknown>): boolean {
  const status = String(row.status ?? "").toLowerCase();
  if (status === "discharged") return false;
  const severity = String(row.severity ?? "").toLowerCase();
  if (severity === "info" && status !== "refuted" && !isConfirmedFindingStatus(status)) return false;
  return true;
}

function isConfirmedFindingStatus(status: string): boolean {
  return status === "confirmed-source" || status === "confirmed-executable" || status === "confirmed-differential";
}

function isExecutionConfirmedFindingStatus(status: string): boolean {
  return status === "confirmed-executable" || status === "confirmed-differential";
}

function countAuditConfirmedFindings(rows: Array<Record<string, unknown>>): number {
  return rows.filter((row) =>
    isConfirmedFindingStatus(String(row.status ?? "").toLowerCase())
    && !findingTrackingBlocksProgress(row)
    && !findingIndependentReviewBlocksProgress(row)).length;
}

function findingTrackingBlocksProgress(row: Record<string, unknown> | undefined): boolean {
  const status = stringValue(row?.tracking_status).toLowerCase();
  return status === "ignored" || status === "duplicate";
}

function findingIndependentReviewBlocksProgress(row: Record<string, unknown> | undefined): boolean {
  const status = stringValue(row?.refutation_status).toLowerCase();
  return Boolean(status && status !== "passed");
}

function findingStatusMatches(row: Record<string, unknown>, status?: string): boolean {
  if (!status) return true;
  const rowStatus = String(row.status ?? "").toLowerCase();
  if (status === "execution-confirmed") return rowStatus === "confirmed-executable" || rowStatus === "confirmed-differential";
  return rowStatus === status;
}

function findingTrackingMatches(row: Record<string, unknown>, tracking?: string): boolean {
  if (!tracking) return true;
  const rowTracking = String(row.tracking_status ?? "open") || "open";
  if (tracking === "active") return rowTracking !== "ignored";
  return rowTracking === tracking;
}

function isIgnoredFinding(row: Record<string, unknown>): boolean {
  return String(row.tracking_status ?? "open") === "ignored";
}

const FINDING_SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function rank(table: Record<string, number>, value: unknown): number {
  return table[String(value ?? "").toLowerCase()] ?? -1;
}

function findingCounts(rows: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const status = String(row.status ?? "");
    if (!status) continue;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function confirmDecisionsList(c: Ctx): void {
  withProject(c, (id, project) => {
    const reproduced = c.url.searchParams.get("reproduced");
    const includeStale = c.url.searchParams.get("includeStale") === "true";
    const allRuns = c.store.listRuns(id);
    const materialBoundary = latestPrepareRun(allRuns);
    const activePrepareRefresh = activePrepareRefreshStartedAt(c.store, project, materialBoundary);
    const currentRuns = currentVisibleRuns(allRuns, materialBoundary, activePrepareRefresh);
    const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
    const currentResultRunIds = runIdSet(currentResultRuns(currentRuns, scopeBoundary));
    let rows = c.store.listConfirmDecisions(id);
    rows = rows
      .filter((row) => includeStale || (!activePrepareRefresh && rowBelongsToCurrentMaterial(row, currentResultRunIds, materialBoundary)))
      .map((row) => annotateConfirmDecisionMaterialStaleness(row, currentResultRunIds, materialBoundary, activePrepareRefresh));
    if (!includeStale) rows = currentConfirmDecisions(rows);
    if (reproduced) rows = rows.filter((row) => row.reproduced === reproduced);
    sendJson(c.res, 200, { confirmDecisions: rows.map(confirmDecisionDisplayRow) });
  });
}

function annotateConfirmDecisionMaterialStaleness(
  row: Record<string, unknown>,
  currentRunIds: Set<number>,
  materialBoundary?: Record<string, unknown>,
  activePrepareRefreshStartedAt?: string,
): Record<string, unknown> {
  if (!activePrepareRefreshStartedAt && rowBelongsToCurrentMaterial(row, currentRunIds, materialBoundary)) return row;
  return {
    ...row,
    material_stale: true,
    stale_since_prepare_run_id: materialBoundary?.id,
    stale_since_prepare_started_at: activePrepareRefreshStartedAt ?? materialBoundary?.started_at,
  };
}

// ---- durable run groups + work items --------------------------------------

function runGroupList(c: Ctx): void {
  const limit = clampInt(c.url.searchParams.get("limit"), 100, 1, 500);
  const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
  const groups = c.store.listRunGroups(limit, offset).map((group) => runGroupApiRow(c.store, group));
  sendJson(c.res, 200, { runGroups: groups, total: c.store.countRunGroups(), limit, offset });
}

async function runGroupCreate(c: Ctx): Promise<void> {
  const body = objectValue(await readBody(c.req));
  if (!body) return sendJson(c.res, 400, { error: "request body must be an object" });
  try {
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length > 0) {
      const manifest = normalizeRunGroupManifest({ version: body.version ?? 1, ...body, items: rawItems });
      const group = c.store.createRunGroup({ name: manifest.name, kind: manifest.kind, parallelism: manifest.parallelism, config: manifest.config, budget: manifest.budget });
      c.store.addWorkItems(Number(group.id), manifest.items);
      return sendJson(c.res, 201, runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!));
    }
    const name = stringValue(body.name).trim();
    if (!name) return sendJson(c.res, 400, { error: "name is required" });
    const parallelism = optionalPositiveInt(body.parallelism, 1);
    if (parallelism === undefined) return sendJson(c.res, 400, { error: "parallelism must be a positive integer" });
    const group = c.store.createRunGroup({
      name,
      kind: stringValue(body.kind).trim() || "evaluation",
      parallelism,
      ...(objectValue(body.config) ? { config: body.config } : {}),
      ...(objectValue(body.budget ?? body.budgets) ? { budget: body.budget ?? body.budgets } : {}),
    });
    sendJson(c.res, 201, runGroupApiRow(c.store, group));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(c.res, /UNIQUE constraint failed/.test(message) ? 409 : 400, { error: message });
  }
}

function runGroupGet(c: Ctx): void {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  group ? sendJson(c.res, 200, runGroupApiRow(c.store, group)) : sendJson(c.res, 404, { error: "no such run group" });
}

async function runGroupItemsAdd(c: Ctx): Promise<void> {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  if (!group) return sendJson(c.res, 404, { error: "no such run group" });
  if (group.state !== "draft" && group.state !== "paused") return sendJson(c.res, 409, { error: "work items may only be appended while a group is draft or paused" });
  const body = objectValue(await readBody(c.req));
  const rawItems = body && Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return sendJson(c.res, 400, { error: "items must be a non-empty array" });
  try {
    c.store.addWorkItems(Number(group.id), rawItems.map((item, index) => normalizeWorkItemInput(item, index)));
    sendJson(c.res, 200, runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(c.res, /UNIQUE constraint failed/.test(message) ? 409 : 400, { error: message });
  }
}

async function runGroupStart(c: Ctx): Promise<void> {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  if (!group) return sendJson(c.res, 404, { error: "no such run group" });
  if (c.store.listWorkItems(Number(group.id)).length === 0) return sendJson(c.res, 409, { error: "run group has no work items" });
  const body = objectValue(await readBody(c.req)) ?? {};
  const parallelism = body.parallelism === undefined ? undefined : optionalPositiveInt(body.parallelism, undefined);
  if (body.parallelism !== undefined && parallelism === undefined) return sendJson(c.res, 400, { error: "parallelism must be a positive integer" });
  if (!c.store.startRunGroup(String(group.uuid), parallelism)) return sendJson(c.res, 409, { error: `run group cannot start from state ${String(group.state)}` });
  const scheduled = scheduleRunGroup(c, Number(group.id));
  sendJson(c.res, 200, { ...runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!), scheduled });
}

function runGroupPause(c: Ctx): void {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  if (!group) return sendJson(c.res, 404, { error: "no such run group" });
  if (group.state !== "running") return sendJson(c.res, 409, { error: "only a running group can be paused" });
  c.store.setRunGroupState(String(group.uuid), "paused");
  sendJson(c.res, 200, runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!));
}

function runGroupCancel(c: Ctx): void {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  if (!group) return sendJson(c.res, 404, { error: "no such run group" });
  if (group.state === "finished" || group.state === "failed" || group.state === "cancelled") {
    return sendJson(c.res, 409, { error: `run group cannot be cancelled from state ${String(group.state)}` });
  }
  const jobs = c.store.cancelRunGroupItems(Number(group.id));
  for (const jobId of jobs) {
    c.store.cancelJob(jobId, "run group cancelled by operator");
    c.plane.cancel(jobId);
  }
  c.store.setRunGroupState(String(group.uuid), "cancelled");
  sendJson(c.res, 200, { ...runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!), canceledJobs: jobs });
}

function runGroupReport(c: Ctx): void {
  const group = c.store.getRunGroupByUuid(c.params.uuid ?? "");
  if (!group) return sendJson(c.res, 404, { error: "no such run group" });
  c.store.refreshRunGroupCompletion(Number(group.id));
  const current = c.store.getRunGroupById(Number(group.id))!;
  sendJson(c.res, 200, { group: current, ...renderRunGroupReport(current, c.store.listWorkItems(Number(group.id))) });
}

function workItemGet(c: Ctx): void {
  const item = c.store.getWorkItem(Number(c.params.id));
  item ? sendJson(c.res, 200, { workItem: workItemApiRow(c.store, item) }) : sendJson(c.res, 404, { error: "no such work item" });
}

function workItemRetry(c: Ctx): void {
  const item = c.store.getWorkItem(Number(c.params.id));
  if (!item) return sendJson(c.res, 404, { error: "no such work item" });
  if (!c.store.retryBlockedWorkItem(Number(item.id))) {
    return sendJson(c.res, 409, { error: "only blocked failed/cancelled work items in a non-cancelled group can be retried" });
  }
  const group = c.store.getRunGroupById(Number(item.run_group_id))!;
  const scheduled = group.state === "running" ? scheduleRunGroup(c, Number(group.id)) : 0;
  sendJson(c.res, 200, { ...runGroupApiRow(c.store, c.store.getRunGroupById(Number(group.id))!), scheduled });
}

function harnessExperimentList(c: Ctx): void {
  const limit = clampInt(c.url.searchParams.get("limit"), 100, 1, 500);
  const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
  const experiments = c.store.listHarnessExperiments(limit, offset).map((row) => harnessExperimentApiRow(c.store, row, false));
  sendJson(c.res, 200, { experiments, total: c.store.countHarnessExperiments(), limit, offset });
}

async function harnessExperimentCreate(c: Ctx): Promise<void> {
  try {
    const input = normalizeHarnessExperimentInput(await readBody(c.req));
    const baseline = c.store.getRunGroupByUuid(input.baselineRunGroupUuid);
    if (!baseline) return sendJson(c.res, 404, { error: "no such baseline run group" });
    if (baseline.state !== "finished") return sendJson(c.res, 409, { error: "baseline run group must be finished before weakness mining" });
    const candidate = input.candidateRunGroupUuid ? c.store.getRunGroupByUuid(input.candidateRunGroupUuid) : undefined;
    if (input.candidateRunGroupUuid && !candidate) return sendJson(c.res, 404, { error: "no such candidate run group" });
    if (candidate && Number(candidate.id) === Number(baseline.id)) return sendJson(c.res, 409, { error: "baseline and candidate run groups must be different" });

    const snapshot = harnessGroupSnapshot(c.store, baseline);
    const failurePatterns = mineHarnessWeaknesses(snapshot.items);
    const preservedBehaviors = minePreservedBehaviors(snapshot.items);
    const proposal = buildHarnessCandidateProposal(failurePatterns, preservedBehaviors, input.editableFiles);
    const state = candidate ? "evaluating" : proposal ? "proposal-ready" : "needs-evidence";
    const created = c.store.createHarnessExperiment({
      name: input.name,
      baselineRunGroupId: Number(baseline.id),
      ...(candidate ? { candidateRunGroupId: Number(candidate.id) } : {}),
      editableFiles: input.editableFiles,
      promotionPolicy: input.promotionPolicy,
      failurePatterns,
      preservedBehaviors,
      ...(proposal ? { proposal } : {}),
      state,
    });
    sendJson(c.res, 201, harnessExperimentApiRow(c.store, created, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(c.res, /UNIQUE constraint failed/.test(message) ? 409 : 400, { error: message });
  }
}

function harnessExperimentGet(c: Ctx): void {
  const experiment = c.store.getHarnessExperimentByUuid(c.params.uuid ?? "");
  experiment
    ? sendJson(c.res, 200, harnessExperimentApiRow(c.store, experiment, true))
    : sendJson(c.res, 404, { error: "no such harness experiment" });
}

async function harnessExperimentProposalUpdate(c: Ctx): Promise<void> {
  const experiment = c.store.getHarnessExperimentByUuid(c.params.uuid ?? "");
  if (!experiment) return sendJson(c.res, 404, { error: "no such harness experiment" });
  const body = objectValue(await readBody(c.req));
  if (!body || body.proposal === undefined) return sendJson(c.res, 400, { error: "proposal is required" });
  try {
    const proposal = normalizeHarnessProposal(
      body.proposal,
      storedArray<string>(experiment.editable_files_json),
      storedArray<HarnessFailurePattern>(experiment.failure_patterns_json),
    );
    c.store.updateHarnessExperimentProposal(Number(experiment.id), proposal);
    sendJson(c.res, 200, harnessExperimentApiRow(c.store, c.store.getHarnessExperimentById(Number(experiment.id))!, true));
  } catch (error) {
    sendJson(c.res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function harnessExperimentCandidateAttach(c: Ctx): Promise<void> {
  const experiment = c.store.getHarnessExperimentByUuid(c.params.uuid ?? "");
  if (!experiment) return sendJson(c.res, 404, { error: "no such harness experiment" });
  const body = objectValue(await readBody(c.req));
  const candidateUuid = body ? stringValue(body.candidateRunGroupUuid ?? body.candidate_run_group_uuid).trim() : "";
  if (!candidateUuid) return sendJson(c.res, 400, { error: "candidateRunGroupUuid is required" });
  const candidate = c.store.getRunGroupByUuid(candidateUuid);
  if (!candidate) return sendJson(c.res, 404, { error: "no such candidate run group" });
  if (Number(candidate.id) === Number(experiment.baseline_run_group_id)) return sendJson(c.res, 409, { error: "baseline and candidate run groups must be different" });
  if (!c.store.attachHarnessExperimentCandidate(Number(experiment.id), Number(candidate.id))) {
    return sendJson(c.res, 409, { error: "candidate could not be attached" });
  }
  sendJson(c.res, 200, harnessExperimentApiRow(c.store, c.store.getHarnessExperimentById(Number(experiment.id))!, true));
}

function harnessExperimentEvaluate(c: Ctx): void {
  const experiment = c.store.getHarnessExperimentByUuid(c.params.uuid ?? "");
  if (!experiment) return sendJson(c.res, 404, { error: "no such harness experiment" });
  if (!storedOptionalRecord<HarnessCandidateProposal>(experiment.proposal_json)) return sendJson(c.res, 409, { error: "experiment needs a bounded candidate proposal before evaluation" });
  const baseline = c.store.getRunGroupById(Number(experiment.baseline_run_group_id));
  const candidateId = Number(experiment.candidate_run_group_id);
  const candidate = Number.isFinite(candidateId) && candidateId > 0 ? c.store.getRunGroupById(candidateId) : undefined;
  if (!baseline || !candidate) return sendJson(c.res, 409, { error: "experiment needs both baseline and candidate run groups" });
  try {
    const scorecard = scoreHarnessExperiment(
      harnessGroupSnapshot(c.store, baseline),
      harnessGroupSnapshot(c.store, candidate),
      storedRecord<HarnessPromotionPolicy>(experiment.promotion_policy_json),
    );
    if (!c.store.settleHarnessExperiment(Number(experiment.id), Number(candidate.id), scorecard, scorecard.decision)) {
      return sendJson(c.res, 409, { error: "candidate changed while evaluation was running; evaluate the current candidate again" });
    }
    sendJson(c.res, 200, harnessExperimentApiRow(c.store, c.store.getHarnessExperimentById(Number(experiment.id))!, true));
  } catch (error) {
    sendJson(c.res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function harnessExperimentBrief(c: Ctx): void {
  const experiment = c.store.getHarnessExperimentByUuid(c.params.uuid ?? "");
  if (!experiment) return sendJson(c.res, 404, { error: "no such harness experiment" });
  const baseline = c.store.getRunGroupById(Number(experiment.baseline_run_group_id));
  const proposal = storedOptionalRecord<HarnessCandidateProposal>(experiment.proposal_json);
  if (!baseline || !proposal) return sendJson(c.res, 409, { error: "experiment has no candidate proposal to export" });
  sendJson(c.res, 200, {
    markdown: renderHarnessCandidateBrief({
      experimentName: String(experiment.name),
      baselineGroup: harnessGroupSnapshot(c.store, baseline),
      proposal,
      patterns: storedArray<HarnessFailurePattern>(experiment.failure_patterns_json),
      policy: storedRecord<HarnessPromotionPolicy>(experiment.promotion_policy_json),
    }),
  });
}

function harnessExperimentApiRow(store: MetadataStore, row: Record<string, unknown>, detail: boolean): Record<string, unknown> {
  const parsed = {
    ...row,
    editableFiles: storedArray<string>(row.editable_files_json),
    promotionPolicy: storedRecord<HarnessPromotionPolicy>(row.promotion_policy_json),
    failurePatterns: storedArray<HarnessFailurePattern>(row.failure_patterns_json),
    preservedBehaviors: storedArray(row.preserved_behaviors_json),
    proposal: storedOptionalRecord<HarnessCandidateProposal>(row.proposal_json),
    scorecard: storedOptionalRecord(row.scorecard_json),
  };
  if (!detail) return parsed;
  const baseline = store.getRunGroupById(Number(row.baseline_run_group_id));
  const candidateId = Number(row.candidate_run_group_id);
  const candidate = Number.isFinite(candidateId) && candidateId > 0 ? store.getRunGroupById(candidateId) : undefined;
  return {
    ...parsed,
    baselineGroup: baseline ? runGroupApiRow(store, baseline) : null,
    candidateGroup: candidate ? runGroupApiRow(store, candidate) : null,
  };
}

function harnessGroupSnapshot(store: MetadataStore, group: Record<string, unknown>): HarnessGroupSnapshot {
  const groupConfig = parseStoredJson(group.config_json) ?? {};
  return {
    uuid: String(group.uuid),
    name: String(group.name),
    state: String(group.state),
    items: store.listWorkItems(Number(group.id)).map((item) => harnessEvidenceItemFromRow(item, groupConfig)),
  };
}

function storedArray<T = unknown>(input: unknown): T[] {
  if (Array.isArray(input)) return input as T[];
  if (typeof input !== "string" || !input.trim()) return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function storedRecord<T>(input: unknown): T {
  const parsed = parseStoredJson(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("stored harness experiment contract is invalid");
  return parsed as T;
}

function storedOptionalRecord<T = Record<string, unknown>>(input: unknown): T | null {
  if (input === null || input === undefined || input === "") return null;
  return storedRecord<T>(input);
}

function runGroupApiRow(store: MetadataStore, group: Record<string, unknown>): Record<string, unknown> {
  return {
    ...group,
    config: parseStoredJson(group.config_json),
    budget: parseStoredJson(group.budget_json),
    summary: parseStoredJson(group.summary_json),
    items: store.listWorkItems(Number(group.id)).map((item) => workItemApiRow(store, item)),
  };
}

function workItemApiRow(store: MetadataStore, item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    targetBundle: parseStoredJson(item.target_bundle_json),
    materialPolicy: parseStoredJson(item.material_policy_json),
    evidenceContract: parseStoredJson(item.evidence_contract_json),
    result: parseStoredJson(item.result_json),
    attemptHistory: store.listWorkItemAttempts(Number(item.id)).map((attempt) => ({
      ...attempt,
      result: parseStoredJson(attempt.result_json),
    })),
  };
}

function scheduleRunGroup(c: Ctx, runGroupId: number): number {
  return scheduleRunGroupWith(c.store, c.plane, runGroupId);
}

function scheduleRunGroupWith(store: MetadataStore, plane: ControlPlane, runGroupId: number): number {
  const group = store.getRunGroupById(runGroupId);
  if (!group || group.state !== "running") return 0;
  let scheduled = 0;
  while (true) {
    const pending = store.pendingRunGroupDispatch(runGroupId, Number(group.parallelism) || 1);
    if (pending.length === 0) break;
    let progressed = false;
    for (const item of pending) {
      try {
        const spec = buildWorkItemLaunchSpec(item, group);
        const bundle = parseStoredJson(item.target_bundle_json);
        const daemonId = typeof bundle?.daemonId === "number" ? bundle.daemonId : undefined;
        const jobId = store.enqueueJob(evaluationTrackingProjectName(item), spec, daemonId);
        if (!store.attachWorkItemJob(Number(item.id), jobId)) {
          store.cancelJob(jobId, "work item was concurrently scheduled");
          continue;
        }
        scheduled += 1;
        progressed = true;
      } catch (error) {
        progressed = store.failUnscheduledWorkItem(Number(item.id), "invalid", error instanceof Error ? error.message : String(error)) || progressed;
      }
    }
    if (!progressed) break;
  }
  store.refreshRunGroupCompletion(runGroupId);
  if (scheduled > 0) plane.nudge();
  return scheduled;
}

function settleRunGroupWorkItem(c: Ctx, jobId: number, status: "done" | "error" | "canceled", error?: string): void {
  settleRunGroupWorkItemWith(c.store, c.plane, jobId, status, error);
}

function settleRunGroupWorkItemWith(store: MetadataStore, plane: ControlPlane, jobId: number, status: "done" | "error" | "canceled", error?: string): void {
  const item = store.getWorkItemByJob(jobId);
  if (!item) return;
  const group = store.getRunGroupById(Number(item.run_group_id));
  if (!group) return;
  const job = store.getJob(jobId);
  const runId = job && typeof job.run_id === "number" ? job.run_id : undefined;
  const run = runId !== undefined ? store.getRun(runId) : undefined;
  const projectId = run && typeof run.project_id === "number" ? run.project_id : typeof item.project_id === "number" ? item.project_id : undefined;
  const findings = projectId === undefined ? [] : store.listFindings(projectId).filter((finding) => runId === undefined || finding.run_id === runId);
  const settlement = settleWorkItem({ item, jobStatus: status, ...(error ? { jobError: error } : {}), ...(run ? { run } : {}), findings });
  store.settleWorkItemByJob(jobId, settlement.state, settlement.outcome, settlement.result, settlement.error);
  store.refreshRunGroupCompletion(Number(group.id));
  if (store.getRunGroupById(Number(group.id))?.state === "running") scheduleRunGroupWith(store, plane, Number(group.id));
}

function reconcileTerminalRunGroupItems(store: MetadataStore, plane: ControlPlane): void {
  for (const group of store.listRunGroups(10_000, 0)) {
    if (group.state !== "running" && group.state !== "paused") continue;
    for (const item of store.listWorkItems(Number(group.id))) {
      if (typeof item.job_id !== "number" || (item.state !== "queued" && item.state !== "claimed" && item.state !== "running")) continue;
      const job = store.getJob(item.job_id);
      const status = job?.status;
      if (status === "done" || status === "error" || status === "canceled") {
        settleRunGroupWorkItemWith(store, plane, item.job_id, status, typeof job?.error === "string" ? job.error : undefined);
      }
    }
  }
}

function parseStoredJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function optionalPositiveInt(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// ---- providers (model-strategy profiles) ----------------------------------

const THINKING = new Set<string>(THINKING_LEVELS);
const CLI_FALLBACK_PROVIDERS = ["claude-code", "codex-cli", "mock"];

// The providers pi-ai can drive (discovered at runtime) + our CLI fallbacks, for the editor.
function availableProviders(): string[] {
  let pi: string[] = [];
  try {
    pi = getProviders() as unknown as string[];
  } catch {
    pi = [];
  }
  return [...new Set([...pi, ...CLI_FALLBACK_PROVIDERS])].sort();
}

function availableModels(provider: string): Array<{ id: string; name: string; reasoning: boolean; thinkingLevels: ModelThinkingLevel[] }> {
  if (provider === "claude-code") {
    return [
      { id: "opus", name: "Opus (latest)", reasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh"] as ModelThinkingLevel[] },
      { id: "sonnet", name: "Sonnet (latest)", reasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh"] as ModelThinkingLevel[] },
      { id: "fable", name: "Fable (latest)", reasoning: true, thinkingLevels: ["low", "medium", "high", "xhigh"] as ModelThinkingLevel[] },
    ];
  }
  try {
    const models = getModels(provider as never);
    return (models ?? []).map((m) => ({
      id: String((m as { id: unknown }).id),
      name: String((m as { name?: unknown; id: unknown }).name ?? (m as { id: unknown }).id),
      reasoning: Boolean((m as { reasoning?: unknown }).reasoning),
      thinkingLevels: getSupportedThinkingLevels(m),
    }));
  } catch {
    return [];
  }
}

// Coerce a request body into a ProviderInput (drop unknown thinking levels; pass roles through).
function readProviderInput(body: Record<string, unknown>): Partial<ProviderInput> {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out: Partial<ProviderInput> = {};
  const name = str(body.name); if (name) out.name = name;
  const provider = str(body.provider); if (provider) out.provider = provider;
  if ("model" in body) out.model = str(body.model);
  if ("thinking" in body) { const t = str(body.thinking); out.thinking = t && THINKING.has(t) ? t : undefined; }
  if ("roles" in body && body.roles && typeof body.roles === "object") out.roles = body.roles as ProviderInput["roles"];
  return out;
}

async function providerCreate(c: Ctx): Promise<void> {
  const input = readProviderInput((await readBody(c.req)) as Record<string, unknown>);
  if (!input.name || !input.provider) return sendJson(c.res, 400, { error: "name and provider are required" });
  if (c.store.getProviderByName(input.name)) return sendJson(c.res, 409, { error: `a provider named "${input.name}" already exists` });
  const id = c.store.createProvider({ name: input.name, provider: input.provider, model: input.model, thinking: input.thinking, roles: input.roles });
  sendJson(c.res, 200, { ok: true, id });
}

async function providerUpdate(c: Ctx): Promise<void> {
  const id = Number(c.params.id);
  if (!c.store.getProvider(id)) return sendJson(c.res, 404, { error: "no such provider" });
  const input = readProviderInput((await readBody(c.req)) as Record<string, unknown>);
  if (input.name) {
    const clash = c.store.getProviderByName(input.name);
    if (clash && clash.id !== id) return sendJson(c.res, 409, { error: `a provider named "${input.name}" already exists` });
  }
  c.store.updateProvider(id, input);
  sendJson(c.res, 200, { ok: true });
}

async function daemonCreate(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return sendJson(c.res, 400, { error: "name is required" });
  const { id, token } = c.store.createDaemonToken(name); // token is returned ONCE — the UI must surface it now
  sendJson(c.res, 200, { ok: true, id, name, token });
}

async function daemonRename(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return sendJson(c.res, 400, { error: "name is required" });
  const ok = c.store.renameDaemon(Number(c.params.id), name);
  ok ? sendJson(c.res, 200, { ok: true }) : sendJson(c.res, 404, { error: "no such daemon" });
}

const TRACKING_STATES = new Set(["open", "triaging", "submitted", "accepted", "fixed", "duplicate", "rejected", "ignored"]);
async function findingTracking(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : "";
  if (!TRACKING_STATES.has(status)) return sendJson(c.res, 400, { error: "invalid tracking status", allowed: [...TRACKING_STATES] });
  const id = Number(c.params.id);
  const finding = c.store.getFinding(id);
  if (!finding) return sendJson(c.res, 404, { error: "no such finding" });
  const rawDuplicateOf = body.duplicateOfFindingId ?? body.duplicate_of_finding_id;
  let duplicateOfFindingId: number | null = null;
  if (rawDuplicateOf !== undefined && rawDuplicateOf !== null && rawDuplicateOf !== "") {
    const parsed = Number(rawDuplicateOf);
    if (!Number.isInteger(parsed) || parsed <= 0) return sendJson(c.res, 400, { error: "duplicateOfFindingId must be a positive integer" });
    if (parsed === id) return sendJson(c.res, 400, { error: "a finding cannot be marked duplicate of itself" });
    const target = c.store.getFinding(parsed);
    if (!target) return sendJson(c.res, 400, { error: "duplicate target finding does not exist" });
    if (Number(target.project_id) !== Number(finding.project_id)) return sendJson(c.res, 400, { error: "duplicate target must be in the same project" });
    if (String(target.tracking_status ?? "") === "duplicate") {
      const canonical = Number(target.duplicate_of_finding_id ?? 0);
      return sendJson(c.res, 400, { error: canonical > 0 ? `duplicate target is itself a duplicate; use canonical finding ${canonical}` : "duplicate target has no canonical finding link" });
    }
    duplicateOfFindingId = parsed;
  }
  if (status === "duplicate" && duplicateOfFindingId === null) {
    return sendJson(c.res, 400, { error: "duplicateOfFindingId is required when status is duplicate" });
  }
  const ok = c.store.setFindingTracking(id, status, duplicateOfFindingId);
  ok ? sendJson(c.res, 200, { ok: true }) : sendJson(c.res, 404, { error: "no such finding" });
}

// Serve a run's raw artifact (text) from its run dir. Allowlisted filenames only (no slashes,
// so no path traversal); the file must resolve directly inside the run dir.
const ALLOWED_ARTIFACT = /^(audit_report\.md|confirm_report\.md|report_[a-z0-9_.-]+\.md|prepare_manifest\.json|confirm_decision\.json|impact_inventory\.json|confirm_provenance\.json|audit_findings\.json|run_health\.json|coverage_gaps\.json|resource_requests\.json|followup_scopes\.json)$/;
function runArtifact(c: Ctx): void {
  const run = c.store.getRun(Number(c.params.id));
  if (!run || !run.run_dir) return sendJson(c.res, 404, { error: "no such run, or it has no run dir" });
  const name = c.url.searchParams.get("name") || "audit_report.md";
  if (!ALLOWED_ARTIFACT.test(name)) return sendJson(c.res, 400, { error: "artifact not allowed", name });
  const runDir = path.resolve(String(run.run_dir));
  const files = name === "prepare_manifest.json"
    ? [
        path.join(runDir, "prepare", "workspace", "prepare_manifest.json"),
        path.join(runDir, name),
      ]
    : [path.join(runDir, name)];
  for (const file of files) {
    const resolved = path.resolve(file);
    if (resolved !== runDir && !resolved.startsWith(runDir + path.sep)) return sendJson(c.res, 400, { error: "bad path" });
    try {
      const text = readFileSync(resolved, "utf8");
      c.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      c.res.end(text);
      return;
    } catch {
      // Try the next artifact candidate.
    }
  }
  return sendJson(c.res, 404, { error: "artifact not found", name });
}

function runStop(c: Ctx): void {
  const id = Number(c.params.id);
  const run = c.store.getRun(id);
  if (!run) return sendJson(c.res, 404, { error: "no such run" });
  const job = c.store.getJobByRun(id);
  if (job) {
    c.store.cancelRunJob(Number(job.id));
    c.plane.cancel(Number(job.id)); // nudge the executing daemon to abort
  }
  if (run.status === "running") c.store.finishRun(id, "killed");
  sendJson(c.res, 200, { stopped: Boolean(job) || run.status === "running" });
}

async function runUpdate(c: Ctx): Promise<void> {
  const id = Number(c.params.id);
  const run = c.store.getRun(id);
  if (!run) return sendJson(c.res, 404, { error: "no such run" });
  if (run.status !== "running") return sendJson(c.res, 409, { error: "only running runs can be adjusted" });
  const body = (await readBody(c.req)) as Record<string, unknown>;
  if (run.run_scopes_target == null) return sendJson(c.res, 409, { error: "run has not entered a scope batch yet" });
  const resolved = resolveRunningRunTarget(c.store, run, body);
  if ("error" in resolved) return sendJson(c.res, resolved.status, { error: resolved.error });
  const target = resolved.target;
  c.store.updateRunScopesTarget(id, target);
  const job = c.store.getJobByRun(id);
  if (job) c.plane.setRunScopesTarget(Number(job.id), target);
  sendJson(c.res, 200, { ok: true, runScopesTarget: target, applied: Boolean(job), ...resolved.meta });
}

type RunningRunTargetResolution =
  | { target: number; meta: Record<string, unknown> }
  | { error: string; status: number };

function resolveRunningRunTarget(store: MetadataStore, run: Record<string, unknown>, body: Record<string, unknown>): RunningRunTargetResolution {
  const direct = body.runScopesTarget ?? body.maxScopes;
  const mode = body.scopeCoverageMode ?? body.coverageMode;
  if (mode !== undefined) return resolveRunningCoverageModeTarget(store, run, body, mode);
  if (body.coverageTarget !== undefined) {
    const coverageTarget = positiveWholeNumber(body.coverageTarget, "coverageTarget");
    if ("error" in coverageTarget) return coverageTarget;
    return {
      target: cumulativeRunningRunTarget(run, currentRunProgress(store, run), coverageTarget.value),
      meta: { coverageTarget: coverageTarget.value },
    };
  }
  if (direct === undefined) return { error: "runScopesTarget, scopeCoverageMode, or coverageTarget is required", status: 400 };
  const target = positiveWholeNumber(direct, "runScopesTarget");
  if ("error" in target) return target;
  return { target: target.value, meta: {} };
}

function resolveRunningCoverageModeTarget(store: MetadataStore, run: Record<string, unknown>, body: Record<string, unknown>, modeInput: unknown): RunningRunTargetResolution {
  if (modeInput !== "focused" && modeInput !== "standard" && modeInput !== "half" && modeInput !== "full" && modeInput !== "custom") {
    return { error: "scopeCoverageMode must be focused|standard|half|full|custom", status: 400 };
  }
  if (modeInput === "custom") {
    const target = positiveWholeNumber(body.runScopesTarget ?? body.maxScopes, "maxScopes");
    if ("error" in target) return target;
    return { target: target.value, meta: { coverageMode: "custom" } };
  }
  const progress = currentRunProgress(store, run);
  const done = Math.max(0, Math.floor(numberValue(run.run_scopes_done)));
  if (modeInput === "focused") {
    return { target: cumulativeRunningRunTarget(run, progress, 10), meta: { coverageMode: "focused", coverageTarget: 10 } };
  }
  if (modeInput === "standard") {
    return { target: cumulativeRunningRunTarget(run, progress, 30), meta: { coverageMode: "standard", coverageTarget: 30 } };
  }
  if (modeInput === "half") return { target: Math.max(done, done + Math.ceil(progress.pending / 2)), meta: { coverageMode: "half" } };
  return { target: Math.max(done, done + progress.pending), meta: { coverageMode: "full" } };
}

function cumulativeRunningRunTarget(run: Record<string, unknown>, progress: Coverage, projectTarget: number): number {
  const done = Math.max(0, Math.floor(numberValue(run.run_scopes_done)));
  return Math.max(done, done + cumulativeCoverageLimit(projectTarget, progress));
}

function currentRunProgress(store: MetadataStore, run: Record<string, unknown>): Coverage {
  const projectId = numberValue(run.project_id);
  if (projectId > 0) {
    const stored = store.scopeProgress(projectId);
    if (stored.total > 0) return stored;
  }
  const total = Math.max(0, Math.floor(numberValue(run.scopes_total)));
  const audited = Math.max(0, Math.floor(numberValue(run.scopes_audited)));
  const pending = Math.max(0, Math.floor(numberValue(run.scopes_pending)));
  return { total, audited, pending, deferred: Math.max(0, total - audited - pending) };
}

function positiveWholeNumber(input: unknown, label: string): { value: number } | { error: string; status: number } {
  if (typeof input !== "number" || !Number.isFinite(input)) return { error: `${label} must be a number`, status: 400 };
  if (input < 1) return { error: `${label} must be at least 1`, status: 400 };
  return { value: Math.floor(input) };
}

function runLog(c: Ctx): void {
  const id = Number(c.params.id);
  const run = c.store.getRun(id);
  if (!run) return sendJson(c.res, 404, { error: "no such run" });
  const bus = c.plane.bus(id);
  const wantsJson = c.url.searchParams.has("tail") || c.url.searchParams.get("format") === "json";
  if (wantsJson) {
    const limit = clampInt(c.url.searchParams.get("tail"), 200, 1, 2000);
    return sendJson(c.res, 200, { runId: id, events: combinedRunActivity(run, bus, limit), limit });
  }
  // One authoritative replay: persisted block events plus the compacted live
  // buffer, already sorted and deduplicated. Subscribing must then be live-only;
  // replaying the bus a second time is what used to duplicate recent activity.
  streamFromBus(c.res, bus, [
    ...combinedRunActivity(run, bus, 200),
    currentRunActivityStreamState(c, run),
  ]);
}

function currentRunActivityStreamState(c: Ctx, run: Record<string, unknown>): Record<string, unknown> {
  const projectId = Number(run.project_id);
  const activeStreams = run.status === "running" && Number.isFinite(projectId)
    ? c.store.listScopes(projectId)
      .filter((scope) => scope.status === "auditing")
      .map((scope) => stringValue(scope.scope_id))
      .filter(Boolean)
    : [];
  return { kind: "activity_stream_state", activeStreams, ts: new Date().toISOString() };
}

function streamFromBus(res: ServerResponse, bus: ActivityBus, replay: Array<Record<string, unknown>> = []): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": open\n\n"); // flush headers immediately so the client's EventSource opens even before the first event
  for (const ev of replay) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  let unsubscribe = (): void => {};
  unsubscribe = bus.subscribe((ev) => {
    try {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      unsubscribe();
    }
  }, false);
  res.on("close", () => unsubscribe());
}

function combinedRunActivity(run: Record<string, unknown>, bus: ActivityBus, limit: number): Array<Record<string, unknown>> {
  const events = [...persistedRunActivity(run, limit), ...compactLiveActivity(bus.snapshot(2000))];
  return dedupeRunActivity(events.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))).slice(-limit);
}

function dedupeRunActivity(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Map<string, { index: number; ts: number }>();
  for (const event of events) {
    const key = activityDedupeKey(event);
    if (!key) {
      out.push(event);
      continue;
    }
    const ts = activityTs(event);
    const prior = seen.get(key.key);
    if (prior && Math.abs(ts - prior.ts) <= key.windowMs) {
      const existing = out[prior.index];
      if (existing) {
        out[prior.index] = richerActivityEvent(existing, event);
        seen.set(key.key, { index: prior.index, ts });
        continue;
      }
    }
    seen.set(key.key, { index: out.length, ts });
    out.push(event);
  }
  return out;
}

function activityDedupeKey(event: Record<string, unknown>): { key: string; windowMs: number } | undefined {
  const kind = stringValue(event.kind);
  if (!kind) return undefined;
  const stream = stringValue(event.streamId);
  if (kind === "audit_thinking" || kind === "audit_text") {
    const body = normalizedActivityKey(activityBody(event));
    return body ? { key: `${kind}:${stream}:${body}`, windowMs: 30_000 } : undefined;
  }
  if (kind === "step") {
    const step = numberValue(event.step);
    const tool = stringValue(event.tool);
    return step > 0 ? { key: `${kind}:${stream}:${tool}:${step}`, windowMs: 10_000 } : undefined;
  }
  if (kind === "artifact") {
    const name = stringValue(event.name);
    const file = stringValue(event.path);
    const id = name || file;
    return id ? { key: `${kind}:${name}:${file}`, windowMs: 5_000 } : undefined;
  }
  return undefined;
}

function activityBody(event: Record<string, unknown>): string {
  return stringValue(event.text) || stringValue(event.detail) || stringValue(event.result) || stringValue(event.delta);
}

function normalizedActivityKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function activityTs(event: Record<string, unknown>): number {
  const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

function richerActivityEvent(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  return activityRichness(b) > activityRichness(a) ? b : a;
}

function activityRichness(event: Record<string, unknown>): number {
  return Object.keys(event).length * 10 + activityBody(event).length + (typeof event.text === "string" ? 50 : 0);
}

export function compactLiveActivity(events: Activity[]): Array<Record<string, unknown>> {
  type Pending = { kind: "audit_thinking" | "audit_text"; body: string; ts?: string; streamId?: string; order: number };
  const out: Array<{ order: number; event: Record<string, unknown> }> = [];
  const pending = new Map<string, Pending>();
  const streamKey = (event: Activity): string => event.streamId?.trim() || "legacy";
  const flush = (key: string): void => {
    const item = pending.get(key);
    if (!item) return;
    const body = item.body.trim();
    if (body) out.push({
      order: item.order,
      event: { kind: item.kind, ts: item.ts, detail: body, ok: true, ...(item.streamId ? { streamId: item.streamId } : {}) },
    });
    pending.delete(key);
  };

  for (const [order, ev] of events.entries()) {
    const key = streamKey(ev);
    const nextKind = ev.kind === "thinking_delta" ? "audit_thinking" : ev.kind === "text_delta" ? "audit_text" : undefined;
    if (!nextKind) {
      flush(key);
      out.push({ order, event: { ts: ev.ts, ...ev } });
      continue;
    }
    const current = pending.get(key);
    if (current && current.kind !== nextKind) flush(key);
    const next = pending.get(key);
    const item: Pending = {
      kind: nextKind,
      body: `${next?.body ?? ""}${ev.delta ?? ""}`,
      ...(ev.streamId ? { streamId: ev.streamId } : {}),
      order,
    };
    const ts = ev.ts ?? next?.ts;
    if (ts) item.ts = ts;
    pending.set(key, item);
  }
  for (const key of pending.keys()) flush(key);
  return out.sort((a, b) => a.order - b.order).map((item) => item.event);
}

function persistedRunActivity(run: Record<string, unknown>, limit: number): Array<Record<string, unknown>> {
  const runDir = typeof run.run_dir === "string" ? path.resolve(run.run_dir) : "";
  if (!runDir) return [];
  const file = path.join(runDir, "events.jsonl");
  if (path.dirname(file) !== runDir) return [];
  let lines: string[];
  try {
    lines = readTailLines(file, limit);
  } catch {
    return [];
  }
  return lines.flatMap((line) => {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      return [persistedEventToActivity(rec)];
    } catch {
      return [];
    }
  });
}

function persistedEventToActivity(rec: Record<string, unknown>): Record<string, unknown> {
  const kind = typeof rec.kind === "string" ? rec.kind : "event";
  const payload = omitKeys(rec, ["ts", "kind"]);
  const detail =
    typeof rec.error === "string" ? rec.error :
    typeof rec.detail === "string" ? rec.detail :
    typeof rec.text === "string" ? rec.text :
    typeof rec.result === "string" ? rec.result :
    typeof rec.name === "string" ? `wrote ${rec.name}` :
    compactJson(payload);
  const ok =
    typeof rec.ok === "boolean" ? rec.ok :
    typeof rec.passed === "boolean" ? rec.passed :
    !/error|failed|refuted/i.test(kind);
  return { kind, ts: rec.ts, ...payload, detail, ok };
}

function omitKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (!keys.includes(key)) out[key] = value;
  return out;
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

// ---- daemon (execution-plane) handlers -----------------------------------------------

// Authenticate a daemon by its bearer token. On failure, sends 401 and returns null.
function daemonAuth(c: Ctx): Record<string, unknown> | null {
  const header = c.req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const daemon = token ? c.store.getDaemonByToken(token) : undefined;
  if (!daemon) {
    sendJson(c.res, 401, { error: "unauthorized: a valid daemon bearer token is required" });
    return null;
  }
  return daemon;
}

function authorizedDaemonJob(c: Ctx, daemon: Record<string, unknown>, jobId: number): Record<string, unknown> | null {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    sendJson(c.res, 400, { error: "a valid job id is required" });
    return null;
  }
  const job = c.store.getJob(jobId);
  if (!job) {
    sendJson(c.res, 404, { error: "no such job" });
    return null;
  }
  if (Number(job.daemon_id) !== Number(daemon.id)) {
    sendJson(c.res, 403, { error: "job is assigned to another daemon" });
    return null;
  }
  return job;
}

function authorizedDaemonRun(c: Ctx, daemon: Record<string, unknown>, runId: number): { run: Record<string, unknown>; job: Record<string, unknown> } | null {
  if (!Number.isInteger(runId) || runId <= 0) {
    sendJson(c.res, 400, { error: "a valid run id is required" });
    return null;
  }
  const run = c.store.getRun(runId);
  if (!run) {
    sendJson(c.res, 404, { error: "no such run" });
    return null;
  }
  const job = c.store.getJobByRun(runId);
  if (!job || Number(job.daemon_id) !== Number(daemon.id)) {
    sendJson(c.res, 403, { error: "run is assigned to another daemon" });
    return null;
  }
  return { run, job };
}

/** Historical artifact replay is authorized by the immutable executor stamped on
 * the run, never by job.run_id (which intentionally follows the active phase). */
function authorizedDaemonOwnedRun(c: Ctx, daemon: Record<string, unknown>, runId: number): Record<string, unknown> | null {
  if (!Number.isInteger(runId) || runId <= 0) {
    sendJson(c.res, 400, { error: "a valid run id is required" });
    return null;
  }
  const run = c.store.getRun(runId);
  if (!run) {
    sendJson(c.res, 404, { error: "no such run" });
    return null;
  }
  if (Number(run.daemon_id) !== Number(daemon.id)) {
    sendJson(c.res, 403, { error: "run is assigned to another daemon" });
    return null;
  }
  return run;
}

async function daemonRegister(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { name?: string; capabilities?: unknown; workspace?: string };
  c.store.touchDaemon(Number(daemon.id), body.capabilities, body.workspace);
  sendJson(c.res, 200, { ok: true, daemonId: Number(daemon.id), name: daemon.name });
}

async function daemonHeartbeat(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { instanceId?: unknown; activeJobIds?: unknown };
  const instanceId = typeof body.instanceId === "string" && body.instanceId.trim() ? body.instanceId.trim() : "default";
  const activeJobIds = Array.isArray(body.activeJobIds)
    ? body.activeJobIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)
    : [];
  c.store.touchDaemon(Number(daemon.id));
  c.plane.updateDaemonJobs(Number(daemon.id), instanceId, activeJobIds);
  const reconciled = reconcileLostExecutorJobs(c.store, c.plane);
  sendJson(c.res, 200, { ok: true, activeJobIds, reconciled });
}

function daemonStream(c: Ctx): void {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  c.store.touchDaemon(Number(daemon.id));
  c.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  c.plane.addDaemon(c.res, Number(daemon.id));
  c.res.write(`data: ${JSON.stringify({ type: "poll" })}\n\n`); // drain any backlog on connect
  const keepalive = setInterval(() => {
    try {
      c.res.write(`: keepalive\n\n`);
      c.store.touchDaemon(Number(daemon.id)); // refresh last_seen while the stream is connected → accurate "online"
    } catch {
      /* closed */
    }
  }, 25_000);
  c.res.on("close", () => {
    clearInterval(keepalive);
    c.plane.removeDaemon(c.res);
  });
}

function daemonClaim(c: Ctx): void {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const job = c.store.claimJob(Number(daemon.id));
  sendJson(c.res, 200, job ? { job } : {});
}

async function daemonReconciliationWorklist(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { beforeId?: unknown; limit?: unknown };
  const beforeId = body.beforeId === undefined ? undefined : Number(body.beforeId);
  if (beforeId !== undefined && (!Number.isInteger(beforeId) || beforeId <= 0)) {
    return sendJson(c.res, 400, { error: "beforeId must be a positive integer" });
  }
  const requestedLimit = body.limit === undefined ? VERIFY_ARTIFACT_RECONCILIATION_LIMIT : Number(body.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    return sendJson(c.res, 400, { error: "limit must be a positive integer" });
  }
  const rows = c.store.listDaemonArtifactReconciliationRuns(
    Number(daemon.id),
    VERIFY_ARTIFACT_RECONCILIATION_VERSION,
    beforeId,
    Math.min(requestedLimit, 100),
  );
  sendJson(c.res, 200, {
    version: VERIFY_ARTIFACT_RECONCILIATION_VERSION,
    runs: rows.map((run) => ({ runId: run.id, runDir: run.run_dir })),
    ...(rows.length > 0 ? { nextBeforeId: rows[rows.length - 1]!.id } : {}),
  });
}

async function daemonReconcileRunArtifacts(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const runId = Number(c.params.id);
  const run = authorizedDaemonOwnedRun(c, daemon, runId);
  if (!run) return;
  if (run.status === "running") return sendJson(c.res, 409, { error: "only terminal runs can replay artifacts" });
  if (!daemonRunIsVerify(run)) return sendJson(c.res, 400, { error: "only verify runs can replay verdict artifacts" });

  const body = (await readBody(c.req)) as { version?: unknown; artifacts?: unknown };
  if (body.version !== VERIFY_ARTIFACT_RECONCILIATION_VERSION) {
    return sendJson(c.res, 409, { error: "unsupported artifact reconciliation version", version: VERIFY_ARTIFACT_RECONCILIATION_VERSION });
  }
  if (!Array.isArray(body.artifacts) || body.artifacts.length > MAX_VERIFY_ARTIFACT_REPLAY_ROWS) {
    return sendJson(c.res, 400, { error: `artifacts must be an array of at most ${MAX_VERIFY_ARTIFACT_REPLAY_ROWS} rows` });
  }
  if (Buffer.byteLength(JSON.stringify(body.artifacts), "utf8") > MAX_VERIFY_ARTIFACT_REPLAY_BYTES) {
    return sendJson(c.res, 413, { error: "artifact replay payload is too large" });
  }
  const artifacts = normalizeVerifyArtifactReplay(body.artifacts);
  if (!artifacts) return sendJson(c.res, 400, { error: "artifact replay rows must be unique negative verify verdicts with positive origin ids" });
  const applied = c.store.reconcileTerminalVerifyArtifacts(runId, artifacts, VERIFY_ARTIFACT_RECONCILIATION_VERSION);
  if (!applied) return sendJson(c.res, 409, { error: "run is not eligible for artifact reconciliation" });
  sendJson(c.res, 200, { ok: true, version: VERIFY_ARTIFACT_RECONCILIATION_VERSION, verdicts: artifacts.length });
}

function daemonRunIsVerify(run: Record<string, unknown>): boolean {
  if (run.kind === "verify") return true;
  const budgets = safeParse(run.budgets_json);
  return Boolean(budgets && typeof budgets === "object" && !Array.isArray(budgets) && (budgets as Record<string, unknown>).verify === true);
}

function normalizeVerifyArtifactReplay(input: unknown[]): Array<Record<string, unknown>> | null {
  const allowedText = ["title", "location", "severity", "scopeId", "scope_id", "description", "evidence", "exploitSketch", "exploit_sketch", "fix", "confirmationStatus", "status"] as const;
  const seen = new Set<number>();
  const rows: Array<Record<string, unknown>> = [];
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const originId = positiveIntegerId(raw.originId ?? raw.origin_id);
    if (originId === undefined || seen.has(originId)) return null;
    const title = typeof raw.title === "string" ? raw.title : "";
    const status = typeof (raw.confirmationStatus ?? raw.status) === "string" ? String(raw.confirmationStatus ?? raw.status) : "";
    if (!/^\s*REFUTED\s*:/i.test(title) && status !== "suspected") return null;
    const row: Record<string, unknown> = { originId };
    for (const key of allowedText) {
      const field = raw[key];
      if (field === undefined) continue;
      if (typeof field !== "string" || field.length > 1_000_000) return null;
      row[key] = field;
    }
    if (raw.confidence !== undefined) {
      if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) return null;
      row.confidence = raw.confidence;
    }
    seen.add(originId);
    rows.push(row);
  }
  return rows;
}

async function daemonRunStart(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { jobId?: number; project?: string; kind?: RunKind; runDir?: string; provider?: string; model?: string; thinking?: string; budgets?: unknown; additional?: boolean };
  const name = (body.project ?? "").trim();
  if (!name || !body.runDir) return sendJson(c.res, 400, { error: "project and runDir are required" });
  if (typeof body.jobId !== "number" || !Number.isFinite(body.jobId)) return sendJson(c.res, 400, { error: "jobId is required" });
  const job = authorizedDaemonJob(c, daemon, body.jobId);
  if (!job) return;
  if (name !== String(job.project)) return sendJson(c.res, 403, { error: "run project does not match the claimed job" });
  if (body.kind !== undefined && !isRunKind(body.kind)) return sendJson(c.res, 400, { error: "kind must be run, map, audit, verify, confirm, prepare, or report" });
  const additional = body.additional === true;
  if (job.run_id != null && !additional) return sendJson(c.res, 200, { runId: Number(job.run_id), existing: true });
  if ((!additional && job.status !== "dispatched") || (additional && job.status !== "running")) {
    return sendJson(c.res, 409, { error: additional ? "pipeline phase can only be appended to a running job" : "job must be claimed before starting a run" });
  }
  const workItem = c.store.getWorkItemByJob(body.jobId);
  // Evaluation jobs may carry an older target-shaped queue name from a pre-isolation DB.
  // The durable work-item identity is authoritative, so both old queued jobs and new ones
  // land in a hidden evaluation project instead of reusing a same-named operator project.
  const trackingName = workItem ? evaluationTrackingProjectName(workItem) : name;
  const existing = c.store.getProject(trackingName);
  const expectedOrigin = workItem ? "evaluation" : "project";
  if (existing && existing.origin !== expectedOrigin) {
    return sendJson(c.res, 409, { error: `${expectedOrigin} tracking identity collides with an existing ${String(existing.origin)} project` });
  }
  const projectId = existing
    ? Number(existing.id)
    : c.store.upsertProject({ name: trackingName, origin: expectedOrigin, config: body.budgets });
  const runId = c.store.startRun({
    projectId,
    daemonId: Number(daemon.id),
    kind: body.kind ?? "run",
    runDir: body.runDir,
    provider: body.provider,
    model: body.model,
    thinking: body.thinking,
    budgets: body.budgets,
  });
  c.store.setJobRun(body.jobId, runId); // link job → current run (so stop can find the active phase)
  sendJson(c.res, 200, { runId });
}

async function daemonRunUpdate(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const runId = Number(c.params.id);
  const authorized = authorizedDaemonRun(c, daemon, runId);
  if (!authorized) return;
  const { run } = authorized;
  if (run.status !== "running") return sendJson(c.res, 200, { ok: true, stale: true });
  const projectId = Number(run.project_id);
  const body = (await readBody(c.req)) as {
    scopes?: Parameters<MetadataStore["replaceScopes"]>[1];
    findings?: Parameters<MetadataStore["upsertFindings"]>[2];
    findingReports?: Array<{ findingId?: number; decisionId?: number; markdown?: string }>;
    reason?: string;
    confirmDecisions?: Parameters<MetadataStore["upsertConfirmDecisions"]>[2];
    decisionPath?: string;
    runScopes?: { done: number; target: number };
    materialFingerprint?: string;
    phaseAttempt?: Parameters<MetadataStore["recordFindingPhaseAttempt"]>[2];
    stage?: { name: string; info: Record<string, unknown> };
    health?: Parameters<MetadataStore["recordRunHealth"]>[1];
    backlog?: Parameters<MetadataStore["replaceDiscoveryBacklog"]>[2];
    finish?: { status: Parameters<MetadataStore["finishRun"]>[1]; coverage?: Coverage; findingsTotal?: number };
  };
  if (body.finish && !isRunTerminalStatus(body.finish.status)) return sendJson(c.res, 400, { error: "finish.status must be done, error, or killed" });
  if (body.scopes) {
    c.store.replaceScopes(projectId, body.scopes);
    c.store.updateRunCoverage(runId, c.store.scopeProgress(projectId));
  }
  if (body.runScopes) c.store.updateRunScopes(runId, body.runScopes.done, body.runScopes.target);
  if (typeof body.materialFingerprint === "string" && body.materialFingerprint.trim()) c.store.updateRunMaterialFingerprint(runId, body.materialFingerprint.trim());
  if (body.phaseAttempt) c.store.recordFindingPhaseAttempt(projectId, runId, body.phaseAttempt);
  if (body.stage) c.store.recordStage(runId, body.stage.name, body.stage.info);
  if (body.health) c.store.recordRunHealth(runId, body.health);
  if (body.backlog) c.store.replaceDiscoveryBacklog(projectId, runId, body.backlog);
  if (body.findings) c.store.upsertFindings(projectId, runId, body.findings, body.reason);
  if (body.findingReports) {
    for (const report of body.findingReports) {
      if (typeof report.decisionId === "number" && typeof report.markdown === "string" && report.markdown.trim()) {
        c.store.setConfirmDecisionReport(projectId, report.decisionId, report.markdown);
      } else if (typeof report.findingId === "number" && typeof report.markdown === "string" && report.markdown.trim()) {
        c.store.setFindingReport(projectId, report.findingId, report.markdown);
      }
    }
  }
  if (body.confirmDecisions) {
    c.store.upsertConfirmDecisions(projectId, runId, body.confirmDecisions, body.decisionPath);
    const health = confirmDecisionRunHealth(body.confirmDecisions);
    if (health) c.store.recordRunHealth(runId, health);
  }
  if (body.finish) c.store.finishRun(runId, body.finish.status, body.finish.coverage, body.finish.findingsTotal);
  c.store.touchJobByRun(runId);
  sendJson(c.res, 200, { ok: true });
}

async function daemonRunActivity(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const runId = Number(c.params.id);
  const authorized = authorizedDaemonRun(c, daemon, runId);
  if (!authorized) return;
  const { run } = authorized;
  if (run.status !== "running") return sendJson(c.res, 200, { ok: true, stale: true });
  const body = (await readBody(c.req)) as { events?: Array<{ kind: string; delta?: string; tool?: string; step?: number; streamId?: string }> };
  if (body.events !== undefined && !Array.isArray(body.events)) return sendJson(c.res, 400, { error: "events must be an array" });
  const events = (body.events ?? []).slice(0, 1000);
  if (events.some((ev) => !ev || typeof ev !== "object" || typeof ev.kind !== "string")) {
    return sendJson(c.res, 400, { error: "each activity event requires a string kind" });
  }
  if (events.some((ev) => ev.streamId !== undefined && (typeof ev.streamId !== "string" || !ev.streamId.trim() || ev.streamId.length > 200))) {
    return sendJson(c.res, 400, { error: "activity streamId must be a non-empty string of at most 200 characters" });
  }
  const bus = c.plane.bus(runId);
  for (const ev of events) bus.push(ev);
  sendJson(c.res, 200, { ok: true });
}

async function daemonPipelineWorklist(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { jobId?: number; project?: string; phase?: string; verifyFromStart?: boolean };
  if (typeof body.jobId !== "number") return sendJson(c.res, 400, { error: "jobId is required" });
  const job = authorizedDaemonJob(c, daemon, body.jobId);
  if (!job) return;
  if (job.status !== "running") return sendJson(c.res, 409, { error: "pipeline worklists require a running job" });
  const projectName = typeof body.project === "string" ? body.project.trim() : "";
  if (!projectName) return sendJson(c.res, 400, { error: "project is required" });
  if (projectName !== String(job.project)) return sendJson(c.res, 403, { error: "pipeline project does not match the claimed job" });
  const phase = body.phase === "verify" || body.phase === "confirm" || body.phase === "report" ? body.phase : "";
  if (!phase) return sendJson(c.res, 400, { error: "phase must be verify, confirm, or report" });
  const project = c.store.getProject(projectName);
  if (!project) return sendJson(c.res, 404, { error: `no project named ${projectName}` });

  const projectId = Number(project.id);
  const allRuns = c.store.listRuns(projectId);
  const materialBoundary = latestPrepareRun(allRuns);
  const currentRuns = currentMaterialRuns(allRuns, materialBoundary);
  const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
  const currentResultRunIds = runIdSet(currentResultRuns(currentRuns, scopeBoundary));
  const requiresRealTargetConfirmation = projectRequiresRealTargetConfirmation(project, allRuns);

  if (phase === "verify") {
    const verifyFindings = verifyWorklist(c.store, projectId, currentResultRunIds, materialBoundary, body.verifyFromStart === true);
    return sendJson(c.res, 200, {
      phase,
      verifyFromStart: body.verifyFromStart === true,
      verifyFindings,
    });
  }

  if (phase === "confirm") {
    if (!requiresRealTargetConfirmation) {
      return sendJson(c.res, 200, { phase, requiresRealTargetConfirmation, inputRunDirs: [], confirmKeys: [] });
    }
    const currentDecisions = currentConfirmDecisions(c.store.listConfirmDecisions(projectId).filter((row) => rowBelongsToCurrentMaterial(row, currentResultRunIds, materialBoundary)));
    const pending = confirmWorkRows(c.store, projectId, currentResultRunIds, materialBoundary, currentDecisions);
    if (pending.length === 0) {
      return sendJson(c.res, 200, { phase, requiresRealTargetConfirmation, inputRunDirs: [], confirmKeys: [] });
    }
    const rows = pending;
    const conflictRetryKeys = new Set(rows
      .filter((row) => row.refutation_status === "conflict")
      .map((row) => stringValue((row as Record<string, unknown>).finding_key).toLowerCase())
      .filter(Boolean));
    const settledRows = currentDecisions.filter((decision) =>
      !confirmDecisionMemberKeys(decision).some((key) => conflictRetryKeys.has(key)));
    return sendJson(c.res, 200, {
      phase,
      requiresRealTargetConfirmation,
      inputRunDirs: [...new Set(rows.map((row) => confirmableRunDir(row as unknown as Record<string, unknown>)).filter(Boolean))],
      inputRunDir: rows[0] ? confirmableRunDir(rows[0] as unknown as Record<string, unknown>) || undefined : undefined,
      confirmKeys: rows.flatMap((row) => confirmSelectorsForFinding(row as unknown as { id?: unknown; finding_key?: unknown })),
      confirmFindings: confirmFindingSeeds(c.store, projectId, rows),
      confirmSettledRows: confirmSettledRows(settledRows),
    });
  }

  const reports = reportWorklist(c.store, projectId, [], currentResultRunIds, materialBoundary, requiresRealTargetConfirmation);
  sendJson(c.res, 200, {
    phase,
    requiresRealTargetConfirmation,
    reportFindings: reports.findings ?? [],
    ...(reports.error ? { skipReason: reports.error } : {}),
  });
}

function verifyWorklist(store: MetadataStore, projectId: number, currentResultRunIds: Set<number>, materialBoundary?: Record<string, unknown>, fromStart = false): unknown[] {
  return reportableFindings(store.listFindings(projectId)
    .filter((row) => rowBelongsToCurrentMaterial(row, currentResultRunIds, materialBoundary))
    .filter((row) => !isIgnoredFinding(row)))
    .filter((row) => {
      const status = String(row.status ?? "");
      if (row.refutation_status === "conflict"
        && store.hasFindingPhaseRetry(projectId, "finding", Number(row.id), "verify")) return true;
      if (status === "suspected" || status === "confirmed-source") return true;
      if (!fromStart || row.confirm_status != null) return false;
      return status === "confirmed-executable" || status === "confirmed-differential";
    })
    .map((row) => {
      const inputFingerprint = findingPhaseFingerprint(store, row, "verify", materialBoundary);
      return { row, inputFingerprint };
    })
    .filter(({ row, inputFingerprint }) => store.phaseEligible(projectId, "finding", Number(row.id), "verify", inputFingerprint))
    .map(({ row, inputFingerprint }) => ({
      ...(normalizeProjectVerifyFindings(store, projectId, findingDetailRow(row)) as Record<string, unknown>),
      _phaseAttempt: { subjectType: "finding", subjectId: Number(row.id), inputFingerprint },
    }));
}

function findingPhaseFingerprint(store: MetadataStore, row: Record<string, unknown>, phase: "verify" | "confirm" | "report", boundary?: Record<string, unknown>): string {
  const full = Number.isFinite(Number(row.id)) ? store.getFinding(Number(row.id)) ?? row : row;
  const runId = Number(full.run_id);
  const run = Number.isFinite(runId) ? store.getRun(runId) : undefined;
  return phaseInputFingerprint({
    phase,
    material: run?.material_fingerprint ?? boundary?.material_fingerprint ?? null,
    findingId: Number(full.id),
    canonicalKey: full.canonical_key ?? full.finding_key,
    status: full.status,
    ...(phase === "verify" ? { confirmStatus: full.confirm_status ?? null } : {}),
    updatedAt: full.updated_at,
  });
}

async function daemonJobStatus(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const jobId = Number(c.params.id);
  const body = (await readBody(c.req)) as { status?: string; error?: string };
  const status = body.status ?? "done";
  if (!isJobTerminalStatus(status)) return sendJson(c.res, 400, { error: "status must be done, error, or canceled" });
  const before = authorizedDaemonJob(c, daemon, jobId);
  if (!before) return;
  if (isJobTerminalStatus(before.status)) {
    return sendJson(c.res, 200, { ok: true, stale: before.status !== status });
  }
  if (!c.store.setActiveJobTerminalStatus(jobId, status, body.error)) {
    const current = c.store.getJob(jobId);
    return sendJson(c.res, 200, { ok: true, stale: current?.status !== status });
  }
  // If the daemon died/aborted before its run reached a terminal state, reconcile the run.
  if (status === "error" || status === "canceled") {
    const job = c.store.getJob(jobId);
    const runId = job && typeof job.run_id === "number" ? job.run_id : undefined;
    if (runId !== undefined) {
      const run = c.store.getRun(runId);
      if (run && run.status === "running") c.store.finishRun(runId, status === "canceled" ? "killed" : "error");
    }
  }
  settleRunGroupWorkItem(c, jobId, status, body.error);
  sendJson(c.res, 200, { ok: true });
}

function isRunKind(value: unknown): value is RunKind {
  return value === "run" || value === "map" || value === "audit" || value === "verify" || value === "confirm" || value === "prepare" || value === "report";
}

function isRunTerminalStatus(value: unknown): value is "done" | "error" | "killed" {
  return value === "done" || value === "error" || value === "killed";
}

function isJobTerminalStatus(value: unknown): value is "done" | "error" | "canceled" {
  return value === "done" || value === "error" || value === "canceled";
}

// ---- shared -----------------------------------------------------------------

function reconcileLostExecutorJobs(store: MetadataStore, plane: ControlPlane): number {
  let changed = 0;
  for (const job of store.runningJobs()) {
    const jobId = Number(job.id);
    if (!Number.isFinite(jobId) || String(job.status) === "queued") continue;
    const daemonId = typeof job.daemon_id === "number" ? job.daemon_id : undefined;
    if (daemonId === undefined) continue;
    if (plane.daemonHoldsJob(daemonId, jobId)) continue;

    const daemonOnline = plane.hasDaemonSignal(daemonId);
    const daemonHasFreshHeartbeat = plane.hasFreshJobHeartbeat(daemonId);
    if (daemonOnline && !daemonHasFreshHeartbeat) continue; // connected pre-heartbeat/old daemon; warn but do not auto-kill
    if (!daemonOnline && daemonRecentlySeen(store, daemonId)) continue;

    const runId = typeof job.run_id === "number" ? job.run_id : undefined;
    const lastActivityAt = runId !== undefined
      ? latestRunActivityAt(store, plane, runId)
      : stringValue(job.updated_at) || stringValue(job.created_at);
    const activity = runInactivity(lastActivityAt);
    const jobTouchedAt = stringValue(job.updated_at) || stringValue(job.created_at);
    const freshDaemonLostJob = daemonHasFreshHeartbeat && timestampOlderThan(jobTouchedAt, DAEMON_LOST_JOB_GRACE_MS);
    if (!freshDaemonLostJob && !activity?.staleActivity) continue;

    const error = daemonOnline ? "executor no longer holds this job" : "executor offline before completion";
    store.setJobStatus(jobId, "canceled", error);
    if (runId !== undefined) {
      const run = store.getRun(runId);
      if (run && run.status === "running") store.finishRun(runId, "killed");
    }
    settleRunGroupWorkItemWith(store, plane, jobId, "canceled", error);
    changed += 1;
  }
  return changed;
}

function daemonRecentlySeen(store: MetadataStore, daemonId: number): boolean {
  const daemon = store.getDaemon(daemonId);
  const seenAt = stringValue(daemon?.last_seen_at);
  if (!seenAt) return false;
  const timestamp = Date.parse(seenAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < DAEMON_OFFLINE_RECONCILE_GRACE_MS;
}

// In-flight jobs across all daemons, shaped for the dashboard's "active" list.
function activeRuns(store: MetadataStore, plane?: ControlPlane): Array<Record<string, unknown>> {
  return store.runningJobs().map((job) => {
    const spec = safeParse(job.spec_json) as { verb?: string } | null;
    const daemonId = typeof job.daemon_id === "number" ? job.daemon_id : undefined;
    const onlineDaemons = daemonId !== undefined && plane ? (plane.hasDaemonSignal(daemonId) ? Math.max(1, plane.daemonCount(daemonId)) : 0) : undefined;
    const blockedReason = daemonId !== undefined && onlineDaemons === 0 ? "selected-daemon-offline" : undefined;
    const lastActivityAt = typeof job.run_id === "number" ? latestRunActivityAt(store, plane, Number(job.run_id)) : undefined;
    const activity = runInactivity(lastActivityAt);
    const updatedAt = maxIsoTimestamp(String(job.updated_at ?? ""), lastActivityAt);
    return {
      jobId: job.id,
      runId: job.run_id ?? null,
      target: job.project,
      status: job.status,
      verb: spec?.verb ?? "run",
      startedAt: job.created_at,
      updatedAt,
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(activity ? { inactiveSeconds: activity.inactiveSeconds, staleActivity: activity.staleActivity } : {}),
      daemonId: daemonId ?? null,
      ...(onlineDaemons !== undefined ? { onlineDaemons } : {}),
      ...(blockedReason ? { blockedReason } : {}),
    };
  });
}

function latestRunActivityAt(store: MetadataStore, plane: ControlPlane | undefined, runId: number): string | undefined {
  const live = plane?.lastActivityAt(runId);
  const run = store.getRun(runId);
  const persisted = run ? persistedRunActivity(run, 1)[0]?.ts : undefined;
  return maxIsoTimestamp(live, typeof persisted === "string" ? persisted : undefined);
}

function maxIsoTimestamp(...values: Array<string | undefined>): string | undefined {
  return values.filter((v): v is string => Boolean(v)).sort().at(-1);
}

function runInactivity(lastActivityAt: string | undefined): { inactiveSeconds: number; staleActivity: boolean } | undefined {
  if (!lastActivityAt) return undefined;
  const last = Date.parse(lastActivityAt);
  if (!Number.isFinite(last)) return undefined;
  const inactiveSeconds = Math.max(0, Math.floor((Date.now() - last) / 1000));
  return { inactiveSeconds, staleActivity: inactiveSeconds * 1000 >= RUN_STALE_ACTIVITY_MS };
}

function timestampOlderThan(value: string | undefined, ageMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed >= ageMs;
}

function daemonRows(c: Ctx): Array<Record<string, unknown>> {
  const includeRaw = c.url.searchParams.get("include") === "capabilities";
  return c.store.listDaemons().map((daemon) => {
    const parsed = safeParse(daemon.capabilities);
    const online = c.plane.hasDaemonSignal(Number(daemon.id));
    if (includeRaw) return { ...daemon, online, capabilities: parsed ?? daemon.capabilities ?? null };
    return { ...daemon, online, capabilities: summarizeDaemonCapabilities(parsed) };
  });
}

function daemonStatusRows(c: Ctx): Array<Record<string, unknown>> {
  return c.store.listDaemons().map((daemon) => {
    const summary = summarizeDaemonCapabilities(safeParse(daemon.capabilities));
    return {
      id: daemon.id,
      name: daemon.name,
      workspace: daemon.workspace,
      last_seen_at: daemon.last_seen_at,
      created_at: daemon.created_at,
      online: c.plane.hasDaemonSignal(Number(daemon.id)),
      capabilities: {
        providerCount: summary.providerCount,
        configuredProviderCount: summary.configuredProviderCount,
      },
    };
  });
}

function summarizeDaemonCapabilities(capabilities: unknown): Record<string, unknown> {
  const providersRaw = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? (capabilities as { providers?: unknown }).providers
    : undefined;
  const sandbox = summarizeDaemonSandbox(capabilities);
  const providers = Array.isArray(providersRaw)
    ? providersRaw.flatMap((entry) => {
        if (typeof entry === "string") return [{ provider: entry, configured: true, required: true }];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const provider = (entry as { provider?: unknown }).provider;
        if (typeof provider !== "string" || !provider.trim()) return [];
        return [{
          provider,
          configured: Boolean((entry as { configured?: unknown }).configured),
          required: Boolean((entry as { required?: unknown }).required),
          oauthLogin: Boolean((entry as { oauthLogin?: unknown }).oauthLogin),
        }];
      })
    : [];
  return {
    providers,
    providerCount: providers.length,
    configuredProviderCount: providers.filter((entry) => entry.configured).length,
    ...(sandbox ? { sandbox } : {}),
  };
}

function summarizeDaemonSandbox(capabilities: unknown): Record<string, unknown> | undefined {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const sandbox = (capabilities as { sandbox?: unknown }).sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return undefined;
  const read = sandbox as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof read.ok === "boolean") out.ok = read.ok;
  if (typeof read.backend === "string" && read.backend.trim()) out.backend = read.backend.trim();
  if (typeof read.image === "string" && read.image.trim()) out.image = read.image.trim();
  if (typeof read.allowHostFallback === "boolean") out.allowHostFallback = read.allowHostFallback;
  if (typeof read.autoBuild === "boolean") out.autoBuild = read.autoBuild;
  if (typeof read.message === "string" && read.message.trim()) out.message = read.message.trim();
  return Object.keys(out).length ? out : undefined;
}

function normalizeProjectStatusFilter(value: string | null | undefined): ProjectStatusFilter | undefined {
  if (!value) return undefined;
  return PROJECT_STATUS_FILTERS.includes(value as ProjectStatusFilter) ? value as ProjectStatusFilter : undefined;
}

function normalizeProjectOriginFilter(value: string | null | undefined): NonNullable<ProjectListOptions["origin"]> | undefined {
  if (!value) return "project";
  return value === "project" || value === "evaluation" || value === "all" ? value : undefined;
}

function normalizeFindingSourceFilter(value: string | null | undefined): "project" | "evaluation" | "all" | undefined {
  if (!value) return "project";
  return value === "project" || value === "evaluation" || value === "all" ? value : undefined;
}

function emptyProjectStatusCounts(total = 0): ProjectStatusCounts {
  return { all: total, running: 0, "needs-work": 0, done: 0, failed: 0, "not-started": 0 };
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function projectSnapshotStatus(row: Record<string, unknown>): ProjectStatusFilter {
  const latest = row.latestRun as { status?: unknown } | null | undefined;
  const latestStatus = typeof latest?.status === "string" ? latest.status : "";
  if (numberField(row, "activeRuns") > 0 || latestStatus === "running") return "running";
  if (latestStatus === "error" || latestStatus === "killed") return "failed";
  const progress = row.progress as Coverage | null | undefined;
  const total = typeof progress?.total === "number" ? progress.total : 0;
  const pending = typeof progress?.pending === "number" ? progress.pending : 0;
  if ((total > 0 && pending > 0) || numberField(row, "verifyPendingFindings") > 0 || numberField(row, "confirmPendingFindings") > 0) return "needs-work";
  if (
    total > 0
    || numberField(row, "findingsTotal") > 0
    || numberField(row, "reproducedBugs") > 0
    || numberField(row, "confirmedBugs") > 0
    || latestStatus === "done"
  ) {
    return "done";
  }
  return "not-started";
}

function countProjectStatuses(rows: Array<Record<string, unknown>>): ProjectStatusCounts {
  const counts = emptyProjectStatusCounts(rows.length);
  for (const row of rows) counts[projectSnapshotStatus(row)] += 1;
  return counts;
}

function projectListResponse(
  store: MetadataStore,
  options: ProjectListOptions,
  status: ProjectStatusFilter | undefined,
): { projects: Array<Record<string, unknown>>; total: number; limit: number; offset: number; statusCounts: ProjectStatusCounts } {
  const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 100;
  const offset = typeof options.offset === "number" && Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0;
  const allRows = projectSnapshots(store, { archived: options.archived, origin: options.origin, search: options.search });
  const statusCounts = countProjectStatuses(allRows);
  const filteredRows = status ? allRows.filter((row) => projectSnapshotStatus(row) === status) : allRows;
  return { projects: filteredRows.slice(offset, offset + limit), total: filteredRows.length, limit, offset, statusCounts };
}

function projectSnapshots(store: MetadataStore, options: ProjectListOptions = {}): Array<Record<string, unknown>> {
  const runningJobs = store.runningJobs();
  const activeByTarget = new Map<string, number>();
  for (const job of runningJobs) {
    if (store.getWorkItemByJob(Number(job.id))) continue;
    activeByTarget.set(String(job.project), (activeByTarget.get(String(job.project)) ?? 0) + 1);
  }
  return store.listProjects(options).map((project) => {
    const id = Number(project.id);
    const allRuns = store.listRuns(id);
    const materialBoundary = latestPrepareRun(allRuns);
    const activePrepareRefresh = activePrepareRefreshStartedAt(store, project, materialBoundary, runningJobs);
    const currentRuns = currentVisibleRuns(allRuns, materialBoundary, activePrepareRefresh);
    const viewBoundary = materialViewBoundary(materialBoundary, activePrepareRefresh);
    const scopeBoundary = latestScopeInventoryBoundaryRun(currentRuns);
    const currentResultRows = currentResultRuns(currentRuns, scopeBoundary);
    const currentRunIds = runIdSet(currentResultRows);
    const scopeView = currentScopeView(store, id, currentRuns, activePrepareRefresh, scopeBoundary, !materialBoundary);
    const allFindings = activePrepareRefresh
      ? []
      : reportableFindings(store.listFindings(id).filter((row) => rowBelongsToCurrentMaterial(row, currentRunIds, materialBoundary)));
    const findings = allFindings.filter((finding) => !isIgnoredFinding(finding));
    const counts = findingCounts(findings);
    const confirmDecisions = activePrepareRefresh
      ? []
      : currentConfirmDecisions(store.listConfirmDecisions(id).filter((row) => rowBelongsToCurrentMaterial(row, currentRunIds, materialBoundary)));
    const reproducedBugs = confirmDecisions.filter((row) => row.reproduced === "yes" && isRealTargetDecisionEvidence(stringValue(row.evidence_level))).length;
    const auditConfirmedFindings = countAuditConfirmedFindings(findings);
    const submissionWorkKeys = new Set(confirmDecisions.filter((row) => needsSubmissionReadinessWork(row)).flatMap(confirmDecisionMemberKeys));
    const verifyPendingFindings = (counts.suspected ?? 0) + (counts["confirmed-source"] ?? 0);
    const requiresRealTargetConfirmation = projectRequiresRealTargetConfirmation(project, allRuns);
    const confirmPendingFindings = requiresRealTargetConfirmation
      ? findings.filter((finding) => {
          const status = String(finding.status ?? "");
          const key = stringValue(finding.finding_key).toLowerCase();
          return !findingTrackingBlocksProgress(finding)
            && !findingIndependentReviewBlocksProgress(finding)
            && (status === "confirmed-executable" || status === "confirmed-differential")
            && (!finding.confirm_status || (key && submissionWorkKeys.has(key)));
        }).length
      : 0;
    return {
      id,
      uuid: project.uuid,
      name: project.name,
      origin: project.origin ?? "project",
      provider_id: project.provider_id ?? null,
      daemon_id: project.daemon_id ?? null,
      dir: project.dir ?? null,
      archived_at: project.archived_at ?? null,
      pinned_at: project.pinned_at ?? null,
      sort_order: project.sort_order ?? null,
      created_at: project.created_at ?? null,
      updated_at: project.updated_at ?? null,
      config: safeParse(project.config_json),
      progress: scopeView.progress,
      findingCounts: counts,
      findingsTotal: findings.length,
      auditConfirmedFindings,
      reproducedBugs,
      confirmedBugs: requiresRealTargetConfirmation ? reproducedBugs : auditConfirmedFindings,
      verifyPendingFindings,
      confirmPendingFindings,
      confirmDecisionCount: confirmDecisions.length,
      runCount: store.countRuns(id),
      currentRunCount: currentResultRows.length,
      latestRun: runApiRows(store, latestDisplayRun(currentRuns), undefined, viewBoundary)[0] ?? null,
      latestRunHealth: runHealthDisplayRow(store.latestRunHealth(id)),
      backlogCounts: store.discoveryBacklogCounts(id),
      activeRuns: activeByTarget.get(String(project.name)) ?? 0,
      material: materialSummary(allRuns, materialBoundary, activePrepareRefresh),
    };
  });
}

function latestDisplayRun(runs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const run = runs.find(runHasDisplayWeight) ?? runs[0];
  return run ? [run] : [];
}

function runHasDisplayWeight(run: Record<string, unknown>): boolean {
  const status = stringValue(run.status);
  if (status === "running" || status === "done") return true;
  if (Number(run.scopes_total) > 0 || Number(run.findings_total) > 0 || Number(run.run_scopes_done) > 0) return true;
  if (stringValue(run.stages_json)) return true;
  return false;
}

function streamSnapshots(res: ServerResponse, store: MetadataStore, plane: ControlPlane): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const timer = setInterval(tick, 1200);
  res.on("close", () => clearInterval(timer));
  tick();
  // A throw here (closed socket, or a transient store read error) must not crash the server.
  function tick(): void {
    try {
      reconcileLostExecutorJobs(store, plane);
      res.write(`data: ${JSON.stringify({ projects: projectSnapshots(store, { limit: PROJECT_STREAM_LIMIT }), active: activeRuns(store, plane) })}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }
}

// Build a launch spec from the project's stored materials/config + the request body
// (verb + run-shape flags + optional one-off overrides). Unbounded (null) budgets stay
// undefined so the kernel's unbounded default applies.
type PhaseProfiles = Partial<Record<"prepare" | "map" | "dig" | "confirm", ProviderProfile>>;

function phaseProviderProfiles(project: Record<string, unknown>, store: MetadataStore): PhaseProfiles {
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  const phaseProviders = cfg.phaseProviders && typeof cfg.phaseProviders === "object"
    ? cfg.phaseProviders as Partial<Record<"prepare" | "map" | "dig" | "confirm", unknown>>
    : {};
  const out: PhaseProfiles = {};
  for (const phase of ["prepare", "map", "dig", "confirm"] as const) {
    const id = phaseProviders[phase];
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    const provider = store.getProvider(id);
    if (provider) out[phase] = provider;
  }
  return out;
}

function launchSpec(store: MetadataStore, project: Record<string, unknown>, body: Record<string, unknown>, out: string, profile?: ProviderProfile, progress?: Coverage, phaseProfiles: PhaseProfiles = {}): LaunchSpec {
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  const overrides = (body.overrides as Record<string, unknown>) ?? {};
  const configOverrides = (overrides.config as Record<string, unknown>) ?? {};
  const bodyOverrides = runBodyConfigOverrides(body);
  const merged = { ...cfg, ...configOverrides, ...bodyOverrides };
  const explicitRunMaxScopes = configOverrides.maxScopes !== undefined || bodyOverrides.maxScopes !== undefined;
  const explicitCoverageContinuation =
    body.continueCoverage === true
    || configOverrides.scopeCoverageMode !== undefined
    || bodyOverrides.scopeCoverageMode !== undefined
    || explicitRunMaxScopes;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const backend = (v: unknown): SandboxBackend | undefined => isSandboxBackend(v) ? v : undefined;
  const network = (v: unknown): "none" | "enabled" | undefined => (v === "none" || v === "enabled" ? v : undefined);
  const list = (v: unknown, fallback: unknown): string[] => {
    const arr = Array.isArray(v) ? v : (safeParse(fallback) as unknown[]) ?? [];
    return arr.filter((x): x is string => typeof x === "string");
  };
  // The VENDOR comes from the selected profile; MODEL + THINKING come from the project's
  // per-phase config (cfg.phases). Each verb has a "primary" phase that drives the run's
  // top-level model/thinking; an audit run (run/audit/map) additionally maps map/dig into
  // roles (refute follows dig). Legacy projects with profile-baked model/thinking/roles still
  // resolve via the profile fallback. Materials are RELATIVE to the project dir (resolved on
  // the daemon against its workspace); new projects default dir to their UUID.
  const verb = (typeof body.verb === "string" ? body.verb : "run") as RunKind;
  const pipeline = body.pipeline === true;
  const phases = (merged.phases && typeof merged.phases === "object" ? merged.phases : {}) as Record<string, { model?: unknown; thinking?: unknown }>;
  const primaryPhase = verb === "prepare" ? "prepare" : verb === "map" ? "map" : verb === "confirm" || verb === "report" ? "confirm" : "dig";
  const explicitSandboxConfirmNetwork = configOverrides.sandboxConfirmNetwork !== undefined || bodyOverrides.sandboxConfirmNetwork !== undefined;
  const effectiveSandboxConfirmNetwork =
    (verb === "prepare" || verb === "confirm" || (verb === "run" && pipeline)) && !explicitSandboxConfirmNetwork
      ? "enabled"
      : network(merged.sandboxConfirmNetwork);
  const phaseModel = (ph: string): string | undefined => str(phases[ph]?.model);
  const phaseThinking = (ph: string): string | undefined => str(phases[ph]?.thinking);
  const phaseProfile = (ph: "prepare" | "map" | "dig" | "confirm"): ProviderProfile | undefined => phaseProfiles[ph] ?? profile;
  const roleEntry = (ph: string): RoleOverride | undefined => {
    const profileForPhase = phaseProfile(ph === "map" ? "map" : "dig");
    const provider = profileForPhase?.provider;
    const model = phaseModel(ph) ?? str(profileForPhase?.model);
    const thinking = phaseThinking(ph) ?? str(profileForPhase?.thinking);
    return provider || model || thinking ? { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) } : undefined;
  };
  const roles: ProviderRoles = {};
  if (verb === "run" || verb === "audit" || verb === "map") {
    for (const [role, ph] of [["map", "map"], ["dig", "dig"], ["refute", "dig"]] as const) {
      const e = roleEntry(ph);
      if (e) roles[role] = e;
    }
  }
  const legacyRoles = profile && Object.keys(profile.roles).length > 0 ? profile.roles : undefined;
  const primaryProfile = phaseProfile(primaryPhase as "prepare" | "map" | "dig" | "confirm");
  const autoCoverage = usesAutoCoverage(verb, body);
  const coverage = resolveCoverage(merged, autoCoverage ? progress : undefined, explicitRunMaxScopes);
  return {
    verb,
    target: String(project.name),
    dir: str(project.dir) ?? String(project.name),
    sourcePaths: list(overrides.sourcePaths, project.source_paths),
    buildRoot: str(overrides.buildRoot) ?? str(project.build_root),
    corpusPaths: list(overrides.corpusPaths, project.corpus_paths),
    provider: primaryProfile?.provider ?? str(merged.provider),
    model: phaseModel(primaryPhase) ?? str(primaryProfile?.model) ?? str(merged.model),
    thinking: phaseThinking(primaryPhase) ?? str(primaryProfile?.thinking) ?? str(merged.thinking),
    models: Object.keys(roles).length > 0 ? roles : legacyRoles,
    coverageMode: coverage.mode,
    coverageTarget: coverage.target,
    maxScopes: coverage.maxScopes,
    mapSteps: num(merged.mapSteps),
    mapSamples: num(merged.mapSamples),
    digSteps: num(merged.digSteps),
    maxSteps: num(merged.maxSteps),
    digSamples: num(merged.digSamples),
    digMaxSamples: num(merged.digMaxSamples),
    adaptiveDig: typeof merged.adaptiveDig === "boolean" ? merged.adaptiveDig : undefined,
    eagerPrepare: typeof merged.eagerPrepare === "boolean" ? merged.eagerPrepare : undefined,
    digConcurrency: num(merged.digConcurrency),
    verifyConcurrency: num(merged.verifyConcurrency),
    sandboxBackend: backend(merged.sandboxBackend),
    sandboxImage: str(merged.sandboxImage),
    sandboxAllowHostFallback: typeof merged.sandboxAllowHostFallback === "boolean" ? merged.sandboxAllowHostFallback : undefined,
    sandboxPrepareNetwork: network(merged.sandboxPrepareNetwork),
    sandboxConfirmNetwork: effectiveSandboxConfirmNetwork,
    sandboxMemoryMb: num(merged.sandboxMemoryMb),
    sandboxCpus: num(merged.sandboxCpus),
    remap: Boolean(body.remap),
    appendMap: Boolean(body.appendMap),
    appendMapSeedPaths: list(body.appendMapSeedPaths, undefined),
    fresh: Boolean(body.fresh),
    quick: Boolean(body.quick),
    mockLlm: Boolean(body.mockLlm),
    pipeline,
    continueCoverage: explicitCoverageContinuation,
    verifyFromStart: Boolean(body.verifyFromStart),
    region: str(body.region),
    scope: str(body.scope),
    scopeNote: str(merged.scopeNote), // a project may store a default focus note in its config
    ...(body.verifyFindings !== undefined ? { verifyFindings: normalizeProjectVerifyFindings(store, Number(project.id), body.verifyFindings) } : {}),
    inputRunDir: str(body.inputRunDir),
    clue: str(body.clue),
    posture: str(body.posture),
    matchDeployed: typeof body.matchDeployed === "boolean" ? body.matchDeployed : undefined,
    endpoint: str(body.endpoint),
    out,
  };
}

function normalizeProjectVerifyFindings(store: MetadataStore, projectId: number, input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => normalizeProjectVerifyFindings(store, projectId, item));
  if (!input || typeof input !== "object") return input;
  const row = input as Record<string, unknown>;
  if (positiveIntegerId(row.originId ?? row.origin_id) !== undefined) return input;
  const id = positiveIntegerId(row.id);
  if (id === undefined) return input;
  const finding = store.getFinding(id);
  if (finding && Number(finding.project_id) === projectId) {
    const duplicateOf = String(finding.tracking_status ?? "") === "duplicate"
      ? positiveIntegerId(finding.duplicate_of_finding_id)
      : undefined;
    const canonical = duplicateOf === undefined ? undefined : store.getFinding(duplicateOf);
    const originId = canonical && Number(canonical.project_id) === projectId ? duplicateOf : id;
    // Keep the selected variant's concrete claim/evidence as the Verify input, but
    // settle the result on its canonical finding. This avoids spending a full
    // execution pass only to strand stronger evidence on non-independent work.
    return { ...findingDetailRow(finding), ...row, originId };
  }
  return { ...row, originId: id };
}

function runBodyConfigOverrides(body: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "scopeCoverageMode",
    "maxScopes",
    "mapSteps",
    "mapSamples",
    "digSteps",
    "maxSteps",
    "digSamples",
    "digMaxSamples",
    "adaptiveDig",
    "eagerPrepare",
    "digConcurrency",
    "verifyConcurrency",
    "sandboxBackend",
    "sandboxImage",
    "sandboxAllowHostFallback",
    "sandboxPrepareNetwork",
    "sandboxConfirmNetwork",
    "sandboxMemoryMb",
    "sandboxCpus",
    "scopeNote",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

type CoverageMode = "focused" | "standard" | "half" | "full" | "custom" | "";
interface ResolvedCoverage {
  mode?: string | undefined;
  target?: number | undefined;
  maxScopes?: number | undefined;
}

function resolveCoverage(cfg: Record<string, unknown>, progress?: Coverage, explicitFirst = false): ResolvedCoverage {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : undefined);
  const explicit = num(cfg.maxScopes);
  if (explicitFirst && explicit !== undefined) return { mode: "custom", maxScopes: explicit };
  const mode = normalizeCoverageMode(cfg.scopeCoverageMode, explicit);
  const total = Math.max(0, Math.floor(progress?.total ?? 0));
  const pending = Math.max(0, Math.floor(progress?.pending ?? 0));
  if (mode === "focused") return { mode, target: 10, maxScopes: cumulativeCoverageLimit(10, progress) };
  if (mode === "standard") return { mode, target: 30, maxScopes: cumulativeCoverageLimit(30, progress) };
  if (mode === "half") return { mode, maxScopes: total > 0 ? Math.max(0, Math.ceil(pending / 2)) : 30 };
  if (mode === "full") return { mode, maxScopes: total > 0 && pending === 0 ? 0 : undefined };
  if (mode === "custom") return { mode, maxScopes: explicit };
  return { mode, maxScopes: explicit };
}

function normalizeCoverageMode(input: unknown, explicit?: number): CoverageMode {
  if (input === "focused" || input === "standard" || input === "half" || input === "full" || input === "custom") return input;
  if (explicit === 10) return "focused";
  if (explicit === 30) return "standard";
  if (explicit === undefined) return "standard";
  return "custom";
}

function cumulativeCoverageLimit(target: number, progress?: Coverage): number {
  const total = Math.max(0, Math.floor(progress?.total ?? 0));
  if (total <= 0) return target;
  const audited = Math.max(0, Math.floor(progress?.audited ?? 0));
  const pending = Math.max(0, Math.floor(progress?.pending ?? 0));
  const projectTarget = Math.min(target, total);
  const remaining = Math.max(0, projectTarget - audited);
  return Math.min(pending, remaining);
}

function usesAutoCoverage(verb: RunKind, body: Record<string, unknown>): boolean {
  if (verb !== "run" && verb !== "audit") return false;
  if (typeof body.scope === "string" && body.scope.trim()) return false;
  if (typeof body.region === "string" && body.region.trim()) return false;
  if (body.verifyFindings !== undefined) return false;
  return true;
}

function coverageTargetReached(spec: LaunchSpec): boolean {
  if (spec.maxScopes !== 0) return false;
  if (spec.verb !== "run" && spec.verb !== "audit") return false;
  if (spec.scope || spec.region || spec.verifyFindings !== undefined) return false;
  return true;
}

function coverageModeLabel(mode: string | undefined): string {
  if (mode === "focused") return "Focused";
  if (mode === "standard") return "Standard";
  if (mode === "half") return "Half";
  if (mode === "full") return "Full";
  if (mode === "custom") return "Custom";
  return "Selected";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function truthyParam(raw: string | null): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}
