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
// SSE stream; daemon→server updates are POSTs. Zero-dependency: Node's built-in http + a
// vanilla SPA. Bind to localhost unless a per-daemon bearer token is configured.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataStore, type RunKind, type Coverage, type ProviderInput, type ProviderProfile, type ProjectInput, type ProviderRoles, type RoleOverride } from "../db/store.js";
import { getProviders, getModels } from "@earendil-works/pi-ai";
import { type LaunchSpec, ActivityBus } from "./run-manager.js";
import { projectHistoryDir } from "../trace/history.js";
import { loadScopeInventory, saveScopeInventory } from "../agent/scope-store.js";

const UI_HTML_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));
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
}

// The control plane: the live registry of connected daemons (for server→daemon nudges) and
// a per-run activity bus (fed by daemon activity POSTs, read by the UI's SSE log stream).
// It holds NO execution state — the DB job queue is the system of record for dispatch.
class ControlPlane {
  private readonly daemons = new Set<ServerResponse>();
  private readonly buses = new Map<number, ActivityBus>();

  addDaemon(res: ServerResponse): void {
    this.daemons.add(res);
  }
  removeDaemon(res: ServerResponse): void {
    this.daemons.delete(res);
  }
  daemonCount(): number {
    return this.daemons.size;
  }

  /** Nudge every connected daemon to (re)claim queued jobs. */
  nudge(): void {
    this.broadcast({ type: "poll" });
  }
  /** Ask whichever daemon holds this job to abort it (others ignore an unknown jobId). */
  cancel(jobId: number): void {
    this.broadcast({ type: "cancel", jobId });
  }
  private broadcast(ev: unknown): void {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.daemons) {
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
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  store: MetadataStore;
  plane: ControlPlane;
  out: string;
}

interface Route {
  method: string;
  path: string; // template, e.g. /api/projects/:name/runs
  summary: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
  handler: (c: Ctx) => Promise<void> | void;
  hidden?: boolean; // omit from the catalog (the UI page + the catalog itself)
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
  route({ method: "GET", path: "/api", summary: "This catalog: every resource and operation, so an agent can self-learn and drive the workflow without the UI.", handler: (c) => sendJson(c.res, 200, catalog()) }),

  route({
    method: "GET", path: "/api/projects",
    summary: "List all projects with a live snapshot (scope coverage, finding counts, confirmed-bug count, latest run, active runs).",
    handler: (c) => sendJson(c.res, 200, { projects: projectSnapshots(c.store) }),
  }),
  route({
    method: "POST", path: "/api/projects",
    summary: "Create a project (no run starts). Rejects a duplicate name.",
    body: { name: "string (required, unique)", sourcePaths: "string[] — code to audit", buildRoot: "string? — buildable root", corpusPaths: "string[]? — specs/docs", config: "object? — { provider, model, thinking, maxScopes, mapSteps, digSteps, digSamples, digConcurrency }" },
    handler: projectCreate,
  }),
  route({
    method: "GET", path: "/api/projects/:name",
    summary: "Project detail: config, scope coverage, finding/run/confirmed counts, recent runs, confirm decisions.",
    params: { name: "project name" },
    handler: projectGet,
  }),
  route({
    method: "PATCH", path: "/api/projects/:name",
    summary: "Update a project's materials and/or config (no run starts). Used by Continue/Restart/Run afterwards.",
    params: { name: "project name" },
    body: { sourcePaths: "string[]?", buildRoot: "string?", corpusPaths: "string[]?", config: "object?" },
    handler: projectUpdate,
  }),
  route({
    method: "DELETE", path: "/api/projects/:name",
    summary: "Delete a project and everything under it (runs, scopes, findings, confirm decisions). On-disk run artifacts are left untouched.",
    params: { name: "project name" },
    handler: projectDelete,
  }),

