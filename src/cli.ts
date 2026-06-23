#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultConfig, defaultOutputDir, defaultWorkspaceDir, normalizeProjectContext, normalizeRoleModels, type AuditorConfig } from "./config.js";
import { CLI_CONFIG_KEYS, configFilePath, getCliConfigValue, isCliConfigKey, loadCliConfig, setCliConfigValue, unsetCliConfigValue, type CliConfigKey } from "./config-file.js";
import { launchViaApi, ran, resolveServer, fetchArtifact } from "./cli-client.js";
import { deriveScopeNote } from "./scope-note.js";
import type { LaunchSpec } from "./server/run-manager.js";
import { importRunToProjectHistory, projectHistoryManifestPath } from "./trace/history.js";
import { MetadataStore } from "./db/store.js";
import { startUiServer } from "./server/app.js";
import { runDaemon } from "./server/daemon.js";
import { knownRuntimeProviders, loginProvider, printProviderCheck, providerAuthStatus } from "./provider-auth.js";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "history") {
    await runHistoryCommand(rest);
    return;
  }

  if (cmd === "server") {
    runServerCommand(rest);
    return;
  }

  if (cmd === "config") {
    runConfigCommand(rest);
    return;
  }

  if (cmd === "ui") {
    if (rest[0] === "help" || rest.includes("--help") || rest.includes("-h")) {
      printUiHelp();
      return;
    }
    // Control-plane web app: track/drive audits across projects. Keeps running (the server
    // holds the event loop open) until interrupted. Runs execute on a DAEMON, not here — so
    // by default we also spawn a co-located local daemon (mint a token + `flounder daemon start`). Pass
    // --no-daemon to run the control plane alone and connect your own daemon(s) elsewhere.
    const port = readIntFlag(rest, "--port") ?? 4500;
    const host = readFlag(rest, "--host") ?? "127.0.0.1";
    const out = resolveOut(rest);
    const workspace = readFlag(rest, "--workspace") ?? defaultWorkspaceDir(); // where the co-located daemon finds project dirs
    const server = startUiServer({ out, port, host });
    if (rest.includes("--no-daemon")) {
      console.log("[flounder ui] --no-daemon: no executor started. Connect one with `flounder daemon start --server <url> --token <token>`.");
    } else {
      const concurrency = readIntFlag(rest, "--concurrency");
      server.on("listening", () => spawnLocalDaemon({ out, url: `http://${host}:${port}`, workspace, ...(concurrency !== undefined ? { concurrency } : {}) }));
    }
    await new Promise(() => {}); // run until the process is interrupted
    return;
  }

  if (cmd === "daemon") {
    if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
      printDaemonHelp();
      return;
    }
    if (rest[0] === "provider" || rest[0] === "providers") {
      await runProviderCommand(rest.slice(1));
      return;
    }
    if (rest[0] !== "start") {
      throw new Error(`Unknown daemon command "${rest[0]}". Use: flounder daemon start --server <url> --token <token>, or flounder daemon provider ...`);
    }
    // Execution plane: connect to a control-plane server, claim queued jobs, and run them
    // LOCALLY (code + provider keys stay here). May run on a different machine than the
    // server. Reports progress back over HTTP; never touches the server's DB directly.
    const startArgs = rest.slice(1);
    if (startArgs.length === 0 || startArgs[0] === "help" || startArgs.includes("--help") || startArgs.includes("-h")) {
      printDaemonStartHelp();
      return;
    }
    const server = readFlag(startArgs, "--server");
    const token = readFlag(startArgs, "--token");
    if (!server || !token) throw new Error("flounder daemon start needs --server <url> and --token <token> (create one with `flounder server daemon-token mint [name]`)");
    const out = resolveOut(startArgs);
    const name = readFlag(startArgs, "--name");
    const workspace = readFlag(startArgs, "--workspace");
    const concurrency = readIntFlag(startArgs, "--concurrency");
    await runDaemon({ server, token, out, ...(name ? { name } : {}), ...(workspace ? { workspace } : {}), ...(concurrency !== undefined ? { concurrency } : {}) });
    return; // runDaemon loops forever (until interrupted)
  }

  // The three sealed agentic verbs share one driver (runAudit); the verb selects the
  // posture. `run` = map -> audit one-stop; `map` = enumerate scopes only; `audit` =
  // the dig stage (a region, inventory scopes, or claims to verify).
  if (cmd === "run" || cmd === "map" || cmd === "audit") {
    const { cfg } = await parseConfig(rest);
    // `flounder run <clue>` with no --source = the one-command pipeline: prepare → map → dig →
    // confirm, end to end (each a separate tracked phase; the sealed dig stays network-sealed).
    if (cmd === "run" && cfg.sourcePaths.length === 0) {
      const clue = (rest[0] && !rest[0].startsWith("--")) ? rest[0] : readFlag(rest, "--clue");
      if (clue) { await runPipeline(rest, cfg, clue); return; }
    }
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> is required (or give a clue: flounder run <tx|address|link>)");
    if (cfg.dryRun) throw new Error("agentic mode has no --dry-run; use --mock-llm for an offline check (or `npm run mock-audit`)");
    // The CLI is a pure thin client: build the launch spec and enqueue it on the control plane,
    // which dispatches it to a daemon that executes and streams it back — so every CLI run is
    // tracked and visible in the UI exactly like a UI-launched one. No in-process path. No
    // control plane reachable → a clear error (we never auto-spawn one).
    const spec = buildAuditSpec(cmd, rest, cfg);
    // `audit --verify <file>`: read the LOCAL findings file and carry its CONTENTS in the spec
    // (not a path — the daemon may be on another machine), so verify is a control-plane run too.
    if (cmd === "audit") {
      const verifyFile = readFlag(rest, "--verify");
      if (verifyFile !== undefined) spec.verifyFindings = JSON.parse(await readFile(verifyFile, "utf8"));
    }
    const run = await launchViaApi(resolveServer(readFlag(rest, "--server")), spec);
    if (!ran(run)) process.exitCode = 1;
    return;
  }

  if (cmd === "prepare") {
    // Open-world ACQUISITION phase, BEFORE map: turn a clue (tx / address / project / link)
    // into the complete, mainnet-matched scope the sealed audit will read, staged with a
    // provenance manifest. Usage: flounder prepare <clue> [--posture blind|informed] [--no-match-deployed] [--endpoint <url>]
    const { cfg } = await parseConfig(rest);
    const clue = (rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined) ?? readFlag(rest, "--clue");
    if (!clue) throw new Error("flounder prepare needs a clue: flounder prepare <tx|address|project|url> [--posture blind|informed]");
    const posture: "blind" | "informed" = (readFlag(rest, "--posture") ?? loadCliConfig().values.posture) === "informed" ? "informed" : "blind";
    const matchDeployed = !rest.includes("--no-match-deployed");
    const endpoint = readFlag(rest, "--endpoint") ?? readFlag(rest, "--rpc");
    const maxSteps = readIntFlag(rest, "--max-steps");
    // Name the staged project after the clue when --target wasn't given, so each prepare is its
    // own UI project rather than colliding on the default "target".
    if (cfg.targetName === "target") cfg.targetName = `prepare-${slugifyClue(clue)}`;
    const spec: LaunchSpec = { verb: "prepare", target: cfg.targetName, sourcePaths: [], provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, clue, posture, matchDeployed, out: cfg.outputDir, ...sandboxSpec(cfg) };
    if (endpoint !== undefined) spec.endpoint = endpoint;
    if (maxSteps !== undefined) spec.maxSteps = maxSteps;
    const run = await launchViaApi(resolveServer(readFlag(rest, "--server")), spec);
    if (!ran(run)) process.exitCode = 1;
    return;
  }

  if (cmd === "confirm") {
    // Open-world confirmation pass over a prior `flounder run`: freeze its findings, then
    // reproduce/consolidate them against real-world ground truth (network enabled) and
    // emit a submit/no-submit decision sheet. Usage: flounder confirm <run-dir> --source <paths...>
    const { cfg } = await parseConfig(rest);
    const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const inputRunDir = positional ?? readFlag(rest, "--run") ?? readFlag(rest, "--input");
    if (!inputRunDir) throw new Error("flounder confirm needs a prior run directory: flounder confirm <run-dir> --source <paths...>");
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> is required (the target code to reproduce against)");
    // Confirm is UNBOUNDED by default (run until the model finishes); --max-steps caps it only if given.
    // It auto-RESUMES a prior interrupted confirm of the same run dir (carries settled rows forward); --fresh ignores that.
    const maxSteps = readIntFlag(rest, "--max-steps");
    const fresh = rest.includes("--fresh");
    const spec: LaunchSpec = { verb: "confirm", target: cfg.targetName, sourcePaths: cfg.sourcePaths, corpusPaths: cfg.corpusPaths, provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, inputRunDir, out: cfg.outputDir, ...sandboxSpec(cfg) };
    if (cfg.buildRoot) spec.buildRoot = cfg.buildRoot;
    if (fresh) spec.fresh = true;
    if (maxSteps !== undefined) spec.maxSteps = maxSteps;
    const run = await launchViaApi(resolveServer(readFlag(rest, "--server")), spec);
    if (!ran(run)) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

async function parseConfig(args: string[]): Promise<{ cfg: AuditorConfig }> {
  const cfg = defaultConfig();
  // Persisted CLI config (user-global < project-local < env) is the base layer, applied BELOW
  // an explicit --config file and the flags — so `flounder config set provider …` sticks but a
  // one-off --provider still wins. Only the fields that map to a CLI concept are layered here.
  const fileCfg = loadCliConfig().values;
  if (fileCfg.provider) cfg.provider = fileCfg.provider;
  if (fileCfg.model) cfg.auditModel = fileCfg.model;
  if (fileCfg.thinking) cfg.thinkingLevel = fileCfg.thinking;
  if (fileCfg.out) cfg.outputDir = fileCfg.out;
  const configPath = readFlag(args, "--config");
  if (configPath) {
    applyConfigOverrides(cfg, JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>);
  }
  cfg.targetName = readFlag(args, "--target") ?? cfg.targetName;
  const sourcePaths = readMultiFlag(args, "--source");
  const corpusPaths = readMultiFlag(args, "--corpus");
  if (sourcePaths.length > 0) cfg.sourcePaths = sourcePaths;
  if (corpusPaths.length > 0) cfg.corpusPaths = corpusPaths;
  const buildRoot = readFlag(args, "--build-root");
  if (buildRoot !== undefined) cfg.buildRoot = buildRoot;
  cfg.outputDir = readFlag(args, "--out") ?? cfg.outputDir;
  const historyDir = readFlag(args, "--history-dir");
  if (historyDir !== undefined) cfg.historyDir = historyDir;
  cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
  cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
  cfg.maxTokens = readIntFlag(args, "--max-tokens") ?? cfg.maxTokens;
  cfg.reproductionCommandTimeoutMs = readIntFlag(args, "--repro-timeout-ms") ?? cfg.reproductionCommandTimeoutMs;
  const sandboxBackend = readFlag(args, "--sandbox-backend");
  if (sandboxBackend === "auto" || sandboxBackend === "oci" || sandboxBackend === "host") cfg.sandboxBackend = sandboxBackend;
  cfg.sandboxImage = readFlag(args, "--sandbox-image") ?? cfg.sandboxImage;
  if (args.includes("--allow-host-execution")) cfg.sandboxAllowHostFallback = true;
  const prepareNetwork = readFlag(args, "--prepare-network");
  if (prepareNetwork === "none" || prepareNetwork === "enabled") cfg.sandboxPrepareNetwork = prepareNetwork;
  const confirmNetwork = readFlag(args, "--confirm-network");
  if (confirmNetwork === "none" || confirmNetwork === "enabled") cfg.sandboxConfirmNetwork = confirmNetwork;
  const memoryMb = readIntFlag(args, "--sandbox-memory-mb");
  if (memoryMb !== undefined) cfg.sandboxMemoryMb = memoryMb;
  const cpus = readFloatFlag(args, "--sandbox-cpus");
  if (cpus !== undefined) cfg.sandboxCpus = cpus;
  cfg.auditMaxSteps = readIntFlag(args, "--max-steps") ?? cfg.auditMaxSteps;
  const scopeNote = readFlag(args, "--scope-note");
  if (scopeNote !== undefined) cfg.auditScopeNote = scopeNote;
  if (args.includes("--no-prepare")) cfg.auditPrepare = false;
  cfg.auditPrepareTimeoutMs = readIntFlag(args, "--prepare-timeout-ms") ?? cfg.auditPrepareTimeoutMs;
  if (args.includes("--no-refute")) cfg.auditRefute = false;
  if (args.includes("--no-appeal")) cfg.auditAppeal = false;
  // The audit POSTURE (map / dig region / dig scope / verify) is set by the command
  // verb in applyAuditPosture, not here. parseConfig only reads shared, posture-agnostic
  // knobs (materials, models, budgets, deep-phase parameters).
  cfg.auditMaxScopes = readIntFlag(args, "--max-scopes") ?? cfg.auditMaxScopes;
  cfg.auditMapSteps = readIntFlag(args, "--map-steps") ?? cfg.auditMapSteps;
  cfg.auditDigSteps = readIntFlag(args, "--dig-steps") ?? cfg.auditDigSteps;
  cfg.auditDigSamples = readIntFlag(args, "--dig-samples") ?? cfg.auditDigSamples;
  cfg.auditDigConcurrency = readIntFlag(args, "--dig-concurrency") ?? cfg.auditDigConcurrency;
  if (args.includes("--remap")) cfg.auditRemap = true;
  if (args.includes("--dry-run")) cfg.dryRun = true;
  const thinking = readFlag(args, "--thinking");
  if (thinking === "off" || thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  return { cfg };
}

function applyConfigOverrides(cfg: AuditorConfig, raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.targetName === "string") cfg.targetName = raw.targetName;
  if (Array.isArray(raw.sourcePaths) && raw.sourcePaths.every((value) => typeof value === "string")) cfg.sourcePaths = raw.sourcePaths;
  if (Array.isArray(raw.corpusPaths) && raw.corpusPaths.every((value) => typeof value === "string")) cfg.corpusPaths = raw.corpusPaths;
  const rawBuildRoot = raw.buildRoot ?? raw.build_root;
  if (typeof rawBuildRoot === "string" && rawBuildRoot.trim().length > 0) cfg.buildRoot = rawBuildRoot.trim();
  if (typeof raw.outputDir === "string") cfg.outputDir = raw.outputDir;
  if (typeof raw.historyDir === "string") cfg.historyDir = raw.historyDir;
  if (typeof raw.history_dir === "string") cfg.historyDir = raw.history_dir;
  if (typeof raw.provider === "string") cfg.provider = raw.provider;
  if (typeof raw.auditModel === "string") cfg.auditModel = raw.auditModel;
  if (typeof raw.model === "string") cfg.auditModel = raw.model;
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) cfg.maxTokens = Math.max(1000, Math.floor(raw.maxTokens));
  const rawReproductionCommandTimeoutMs = raw.reproductionCommandTimeoutMs ?? raw.reproduction_command_timeout_ms;
  if (typeof rawReproductionCommandTimeoutMs === "number" && Number.isFinite(rawReproductionCommandTimeoutMs)) {
    cfg.reproductionCommandTimeoutMs = Math.max(1000, Math.floor(rawReproductionCommandTimeoutMs));
  }
  const rawSandboxBackend = raw.sandboxBackend ?? raw.sandbox_backend;
  if (rawSandboxBackend === "auto" || rawSandboxBackend === "oci" || rawSandboxBackend === "host") cfg.sandboxBackend = rawSandboxBackend;
  const rawSandboxImage = raw.sandboxImage ?? raw.sandbox_image;
  if (typeof rawSandboxImage === "string" && rawSandboxImage.trim()) cfg.sandboxImage = rawSandboxImage.trim();
  const rawAllowHost = raw.sandboxAllowHostFallback ?? raw.sandbox_allow_host_fallback ?? raw.allowHostExecution ?? raw.allow_host_execution;
  if (typeof rawAllowHost === "boolean") cfg.sandboxAllowHostFallback = rawAllowHost;
  const rawPrepareNetwork = raw.sandboxPrepareNetwork ?? raw.sandbox_prepare_network;
  if (rawPrepareNetwork === "none" || rawPrepareNetwork === "enabled") cfg.sandboxPrepareNetwork = rawPrepareNetwork;
  const rawConfirmNetwork = raw.sandboxConfirmNetwork ?? raw.sandbox_confirm_network;
  if (rawConfirmNetwork === "none" || rawConfirmNetwork === "enabled") cfg.sandboxConfirmNetwork = rawConfirmNetwork;
  const rawSandboxMemoryMb = raw.sandboxMemoryMb ?? raw.sandbox_memory_mb;
  if (typeof rawSandboxMemoryMb === "number" && Number.isFinite(rawSandboxMemoryMb)) cfg.sandboxMemoryMb = Math.max(64, Math.floor(rawSandboxMemoryMb));
  const rawSandboxCpus = raw.sandboxCpus ?? raw.sandbox_cpus;
  if (typeof rawSandboxCpus === "number" && Number.isFinite(rawSandboxCpus)) cfg.sandboxCpus = Math.max(0.1, rawSandboxCpus);
  const rawAuditMaxSteps = raw.auditMaxSteps ?? raw.audit_max_steps;
  if (typeof rawAuditMaxSteps === "number" && Number.isFinite(rawAuditMaxSteps)) cfg.auditMaxSteps = Math.max(1, Math.floor(rawAuditMaxSteps));
  const rawAuditScopeNote = raw.auditScopeNote ?? raw.audit_scope_note;
  if (typeof rawAuditScopeNote === "string" && rawAuditScopeNote.trim().length > 0) cfg.auditScopeNote = rawAuditScopeNote.trim();
  const rawAuditPrepare = raw.auditPrepare ?? raw.audit_prepare;
  if (typeof rawAuditPrepare === "boolean") cfg.auditPrepare = rawAuditPrepare;
  const rawAuditPrepareTimeoutMs = raw.auditPrepareTimeoutMs ?? raw.audit_prepare_timeout_ms;
  if (typeof rawAuditPrepareTimeoutMs === "number" && Number.isFinite(rawAuditPrepareTimeoutMs)) cfg.auditPrepareTimeoutMs = Math.max(10_000, Math.floor(rawAuditPrepareTimeoutMs));
  const rawAuditRefute = raw.auditRefute ?? raw.audit_refute;
  if (typeof rawAuditRefute === "boolean") cfg.auditRefute = rawAuditRefute;
  const rawAuditAppeal = raw.auditAppeal ?? raw.audit_appeal;
  if (typeof rawAuditAppeal === "boolean") cfg.auditAppeal = rawAuditAppeal;
  const rawAuditDeep = raw.auditDeep ?? raw.audit_deep;
  if (typeof rawAuditDeep === "boolean") cfg.auditDeep = rawAuditDeep;
  const rawAuditDeepFocus = raw.auditDeepFocus ?? raw.audit_deep_focus;
  if (typeof rawAuditDeepFocus === "string" && rawAuditDeepFocus.trim().length > 0) {
    cfg.auditDeep = true;
    cfg.auditDeepFocus = rawAuditDeepFocus.trim();
  }
  const rawMaxScopes = raw.auditMaxScopes ?? raw.audit_max_scopes;
  if (typeof rawMaxScopes === "number" && Number.isFinite(rawMaxScopes)) cfg.auditMaxScopes = Math.max(1, Math.floor(rawMaxScopes));
  const rawMapSteps = raw.auditMapSteps ?? raw.audit_map_steps;
  if (typeof rawMapSteps === "number" && Number.isFinite(rawMapSteps)) cfg.auditMapSteps = Math.max(1, Math.floor(rawMapSteps));
  const rawDigSteps = raw.auditDigSteps ?? raw.audit_dig_steps;
  if (typeof rawDigSteps === "number" && Number.isFinite(rawDigSteps)) cfg.auditDigSteps = Math.max(1, Math.floor(rawDigSteps));
  const rawDigSamples = raw.auditDigSamples ?? raw.audit_dig_samples;
  if (typeof rawDigSamples === "number" && Number.isFinite(rawDigSamples)) cfg.auditDigSamples = Math.max(1, Math.floor(rawDigSamples));
  const rawDigConcurrency = raw.auditDigConcurrency ?? raw.audit_dig_concurrency;
  if (typeof rawDigConcurrency === "number" && Number.isFinite(rawDigConcurrency)) cfg.auditDigConcurrency = Math.max(1, Math.floor(rawDigConcurrency));
  if (raw.thinkingLevel === "off" || raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  const rawModels = normalizeRoleModels(raw.models);
  if (rawModels) cfg.models = rawModels;
  if ("projectContext" in raw || "project_context" in raw) {
    cfg.projectContext = normalizeProjectContext(raw.projectContext ?? raw.project_context) ?? cfg.projectContext;
  }
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
}

// Spawn a co-located daemon for `flounder ui`: reuse the local auto-daemon token from
// the shared store, then run `flounder daemon start` as a child pointed at the
// just-started server. Reusing the token keeps the daemon id stable across UI restarts,
// so projects pinned to the local executor keep claiming their queued jobs.
function spawnLocalDaemon(opts: { out: string; url: string; workspace?: string; concurrency?: number }): void {
  const store = MetadataStore.openForOutput(opts.out);
  const { id, token, reused } = store.getOrCreateLocalDaemonToken();
  store.close();
  const args = [fileURLToPath(import.meta.url), "daemon", "start", "--server", opts.url, "--token", token, "--out", opts.out, "--name", "local"];
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.concurrency !== undefined) args.push("--concurrency", String(opts.concurrency));
  console.log(`[flounder ui] ${reused ? "reusing" : "created"} local daemon #${id}`);
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("error", (error) => console.error(`[flounder ui] could not start local daemon: ${error.message}`));
  child.on("exit", (code) => console.log(`[flounder ui] local daemon exited (code ${code ?? "?"})`));
  const kill = (): void => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", kill);
  // Tie the child to our lifecycle for every way we're asked to stop: SIGINT (Ctrl-C), SIGTERM
  // (`pkill`, process managers, `kill`), and SIGHUP (terminal closed). A bare signal terminates
  // Node WITHOUT running the "exit" handler, so without these the daemon would be orphaned.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      kill();
      process.exit(0);
    });
  }
}

