import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { analyzeAgentBashCommandSafety, analyzeConfirmBashCommandSafety, isAgentBuildCommand, isAgentConfirmCommand } from "../security/policy.js";
import { prepareWorkspaceToolchain } from "./prepare.js";
import {
  firstBlockedSandboxFile,
  matchSuccessPatterns,
  normalizeRelativePath,
  prepareSandboxWorkspace,
  resolveWorkspacePath,
  runSandboxCommand,
  type SandboxWorkspace,
  writeSandboxFiles,
} from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import type { ConfirmationStatus, Doc, ReproductionCommand, ReproductionCommandResult, ReproductionFile, Severity } from "../types.js";
import type { ProjectMemory } from "./memory.js";

// Pi-style capability surface for audit mode. The framework exposes generic
// affordances and hard guarantees only: read material, write/edit a copied
// workspace, run a policy-gated local command, and validate executable evidence.
// Bug classes, search schedules, source facts, and report actions are not
// default tools because they tell the model how to reason.

export interface FixPatch {
  path: string;
  old: string;
  new: string;
}

export interface AgentFinding {
  id: string;
  title: string;
  severity: Severity;
  location: string;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
  confidence: number;
  confirmationStatus: ConfirmationStatus;
  commandRunId?: string;
  /** Optional machine-applicable fix for differential (fail-after-fix) confirmation. */
  fixPatch?: FixPatch;
  /** Patterns the cited test prints once the exploit is blocked by the applied fix. */
  patchedSuccessPatterns?: string[];
  /** Independent-skeptic verdict (a fresh-context model that tried to break the claim). */
  refutation?: { refuted: boolean; reason: string; unrealistic?: boolean };
  /** An execution-proven finding an independent skeptic disputes — kept, but flagged for humans. */
  disputed?: boolean;
  /** Outcome of the one appeal a refuted finding may make: rebuild a faithful PoC that
   * answers the skeptic's objection. Recorded whether upheld or not, so the original
   * confirmation + refutation + appeal trail is never lost. */
  appeal?: { attempted: boolean; upheld: boolean; reason: string };
  /** The map-phase scope this finding came from (when the map → dig flow produced it). */
  scopeId?: string;
}

export interface CommandRunRecord {
  id: string;
  passed: boolean;
  command: string;
  /** Structured command, so the framework can re-run it for differential confirmation. */
  commandSpec: ReproductionCommand;
  successPatterns: string[];
  matched: string[];
  missing: string[];
  exitCode: number | null;
  expectedExitCode: number;
  timedOut: boolean;
  workspace: string;
}

export interface AgentSession {
  findings: AgentFinding[];
  commandRuns: CommandRunRecord[];
  finished: boolean;
  finishSummary?: string;
  counters: { command: number; finding: number };
  workspace?: SandboxWorkspace;
  scratchFiles: Map<string, string>;
  /** Whether the toolchain warm-up has run for this session's workspace. */
  prepared?: boolean;
  /** Persistent, host-isolated package cache (CARGO_HOME etc.) reused across runs. */
  buildCacheDir?: string;
  /**
   * Workspace-relative paths of the pristine target source (captured right after
   * copy). The model may not write/edit these, so a confirmation runs against
   * untampered code — it can only add new test files.
   */
  baselineFiles?: Set<string>;
}

export function newSession(): AgentSession {
  return {
    findings: [],
    commandRuns: [],
    finished: false,
    counters: { command: 0, finding: 0 },
    scratchFiles: new Map(),
  };
}

export interface ToolContext {
  cfg: AuditorConfig;
  source: Doc[];
  corpus: Doc[];
  memory: ProjectMemory;
  logger: RunLogger;
  session: AgentSession;
}