  route({
    method: "GET", path: "/api/projects/:name/runs",
    summary: "List a project's runs (newest first).",
    params: { name: "project name" }, query: { limit: "number? — cap rows" },
    handler: (c) => withProject(c, (id) => sendJson(c.res, 200, { runs: c.store.listRuns(id, clampInt(c.url.searchParams.get("limit"), 200, 1, 1000)) })),
  }),
  route({
    method: "POST", path: "/api/projects/:name/runs",
    summary: "Queue a run on the project (start/continue an audit, restart, map, audit a region/scope, confirm, or prepare). The job is dispatched to a connected daemon, which executes it and reports back. Uses the project's stored materials + config unless overridden. This is the single action behind the UI's Start/Continue/Restart/Run buttons.",
    params: { name: "project name" },
    body: {
      verb: "'run' | 'map' | 'audit' | 'confirm' | 'prepare' (default 'run'; run = map→dig, resumes)",
      remap: "boolean? — re-enumerate scopes (restart)", fresh: "boolean? — confirm: ignore a prior interrupted confirm",
      quick: "boolean? — run: single breadth pass", mockLlm: "boolean? — offline mock model",
      region: "string? — audit: pinned region e.g. src/Foo.sol:120-180", scope: "string? — audit: scope id(s)", verifyFindings: "object|array? — audit: inline suspected finding(s) to confirm-or-refute by execution",
      inputRunDir: "string? — confirm: the finished run dir to reproduce",
      clue: "string? — prepare: the tx / address / project / link to acquire from",
      posture: "string? — prepare: 'blind' | 'informed'", matchDeployed: "boolean? — prepare: prove staged source matches the live deployment (default true)", endpoint: "string? — prepare: read-only access hint (e.g. RPC URL)",
      overrides: "object? — { sourcePaths, buildRoot, corpusPaths, config } one-off overrides of the stored project",
    },
    handler: runLaunch,
  }),
  route({
    method: "GET", path: "/api/projects/:name/scopes",
    summary: "List the project's scope inventory (audited / pending / deferred) — the map output.",
    params: { name: "project name" },
    handler: (c) => withProject(c, (id) => sendJson(c.res, 200, { scopes: c.store.listScopes(id), progress: c.store.scopeProgress(id) })),
  }),
  route({
    method: "PATCH", path: "/api/projects/:name/scopes/:scopeId",
    summary: "Set a scope's status — mark it `deferred` to skip it in auto-dig (or `pending` to resume). Updates the persisted inventory the audit reads, so the next run honors it.",
    params: { name: "project name", scopeId: "scope id from the inventory" },
    body: { status: "'deferred' (skip) | 'pending' (resume) | 'audited'" },
    handler: scopeSetStatus,
  }),
  route({
    method: "GET", path: "/api/projects/:name/findings",
    summary: "List findings, paginated + filterable, each with its status timeline (suspect→confirm→refute).",
    params: { name: "project name" },
    query: { status: "string? — exact status filter", q: "string? — text search (title/location)", limit: "number? (default 50)", offset: "number? (default 0)" },
    handler: findingsList,
  }),
  route({
    method: "GET", path: "/api/projects/:name/confirm-decisions",
    summary: "List confirm decisions (one per distinct bug). Filter ?reproduced=yes for the bugs actually reproduced on the real target (the audit's payoff).",
    params: { name: "project name" }, query: { reproduced: "string? — e.g. 'yes' for confirmed bugs" },
    handler: confirmDecisionsList,
  }),

  route({
    method: "GET", path: "/api/providers",
    summary: "List saved provider profiles — a reusable model strategy (provider + model + thinking, with optional per-phase map/dig/refute overrides) that a project selects.",
    handler: (c) => sendJson(c.res, 200, { providers: c.store.listProviders() }),
  }),
  route({
    method: "POST", path: "/api/providers",
    summary: "Create a provider profile.",
    body: { name: "string (unique)", provider: "pi-ai provider id, or claude-code / codex-cli / mock", model: "string? — default model", thinking: "minimal|low|medium|high|xhigh?", roles: "object? — per-phase overrides { map|dig|refute: { provider?, model?, thinking? } }" },
    handler: providerCreate,
  }),
  route({
    method: "GET", path: "/api/pi/providers",
    summary: "Providers pi-ai can drive (for the profile editor), plus the CLI fallbacks. Discovery, not the saved resource.",
    handler: (c) => sendJson(c.res, 200, { providers: availableProviders() }),
  }),
  route({
    method: "GET", path: "/api/pi/models/:provider",
    summary: "Models pi-ai exposes for a provider (id, name, reasoning) — for the model dropdown.",
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
    summary: "Registered execution-plane daemons (id, name, workspace, last_seen_at) — no tokens.",
    handler: (c) => sendJson(c.res, 200, { daemons: c.store.listDaemons() }),
  }),
  route({
    method: "POST", path: "/api/daemons",
    summary: "Register a daemon and mint its bearer token (shown ONCE). Configure it on the daemon: flounder daemon --server <url> --token <token>.",
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
    summary: "Every finding across ALL projects (joined with project name) plus aggregate stats — the cross-project Bugs dashboard. Optional ?status= and ?tracking= filters; ?limit/&offset paginate.",
    handler: (c) => {
      const status = c.url.searchParams.get("status") || undefined;
      const tracking = c.url.searchParams.get("tracking") || undefined;
      const limit = Number(c.url.searchParams.get("limit")) || undefined;
      const offset = Number(c.url.searchParams.get("offset")) || undefined;
      sendJson(c.res, 200, { findings: c.store.listGlobalFindings({ status, tracking, limit, offset }), stats: c.store.globalFindingStats() });
    },
  }),
  route({
    method: "PATCH", path: "/api/findings/:id/tracking",
    summary: "Set a finding's submission-tracking state (open|triaging|submitted|accepted|fixed|duplicate|rejected) — for following a bug from discovery to vendor disclosure.",
    params: { id: "finding id" },
    body: { status: "open|triaging|submitted|accepted|fixed|duplicate|rejected" },
    handler: findingTracking,
  }),

