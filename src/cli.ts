#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultConfig, normalizeProjectContext, normalizeRoleModels, type AuditorConfig } from "./config.js";
import { CLI_CONFIG_KEYS, configFilePath, getCliConfigValue, isCliConfigKey, loadCliConfig, setCliConfigValue, unsetCliConfigValue, type CliConfigKey } from "./config-file.js";
import { launchViaApi, ran, resolveServer } from "./cli-client.js";
import type { LaunchSpec } from "./server/run-manager.js";
import { importRunToProjectHistory, projectHistoryManifestPath } from "./trace/history.js";
import { MetadataStore } from "./db/store.js";
import { startUiServer } from "./server/app.js";
import { runDaemon } from "./server/daemon.js";

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

  if (cmd === "db") {
    runDbCommand(rest);
    return;
  }

  if (cmd === "config") {
    runConfigCommand(rest);
    return;
  }

  if (cmd === "ui") {
    // Control-plane web app: track/drive audits across projects. Keeps running (the server
    // holds the event loop open) until interrupted. Runs execute on a DAEMON, not here — so
    // by default we also spawn a co-located local daemon (mint a token + `flounder daemon`). Pass
    // --no-daemon to run the control plane alone and connect your own daemon(s) elsewhere.
    const port = readIntFlag(rest, "--port") ?? 4500;
    const host = readFlag(rest, "--host") ?? "127.0.0.1";
    const out = resolveOut(rest);
    const workspace = readFlag(rest, "--workspace") ?? "./workspace"; // where the co-located daemon finds project dirs
    const server = startUiServer({ out, port, host });
    if (rest.includes("--no-daemon")) {
      console.log("[flounder ui] --no-daemon: no executor started. Connect one with `flounder daemon --server <url> --token <token>`.");
    } else {
      const concurrency = readIntFlag(rest, "--concurrency");
      server.on("listening", () => spawnLocalDaemon({ out, url: `http://${host}:${port}`, workspace, ...(concurrency !== undefined ? { concurrency } : {}) }));
    }
    await new Promise(() => {}); // run until the process is interrupted
    return;
  }

  if (cmd === "daemon") {
    // Execution plane: connect to a control-plane server, claim queued jobs, and run them
    // LOCALLY (code + provider keys stay here). May run on a different machine than the
    // server. Reports progress back over HTTP; never touches the server's DB directly.
    const server = readFlag(rest, "--server");
    const token = readFlag(rest, "--token");
    if (!server || !token) throw new Error("flounder daemon needs --server <url> and --token <token> (mint one with `flounder ui`, or via the store)");
    const out = resolveOut(rest);
    const name = readFlag(rest, "--name");
    const workspace = readFlag(rest, "--workspace");
    const concurrency = readIntFlag(rest, "--concurrency");
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
    const spec: LaunchSpec = { verb: "prepare", target: cfg.targetName, sourcePaths: [], provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, clue, posture, matchDeployed, out: cfg.outputDir };
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
    const spec: LaunchSpec = { verb: "confirm", target: cfg.targetName, sourcePaths: cfg.sourcePaths, corpusPaths: cfg.corpusPaths, provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, inputRunDir, out: cfg.outputDir };
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
  if (thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
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
  if (raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  const rawModels = normalizeRoleModels(raw.models);
  if (rawModels) cfg.models = rawModels;
  if ("projectContext" in raw || "project_context" in raw) {
    cfg.projectContext = normalizeProjectContext(raw.projectContext ?? raw.project_context) ?? cfg.projectContext;
  }
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
}

// Spawn a co-located daemon for `flounder ui`: mint a fresh bearer token in the shared store,
// then run `flounder daemon` as a child pointed at the just-started server. The child dies with
// the parent. (A remote daemon is started the same way, by hand, on another machine.)
function spawnLocalDaemon(opts: { out: string; url: string; workspace?: string; concurrency?: number }): void {
  const store = MetadataStore.openForOutput(opts.out);
  const { token } = store.createDaemonToken(`local-${process.pid}`);
  store.close();
  const args = [fileURLToPath(import.meta.url), "daemon", "--server", opts.url, "--token", token, "--out", opts.out];
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.concurrency !== undefined) args.push("--concurrency", String(opts.concurrency));
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
  process.on("SIGINT", () => {
    kill();
    process.exit(0);
  });
}

/** Resolve --out: flag > persisted config `out` > "runs". Keeps the tracking-store location
 * consistent across the CLI, the control plane, and the daemon when set once via config. */
function resolveOut(args: string[]): string {
  return readFlag(args, "--out") ?? loadCliConfig().values.out ?? "runs";
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
  };
  if (cfg.buildRoot) spec.buildRoot = cfg.buildRoot;
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

/** A short, filesystem/UI-safe slug from a prepare clue (tx / address / url), for the project name. */
function slugifyClue(clue: string): string {
  const slug = clue.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return slug || "target";
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
  const prepSpec: LaunchSpec = { verb: "prepare", target, sourcePaths: [], provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, clue, posture, matchDeployed, out: cfg.outputDir };
  if (endpoint !== undefined) prepSpec.endpoint = endpoint;
  const prep = await launchViaApi(server, prepSpec);
  if (!ran(prep)) { console.error("[pipeline] prepare did not finish — stopping."); process.exitCode = 1; return; }
  const staged = `${String(prep!.run_dir)}/prepare/workspace`;

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
    const confSpec: LaunchSpec = { verb: "confirm", target, sourcePaths: [staged], inputRunDir: String(audit!.run_dir), provider: cfg.provider, model: cfg.auditModel, thinking: cfg.thinkingLevel, out: cfg.outputDir };
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

// Read view over the SQLite tracking store (the UI's future backend; usable from the CLI
// today). `flounder db projects` | `runs [<target>]` | `findings <target>`.
function runDbCommand(args: string[]): void {
  const [subcommand = "projects", ...rest] = args;
  const out = resolveOut(args);
  const positional = rest.find((token) => !token.startsWith("--"));
  const target = readFlag(args, "--target") ?? positional;
  const db = MetadataStore.openForOutput(out);
  try {
    if (subcommand === "projects") {
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
    if (subcommand === "daemons") {
      const daemons = db.listDaemons();
      if (daemons.length === 0) {
        console.log("(no daemons registered — mint a token with `flounder db mint-token [name]`, then run `flounder daemon`)");
        return;
      }
      for (const d of daemons) console.log(`• [${d.id}] ${d.name}  last_seen=${d.last_seen_at ?? "never"}`);
      return;
    }
    if (subcommand === "mint-token") {
      // Mint a bearer token for a (remote) daemon. Must run on the SERVER machine — the
      // server owns this DB; the daemon authenticates with the printed token over HTTP.
      const name = readFlag(args, "--name") ?? positional ?? "daemon";
      const { id, token } = db.createDaemonToken(name);
      console.log(`[daemon ${id}] ${name}`);
      console.log(`token: ${token}`);
      console.log(`run on the executor machine:\n  flounder daemon --server http://<this-server-host>:4500 --token ${token}`);
      return;
    }
    const projectId = resolveProjectId(db, target);
    if (subcommand === "runs") {
      for (const run of db.listRuns(projectId)) {
        console.log(`${run.started_at}  ${run.kind} [${run.status}]  scopes ${run.scopes_audited ?? "-"}/${run.scopes_total ?? "-"}  findings ${run.findings_total ?? "-"}  ${run.run_dir ?? ""}`);
      }
      return;
    }
    if (subcommand === "findings") {
      for (const finding of db.listFindings(projectId)) {
        const timeline = db.findingTimeline(Number(finding.id)).map((event) => event.to_status).join(" → ");
        console.log(`[${finding.status}] ${finding.title} (${finding.location ?? "?"})  ${timeline}`);
      }
      return;
    }
    throw new Error(`Unknown db command "${subcommand}". Use: flounder db projects | runs [--target <name>] | findings --target <name> | daemons | mint-token [name]`);
  } finally {
    db.close();
  }
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
  flounder db      [projects | runs [<target>] | findings <target> | daemons | mint-token [name]]   read the tracking store; mint/list daemon tokens
  flounder config  [list | get <key> | set <key> <value> | unset <key> | path] [--global|--local]   persisted CLI defaults (server, provider, model, thinking, out, posture)
  flounder ui      [--port <n>] [--host <h>] [--out <dir>] [--no-daemon]           control-plane web dashboard + a co-located executor daemon (localhost)
  flounder daemon  --server <url> --token <token> [--out <dir>] [--concurrency <n>]   execution plane: claim + run queued jobs (may be a different machine)

Control plane vs execution plane:
  flounder ui starts the CONTROL PLANE (the dashboard, REST API, SQLite store, and job queue) and,
  unless --no-daemon, a co-located DAEMON to execute jobs. The daemon is what actually runs the
  audit — so code and provider keys stay on the daemon's machine. Run "flounder daemon" on another
  host (with a token minted by the server operator) to execute remotely; the server owns the DB
  and the daemon only reports progress back over HTTP.

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
  --provider <name>       pi-ai provider (default openai-codex); codex-cli/claude-code are CLI fallbacks
  --model <name>          set the audit model
  --thinking <level>      minimal|low|medium|high|xhigh
  --out <dir>             artifact output directory (default runs)
  --history-dir <dir>     project history directory, default <out>/history
  --scope-note <text>     one-line authorized-scope hint for the agent
  --max-steps <n>         cap agent turns for a breadth pass / pinned audit (default: UNBOUNDED — the model stops when done)
  --no-prepare            skip the toolchain warm-up (deps fetch/build)
  --prepare-timeout-ms <n>  per-command timeout for the warm-up, default 600000
  --no-refute / --no-appeal  skip the independent-refutation / one-appeal passes on confirmed findings
  --server <url>          control plane the CLI drives (default --server > FLOUNDER_SERVER > config 'server' > http://127.0.0.1:4500)
  --mock-llm              run with the deterministic mock model (no provider needed); the daemon executes it like any run

run / map / audit deep-phase options:
  --quick                 run only: a single breadth pass instead of map -> audit
  --map-steps <n>         cap the map phase (default: UNBOUNDED)
  --dig-steps <n>         cap each scope's dig (default: UNBOUNDED; the dig stops when its obligations are discharged)
  --dig-samples <n>       independent dig passes per scope, findings unioned (raises recall), default 1
  --dig-concurrency <n>   scopes deep-audited in parallel (isolated workspaces), default 1
  --max-scopes <n>        un-audited scopes the dig audits per run, default 10
  --remap                 re-enumerate scopes from scratch (default resumes the persisted inventory)

flounder audit selectors (choose one; default digs the existing inventory):
  <region>                deep-audit one pinned region, e.g. src/Foo.sol:120-180 (no map needed)
  --scope <id[,id...]>    deep-audit specific scope id(s) from the inventory (run flounder map first)
  --verify <file>         confirm-or-refute given suspected finding(s) by execution. <file> is JSON (one finding or an array; each: title, location, description, exploit_sketch?, fix_patch?). Writes a PoC, builds, runs it through the confirmation gate + differential, marking each confirmed-differential / confirmed-executable / REFUTED. Needs a buildable target.

flounder confirm: unbounded by default (ends when the model finishes); --max-steps caps it. Auto-resumes an
interrupted prior confirm of the same run dir (carries already-settled rows forward); --fresh ignores it.
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
