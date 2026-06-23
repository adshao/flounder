import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { listWorkspaceFiles, prepareSandboxWorkspace, writeSandboxFiles } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import { publicPath } from "../util/paths.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type ToolContext } from "./tools.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";
import type { RunStatus } from "../db/store.js";

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
      `flounder prepare needs a session provider (e.g. openai-codex) because it fetches source and reads live chains. Set --provider openai-codex and run \`flounder daemon provider login openai-codex\` on the daemon machine first.`,
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
  const tools = buildTools({ prepare: true });

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

  let manifest = readPrepareManifest(session, workspace.absolute);
  const validation = validatePrepareManifest(manifest, options.matchDeployed);
  manifest = normalizePrepareManifest(manifest, validation);
  const blockingIssues = prepareValidationBlockingIssues(validation);
  if (manifest !== undefined) {
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeSandboxFiles(workspace.absolute, [{ path: "prepare_manifest.json", content }]);
    session.scratchFiles.set("prepare_manifest.json", content);
  }
  await logger.artifact("prepare_manifest.json", manifest ?? { error: "no prepare_manifest.json written by the model", clue: options.clue });
  await logger.event("audit_prepare_done", {
    hasManifest: manifest !== undefined,
    workspace: publicPath(workspace.absolute),
    components: validation.components,
    matched: validation.matched,
    unverified: validation.unverified,
    sourcePinned: validation.sourcePinned,
    issues: validation.issues.length,
    blockingIssues: blockingIssues.length,
  });

  const finalStatus: RunStatus = options.signal?.aborted ? "killed" : manifest !== undefined && blockingIssues.length === 0 ? "done" : "error";
  recorder.finish(finalStatus);
  if (finalStatus === "error") {
    const reason = blockingIssues.length > 0 ? blockingIssues.join("; ") : "no prepare_manifest.json written by the model";
    throw new Error(`prepare did not produce usable source materials: ${reason}`);
  }

  return { runDir: logger.runDir, workspaceDir: workspace.absolute, manifest: manifest ?? null, validation };
}

export function prepareValidationBlockingIssues(validation: PrepareValidation): string[] {
  return uniqueStrings(
    validation.issues.filter((issue) => {
      const raw = issue.toLowerCase();
      return raw.includes("no prepare_manifest.json")
        || raw.includes("manifest lists no components");
    }),
  );
}

export function normalizePrepareManifest(manifest: unknown, validation: PrepareValidation): unknown {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manifest;
  const row = manifest as Record<string, unknown>;
  const current = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  const openGaps = hasOpenPrepareGaps(row);
  const pendingPlaceholders = hasPendingPreparePlaceholders(row);
  const needsReview = validation.issues.length > 0 || validation.unverified > 0 || openGaps || pendingPlaceholders;
  if (["ready", "done", "complete", "completed", "verified", "partial"].includes(current)) {
    if (!needsReview) return manifest;
    return {
      ...row,
      status: "partial",
      status_reason:
        current === "partial" && typeof row.status_reason === "string" && row.status_reason.trim()
          ? row.status_reason
          : "prepare run ended with unresolved gaps, placeholders, or validation issues",
    };
  }
  const status = needsReview ? "partial" : "complete";
  return {
    ...row,
    status,
    status_reason:
      typeof row.status_reason === "string" && row.status_reason.trim()
        ? row.status_reason
        : status === "partial"
          ? "prepare run ended with unresolved gaps, placeholders, or validation issues"
          : "prepare run ended with staged neutral materials ready for sealed audit",
  };
}