  route({
    method: "POST", path: "/api/launch",
    summary: "Queue an ad-hoc run from a full launch spec (absolute materials, no project staging) — the entry point the CLI drives. Upserts a project row keyed by `target` so the run is grouped + visible, enqueues the job, and nudges daemons. Use POST /api/projects/:name/runs instead to launch a UI-configured project.",
    body: {
      verb: "'run' | 'map' | 'audit' | 'confirm' | 'prepare' (required)", target: "string (required) — run/project name",
      sourcePaths: "string[] — ABSOLUTE code paths the daemon reads", corpusPaths: "string[]? — ABSOLUTE design/reference paths", buildRoot: "string? — ABSOLUTE buildable root",
      provider: "string?", model: "string?", thinking: "string?",
      maxScopes: "number?", mapSteps: "number?", digSteps: "number?", maxSteps: "number?", digSamples: "number?", digConcurrency: "number?",
      remap: "boolean?", quick: "boolean?", mockLlm: "boolean?", region: "string?", scope: "string?", scopeNote: "string? — map/audit: 'authorized scope note' that focuses map on the in-scope target (the pipeline auto-derives it from prepare's manifest)", verifyFindings: "object|array? — audit: inline suspected finding(s) to confirm-or-refute by execution",
      inputRunDir: "string? — confirm", fresh: "boolean? — confirm",
      clue: "string? — prepare", posture: "string? — prepare", matchDeployed: "boolean? — prepare", endpoint: "string? — prepare",
    },
    handler: launch,
  }),
  route({
    method: "GET", path: "/api/jobs/:id",
    summary: "A queued/dispatched/running job (status, run_id once a daemon starts it, error). Poll after POST /api/launch to follow a CLI-launched run to its run id, then stream GET /api/runs/:id/log.",
    params: { id: "job id" },
    handler: (c) => { const job = c.store.getJob(Number(c.params.id)); job ? sendJson(c.res, 200, { job }) : sendJson(c.res, 404, { error: "no such job" }); },
  }),
  route({
    method: "GET", path: "/api/runs/:id",
    summary: "A single run (status, kind, coverage, finding count, run dir, timestamps).",
    params: { id: "run id" },
    handler: (c) => {
      const run = c.store.getRun(Number(c.params.id));
      run ? sendJson(c.res, 200, { run }) : sendJson(c.res, 404, { error: "no such run" });
    },
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
    params: { id: "run id" }, query: { name: "artifact filename (audit_report.md | confirm_report.md | report_f<N>.md | prepare_manifest.json | confirm_decision.json | confirm_provenance.json)" },
    handler: runArtifact,
  }),
  route({
    method: "GET", path: "/api/runs/:id/log",
    summary: "SSE stream of a run's live activity: the model's token-level thinking + output (audit_thinking / audit_text), tool calls (audit_step), and milestones, as reported by the executing daemon. Replays recent backlog then streams new events.",
    params: { id: "run id" },
    handler: (c) => streamFromBus(c.res, c.plane.bus(Number(c.params.id))),
  }),

  route({ method: "GET", path: "/api/active", summary: "In-flight jobs (queued/dispatched/running) across all daemons.", handler: (c) => sendJson(c.res, 200, { active: activeRuns(c.store), daemons: c.store.listDaemons() }) }),
  route({ method: "GET", path: "/api/stream", summary: "Server-sent events: the project snapshot + active list, pushed ~1/s for live updates.", handler: (c) => streamSnapshots(c.res, c.store) }),

