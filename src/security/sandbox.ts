import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReproductionCommandSafety } from "./policy.js";
import type { ReproductionCommand, ReproductionCommandResult, ReproductionFile } from "../types.js";

// Shared, security-critical local sandbox primitives. Both the reproduction
// stage and the agent bash capability route execution through this module
// so command safety, workspace isolation, and output redaction have a single
// implementation. The framework owns these guarantees; the model never does.

export interface SandboxWorkspace {
  absolute: string;
  relative: string;
}

export const SANDBOX_BACKENDS = ["auto", "oci", "apple-container", "host"] as const;
export type SandboxBackend = typeof SANDBOX_BACKENDS[number];
export type SandboxNetworkMode = "none" | "enabled";
export const DEFAULT_SANDBOX_IMAGE = "flounder-sandbox:latest";
const APPLE_CONTAINER_SEALED_NETWORK = "flounder-sealed";

export interface SandboxExecutionOptions {
  backend?: SandboxBackend;
  image?: string;
  allowHostFallback?: boolean;
  network?: SandboxNetworkMode;
  memoryMb?: number;
  cpus?: number;
}

export interface SandboxReadiness {
  ok: boolean;
  backend: SandboxBackend;
  image: string;
  allowHostFallback: boolean;
  message?: string;
}

