import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sandboxExecutionOptions, type AuditorConfig } from "../config.js";
import { runSandboxCommand, type SandboxWorkspace } from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import type { ReproductionCommand } from "../types.js";
import type { ResourceRequest } from "./discovery-artifacts.js";

// Verification-environment guarantee (not strategy). Confirmation only matters if
// the model's local test can actually compile and run. On a real target that
// means the toolchain's dependencies must be present. This module warms the
// copied workspace ONCE: it detects the toolchain and runs the project's own
// dependency-fetch/build with network allowed and a generous timeout, populating
// the workspace-local caches (CARGO_HOME, SCARB_CACHE, GOMODCACHE, npm cache, …) that
// runSandboxCommand already points inside the workspace. Afterwards the model's
// bash test runs are incremental and can run offline and reproducibly.
//
// These commands are framework-chosen and trusted (not model input), so they do
// not pass through the agent bash allowlist. They do execute the target's own
// dependency build scripts in the isolated workspace (HOME and caches already
// point inside it); that is inherent to preparing a real toolchain and is why the
// step is gated by AuditorConfig.auditPrepare.

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "target", "build", "dist", "coverage", "runs", "__pycache__", ".cache", ".next", ".nuxt", ".turbo"]);
const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 8000;

type Toolchain = "cargo" | "go" | "npm" | "pnpm" | "yarn" | "forge" | "scarb" | "blueprint";

export interface PrepareCommandResult {
  toolchain: Toolchain;
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ok: boolean;
  diagnostic?: string;
}

export interface PrepareReport {
  ran: boolean;
  detected: Toolchain[];
  pinnedToolVersions: PinnedToolVersion[];
  toolVersionChecks: ToolVersionCheck[];
  results: PrepareCommandResult[];
}

export interface PinnedToolVersion {
  tool: string;
  version: string;
  dir: string;
}

export interface ToolVersionCheck {
  tool: string;
  command: string;
  expected: string;
  actual?: string;
  ok: boolean;
  reason?: string;
}

