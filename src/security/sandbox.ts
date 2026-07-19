import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
const APPLE_CONTAINER_NETWORK_DNS = ["1.1.1.1", "8.8.8.8"] as const;
const CACHE_TEMP_PREFIX = ".flounder-cache-";

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
  const onlySource = sourcePaths[0] ?? "";
  if (sourcePaths.length === 1 && (await isDirectory(onlySource))) {
    // lstat("link/") follows the final symlink on Node/macOS. Resolve only the
    // spelling (not the symlink) so a trailing separator cannot bypass the guard.
    const normalizedSource = path.resolve(onlySource);
    const sourceInfo = await lstat(normalizedSource);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error("Sandbox source root must not be a symbolic link.");
    }
    await copyDirectoryContents(normalizedSource, absolute);
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
  const options = normalizeSandboxExecutionOptions(executionOptions);
  const executionCommand = hardenNetworkEnabledCommand(command, options.network);
  await mkdir(tmpDir, { recursive: true });
  // A persistent, host-isolated package cache (CARGO_HOME etc.) when provided, so
  // dependency builds are downloaded once and reused across runs. HOME stays the
  // per-run workspace either way, so host credentials/config are never exposed.
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  await restoreSandboxToolCaches(workspaceAbsolute, cacheDir);
  const raw = await runWithSelectedBackend({
    command: executionCommand,
    workspaceAbsolute,
    cwdAbsolute: cwd,
    tmpDir,
    ...(cacheDir ? { cacheDir } : {}),
    maxLogBytes,
    options,
  });
  await persistSandboxToolCaches(workspaceAbsolute, cacheDir);

  const redactionScope = [workspaceAbsolute, tmpDir, ...redactPaths, ...machineRedactionPaths()];
  return {
    command: executionCommand,
    exitCode: raw.exitCode,
    expectedExitCode: executionCommand.expectedExitCode ?? 0,
    timedOut: raw.timedOut,
    durationMs: Date.now() - started,
    stdout: redactMachineStrings(redactLocalPaths(raw.stdout, redactionScope)),
    stderr: redactMachineStrings(redactLocalPaths(raw.stderr, redactionScope)),
  };
}

/**
 * Network-enabled fetch tools run with framework-owned clean-config and protocol
 * arguments. The model cannot remove these because they are attached after policy
 * classification, immediately before the sandbox process is spawned.
 */
export function hardenNetworkEnabledCommand(command: ReproductionCommand, network: SandboxNetworkMode): ReproductionCommand {
  if (network !== "enabled") return command;
  const program = command.program.trim().toLowerCase();
  if (program === "curl") {
    return {
      ...command,
      args: ["--disable", "--proto", "=http,https", "--proto-redir", "=http,https", ...command.args],
    };
  }
  if (program === "wget") {
    return { ...command, args: ["--no-config", ...command.args] };
  }
  if (program === "git") {
    return {
      ...command,
      args: [
        "-c", "core.hooksPath=/dev/null",
        "-c", "init.templateDir=",
        "-c", "credential.helper=",
        ...command.args,
      ],
    };
  }
  return command;
}

async function restoreSandboxToolCaches(workspaceAbsolute: string, cacheDir?: string): Promise<void> {
  const workspaceSvm = path.join(workspaceAbsolute, ".svm");
  // Foundry can leave the final solc path behind when a compiler download is
  // interrupted. A workspace is private to one run, so remove only artifacts
  // that are provably truncated before the next command can execute them.
  await removeTruncatedFoundryCompilers(workspaceSvm);
  if (!cacheDir) return;
  await mergeDirectoryContents(path.join(cacheDir, "foundry-svm"), workspaceSvm, {
    acceptFile: isCompleteFoundryCacheFile,
  });
}

