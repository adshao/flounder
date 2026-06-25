// Run-spec utilities shared by the control plane (server) and the execution plane (daemon):
// the translation of a UI/agent LaunchSpec into an AuditorConfig (what the daemon runs) and
// into equivalent `flounder` CLI argv (for display), plus the per-run ActivityBus the server uses
// to fan a daemon's token-level activity out to the UI's live log. Execution itself lives in
// the daemon (src/server/daemon.ts); this module holds no run state.

import path from "node:path";
import { defaultConfig, defaultOutputDir, THINKING_LEVELS, type AuditorConfig } from "../config.js";
import type { RunKind, ProviderRoles } from "../db/store.js";
import type { SandboxBackend, SandboxNetworkMode } from "../security/sandbox.js";

const DEFAULT_OUT = defaultOutputDir();
const THINKING = new Set<string>(THINKING_LEVELS);

export type Activity = { kind: string; delta?: string; tool?: string; step?: number; ts?: string };

// In-memory per-run feed of the model's streaming activity (token-level thinking/output +
// tool calls), for live UI streaming without per-token disk writes. Keeps a recent ring
// buffer so a late subscriber gets backlog, then live events.
export class ActivityBus {
  private readonly buffer: Activity[] = [];
  private readonly listeners = new Set<(ev: Activity) => void>();
  push(ev: Activity): void {
    const item = ev.ts ? ev : { ...ev, ts: new Date().toISOString() };
    this.buffer.push(item);
    if (this.buffer.length > 2000) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(item);
      } catch {
        // a broken listener must not stop the run
      }
    }
  }
  subscribe(fn: (ev: Activity) => void): () => void {
    for (const ev of this.buffer) fn(ev); // replay backlog
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  snapshot(limit = 200): Activity[] {
    const n = Math.max(0, Math.min(Math.floor(limit), this.buffer.length));
    return this.buffer.slice(this.buffer.length - n);
  }
}

export interface LaunchSpec {
  verb: RunKind; // run | map | audit | confirm | report (verify is an audit selector)
  target: string;
  sourcePaths: string[];
  buildRoot?: string | undefined;
  corpusPaths?: string[] | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  coverageMode?: string | undefined;
  coverageTarget?: number | undefined;
  maxScopes?: number | undefined;
  mapSteps?: number | undefined;
  digSteps?: number | undefined;
  maxSteps?: number | undefined;
  digSamples?: number | undefined;
  digConcurrency?: number | undefined;
  remap?: boolean | undefined; // run/map/audit: re-enumerate the scope inventory (restart)
  fresh?: boolean | undefined; // confirm: ignore a prior interrupted confirm
  inputRunDir?: string | undefined; // confirm: the finished run dir to reproduce
  inputRunDirs?: string[] | undefined; // confirm (aggregate): several run dirs whose confirmed findings are unioned + reproduced together
  confirmKeys?: string[] | undefined; // confirm: restrict the work list to these finding content keys (the pending/target set the control plane resolved from finding status)
  reportFindings?: ReportFindingSpec[] | undefined; // report: confirmed/reproduced bugs to package as formal Markdown reports
  pipeline?: boolean | undefined; // run: project/CLI clue pipeline (prepare if needed -> map/dig -> verify -> confirm -> report)
  verifyFromStart?: boolean | undefined; // pipeline: re-run Verify from the beginning instead of only pending candidates
  region?: string | undefined; // audit: a pinned region
  scope?: string | undefined; // audit: scope id[,id...]
  verifyFindings?: unknown; // audit: inline suspected finding(s) to confirm-or-refute (the --verify file's contents, carried inline so a remote daemon needs no local file)
  quick?: boolean | undefined; // run: a single breadth pass instead of map -> audit
  mockLlm?: boolean | undefined; // run with the deterministic offline model (no provider needed)
  clue?: string | undefined; // prepare: the tx / address / project / repo / link to acquire from
  posture?: string | undefined; // prepare: blind | informed
  matchDeployed?: boolean | undefined; // prepare: prove staged source matches the live deployment (default true)
  endpoint?: string | undefined; // prepare: read-only access hint (e.g. an RPC URL)
  dir?: string | undefined; // project subdir under the daemon workspace; materials resolve under it
  models?: ProviderRoles | undefined; // per-phase provider/model/thinking overrides (from the selected profile)
  scopeNote?: string | undefined; // map/audit: the "authorized scope note" prior — focuses map on the in-scope target (the pipeline auto-derives it from prepare's manifest; --scope-note also sets it)
  sandboxBackend?: SandboxBackend | undefined;
  sandboxImage?: string | undefined;
  sandboxAllowHostFallback?: boolean | undefined;
  sandboxPrepareNetwork?: SandboxNetworkMode | undefined;
  sandboxConfirmNetwork?: SandboxNetworkMode | undefined;
  sandboxMemoryMb?: number | undefined;
  sandboxCpus?: number | undefined;
  out?: string | undefined;
}

