#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultConfig, normalizeProjectContext, normalizeRoleModels, type AuditorConfig } from "./config.js";
import { runHunt } from "./agent/hunt.js";
import { MockAuditLlmClient } from "./llm/mock.js";
import { importRunToProjectHistory, projectHistoryManifestPath } from "./trace/history.js";

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

  if (cmd === "hunt") {
    const { cfg } = await parseConfig(rest);
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> is required for hunt");
    if (cfg.dryRun) throw new Error("hunt is an agentic mode and cannot run in --dry-run; use the mock model with --mock-llm for offline checks");
    const result = await runHunt(cfg, {
      streamEvents: true,
      ...(hasFlag(rest, "--mock-llm") ? { llm: new MockAuditLlmClient() } : {}),
    });
    printCoverage(result.runDir, result.summary.coverage);
    if (result.scopeCoverage) {
      const { total, audited, pending } = result.scopeCoverage;
      console.log(`[scopes] audited ${audited}/${total}` + (pending > 0 ? `, ${pending} pending — run the same command again to audit the next batch (or --remap to re-enumerate).` : " — inventory fully audited."));
    }
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

async function parseConfig(args: string[]): Promise<{ cfg: AuditorConfig }> {
  const cfg = defaultConfig();
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
  cfg.huntMaxSteps = readIntFlag(args, "--max-steps") ?? cfg.huntMaxSteps;
  const scopeNote = readFlag(args, "--scope-note");
  if (scopeNote !== undefined) cfg.huntScopeNote = scopeNote;
  if (args.includes("--no-prepare")) cfg.huntPrepare = false;
  cfg.huntPrepareTimeoutMs = readIntFlag(args, "--prepare-timeout-ms") ?? cfg.huntPrepareTimeoutMs;
  if (args.includes("--no-refute")) cfg.huntRefute = false;
  if (args.includes("--deep")) cfg.huntDeep = true;
  cfg.huntMaxScopes = readIntFlag(args, "--max-scopes") ?? cfg.huntMaxScopes;
  cfg.huntMapSteps = readIntFlag(args, "--map-steps") ?? cfg.huntMapSteps;
  cfg.huntDigSteps = readIntFlag(args, "--dig-steps") ?? cfg.huntDigSteps;
  cfg.huntDigSamples = readIntFlag(args, "--dig-samples") ?? cfg.huntDigSamples;
  cfg.huntDigConcurrency = readIntFlag(args, "--dig-concurrency") ?? cfg.huntDigConcurrency;
  if (args.includes("--remap")) cfg.huntRemap = true;
  const scopeSel = readFlag(args, "--scope");
  if (scopeSel) {
    const ids = scopeSel.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length > 0) {
      cfg.huntScopeIds = ids;
      cfg.huntDeep = true; // picking a scope is a deep (map → dig) operation
    }
  }
  const deepFocus = readFlag(args, "--deep-focus");
  if (deepFocus !== undefined) {
    cfg.huntDeep = true;
    cfg.huntDeepFocus = deepFocus;
  }
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
  const rawHuntMaxSteps = raw.huntMaxSteps ?? raw.hunt_max_steps;
  if (typeof rawHuntMaxSteps === "number" && Number.isFinite(rawHuntMaxSteps)) cfg.huntMaxSteps = Math.max(1, Math.floor(rawHuntMaxSteps));
  const rawHuntScopeNote = raw.huntScopeNote ?? raw.hunt_scope_note;
  if (typeof rawHuntScopeNote === "string" && rawHuntScopeNote.trim().length > 0) cfg.huntScopeNote = rawHuntScopeNote.trim();
  const rawHuntPrepare = raw.huntPrepare ?? raw.hunt_prepare;
  if (typeof rawHuntPrepare === "boolean") cfg.huntPrepare = rawHuntPrepare;
  const rawHuntPrepareTimeoutMs = raw.huntPrepareTimeoutMs ?? raw.hunt_prepare_timeout_ms;
  if (typeof rawHuntPrepareTimeoutMs === "number" && Number.isFinite(rawHuntPrepareTimeoutMs)) cfg.huntPrepareTimeoutMs = Math.max(10_000, Math.floor(rawHuntPrepareTimeoutMs));
  const rawHuntRefute = raw.huntRefute ?? raw.hunt_refute;
  if (typeof rawHuntRefute === "boolean") cfg.huntRefute = rawHuntRefute;
  const rawHuntDeep = raw.huntDeep ?? raw.hunt_deep;
  if (typeof rawHuntDeep === "boolean") cfg.huntDeep = rawHuntDeep;
  const rawHuntDeepFocus = raw.huntDeepFocus ?? raw.hunt_deep_focus;
  if (typeof rawHuntDeepFocus === "string" && rawHuntDeepFocus.trim().length > 0) {
    cfg.huntDeep = true;
    cfg.huntDeepFocus = rawHuntDeepFocus.trim();
  }
  const rawMaxScopes = raw.huntMaxScopes ?? raw.hunt_max_scopes;
  if (typeof rawMaxScopes === "number" && Number.isFinite(rawMaxScopes)) cfg.huntMaxScopes = Math.max(1, Math.floor(rawMaxScopes));
  const rawMapSteps = raw.huntMapSteps ?? raw.hunt_map_steps;
  if (typeof rawMapSteps === "number" && Number.isFinite(rawMapSteps)) cfg.huntMapSteps = Math.max(1, Math.floor(rawMapSteps));
  const rawDigSteps = raw.huntDigSteps ?? raw.hunt_dig_steps;
  if (typeof rawDigSteps === "number" && Number.isFinite(rawDigSteps)) cfg.huntDigSteps = Math.max(1, Math.floor(rawDigSteps));
  const rawDigSamples = raw.huntDigSamples ?? raw.hunt_dig_samples;
  if (typeof rawDigSamples === "number" && Number.isFinite(rawDigSamples)) cfg.huntDigSamples = Math.max(1, Math.floor(rawDigSamples));
  const rawDigConcurrency = raw.huntDigConcurrency ?? raw.hunt_dig_concurrency;
  if (typeof rawDigConcurrency === "number" && Number.isFinite(rawDigConcurrency)) cfg.huntDigConcurrency = Math.max(1, Math.floor(rawDigConcurrency));
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

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
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

function printCoverage(runDir: string, coverage: { itemsTotal: number; itemsWithFinding: number; bySeverity: Record<string, number>; itemsNeedingRetry?: number; needsMoreContextTrials?: number; unverifiedFindings?: number }): void {
  console.log(`[run dir] ${runDir}`);
  console.log(`[coverage] findings=${coverage.itemsWithFinding}/${coverage.itemsTotal} by_severity=${JSON.stringify(coverage.bySeverity)}`);
  if ((coverage.itemsNeedingRetry ?? 0) > 0 || (coverage.needsMoreContextTrials ?? 0) > 0 || (coverage.unverifiedFindings ?? 0) > 0) {
    console.log(`[quality] retry_items=${coverage.itemsNeedingRetry ?? 0} needs_more_context_trials=${coverage.needsMoreContextTrials ?? 0} unverified_findings=${coverage.unverifiedFindings ?? 0}`);
  }
}

async function runHistoryCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "import-run") {
    throw new Error("Unknown history command. Use: fsa history import-run --target <name> --run <dir>");
  }
  const { cfg } = await parseConfig(rest);
  const runDir = readFlag(rest, "--run") ?? readFlag(rest, "--run-dir");
  if (!runDir) throw new Error("--run <dir> is required");
  const manifest = await importRunToProjectHistory({ ...projectHistoryLocation(cfg), runDir });
  const manifestPath = projectHistoryManifestPath(projectHistoryLocation(cfg));
  console.log(`[history] manifest=${manifestPath}`);
  console.log(`[history] runs=${manifest.aggregate.totalRuns} materials=${manifest.aggregate.materialsTotal} findings=${manifest.aggregate.findingsTotal}`);
}

function projectHistoryLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function printHelp(): void {
  console.log(`full-stack-auditor

Usage:
  fsa hunt --target <name> --source <paths...> [--corpus <paths...>] [--max-steps <n>]
  fsa history import-run --target <name> --run <dir> [--history-dir <dir>]

hunt is the thin agentic mode: the model drives its own investigation with
pi-style read/write/edit/bash tools and durable cross-run memory. The framework
supplies capability and verification, not a checklist.

Options:
  --config <file>         JSON config with project context, models, and paths
  --provider <name>       pi-ai provider (default openai-codex); codex-cli/claude-code are CLI fallbacks
  --model <name>          set the hunt model
  --history-dir <dir>     project history directory, default <out>/history
  --thinking <level>      minimal|low|medium|high|xhigh
  --max-steps <n>         hunt: max agent turns/actions before stopping, default 40
  --scope-note <text>     hunt: one-line authorized-scope hint for the agent
  --no-prepare            hunt: skip the toolchain warm-up (deps fetch/build)
  --prepare-timeout-ms <n>
                          hunt: per-command timeout for the warm-up, default 600000
  --build-root <path>     hunt: directory copied into the sandbox so it is buildable (e.g. a workspace root); defaults to --source
  --no-refute             hunt: skip the independent-refutation pass on confirmed findings
  --deep                  hunt: map → dig flow (map enumerates scopes, dig deep-audits the top ones)
  --deep-focus <path>     hunt: skip map and deep-audit one pinned region (implies --deep)
  --max-scopes <n>        hunt: how many un-audited scopes the dig phase audits per run, default 6
  --map-steps <n>         hunt: action budget for the map phase, default 20
  --dig-steps <n>         hunt: per-scope action budget for the dig phase, default 30
  --dig-samples <n>       hunt: independent dig passes per scope, findings unioned (raises recall), default 1
  --dig-concurrency <n>   hunt: how many scopes to deep-audit in parallel (isolated workspaces), default 1
  --remap                 hunt: re-enumerate scopes from scratch (default resumes the persisted inventory)
  --scope <id[,id...]>    hunt: deep-audit specific scope id(s) from the inventory (implies --deep; run --deep once first to enumerate)
  --mock-llm              run with the deterministic mock model
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
