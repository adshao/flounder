import { spawn } from "node:child_process";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeReproductionCommandSafety } from "./policy.js";
import type { ReproductionCommand, ReproductionCommandResult, ReproductionFile } from "../types.js";

// Shared, security-critical local sandbox primitives. Both the reproduction
// stage and the agent run_test capability route execution through this module
// so command safety, workspace isolation, and output redaction have a single
// implementation. The framework owns these guarantees; the model never does.

export interface SandboxWorkspace {
  absolute: string;
  relative: string;
}

/**
 * Copy the authorized source roots into an isolated workspace under `runDir`.
 * `relativeDir` is a run-relative POSIX path (for example
 * `reproduction/<id>/workspace` or `hunt/<id>/workspace`).
 */
export async function prepareSandboxWorkspace(sourcePaths: string[], runDir: string, relativeDir: string): Promise<SandboxWorkspace> {
  const relative = relativeDir;
  const absolute = path.join(runDir, ...relative.split("/"));
  await mkdir(absolute, { recursive: true });
  if (sourcePaths.length === 1 && (await isDirectory(sourcePaths[0] ?? ""))) {
    await copyDirectoryContents(sourcePaths[0] ?? "", absolute);
  } else {
    for (const sourcePath of sourcePaths) {
      await copySourcePath(sourcePath, path.join(absolute, path.basename(sourcePath)));
    }
  }
  return { absolute, relative };
}

/** Reject command-level policy violations (live networks, non-test runners, remote RPC). */
export function firstBlockedSandboxCommand(commands: ReproductionCommand[]): string | undefined {
  for (const command of commands) {
    const decision = analyzeReproductionCommandSafety(command);
    if (decision.blocked) return decision.reason ?? "Reproduction command blocked by policy.";
  }
  return undefined;
}

/** Reject generated test files that reach for remote URLs, subprocesses, or secrets. */
export function firstBlockedSandboxFile(files: ReproductionFile[]): string | undefined {
  for (const file of files) {
    const decision = analyzeSandboxFileSafety(file);
    if (decision) return decision;
  }
  return undefined;
}