  // ---- execution plane: daemon ↔ server (hidden from the agent catalog) ----------------
  route({ method: "POST", path: "/api/daemon/register", summary: "(daemon) Register/heartbeat. Bearer token required.", hidden: true, handler: daemonRegister }),
  route({ method: "GET", path: "/api/daemon/stream", summary: "(daemon) SSE: poll/cancel nudges from the server.", hidden: true, handler: daemonStream }),
  route({ method: "POST", path: "/api/daemon/claim", summary: "(daemon) Atomically claim the oldest queued job.", hidden: true, handler: daemonClaim }),
  route({ method: "POST", path: "/api/daemon/runs", summary: "(daemon) Start a run row for a claimed job; links job→run.", hidden: true, handler: daemonRunStart }),
  route({ method: "PATCH", path: "/api/daemon/runs/:id", summary: "(daemon) Report run progress: scopes / findings / confirm-decisions / finish.", hidden: true, handler: daemonRunUpdate }),
  route({ method: "POST", path: "/api/daemon/runs/:id/activity", summary: "(daemon) Push a batch of token-level activity events for the live log.", hidden: true, handler: daemonRunActivity }),
  route({ method: "POST", path: "/api/daemon/jobs/:id/status", summary: "(daemon) Report a job's terminal status (done/error/canceled).", hidden: true, handler: daemonJobStatus }),
];

function catalog(): unknown {
  return {
    name: "flounder",
    description: "REST API for tracking and driving white-hat audits. Resources: project (CRUD), run (launch/stop/read), scope, finding, confirm-decision. Runs execute on connected daemons; every UI operation is one of these calls.",
    resources: ["project", "provider", "run", "scope", "finding", "confirm-decision"],
    endpoints: ROUTES.filter((r) => !r.hidden).map((r) => ({
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
  const out = options.out ?? "runs";
  const port = options.port ?? 4500;
  const host = options.host ?? "127.0.0.1"; // localhost by default; expose only with daemon tokens set
  const store = MetadataStore.openForOutput(out);
  // Seed a couple of starter profiles so a fresh install has something to select (no-op if any exist).
  store.seedProviders([
    { name: "openai-codex · gpt-5.5 · xhigh", provider: "openai-codex", model: "gpt-5.5", thinking: "xhigh" },
    { name: "claude-code · opus · high", provider: "claude-code", model: "claude-opus-4-8", thinking: "high" },
  ]);
  const plane = new ControlPlane();
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
      // .then(run) (not Promise.resolve(run())) so a SYNCHRONOUS throw in a handler becomes a
      // rejection we can turn into a 500 — never an uncaught exception that kills the server.
      Promise.resolve()
        .then(() => r.handler({ req, res, params, url, store, plane, out }))
        .catch((error) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) });
          else res.end();
        });
      return;
    }
    sendJson(res, 404, { error: "not found", hint: "GET /api lists every endpoint" });
  });
  server.listen(port, host, () => {
    console.log(`[flounder ui] http://${host}:${port}  (API catalog: http://${host}:${port}/api · store: ${out}/flounder.db)`);
  });
  return server;
}

// ---- handlers -------------------------------------------------------------------------

function withProject(c: Ctx, fn: (projectId: number, project: Record<string, unknown>) => void): void {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) {
    sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
    return;
  }
  fn(Number(project.id), project);
}

// The editable project fields shared by create + update (materials are relative paths now;
// providerId selects a profile; dir is the subdir under the daemon workspace).
interface ProjectBody {
  sourcePaths?: string[];
  buildRoot?: string;
  corpusPaths?: string[];
  config?: unknown;
  providerId?: number | null;
  dir?: string;
}
function projectFields(body: ProjectBody): Omit<ProjectInput, "name"> {
  return {
    sourcePaths: body.sourcePaths,
    buildRoot: body.buildRoot,
    corpusPaths: body.corpusPaths,
    config: body.config,
    providerId: typeof body.providerId === "number" ? body.providerId : undefined,
    dir: typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : undefined,
  };
}

async function projectCreate(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as ProjectBody & { name?: string };
  const name = (body.name ?? "").trim();
  if (!name) return sendJson(c.res, 400, { error: "project name is required" });
  if (c.store.getProject(name)) return sendJson(c.res, 409, { error: `a project named "${name}" already exists` });
  c.store.upsertProject({ name, ...projectFields(body) });
  sendJson(c.res, 200, { ok: true, name });
}

function projectGet(c: Ctx): void {
  withProject(c, (id, project) => {
    sendJson(c.res, 200, {
      project,
      progress: c.store.scopeProgress(id),
      statusCounts: c.store.findingStatusCounts(id),
      findingsTotal: c.store.countFindings(id),
      confirmedBugs: c.store.countConfirmedBugs(id),
      runs: c.store.listRuns(id, 50),
      runsTotal: c.store.countRuns(id),
      confirmDecisions: c.store.listConfirmDecisions(id),
    });
  });
}

