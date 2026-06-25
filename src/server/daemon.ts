// flounder daemon — the EXECUTION plane. Connects to a control-plane server, claims queued
// jobs, runs runAudit/runConfirm LOCALLY (code, provider keys, and the sandbox stay on
// this machine), and reports progress to the server over HTTP: SSE for dispatch + cancel
// nudges, POST for run start / updates / activity. It can run on a different machine than
// the server — the server owns the DB; the daemon never touches it.

import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { runAudit } from "../agent/audit.js";
import { runConfirm } from "../agent/confirm.js";
import { runReport } from "../agent/report.js";
import { runPrepare } from "../agent/acquire.js";
import { MockAuditLlmClient } from "../llm/mock.js";
import { deriveScopeNote } from "../scope-note.js";
import { specToConfig, type LaunchSpec, type ReportFindingSpec } from "./run-manager.js";
import { toScopeRow, toFindingRow, configSnapshot, type RunTracker, type ConfirmDecisionInput, type FindingReportInput } from "../db/record.js";
import { defaultOutputDir, defaultWorkspaceDir, type AuditorConfig } from "../config.js";
import type { Coverage, RunStatus } from "../db/store.js";
import type { AgentFinding, AuditScope } from "../agent/tools.js";
import { assertProviderAuthenticated, knownRuntimeProviders, providerAuthStatus } from "../provider-auth.js";

export interface DaemonOptions {
  server: string;
  token: string;
  out?: string;
  name?: string;
  concurrency?: number;
  workspace?: string; // root under which project dirs live; materials resolve here (default ~/.flounder/workspace)
}