/** Resolve --out: flag > persisted config `out` > ~/.flounder. Keeps the tracking-store location
 * consistent across the CLI, the control plane, and the daemon when set once via config. */
function resolveOut(args: string[]): string {
  return readFlag(args, "--out") ?? loadCliConfig().values.out ?? defaultOutputDir();
}

async function runProviderCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printDaemonProviderHelp();
    return;
  }
  const positional = (i = 0): string | undefined => args.filter((token) => !token.startsWith("--")).slice(1)[i];
  const provider = positional() ?? readFlag(args, "--provider") ?? loadCliConfig().values.provider ?? defaultConfig().provider;

  if (subcommand === "list") {
    const rows = await Promise.all(knownRuntimeProviders().map(async (name) => providerAuthStatus(name)));
    for (const row of rows) {
      const auth = !row.required ? "local" : row.configured ? `ok:${row.source ?? "configured"}` : row.oauthLogin ? "login-needed" : "env-needed";
      console.log(`${namePad(row.provider)} ${auth}`);
    }
    return;
  }

  if (subcommand === "check") {
    const ok = await printProviderCheck(provider);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (subcommand === "login") {
    await loginProvider(provider);
    return;
  }

  throw new Error(`Unknown daemon provider command "${subcommand}". Use: flounder daemon provider list | check [provider] | login [provider]`);
}