export interface SandboxImageBuildResult {
  ok: boolean;
  image: string;
  dockerfile?: string;
  message: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

interface SandboxProcessOptions extends Required<Pick<SandboxExecutionOptions, "backend" | "image" | "allowHostFallback" | "network">> {
  memoryMb?: number;
  cpus?: number;
}

interface ProcessRunInput {
  command: ReproductionCommand;
  workspaceAbsolute: string;
  cwdAbsolute: string;
  tmpDir: string;
  cacheDir?: string;
  maxLogBytes: number;
  options: SandboxProcessOptions;
}

/**
 * Copy the authorized source roots into an isolated workspace under `runDir`.
 * `relativeDir` is a run-relative POSIX path (for example
 * `reproduction/<id>/workspace` or `audit/<id>/workspace`).
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
      return `Blocked by flounder guardrail: generated test file ${file.path} must not reference remote URLs.`;
    }
  }
  if (/\b(?:child_process|Deno\.Command|Bun\.spawn|spawnSync|execFileSync|execSync)\b/.test(content)) {
    return `Blocked by flounder guardrail: generated test file ${file.path} must not spawn subprocesses.`;
  }
  if (/\b(?:PRIVATE_KEY|MNEMONIC|SECRET|TOKEN|ALCHEMY|INFURA|QUICKNODE|MORALIS|ETHERSCAN|RPC_URL)\b/.test(content)) {
    return `Blocked by flounder guardrail: generated test file ${file.path} must not read secret or RPC environment variables.`;
  }
  if (/\b(?:sendRawTransaction|broadcast|transferFrom|withdraw|drain)\b/i.test(content) && /\b(?:mainnet|testnet|public\s+rpc|production)\b/i.test(content)) {
    return `Blocked by flounder guardrail: generated test file ${file.path} combines live-network and value-moving terms.`;
  }
  return undefined;
}

export async function writeSandboxFiles(workspaceAbsolute: string, files: ReproductionFile[]): Promise<void> {
  for (const file of files) {
    const target = await resolveWorkspacePathForWrite(workspaceAbsolute, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

export async function runSandboxCommand(
  command: ReproductionCommand,
  workspaceAbsolute: string,
  maxLogBytes: number,
  redactPaths: string[],
  cacheDir?: string,
  executionOptions: SandboxExecutionOptions = {},
): Promise<ReproductionCommandResult> {
  const cwd = command.cwd ? await resolveWorkspacePathForRead(workspaceAbsolute, command.cwd) : workspaceAbsolute;
  const started = Date.now();
  const tmpDir = path.join(workspaceAbsolute, ".tmp");
  await mkdir(tmpDir, { recursive: true });
  // A persistent, host-isolated package cache (CARGO_HOME etc.) when provided, so
  // dependency builds are downloaded once and reused across runs. HOME stays the
  // per-run workspace either way, so host credentials/config are never exposed.
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  const raw = await runWithSelectedBackend({
    command,
    workspaceAbsolute,
    cwdAbsolute: cwd,
    tmpDir,
    ...(cacheDir ? { cacheDir } : {}),
    maxLogBytes,
    options: normalizeSandboxExecutionOptions(executionOptions),
  });

  const redactionScope = [workspaceAbsolute, tmpDir, ...redactPaths, ...machineRedactionPaths()];
  return {
    command,
    exitCode: raw.exitCode,
    expectedExitCode: command.expectedExitCode ?? 0,
    timedOut: raw.timedOut,
    durationMs: Date.now() - started,
    stdout: redactMachineStrings(redactLocalPaths(raw.stdout, redactionScope)),
    stderr: redactMachineStrings(redactLocalPaths(raw.stderr, redactionScope)),
  };
}

function normalizeSandboxExecutionOptions(input: SandboxExecutionOptions): SandboxProcessOptions {
  return {
    backend: input.backend ?? "auto",
    image: input.image || DEFAULT_SANDBOX_IMAGE,
    allowHostFallback: input.allowHostFallback ?? false,
    network: input.network ?? "none",
    ...(input.memoryMb !== undefined ? { memoryMb: input.memoryMb } : {}),
    ...(input.cpus !== undefined ? { cpus: input.cpus } : {}),
  };
}

export function isDefaultSandboxImage(image: string): boolean {
  return image === DEFAULT_SANDBOX_IMAGE;
}

export function isSandboxBackend(value: unknown): value is SandboxBackend {
  return typeof value === "string" && (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

export function autoPrefersAppleContainer(platform = process.platform, arch = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

export async function checkSandboxReadiness(input: SandboxExecutionOptions = {}): Promise<SandboxReadiness> {
  const options = normalizeSandboxExecutionOptions(input);
  if (options.backend === "host") {
    if (options.allowHostFallback) return { ok: true, backend: options.backend, image: options.image, allowHostFallback: true };
    return {
      ok: false,
      backend: options.backend,
      image: options.image,
      allowHostFallback: false,
      message: "Host sandbox backend requires explicit --allow-host-execution because model-generated commands would run on the local machine.",
    };
  }

  if (options.backend === "apple-container") {
    const appleReady = await checkAppleContainerBackendReady(options);
    if (appleReady.ok) return { ok: true, backend: "apple-container", image: options.image, allowHostFallback: false };
    return {
      ok: false,
      backend: "apple-container",
      image: options.image,
      allowHostFallback: false,
      message: appleReady.message,
    };
  }

  let appleFailure: string | undefined;
  if (options.backend === "auto" && autoPrefersAppleContainer()) {
    const appleReady = await checkAppleContainerBackendReady(options);
    if (appleReady.ok) return { ok: true, backend: "apple-container", image: options.image, allowHostFallback: false };
    appleFailure = appleReady.message;
  }

  const ociAvailable = await isOciSandboxAvailable(options.image);
  if (ociAvailable) return { ok: true, backend: "oci", image: options.image, allowHostFallback: options.allowHostFallback };
  if (options.backend === "oci") {
    return {
      ok: false,
      backend: "oci",
      image: options.image,
      allowHostFallback: options.allowHostFallback,
      message: `OCI sandbox image "${options.image}" is not available. Build or pull it first, or explicitly opt into host execution for trusted local targets.`,
    };
  }
  if (options.allowHostFallback) return { ok: true, backend: "host", image: options.image, allowHostFallback: true };
  return {
    ok: false,
    backend: "auto",
    image: options.image,
    allowHostFallback: false,
    message: noAutoSandboxMessage(options.image, appleFailure),
  };
}

export function clearSandboxAvailabilityCache(image?: string): void {
  if (image) {
    ociAvailability.delete(image);
    appleContainerAvailability.delete(image);
  } else {
    ociAvailability.clear();
    appleContainerAvailability.clear();
  }
}

export async function buildDefaultSandboxImage(options: { timeoutMs?: number } = {}): Promise<SandboxImageBuildResult> {
  const dockerfile = await defaultSandboxDockerfilePath();
  if (!dockerfile) {
    return {
      ok: false,
      image: DEFAULT_SANDBOX_IMAGE,
      message: "Default sandbox Dockerfile was not found in this installation.",
    };
  }
  const root = path.dirname(path.dirname(dockerfile));
  const result = await runSpawnedProcess({
    program: "docker",
    args: ["build", "-f", dockerfile, "-t", DEFAULT_SANDBOX_IMAGE, root],
    cwd: root,
    env: dockerClientEnv(),
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    maxLogBytes: 12_000,
  });
  clearSandboxAvailabilityCache(DEFAULT_SANDBOX_IMAGE);
  if (result.exitCode === 0 && !result.timedOut) {
    return {
      ok: true,
      image: DEFAULT_SANDBOX_IMAGE,
      dockerfile,
      message: `Built ${DEFAULT_SANDBOX_IMAGE}.`,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }
  return {
    ok: false,
    image: DEFAULT_SANDBOX_IMAGE,
    dockerfile,
    message: result.timedOut
      ? `Timed out while building ${DEFAULT_SANDBOX_IMAGE}.`
      : `Failed to build ${DEFAULT_SANDBOX_IMAGE}.`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
}

async function runWithSelectedBackend(input: ProcessRunInput): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  if (input.options.backend === "host") {
    if (!input.options.allowHostFallback) {
      return unavailableResult("Host sandbox backend requires explicit --allow-host-execution because model-generated commands would run on the local machine.");
    }
    return runHostSandboxProcess(input);
  }

  if (input.options.backend === "apple-container") {
    const appleReady = await checkAppleContainerBackendReady(input.options);
    if (!appleReady.ok) return unavailableResult(appleReady.message);
    return runAppleContainerSandboxProcess(input);
  }

  let appleFailure: string | undefined;
  if (input.options.backend === "auto" && autoPrefersAppleContainer()) {
    const appleReady = await checkAppleContainerBackendReady(input.options);
    if (appleReady.ok) return runAppleContainerSandboxProcess(input);
    appleFailure = appleReady.message;
  }

  const ociAvailable = await isOciSandboxAvailable(input.options.image);
  if (input.options.backend === "oci" || ociAvailable) {
    if (!ociAvailable) {
      return unavailableResult(`OCI sandbox image "${input.options.image}" is not available. Build or pull it first, or explicitly opt into host execution for trusted local targets.`);
    }
    return runOciSandboxProcess(input);
  }

  if (input.options.allowHostFallback) return runHostSandboxProcess(input);
  return unavailableResult(noAutoSandboxMessage(input.options.image, appleFailure));
}

function unavailableResult(message: string): { stdout: string; stderr: string; exitCode: number; timedOut: boolean } {
  return { stdout: "", stderr: message, exitCode: 126, timedOut: false };
}

async function runHostSandboxProcess(input: ProcessRunInput): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return runSpawnedProcess({
    program: input.command.program,
    args: input.command.args,
    cwd: input.cwdAbsolute,
    env: sandboxEnv(input.workspaceAbsolute, input.tmpDir, input.cacheDir),
    timeoutMs: input.command.timeoutMs ?? 120_000,
    maxLogBytes: input.maxLogBytes,
  });
}

async function runOciSandboxProcess(input: ProcessRunInput): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const containerName = `flounder-${process.pid}-${randomBytes(4).toString("hex")}`;
  const cwdRelative = path.relative(input.workspaceAbsolute, input.cwdAbsolute).split(path.sep).filter(Boolean).join("/");
  const containerCwd = cwdRelative ? `/workspace/${cwdRelative}` : "/workspace";
  const dockerArgs = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    containerName,
    "--workdir",
    containerCwd,
    "--mount",
    `type=bind,src=${input.workspaceAbsolute},dst=/workspace`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--pids-limit",
    "512",
  ];
  if (input.options.network === "none") dockerArgs.push("--network", "none");
  if (input.cacheDir) dockerArgs.push("--mount", `type=bind,src=${input.cacheDir},dst=/cache`);
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  if (input.options.memoryMb !== undefined) dockerArgs.push("--memory", `${Math.max(64, Math.floor(input.options.memoryMb))}m`);
  if (input.options.cpus !== undefined) dockerArgs.push("--cpus", String(Math.max(0.1, input.options.cpus)));
  for (const [key, value] of Object.entries(sandboxEnv("/workspace", "/workspace/.tmp", input.cacheDir ? "/cache" : undefined))) {
    if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
  }
  dockerArgs.push(input.options.image, input.command.program, ...input.command.args);
  const result = await runSpawnedProcess({
    program: "docker",
    args: dockerArgs,
    cwd: input.workspaceAbsolute,
    env: dockerClientEnv(),
    timeoutMs: input.command.timeoutMs ?? 120_000,
    maxLogBytes: input.maxLogBytes,
  });
  if (result.timedOut) void forceRemoveContainer(containerName);
  return result;
}

async function runAppleContainerSandboxProcess(input: ProcessRunInput): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const networkReady = input.options.network === "none" ? await ensureAppleContainerSealedNetwork() : { ok: true as const };
  if (!networkReady.ok) return unavailableResult(networkReady.message);
  const containerName = `flounder-${process.pid}-${randomBytes(4).toString("hex")}`;
  const cwdRelative = path.relative(input.workspaceAbsolute, input.cwdAbsolute).split(path.sep).filter(Boolean).join("/");
  const containerCwd = cwdRelative ? `/workspace/${cwdRelative}` : "/workspace";
  const containerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--workdir",
    containerCwd,
    "--mount",
    `type=bind,source=${input.workspaceAbsolute},target=/workspace`,
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
  ];
  if (input.options.network === "none") containerArgs.push("--network", APPLE_CONTAINER_SEALED_NETWORK, "--no-dns");
  if (input.cacheDir) containerArgs.push("--mount", `type=bind,source=${input.cacheDir},target=/cache`);
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    containerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  if (input.options.memoryMb !== undefined) containerArgs.push("--memory", `${Math.max(64, Math.floor(input.options.memoryMb))}M`);
  if (input.options.cpus !== undefined) containerArgs.push("--cpus", String(Math.max(0.1, input.options.cpus)));
  for (const [key, value] of Object.entries(sandboxEnv("/workspace", "/workspace/.tmp", input.cacheDir ? "/cache" : undefined))) {
    if (value !== undefined) containerArgs.push("--env", `${key}=${value}`);
  }
  containerArgs.push(input.options.image, input.command.program, ...input.command.args);
  const result = await runSpawnedProcess({
    program: "container",
    args: containerArgs,
    cwd: input.workspaceAbsolute,
    env: containerClientEnv(),
    timeoutMs: input.command.timeoutMs ?? 120_000,
    maxLogBytes: input.maxLogBytes,
  });
  if (result.timedOut) void forceRemoveAppleContainer(containerName);
  return result;
}

async function runSpawnedProcess(input: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxLogBytes: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(input.program, input.args, {
    cwd: input.cwd,
    shell: false,
    env: input.env,
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (exitCode === null) child.kill("SIGKILL");
    }, 2_000);
  }, input.timeoutMs);

  child.stdout?.on("data", (chunk) => {
    stdout = appendLimited(stdout, String(chunk), input.maxLogBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendLimited(stderr, String(chunk), input.maxLogBytes);
  });

  await new Promise<void>((resolve) => {
    child.on("error", (error) => {
      stderr = appendLimited(stderr, error.message, input.maxLogBytes);
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  return { stdout, stderr, exitCode, timedOut };
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

export async function resolveWorkspacePathForRead(workspace: string, relativePath: string): Promise<string> {
  const target = resolveWorkspacePath(workspace, relativePath);
  return assertInsideRealWorkspace(workspace, target, relativePath);
}

export async function resolveWorkspacePathForWrite(workspace: string, relativePath: string): Promise<string> {
  const target = resolveWorkspacePath(workspace, relativePath);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  await assertInsideRealWorkspace(workspace, parent, relativePath);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Unsafe sandbox path: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

async function assertInsideRealWorkspace(workspace: string, target: string, original: string): Promise<string> {
  const rootReal = await realpath(workspace);
  const targetReal = await realpath(target);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Unsafe sandbox path escapes workspace through symlink: ${original}`);
  }
  return target;
}

export function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "finding";
}

/**
 * List every file currently in the workspace as workspace-relative POSIX paths.
 * Called right after the target source is copied (before corpus, warm-up, or any
 * model action) to capture the pristine baseline — the set of files the model is
 * not allowed to modify, so confirmation runs against untampered target source.
 */
export async function listWorkspaceFiles(workspaceAbsolute: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldSkipCopyName(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(absDir, entry.name), rel);
      else out.add(rel);
    }
  };
  await walk(workspaceAbsolute, "");
  return out;
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
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    await copyDirectoryContents(sourcePath, targetPath);
    return;
  }
  if (!info.isFile()) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
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

