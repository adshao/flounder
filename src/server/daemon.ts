// flounder daemon — the EXECUTION plane. Connects to a control-plane server, claims queued
// jobs, runs runAudit/runConfirm LOCALLY (code, provider keys, and the sandbox stay on
// this machine), and reports progress to the server over HTTP: SSE for dispatch + cancel
// nudges, POST for run start / updates / activity. It can run on a different machine than
// the server — the server owns the DB; the daemon never touches it.

import path from "node:path";
import os from "node:os";
import { writeFile } from "node:fs/promises";
import { runAudit } from "../agent/audit.js";
import { runConfirm } from "../agent/confirm.js";
import { runPrepare } from "../agent/acquire.js";
import { MockAuditLlmClient } from "../llm/mock.js";
import { specToConfig, type LaunchSpec } from "./run-manager.js";
import { toScopeRow, toFindingRow, configSnapshot, type RunTracker, type ConfirmDecisionInput } from "../db/record.js";
import type { AuditorConfig } from "../config.js";
import type { Coverage, RunStatus } from "../db/store.js";
import type { AgentFinding, AuditScope } from "../agent/tools.js";

export interface DaemonOptions {
  server: string;
  token: string;
  out?: string;
  name?: string;
  concurrency?: number;
  workspace?: string; // root under which project dirs live; materials resolve here (default ./workspace)
}