function printDaemonHelp(): void {
  console.log(`flounder daemon — execution-plane worker.

Usage:
  flounder daemon start --server <url> --token <token> [--workspace <dir>] [--out <dir>] [--name <name>] [--concurrency <n>]
  flounder daemon provider [list | check [provider] | login [provider]]

The daemon runs audits locally: target source, sandbox execution, and provider
credentials stay on this machine. The control-plane server only queues jobs and
stores status.

Defaults:
  --out        ~/.flounder
  --workspace  ~/.flounder/workspace

Setup:
  flounder server daemon-token mint my-daemon
  flounder daemon provider login openai-codex
  flounder daemon provider check openai-codex
  flounder daemon start --server http://127.0.0.1:4500 --token <token>
`);
}

function printDaemonStartHelp(): void {
  console.log(`flounder daemon start — connect this machine as an executor.

Usage:
  flounder daemon start --server <url> --token <token> [--workspace <dir>] [--out <dir>] [--name <name>] [--concurrency <n>]

Required:
  --server      Control-plane URL, for example http://127.0.0.1:4500
  --token       Daemon connection token minted by flounder server daemon-token mint

Defaults:
  --out         ~/.flounder
  --workspace  ~/.flounder/workspace

Before starting real work, authenticate provider profiles on this daemon machine:
  flounder daemon provider login openai-codex
  flounder daemon provider check openai-codex
`);
}

