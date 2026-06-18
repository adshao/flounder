import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { listWorkspaceFiles, prepareSandboxWorkspace } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import { publicPath } from "../util/paths.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type ToolContext } from "./tools.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";

// `flounder prepare` — the open-world ACQUISITION phase that runs BEFORE map. Given a clue
// (a tx, an address, a project, a package, a repo, a link), it resolves the complete dependency
// closure, fetches the source, and — by default — proves each deployed component matches the
// code actually running on its platform, staging everything into a workspace with a provenance
// manifest. The staged workspace becomes the (sealed) audit's --source; unresolved components
// are recorded
// as gaps the audit treats as known trust boundaries. Like confirm, prepare is an agent
// session with network + bash: the framework supplies the network capability + the fixed
// constraints (mainnet-match, provenance, posture firewall, never-broadcast); the model does
// the resolution. Nothing here is per-technology.

export interface PrepareRunResult {
  runDir: string;
  workspaceDir: string;
  manifest: unknown;
  validation: PrepareValidation;
}

export interface PrepareValidation {
  components: number;
  /** deployed components proven to match the live code */
  matched: number;
  /** deployed components the agent could NOT match (honest, but a trust boundary) */
  unverified: number;
  /** non-deployed components whose source origin (repo+rev / pkg+ver / path+digest) is pinned */
  sourcePinned: number;
  /** tier-routing violations: a deployed component left un-classified, or a non-deployed one with no pinned origin */
  issues: string[];
}

export async function runPrepare(
  cfg: AuditorConfig,
  options: {
    clue: string;
    posture: "blind" | "informed";
    matchDeployed: boolean;
    endpoint?: string;
    maxSteps?: number;
    streamEvents?: boolean;
    signal?: AbortSignal;
    onRun?: (runId: number) => void;
    onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number }) => void;
    makeTracker?: RunTrackerFactory;
  },
): Promise<PrepareRunResult> {
  // Prepare fetches source and reads live chains, so it needs a real network-capable agent.
  if (!isPiSessionProvider(cfg.provider)) {
    throw new Error(
      `flounder prepare needs a pi-session provider (e.g. openai-codex) — it fetches source and reads live chains. Set --provider openai-codex (and log pi in).`,
    );
  }

  // UNBOUNDED by default (acquisition + bytecode matching is heavy); a turn cap applies only
  // when the caller passes --max-steps. prepareMode=true swaps the bash tool to the
  // network-enabled policy (fork/read/fetch/clone — never broadcast), same as confirm.
  const prepareCfg: AuditorConfig = { ...cfg, prepareMode: true, auditMaxSteps: options.maxSteps ?? Number.POSITIVE_INFINITY };
  const startedAt = new Date();
  const logger = new RunLogger(prepareCfg.outputDir, `${prepareCfg.targetName}-prepare`, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, `${prepareCfg.targetName}-prepare`);

  // Empty staging workspace: the agent fetches the target's source/docs INTO it; this
  // directory (plus prepare_manifest.json) becomes the audit's --source. sourcePaths points
  // at it so the bash tool has a workspace root even though we start with nothing on disk.
  const workspace = await prepareSandboxWorkspace([], logger.runDir, "prepare/workspace");
  const stagedCfg: AuditorConfig = { ...prepareCfg, sourcePaths: [workspace.absolute], buildRoot: workspace.absolute };

  const session: AgentSession = newSession();
  session.workspace = workspace;
  session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
  session.buildCacheDir = path.join(projectHistoryDir(historyLocation(stagedCfg)), "build-cache");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(stagedCfg)), "memory.jsonl"));
  const ctx: ToolContext = { cfg: stagedCfg, source: [], corpus: [], memory, logger, session };
  const tools = buildTools();

  // SQLite tracking: record this prepare under the SAME project store the UI reads, so a
  // CLI-run prepare shows up in the UI exactly like run/map/audit/confirm. makeTracker lets a
  // UI-dispatched daemon supply its own tracker; the default opens <outputDir>/flounder.db.
  // Failure-isolated: a disabled recorder is a no-op, the prepare still runs.
  const recorder = (options.makeTracker ?? RunRecorder.start)(stagedCfg, logger.runDir, "prepare", logger);
  if (recorder.runDbId !== undefined) options.onRun?.(recorder.runDbId);

  const matchLine = options.matchDeployed
    ? "REQUIRED where a live deployed/published instance exists — prove the staged source is the code actually running there (use whatever the platform offers); mark any deployed component you cannot match as \"unverified\". If there is NO live instance, match is \"n/a\" — pin the exact source origin (repo+revision / package+version / path+digest) instead. Either way, never present unmatched source as the target."
    : "off — pin full source provenance for everything staged, but do not require deployment matching";
  const seed = [
    `Clue: ${options.clue}`,
    `Posture: ${options.posture}`,
    `Deployment match: ${matchLine}`,
    options.endpoint ? `Suggested read-only endpoint/access hint: ${options.endpoint}` : `Use whatever read-only access the target's ecosystem provides.`,
  ].join("\n");

  await logger.event("audit_prepare_start", {
    clue: options.clue,
    posture: options.posture,
    matchDeployed: options.matchDeployed,
    provider: prepareCfg.provider,
    model: prepareCfg.auditModel,
    maxSteps: Number.isFinite(prepareCfg.auditMaxSteps) ? prepareCfg.auditMaxSteps : "unlimited",
  });

  await runAuditSession({
    cfg: stagedCfg,
    ctx,
    tools,
    logger,
    cwd: workspace.absolute,
    fileManifest: "(workspace is empty — stage all fetched source/docs here)",
    prepare: seed,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });

  const manifest = readPrepareManifest(session);
  const validation = validatePrepareManifest(manifest, options.matchDeployed);
  await logger.artifact("prepare_manifest.json", manifest ?? { error: "no prepare_manifest.json written by the model", clue: options.clue });
  await logger.event("audit_prepare_done", {
    hasManifest: manifest !== undefined,
    workspace: publicPath(workspace.absolute),
    components: validation.components,
    matched: validation.matched,
    unverified: validation.unverified,
    sourcePinned: validation.sourcePinned,
    issues: validation.issues.length,
  });

  recorder.finish(manifest !== undefined ? "done" : "error");

  return { runDir: logger.runDir, workspaceDir: workspace.absolute, manifest: manifest ?? null, validation };
}

