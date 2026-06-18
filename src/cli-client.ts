// The CLI as a thin client of the control plane. A `flounder run|map|audit|confirm|prepare`
// (without --local/--mock-llm) builds a launch spec, POSTs it to the control plane, and then
// FOLLOWS the run the daemon executes — so every CLI run is tracked and visible in the UI
// exactly like a UI-launched one, and the API is the single entry point. Execution never
// happens here; if no control plane is reachable we say so and let the user start one
// (`flounder ui`) — we never auto-spawn a server the user can't see.

import path from "node:path";
import type { LaunchSpec } from "./server/run-manager.js";
import { loadCliConfig } from "./config-file.js";

const DEFAULT_SERVER = "http://127.0.0.1:4500";

/** Resolve the control-plane URL: --server flag > FLOUNDER_SERVER env > config `server` > default.
 * (loadCliConfig folds FLOUNDER_SERVER in above the file value, so the flag is the only thing
 * checked here on top of it.) Trailing slash trimmed. */
export function resolveServer(flagValue: string | undefined): string {
  const configured = loadCliConfig().values.server;
  return (flagValue ?? configured ?? DEFAULT_SERVER).replace(/\/+$/, "");
}

// Materials must resolve the same way on a (co-located) daemon that may have a different cwd, so
// they are made absolute before they leave the CLI. The control plane stores the spec verbatim
// and specToConfig uses absolute paths as-is (no project-dir indirection).
export function absolutizeSpec(spec: LaunchSpec): LaunchSpec {
  const abs = (p: string): string => path.resolve(p);
  return {
    ...spec,
    sourcePaths: spec.sourcePaths.map(abs),
    ...(spec.corpusPaths ? { corpusPaths: spec.corpusPaths.map(abs) } : {}),
    ...(spec.buildRoot ? { buildRoot: abs(spec.buildRoot) } : {}),
    ...(spec.inputRunDir ? { inputRunDir: abs(spec.inputRunDir) } : {}),
  };
}

class ControlPlaneDownError extends Error {
  constructor(server: string, cause: unknown) {
    const detail = cause instanceof Error ? ((cause as { code?: string }).code ?? cause.message) : String(cause);
    super(
      `no flounder control plane at ${server} (${detail}).\n` +
        `  Start one:         flounder ui                         (control plane + a co-located executor daemon)\n` +
        `  Or point the CLI:  --server <url>  ·  FLOUNDER_SERVER=<url>  ·  flounder config set server <url>\n` +
        `  Or run in-process: add --local (real run, no server) or --mock-llm (offline)`,
    );
    this.name = "ControlPlaneDownError";
  }
}