function printDaemonProviderHelp(): void {
  console.log(`flounder daemon provider — provider auth on this daemon machine.

Usage:
  flounder daemon provider list
  flounder daemon provider check [provider]
  flounder daemon provider login [provider]

Provider credentials are never stored on the server. OAuth/subscription providers
write daemon-local auth under ~/.flounder/agent/auth.json unless
FLOUNDER_AGENT_DIR is set. Existing pi auth for the same provider can be imported
from ~/.pi/agent/auth.json. API-key providers can be supplied through the daemon
process environment.
`);
}

function runMintTokenCommand(args: string[]): void {
  const out = resolveOut(args);
  const positional = args.find((token) => !token.startsWith("--"));
  const name = readFlag(args, "--name") ?? positional ?? "daemon";
  const server = readFlag(args, "--server") ?? "http://<this-server-host>:4500";
  const db = MetadataStore.openForOutput(out);
  try {
    const { id, token } = db.createDaemonToken(name);
    console.log(`[daemon ${id}] ${name}`);
    console.log(`token: ${token}`);
    console.log(`run on the executor machine:\n  flounder daemon start --server ${server} --token ${token}`);
  } finally {
    db.close();
  }
}

function runDaemonTokenCommand(args: string[]): void {
  const [subcommand = "mint", ...rest] = args;
  if (subcommand === "mint" || subcommand === "create") {
    runMintTokenCommand(rest);
    return;
  }
  throw new Error("Unknown server daemon-token command. Use: flounder server daemon-token mint [name]");
}