const ociAvailability = new Map<string, Promise<boolean>>();
const appleContainerAvailability = new Map<string, Promise<boolean>>();

function isOciSandboxAvailable(image: string): Promise<boolean> {
  let cached = ociAvailability.get(image);
  if (!cached) {
    cached = checkOciSandboxAvailable(image);
    ociAvailability.set(image, cached);
  }
  return cached;
}

async function checkOciSandboxAvailable(image: string): Promise<boolean> {
  const result = await runSpawnedProcess({
    program: "docker",
    args: ["image", "inspect", image],
    cwd: process.cwd(),
    env: dockerClientEnv(),
    timeoutMs: 5000,
    maxLogBytes: 2000,
  });
  return result.exitCode === 0 && !result.timedOut;
}

function isAppleContainerSandboxAvailable(image: string): Promise<boolean> {
  let cached = appleContainerAvailability.get(image);
  if (!cached) {
    cached = checkAppleContainerSandboxAvailable(image);
    appleContainerAvailability.set(image, cached);
  }
  return cached;
}

async function checkAppleContainerSandboxAvailable(image: string): Promise<boolean> {
  const result = await runSpawnedProcess({
    program: "container",
    args: ["image", "inspect", image],
    cwd: process.cwd(),
    env: containerClientEnv(),
    timeoutMs: 5000,
    maxLogBytes: 2000,
  });
  return result.exitCode === 0 && !result.timedOut;
}