export interface ReportFindingSpec {
  findingId: number;
  findingKey: string;
  title: string;
  evidenceMode?: "real-target-reproduced" | "source-only-local-confirmed" | undefined;
  location?: string | undefined;
  severity?: string | undefined;
  status?: string | undefined;
  confirmStatus?: string | undefined;
  description?: string | undefined;
  evidence?: string | undefined;
  exploitSketch?: string | undefined;
  fix?: string | undefined;
  confidence?: number | undefined;
  decisions?: Array<Record<string, unknown>> | undefined;
}

// Translate a launch spec into an AuditorConfig — the daemon's equivalent of the CLI's
// parseConfig + applyAuditPosture. Budgets are UNBOUNDED unless the spec caps them.
// `workspace` is the daemon's root: when the spec carries a project `dir`, materials are
// RELATIVE to <workspace>/<dir>; otherwise they are used as-is (ad-hoc/legacy specs).
export function specToConfig(spec: LaunchSpec, out: string, workspace?: string): AuditorConfig {
  const cfg = defaultConfig();
  cfg.targetName = spec.target;
  const root = spec.dir !== undefined ? resolveUnder(path.resolve(workspace ?? "."), spec.dir, "project dir") : undefined;
  const resolveMat = (p: string): string => (root ? resolveUnder(root, p, "project material") : p);
  cfg.sourcePaths = spec.sourcePaths.map(resolveMat);
  cfg.corpusPaths = (spec.corpusPaths ?? []).map(resolveMat);
  if (spec.buildRoot) cfg.buildRoot = resolveMat(spec.buildRoot);
  else if (root) cfg.buildRoot = root; // default the buildable root to the whole project dir
  if (spec.provider) cfg.provider = spec.provider;
  if (spec.model) cfg.auditModel = spec.model;
  if (spec.thinking && THINKING.has(spec.thinking)) cfg.thinkingLevel = spec.thinking as AuditorConfig["thinkingLevel"];
  if (spec.models) cfg.models = spec.models as NonNullable<AuditorConfig["models"]>;
  if (spec.sandboxBackend) cfg.sandboxBackend = spec.sandboxBackend;
  if (spec.sandboxImage) cfg.sandboxImage = spec.sandboxImage;
  if (spec.sandboxAllowHostFallback !== undefined) cfg.sandboxAllowHostFallback = spec.sandboxAllowHostFallback;
  if (spec.sandboxPrepareNetwork) cfg.sandboxPrepareNetwork = spec.sandboxPrepareNetwork;
  if (spec.sandboxConfirmNetwork) cfg.sandboxConfirmNetwork = spec.sandboxConfirmNetwork;
  if (spec.sandboxMemoryMb !== undefined) cfg.sandboxMemoryMb = spec.sandboxMemoryMb;
  if (spec.sandboxCpus !== undefined) cfg.sandboxCpus = spec.sandboxCpus;
  cfg.outputDir = out;
  cfg.auditMaxSteps = spec.maxSteps ?? Number.POSITIVE_INFINITY;
  cfg.auditMapSteps = spec.mapSteps ?? Number.POSITIVE_INFINITY;
  cfg.auditDigSteps = spec.digSteps ?? Number.POSITIVE_INFINITY;
  if (spec.maxScopes !== undefined) cfg.auditMaxScopes = spec.maxScopes;
  if (spec.digSamples !== undefined) cfg.auditDigSamples = spec.digSamples;
  if (spec.digConcurrency !== undefined) cfg.auditDigConcurrency = spec.digConcurrency;
  if (spec.remap) cfg.auditRemap = true; // re-enumerate scopes from scratch (restart)
  // prepare + confirm derive their own posture from their options (clue / prior run), not from
  // the sealed audit's map/dig flags — return the base cfg (provider/model/out/target) as-is.
  if (spec.verb === "prepare" || spec.verb === "confirm" || spec.verb === "report") return cfg;
  // The scope-focus prior only applies to the map/dig phases (prepare/confirm returned above and
  // don't consume it). From prepare's manifest or --scope-note.
  if (spec.scopeNote && spec.scopeNote.trim()) cfg.auditScopeNote = spec.scopeNote.trim();
  if (spec.verb === "map") {
    cfg.auditDeep = true;
    cfg.auditMapOnly = true;
  } else if (spec.verb === "audit") {
    if (spec.verifyFindings !== undefined) {
      // verify posture: confirm-or-refute given claims by execution. The daemon materializes the
      // findings to a temp file and sets auditVerify; no map/dig enumeration (auditDeep stays off).
    } else {
      cfg.auditDeep = true;
      if (spec.region) {
        cfg.auditDeepFocus = spec.region;
      } else {
        cfg.auditRequireInventory = true; // dig the existing inventory; never auto-map here
        const ids = (spec.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length > 0) cfg.auditScopeIds = ids;
      }
    }
  } else if (!spec.quick) {
    cfg.auditDeep = true; // run = map -> dig, unless --quick (breadth)
  }
  return cfg;
}