async function persistSandboxToolCaches(workspaceAbsolute: string, cacheDir?: string): Promise<void> {
  if (!cacheDir) return;
  await mergeDirectoryContents(path.join(workspaceAbsolute, ".svm"), path.join(cacheDir, "foundry-svm"), {
    acceptFile: isCompleteFoundryCacheFile,
    atomicFiles: true,
  });
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

  const oci = await isOciSandboxAvailable(options.image);
  if (oci.available) return { ok: true, backend: "oci", image: options.image, allowHostFallback: options.allowHostFallback };
  if (options.backend === "oci") {
    return {
      ok: false,
      backend: "oci",
      image: options.image,
      allowHostFallback: options.allowHostFallback,
      message: oci.message ?? missingOciImageMessage(options.image),
    };
  }
  if (options.allowHostFallback) return { ok: true, backend: "host", image: options.image, allowHostFallback: true };
  return {
    ok: false,
    backend: "auto",
    image: options.image,
    allowHostFallback: false,
    message: noAutoSandboxMessage(options.image, appleFailure, oci.message),
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

  const oci = await isOciSandboxAvailable(input.options.image);
  if (input.options.backend === "oci" || oci.available) {
    if (!oci.available) {
      return unavailableResult(oci.message ?? missingOciImageMessage(input.options.image));
    }
    return runOciSandboxProcess(input);
  }

  if (input.options.allowHostFallback) return runHostSandboxProcess(input);
  return unavailableResult(noAutoSandboxMessage(input.options.image, appleFailure, oci.message));
}

function unavailableResult(message: string): { stdout: string; stderr: string; exitCode: number; timedOut: boolean } {
  return { stdout: "", stderr: message, exitCode: 126, timedOut: false };
}

async function runHostSandboxProcess(input: ProcessRunInput): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return runSpawnedProcess({
    program: input.command.program,
    args: input.command.args,
    cwd: input.cwdAbsolute,
    env: sandboxEnv(input.workspaceAbsolute, input.tmpDir, input.cacheDir, input.command, input.options.network),
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
  for (const [key, value] of Object.entries(sandboxEnv("/workspace", "/workspace/.tmp", input.cacheDir ? "/cache" : undefined, input.command, input.options.network))) {
    if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
  }
  dockerArgs.push(input.options.image, input.command.program, ...input.command.args);
  let cleanupStarted = false;
  const cleanupTimedOutContainer = (): void => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void forceRemoveContainer(containerName);
  };
  const result = await runSpawnedProcess({
    program: "docker",
    args: dockerArgs,
    cwd: input.workspaceAbsolute,
    env: dockerClientEnv(),
    timeoutMs: input.command.timeoutMs ?? 120_000,
    maxLogBytes: input.maxLogBytes,
    onTimeout: cleanupTimedOutContainer,
    timeoutKillDelayMs: 250,
  });
  if (result.timedOut) cleanupTimedOutContainer();
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
  if (input.options.network === "none") {
    containerArgs.push("--network", APPLE_CONTAINER_SEALED_NETWORK, "--no-dns");
  } else {
    for (const server of APPLE_CONTAINER_NETWORK_DNS) containerArgs.push("--dns", server);
  }
  if (input.cacheDir) containerArgs.push("--mount", `type=bind,source=${input.cacheDir},target=/cache`);
  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    containerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
  }
  if (input.options.memoryMb !== undefined) containerArgs.push("--memory", `${Math.max(64, Math.floor(input.options.memoryMb))}M`);
  if (input.options.cpus !== undefined) containerArgs.push("--cpus", String(Math.max(0.1, input.options.cpus)));
  for (const [key, value] of Object.entries(sandboxEnv("/workspace", "/workspace/.tmp", input.cacheDir ? "/cache" : undefined, input.command, input.options.network))) {
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
  if (result.timedOut) {
    // The Apple CLI may still be unwinding its `container run` XPC session when
    // the timeout fires. Deleting concurrently races that session and can leave
    // the per-container VM running indefinitely, so wait for the client process
    // to exit before retrying and observing cleanup.
    const cleanup = await forceRemoveAppleContainer(containerName);
    if (!cleanup.ok) {
      result.stderr = appendLimited(
        result.stderr,
        `Apple container cleanup failed after command timeout: ${cleanup.message}`,
        input.maxLogBytes,
      );
    }
  }
  return result;
}

async function runSpawnedProcess(input: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxLogBytes: number; onTimeout?: () => void; timeoutKillDelayMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exitCode: number | null = null;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(input.program, input.args, {
    cwd: input.cwd,
    shell: false,
    env: input.env,
  });
  const terminateChild = (): void => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (exitCode === null) child.kill("SIGKILL");
    }, 2_000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      input.onTimeout?.();
    } catch (error) {
      stderr = appendLimited(stderr, error instanceof Error ? error.message : String(error), input.maxLogBytes);
    }
    const delay = Math.max(0, input.timeoutKillDelayMs ?? 0);
    if (delay > 0) terminateTimer = setTimeout(terminateChild, delay);
    else terminateChild();
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
  if (terminateTimer) clearTimeout(terminateTimer);
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