async function checkAppleContainerBackendReady(options: SandboxProcessOptions): Promise<{ ok: true } | { ok: false; message: string }> {
  const available = await isAppleContainerSandboxAvailable(options.image);
  if (!available) {
    return {
      ok: false,
      message: `Apple container sandbox image "${options.image}" is not available. Install apple/container, run "container system start", and build or pull the image for the Apple container runtime.`,
    };
  }
  if (options.network === "none") return ensureAppleContainerSealedNetwork();
  return { ok: true };
}

async function ensureAppleContainerSealedNetwork(): Promise<{ ok: true } | { ok: false; message: string }> {
  const inspect = await runSpawnedProcess({
    program: "container",
    args: ["network", "inspect", APPLE_CONTAINER_SEALED_NETWORK],
    cwd: process.cwd(),
    env: containerClientEnv(),
    timeoutMs: 10_000,
    maxLogBytes: 2000,
  });
  if (inspect.exitCode === 0 && !inspect.timedOut) return { ok: true };
  const created = await runSpawnedProcess({
    program: "container",
    args: ["network", "create", "--internal", APPLE_CONTAINER_SEALED_NETWORK],
    cwd: process.cwd(),
    env: containerClientEnv(),
    timeoutMs: 30_000,
    maxLogBytes: 4000,
  });
  if (created.exitCode === 0 && !created.timedOut) return { ok: true };
  return {
    ok: false,
    message: `Apple container backend could not create the internal sealed network "${APPLE_CONTAINER_SEALED_NETWORK}". Sealed audit commands require an internal host-only, no-DNS network on this backend; start apple/container and ensure "container network create --internal" is available.`,
  };
}