function resolveUnder(root: string, input: string, label: string): string {
  if (path.isAbsolute(input)) throw new Error(`Unsafe ${label}: absolute paths are not allowed in project-relative launch specs.`);
  const normalized = path.normalize(input);
  if (!normalized || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe ${label}: ${input}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, normalized);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Unsafe ${label}: ${input}`);
  }
  return target;
}

// Translate a launch spec into `flounder` CLI argv — NOT used to run (the manager runs in-process),
// but handy for showing the equivalent terminal command. Pure and unit-tested.
export function buildArgs(spec: LaunchSpec): string[] {
  // prepare's argv diverges (positional clue, no --source — it stages its own workspace), so
  // build it on its own path rather than threading the shared audit flags below.
  if (spec.verb === "prepare") {
    const out: string[] = ["prepare"];
    if (spec.clue) out.push(spec.clue);
    out.push("--target", spec.target);
    if (spec.posture) out.push("--posture", spec.posture);
    if (spec.matchDeployed === false) out.push("--no-match-deployed");
    if (spec.endpoint) out.push("--endpoint", spec.endpoint);
    if (spec.provider) out.push("--provider", spec.provider);
    if (spec.model) out.push("--model", spec.model);
    if (spec.thinking) out.push("--thinking", spec.thinking);
    if (spec.maxSteps !== undefined) out.push("--max-steps", String(spec.maxSteps));
    if (spec.sandboxBackend) out.push("--sandbox-backend", spec.sandboxBackend);
    if (spec.sandboxImage) out.push("--sandbox-image", spec.sandboxImage);
    if (spec.sandboxAllowHostFallback) out.push("--allow-host-execution");
    if (spec.sandboxPrepareNetwork) out.push("--prepare-network", spec.sandboxPrepareNetwork);
    if (spec.sandboxConfirmNetwork) out.push("--confirm-network", spec.sandboxConfirmNetwork);
    if (spec.sandboxMemoryMb !== undefined) out.push("--sandbox-memory-mb", String(spec.sandboxMemoryMb));
    if (spec.sandboxCpus !== undefined) out.push("--sandbox-cpus", String(spec.sandboxCpus));
    out.push("--out", spec.out ?? DEFAULT_OUT);
    return out;
  }
  const args: string[] = [spec.verb];
  if (spec.verb === "confirm") {
    if (!spec.inputRunDir) throw new Error("confirm requires inputRunDir (the finished run directory)");
    args.push(spec.inputRunDir);
  } else if (spec.verb === "audit" && spec.region) {
    args.push(spec.region);
  }
  args.push("--target", spec.target);
  if (spec.sourcePaths.length > 0) args.push("--source", ...spec.sourcePaths);
  if (spec.buildRoot) args.push("--build-root", spec.buildRoot);
  if (spec.corpusPaths && spec.corpusPaths.length > 0) args.push("--corpus", ...spec.corpusPaths);
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model) args.push("--model", spec.model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.verb === "audit" && spec.scope) args.push("--scope", spec.scope);
  if (spec.verb === "audit" && spec.verifyFindings !== undefined) args.push("--verify", "<inline-findings>");
  if (spec.verb === "run" && spec.verifyFromStart) args.push("--verify-from-start");
  if (spec.maxScopes !== undefined) args.push("--max-scopes", String(spec.maxScopes));
  if (spec.mapSteps !== undefined) args.push("--map-steps", String(spec.mapSteps));
  if (spec.digSteps !== undefined) args.push("--dig-steps", String(spec.digSteps));
  if (spec.maxSteps !== undefined) args.push("--max-steps", String(spec.maxSteps));
  if (spec.digSamples !== undefined) args.push("--dig-samples", String(spec.digSamples));
  if (spec.digConcurrency !== undefined) args.push("--dig-concurrency", String(spec.digConcurrency));
  if (spec.remap && spec.verb !== "confirm") args.push("--remap");
  if (spec.fresh && spec.verb === "confirm") args.push("--fresh");
  if (spec.quick && spec.verb === "run") args.push("--quick");
  if (spec.mockLlm) args.push("--mock-llm");
  if (spec.sandboxBackend) args.push("--sandbox-backend", spec.sandboxBackend);
  if (spec.sandboxImage) args.push("--sandbox-image", spec.sandboxImage);
  if (spec.sandboxAllowHostFallback) args.push("--allow-host-execution");
  if (spec.sandboxPrepareNetwork) args.push("--prepare-network", spec.sandboxPrepareNetwork);
  if (spec.sandboxConfirmNetwork) args.push("--confirm-network", spec.sandboxConfirmNetwork);
  if (spec.sandboxMemoryMb !== undefined) args.push("--sandbox-memory-mb", String(spec.sandboxMemoryMb));
  if (spec.sandboxCpus !== undefined) args.push("--sandbox-cpus", String(spec.sandboxCpus));
  args.push("--out", spec.out ?? DEFAULT_OUT);
  return args;
}