async function projectUpdate(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as ProjectBody;
  c.store.upsertProject({ name: String(project.name), ...projectFields(body) });
  sendJson(c.res, 200, { ok: true });
}

function projectDelete(c: Ctx): void {
  const removed = c.store.deleteProject(c.params.name ?? "");
  removed ? sendJson(c.res, 200, { ok: true, deleted: c.params.name }) : sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
}

async function scopeSetStatus(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as { status?: string };
  const status = body.status;
  if (status !== "pending" && status !== "audited" && status !== "deferred") {
    return sendJson(c.res, 400, { error: "status must be one of pending | audited | deferred" });
  }
  const scopeId = c.params.scopeId ?? "";
  // Update the persisted inventory the AUDIT reads (history-dir scopes.json), so the next
  // dig honors the skip — then mirror it into the UI's SQLite projection. (If the daemon
  // executes from its own checkout, it re-reads the inventory there via resume/--remap; this
  // server-side copy is the one a co-located daemon shares.)
  const inventoryDir = projectHistoryDir({ outputDir: c.out, targetName: String(project.name) });
  const inventory = await loadScopeInventory(inventoryDir);
  const scope = inventory.find((s) => s.id === scopeId);
  if (scope) {
    scope.status = status;
    await saveScopeInventory(inventoryDir, inventory);
  }
  c.store.setScopeStatus(Number(project.id), scopeId, status);
  sendJson(c.res, 200, { ok: true, scopeId, status });
}

// Queue a run for the project. The job lands in the DB queue; connected daemons are nudged
// to claim it. Returns the job id (the run id appears once a daemon starts it).
async function runLaunch(c: Ctx): Promise<void> {
  const project = c.store.getProject(c.params.name ?? "");
  if (!project) return sendJson(c.res, 404, { error: `no project named ${c.params.name}` });
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const profile = project.provider_id != null ? c.store.getProvider(Number(project.provider_id)) : undefined;
  const spec = launchSpec(project, body, c.out, profile);
  // Confirm is FINDING-grained + resumable: when no explicit run dir is given, resolve the work set
  // from finding STATUS — a specific finding (body.findingId) or all pending-confirmable findings
  // (confirmed by the audit, not yet decided on the real target). The confirm then updates each
  // finding's confirm_status, so a re-run only picks up what's still pending.
  if (spec.verb === "confirm" && !spec.inputRunDir && !(spec.inputRunDirs && spec.inputRunDirs.length > 0)) {
    if (body.findingId != null) {
      const f = c.store.getConfirmable(Number(body.findingId));
      if (!f || !f.run_dir) return sendJson(c.res, 400, { error: "that finding has no source run dir to confirm from" });
      spec.inputRunDir = String(f.run_dir);
      spec.confirmKeys = [f.finding_key];
    } else {
      const pending = c.store.pendingConfirmable(Number(project.id)).filter((p) => p.run_dir);
      if (pending.length === 0) return sendJson(c.res, 400, { error: "nothing to confirm — every audit-confirmed finding already has a real-target decision (use --fresh to redo)" });
      spec.inputRunDirs = [...new Set(pending.map((p) => String(p.run_dir)))];
      spec.inputRunDir = spec.inputRunDirs[0];
      spec.confirmKeys = pending.map((p) => p.finding_key);
    }
  }
  const jobId = c.store.enqueueJob(spec.target, spec);
  c.plane.nudge();
  sendJson(c.res, 200, { jobId, verb: spec.verb, queued: true, daemons: c.plane.daemonCount() });
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
    digSteps: num(body.digSteps),
    maxSteps: num(body.maxSteps),
    digSamples: num(body.digSamples),
    digConcurrency: num(body.digConcurrency),
    remap: bool(body.remap),
    fresh: bool(body.fresh),
    quick: bool(body.quick),
    mockLlm: bool(body.mockLlm),
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
  for (const [k, v] of Object.entries({ provider: spec.provider, model: spec.model, thinking: spec.thinking, maxScopes: spec.maxScopes, mapSteps: spec.mapSteps, digSteps: spec.digSteps, digSamples: spec.digSamples, digConcurrency: spec.digConcurrency })) {
    if (v !== undefined) cfg[k] = v;
  }
  return cfg;
}