type Activity = { kind: string; delta?: string; tool?: string; step?: number };

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const base = opts.server.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const out = opts.out ?? "runs";
  const workspace = path.resolve(opts.workspace ?? "workspace"); // where project dirs (and their relative materials) live
  const maxConcurrent = Math.max(1, opts.concurrency ?? 2);
  const inflight = new Map<number, AbortController>(); // jobId -> abort

  const reg = await fetch(base + "/api/daemon/register", { method: "POST", headers, body: JSON.stringify({ name: opts.name ?? "daemon", capabilities: {}, workspace }) }).catch(() => null);
  if (!reg || !reg.ok) throw new Error(`daemon: could not register with ${base} (status ${reg ? reg.status : "no response"}) — check --server and --token`);
  console.log(`[flounder daemon] connected to ${base}  (out=${out}, workspace=${workspace}, concurrency=${maxConcurrent})`);

  const claimLoop = async (): Promise<void> => {
    while (inflight.size < maxConcurrent) {
      const res = await fetch(base + "/api/daemon/claim", { method: "POST", headers }).catch(() => null);
      if (!res || !res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { job?: { id: number; project: string; spec: LaunchSpec } };
      if (!data.job) return;
      void runJob(data.job);
    }
  };

  const runJob = async (job: { id: number; project: string; spec: LaunchSpec }): Promise<void> => {
    const abort = new AbortController();
    inflight.set(job.id, abort);
    const spec: LaunchSpec = { ...job.spec, out };
    let tracker: RemoteTracker | undefined;
    const sink = activitySink(() => tracker);
    const makeTracker = (cfg: AuditorConfig, runDir: string, kind: string): RunTracker => {
      tracker = new RemoteTracker(base, headers, { jobId: job.id, project: cfg.targetName, kind, runDir, provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, budgets: configSnapshot(cfg) });
      return tracker;
    };
    try {
      const cfg = specToConfig(spec, out, workspace);
      if (spec.verb === "confirm") {
        if (!spec.inputRunDir) throw new Error("confirm requires inputRunDir");
        await runConfirm(cfg, { inputRunDir: spec.inputRunDir, signal: abort.signal, makeTracker, onActivity: sink.push, ...(spec.inputRunDirs ? { inputRunDirs: spec.inputRunDirs } : {}), ...(spec.confirmKeys ? { confirmKeys: spec.confirmKeys } : {}), ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}), ...(spec.fresh ? { fresh: true } : {}) });
      } else if (spec.verb === "prepare") {
        if (!spec.clue) throw new Error("prepare requires a clue (tx / address / project / link)");
        await runPrepare(cfg, {
          clue: spec.clue,
          posture: spec.posture === "informed" ? "informed" : "blind",
          matchDeployed: spec.matchDeployed !== false,
          signal: abort.signal,
          makeTracker,
          onActivity: sink.push,
          ...(spec.endpoint !== undefined ? { endpoint: spec.endpoint } : {}),
          ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
        });
      } else {
        if (spec.verb === "audit" && spec.verifyFindings !== undefined) {
          // verify posture: write the inline findings to a temp file the kernel's verify path reads.
          const vf = path.join(os.tmpdir(), `flounder-verify-${job.id}.json`);
          await writeFile(vf, JSON.stringify(spec.verifyFindings), "utf8");
          cfg.auditVerify = vf;
        }
        await runAudit(cfg, { kind: spec.verb, signal: abort.signal, makeTracker, onActivity: sink.push, ...(spec.mockLlm ? { llm: new MockAuditLlmClient() } : {}) });
      }
      sink.flush();
      await post(base, headers, `/api/daemon/jobs/${job.id}/status`, { status: abort.signal.aborted ? "canceled" : "done" });
    } catch (error) {
      sink.flush();
      await post(base, headers, `/api/daemon/jobs/${job.id}/status`, { status: abort.signal.aborted ? "canceled" : "error", error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    } finally {
      inflight.delete(job.id);
      void claimLoop();
    }
  };

  // SSE: dispatch nudges (re-claim) + cancels. Reconnect with backoff; also claim on connect.
  for (;;) {
    try {
      const res = await fetch(base + "/api/daemon/stream", { headers });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      void claimLoop();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
            const ev = JSON.parse(line.slice(5).trim()) as { type: string; jobId?: number };
            if (ev.type === "poll") void claimLoop();
            else if (ev.type === "cancel" && ev.jobId !== undefined) inflight.get(ev.jobId)?.abort();
          } catch {
            // ignore malformed frame
          }
        }
      }
    } catch {
      // disconnected — reconnect after a short backoff
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Reports a run's progress to the server. Serializes calls on one chain so the run is
// created first (and updates land in order); keys everything by the server-assigned runId.
class RemoteTracker implements RunTracker {
  readonly runDbId = undefined; // remote: the server owns the run id; not needed by the kernel
  private chain: Promise<void>;
  private runId: number | undefined;

  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string>,
    start: { jobId: number; project: string; kind: string; runDir: string; provider?: string; model?: string; thinking?: string; budgets: unknown },
  ) {
    this.chain = this.req("POST", "/api/daemon/runs", start).then((r) => {
      this.runId = (r as { runId?: number } | null)?.runId;
    });
  }

  private enqueue(make: () => Promise<unknown>): void {
    this.chain = this.chain.then(make).then(
      () => {},
      () => {},
    );
  }

  private async req(method: string, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.base + path, { method, headers: this.headers, body: JSON.stringify(body) }).catch(() => null);
    return res && res.ok ? res.json().catch(() => null) : null;
  }

  scopes(scopes: AuditScope[]): void {
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { scopes: scopes.map(toScopeRow) }) : Promise.resolve()));
  }

  runScopes(done: number, target: number): void {
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { runScopes: { done, target } }) : Promise.resolve()));
  }

  findings(findings: AgentFinding[], runDir: string, reason?: string): void {
    if (findings.length === 0) return;
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { findings: findings.map((f) => toFindingRow(f, runDir)), reason }) : Promise.resolve()));
  }

  confirmDecisions(rows: ConfirmDecisionInput[], decisionPath?: string): void {
    if (rows.length === 0) return;
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { confirmDecisions: rows, decisionPath }) : Promise.resolve()));
  }

  finish(status: RunStatus, coverage?: Coverage, findingsTotal?: number): void {
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { finish: { status, coverage, findingsTotal } }) : Promise.resolve()));
  }

  activity(events: Activity[]): void {
    this.enqueue(() => (this.runId ? this.req("POST", `/api/daemon/runs/${this.runId}/activity`, { events }) : Promise.resolve()));
  }
}

// Batches token-level activity (~200ms) so the live stream stays token-granular without a
// network POST per token. Routes through the run's tracker (which holds the server runId).
function activitySink(getTracker: () => RemoteTracker | undefined): { push: (ev: Activity) => void; flush: () => void } {
  let buffer: Activity[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushNow = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    getTracker()?.activity(batch);
  };
  return {
    push: (ev) => {
      buffer.push(ev);
      if (!timer) timer = setTimeout(() => { timer = null; flushNow(); }, 200);
    },
    flush: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      flushNow();
    },
  };
}

async function post(base: string, headers: Record<string, string>, path: string, body: unknown): Promise<void> {
  await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => {});
}