async function api(server: string, method: string, route: string, body?: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(server + route, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    throw new ControlPlaneDownError(server, cause);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${route} → ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Enqueue the spec on the control plane and follow the run to completion. Returns the final run
 * row (so a pipeline can chain phases by its run_dir/findings), or undefined if no run started. */
export async function launchViaApi(server: string, spec: LaunchSpec): Promise<Record<string, unknown> | undefined> {
  console.log(`[control plane] ${server}`);
  const launched = await api(server, "POST", "/api/launch", absolutizeSpec(spec));
  const jobId = launched.jobId;
  const daemons = typeof launched.daemons === "number" ? launched.daemons : 0;
  if (typeof jobId !== "number") throw new Error(`launch was not accepted: ${JSON.stringify(launched)}`);
  console.log(`[queued] job #${jobId} (${spec.verb}) on "${spec.target}" · ${daemons} daemon(s) connected`);
  if (daemons === 0) {
    console.log(`[warning] no executor daemon is connected — the job stays queued until one connects.`);
    console.log(`          start one co-located:  flounder ui    (or a remote: flounder daemon --server ${server} --token <token>)`);
  }

  const runId = await waitForRun(server, jobId);
  if (runId === undefined) return undefined; // job ended before a run started (error/canceled) — already reported

  console.log(`[running] run #${runId} — live log below (Ctrl-C stops the run):\n`);
  return await streamAndAwait(server, runId);
}

/** True iff a launchViaApi result finished `done`. */
export function ran(run: Record<string, unknown> | undefined): boolean {
  return run !== undefined && run.status === "done";
}

// Poll the job until a daemon starts its run (run_id appears), or the job fails before that.
async function waitForRun(server: string, jobId: number): Promise<number | undefined> {
  let lastNote = 0;
  for (;;) {
    const { job } = (await api(server, "GET", `/api/jobs/${jobId}`)) as { job?: Record<string, unknown> };
    if (!job) throw new Error(`job #${jobId} not found`);
    if (typeof job.run_id === "number") return job.run_id;
    const status = String(job.status);
    if (status === "error" || status === "canceled") {
      console.error(`[job ${status}] ${job.error ? String(job.error) : "(no detail)"}`);
      return undefined;
    }
    const now = Date.now();
    if (now - lastNote > 5000) {
      console.log(`[${status}] waiting for a daemon to start the run…`);
      lastNote = now;
    }
    await delay(700);
  }
}

// Stream the live activity log while polling for the run's terminal status. Ctrl-C asks the
// control plane to stop the run (matching the old local Ctrl-C-ends-it semantics) rather than
// silently detaching; a second Ctrl-C force-exits the CLI and leaves the run to the daemon.
async function streamAndAwait(server: string, runId: number): Promise<Record<string, unknown> | undefined> {
  const ac = new AbortController();
  let stopping = false;
  const onSigint = (): void => {
    if (stopping) {
      console.log(`\n[detached] leaving run #${runId} to the daemon. Track it: flounder db runs  ·  or the UI.`);
      process.exit(130);
    }
    stopping = true;
    console.log(`\n[stopping] asking the control plane to stop run #${runId} (Ctrl-C again to detach and leave it running)…`);
    void api(server, "POST", `/api/runs/${runId}/stop`).catch(() => {});
  };
  process.on("SIGINT", onSigint);
  const streaming = streamLog(server, runId, ac.signal);
  try {
    for (;;) {
      const { run } = (await api(server, "GET", `/api/runs/${runId}`)) as { run?: Record<string, unknown> };
      const status = run ? String(run.status) : "";
      if (status === "done" || status === "error" || status === "killed") {
        await delay(400); // let trailing log frames flush before we cut the stream
        ac.abort();
        await streaming.catch(() => {});
        printRunSummary(run);
        return run;
      }
      await delay(900);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// Consume the run's SSE activity stream (GET /api/runs/:id/log) and render it like a local run.
async function streamLog(server: string, runId: number, signal: AbortSignal): Promise<void> {
  let res: Response | null = null;
  try {
    res = await fetch(`${server}/api/runs/${runId}/log`, { signal });
  } catch {
    return; // stream unavailable — status polling still drives completion
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const print = makeActivityPrinter();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          print(JSON.parse(line.slice(5).trim()) as Activity);
        } catch {
          /* malformed frame */
        }
      }
    }
  } catch {
    /* aborted on terminal status */
  }
}

interface Activity {
  kind: string;
  delta?: string;
  tool?: string;
  step?: number;
}

// Render the three activity kinds the daemon streams (thinking_delta / text_delta / step):
// reasoning dimmed, output normal, tool calls as their own marker line. Channel switches insert
// a newline so the two token streams don't run together.
function makeActivityPrinter(): (ev: Activity) => void {
  const tty = process.stdout.isTTY === true;
  const dim = (s: string): string => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  let last = "";
  return (ev) => {
    if (ev.kind === "step") {
      process.stdout.write(`\n${dim(`→ [${ev.step ?? "?"}] ${ev.tool ?? "tool"}`)}\n`);
      last = "step";
    } else if (ev.kind === "text_delta" && typeof ev.delta === "string") {
      if (last === "thinking") process.stdout.write("\n");
      process.stdout.write(ev.delta);
      last = "text";
    } else if (ev.kind === "thinking_delta" && typeof ev.delta === "string") {
      if (last === "text") process.stdout.write("\n");
      process.stdout.write(dim(ev.delta));
      last = "thinking";
    }
  };
}

function printRunSummary(run: Record<string, unknown> | undefined): void {
  process.stdout.write("\n\n");
  if (!run) {
    console.log("[done]");
    return;
  }
  const status = String(run.status);
  const badge = status === "done" ? "✓ done" : status === "killed" ? "■ stopped" : "✗ error";
  console.log(`[${badge}] run #${run.id} (${String(run.kind)})`);
  if (run.run_dir) console.log(`[run dir] ${String(run.run_dir)}`);
  if (String(run.kind) === "prepare" && run.run_dir) {
    // The acquisition stages source under the run dir; that becomes the sealed audit's --source.
    console.log(`[staged source] ${String(run.run_dir)}/prepare/workspace  ← next: flounder run --source <this> --target <name>`);
    console.log(`[manifest] ${String(run.run_dir)}/prepare_manifest.json  ← provenance: components, deployment-match, posture, gaps`);
  }
  if (run.findings_total != null) console.log(`[findings] ${String(run.findings_total)}`);
  if (run.scopes_total != null) console.log(`[scopes] ${run.scopes_audited ?? "-"}/${String(run.scopes_total)}`);
}