function findingsList(c: Ctx): void {
  withProject(c, (id) => {
    const status = c.url.searchParams.get("status") ?? undefined;
    const search = c.url.searchParams.get("q") ?? undefined;
    const limit = clampInt(c.url.searchParams.get("limit"), 50, 1, 500);
    const offset = clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000);
    const findings = c.store.queryFindings(id, { status, search, limit, offset }).map((finding) => ({ ...finding, timeline: c.store.findingTimeline(Number(finding.id)) }));
    sendJson(c.res, 200, { findings, total: c.store.countFindings(id, { status, search }), limit, offset });
  });
}

function confirmDecisionsList(c: Ctx): void {
  withProject(c, (id) => {
    const reproduced = c.url.searchParams.get("reproduced");
    let rows = c.store.listConfirmDecisions(id);
    if (reproduced) rows = rows.filter((row) => row.reproduced === reproduced);
    sendJson(c.res, 200, { confirmDecisions: rows });
  });
}

// ---- providers (model-strategy profiles) ----------------------------------

const THINKING = new Set(["minimal", "low", "medium", "high", "xhigh"]);
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

function availableModels(provider: string): Array<{ id: string; name: string; reasoning: boolean }> {
  try {
    const models = getModels(provider as never) as unknown as Array<Record<string, unknown>>;
    return (models ?? []).map((m) => ({ id: String(m.id), name: String(m.name ?? m.id), reasoning: Boolean(m.reasoning) }));
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

const TRACKING_STATES = new Set(["open", "triaging", "submitted", "accepted", "fixed", "duplicate", "rejected"]);
async function findingTracking(c: Ctx): Promise<void> {
  const body = (await readBody(c.req)) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : "";
  if (!TRACKING_STATES.has(status)) return sendJson(c.res, 400, { error: "invalid tracking status", allowed: [...TRACKING_STATES] });
  const ok = c.store.setFindingTracking(Number(c.params.id), status);
  ok ? sendJson(c.res, 200, { ok: true }) : sendJson(c.res, 404, { error: "no such finding" });
}

// Serve a run's report artifact (text) from its run dir. Allowlisted filenames only (no slashes,
// so no path traversal); the file must resolve directly inside the run dir.
const ALLOWED_ARTIFACT = /^(audit_report\.md|confirm_report\.md|report_f\d+\.md|prepare_manifest\.json|confirm_decision\.json|confirm_provenance\.json|audit_findings\.json)$/;
function runArtifact(c: Ctx): void {
  const run = c.store.getRun(Number(c.params.id));
  if (!run || !run.run_dir) return sendJson(c.res, 404, { error: "no such run, or it has no run dir" });
  const name = c.url.searchParams.get("name") || "audit_report.md";
  if (!ALLOWED_ARTIFACT.test(name)) return sendJson(c.res, 400, { error: "artifact not allowed", name });
  const runDir = path.resolve(String(run.run_dir));
  const file = path.join(runDir, name);
  if (path.dirname(file) !== runDir) return sendJson(c.res, 400, { error: "bad path" });
  let text: string;
  try {
    text = readFileSync(file, "utf8"); // read BEFORE committing a status, so a missing file is a clean 404
  } catch {
    return sendJson(c.res, 404, { error: "artifact not found", name });
  }
  c.res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  c.res.end(text);
}

function runStop(c: Ctx): void {
  const id = Number(c.params.id);
  if (!c.store.getRun(id)) return sendJson(c.res, 404, { error: "no such run" });
  const job = c.store.getJobByRun(id);
  if (job) {
    c.store.requestJobCancel(Number(job.id));
    c.plane.cancel(Number(job.id)); // nudge the executing daemon to abort
  }
  sendJson(c.res, 200, { stopped: Boolean(job) });
}

function streamFromBus(res: ServerResponse, bus: ActivityBus): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": open\n\n"); // flush headers immediately so the client's EventSource opens even before the first event
  // `let` + no-op default: subscribe() replays backlog synchronously, so the callback can fire
  // before the real unsubscribe is assigned — guard against the temporal-dead-zone reference.
  let unsubscribe = (): void => {};
  unsubscribe = bus.subscribe((ev) => {
    try {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      unsubscribe();
    }
  });
  res.on("close", () => unsubscribe());
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

async function daemonRegister(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { name?: string; capabilities?: unknown; workspace?: string };
  c.store.touchDaemon(Number(daemon.id), body.capabilities, body.workspace);
  sendJson(c.res, 200, { ok: true, daemonId: Number(daemon.id), name: daemon.name });
}

function daemonStream(c: Ctx): void {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  c.store.touchDaemon(Number(daemon.id));
  c.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  c.plane.addDaemon(c.res);
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

async function daemonRunStart(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const body = (await readBody(c.req)) as { jobId?: number; project?: string; kind?: RunKind; runDir?: string; provider?: string; model?: string; thinking?: string; budgets?: unknown };
  const name = (body.project ?? "").trim();
  if (!name || !body.runDir) return sendJson(c.res, 400, { error: "project and runDir are required" });
  const existing = c.store.getProject(name);
  const projectId = existing ? Number(existing.id) : c.store.upsertProject({ name, config: body.budgets });
  const runId = c.store.startRun({
    projectId,
    kind: body.kind ?? "run",
    runDir: body.runDir,
    provider: body.provider,
    model: body.model,
    thinking: body.thinking,
    budgets: body.budgets,
  });
  if (typeof body.jobId === "number") c.store.setJobRun(body.jobId, runId); // link job → run (so stop can find it)
  sendJson(c.res, 200, { runId });
}

async function daemonRunUpdate(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const runId = Number(c.params.id);
  const run = c.store.getRun(runId);
  if (!run) return sendJson(c.res, 404, { error: "no such run" });
  const projectId = Number(run.project_id);
  const body = (await readBody(c.req)) as {
    scopes?: Parameters<MetadataStore["upsertScopes"]>[1];
    findings?: Parameters<MetadataStore["upsertFindings"]>[2];
    reason?: string;
    confirmDecisions?: Parameters<MetadataStore["upsertConfirmDecisions"]>[2];
    decisionPath?: string;
    runScopes?: { done: number; target: number };
    finish?: { status: Parameters<MetadataStore["finishRun"]>[1]; coverage?: Coverage; findingsTotal?: number };
  };
  if (body.scopes) {
    c.store.upsertScopes(projectId, body.scopes);
    c.store.updateRunCoverage(runId, c.store.scopeProgress(projectId));
  }
  if (body.runScopes) c.store.updateRunScopes(runId, body.runScopes.done, body.runScopes.target);
  if (body.findings) c.store.upsertFindings(projectId, runId, body.findings, body.reason);
  if (body.confirmDecisions) c.store.upsertConfirmDecisions(projectId, runId, body.confirmDecisions, body.decisionPath);
  if (body.finish) c.store.finishRun(runId, body.finish.status, body.finish.coverage, body.finish.findingsTotal);
  sendJson(c.res, 200, { ok: true });
}

async function daemonRunActivity(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const runId = Number(c.params.id);
  const body = (await readBody(c.req)) as { events?: Array<{ kind: string; delta?: string; tool?: string; step?: number }> };
  const bus = c.plane.bus(runId);
  for (const ev of body.events ?? []) bus.push(ev);
  sendJson(c.res, 200, { ok: true });
}

async function daemonJobStatus(c: Ctx): Promise<void> {
  const daemon = daemonAuth(c);
  if (!daemon) return;
  const jobId = Number(c.params.id);
  const body = (await readBody(c.req)) as { status?: string; error?: string };
  const status = body.status ?? "done";
  c.store.setJobStatus(jobId, status, body.error);
  // If the daemon died/aborted before its run reached a terminal state, reconcile the run.
  if (status === "error" || status === "canceled") {
    const job = c.store.getJob(jobId);
    const runId = job && typeof job.run_id === "number" ? job.run_id : undefined;
    if (runId !== undefined) {
      const run = c.store.getRun(runId);
      if (run && run.status === "running") c.store.finishRun(runId, status === "canceled" ? "killed" : "error");
    }
  }
  sendJson(c.res, 200, { ok: true });
}

// ---- shared -----------------------------------------------------------------

// In-flight jobs across all daemons, shaped for the dashboard's "active" list.
function activeRuns(store: MetadataStore): Array<Record<string, unknown>> {
  return store.runningJobs().map((job) => {
    const spec = safeParse(job.spec_json) as { verb?: string } | null;
    return { jobId: job.id, runId: job.run_id ?? null, target: job.project, status: job.status, verb: spec?.verb ?? "run", startedAt: job.created_at };
  });
}

function projectSnapshots(store: MetadataStore): Array<Record<string, unknown>> {
  const activeByTarget = new Map<string, number>();
  for (const job of store.runningJobs()) activeByTarget.set(String(job.project), (activeByTarget.get(String(job.project)) ?? 0) + 1);
  return store.listProjects().map((project) => {
    const id = Number(project.id);
    return {
      name: project.name,
      config: safeParse(project.config_json),
      progress: store.scopeProgress(id),
      findingCounts: store.findingStatusCounts(id),
      findingsTotal: store.countFindings(id),
      confirmedBugs: store.countConfirmedBugs(id),
      runCount: store.countRuns(id),
      latestRun: store.latestRun(id) ?? null,
      activeRuns: activeByTarget.get(String(project.name)) ?? 0,
    };
  });
}

function streamSnapshots(res: ServerResponse, store: MetadataStore): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const timer = setInterval(tick, 1200);
  res.on("close", () => clearInterval(timer));
  tick();
  // A throw here (closed socket, or a transient store read error) must not crash the server.
  function tick(): void {
    try {
      res.write(`data: ${JSON.stringify({ projects: projectSnapshots(store), active: activeRuns(store) })}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }
}

// Build a launch spec from the project's stored materials/config + the request body
// (verb + run-shape flags + optional one-off overrides). Unbounded (null) budgets stay
// undefined so the kernel's unbounded default applies.
function launchSpec(project: Record<string, unknown>, body: Record<string, unknown>, out: string, profile?: ProviderProfile): LaunchSpec {
  const cfg = (safeParse(project.config_json) as Record<string, unknown>) ?? {};
  const overrides = (body.overrides as Record<string, unknown>) ?? {};
  const merged = { ...cfg, ...((overrides.config as Record<string, unknown>) ?? {}) };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const list = (v: unknown, fallback: unknown): string[] => {
    const arr = Array.isArray(v) ? v : (safeParse(fallback) as unknown[]) ?? [];
    return arr.filter((x): x is string => typeof x === "string");
  };
  // The VENDOR comes from the selected profile; MODEL + THINKING come from the project's
  // per-phase config (cfg.phases). Each verb has a "primary" phase that drives the run's
  // top-level model/thinking; an audit run (run/audit/map) additionally maps map/dig into
  // roles (refute follows dig). Legacy projects with profile-baked model/thinking/roles still
  // resolve via the profile fallback. Materials are RELATIVE to the project dir (resolved on
  // the daemon against its workspace); dir defaults to the name.
  const verb = (typeof body.verb === "string" ? body.verb : "run") as RunKind;
  const phases = (merged.phases && typeof merged.phases === "object" ? merged.phases : {}) as Record<string, { model?: unknown; thinking?: unknown }>;
  const primaryPhase = verb === "prepare" ? "prepare" : verb === "map" ? "map" : verb === "confirm" ? "confirm" : "dig";
  const phaseModel = (ph: string): string | undefined => str(phases[ph]?.model);
  const phaseThinking = (ph: string): string | undefined => str(phases[ph]?.thinking);
  const roleEntry = (ph: string): RoleOverride | undefined => {
    const model = phaseModel(ph), thinking = phaseThinking(ph);
    return model || thinking ? { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) } : undefined;
  };
  const roles: ProviderRoles = {};
  if (verb === "run" || verb === "audit" || verb === "map") {
    for (const [role, ph] of [["map", "map"], ["dig", "dig"], ["refute", "dig"]] as const) {
      const e = roleEntry(ph);
      if (e) roles[role] = e;
    }
  }
  const legacyRoles = profile && Object.keys(profile.roles).length > 0 ? profile.roles : undefined;
  return {
    verb,
    target: String(project.name),
    dir: str(project.dir) ?? String(project.name),
    sourcePaths: list(overrides.sourcePaths, project.source_paths),
    buildRoot: str(overrides.buildRoot) ?? str(project.build_root),
    corpusPaths: list(overrides.corpusPaths, project.corpus_paths),
    provider: profile?.provider ?? str(merged.provider),
    model: phaseModel(primaryPhase) ?? str(profile?.model) ?? str(merged.model),
    thinking: phaseThinking(primaryPhase) ?? str(profile?.thinking) ?? str(merged.thinking),
    models: Object.keys(roles).length > 0 ? roles : legacyRoles,
    maxScopes: num(merged.maxScopes),
    mapSteps: num(merged.mapSteps),
    digSteps: num(merged.digSteps),
    maxSteps: num(merged.maxSteps),
    digSamples: num(merged.digSamples),
    digConcurrency: num(merged.digConcurrency),
    remap: Boolean(body.remap),
    fresh: Boolean(body.fresh),
    quick: Boolean(body.quick),
    mockLlm: Boolean(body.mockLlm),
    region: str(body.region),
    scope: str(body.scope),
    scopeNote: str(merged.scopeNote), // a project may store a default focus note in its config
    ...(body.verifyFindings !== undefined ? { verifyFindings: body.verifyFindings } : {}),
    inputRunDir: str(body.inputRunDir),
    clue: str(body.clue),
    posture: str(body.posture),
    matchDeployed: typeof body.matchDeployed === "boolean" ? body.matchDeployed : undefined,
    endpoint: str(body.endpoint),
    out,
  };
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