export function analyzeSandboxFileSafety(file: ReproductionFile): string | undefined {
  const content = file.content;
  for (const url of content.match(/\bhttps?:\/\/[^\s"'`<>]+/gi) ?? []) {
    if (!isLocalUrl(url)) {
      return `Blocked by full-stack-auditor guardrail: generated test file ${file.path} must not reference remote URLs.`;
    }
  }
  if (/\b(?:child_process|Deno\.Command|Bun\.spawn|spawnSync|execFileSync|execSync)\b/.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated test file ${file.path} must not spawn subprocesses.`;
  }
  if (/\b(?:PRIVATE_KEY|MNEMONIC|SECRET|TOKEN|ALCHEMY|INFURA|QUICKNODE|MORALIS|ETHERSCAN|RPC_URL)\b/.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated test file ${file.path} must not read secret or RPC environment variables.`;
  }
  if (/\b(?:sendRawTransaction|broadcast|transferFrom|withdraw|drain)\b/i.test(content) && /\b(?:mainnet|testnet|public\s+rpc|production)\b/i.test(content)) {
    return `Blocked by full-stack-auditor guardrail: generated test file ${file.path} combines live-network and value-moving terms.`;
  }
  return undefined;
}

export async function writeSandboxFiles(workspaceAbsolute: string, files: ReproductionFile[]): Promise<void> {
  for (const file of files) {
    const target = resolveWorkspacePath(workspaceAbsolute, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export async function runSandboxCommand(
  command: ReproductionCommand,
  workspaceAbsolute: string,
  maxLogBytes: number,
  redactPaths: string[],
): Promise<ReproductionCommandResult> {
  const cwd = command.cwd ? resolveWorkspacePath(workspaceAbsolute, command.cwd) : workspaceAbsolute;
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  const tmpDir = path.join(workspaceAbsolute, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  const child = spawn(command.program, command.args, {
    cwd,
    shell: false,
    env: localSandboxEnv(workspaceAbsolute, tmpDir),
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, command.timeoutMs ?? 120_000);

  child.stdout?.on("data", (chunk) => {
    stdout = appendLimited(stdout, String(chunk), maxLogBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendLimited(stderr, String(chunk), maxLogBytes);
  });

  await new Promise<void>((resolve) => {
    child.on("error", (error) => {
      stderr = appendLimited(stderr, error.message, maxLogBytes);
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });
  clearTimeout(timer);

  const redactionScope = [workspaceAbsolute, tmpDir, ...redactPaths, ...machineRedactionPaths()];
  return {
    command,
    exitCode,
    expectedExitCode: command.expectedExitCode ?? 0,
    timedOut,
    durationMs: Date.now() - started,
    stdout: redactMachineStrings(redactLocalPaths(stdout, redactionScope)),
    stderr: redactMachineStrings(redactLocalPaths(stderr, redactionScope)),
  };
}

/** Case-insensitive literal success-pattern match against combined command output. */
export function matchSuccessPatterns(patterns: string[], commandResults: ReproductionCommandResult[]): { matched: string[]; missing: string[] } {
  const output = commandResults.map((result) => [result.stdout, result.stderr].join("\n")).join("\n").toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const pattern of patterns) {
    const needle = pattern.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (output.includes(needle)) matched.push(pattern);
    else missing.push(pattern);
  }
  return {
    matched,
    missing: patterns.length === 0
      ? ["No verifier-owned executableSuccessPatterns were provided; reproduction-agent-only strings cannot confirm execution."]
      : missing,
  };
}

export function normalizeRelativePath(input: string): string | undefined {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/")).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || path.isAbsolute(input) || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

export function resolveWorkspacePath(workspace: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new Error(`Unsafe sandbox path: ${relativePath}`);
  const target = path.resolve(workspace, ...normalized.split("/"));
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe sandbox path: ${relativePath}`);
  }
  return target;
}

export function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "finding";
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipCopyName(entry.name)) continue;
    await copySourcePath(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
}

async function copySourcePath(sourcePath: string, targetPath: string): Promise<void> {
  if (shouldSkipCopyName(path.basename(sourcePath))) return;
  await cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => !shouldSkipCopyName(path.basename(source)),
  });
}

async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

function shouldSkipCopyName(name: string): boolean {
  return new Set([".git", ".hg", ".svn", "node_modules", "vendor", "target", "build", "dist", "coverage", "runs", "__pycache__", ".cache", ".next", ".nuxt", ".turbo"]).has(name);
}

function appendLimited(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, Math.max(0, maxBytes)) + "\n[truncated]\n";
}

function redactLocalPaths(input: string, paths: string[]): string {
  let out = input;
  for (const candidate of paths) {
    if (!candidate) continue;
    const absolute = path.resolve(candidate);
    out = replaceAll(out, absolute, "<local-path>");
  }
  return out;
}

function machineRedactionPaths(): string[] {
  return [process.env.HOME, process.env.TMPDIR, process.env.TEMP, process.env.TMP].filter((value): value is string => Boolean(value));
}

function redactMachineStrings(input: string): string {
  let out = input;
  for (const value of [process.env.USER, process.env.LOGNAME]) {
    if (value && value.length >= 3) out = replaceAll(out, value, "<local-user>");
  }
  return out;
}

function replaceAll(input: string, needle: string, replacement: string): string {
  return input.split(needle).join(replacement);
}

function localSandboxEnv(workspace: string, tmpDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: workspace,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    XDG_CACHE_HOME: path.join(tmpDir, "xdg-cache"),
    CARGO_HOME: path.join(tmpDir, "cargo-home"),
    GOCACHE: path.join(tmpDir, "go-build-cache"),
    GOMODCACHE: path.join(tmpDir, "go-mod-cache"),
    NPM_CONFIG_CACHE: path.join(tmpDir, "npm-cache"),
  };
  if (process.env.PATH !== undefined) out.PATH = process.env.PATH;
  if (process.env.LANG !== undefined) out.LANG = process.env.LANG;
  if (process.env.LC_ALL !== undefined) out.LC_ALL = process.env.LC_ALL;
  return out;
}

export function isLocalUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}