export async function prepareWorkspaceToolchain(input: { workspace: SandboxWorkspace; cfg: AuditorConfig; logger: RunLogger; cacheDir?: string; focusCommand?: ReproductionCommand; focusPaths?: string[]; streamId?: string; signal?: AbortSignal }): Promise<PrepareReport> {
  const streamMeta = input.streamId ? { streamId: input.streamId } : {};
  const artifactName = input.streamId ? `audit_prepare-${slug(input.streamId)}.json` : "audit_prepare.json";
  const allPlans = await detectToolchains(input.workspace.absolute);
  const pathFocusedPlans = focusPlansByPaths(allPlans, input.focusPaths);
  const plans = focusPlans(pathFocusedPlans, input.focusCommand);
  const pinnedToolVersions = await detectPinnedToolVersions(input.workspace.absolute);
  const relevantPins = relevantPinnedToolVersions(pinnedToolVersions, plans);
  if (relevantPins.length > 0) {
    await input.logger.event("audit_prepare_tool_versions", { pins: relevantPins, ...streamMeta });
  }
  const toolVersionChecks = await checkPinnedToolVersions(input, relevantPins);
  if (toolVersionChecks.length > 0) {
    await input.logger.event("audit_prepare_tool_version_checks", { checks: toolVersionChecks, ...streamMeta });
  }
  const failedChecks = toolVersionChecks.filter((check) => !check.ok);
  if (failedChecks.length > 0) {
    await input.logger.event("audit_prepare_tool_version_mismatch", { checks: failedChecks, ...streamMeta });
    await input.logger.artifact(artifactName, { detected: plans.map((plan) => plan.toolchain), pinnedToolVersions: relevantPins, toolVersionChecks, results: [] });
    return { ran: false, detected: plans.map((plan) => plan.toolchain), pinnedToolVersions: relevantPins, toolVersionChecks, results: [] };
  }
  if (plans.length === 0) {
    await input.logger.event("audit_prepare_skipped", { reason: "no supported toolchain manifest detected", ...streamMeta });
    return { ran: false, detected: [], pinnedToolVersions: relevantPins, toolVersionChecks, results: [] };
  }

  await input.logger.event("audit_prepare_start", { toolchains: plans.map((plan) => plan.toolchain), timeoutMs: input.cfg.auditPrepareTimeoutMs, ...streamMeta });
  const results: PrepareCommandResult[] = [];
  for (const plan of plans) {
    for (const argv of plan.commands) {
      const command: ReproductionCommand = {
        program: argv[0] ?? "",
        args: argv.slice(1),
        timeoutMs: input.cfg.auditPrepareTimeoutMs,
        expectedExitCode: 0,
        ...(plan.cwd ? { cwd: plan.cwd } : {}),
      };
      const run = await runSandboxCommand(
        command,
        input.workspace.absolute,
        input.cfg.reproductionMaxLogBytes,
        input.cfg.sourcePaths,
        input.cacheDir,
        sandboxExecutionOptions(input.cfg, input.cfg.sandboxPrepareNetwork),
        input.signal,
      );
      const ok = run.exitCode === 0 && !run.timedOut;
      const record: PrepareCommandResult = {
        toolchain: plan.toolchain,
        command: argv.join(" "),
        cwd: plan.cwd ?? ".",
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        ok,
        ...(ok ? {} : { diagnostic: prepareDiagnostic(run.stderr, run.stdout) }),
      };
      results.push(record);
      await input.logger.event("audit_prepare_command", { toolchain: plan.toolchain, command: record.command, cwd: record.cwd, exitCode: run.exitCode, timedOut: run.timedOut, ok, ...streamMeta });
      // If dependency fetch fails or times out, later commands for the same
      // toolchain will too; stop this toolchain but keep warming the others.
      if (!ok) break;
    }
  }

  await input.logger.artifact(artifactName, { detected: plans.map((plan) => plan.toolchain), pinnedToolVersions: relevantPins, toolVersionChecks, results });
  return { ran: true, detected: plans.map((plan) => plan.toolchain), pinnedToolVersions: relevantPins, toolVersionChecks, results };
}

export function prepareToolVersionBlockingIssue(report: PrepareReport): string | undefined {
  const failed = report.toolVersionChecks.filter((check) => !check.ok);
  if (failed.length === 0) return undefined;
  const details = failed.map((check) => {
    const actual = check.actual ? `actual ${check.actual}` : (check.reason ?? "tool unavailable");
    return `${check.tool} expected ${check.expected}, ${actual}`;
  });
  return `sandbox image/toolchain preflight failed: ${details.join("; ")}. Build or select a target-specific sandbox image that matches the project's pinned toolchain.`;
}