interface DirectoryMergeOptions {
  acceptFile?: (copiedPath: string, logicalSourcePath?: string) => Promise<boolean>;
  atomicFiles?: boolean;
}

async function mergeDirectoryContents(sourceDir: string, targetDir: string, options: DirectoryMergeOptions = {}): Promise<void> {
  if (!(await isDirectory(sourceDir))) return;
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipCopyName(entry.name) || entry.name.startsWith(CACHE_TEMP_PREFIX)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath, options);
      continue;
    }
    if (!info.isFile()) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    // Validate the private copy that will actually be published. Validating the
    // source path first leaves a TOCTOU window where a detached build process can
    // replace or truncate it between validation and copy.
    if (options.atomicFiles || options.acceptFile) await copyFileAtomically(sourcePath, targetPath, options.acceptFile);
    else await copyFile(sourcePath, targetPath);
  }
}

async function copyFileAtomically(
  sourcePath: string,
  targetPath: string,
  acceptFile?: (copiedPath: string, logicalSourcePath?: string) => Promise<boolean>,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(targetPath),
    `${CACHE_TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await copyFile(sourcePath, tempPath);
    if (acceptFile && !(await acceptFile(tempPath, sourcePath))) return;
    await rename(tempPath, targetPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function removeTruncatedFoundryCompilers(root: string): Promise<void> {
  if (!(await isDirectory(root))) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(CACHE_TEMP_PREFIX)) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await removeTruncatedFoundryCompilers(entryPath);
      continue;
    }
    if (entry.isFile() && isFoundryCompilerName(entry.name) && await isDefinitelyInvalidFoundryCompiler(entryPath)) {
      await rm(entryPath, { force: true });
    }
  }
}

async function isCompleteFoundryCacheFile(copiedPath: string, logicalSourcePath = copiedPath): Promise<boolean> {
  return !isFoundryCompilerName(path.basename(logicalSourcePath)) || !(await isDefinitelyInvalidFoundryCompiler(copiedPath));
}

function isFoundryCompilerName(name: string): boolean {
  return name.startsWith("solc-");
}

/**
 * Reject incomplete or unknown native compiler cache entries. Foundry installs
 * native solc executables, so the supported cache formats are ELF, Mach-O, and
 * PE; accepting arbitrary bytes would let an interrupted pre-header download
 * become durable poison.
 */
async function isDefinitelyInvalidFoundryCompiler(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const fileInfo = await handle.stat();
    // No supported native compiler executable can be shorter than its four-byte
    // magic. Treat an interruption before the ELF identifier is fully flushed as
    // conclusively incomplete even though its eventual platform is not yet known.
    if (fileInfo.size < 4) return true;
    const fileSize = BigInt(fileInfo.size);
    const header = Buffer.alloc(64);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead < 4) return true;
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      // Keep the handle open until the format-specific parser finishes its
      // positioned reads. Returning the bare promise would enter `finally`
      // immediately and close it underneath Mach-O/PE validation.
      return await isDefinitelyInvalidNonElfCompiler(handle, header, headerRead.bytesRead, fileSize);
    }
    // Once the ELF magic is present, a partial e_ident is conclusively an
    // interrupted ELF file rather than an unknown executable format.
    if (headerRead.bytesRead < 16) return true;

    const elfClass = header[4];
    const dataEncoding = header[5];
    if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) return true;
    const is64Bit = elfClass === 2;
    const littleEndian = dataEncoding === 1;
    const headerSize = is64Bit ? 64 : 52;
    if (headerRead.bytesRead < headerSize) return true;

    const programOffset = readElfInteger(header, is64Bit ? 32 : 28, is64Bit ? 8 : 4, littleEndian);
    const sectionOffset = readElfInteger(header, is64Bit ? 40 : 32, is64Bit ? 8 : 4, littleEndian);
    const programEntrySize = Number(readElfInteger(header, is64Bit ? 54 : 42, 2, littleEndian));
    const programCount = Number(readElfInteger(header, is64Bit ? 56 : 44, 2, littleEndian));
    const sectionEntrySize = Number(readElfInteger(header, is64Bit ? 58 : 46, 2, littleEndian));
    const sectionCount = Number(readElfInteger(header, is64Bit ? 60 : 48, 2, littleEndian));

    // Extended ELF counts require section-zero interpretation. Reject those
    // entries here rather than treating an unvalidated table layout as a
    // complete compiler cache object.
    if (programCount === 0xffff || (sectionCount === 0 && sectionOffset !== 0n)) return true;
    if (tableExtendsPastEnd(programOffset, programEntrySize, programCount, fileSize)) return true;
    if (tableExtendsPastEnd(sectionOffset, sectionEntrySize, sectionCount, fileSize)) return true;

    if (programCount > 0 && programCount <= 4096) {
      const minimumEntrySize = is64Bit ? 56 : 32;
      if (programEntrySize < minimumEntrySize) return true;
      for (let index = 0; index < programCount; index += 1) {
        const entryOffset = programOffset + BigInt(index * programEntrySize);
        const entry = await readFileSlice(handle, entryOffset, minimumEntrySize);
        if (!entry) return true;
        const segmentOffset = readElfInteger(entry, is64Bit ? 8 : 4, is64Bit ? 8 : 4, littleEndian);
        const segmentSize = readElfInteger(entry, is64Bit ? 32 : 16, is64Bit ? 8 : 4, littleEndian);
        if (segmentSize > 0n && segmentOffset + segmentSize > fileSize) return true;
      }
    }

    if (sectionCount > 0 && sectionCount <= 8192) {
      const minimumEntrySize = is64Bit ? 64 : 40;
      if (sectionEntrySize < minimumEntrySize) return true;
      for (let index = 0; index < sectionCount; index += 1) {
        const entryOffset = sectionOffset + BigInt(index * sectionEntrySize);
        const entry = await readFileSlice(handle, entryOffset, minimumEntrySize);
        if (!entry) return true;
        const sectionType = Number(readElfInteger(entry, 4, 4, littleEndian));
        if (sectionType === 8) continue; // SHT_NOBITS has no file-backed bytes.
        const contentsOffset = readElfInteger(entry, is64Bit ? 24 : 16, is64Bit ? 8 : 4, littleEndian);
        const contentsSize = readElfInteger(entry, is64Bit ? 32 : 20, is64Bit ? 8 : 4, littleEndian);
        if (contentsSize > 0n && contentsOffset + contentsSize > fileSize) return true;
      }
    }

    return false;
  } finally {
    await handle.close();
  }
}

async function isDefinitelyInvalidNonElfCompiler(
  handle: Awaited<ReturnType<typeof open>>,
  header: Buffer,
  headerBytes: number,
  fileSize: bigint,
): Promise<boolean> {
  const magic = header.readUInt32BE(0);
  if (magic === 0xfeedface) return isTruncatedMachO(handle, header, headerBytes, fileSize, false, false);
  if (magic === 0xcefaedfe) return isTruncatedMachO(handle, header, headerBytes, fileSize, true, false);
  if (magic === 0xfeedfacf) return isTruncatedMachO(handle, header, headerBytes, fileSize, false, true);
  if (magic === 0xcffaedfe) return isTruncatedMachO(handle, header, headerBytes, fileSize, true, true);
  if (magic === 0xcafebabe) return isTruncatedFatMachO(handle, header, headerBytes, fileSize, false, false);
  if (magic === 0xbebafeca) return isTruncatedFatMachO(handle, header, headerBytes, fileSize, true, false);
  if (magic === 0xcafebabf) return isTruncatedFatMachO(handle, header, headerBytes, fileSize, false, true);
  if (magic === 0xbfbafeca) return isTruncatedFatMachO(handle, header, headerBytes, fileSize, true, true);
  if (header[0] === 0x4d && header[1] === 0x5a) return isTruncatedPe(handle, header, headerBytes, fileSize);
  return true;
}

async function isTruncatedMachO(
  handle: Awaited<ReturnType<typeof open>>,
  header: Buffer,
  headerBytes: number,
  fileSize: bigint,
  littleEndian: boolean,
  is64Bit: boolean,
): Promise<boolean> {
  const headerSize = is64Bit ? 32 : 28;
  if (headerBytes < headerSize) return true;
  const read32 = (buffer: Buffer, offset: number): number => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const ncmds = read32(header, 16);
  const sizeofcmds = read32(header, 20);
  if (ncmds === 0 || sizeofcmds === 0 || ncmds > 16_384) return true;
  const commandsEnd = BigInt(headerSize) + BigInt(sizeofcmds);
  if (commandsEnd > fileSize) return true;
  let commandOffset = BigInt(headerSize);
  for (let index = 0; index < ncmds; index += 1) {
    const commandHeader = await readFileSlice(handle, commandOffset, 8);
    if (!commandHeader) return true;
    const command = read32(commandHeader, 0) & 0x7fffffff;
    const commandSize = read32(commandHeader, 4);
    if (commandSize < 8 || commandOffset + BigInt(commandSize) > commandsEnd) return true;
    if (command === 0x19 || command === 0x1) {
      const segmentSize = command === 0x19 ? 72 : 56;
      if (commandSize < segmentSize) return true;
      const segment = await readFileSlice(handle, commandOffset, segmentSize);
      if (!segment) return true;
      const fileOffset = command === 0x19
        ? readNativeInteger(segment, 40, 8, littleEndian)
        : readNativeInteger(segment, 32, 4, littleEndian);
      const backedSize = command === 0x19
        ? readNativeInteger(segment, 48, 8, littleEndian)
        : readNativeInteger(segment, 36, 4, littleEndian);
      if (backedSize > 0n && fileOffset + backedSize > fileSize) return true;
    }
    commandOffset += BigInt(commandSize);
  }
  return commandOffset !== commandsEnd;
}

async function isTruncatedFatMachO(
  handle: Awaited<ReturnType<typeof open>>,
  header: Buffer,
  headerBytes: number,
  fileSize: bigint,
  littleEndian: boolean,
  is64Bit: boolean,
): Promise<boolean> {
  if (headerBytes < 8) return true;
  const count = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
  if (count === 0 || count > 256) return true;
  const entrySize = is64Bit ? 32 : 20;
  if (8n + BigInt(entrySize * count) > fileSize) return true;
  for (let index = 0; index < count; index += 1) {
    const entry = await readFileSlice(handle, 8n + BigInt(index * entrySize), entrySize);
    if (!entry) return true;
    const offset = readNativeInteger(entry, 8, is64Bit ? 8 : 4, littleEndian);
    const size = readNativeInteger(entry, is64Bit ? 16 : 12, is64Bit ? 8 : 4, littleEndian);
    if (size === 0n || offset + size > fileSize) return true;
  }
  return false;
}

async function isTruncatedPe(
  handle: Awaited<ReturnType<typeof open>>,
  header: Buffer,
  headerBytes: number,
  fileSize: bigint,
): Promise<boolean> {
  if (headerBytes < 64) return true;
  const peOffset = header.readUInt32LE(60);
  if (BigInt(peOffset) + 24n > fileSize) return true;
  const coff = await readFileSlice(handle, BigInt(peOffset), 24);
  if (!coff || coff[0] !== 0x50 || coff[1] !== 0x45 || coff[2] !== 0 || coff[3] !== 0) return true;
  const sectionCount = coff.readUInt16LE(6);
  const optionalHeaderSize = coff.readUInt16LE(20);
  if (sectionCount === 0 || sectionCount > 4096 || optionalHeaderSize < 2) return true;
  const optionalHeader = await readFileSlice(handle, BigInt(peOffset + 24), optionalHeaderSize);
  if (!optionalHeader) return true;
  const optionalMagic = optionalHeader.readUInt16LE(0);
  if (optionalMagic !== 0x10b && optionalMagic !== 0x20b) return true;
  const sectionTable = BigInt(peOffset + 24 + optionalHeaderSize);
  if (sectionTable + BigInt(sectionCount * 40) > fileSize) return true;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = await readFileSlice(handle, sectionTable + BigInt(index * 40), 40);
    if (!section) return true;
    const rawSize = BigInt(section.readUInt32LE(16));
    const rawOffset = BigInt(section.readUInt32LE(20));
    if (rawSize > 0n && rawOffset + rawSize > fileSize) return true;
  }
  return false;
}

function tableExtendsPastEnd(offset: bigint, entrySize: number, count: number, fileSize: bigint): boolean {
  if (count === 0) return false;
  if (entrySize === 0) return false;
  return offset + BigInt(entrySize) * BigInt(count) > fileSize;
}

async function readFileSlice(
  handle: Awaited<ReturnType<typeof open>>,
  offset: bigint,
  size: number,
): Promise<Buffer | undefined> {
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const entry = Buffer.alloc(size);
  const result = await handle.read(entry, 0, size, Number(offset));
  return result.bytesRead === size ? entry : undefined;
}

function readNativeInteger(buffer: Buffer, offset: number, byteLength: 4 | 8, littleEndian: boolean): bigint {
  if (byteLength === 4) return BigInt(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

function readElfInteger(buffer: Buffer, offset: number, byteLength: 2 | 4 | 8, littleEndian: boolean): bigint {
  if (byteLength === 2) return BigInt(littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  if (byteLength === 4) return BigInt(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

async function copySourcePath(sourcePath: string, targetPath: string): Promise<void> {
  if (shouldSkipCopyName(path.basename(sourcePath))) return;
  const normalizedSource = path.resolve(sourcePath);
  const info = await lstat(normalizedSource);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    await copyDirectoryContents(normalizedSource, targetPath);
    return;
  }
  if (!info.isFile()) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(normalizedSource, targetPath);
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
  const marker = "\n[truncated; preserving head and tail]\n";
  if (maxBytes <= marker.length + 16) return combined.slice(0, Math.max(0, maxBytes));
  const budget = maxBytes - marker.length;
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${combined.slice(0, head)}${marker}${combined.slice(-tail)}`;
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

const ociAvailability = new Map<string, Promise<OciAvailability>>();
const appleContainerAvailability = new Map<string, Promise<AppleContainerAvailability>>();

interface OciAvailability {
  available: boolean;
  message?: string;
}

interface AppleContainerAvailability {
  available: boolean;
  message?: string;
}

function isOciSandboxAvailable(image: string): Promise<OciAvailability> {
  let cached = ociAvailability.get(image);
  if (!cached) {
    cached = checkOciSandboxAvailable(image);
    ociAvailability.set(image, cached);
  }
  return cached;
}

async function checkOciSandboxAvailable(image: string): Promise<OciAvailability> {
  const result = await runSpawnedProcess({
    program: "docker",
    args: ["image", "inspect", image],
    cwd: process.cwd(),
    env: dockerClientEnv(),
    timeoutMs: 5000,
    maxLogBytes: 2000,
  });
  if (result.exitCode === 0 && !result.timedOut) return { available: true };
  if (result.timedOut) {
    return {
      available: false,
      message: `Docker did not respond while inspecting OCI sandbox image "${image}". Verify the Docker daemon is running and reachable.`,
    };
  }
  const output = sandboxRuntimeDiagnostic(`${result.stderr}\n${result.stdout}`);
  if (/spawn docker ENOENT|not found|No such file or directory/i.test(output)) {
    return {
      available: false,
      message: `Docker CLI was not found on PATH while inspecting OCI sandbox image "${image}". Install Docker or configure the daemon process PATH.`,
    };
  }
  if (/permission denied|operation not permitted/i.test(output)) {
    return {
      available: false,
      message: `Flounder is not permitted to access the Docker API while inspecting OCI sandbox image "${image}". Verify Docker socket permissions for the daemon process.${output ? ` Docker reported: ${output}` : ""}`,
    };
  }
  if (/cannot connect|connection refused|is the docker daemon running|docker daemon.*not running|error during connect/i.test(output)) {
    return {
      available: false,
      message: `Docker is not reachable while inspecting OCI sandbox image "${image}". Start Docker and verify the daemon process can access its socket.${output ? ` Docker reported: ${output}` : ""}`,
    };
  }
  if (/no such image|image.*not found|unable to find image/i.test(output)) {
    return { available: false, message: missingOciImageMessage(image) };
  }
  return {
    available: false,
    message: `Docker could not inspect OCI sandbox image "${image}".${output ? ` Docker reported: ${output}` : ""}`,
  };
}

function isAppleContainerSandboxAvailable(image: string): Promise<AppleContainerAvailability> {
  let cached = appleContainerAvailability.get(image);
  if (!cached) {
    cached = checkAppleContainerSandboxAvailable(image);
    appleContainerAvailability.set(image, cached);
  }
  return cached;
}

async function checkAppleContainerSandboxAvailable(image: string): Promise<AppleContainerAvailability> {
  const result = await runSpawnedProcess({
    program: "container",
    args: ["image", "inspect", image],
    cwd: process.cwd(),
    env: containerClientEnv(),
    timeoutMs: 5000,
    maxLogBytes: 2000,
  });
  if (result.exitCode === 0 && !result.timedOut) return { available: true };
  if (result.timedOut) {
    return {
      available: false,
      message: `Apple container did not respond while inspecting sandbox image "${image}". Check "container system status" and restart apple/container if needed.`,
    };
  }
  const output = `${result.stderr}\n${result.stdout}`.trim();
  if (/spawn container ENOENT|not found|No such file or directory/i.test(output)) {
    return {
      available: false,
      message: `Apple container CLI was not found on PATH. Install apple/container, run "container system start", and build or pull sandbox image "${image}" for the Apple container runtime.`,
    };
  }
  if (/Operation not permitted/i.test(output)) {
    return {
      available: false,
      message: `Apple container CLI is installed, but this process is not permitted to access the container system API. Run Flounder from an unsandboxed terminal/session, then verify "container image inspect ${image}" succeeds.`,
    };
  }
  if (/connection|connect|service|apiserver|not running|cannot.*container/i.test(output)) {
    return {
      available: false,
      message: `Apple container system is not reachable while inspecting sandbox image "${image}". Run "container system start" and verify "container system status" is running.`,
    };
  }
  return { available: false };
}

async function checkAppleContainerBackendReady(options: SandboxProcessOptions): Promise<{ ok: true } | { ok: false; message: string }> {
  const available = await isAppleContainerSandboxAvailable(options.image);
  if (!available.available) {
    return {
      ok: false,
      message: available.message ?? `Apple container sandbox image "${options.image}" is not available. Install apple/container, run "container system start", and build or pull the image for the Apple container runtime.`,
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

function missingOciImageMessage(image: string): string {
  return `OCI sandbox image "${image}" is not available. Build or pull it first, or explicitly opt into host execution for trusted local targets.`;
}

function noAutoSandboxMessage(image: string, appleFailure?: string, ociFailure?: string): string {
  const appleHint = appleFailure ? ` Apple container auto-selection was skipped: ${appleFailure}` : "";
  const ociHint = ociFailure ? ` Docker OCI selection was skipped: ${ociFailure}` : "";
  return `No sandbox backend is available for image "${image}", and host execution fallback is disabled.${appleHint}${ociHint} Install/start Apple container on Apple silicon macOS or install Docker and build/pull the image, or pass --allow-host-execution only for trusted local targets.`;
}

function sandboxRuntimeDiagnostic(input: string): string {
  return redactMachineStrings(redactLocalPaths(input.trim(), machineRedactionPaths())).replace(/\s+/g, " ").slice(0, 500);
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

async function forceRemoveAppleContainer(name: string): Promise<{ ok: boolean; message: string }> {
  const attempts = 3;
  let message = "container delete did not complete";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runSpawnedProcess({
      program: "container",
      args: ["delete", "--force", name],
      cwd: process.cwd(),
      env: containerClientEnv(),
      timeoutMs: 10_000,
      maxLogBytes: 2000,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.exitCode === 0 || appleContainerIsAlreadyAbsent(output)) return { ok: true, message: "removed" };
    message = output || `container delete exited with code ${String(result.exitCode)}`;
    if (attempt < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return { ok: false, message };
}

function appleContainerIsAlreadyAbsent(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes("container with id") && (normalized.includes("notfound") || normalized.includes("not found"));
}

function dockerClientEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  out.PATH = sandboxToolPath(process.env.PATH);
  return out;
}

function containerClientEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME"]) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  out.PATH = sandboxToolPath(process.env.PATH);
  return out;
}

function sandboxEnv(workspace: string, tmpDir: string, cacheDir?: string, command?: ReproductionCommand, network: SandboxNetworkMode = "none"): NodeJS.ProcessEnv {
  // HOME is always the per-run workspace (host config/credentials stay hidden).
  // Package caches go to a persistent cacheDir when one is supplied, else the
  // per-run tmpDir (which is discarded with the run).
  const pkgCache = cacheDir ?? tmpDir;
  const out: NodeJS.ProcessEnv = {
    CI: "1",
    // Foundry can otherwise inherit an ffi=true project setting and let a test
    // escape the command classifier by spawning a second arbitrary process.
    FOUNDRY_FFI: "false",
    HOME: workspace,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    XDG_CACHE_HOME: path.join(pkgCache, "xdg-cache"),
    CARGO_HOME: path.join(pkgCache, "cargo-home"),
    SCARB_CACHE: path.join(pkgCache, "scarb-cache"),
    GOCACHE: path.join(pkgCache, "go-build-cache"),
    GOMODCACHE: path.join(pkgCache, "go-mod-cache"),
    NPM_CONFIG_CACHE: path.join(pkgCache, "npm-cache"),
    YARN_GLOBAL_FOLDER: path.join(pkgCache, "yarn-berry"),
  };
  out.PATH = sandboxToolPath(process.env.PATH);
  if (network === "enabled") {
    const program = command?.program.trim().toLowerCase();
    if (program === "curl") out.CURL_HOME = "/dev/null";
    if (program === "wget") out.WGETRC = "/dev/null";
    if (program === "git") {
      out.GIT_CONFIG_NOSYSTEM = "1";
      out.GIT_CONFIG_SYSTEM = "/dev/null";
      out.GIT_CONFIG_GLOBAL = "/dev/null";
      out.GIT_ALLOW_PROTOCOL = "https";
      out.GIT_TERMINAL_PROMPT = "0";
    }
  }
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