function runDaemonListCommand(args: string[]): void {
  const out = resolveOut(args);
  const db = MetadataStore.openForOutput(out);
  try {
    const daemons = db.listDaemons();
    if (daemons.length === 0) {
      console.log("(no daemons registered — create a connection token with `flounder server daemon-token mint [name]`, then run `flounder daemon start --server <url> --token <token>`)");
      return;
    }
    for (const d of daemons) console.log(`• [${d.id}] ${d.name}  last_seen=${d.last_seen_at ?? "never"}`);
  } finally {
    db.close();
  }
}

function namePad(value: string): string {
  return value.padEnd(28);
}

/** Build the launch spec for a sealed audit verb (run/map/audit). Materials come from cfg
 * (config-file + flags; the client makes them absolute before sending). Budgets are carried ONLY
 * when explicitly capped, so the daemon's unbounded default applies otherwise. */
function buildAuditSpec(cmd: "run" | "map" | "audit", rest: string[], cfg: AuditorConfig): LaunchSpec {
  const spec: LaunchSpec = {
    verb: cmd,
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths,
    corpusPaths: cfg.corpusPaths,
    provider: cfg.provider,
    model: cfg.auditModel,
    thinking: cfg.thinkingLevel,
    out: cfg.outputDir,
    ...sandboxSpec(cfg),
  };
  if (cfg.buildRoot) spec.buildRoot = cfg.buildRoot;
  if (cfg.auditScopeNote && cfg.auditScopeNote.trim()) spec.scopeNote = cfg.auditScopeNote.trim(); // --scope-note, or the pipeline's prepare-derived focus
  if (cmd === "run" && rest.includes("--quick")) spec.quick = true;
  if (rest.includes("--remap")) spec.remap = true;
  if (rest.includes("--mock-llm")) spec.mockLlm = true; // offline mock model, executed by the daemon
  if (cmd === "audit") {
    const region = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (region) spec.region = region;
    const scope = readFlag(rest, "--scope");
    if (scope) spec.scope = scope;
  }
  const cap = (flag: string, set: (n: number) => void): void => {
    const n = readIntFlag(rest, flag);
    if (n !== undefined) set(n);
  };
  cap("--max-steps", (n) => (spec.maxSteps = n));
  cap("--map-steps", (n) => (spec.mapSteps = n));
  cap("--dig-steps", (n) => (spec.digSteps = n));
  cap("--max-scopes", (n) => (spec.maxScopes = n));
  cap("--dig-samples", (n) => (spec.digSamples = n));
  cap("--dig-concurrency", (n) => (spec.digConcurrency = n));
  return spec;
}

function sandboxSpec(cfg: AuditorConfig): Pick<LaunchSpec, "sandboxBackend" | "sandboxImage" | "sandboxAllowHostFallback" | "sandboxPrepareNetwork" | "sandboxConfirmNetwork" | "sandboxMemoryMb" | "sandboxCpus"> {
  return {
    sandboxBackend: cfg.sandboxBackend,
    sandboxImage: cfg.sandboxImage,
    sandboxAllowHostFallback: cfg.sandboxAllowHostFallback,
    sandboxPrepareNetwork: cfg.sandboxPrepareNetwork,
    sandboxConfirmNetwork: cfg.sandboxConfirmNetwork,
    ...(cfg.sandboxMemoryMb !== undefined ? { sandboxMemoryMb: cfg.sandboxMemoryMb } : {}),
    ...(cfg.sandboxCpus !== undefined ? { sandboxCpus: cfg.sandboxCpus } : {}),
  };
}

/** A short, filesystem/UI-safe slug from a prepare clue (tx / address / url), for the project name. */
function slugifyClue(clue: string): string {
  const slug = clue.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return slug || "target";
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// `flounder run <clue>` — the one-command pipeline. Orchestrates the distinct phases as SEPARATE
// tracked runs (so each stays resumable + UI-visible and the dig stays network-sealed), feeding
// each phase's output to the next: prepare (acquire, open-world) → run (map→dig, sealed) on the
// staged source → confirm (reproduce, open-world) if the dig found anything. The user runs one
// command and reads the final trail. --no-confirm stops after the dig; --posture/--no-match-deployed/
// --endpoint tune prepare; --max-scopes/--dig-* tune the dig (via buildAuditSpec).
async function runPipeline(rest: string[], cfg: AuditorConfig, clue: string): Promise<void> {
  const server = resolveServer(readFlag(rest, "--server"));
  const target = cfg.targetName === "target" ? `aud-${slugifyClue(clue)}` : cfg.targetName;
  cfg.targetName = target;
  const posture: "blind" | "informed" = (readFlag(rest, "--posture") ?? loadCliConfig().values.posture) === "informed" ? "informed" : "blind";
  const matchDeployed = !rest.includes("--no-match-deployed");
  const endpoint = readFlag(rest, "--endpoint") ?? readFlag(rest, "--rpc");
  const noConfirm = rest.includes("--no-confirm");
  console.log(`=== flounder run pipeline · target "${target}" · prepare → map → dig${noConfirm ? "" : " → confirm"} ===`);

  // Phase 1 — prepare (open-world acquisition + deployment match) stages the source.
  console.log("\n── phase 1 · prepare (acquire the target) ──");
  const prepSpec: LaunchSpec = { verb: "prepare", target, sourcePaths: [], provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, clue, posture, matchDeployed, out: cfg.outputDir, ...sandboxSpec(cfg) };
  if (endpoint !== undefined) prepSpec.endpoint = endpoint;
  const prep = await launchViaApi(server, prepSpec);
  if (!ran(prep)) { console.error("[pipeline] prepare did not finish — stopping."); process.exitCode = 1; return; }
  const staged = `${String(prep!.run_dir)}/prepare/workspace`;

  // Derive the map/dig FOCUS from prepare's manifest: the deployment-matched / in-scope components
  // become the primary target, the rest named as trust boundaries. This is a factual restatement of
  // what prepare staged — NOT a bug hint — so map concentrates on the target without overfitting.
  // (A user --scope-note still composes on top.) Best-effort: no manifest reachable → map unfocused.
  const manifestText = await fetchArtifact(server, Number(prep!.id), "prepare_manifest.json");
  const derived = manifestText ? deriveScopeNote(safeJsonParse(manifestText)) : undefined;
  if (derived) {
    const userNote = readFlag(rest, "--scope-note");
    cfg.auditScopeNote = [userNote, derived].filter((s): s is string => !!s && s.trim().length > 0).join("\n\n");
    console.log(`[pipeline] scope focus derived from prepare manifest (${derived.split("\n").filter((l) => l.startsWith("- ")).length} components classified) — map/dig will prioritise the in-scope target.`);
  } else {
    console.log("[pipeline] no usable prepare manifest — map will treat all staged source as in scope.");
  }

  // Phase 2 — run = map → dig, NETWORK-SEALED, on the staged source.
  console.log("\n── phase 2 · run (map → dig, network-sealed) ──");
  cfg.sourcePaths = [staged];
  const audit = await launchViaApi(server, buildAuditSpec("run", rest, cfg));
  if (!ran(audit)) { console.error("[pipeline] audit did not finish — stopping."); process.exitCode = 1; return; }

  // Phase 3 — confirm (open-world reproduction) the dig's findings on the real target.
  const findings = Number(audit!.findings_total ?? 0);
  if (noConfirm) console.log("\n[pipeline] --no-confirm — skipping reproduction.");
  else if (findings <= 0) console.log("\n[pipeline] the dig surfaced no findings — nothing to reproduce.");
  else {
    console.log("\n── phase 3 · confirm (reproduce on the real target) ──");
    const confSpec: LaunchSpec = { verb: "confirm", target, sourcePaths: [staged], inputRunDir: String(audit!.run_dir), provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, out: cfg.outputDir, ...sandboxSpec(cfg) };
    if (!ran(await launchViaApi(server, confSpec))) process.exitCode = 1;
  }
  console.log(`\n=== pipeline done · UI project "${target}" has the full prepare → dig${noConfirm ? "" : " → confirm"} trail ===`);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readIntFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readFloatFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readMultiFlag(args: string[], name: string): string[] {
  const idx = args.indexOf(name);
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < args.length; i += 1) {
    const value = args[i];
    if (!value || value.startsWith("--")) break;
    out.push(value);
  }
  return out;
}

async function runHistoryCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "import-run") {
    throw new Error("Unknown history command. Use: flounder history import-run --target <name> --run <dir>");
  }
  const { cfg } = await parseConfig(rest);
  const runDir = readFlag(rest, "--run") ?? readFlag(rest, "--run-dir");
  if (!runDir) throw new Error("--run <dir> is required");
  const manifest = await importRunToProjectHistory({ ...projectHistoryLocation(cfg), runDir });
  const manifestPath = projectHistoryManifestPath(projectHistoryLocation(cfg));
  console.log(`[history] manifest=${manifestPath}`);
  console.log(`[history] runs=${manifest.aggregate.totalRuns} materials=${manifest.aggregate.materialsTotal} findings=${manifest.aggregate.findingsTotal}`);
}