export function prepareResourceRequests(report: PrepareReport, focusCommand?: ReproductionCommand): ResourceRequest[] {
  const requests: ResourceRequest[] = [];
  for (const check of report.toolVersionChecks.filter((item) => !item.ok)) {
    const actual = check.actual ? `actual ${check.actual}` : (check.reason ?? "tool unavailable");
    requests.push({
      id: `prepare-${slug(check.tool)}-version`,
      status: "open",
      kind: "sandbox-image",
      needed: `Sandbox image with ${check.tool} ${check.expected}`,
      reason: `${check.command} did not match the pinned tool version (${actual}).`,
      unblock: "Build or select a target-specific sandbox image that matches the target's pinned toolchain, then rerun verify/refute.",
      ...(focusCommand ? { retryCommand: renderCommand(focusCommand) } : {}),
      priority: "high",
    });
  }
  for (const result of report.results.filter((item) => !item.ok)) {
    const status = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "without an exit code"}`;
    const diagnostic = result.diagnostic ? ` Diagnostic: ${result.diagnostic}` : "";
    const kind: ResourceRequest["kind"] = /broken pipe|segmentation fault|illegal instruction|panic/i.test(result.diagnostic ?? "")
      ? "sandbox-image"
      : "toolchain";
    requests.push({
      id: `prepare-${slug(result.toolchain)}-${slug(result.cwd)}-${slug(result.command)}`,
      status: "open",
      kind,
      needed: `Working ${result.toolchain} prepare environment for ${result.cwd}`,
      reason: `Prepare command "${result.command}" in ${result.cwd} ${status}.${diagnostic}`,
      unblock: "Repair the sandbox image/toolchain or dependency setup, mark this request resolved, then rerun verify/refute for affected findings.",
      retryCommand: focusCommand ? renderCommand(focusCommand) : result.command,
      priority: "high",
    });
  }
  return dedupeRequests(requests);
}

async function checkPinnedToolVersions(
  input: {
    workspace: SandboxWorkspace;
    cfg: AuditorConfig;
    logger: RunLogger;
    cacheDir?: string;
    signal?: AbortSignal;
  },
  pins: PinnedToolVersion[],
): Promise<ToolVersionCheck[]> {
  const specs = pins.flatMap((pin) => versionCheckSpecs(pin));
  const out: ToolVersionCheck[] = [];
  for (const spec of specs) {
    const command: ReproductionCommand = {
      program: spec.argv[0] ?? "",
      args: spec.argv.slice(1),
      timeoutMs: Math.min(input.cfg.auditPrepareTimeoutMs, 30_000),
      expectedExitCode: 0,
      ...(spec.cwd && spec.cwd !== "." ? { cwd: spec.cwd } : {}),
    };
    const run = await runSandboxCommand(
      command,
      input.workspace.absolute,
      input.cfg.reproductionMaxLogBytes,
      input.cfg.sourcePaths,
      input.cacheDir,
      sandboxExecutionOptions(input.cfg, "none"),
      input.signal,
    );
    const combined = `${run.stdout}\n${run.stderr}`.trim();
    const actual = firstVersionLine(combined);
    out.push({
      tool: spec.tool,
      command: spec.argv.join(" "),
      expected: spec.expected,
      ...(actual ? { actual } : {}),
      ok: run.exitCode === 0 && !run.timedOut && versionOutputMatches(combined, spec.expected),
      ...(run.exitCode !== 0 || run.timedOut
        ? { reason: run.timedOut ? "version command timed out" : `version command exited ${run.exitCode}` }
        : (!actual ? { reason: "version command returned no parseable version" } : {})),
    });
  }
  return out;
}

interface VersionCheckSpec {
  tool: string;
  expected: string;
  argv: string[];
  cwd?: string;
}

function versionCheckSpecs(pin: PinnedToolVersion): VersionCheckSpec[] {
  if (pin.tool === "rust") {
    return [
      { tool: "rustc", expected: pin.version, argv: ["rustc", "--version"], cwd: pin.dir },
      { tool: "cargo", expected: pin.version, argv: ["cargo", "--version"], cwd: pin.dir },
    ];
  }
  if (pin.tool === "scarb") return [{ tool: "scarb", expected: pin.version, argv: ["scarb", "--version"], cwd: pin.dir }];
  if (pin.tool === "starknet-foundry") {
    return [
      { tool: "snforge", expected: pin.version, argv: ["snforge", "--version"], cwd: pin.dir },
      { tool: "sncast", expected: pin.version, argv: ["sncast", "--version"], cwd: pin.dir },
    ];
  }
  if (pin.tool === "universal-sierra-compiler") return [{ tool: "universal-sierra-compiler", expected: pin.version, argv: ["universal-sierra-compiler", "--version"], cwd: pin.dir }];
  return [];
}

function versionOutputMatches(output: string, expected: string): boolean {
  return new RegExp(`(^|[^0-9A-Za-z.])${escapeRegExp(expected)}([^0-9A-Za-z.]|$)`).test(output);
}

function firstVersionLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[[0-9]+\/[0-9]+\](?:\s+\[[^\]]+\])?/.test(line))
    .find((line) => /\b\d+\.\d+(?:\.\d+)?\b/.test(line));
}

function prepareDiagnostic(stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[[0-9]+\/[0-9]+\]/.test(line))
    .join(" ");
  return combined.slice(0, 500);
}

function renderCommand(command: ReproductionCommand): string {
  return [command.program, ...command.args].join(" ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
}

function dedupeRequests(requests: ResourceRequest[]): ResourceRequest[] {
  const seen = new Set<string>();
  const out: ResourceRequest[] = [];
  for (const request of requests) {
    const key = `${request.kind}::${request.needed}::${request.reason}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ToolchainPlan {
  toolchain: Toolchain;
  cwd?: string;
  commands: string[][];
}

function focusPlansByPaths(plans: ToolchainPlan[], focusPaths?: string[]): ToolchainPlan[] {
  const dirs = (focusPaths ?? [])
    .flatMap((value) => value.split(","))
    .map(focusDirectory)
    .filter((value): value is string => Boolean(value));
  if (dirs.length === 0) return plans;
  const focused = plans.filter((plan) => dirs.some((dir) => planCoversCommandCwd(plan.cwd, dir)));
  if (focused.length === 0) return plans;
  const focusDirs = focused.map((plan) => normalizePlanDir(plan.cwd ?? ""));
  const dependencyPlans = plans.filter((plan) =>
    ["npm", "pnpm", "yarn"].includes(plan.toolchain)
    && focusDirs.some((dir) => planCoversCommandCwd(plan.cwd, dir)),
  );
  return uniquePlans([...dependencyPlans, ...focused]);
}

function focusDirectory(value: string): string | undefined {
  const reference = value.trim().replace(/:\d+(?:-\d+)?(?:\s.*)?$/, "");
  if (!reference) return undefined;
  const normalized = normalizePlanDir(reference);
  return normalizePlanDir(path.posix.dirname(normalized));
}

function focusPlans(plans: ToolchainPlan[], command?: ReproductionCommand): ToolchainPlan[] {
  if (!command) return plans;
  const commandToolchain = commandToolchainName(command.program);
  const cwd = normalizePlanDir(command.cwd ?? "");
  let focused = commandToolchain
    ? plans.filter((plan) => plan.toolchain === commandToolchain && planCoversCommandCwd(plan.cwd, cwd))
    : plans.filter((plan) => cwd && sameOrNestedPlan(plan.cwd, cwd));
  if (focused.length === 0 && commandToolchain) {
    focused = plans.filter((plan) => plan.toolchain === commandToolchain);
  }
  if (focused.length === 0) return plans;
  const focusDirs = focused.map((plan) => normalizePlanDir(plan.cwd ?? ""));
  const dependencyPlans = plans.filter((plan) =>
    ["npm", "pnpm", "yarn"].includes(plan.toolchain)
    && focusDirs.some((dir) => planCoversCommandCwd(plan.cwd, dir)),
  );
  focused = [...dependencyPlans, ...focused];
  return uniquePlans(focused);
}

function commandToolchainName(program: string): Toolchain | undefined {
  const name = path.basename(program);
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "cargo" || name === "go" || name === "forge" || name === "scarb" || name === "blueprint") return name;
  return undefined;
}