function noAutoSandboxMessage(image: string, appleFailure?: string): string {
  const appleHint = appleFailure ? ` Apple container auto-selection was skipped: ${appleFailure}` : "";
  return `No sandbox backend is available for image "${image}", and host execution fallback is disabled.${appleHint} Install/start Apple container on Apple silicon macOS or install Docker and build/pull the image, or pass --allow-host-execution only for trusted local targets.`;
}

async function defaultSandboxDockerfilePath(): Promise<string | undefined> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../docker/flounder-sandbox.Dockerfile"),
    path.resolve(process.cwd(), "docker/flounder-sandbox.Dockerfile"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try the next installation layout
    }
  }
  return undefined;
}

async function forceRemoveContainer(name: string): Promise<void> {
  await runSpawnedProcess({
    program: "docker",
    args: ["rm", "-f", name],
    cwd: process.cwd(),
    env: dockerClientEnv(),
    timeoutMs: 10_000,
    maxLogBytes: 2000,
  });
}

async function forceRemoveAppleContainer(name: string): Promise<void> {
  await runSpawnedProcess({
    program: "container",
    args: ["delete", "--force", name],
    cwd: process.cwd(),
    env: containerClientEnv(),
    timeoutMs: 10_000,
    maxLogBytes: 2000,
  });
}

function dockerClientEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function containerClientEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME"]) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}

function sandboxEnv(workspace: string, tmpDir: string, cacheDir?: string): NodeJS.ProcessEnv {
  // HOME is always the per-run workspace (host config/credentials stay hidden).
  // Package caches go to a persistent cacheDir when one is supplied, else the
  // per-run tmpDir (which is discarded with the run).
  const pkgCache = cacheDir ?? tmpDir;
  const out: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: workspace,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    XDG_CACHE_HOME: path.join(pkgCache, "xdg-cache"),
    CARGO_HOME: path.join(pkgCache, "cargo-home"),
    GOCACHE: path.join(pkgCache, "go-build-cache"),
    GOMODCACHE: path.join(pkgCache, "go-mod-cache"),
    NPM_CONFIG_CACHE: path.join(pkgCache, "npm-cache"),
  };
  out.PATH = sandboxToolPath(process.env.PATH);
  if (process.env.LANG !== undefined) out.LANG = process.env.LANG;
  if (process.env.LC_ALL !== undefined) out.LC_ALL = process.env.LC_ALL;
  return out;
}

export function sandboxToolPath(basePath: string | undefined = process.env.PATH): string {
  const parts = (basePath ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
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