export function readPrepareManifest(session: Pick<AgentSession, "scratchFiles">, workspaceDir?: string): unknown {
  if (workspaceDir) {
    const file = path.join(workspaceDir, "prepare_manifest.json");
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return { raw: readFileSync(file, "utf8") };
      }
    }
  }
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
  const manifestRow = manifest as Record<string, unknown>;
  const comps = (manifest as { components?: unknown }).components;
  const list = Array.isArray(comps) ? (comps as Array<Record<string, unknown>>) : [];
  out.components = list.length;
  if (list.length === 0) issues.push("manifest lists no components");
  let deployedComponents = 0;
  for (const c of list) {
    const deploymentMatch = objectRecord(c?.deployment_match);
    const provenance = objectRecord(c?.provenance) ?? objectRecord(c?.origin);
    const id = String(c?.identity ?? c?.role ?? c?.id ?? c?.name ?? c?.path ?? "?");
    const platform = String(c?.platform ?? "").trim().toLowerCase();
    const type = str(c?.type).toLowerCase();
    const deployed = str(c?.address).length > 0
      || Object.keys(objectRecord(c?.addresses) ?? {}).length > 0
      || type.includes("ethereum_contract")
      || type.includes("deployed_contract")
      || type.includes("deployment")
      || isDeploymentPlatform(platform);
    const match = normalizePrepareMatchStatus(str(c?.match ?? deploymentMatch?.status));
    const revision = str(
      c?.revision
        ?? provenance?.revision
        ?? provenance?.commit
        ?? provenance?.tag
        ?? provenance?.ref
        ?? provenance?.branch
        ?? provenance?.repo_revision
        ?? provenance?.source_pin
        ?? provenance?.source_verifier
        ?? provenance?.metadata
        ?? objectRecord(provenance?.code_digest)?.sha256,
    );
    const unresolvedFields = pendingPreparePlaceholderFields(c, provenance, deploymentMatch);
    if (unresolvedFields.length > 0) issues.push(`${id}: unresolved prepare placeholder(s): ${unresolvedFields.join(", ")}`);
    if (deployed) {
      deployedComponents += 1;
      if (match === "matched") out.matched += 1;
      else if (match === "unverified") out.unverified += 1;
      else issues.push(`${id}: deployed on "${platform}" but match="${match || "missing"}" — a deployed component must be "matched" or "unverified"`);
    } else {
      if (revision.length > 0 && !isPendingPreparePlaceholder(revision)) out.sourcePinned += 1;
      else issues.push(`${id}: no deployment and no pinned source origin (need repo+revision / package+version / path+digest)`);
    }
  }
  if (matchDeployed && out.unverified > 0) {
    issues.push(`${out.unverified} deployed component(s) UNVERIFIED — staged source not proven to match the live code; the audit should treat each as a trust boundary`);
  }
  validateRealTargetPlan(manifestRow, { issues, deployedComponents });
  return out;
}

