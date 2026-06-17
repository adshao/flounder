// Local web app for tracking/driving audits across projects. Zero-dependency: Node's
// built-in http server + a vanilla SPA (src/server/ui-html.ts). Reads the SQLite tracking
// store and drives the RunManager (which shells out to `fsa`). Binds to localhost only —
// it can spawn audit processes, so it must not be exposed on the network. This is the
// backend a later formal API would grow from.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MetadataStore } from "../db/store.js";
import { RunManager, type LaunchSpec } from "./run-manager.js";

// The SPA is a static asset copied to dist/server/public at build (scripts/copy-assets.mjs),
// kept as a real .html file so its own backticks/${} do not fight a TS template literal.
// Read per request (a tiny file) so a rebuilt asset shows on reload without a server restart.
const UI_HTML_PATH = fileURLToPath(new URL("./public/index.html", import.meta.url));
function loadUiHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:2rem'>fsa UI asset missing — run <code>npm run build</code>.</body>";
  }
}

export interface UiServerOptions {
  out?: string;
  port?: number;
  host?: string;
}

export function startUiServer(options: UiServerOptions = {}): ReturnType<typeof createServer> {
  const out = options.out ?? "runs";
  const port = options.port ?? 4500;
  const host = options.host ?? "127.0.0.1"; // localhost only — this endpoint can spawn processes
  const store = MetadataStore.openForOutput(out); // long-lived reader; WAL sees committed writes
  const manager = new RunManager();

  const server = createServer((req, res) => {
    handle(req, res, store, manager, out).catch((error) => sendJson(res, 500, { error: String(error instanceof Error ? error.message : error) }));
  });
  server.listen(port, host, () => {
    console.log(`[fsa ui] http://${host}:${port}  (tracking store: ${out}/fsa.db)`);
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, store: MetadataStore, manager: RunManager, out: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(loadUiHtml());
    return;
  }

  if (method === "GET" && path === "/api/projects") {
    sendJson(res, 200, { projects: projectSnapshots(store, manager) });
    return;
  }

  if (method === "GET" && path.startsWith("/api/projects/")) {
    const name = decodeURIComponent(path.slice("/api/projects/".length));
    const project = store.listProjects().find((row) => row.name === name);
    if (!project) {
      sendJson(res, 404, { error: `no project named ${name}` });
      return;
    }
    const id = Number(project.id);
    const findings = store.listFindings(id).map((finding) => ({
      ...finding,
      timeline: store.findingTimeline(Number(finding.id)),
    }));
    sendJson(res, 200, {
      project,
      progress: store.scopeProgress(id),
      runs: store.listRuns(id),
      findings,
      confirmDecisions: store.listConfirmDecisions(id),
    });
    return;
  }

  if (method === "GET" && path === "/api/active") {
    sendJson(res, 200, { active: manager.active() });
    return;
  }

  if (method === "GET" && path === "/api/stream") {
    streamSnapshots(res, store, manager);
    return;
  }

  if (method === "POST" && path === "/api/launch") {
    const spec = (await readBody(req)) as LaunchSpec;
    const result = manager.launch({ ...spec, out });
    sendJson(res, 200, result);
    return;
  }

  if (method === "POST" && path === "/api/continue") {
    const spec = (await readBody(req)) as Omit<LaunchSpec, "verb" | "remap">;
    sendJson(res, 200, manager.continueAudit({ ...spec, out }));
    return;
  }

  if (method === "POST" && path === "/api/restart") {
    const spec = (await readBody(req)) as Omit<LaunchSpec, "verb" | "remap">;
    sendJson(res, 200, manager.restartAudit({ ...spec, out }));
    return;
  }

  if (method === "POST" && path === "/api/kill") {
    const body = (await readBody(req)) as { pid?: number };
    if (typeof body.pid !== "number") {
      sendJson(res, 400, { error: "pid (number) required" });
      return;
    }
    sendJson(res, 200, { killed: manager.kill(body.pid) });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// One row per project for the dashboard: coverage, finding counts by status, latest run,
// and whether a process is currently active for it.
function projectSnapshots(store: MetadataStore, manager: RunManager): Array<Record<string, unknown>> {
  const activeByTarget = new Map<string, number>();
  for (const run of manager.active()) activeByTarget.set(run.target, (activeByTarget.get(run.target) ?? 0) + 1);
  return store.listProjects().map((project) => {
    const id = Number(project.id);
    const runs = store.listRuns(id);
    const findings = store.listFindings(id);
    const counts: Record<string, number> = {};
    for (const finding of findings) counts[String(finding.status)] = (counts[String(finding.status)] ?? 0) + 1;
    return {
      name: project.name,
      config: safeParse(project.config_json),
      progress: store.scopeProgress(id),
      findingCounts: counts,
      findingsTotal: findings.length,
      runCount: runs.length,
      latestRun: runs[0] ?? null,
      activeRuns: activeByTarget.get(String(project.name)) ?? 0,
    };
  });
}

// Server-sent events: push the project snapshot + active list ~1/s so the dashboard shows
// live progress (a polling read-model is plenty for a local single-user tool).
function streamSnapshots(res: ServerResponse, store: MetadataStore, manager: RunManager): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const tick = (): void => {
    res.write(`data: ${JSON.stringify({ projects: projectSnapshots(store, manager), active: manager.active() })}\n\n`);
  };
  tick();
  const timer = setInterval(tick, 1200);
  res.on("close", () => clearInterval(timer));
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