function planCoversCommandCwd(planCwd: string | undefined, commandCwd: string): boolean {
  const planDir = normalizePlanDir(planCwd ?? "");
  const commandDir = normalizePlanDir(commandCwd);
  return planDir === commandDir || commandDir.startsWith(`${planDir}/`);
}

function relevantPinnedToolVersions(pins: PinnedToolVersion[], plans: ToolchainPlan[]): PinnedToolVersion[] {
  return pins.filter((pin) => plans.some((plan) => pinAppliesToPlan(pin, plan)));
}

function pinAppliesToPlan(pin: PinnedToolVersion, plan: ToolchainPlan): boolean {
  if (pin.tool === "rust") return plan.toolchain === "cargo" && sameOrNestedPlan(pin.dir, plan.cwd ?? "");
  if (pin.tool === "scarb" || pin.tool === "starknet-foundry" || pin.tool === "universal-sierra-compiler") {
    return plan.toolchain === "scarb" && sameOrNestedPlan(pin.dir, plan.cwd ?? "");
  }
  return sameOrNestedPlan(pin.dir, plan.cwd ?? "");
}

function sameOrNestedPlan(a: string | undefined, b: string | undefined): boolean {
  const left = normalizePlanDir(a ?? "");
  const right = normalizePlanDir(b ?? "");
  return left === right || left === "." || right === "." || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizePlanDir(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized || ".";
}

function uniquePlans(plans: ToolchainPlan[]): ToolchainPlan[] {
  const seen = new Set<string>();
  const out: ToolchainPlan[] = [];
  for (const plan of plans) {
    const key = `${plan.toolchain}:${plan.cwd ?? "."}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(plan);
  }
  return out;
}

async function detectToolchains(workspaceAbsolute: string): Promise<ToolchainPlan[]> {
  const manifests = await scanManifests(workspaceAbsolute);
  const plans: ToolchainPlan[] = [];
  const shallowest = (predicate: (name: string) => boolean): string | undefined => {
    const dirs = manifests.filter((entry) => predicate(entry.name)).map((entry) => entry.dir);
    if (dirs.length === 0) return undefined;
    return dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  };
  const hasIn = (dir: string, name: string): boolean => manifests.some((entry) =>
    normalizePlanDir(entry.dir) === normalizePlanDir(dir) && entry.name === name,
  );

  // Order matters: dependency-install toolchains (npm/pnpm/yarn) run FIRST, because
  // a Solidity/Foundry project often imports its dependencies (e.g. @openzeppelin)
  // from node_modules — so `forge build` only resolves after `npm install`. Then go
  // mod download, then the compile toolchains (cargo, Scarb/Cairo, Blueprint/TON,
  // forge).
  //
  // Choose the package manager from the lockfile CO-LOCATED with each outermost
  // package.json. A multi-project audit root can contain sibling buildable packages
  // that each need their own dependency closure before their Foundry build. Nested
  // package manifests remain covered by their nearest outer package, so a vendored
  // Foundry lib cannot redirect installation into its own subdirectory.
  for (const pkgDir of outermostManifestDirs(manifests, "package.json")) {
    if (hasIn(pkgDir, "pnpm-lock.yaml")) plans.push({ toolchain: "pnpm", ...cwd(pkgDir), commands: [["pnpm", "install", "--frozen-lockfile"]] });
    else if (hasIn(pkgDir, "yarn.lock")) plans.push({ toolchain: "yarn", ...cwd(pkgDir), commands: [["yarn", "install", "--frozen-lockfile"]] });
    else if (hasIn(pkgDir, "package-lock.json")) plans.push({ toolchain: "npm", ...cwd(pkgDir), commands: [["npm", "install", "--no-audit", "--no-fund"]] });
    else plans.push({ toolchain: "npm", ...cwd(pkgDir), commands: [["npm", "install", "--no-audit", "--no-fund"]] });
  }

  const goDir = shallowest((name) => name === "go.mod");
  if (goDir !== undefined) plans.push({ toolchain: "go", ...cwd(goDir), commands: [["go", "mod", "download"]] });

  // Warm with `cargo build` (not `--tests`): it compiles the heavy runtime
  // dependency tree (the bulk of build time, which `cargo test` then reuses)
  // without trying to compile the model's scratch test files under tests/ — those
  // may not compile yet, and a `--tests` warm-up would fail on them and warm nothing.
  const cargoDir = shallowest((name) => name === "Cargo.toml");
  if (cargoDir !== undefined) plans.push({ toolchain: "cargo", ...cwd(cargoDir), commands: [["cargo", "fetch"], ["cargo", "build"]] });

  const scarbDir = shallowest((name) => name === "Scarb.toml");
  if (scarbDir !== undefined) plans.push({ toolchain: "scarb", ...cwd(scarbDir), commands: [["scarb", "fetch"], ["scarb", "build"]] });

  const blueprintDir = shallowest((name) => isBlueprintManifest(name));
  if (blueprintDir !== undefined) plans.push({ toolchain: "blueprint", ...cwd(blueprintDir), commands: [["blueprint", "build", "--all"]] });

  // Independent Foundry packages commonly coexist under one audit build root.
  // Keep every outermost project root so a scope-focused prepare can select the
  // package it actually audits; nested vendored projects remain covered by their
  // nearest parent and are not warmed independently.
  for (const foundryDir of outermostManifestDirs(manifests, "foundry.toml")) {
    plans.push({ toolchain: "forge", ...cwd(foundryDir), commands: [["forge", "build"]] });
  }

  return plans;
}

function outermostManifestDirs(manifests: ManifestEntry[], name: string): string[] {
  const dirs = [...new Set(manifests.filter((entry) => entry.name === name).map((entry) => normalizePlanDir(entry.dir)))];
  return dirs
    .filter((dir) => !dirs.some((candidate) => candidate !== dir && planCoversCommandCwd(candidate, dir)))
    .sort((a, b) => a.localeCompare(b));
}

export async function detectPinnedToolVersions(workspaceAbsolute: string): Promise<PinnedToolVersion[]> {
  const manifests = await scanManifests(workspaceAbsolute);
  const out: PinnedToolVersion[] = [];
  for (const entry of manifests.filter((manifest) => manifest.name === "rust-toolchain" || manifest.name === "rust-toolchain.toml")) {
    const abs = path.join(workspaceAbsolute, ...entry.dir.split("/").filter(Boolean), entry.name);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const channel = entry.name === "rust-toolchain.toml"
      ? content.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1]
      : content.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()).find(Boolean);
    if (channel && /^\d+\.\d+\.\d+(?:[-+._a-zA-Z0-9]+)?$/.test(channel)) {
      out.push({ tool: "rust", version: channel, dir: entry.dir || "." });
    }
  }
  for (const entry of manifests.filter((manifest) => manifest.name === ".tool-versions")) {
    const abs = path.join(workspaceAbsolute, ...entry.dir.split("/").filter(Boolean), entry.name);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.replace(/#.*/, "").trim();
      if (!trimmed) continue;
      const [tool, version] = trimmed.split(/\s+/, 2);
      if (!tool || !version) continue;
      out.push({ tool, version, dir: entry.dir || "." });
    }
  }
  return out;
}

function cwd(dir: string): { cwd?: string } {
  return dir && dir !== "." ? { cwd: dir } : {};
}

interface ManifestEntry {
  name: string;
  dir: string; // workspace-relative posix dir, "" for root
}

async function scanManifests(root: string): Promise<ManifestEntry[]> {
  const wanted = new Set(["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "go.mod", "package.json", "foundry.toml", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Scarb.toml", "Scarb.lock", "snfoundry.toml", ".tool-versions", "blueprint.config.ts", "blueprint.config.js", "blueprint.config.cjs", "blueprint.config.mjs", "tact.config.json"]);
  const out: ManifestEntry[] = [];
  let budget = MAX_SCAN_ENTRIES;
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || budget <= 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name, depth + 1);
      } else if (wanted.has(entry.name)) {
        out.push({ name: entry.name, dir: relDir });
      }
    }
  };
  await walk(root, "", 0);
  return out;
}

function isBlueprintManifest(name: string): boolean {
  return name === "blueprint.config.ts"
    || name === "blueprint.config.js"
    || name === "blueprint.config.cjs"
    || name === "blueprint.config.mjs"
    || name === "tact.config.json";
}