function normalizePrepareMatchStatus(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  if (raw === "na" || raw === "none" || raw.startsWith("n/a") || raw.includes("not_applicable") || raw.includes("not-applicable")) return "n/a";
  if (raw.includes("unverified") || raw.includes("not_verified") || raw.includes("no_match")) return "unverified";
  if (raw === "matched" || raw.includes("verified") || raw.includes("matched") || raw.includes("sourcify")) return "matched";
  return raw;
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

function validateRealTargetPlan(manifest: Record<string, unknown>, ctx: { issues: string[]; deployedComponents: number }): void {
  const realTarget = objectRecord(manifest.real_target) ?? objectRecord(manifest.realTarget);
  if (!realTarget) {
    ctx.issues.push("prepare manifest missing real_target verification plan");
    return;
  }

  const requiredRaw = realTarget.requires_confirmation ?? realTarget.requiresConfirmation ?? realTarget.requires_real_target_confirmation;
  if (typeof requiredRaw !== "boolean") {
    ctx.issues.push("real_target.requires_confirmation must be true or false");
    return;
  }

  const explicitMode = str(realTarget.mode).toLowerCase();
  const mode = explicitMode || (requiredRaw === true ? "deployed" : requiredRaw === false ? "source-only" : "");
  if (!mode) ctx.issues.push("real_target.mode is missing");

  const groundTruth = Array.isArray(realTarget.ground_truth)
    ? realTarget.ground_truth
    : Array.isArray(realTarget.groundTruth)
      ? realTarget.groundTruth
      : [];
  const guidance = objectRecord(realTarget.confirm_guidance) ?? objectRecord(realTarget.confirmGuidance);
  const guidanceText = str(realTarget.confirm_guidance ?? realTarget.confirmGuidance);
  const methodFallback = str(realTarget.method ?? realTarget.read_only_method ?? realTarget.readOnlyMethod) || guidanceText;
  if (requiredRaw !== false && !guidance && !methodFallback) ctx.issues.push("real_target.confirm_guidance is missing");
  const guidanceRequired = guidance ? guidance.required : undefined;
  if (guidance && typeof guidanceRequired === "boolean" && guidanceRequired !== requiredRaw) {
    ctx.issues.push("real_target.confirm_guidance.required disagrees with real_target.requires_confirmation");
  }

  if (requiredRaw) {
    if (groundTruth.length === 0) ctx.issues.push("real_target requires confirmation but has no ground_truth entries");
    groundTruth.forEach((entry, index) => {
      const row = objectRecord(entry);
      if (!row) {
        ctx.issues.push(`real_target.ground_truth[${index}] is not an object`);
        return;
      }
      const kind = (str(row.kind) || (str(row.network) && str(row.address) ? "chain" : "")).toLowerCase();
      const address = str(row.address);
      const network = str(row.network);
      const role = str(row.role);
      const sourceMatch = str(row.source_match ?? row.sourceMatch ?? row.deployment_match_status ?? row.deploymentMatchStatus).toLowerCase();
      if (!kind) ctx.issues.push(`real_target.ground_truth[${index}] missing kind`);
      if (!role) ctx.issues.push(`real_target.ground_truth[${index}] missing role`);
      if (!sourceMatch) ctx.issues.push(`real_target.ground_truth[${index}] missing source_match`);
      if (kind === "chain") {
        if (!network) ctx.issues.push(`real_target.ground_truth[${index}] chain entry missing network`);
        if (row.chain_id === undefined && row.chainId === undefined) ctx.issues.push(`real_target.ground_truth[${index}] chain entry missing chain_id`);
        if (!address) ctx.issues.push(`real_target.ground_truth[${index}] chain entry missing address`);
      }
    });
    const method = str(guidance?.recommended_method ?? guidance?.recommendedMethod ?? methodFallback);
    if (!method) ctx.issues.push("real_target.confirm_guidance.recommended_method is missing");
  } else {
    const reason = str(realTarget.not_required_reason ?? realTarget.reason ?? guidance?.not_required_reason ?? guidance?.notRequiredReason);
    if (!reason) ctx.issues.push("real_target says confirmation is not required but gives no reason");
    if (ctx.deployedComponents > 0) {
      ctx.issues.push("real_target says confirmation is not required even though deployed components were staged");
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function hasOpenPrepareGaps(manifest: Record<string, unknown>): boolean {
  const gaps = manifest.gaps;
  if (!Array.isArray(gaps)) return false;
  return gaps.some((gap) => {
    if (gap === undefined || gap === null) return false;
    if (typeof gap === "string") return isPendingPreparePlaceholder(gap);
    if (typeof gap !== "object" || Array.isArray(gap)) return true;
    const row = gap as Record<string, unknown>;
    if (row.resolved === true) return false;
    const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
    if (["closed", "resolved", "complete", "completed", "done", "verified"].includes(status)) return false;
    if (["open", "pending", "partial", "unresolved", "blocked"].includes(status)) return true;
    return isPendingPreparePlaceholder(row.id) || isPendingPreparePlaceholder(row.kind) || isPendingPreparePlaceholder(row.description) || isPendingPreparePlaceholder(row.note) || isPendingPreparePlaceholder(row.where);
  });
}

function hasPendingPreparePlaceholders(manifest: Record<string, unknown>): boolean {
  const comps = Array.isArray(manifest.components) ? (manifest.components as Array<Record<string, unknown>>) : [];
  return comps.some((component) => {
    const deploymentMatch = objectRecord(component.deployment_match);
    const provenance = objectRecord(component.provenance) ?? objectRecord(component.origin);
    return pendingPreparePlaceholderFields(component, provenance, deploymentMatch).length > 0;
  });
}

function pendingPreparePlaceholderFields(
  component: Record<string, unknown>,
  provenance?: Record<string, unknown>,
  deploymentMatch?: Record<string, unknown>,
): string[] {
  const revision = component.revision
    ?? provenance?.revision
    ?? provenance?.commit
    ?? provenance?.tag
    ?? provenance?.ref
    ?? provenance?.branch
    ?? provenance?.repo_revision
    ?? provenance?.source_pin
    ?? provenance?.source_verifier
    ?? provenance?.metadata
    ?? objectRecord(provenance?.code_digest)?.sha256;
  const fields: Array<[string, unknown]> = [
    ["revision", revision],
    ["staged_path", component.staged_path ?? component.stagedPath ?? component.path],
    ["match", component.match ?? deploymentMatch?.status],
  ];
  return fields.filter(([, value]) => isPendingPreparePlaceholder(value)).map(([label]) => label);
}

function isPendingPreparePlaceholder(value: unknown): boolean {
  const raw = str(value).toLowerCase();
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return { outputDir: cfg.outputDir, targetName: cfg.targetName, ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}) };
}