// Read/write views over the control-plane server state. These are product resources, not
// database commands: project inventory, global run history, global findings, daemon registry,
// and daemon connection tokens.
function runServerCommand(args: string[]): void {
  const [resource, ...rest] = args;
  if (!resource || resource === "help" || resource === "--help" || resource === "-h") {
    printServerHelp();
    return;
  }
  if (resource === "project") {
    runProjectCommand(rest);
    return;
  }
  if (resource === "run") {
    runServerRunCommand(rest);
    return;
  }
  if (resource === "finding") {
    runFindingCommand(rest);
    return;
  }
  if (resource === "daemon") {
    const [subcommand = "list", ...daemonRest] = rest;
    if (subcommand !== "list") throw new Error(`Unknown server daemon command "${subcommand}". Use: flounder server daemon list`);
    runDaemonListCommand(daemonRest);
    return;
  }
  if (resource === "daemon-token") {
    runDaemonTokenCommand(rest);
    return;
  }
  throw new Error(`Unknown server resource "${resource}". Use: flounder server project|run|finding|daemon|daemon-token`);
}

function runProjectCommand(args: string[]): void {
  const [subcommand = "list"] = args;
  const out = resolveOut(args);
  const db = MetadataStore.openForOutput(out);
  try {
    if (subcommand === "list") {
      const projects = db.listProjects();
      if (projects.length === 0) {
        console.log("(no projects tracked yet — run `flounder run` first, or check --out)");
        return;
      }
      for (const project of projects) {
        const id = Number(project.id);
        const progress = db.scopeProgress(id);
        const runs = db.listRuns(id);
        const findings = db.listFindings(id);
        const latest = runs[0];
        console.log(`• ${project.name}`);
        console.log(`    scopes:   ${progress.audited}/${progress.total} audited (${progress.pending} pending)`);
        console.log(`    findings: ${findings.length}  ${formatStatusCounts(findings)}`);
        console.log(`    runs:     ${runs.length}${latest ? `  latest: ${latest.kind} [${latest.status}] ${latest.run_dir ?? ""}` : ""}`);
      }
      return;
    }
    throw new Error(`Unknown server project command "${subcommand}". Use: flounder server project list`);
  } finally {
    db.close();
  }
}

function runServerRunCommand(args: string[]): void {
  const [subcommand = "list", ...rest] = args;
  if (subcommand !== "list") throw new Error(`Unknown server run command "${subcommand}". Use: flounder server run list [--project <name>]`);
  const out = resolveOut(args);
  const positional = rest.find((token) => !token.startsWith("--"));
  const target = readFlag(args, "--project") ?? readFlag(args, "--target") ?? positional;
  const db = MetadataStore.openForOutput(out);
  try {
    const projectId = target ? resolveProjectId(db, target) : undefined;
    const projects = db.listProjects();
    const projectNameById = new Map(projects.map((project) => [Number(project.id), String(project.name)]));
    const runs = db.listRuns(projectId);
    if (runs.length === 0) {
      console.log(target ? `(no runs tracked for ${target})` : "(no runs tracked yet)");
      return;
    }
    for (const run of runs) {
      const projectName = projectNameById.get(Number(run.project_id)) ?? "unknown-project";
      console.log(`${run.started_at}  ${projectName}  ${run.kind} [${run.status}]  scopes ${run.scopes_audited ?? "-"}/${run.scopes_total ?? "-"}  findings ${run.findings_total ?? "-"}  ${run.run_dir ?? ""}`);
    }
  } finally {
    db.close();
  }
}

function runFindingCommand(args: string[]): void {
  const [subcommand = "list", ...rest] = args;
  if (subcommand !== "list") throw new Error(`Unknown server finding command "${subcommand}". Use: flounder server finding list [--project <name>]`);
  const out = resolveOut(args);
  const positional = rest.find((token) => !token.startsWith("--"));
  const target = readFlag(args, "--project") ?? readFlag(args, "--target") ?? positional;
  const status = readFlag(args, "--status");
  const tracking = readFlag(args, "--tracking");
  const db = MetadataStore.openForOutput(out);
  try {
    const findings = target
      ? db.listFindings(resolveProjectId(db, target)).filter((finding) => matchesFindingFilters(finding, status, tracking))
      : db.listGlobalFindings({ status, tracking });
    if (findings.length === 0) {
      console.log(target ? `(no findings tracked for ${target})` : "(no findings tracked yet)");
      return;
    }
    for (const finding of findings) {
      const project = finding.project_name ? `${finding.project_name}  ` : "";
      const timeline = db.findingTimeline(Number(finding.id)).map((event) => event.to_status).join(" → ");
      console.log(`${project}[${finding.status}] ${finding.title} (${finding.location ?? "?"})  ${timeline}`);
    }
  } finally {
    db.close();
  }
}