type Activity = { kind: string; delta?: string; tool?: string; step?: number };

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const base = opts.server.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  const out = opts.out ?? defaultOutputDir();
  const workspace = path.resolve(opts.workspace ?? defaultWorkspaceDir()); // where project dirs (and their relative materials) live
  await ensureDaemonDirectories(out, workspace);
  const maxConcurrent = Math.max(1, opts.concurrency ?? 2);
  const inflight = new Map<number, AbortController>(); // jobId -> abort
  const runScopeTargets = new Map<number, number>(); // jobId -> live dig-batch target
  const instanceId = randomUUID();
  const heartbeat = (): void => {
    void post(base, headers, "/api/daemon/heartbeat", { instanceId, activeJobIds: [...inflight.keys()] });
  };

  const reg = await fetch(base + "/api/daemon/register", { method: "POST", headers, body: JSON.stringify({ name: opts.name ?? "daemon", capabilities: await daemonCapabilities(), workspace }) }).catch(() => null);
  if (!reg || !reg.ok) throw new Error(`daemon: could not register with ${base} (status ${reg ? reg.status : "no response"}) — check --server and --token`);
  console.log(`[flounder daemon] connected to ${base}  (out=${out}, workspace=${workspace}, concurrency=${maxConcurrent})`);
  setInterval(heartbeat, 10_000);
  heartbeat();

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
    heartbeat();
    const spec: LaunchSpec = { ...job.spec, out };
    let tracker: RemoteTracker | undefined;
    let phaseStarts = 0;
    const sink = activitySink(() => tracker);
    const makeTracker = (cfg: AuditorConfig, runDir: string, kind: string): RunTracker => {
      tracker = new RemoteTracker(base, headers, { jobId: job.id, project: cfg.targetName, kind, runDir, provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, budgets: cfg.auditVerify ? { ...configSnapshot(cfg), verify: true, ...(cfg.auditVerifyFromStart ? { verifyFromStart: true } : {}) } : configSnapshot(cfg), additional: phaseStarts > 0 });
      phaseStarts += 1;
      return tracker;
    };
    const flushTracker = async (): Promise<void> => {
      sink.flush();
      await tracker?.flush();
    };
    try {
      const cfg = specToConfig(spec, out, workspace);
      if (spec.mockLlm) {
        cfg.sandboxBackend = "host";
        cfg.sandboxAllowHostFallback = true;
      }
      if (!spec.mockLlm) await assertProviderAuthenticated(cfg.provider);
      if (spec.verb === "run" && spec.pipeline) {
        await runPipelineJob(base, headers, spec, { out, workspace, signal: abort.signal, makeTracker, flushTracker, onActivity: sink.push, mockLlm: spec.mockLlm === true, runScopeTargets, jobId: job.id });
      } else if (spec.verb === "report") {
        if (!spec.reportFindings?.length) throw new Error("report requires reproduced finding inputs");
        await runReport(cfg, { findings: spec.reportFindings, signal: abort.signal, makeTracker, onActivity: sink.push, ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}) });
      } else if (spec.verb === "confirm") {
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
        let verifyTempDir: string | undefined;
        if (spec.verb === "audit" && spec.verifyFindings !== undefined) {
          // verify posture: write the inline findings to a temp file the kernel's verify path reads.
          verifyTempDir = await mkdtemp(path.join(os.tmpdir(), `flounder-verify-${job.id}-`));
          const vf = path.join(verifyTempDir, "findings.json");
          await writeFile(vf, JSON.stringify(spec.verifyFindings), "utf8");
          cfg.auditVerify = vf;
        }
        try {
          await runAudit(cfg, {
            kind: spec.verb,
            signal: abort.signal,
            makeTracker,
            onActivity: sink.push,
            control: { getRunScopesTarget: () => runScopeTargets.get(job.id) },
            ...(spec.mockLlm ? { llm: new MockAuditLlmClient() } : {}),
          });
        } finally {
          if (verifyTempDir) await rm(verifyTempDir, { recursive: true, force: true });
        }
      }
      await flushTracker();
      await post(base, headers, `/api/daemon/jobs/${job.id}/status`, { status: abort.signal.aborted ? "canceled" : "done" });
    } catch (error) {
      await flushTracker();
      await post(base, headers, `/api/daemon/jobs/${job.id}/status`, { status: abort.signal.aborted ? "canceled" : "error", error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    } finally {
      inflight.delete(job.id);
      runScopeTargets.delete(job.id);
      heartbeat();
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
            const ev = JSON.parse(line.slice(5).trim()) as { type: string; jobId?: number; target?: number };
            if (ev.type === "poll") void claimLoop();
            else if (ev.type === "cancel" && ev.jobId !== undefined) inflight.get(ev.jobId)?.abort();
            else if (ev.type === "set-run-scopes-target" && ev.jobId !== undefined && typeof ev.target === "number" && Number.isFinite(ev.target)) {
              runScopeTargets.set(ev.jobId, Math.max(1, Math.floor(ev.target)));
            }
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

async function runPipelineJob(
  base: string,
  headers: Record<string, string>,
  spec: LaunchSpec,
  ctx: {
    out: string;
    workspace: string;
    signal: AbortSignal;
    makeTracker: (cfg: AuditorConfig, runDir: string, kind: string) => RunTracker;
    flushTracker: () => Promise<void>;
    onActivity: (event: Activity) => void;
    mockLlm: boolean;
    runScopeTargets: Map<number, number>;
    jobId: number;
  },
): Promise<void> {
  let staged = spec.buildRoot ?? spec.sourcePaths[0];
  let derivedScopeNote: string | undefined;
  if (spec.clue) {
    const prepareCfg = specToConfig({ ...spec, verb: "prepare", sourcePaths: [], buildRoot: undefined, corpusPaths: [] }, ctx.out, ctx.workspace);
    const prepare = await runPrepare(prepareCfg, {
      clue: spec.clue,
      posture: spec.posture === "informed" ? "informed" : "blind",
      matchDeployed: spec.matchDeployed !== false,
      signal: ctx.signal,
      makeTracker: ctx.makeTracker,
      onActivity: ctx.onActivity,
      ...(spec.endpoint !== undefined ? { endpoint: spec.endpoint } : {}),
      ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
    });
    await ctx.flushTracker();
    staged = prepare.workspaceDir;
    derivedScopeNote = deriveScopeNote(prepare.manifest);
  }
  if (!staged) throw new Error("pipeline run needs a prepared workspace or a clue for Prepare");
  const scopeNote = [spec.scopeNote, derivedScopeNote].filter((entry): entry is string => Boolean(entry && entry.trim())).join("\n\n") || undefined;
  const auditSpec: LaunchSpec = {
    ...spec,
    verb: "run",
    dir: undefined,
    sourcePaths: [staged],
    buildRoot: staged,
    ...(scopeNote ? { scopeNote } : {}),
  };
  const auditCfg = specToConfig(auditSpec, ctx.out, ctx.workspace);
  await runAudit(auditCfg, {
    kind: "run",
    signal: ctx.signal,
    makeTracker: ctx.makeTracker,
    onActivity: ctx.onActivity,
    control: { getRunScopesTarget: () => ctx.runScopeTargets.get(ctx.jobId) },
    ...(ctx.mockLlm ? { llm: new MockAuditLlmClient() } : {}),
  });
  await ctx.flushTracker();

  const verify = await pipelineWorklist(base, headers, spec.target, "verify", spec.verifyFromStart === true);
  if (verify.verifyFindings.length > 0) {
    const verifySpec: LaunchSpec = {
      ...spec,
      verb: "audit",
      dir: undefined,
      sourcePaths: [staged],
      buildRoot: staged,
      verifyFindings: verify.verifyFindings,
    };
    const verifyCfg = specToConfig(verifySpec, ctx.out, ctx.workspace);
    const verifyTempDir = await mkdtemp(path.join(os.tmpdir(), `flounder-verify-${ctx.jobId}-`));
    try {
      const vf = path.join(verifyTempDir, "findings.json");
      await writeFile(vf, JSON.stringify(verify.verifyFindings), "utf8");
      verifyCfg.auditVerify = vf;
      await runAudit(verifyCfg, {
        kind: "audit",
        signal: ctx.signal,
        makeTracker: ctx.makeTracker,
        onActivity: ctx.onActivity,
        ...(ctx.mockLlm ? { llm: new MockAuditLlmClient() } : {}),
      });
    } finally {
      await rm(verifyTempDir, { recursive: true, force: true });
    }
    await ctx.flushTracker();
  }

  const confirm = await pipelineWorklist(base, headers, spec.target, "confirm");
  if (confirm.inputRunDir && confirm.inputRunDirs.length > 0 && confirm.confirmKeys.length > 0) {
    const confirmSpec: LaunchSpec = {
      ...spec,
      verb: "confirm",
      dir: undefined,
      sourcePaths: [staged],
      buildRoot: staged,
      inputRunDir: confirm.inputRunDir,
      inputRunDirs: confirm.inputRunDirs,
      confirmKeys: confirm.confirmKeys,
    };
    const confirmCfg = specToConfig(confirmSpec, ctx.out, ctx.workspace);
    await runConfirm(confirmCfg, {
      inputRunDir: confirmSpec.inputRunDir!,
      signal: ctx.signal,
      makeTracker: ctx.makeTracker,
      onActivity: ctx.onActivity,
      ...(confirmSpec.inputRunDirs ? { inputRunDirs: confirmSpec.inputRunDirs } : {}),
      ...(confirmSpec.confirmKeys ? { confirmKeys: confirmSpec.confirmKeys } : {}),
      ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
      ...(spec.fresh ? { fresh: true } : {}),
    });
    await ctx.flushTracker();
  }

  const report = await pipelineWorklist(base, headers, spec.target, "report");
  if (report.reportFindings.length > 0) {
    const reportSpec: LaunchSpec = {
      ...spec,
      verb: "report",
      dir: undefined,
      sourcePaths: [staged],
      buildRoot: staged,
      reportFindings: report.reportFindings,
    };
    const reportCfg = specToConfig(reportSpec, ctx.out, ctx.workspace);
    await runReport(reportCfg, {
      findings: report.reportFindings,
      signal: ctx.signal,
      makeTracker: ctx.makeTracker,
      onActivity: ctx.onActivity,
      ...(spec.maxSteps !== undefined ? { maxSteps: spec.maxSteps } : {}),
    });
  }
}

async function pipelineWorklist(base: string, headers: Record<string, string>, project: string, phase: "verify" | "confirm" | "report", verifyFromStart = false): Promise<{
  verifyFindings: unknown[];
  inputRunDir?: string;
  inputRunDirs: string[];
  confirmKeys: string[];
  reportFindings: ReportFindingSpec[];
}> {
  const res = await fetch(base + "/api/daemon/pipeline-worklist", {
    method: "POST",
    headers,
    body: JSON.stringify({ project, phase, ...(phase === "verify" && verifyFromStart ? { verifyFromStart: true } : {}) }),
  });
  if (!res.ok) throw new Error(`pipeline ${phase} worklist failed (${res.status})`);
  const body = (await res.json().catch(() => ({}))) as {
    inputRunDir?: unknown;
    inputRunDirs?: unknown;
    confirmKeys?: unknown;
    reportFindings?: unknown;
    verifyFindings?: unknown;
  };
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
  const inputRunDir = typeof body.inputRunDir === "string" ? body.inputRunDir : undefined;
  return {
    verifyFindings: Array.isArray(body.verifyFindings) ? body.verifyFindings : [],
    ...(inputRunDir ? { inputRunDir } : {}),
    inputRunDirs: strings(body.inputRunDirs),
    confirmKeys: strings(body.confirmKeys),
    reportFindings: Array.isArray(body.reportFindings) ? body.reportFindings as ReportFindingSpec[] : [],
  };
}

export async function ensureDaemonDirectories(out: string, workspace: string): Promise<void> {
  await mkdir(path.resolve(out), { recursive: true });
  await mkdir(path.resolve(workspace), { recursive: true });
}

async function daemonCapabilities(): Promise<Record<string, unknown>> {
  const providers = await Promise.all(
    knownRuntimeProviders().map(async (provider) => {
      try {
        const status = await providerAuthStatus(provider);
        return {
          provider,
          required: status.required,
          configured: status.configured,
          oauthLogin: status.oauthLogin,
          expectedEnvVars: status.expectedEnvVars,
        };
      } catch {
        return { provider, required: true, configured: false };
      }
    }),
  );
  return { providers };
}

// Reports a run's progress to the server. Serializes calls on one chain so the run is
// created first (and updates land in order); keys everything by the server-assigned runId.
class RemoteTracker implements RunTracker {
  readonly runDbId = undefined; // remote: the server owns the run id; not needed by the kernel
  private chain: Promise<void>;
  private runId: number | undefined;
  private readonly targetName: string;

  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string>,
    start: { jobId: number; project: string; kind: string; runDir: string; provider?: string; model?: string; thinking?: string; budgets: unknown; additional?: boolean },
  ) {
    this.targetName = start.project;
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
    const reportable = findings.filter((finding) => finding.severity !== "info" && finding.confirmationStatus !== "discharged");
    if (reportable.length === 0) return;
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { findings: reportable.map((f) => toFindingRow(f, runDir, this.targetName)), reason }) : Promise.resolve()));
  }

  stage(name: string, info: Record<string, unknown>): void {
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { stage: { name, info } }) : Promise.resolve()));
  }

  confirmDecisions(rows: ConfirmDecisionInput[], decisionPath?: string): void {
    if (rows.length === 0) return;
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { confirmDecisions: rows, decisionPath }) : Promise.resolve()));
  }

  findingReports(reports: FindingReportInput[]): void {
    if (reports.length === 0) return;
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { findingReports: reports }) : Promise.resolve()));
  }

  finish(status: RunStatus, coverage?: Coverage, findingsTotal?: number): void {
    this.enqueue(() => (this.runId ? this.req("PATCH", `/api/daemon/runs/${this.runId}`, { finish: { status, coverage, findingsTotal } }) : Promise.resolve()));
  }

  activity(events: Activity[]): void {
    this.enqueue(() => (this.runId ? this.req("POST", `/api/daemon/runs/${this.runId}/activity`, { events }) : Promise.resolve()));
  }

  flush(): Promise<void> {
    return this.chain;
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