export interface ToolResult {
  observation: string;
  meta?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function buildTools(): AgentTool[] {
  return [readTool, writeTool, editTool, bashTool];
}

/** Render the tool catalogue for the system prompt. */
export function renderToolCatalogue(tools: AgentTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

export function ingestFindingsFromScratch(session: AgentSession): { parsed: number; errors: string[] } {
  const entry = findingsJsonEntry(session);
  if (!entry) {
    session.findings = [];
    session.counters.finding = 0;
    return { parsed: 0, errors: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch (error) {
    session.findings = [];
    return { parsed: 0, errors: [`${entry.path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).findings)
      ? ((raw as Record<string, unknown>).findings as unknown[])
      : undefined;
  if (!items) {
    session.findings = [];
    return { parsed: 0, errors: [`${entry.path}: expected an array or an object with a findings array.`] };
  }

  const findings: AgentFinding[] = [];
  const errors: string[] = [];
  for (const [idx, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`findings[${idx}]: expected object.`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = asString(record.title);
    const location = asString(record.location);
    if (!title || !location) {
      errors.push(`findings[${idx}]: "title" and "location" are required.`);
      continue;
    }

    const commandRunId = asString(record.command_id) ?? asString(record.commandRunId) ?? asString(record.test_run_id);
    const citedRun = commandRunId ? session.commandRuns.find((run) => run.id === commandRunId) : undefined;
    const confirmed = Boolean(citedRun?.passed);
    const id = asString(record.id) ?? `f${findings.length + 1}`;
    const fixPatch = normalizeFixPatch(record.fix_patch ?? record.fixPatch);
    findings.push({
      id,
      title,
      severity: asEnum(record.severity, ["info", "low", "medium", "high", "critical"], "medium") as Severity,
      location,
      description: asString(record.description) ?? "",
      evidence: asString(record.evidence) ?? "",
      exploitSketch: asString(record.exploit_sketch) ?? asString(record.exploitSketch) ?? "",
      fix: asString(record.fix) ?? "",
      confidence: clampFloat(record.confidence, 0, 1, 0.5),
      confirmationStatus: confirmed ? "confirmed-executable" : "suspected",
      ...(confirmed && citedRun ? { commandRunId: citedRun.id } : {}),
      ...(fixPatch ? { fixPatch } : {}),
      ...(asStringList(record.patched_success_patterns ?? record.patchedSuccessPatterns).length > 0
        ? { patchedSuccessPatterns: asStringList(record.patched_success_patterns ?? record.patchedSuccessPatterns) }
        : {}),
    });

    if (commandRunId && !citedRun) errors.push(`findings[${idx}]: command_id "${commandRunId}" does not match a bash command run.`);
    if (commandRunId && citedRun && !citedRun.passed) errors.push(`findings[${idx}]: command_id "${commandRunId}" is not confirmation-eligible.`);
  }

  session.findings = findings;
  session.counters.finding = findings.length;
  return { parsed: findings.length, errors };
}

const readTool: AgentTool = {
  name: "read",
  description:
    'Read loaded source/corpus or a file written in the sandbox. args: {"path": string, "start"?: int (1-based), "end"?: int}. Without a range it returns up to 400 lines.',
  async run(args, ctx) {
    const target = asString(args.path);
    if (!target) return { observation: 'error: "path" is required' };
    const readable = await findReadable(ctx, target);
    if (!readable) return { observation: `error: no loaded or sandbox file matches "${target}". Use bash with ls/find/rg to inspect the copied workspace.` };
    const allLines = readable.content.split(/\r?\n/);
    const total = allLines.length;
    const start = clampInt(args.start, 1, Math.max(1, total), 1);
    const defaultEnd = Math.min(total, start + 399);
    const end = clampInt(args.end, start, Math.max(start, total), defaultEnd);
    const slice = allLines.slice(start - 1, end);
    const numbered = slice.map((line, idx) => `${start + idx}\t${line}`).join("\n");
    return {
      observation: `${readable.path} lines ${start}-${end} of ${total} (${readable.kind})\n${numbered}`,
      meta: { path: readable.path, start, end, total, kind: readable.kind },
    };
  },
};

const writeTool: AgentTool = {
  name: "write",
  description:
    'Write a file inside the copied sandbox workspace. args: {"path": relative, "content": string}. To report results, write findings.json at the workspace root.',
  async run(args, ctx) {
    const normalized = normalizeToolPath(args.path);
    if (!normalized) return { observation: 'error: "path" must be a safe relative path.' };
    const content = typeof args.content === "string" ? args.content : undefined;
    if (content === undefined) return { observation: 'error: "content" is required.' };
    if (Buffer.byteLength(content, "utf8") > ctx.cfg.reproductionMaxFileBytes) return { observation: "error: content exceeds the configured file-size limit." };

    if (baselineProtected(ctx, normalized)) return { observation: baselineBlockMessage(normalized) };
    if (!isReportFile(normalized)) {
      const blockedFile = firstBlockedSandboxFile([{ path: normalized, content }]);
      if (blockedFile) return { observation: `blocked: ${blockedFile}` };
    }

    const workspace = await ensureWorkspace(ctx);
    if (!workspace) return { observation: "error: write needs on-disk source roots (sourcePaths); none are configured for this run." };
    await writeSandboxFiles(workspace.absolute, [{ path: normalized, content }]);
    ctx.session.scratchFiles.set(normalized, content);
    await ctx.logger.event("audit_write", { path: normalized, bytes: Buffer.byteLength(content, "utf8") });
    return { observation: `wrote ${normalized} (${Buffer.byteLength(content, "utf8")} bytes) in sandbox workspace ${workspace.relative}.`, meta: { path: normalized } };
  },
};

const editTool: AgentTool = {
  name: "edit",
  description:
    'Replace text in a test/scratch file you created in the sandbox workspace. args: {"path": relative, "old": string, "new": string, "replace_all"?: bool}. It cannot modify the target source under audit — write your tests as new files; the framework applies your declared fix during confirmation.',
  async run(args, ctx) {
    const target = asString(args.path);
    if (!target) return { observation: 'error: "path" is required.' };
    const oldText = typeof args.old === "string" ? args.old : undefined;
    const newText = typeof args.new === "string" ? args.new : undefined;
    if (oldText === undefined || newText === undefined || oldText.length === 0) return { observation: 'error: "old" and "new" strings are required, and "old" must be non-empty.' };

    const workspace = await ensureWorkspace(ctx);
    if (!workspace) return { observation: "error: edit needs on-disk source roots (sourcePaths); none are configured for this run." };
    const existing = await readWorkspaceCandidate(ctx, target);
    if (!existing) return { observation: `error: no sandbox file matches "${target}".` };
    if (baselineProtected(ctx, existing.path)) return { observation: baselineBlockMessage(existing.path) };
    if (!existing.content.includes(oldText)) return { observation: `error: old text was not found in ${existing.path}.` };

    const next = asBool(args.replace_all, false) ? existing.content.split(oldText).join(newText) : existing.content.replace(oldText, newText);
    if (Buffer.byteLength(next, "utf8") > ctx.cfg.reproductionMaxFileBytes) return { observation: "error: edited file exceeds the configured file-size limit." };
    if (!isReportFile(existing.path)) {
      const blockedFile = firstBlockedSandboxFile([{ path: existing.path, content: next }]);
      if (blockedFile) return { observation: `blocked: ${blockedFile}` };
    }

    await writeSandboxFiles(workspace.absolute, [{ path: existing.path, content: next }]);
    ctx.session.scratchFiles.set(existing.path, next);
    await ctx.logger.event("audit_edit", { path: existing.path, bytes: Buffer.byteLength(next, "utf8") });
    return { observation: `edited ${existing.path} in sandbox workspace ${workspace.relative}.`, meta: { path: existing.path } };
  },
};

const bashTool: AgentTool = {
  name: "bash",
  description:
    'Run one local command in the copied sandbox workspace. args: {"cmd": string, "purpose"?: "inspect"|"build"|"confirm" (default inspect), "cwd"?: relative, "expected_exit_code"?: int, "success_patterns"?: [string], "timeout_ms"?: int}. Shell control operators, remote networks, destructive commands, and paths outside the workspace are blocked. purpose=inspect is for exploration (ls/find/rg/cat/sed and reads) and never confirms anything. purpose=build is for dependency resolution and compilation (cargo build/fetch, npm install, go mod download, forge build, pip install, …) to make the workspace buildable; it has side effects but is NOT confirmation-eligible. purpose=confirm must be a real local test runner (cargo test, forge test, go test, node --test, pytest, …) with success_patterns; only a confirm command that exits as expected with every success_pattern present becomes confirmation-eligible and citable as command_id for confirmed-executable.',
  async run(args, ctx) {
    const normalized = normalizeBashCommand(args, ctx.cfg);
    if ("error" in normalized) return { observation: normalized.error };
    // CONFIRM mode swaps to the network-enabled policy (fork/read live networks, fetch,
    // search — never broadcast); `flounder run` keeps the network-sealed local-only policy.
    const blocked = (ctx.cfg.confirmMode || ctx.cfg.prepareMode)
      ? analyzeConfirmBashCommandSafety(normalized.command)
      : analyzeAgentBashCommandSafety(normalized.command);
    if (blocked.blocked) return { observation: `blocked: ${blocked.reason ?? "command blocked by policy"}` };

    const workspace = await ensureWorkspace(ctx);
    if (!workspace) return { observation: "error: bash needs on-disk source roots (sourcePaths); none are configured for this run." };
    // Lazy warm-up: only a real test/build command needs dependencies, so prepare
    // the toolchain on first use rather than eagerly for every (possibly
    // read-only or unauthenticated) run.
    if (isAgentConfirmCommand(normalized.command) || isAgentBuildCommand(normalized.command)) await ensurePrepared(ctx, workspace);
    ctx.session.counters.command += 1;
    const runId = `cmd${ctx.session.counters.command}`;
    const result = await runSandboxCommand(normalized.command, workspace.absolute, ctx.cfg.reproductionMaxLogBytes, ctx.cfg.sourcePaths, ctx.session.buildCacheDir);
    const exitMatched = result.exitCode === result.expectedExitCode && !result.timedOut;
    const isConfirm = normalized.purpose === "confirm";
    const eligibleByType = isAgentConfirmCommand(normalized.command);
    // Only a confirm-purpose run of an actual test/build command can pass. This is
    // the gate that keeps an inspection command (e.g. cat of a model-authored file)
    // from forging executable confirmation by echoing a success pattern.
    const patternCheck = isConfirm ? matchSuccessPatterns(normalized.successPatterns, [result]) : { matched: [], missing: [] };
    const passed =
      isConfirm && eligibleByType && exitMatched && normalized.successPatterns.length > 0 && patternCheck.missing.length === 0 && patternCheck.matched.length > 0;
    const record: CommandRunRecord = {
      id: runId,
      passed,
      command: normalized.raw,
      commandSpec: normalized.command,
      successPatterns: normalized.successPatterns,
      matched: patternCheck.matched,
      missing: patternCheck.missing,
      exitCode: result.exitCode,
      expectedExitCode: result.expectedExitCode,
      timedOut: result.timedOut,
      workspace: workspace.relative,
    };
    ctx.session.commandRuns.push(record);
    await ctx.logger.event("audit_command_run", {
      runId,
      purpose: normalized.purpose,
      passed,
      exitCode: result.exitCode,
      expectedExitCode: result.expectedExitCode,
      timedOut: result.timedOut,
      matched: patternCheck.matched.length,
      missing: patternCheck.missing.length,
    });

    const tail = (text: string): string => (text.length > 1600 ? `...${text.slice(-1600)}` : text);
    const verdict = !isConfirm
      ? `command ${runId} (${normalized.purpose}): exit=${result.exitCode}${result.timedOut ? " timedOut" : ""}.`
      : passed
        ? `command ${runId}: CONFIRMATION-ELIGIBLE PASS; cite command_id="${runId}" in findings.json for confirmed-executable.`
        : `command ${runId}: not confirmation-eligible (${confirmFailureReason(eligibleByType, normalized, exitMatched, result, patternCheck)}).`;
    return {
      observation: `${verdict}\n--- stdout ---\n${tail(result.stdout) || "(empty)"}\n--- stderr ---\n${tail(result.stderr) || "(empty)"}`,
      meta: { runId, passed, purpose: normalized.purpose },
    };
  },
};

function confirmFailureReason(
  eligibleByType: boolean,
  normalized: { command: ReproductionCommand; successPatterns: string[] },
  exitMatched: boolean,
  result: ReproductionCommandResult,
  patternCheck: { matched: string[]; missing: string[] },
): string {
  if (!eligibleByType) {
    return `purpose=confirm requires a local test/build runner (cargo test, forge test, go test, node --test, pytest, …); "${normalized.command.program}" is an inspection command, so it cannot confirm a finding`;
  }
  if (normalized.successPatterns.length === 0) return "purpose=confirm requires success_patterns describing the invariant break or patched regression";
  if (!exitMatched) return `exit=${result.exitCode} expected=${result.expectedExitCode} timedOut=${result.timedOut}`;
  return `missing success patterns: ${patternCheck.missing.join(" | ")}`;
}

/** Report files the framework reads back from the workspace (findings + the map's scope inventory). */
export function isReportFile(normalizedPath: string): boolean {
  return normalizedPath === "findings.json" || normalizedPath === "scopes.json";
}

/** True when the path is part of the pristine target source the model may not modify. */
function baselineProtected(ctx: ToolContext, normalizedPath: string): boolean {
  if (isReportFile(normalizedPath)) return false;
  return Boolean(ctx.session.baselineFiles?.has(normalizedPath));
}

function baselineBlockMessage(normalizedPath: string): string {
  return `blocked: "${normalizedPath}" is part of the target source under audit and cannot be modified. Write your test/PoC as a NEW file. To demonstrate a bug, prove it on the unmodified code; the framework applies your declared fix during confirmation.`;
}

async function ensurePrepared(ctx: ToolContext, workspace: SandboxWorkspace): Promise<void> {
  if (!ctx.cfg.auditPrepare || ctx.session.prepared) return;
  ctx.session.prepared = true; // set before awaiting so a second test command does not re-trigger
  await prepareWorkspaceToolchain({ workspace, cfg: ctx.cfg, logger: ctx.logger, ...(ctx.session.buildCacheDir ? { cacheDir: ctx.session.buildCacheDir } : {}) });
}

async function ensureWorkspace(ctx: ToolContext): Promise<SandboxWorkspace | undefined> {
  if (ctx.session.workspace) return ctx.session.workspace;
  if (ctx.cfg.sourcePaths.length === 0) return undefined;
  const workspace = await prepareSandboxWorkspace(ctx.cfg.sourcePaths, ctx.logger.runDir, "audit/workspace");
  ctx.session.workspace = workspace;
  await ctx.logger.event("audit_workspace", { workspace: workspace.relative });
  return workspace;
}

async function findReadable(ctx: ToolContext, target: string): Promise<{ path: string; content: string; kind: string } | undefined> {
  const normalized = normalizeToolPath(target);
  if (normalized && ctx.session.scratchFiles.has(normalized)) {
    return { path: normalized, content: ctx.session.scratchFiles.get(normalized) as string, kind: "scratch" };
  }
  const workspaceContent = await readWorkspaceCandidate(ctx, target);
  if (workspaceContent) return { ...workspaceContent, kind: "sandbox" };
  const doc = findDoc(ctx, target);
  if (doc) return { path: doc.path, content: doc.content, kind: doc.kind };
  return undefined;
}

async function readWorkspaceCandidate(ctx: ToolContext, target: string): Promise<{ path: string; content: string } | undefined> {
  const workspace = ctx.session.workspace;
  if (!workspace) return undefined;
  for (const candidate of workspacePathCandidates(ctx, target)) {
    if (ctx.session.scratchFiles.has(candidate)) return { path: candidate, content: ctx.session.scratchFiles.get(candidate) as string };
    try {
      const content = await readFile(resolveWorkspacePath(workspace.absolute, candidate), "utf8");
      return { path: candidate, content };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function workspacePathCandidates(ctx: ToolContext, target: string): string[] {
  const normalized = normalizeToolPath(target);
  if (!normalized) return [];
  const out = [normalized];
  if (ctx.cfg.sourcePaths.length === 1) {
    const sourceBase = path.basename(path.resolve(ctx.cfg.sourcePaths[0] ?? ""));
    const parts = normalized.split("/");
    if (parts.length > 1 && parts[0] === sourceBase) out.push(parts.slice(1).join("/"));
  }
  return [...new Set(out)];
}

function findDoc(ctx: ToolContext, target: string): Doc | undefined {
  const all = [...ctx.source, ...ctx.corpus];
  return (
    all.find((doc) => doc.path === target) ??
    all.find((doc) => doc.path.endsWith(`/${target}`) || doc.path.endsWith(target)) ??
    all.find((doc) => doc.path.includes(target))
  );
}

function findingsJsonEntry(session: AgentSession): { path: string; content: string } | undefined {
  return scratchReportEntry(session, "findings.json");
}

function scratchReportEntry(session: AgentSession, basename: string): { path: string; content: string } | undefined {
  const direct = session.scratchFiles.get(basename);
  if (direct !== undefined) return { path: basename, content: direct };
  const matches = [...session.scratchFiles.entries()]
    .filter(([filePath]) => path.posix.basename(filePath) === basename)
    .sort((a, b) => a[0].length - b[0].length);
  const first = matches[0];
  return first ? { path: first[0], content: first[1] } : undefined;
}

/** A scope produced by the map phase. Free-form but with the fields dig needs. */
export interface AuditScope {
  id: string;
  obligation: string;
  region: string;
  lenses: string[];
  exposure: string;
  difficulty: string;
  score: number;
  why: string;
  status?: "pending" | "audited" | "deferred" | "auditing";
  digSeconds?: number; // how long this scope's deep-audit took (set when it completes)
  priority?: number; // manual dig-queue ordering (operator "↑ Top"); ordered above score, doesn't change score
}

/** Non-mutating check: did the session write a non-empty findings.json to scratch?
 *  Used by the session driver to decide whether a dig needs a forced finalize
 *  (the dig writes ALL obligations — discharged and flagged — so "empty" means the
 *  obligation analysis was never persisted, not that the region is clean). */
export function scratchHasFindings(session: AgentSession): boolean {
  const entry = scratchReportEntry(session, "findings.json");
  if (!entry) return false;
  try {
    const raw: unknown = JSON.parse(entry.content);
    const items = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).findings)
        ? ((raw as Record<string, unknown>).findings as unknown[])
        : [];
    return items.length > 0;
  } catch {
    return false;
  }
}

/** Parse the map phase's scopes.json from scratch (sorted by score, highest first). */
export function readScratchScopes(session: AgentSession): AuditScope[] {
  const entry = scratchReportEntry(session, "scopes.json");
  if (!entry) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch {
    return [];
  }
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).scopes)
      ? ((raw as Record<string, unknown>).scopes as unknown[])
      : [];
  const scopes: AuditScope[] = [];
  for (const [idx, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const region = asString(r.region) ?? asString(r.location);
    const obligation = asString(r.obligation) ?? asString(r.title);
    if (!region || !obligation) continue;
    const scoreNum = typeof r.score === "number" ? r.score : Number.parseFloat(asString(r.score) ?? "");
    scopes.push({
      id: asString(r.id) ?? `S${idx + 1}`,
      obligation,
      region,
      lenses: Array.isArray(r.lenses) ? r.lenses.filter((x): x is string => typeof x === "string") : [],
      exposure: asString(r.exposure) ?? "unknown",
      difficulty: asString(r.difficulty) ?? "unknown",
      score: Number.isFinite(scoreNum) ? scoreNum : 0,
      why: asString(r.why) ?? "",
    });
  }
  return scopes.sort((a, b) => b.score - a.score);
}

const CONFIRMATION_RANK: Record<string, number> = {
  suspected: 0,
  "confirmed-source": 1,
  "confirmed-executable": 2,
  "confirmed-differential": 3,
};

/** Union findings from multiple dig samples: dedupe by (location, title), keeping the
 *  strongest-confirmed (then highest-confidence) instance. Used when auditDigSamples > 1. */
export function dedupeFindings(findings: AgentFinding[]): AgentFinding[] {
  const best = new Map<string, AgentFinding>();
  for (const finding of findings) {
    const key = `${(finding.location ?? "").trim().toLowerCase()}::${(finding.title ?? "").trim().toLowerCase()}`;
    const current = best.get(key);
    if (!current) {
      best.set(key, finding);
      continue;
    }
    const rankNew = CONFIRMATION_RANK[finding.confirmationStatus] ?? 0;
    const rankCur = CONFIRMATION_RANK[current.confirmationStatus] ?? 0;
    if (rankNew > rankCur || (rankNew === rankCur && (finding.confidence ?? 0) > (current.confidence ?? 0))) {
      best.set(key, finding);
    }
  }
  return [...best.values()];
}

/** Drop the findings.json scratch entry so the next dig pass starts from a clean slate. */
export function clearScratchFindings(session: AgentSession): void {
  for (const key of [...session.scratchFiles.keys()]) {
    if (path.posix.basename(key) === "findings.json") session.scratchFiles.delete(key);
  }
}

function normalizeBashCommand(
  args: Record<string, unknown>,
  cfg: AuditorConfig,
): { raw: string; command: ReproductionCommand; successPatterns: string[]; purpose: "inspect" | "build" | "confirm" } | { error: string } {
  const raw = asString(args.cmd) ?? asString(args.command);
  if (!raw) return { error: 'error: "cmd" is required.' };
  if (raw.length > 4000) return { error: "error: command is too long." };
  const split = splitCommandLine(raw);
  if ("error" in split) return split;
  if (split.argv.length === 0) return { error: "error: command is empty." };
  const program = split.argv[0] ?? "";
  const commandArgs = split.argv.slice(1);
  const command: ReproductionCommand = { program, args: commandArgs };
  const cwd = asString(args.cwd);
  if (cwd && cwd !== ".") {
    const normalizedCwd = normalizeRelativePath(cwd);
    if (!normalizedCwd) return { error: 'error: "cwd" must be a safe relative path.' };
    command.cwd = normalizedCwd;
  }
  // Build/test runners compile (often minutes for large dependency trees), so they
  // get the build-grade timeout ceiling and default; quick inspection commands keep
  // the short timeout. Without this a real `cargo test`/`go test` confirm cannot
  // finish its cold compile within the 120s inspect budget.
  const compiles = isAgentBuildCommand(command) || isAgentConfirmCommand(command);
  const ceilingMs = compiles ? Math.max(cfg.reproductionCommandTimeoutMs, cfg.auditPrepareTimeoutMs) : cfg.reproductionCommandTimeoutMs;
  const defaultMs = compiles ? ceilingMs : cfg.reproductionCommandTimeoutMs;
  command.timeoutMs = clampInt(args.timeout_ms ?? args.timeoutMs, 1000, ceilingMs, defaultMs);
  command.expectedExitCode = clampInt(args.expected_exit_code ?? args.expectedExitCode, 0, 255, 0);
  return { raw, command, successPatterns: asStringList(args.success_patterns), purpose: asEnum(args.purpose, ["inspect", "build", "confirm"], "inspect") };
}

function splitCommandLine(input: string): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (let idx = 0; idx < input.length; idx += 1) {
    const ch = input[idx] as string;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (!quote && (ch === ";" || ch === "&" || ch === "|" || ch === "<" || ch === ">" || ch === "`")) {
      return { error: "blocked: shell control operators are not allowed in agent bash commands." };
    }
    if (ch === "$" && !quote && input[idx + 1] === "(") {
      return { error: "blocked: shell command substitution is not allowed in agent bash commands." };
    }
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
      quote = quote ? undefined : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (quote) return { error: "error: unterminated quote in command." };
  if (current.length > 0) argv.push(current);
  return { argv };
}

function normalizeToolPath(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeRelativePath(value) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return asString(value) ? [asString(value) as string] : [];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, 16);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeFixPatch(value: unknown): FixPatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const path = asString(raw.path);
  const oldText = typeof raw.old === "string" ? raw.old : undefined;
  const newText = typeof raw.new === "string" ? raw.new : undefined;
  if (!path || oldText === undefined || oldText.length === 0 || newText === undefined) return undefined;
  return { path, old: oldText, new: newText };
}

function asEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