function readPrepareManifest(session: AgentSession): unknown {
  let entry = session.scratchFiles.get("prepare_manifest.json");
  if (entry === undefined) {
    for (const [key, value] of session.scratchFiles) {
      if (key.endsWith("/prepare_manifest.json")) {
        entry = value;
        break;
      }
    }
  }
  if (entry === undefined) return undefined;
  const text = typeof entry === "string" ? entry : String(entry);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Two-tier constraint, auto-routed PER COMPONENT by whether a live deployment exists:
//   Tier 1 (deployed)     -> staged source must be proven to match the running code ("matched"),
//                            or honestly flagged "unverified" (which the audit treats as a trust boundary).
//   Tier 2 (no deployment)-> match is "n/a"; the source ORIGIN must instead be pinned.
// This validates the model's manifest against those two tiers — it does not re-run the match
// (the model cites its own evidence, like confirm); it checks every component is correctly
// classified + pinned and surfaces any tier-routing violation.
function validatePrepareManifest(manifest: unknown, matchDeployed: boolean): PrepareValidation {
  const issues: string[] = [];
  const out: PrepareValidation = { components: 0, matched: 0, unverified: 0, sourcePinned: 0, issues };
  if (!manifest || typeof manifest !== "object") {
    issues.push("no prepare_manifest.json (or not a JSON object) was produced");
    return out;
  }
  const comps = (manifest as { components?: unknown }).components;
  const list = Array.isArray(comps) ? (comps as Array<Record<string, unknown>>) : [];
  out.components = list.length;
  if (list.length === 0) issues.push("manifest lists no components");
  for (const c of list) {
    const id = String(c?.identity ?? c?.role ?? "?");
    const platform = String(c?.platform ?? "").trim().toLowerCase();
    const deployed = platform.length > 0 && platform !== "none" && platform !== "n/a";
    const match = String(c?.match ?? "").trim().toLowerCase();
    const revision = String(c?.revision ?? "").trim();
    if (deployed) {
      if (match === "matched") out.matched += 1;
      else if (match === "unverified") out.unverified += 1;
      else issues.push(`${id}: deployed on "${platform}" but match="${match || "missing"}" — a deployed component must be "matched" or "unverified"`);
    } else {
      if (match && match !== "n/a") issues.push(`${id}: no deployment but match="${match}" — should be "n/a"`);
      if (revision.length > 0) out.sourcePinned += 1;
      else issues.push(`${id}: no deployment and no pinned source origin (need repo+revision / package+version / path+digest)`);
    }
  }
  if (matchDeployed && out.unverified > 0) {
    issues.push(`${out.unverified} deployed component(s) UNVERIFIED — staged source not proven to match the live code; the audit should treat each as a trust boundary`);
  }
  return out;
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return { outputDir: cfg.outputDir, targetName: cfg.targetName, ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}) };
}