function matchesFindingFilters(finding: Record<string, unknown>, status: string | undefined, tracking: string | undefined): boolean {
  if (status && finding.status !== status) return false;
  if (tracking && String(finding.tracking_status ?? "open") !== tracking) return false;
  return true;
}

function printServerHelp(): void {
  console.log(`flounder server — control-plane resources.

Usage:
  flounder server project list
  flounder server run list [--project <name>]
  flounder server finding list [--project <name>] [--status <s>] [--tracking <s>]
  flounder server daemon list
  flounder server daemon-token mint [name] [--server <url>]

These commands read or write the server/control-plane state. Daemon-machine local
operations stay under "flounder daemon ...", for example "flounder daemon provider login".`);
}

function resolveProjectId(db: MetadataStore, target: string | undefined): number {
  const projects = db.listProjects();
  if (!target) {
    const only = projects[0];
    if (projects.length === 1 && only) return Number(only.id);
    throw new Error("--target <name> is required (multiple projects tracked)");
  }
  const match = projects.find((project) => project.name === target);
  if (!match) throw new Error(`no tracked project named "${target}"`);
  return Number(match.id);
}

function formatStatusCounts(findings: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const status = String(finding.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

function projectHistoryLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

// `flounder config` — read/write the persisted CLI config (the layered files loadCliConfig
// merges). Scope defaults to --global (your usual settings); --local writes the nearest
// .flounder/config.json for project-specific overrides.
function runConfigCommand(args: string[]): void {
  const [sub = "list", ...rest] = args;
  const scope: "global" | "local" = rest.includes("--local") ? "local" : "global";
  const cwd = process.cwd();
  const keyList = (Object.keys(CLI_CONFIG_KEYS) as CliConfigKey[]).join(", ");
  const positional = (i = 0): string | undefined => rest.filter((t) => !t.startsWith("--"))[i];

  if (sub === "list") {
    const loaded = loadCliConfig(cwd);
    console.log(`user:    ${loaded.userFile}${existsSync(loaded.userFile) ? "" : "  (none yet)"}`);
    console.log(`project: ${loaded.projectFile ?? "(none found by walking up from cwd)"}`);
    console.log("");
    for (const key of Object.keys(CLI_CONFIG_KEYS) as CliConfigKey[]) {
      const value = loaded.values[key];
      const spec = CLI_CONFIG_KEYS[key];
      if (value === undefined) console.log(`  ${key.padEnd(9)} (unset)  — ${spec.summary}`);
      else console.log(`  ${key.padEnd(9)} ${String(value)}  [${loaded.sources[key]}]`);
    }
    return;
  }
  if (sub === "path") {
    console.log(configFilePath(scope, cwd));
    return;
  }
  if (sub === "get") {
    const key = positional();
    if (!key || !isCliConfigKey(key)) throw new Error(`flounder config get <key>  — keys: ${keyList}`);
    const { value, source } = getCliConfigValue(key, cwd);
    console.log(value === undefined ? `(${key} is unset)` : `${value}  [${source}]`);
    return;
  }
  if (sub === "set") {
    const key = positional(0);
    const value = rest.filter((t) => !t.startsWith("--")).slice(1).join(" ");
    if (!key || !isCliConfigKey(key)) throw new Error(`flounder config set <key> <value> [--global|--local]  — keys: ${keyList}`);
    if (!value) throw new Error(`flounder config set ${key} <value>  — a value is required`);
    const { file, value: stored } = setCliConfigValue(key, value, scope, cwd);
    console.log(`set ${key} = ${stored}  (${scope}: ${file})`);
    return;
  }
  if (sub === "unset") {
    const key = positional();
    if (!key || !isCliConfigKey(key)) throw new Error(`flounder config unset <key> [--global|--local]  — keys: ${keyList}`);
    const { file, existed } = unsetCliConfigValue(key, scope, cwd);
    console.log(existed ? `unset ${key}  (${scope}: ${file})` : `${key} was not set in ${scope}  (${file})`);
    return;
  }
  throw new Error(`Unknown config command "${sub}". Use: flounder config [list | get <key> | set <key> <value> | unset <key> | path] [--global|--local]`);
}

function printHelp(): void {
  console.log(`flounder — white-hat agentic security audit.

Usage:
  flounder prepare <clue> [--posture blind|informed] [--no-match-deployed] [--endpoint <url>]   open-world: clue (tx/address/project/repo/link) -> complete, deployment-matched scope; runs BEFORE map
  flounder run     <clue>                                                         ONE-COMMAND PIPELINE from a tx/address/link: prepare -> map -> dig -> confirm (--no-confirm to stop after the dig)
  flounder run     --source <paths...> --target <name> [--corpus <paths...>]      sealed audit only: map -> dig on given source (--quick = one breadth pass)
  flounder map     --target <name> --source <paths...> [--corpus <paths...>]      enumerate the scope inventory only (writes audit_scopes.json)
  flounder audit   [<region> | --scope <id,...> | --verify <file>] --source ...   deep-audit a region, inventory scopes, or given claims
  flounder confirm <run-dir> --source <paths...>                                  open-world: reproduce a run's findings on the real target
  flounder history import-run --target <name> --run <dir>
  flounder server project list                                                   list tracked projects
  flounder server run list [--project <name>]                                    list run history globally or for one project
  flounder server finding list [--project <name>] [--status <s>] [--tracking <s>] list findings globally or for one project
  flounder server daemon list                                                    list registered execution daemons
  flounder server daemon-token mint [name] [--server <url>]                      create a daemon connection token
  flounder config  [list | get <key> | set <key> <value> | unset <key> | path] [--global|--local]   persisted CLI defaults (server, provider, model, thinking, out, posture)
  flounder daemon provider [list | check [provider] | login [provider]]          manage provider auth on this daemon machine
  flounder ui      [--port <n>] [--host <h>] [--out <dir>] [--workspace <dir>] [--concurrency <n>] [--no-daemon]   control-plane web dashboard + a co-located executor daemon (localhost)
  flounder daemon start --server <url> --token <token> [--out <dir>] [--workspace <dir>] [--concurrency <n>]   execution plane: claim + run queued jobs (may be a different machine)

CLI layout:
  Workflow verbs stay top-level. Control-plane resource operations live under
  "flounder server ...". Daemon-machine local operations live under "flounder daemon ...".
  In practice:
    flounder server project list        reads the project collection
    flounder server run list            reads global run history without colliding with "flounder run"
    flounder server finding list        reads the global finding index, optionally filtered by project
    flounder server daemon-token mint   creates a daemon connection token on the control-plane side
    flounder daemon start --server ... --token ...    runs the executor on the daemon machine
    flounder daemon provider ...   logs in/checks provider auth on the daemon machine

Control plane vs execution plane:
  flounder ui starts the CONTROL PLANE (the dashboard, REST API, SQLite store, and job queue) and,
  unless --no-daemon, a co-located DAEMON to execute jobs. The daemon is what actually runs the
  audit — so code and provider keys stay on the daemon's machine. Run "flounder daemon start" on another
  host (with a token minted by the server operator) to execute remotely; the server owns the DB
  and the daemon only reports progress back over HTTP.

  Provider auth is local to each daemon machine. Use "flounder daemon provider login openai-codex" for
  subscription/OAuth providers, or set the provider's API-key environment variables before
  running "flounder daemon start". Use "flounder daemon provider check <provider>" to verify the daemon host.

How CLI runs execute (the API is the single entry point):
  run / map / audit / confirm / prepare are thin clients of the control plane: the CLI builds a
  launch spec, POSTs it (so the run is tracked + visible in the UI exactly like a UI-launched one),
  and streams the daemon's live log back here. The endpoint resolves --server > FLOUNDER_SERVER >
  config 'server' > http://127.0.0.1:4500. If no control plane is reachable the CLI says so and
  asks you to start one (flounder ui) — it never auto-spawns a server you can't see, and there is
  no in-process path: the CLI does exactly what the UI does. Ctrl-C stops the run. (For an offline
  check with no server, run the regression harness 'npm run mock-audit', which calls the library
  directly.)

Sealed vs open world:
  run / map / audit are NETWORK-SEALED — the model finds and proves bugs blind, with no
  network access (provably no online lookup). confirm is the OPEN-WORLD counterpart: it
  freezes a prior run's findings, then WITH the network reproduces each against real
  ground truth (e.g. a mainnet fork), consolidates duplicates, checks novelty, and emits a
  submit/no-submit decision sheet. Found blind (run/map/audit), reproduced open (confirm).

The model drives its own investigation with read/write/edit/bash tools and durable
cross-run memory. The framework supplies capability and verification, not a checklist.

Shared options:
  --source <paths...>     code under audit; the model reads (not modifies) these. Point at a buildable root (or use --build-root) to enable execution confirmation.
  --corpus <paths...>     design/reference MATERIALS the model reads to derive what the code MUST enforce (specs, whitepapers, design notes, prior audits, incident briefs). Context, not answers — never the bug, its location, or mechanism.
  --build-root <path>     directory copied into the sandbox so it is buildable (e.g. a workspace root); defaults to --source
  --target <name>         run/artifact name and durable-memory key
  --config <file>         JSON config with project context, models, and paths
  --provider <name>       Flounder provider id (default openai-codex); codex-cli/claude-code are explicit local fallbacks
  --model <name>          set the audit model
  --thinking <level>      off|minimal|low|medium|high|xhigh
  --out <dir>             artifact output directory and local tracking store (default ~/.flounder)
  --history-dir <dir>     project history directory, default <out>/history
  --workspace <dir>       daemon project workspace root, default ~/.flounder/workspace
  --scope-note <text>     one-line authorized-scope hint for the agent
  --max-steps <n>         cap agent turns for a breadth pass / pinned audit (default: UNBOUNDED — the model stops when done)
  --no-prepare            skip the toolchain warm-up (deps fetch/build)
  --prepare-timeout-ms <n>  per-command timeout for the warm-up, default 600000
  --sandbox-backend <b>   auto|oci|host; default auto uses the OCI sandbox and refuses implicit host fallback
  --sandbox-image <img>   OCI image for sandboxed commands (default flounder-sandbox:latest; build with npm run sandbox:build)
  --allow-host-execution  trusted-local opt-in only: let auto fall back to host execution when no OCI sandbox is available
  --prepare-network <m>   none|enabled; dependency warm-up/build commands default to enabled
  --confirm-network <m>   none|enabled; open-world prepare/confirm bash commands default to enabled
  --sandbox-memory-mb <n> memory limit for OCI sandbox commands
  --sandbox-cpus <n>      CPU limit for OCI sandbox commands
  --no-refute / --no-appeal  skip the independent-refutation / one-appeal passes on confirmed findings
  --server <url>          control plane the CLI drives (default --server > FLOUNDER_SERVER > config 'server' > http://127.0.0.1:4500)
  --mock-llm              run with the deterministic mock model (no provider needed); the daemon executes it like any run

run / map / audit deep-phase options:
  --quick                 run only: a single breadth pass instead of map -> audit
  --map-steps <n>         cap the map phase (default: UNBOUNDED)
  --dig-steps <n>         cap each scope's dig (default: UNBOUNDED; the dig stops when its obligations are discharged)
  --dig-samples <n>       independent dig passes per scope, findings unioned (raises recall), default 1
  --dig-concurrency <n>   scopes deep-audited in parallel (isolated workspaces), default 1
  --max-scopes <n>        one-run cap for un-audited scopes; UI Standard defaults to auditing until 30 project scopes are done
  --remap                 re-enumerate scopes from scratch (default resumes the persisted inventory)

flounder audit selectors (choose one; default digs the existing inventory):
  <region>                deep-audit one pinned region, e.g. src/Foo.sol:120-180 (no map needed)
  --scope <id[,id...]>    deep-audit specific scope id(s) from the inventory (run flounder map first)
  --verify <file>         confirm-or-refute given suspected finding(s) by execution. <file> is JSON (one finding or an array; each: title, location, description, exploit_sketch?, fix_patch?). Writes a PoC, builds, runs it through the confirmation gate + differential, marking each confirmed-differential / confirmed-executable / REFUTED. Needs a buildable target.

flounder confirm: unbounded by default (ends when the model finishes); --max-steps caps it. Auto-resumes an
interrupted prior confirm of the same run dir (carries already-settled rows forward); --fresh ignores it.
`);
}

function printUiHelp(): void {
  console.log(`flounder ui — start the control-plane dashboard.

Usage:
  flounder ui [--port <n>] [--host <h>] [--out <dir>] [--workspace <dir>] [--concurrency <n>] [--no-daemon]

Options:
  --port              Dashboard/API port, default 4500
  --host              Bind host, default 127.0.0.1
  --out               Flounder product home/output dir, default ~/.flounder
  --workspace         Co-located daemon workspace, default ~/.flounder/workspace
  --concurrency       Co-located daemon jobs in parallel, default 2
  --no-daemon         Start only the control plane; connect executors with flounder daemon start

flounder ui starts the REST API, SQLite tracking store, dashboard, and by default a local
execution daemon. Target code and provider credentials stay on the daemon machine.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
