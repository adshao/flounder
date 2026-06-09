#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultConfig, type AuditorConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { runHunt } from "./agent/hunt.js";
import type { AuditItem, AuditResult, AuditorAgentDefinition } from "./types.js";
import { loadCorpus, loadSource } from "./ingest/source.js";
import { RunLogger } from "./trace/logger.js";
import { runAudit } from "./audit/runner.js";
import { aggregate } from "./audit/aggregate.js";
import { selectFindingsForFollowUp } from "./audit/impact.js";
import { createLlmClient } from "./llm/client.js";
import { MockAuditLlmClient } from "./llm/mock.js";
import { normalizeLensPacks, normalizeProjectContext } from "./lens/context.js";
import { resolveLastRunDir } from "./trace/last-run.js";
import { importRunToProjectHistory, projectHistoryManifestPath, resolveProjectHistoryLatestRunDir, updateProjectHistory } from "./trace/history.js";
import { reproduceTop } from "./reproduce/planner.js";
import { loadProjectLearningFromRun, loadSummaryFromRun, loadVerificationsFromRun } from "./trace/run-state.js";
import { renderDisclosure, reportArtifactName } from "./reports/disclosure.js";
import type { AuditSummary, Reproduction, Verification } from "./types.js";

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

  if (cmd === "run") {
    const { cfg, verifyTopK } = await parseConfig(rest);
    const resumeRunDir = await readResumeRunDir(rest, cfg);
    const result = await runPipeline(cfg, {
      verifyTopK,
      streamEvents: true,
      ...(resumeRunDir ? { resumeRunDir } : {}),
      ...(hasFlag(rest, "--mock-llm") ? { llm: new MockAuditLlmClient() } : {}),
    });
    printCoverage(result.runDir, result.summary.coverage);
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
    return;
  }

  if (cmd === "audit") {
    const { cfg } = await parseConfig(rest);
    const checklistPath = readFlag(rest, "--checklist");
    if (!checklistPath) throw new Error("--checklist is required");
    const checklist = JSON.parse(await readFile(checklistPath, "utf8")) as AuditItem[];
    const startedAt = new Date();
    const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, { streamEvents: true });
    await logger.init();
    const source = await loadSource(cfg.sourcePaths);
    const corpus = await loadCorpus(cfg.corpusPaths);
    const llm = cfg.dryRun ? undefined : hasFlag(rest, "--mock-llm") ? new MockAuditLlmClient(logger) : createLlmClient(cfg, logger);
    await logger.artifact("checklist.json", checklist);
    const results = await runAudit({ cfg, items: checklist, source, corpus, ...(llm ? { llm } : {}), logger });
    const summary = aggregate(results);
    await logger.artifact("summary.json", summary);
    await updateProjectHistory({
      cfg,
      runDir: logger.runDir,
      summary,
      items: checklist,
      results,
      completedRounds: roundsFromItems(checklist),
      startedAt: startedAt.toISOString(),
    });
    printCoverage(logger.runDir, summary.coverage);
    return;
  }

  if (cmd === "reproduce") {
    const { cfg, verifyTopK } = await parseConfig(rest);
    const runDir = readFlag(rest, "--run") ?? readFlag(rest, "--run-dir") ?? (hasFlag(rest, "--resume-last") ? await resolveLastRunDir(cfg.outputDir) : undefined);
    if (!runDir) throw new Error("--run <dir> is required");
    if (cfg.sourcePaths.length === 0) throw new Error("--source <paths...> or sourcePaths in --config is required for reproduction");
    if (cfg.reproductionMode === "off") cfg.reproductionMode = "plan";
    const summary = await loadSummaryFromRun(runDir);
    const verifications = await loadVerificationsFromRun(runDir);
    const projectLearning = await loadProjectLearningFromRun(runDir);
    const logger = new RunLogger(cfg.outputDir, cfg.targetName, new Date(), { runDir, streamEvents: true });
    await logger.init();
    const source = await loadSource(cfg.sourcePaths);
    const llm = cfg.dryRun ? undefined : hasFlag(rest, "--mock-llm") ? new MockAuditLlmClient(logger) : createLlmClient(cfg, logger);
    if (llm && "setLogger" in llm && typeof llm.setLogger === "function") {
      llm.setLogger(logger);
    }
    const reproductions = await reproduceTop({
      cfg,
      findings: summary.findings,
      verifications,
      source,
      ...(projectLearning ? { projectLearning } : {}),
      ...(llm ? { llm } : {}),
      logger,
      topK: verifyTopK,
    });
    applyReproductionStatuses(summary, reproductions);
    updateVerificationCoverage(summary);
    await logger.artifact("summary.json", summary);
    const verificationById = new Map(verifications.map((verification) => [verification.id, verification]));
    const reproductionByFindingId = new Map(reproductions.map((reproduction) => [reproduction.findingId, reproduction]));
    for (const finding of selectFindingsForFollowUp(summary.findings, verifyTopK, cfg)) {
      await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding, verificationById.get(finding.id), reproductionByFindingId.get(finding.id)));
    }
    const checklist = await readJsonFile<AuditItem[]>(`${runDir}/checklist.json`);
    const results = await readJsonFile<AuditResult[]>(`${runDir}/audit_results.json`);
    await updateProjectHistory({
      cfg,
      runDir,
      summary,
      items: checklist,
      results,
      completedRounds: roundsFromItems(checklist),
    });
    printCoverage(runDir, summary.coverage);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

async function parseConfig(args: string[]): Promise<{ cfg: AuditorConfig; verifyTopK: number }> {
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
  cfg.outputDir = readFlag(args, "--out") ?? cfg.outputDir;
  const historyDir = readFlag(args, "--history-dir");
  if (historyDir !== undefined) cfg.historyDir = historyDir;
  cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
  cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
  cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
  cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
  cfg.rounds = readIntFlag(args, "--rounds") ?? cfg.rounds;
  cfg.explorationStrategy = readStrategyFlag(args) ?? cfg.explorationStrategy;
  cfg.maxNewItemsPerRound = readIntFlag(args, "--max-new-items-per-round") ?? cfg.maxNewItemsPerRound;
  cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
  cfg.maxWorkers = readIntFlag(args, "--max-workers") ?? cfg.maxWorkers;
  cfg.highImpactMaxFindings = readIntFlag(args, "--high-impact-max-findings") ?? cfg.highImpactMaxFindings;
  if (args.includes("--no-high-impact-verification")) cfg.highImpactVerification = false;
  cfg.scopeMode = readScopeModeFlag(args) ?? cfg.scopeMode;
  const baselineExplorationShare = readNumberFlag(args, "--baseline-exploration-share");
  if (baselineExplorationShare !== undefined) cfg.baselineExplorationShare = Math.max(0, Math.min(0.8, baselineExplorationShare));
  const maxAuditItems = readIntFlag(args, "--max-items");
  if (maxAuditItems !== undefined) cfg.maxAuditItems = maxAuditItems;
  cfg.maxTokens = readIntFlag(args, "--max-tokens") ?? cfg.maxTokens;
  cfg.contextCharBudget = readIntFlag(args, "--context-chars") ?? cfg.contextCharBudget;
  cfg.contextRetrieval = readRetrievalFlag(args) ?? cfg.contextRetrieval;
  cfg.qmdCommand = readFlag(args, "--qmd-command") ?? cfg.qmdCommand;
  cfg.qmdLimit = readIntFlag(args, "--qmd-limit") ?? cfg.qmdLimit;
  cfg.qmdMinScore = readNumberFlag(args, "--qmd-min-score") ?? cfg.qmdMinScore;
  cfg.qmdTimeoutMs = readIntFlag(args, "--qmd-timeout-ms") ?? cfg.qmdTimeoutMs;
  const qmdCollections = readMultiFlag(args, "--qmd-collection");
  if (qmdCollections.length > 0) cfg.qmdCollections = qmdCollections;
  cfg.portfolioMaxItems = readIntFlag(args, "--portfolio-max-items") ?? cfg.portfolioMaxItems;
  cfg.reproductionMode = readReproductionModeFlag(args) ?? cfg.reproductionMode;
  cfg.reproductionMaxCommands = readIntFlag(args, "--repro-max-commands") ?? cfg.reproductionMaxCommands;
  cfg.reproductionCommandTimeoutMs = readIntFlag(args, "--repro-timeout-ms") ?? cfg.reproductionCommandTimeoutMs;
  cfg.reproductionMaxFileBytes = readIntFlag(args, "--repro-max-file-bytes") ?? cfg.reproductionMaxFileBytes;
  cfg.reproductionMaxLogBytes = readIntFlag(args, "--repro-max-log-bytes") ?? cfg.reproductionMaxLogBytes;
  cfg.huntMaxSteps = readIntFlag(args, "--max-steps") ?? cfg.huntMaxSteps;
  const scopeNote = readFlag(args, "--scope-note");
  if (scopeNote !== undefined) cfg.huntScopeNote = scopeNote;
  if (args.includes("--dry-run")) cfg.dryRun = true;
  if (args.includes("--no-project-learning")) cfg.projectLearning = false;
  if (args.includes("--no-dynamic-lenses")) cfg.dynamicLensDiscovery = false;
  if (args.includes("--no-portfolio-enumeration")) cfg.portfolioEnumeration = false;
  if (cfg.dryRun && !args.includes("--no-local-seeders")) cfg.localChecklistSeeders = true;
  if (args.includes("--local-seeders")) cfg.localChecklistSeeders = true;
  if (args.includes("--no-local-seeders")) cfg.localChecklistSeeders = false;
  const thinking = readFlag(args, "--thinking");
  if (thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  return { cfg, verifyTopK: readIntFlag(args, "--verify-top") ?? 3 };
}

function applyConfigOverrides(cfg: AuditorConfig, raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.targetName === "string") cfg.targetName = raw.targetName;
  if (Array.isArray(raw.sourcePaths) && raw.sourcePaths.every((value) => typeof value === "string")) cfg.sourcePaths = raw.sourcePaths;
  if (Array.isArray(raw.corpusPaths) && raw.corpusPaths.every((value) => typeof value === "string")) cfg.corpusPaths = raw.corpusPaths;
  if (typeof raw.outputDir === "string") cfg.outputDir = raw.outputDir;
  if (typeof raw.historyDir === "string") cfg.historyDir = raw.historyDir;
  if (typeof raw.history_dir === "string") cfg.historyDir = raw.history_dir;
  if (typeof raw.provider === "string") cfg.provider = raw.provider;
  if (typeof raw.enumModel === "string") cfg.enumModel = raw.enumModel;
  if (typeof raw.auditModel === "string") cfg.auditModel = raw.auditModel;
  if (typeof raw.verifyModel === "string") cfg.verifyModel = raw.verifyModel;
  if (typeof raw.model === "string") {
    cfg.enumModel = raw.model;
    cfg.auditModel = raw.model;
    cfg.verifyModel = raw.model;
  }
  if (typeof raw.trials === "number" && Number.isFinite(raw.trials)) cfg.trials = Math.max(1, Math.floor(raw.trials));
  if (typeof raw.rounds === "number" && Number.isFinite(raw.rounds)) cfg.rounds = Math.max(1, Math.floor(raw.rounds));
  const rawStrategy = raw.explorationStrategy ?? raw.exploration_strategy ?? raw.strategy;
  if (rawStrategy === "breadth" || rawStrategy === "depth" || rawStrategy === "hybrid") {
    cfg.explorationStrategy = rawStrategy;
  }
  const rawMaxNewItemsPerRound = raw.maxNewItemsPerRound ?? raw.max_new_items_per_round;
  if (typeof rawMaxNewItemsPerRound === "number" && Number.isFinite(rawMaxNewItemsPerRound)) {
    cfg.maxNewItemsPerRound = Math.max(1, Math.floor(rawMaxNewItemsPerRound));
  }
  if (typeof raw.maxWorkers === "number" && Number.isFinite(raw.maxWorkers)) cfg.maxWorkers = Math.max(1, Math.floor(raw.maxWorkers));
  const rawHighImpactVerification = raw.highImpactVerification ?? raw.high_impact_verification;
  if (typeof rawHighImpactVerification === "boolean") cfg.highImpactVerification = rawHighImpactVerification;
  const rawHighImpactMaxFindings = raw.highImpactMaxFindings ?? raw.high_impact_max_findings;
  if (typeof rawHighImpactMaxFindings === "number" && Number.isFinite(rawHighImpactMaxFindings)) {
    cfg.highImpactMaxFindings = Math.max(0, Math.floor(rawHighImpactMaxFindings));
  }
  const rawScopeMode = raw.scopeMode ?? raw.scope_mode;
  if (rawScopeMode === "augment" || rawScopeMode === "restrict") cfg.scopeMode = rawScopeMode;
  const rawBaselineExplorationShare = raw.baselineExplorationShare ?? raw.baseline_exploration_share;
  if (typeof rawBaselineExplorationShare === "number" && Number.isFinite(rawBaselineExplorationShare)) {
    cfg.baselineExplorationShare = Math.max(0, Math.min(0.8, rawBaselineExplorationShare));
  }
  const rawMaxAuditItems = raw.maxAuditItems ?? raw.max_audit_items;
  if (typeof rawMaxAuditItems === "number" && Number.isFinite(rawMaxAuditItems)) cfg.maxAuditItems = Math.max(1, Math.floor(rawMaxAuditItems));
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) cfg.maxTokens = Math.max(1000, Math.floor(raw.maxTokens));
  if (typeof raw.contextCharBudget === "number" && Number.isFinite(raw.contextCharBudget)) {
    cfg.contextCharBudget = Math.max(4000, Math.floor(raw.contextCharBudget));
  }
  const rawRetrieval = raw.contextRetrieval ?? raw.context_retrieval ?? raw.retrieval;
  if (rawRetrieval === "source-index" || rawRetrieval === "source-index+qmd") cfg.contextRetrieval = rawRetrieval;
  if (typeof raw.qmdCommand === "string") cfg.qmdCommand = raw.qmdCommand;
  if (typeof raw.qmdLimit === "number" && Number.isFinite(raw.qmdLimit)) cfg.qmdLimit = Math.max(1, Math.floor(raw.qmdLimit));
  if (typeof raw.qmdMinScore === "number" && Number.isFinite(raw.qmdMinScore)) cfg.qmdMinScore = Math.max(0, raw.qmdMinScore);
  const rawPortfolioMaxItems = raw.portfolioMaxItems ?? raw.portfolio_max_items;
  if (typeof rawPortfolioMaxItems === "number" && Number.isFinite(rawPortfolioMaxItems)) {
    cfg.portfolioMaxItems = Math.max(1, Math.floor(rawPortfolioMaxItems));
  }
  const rawPortfolioEnumeration = raw.portfolioEnumeration ?? raw.portfolio_enumeration;
  if (typeof rawPortfolioEnumeration === "boolean") cfg.portfolioEnumeration = rawPortfolioEnumeration;
  const rawReproductionMode = raw.reproductionMode ?? raw.reproduction_mode ?? raw.repro;
  if (rawReproductionMode === "off" || rawReproductionMode === "plan" || rawReproductionMode === "execute") {
    cfg.reproductionMode = rawReproductionMode;
  }
  const rawReproductionMaxCommands = raw.reproductionMaxCommands ?? raw.reproduction_max_commands;
  if (typeof rawReproductionMaxCommands === "number" && Number.isFinite(rawReproductionMaxCommands)) {
    cfg.reproductionMaxCommands = Math.max(1, Math.floor(rawReproductionMaxCommands));
  }
  const rawReproductionCommandTimeoutMs = raw.reproductionCommandTimeoutMs ?? raw.reproduction_command_timeout_ms;
  if (typeof rawReproductionCommandTimeoutMs === "number" && Number.isFinite(rawReproductionCommandTimeoutMs)) {
    cfg.reproductionCommandTimeoutMs = Math.max(1000, Math.floor(rawReproductionCommandTimeoutMs));
  }
  const rawReproductionMaxFileBytes = raw.reproductionMaxFileBytes ?? raw.reproduction_max_file_bytes;
  if (typeof rawReproductionMaxFileBytes === "number" && Number.isFinite(rawReproductionMaxFileBytes)) {
    cfg.reproductionMaxFileBytes = Math.max(1000, Math.floor(rawReproductionMaxFileBytes));
  }
  const rawReproductionMaxLogBytes = raw.reproductionMaxLogBytes ?? raw.reproduction_max_log_bytes;
  if (typeof rawReproductionMaxLogBytes === "number" && Number.isFinite(rawReproductionMaxLogBytes)) {
    cfg.reproductionMaxLogBytes = Math.max(1000, Math.floor(rawReproductionMaxLogBytes));
  }
  const rawHuntMaxSteps = raw.huntMaxSteps ?? raw.hunt_max_steps;
  if (typeof rawHuntMaxSteps === "number" && Number.isFinite(rawHuntMaxSteps)) cfg.huntMaxSteps = Math.max(1, Math.floor(rawHuntMaxSteps));
  const rawHuntScopeNote = raw.huntScopeNote ?? raw.hunt_scope_note;
  if (typeof rawHuntScopeNote === "string" && rawHuntScopeNote.trim().length > 0) cfg.huntScopeNote = rawHuntScopeNote.trim();
  const rawQmdTimeoutMs = raw.qmdTimeoutMs ?? raw.qmd_timeout_ms;
  if (typeof rawQmdTimeoutMs === "number" && Number.isFinite(rawQmdTimeoutMs)) cfg.qmdTimeoutMs = Math.max(1000, Math.floor(rawQmdTimeoutMs));
  const rawQmdCollections = raw.qmdCollections ?? raw.qmd_collections ?? raw.qmdCollection ?? raw.qmd_collection;
  if (Array.isArray(rawQmdCollections) && rawQmdCollections.every((value) => typeof value === "string")) {
    cfg.qmdCollections = rawQmdCollections.filter((value) => value.trim().length > 0);
  } else if (typeof rawQmdCollections === "string" && rawQmdCollections.trim().length > 0) {
    cfg.qmdCollections = [rawQmdCollections.trim()];
  }
  if (raw.thinkingLevel === "minimal" || raw.thinkingLevel === "low" || raw.thinkingLevel === "medium" || raw.thinkingLevel === "high" || raw.thinkingLevel === "xhigh") {
    cfg.thinkingLevel = raw.thinkingLevel;
  }
  if (Array.isArray(raw.failureModes) && raw.failureModes.every((value) => typeof value === "string")) {
    cfg.failureModes = raw.failureModes as AuditorConfig["failureModes"];
  }
  if (Array.isArray(raw.auditorAgents)) {
    cfg.auditorAgents = cleanAuditorAgents(raw.auditorAgents);
  }
  if ("lensPacks" in raw || "lens_packs" in raw) cfg.lensPacks = normalizeLensPacks(raw.lensPacks ?? raw.lens_packs);
  if ("projectContext" in raw || "project_context" in raw) {
    cfg.projectContext = normalizeProjectContext(raw.projectContext ?? raw.project_context) ?? cfg.projectContext;
  }
  if (typeof raw.projectLearning === "boolean") cfg.projectLearning = raw.projectLearning;
  if (typeof raw.dynamicLensDiscovery === "boolean") cfg.dynamicLensDiscovery = raw.dynamicLensDiscovery;
  if (typeof raw.localChecklistSeeders === "boolean") cfg.localChecklistSeeders = raw.localChecklistSeeders;
  if (typeof raw.dryRun === "boolean") cfg.dryRun = raw.dryRun;
}

function cleanAuditorAgents(value: unknown[]): AuditorAgentDefinition[] {
  const packs = normalizeLensPacks([{ id: "config-agents", auditorAgents: value }]);
  return packs[0]?.auditorAgents ?? [];
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

function readNumberFlag(args: string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStrategyFlag(args: string[]): AuditorConfig["explorationStrategy"] | undefined {
  const value = readFlag(args, "--strategy") ?? readFlag(args, "--exploration-strategy");
  return value === "breadth" || value === "depth" || value === "hybrid" ? value : undefined;
}

function readRetrievalFlag(args: string[]): AuditorConfig["contextRetrieval"] | undefined {
  const value = readFlag(args, "--retrieval") ?? readFlag(args, "--context-retrieval");
  return value === "source-index" || value === "source-index+qmd" ? value : undefined;
}

function readScopeModeFlag(args: string[]): AuditorConfig["scopeMode"] | undefined {
  const value = readFlag(args, "--scope-mode");
  return value === "augment" || value === "restrict" ? value : undefined;
}

function readReproductionModeFlag(args: string[]): AuditorConfig["reproductionMode"] | undefined {
  const value = readFlag(args, "--repro") ?? readFlag(args, "--reproduction");
  return value === "off" || value === "plan" || value === "execute" ? value : undefined;
}

async function readResumeRunDir(args: string[], cfg: AuditorConfig): Promise<string | undefined> {
  const continueProject = readFlag(args, "--continue-project");
  if (hasFlag(args, "--continue-project") && !continueProject) throw new Error("--continue-project <target> is required");
  if (continueProject) {
    if (hasFlag(args, "--resume-last") || readFlag(args, "--resume-run")) {
      throw new Error("--continue-project cannot be combined with --resume-last or --resume-run");
    }
    cfg.targetName = continueProject;
    return resolveProjectHistoryLatestRunDir(projectHistoryLocation(cfg));
  }
  if (hasFlag(args, "--resume-last")) return resolveLastRunDir(cfg.outputDir);
  const resumeRun = readFlag(args, "--resume-run");
  if (resumeRun === "last") return resolveLastRunDir(cfg.outputDir);
  return resumeRun;
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

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function roundsFromItems(items: AuditItem[]): number {
  return Math.max(1, ...items.map((item) => (typeof item.round === "number" && Number.isFinite(item.round) ? item.round : 1)));
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
  fsa run --target <name> --source <paths...> [--corpus <paths...>] [--dry-run]
  fsa audit --checklist <file> --source <paths...>
  fsa reproduce --run <dir> --source <paths...> [--repro plan|execute]
  fsa history import-run --target <name> --run <dir> [--history-dir <dir>]

hunt is the thin agentic mode: the model drives its own investigation with
read/search/run_test tools and durable cross-run memory. The framework supplies
capability and verification, not a checklist. run is the staged pipeline.

Options:
  --config <file>         JSON config with projectContext, lensPacks, agents, models, paths
  --provider <name>       pi-ai provider, codex-cli, or claude-code; default openai
  --model <name>          set enum/audit/verify model
  --enum-model <name>     model for checklist enumeration
  --audit-model <name>    model for audit trials
  --verify-model <name>   model for verification planning
  --rounds <n>            project exploration rounds, default 1
                          with --resume-run, append n additional rounds
  --strategy <name>       breadth|depth|hybrid, default hybrid
  --history-dir <dir>     project history directory, default <out>/history
  --continue-project <target>
                          append rounds to the latest run saved in that project's history
  --resume-run <dir>      continue from an existing run directory
  --resume-run last       continue from the last run under --out
  --resume-last           shorthand for --resume-run last
  --max-new-items-per-round <n>
                          cap new deepening items per round, default 16
  --trials <n>            independent trials per item, default 4
  --scope-mode <name>     augment|restrict, default augment
                          augment treats configured lenses as guidance, not a boundary
  --baseline-exploration-share <n>
                          in augment mode, reserve this first-round share for lens-free broad enumeration
  --max-items <n>         cap total audit items across rounds for cost-controlled runs
  --thinking <level>      minimal|low|medium|high|xhigh
  --context-chars <n>     character budget per audit item context
  --retrieval <name>      source-index|source-index+qmd, default source-index
  --qmd-command <cmd>     QMD CLI command when QMD retrieval is enabled, default qmd
  --qmd-limit <n>         max QMD hits per item, default 6
  --qmd-min-score <n>     minimum QMD hit score, default 0.25
  --qmd-timeout-ms <n>    QMD query timeout, default 60000
  --qmd-collection <names...>
                          limit QMD retrieval to one or more collections
  --verify-top <n>        top ranked findings for verification and reproduction, default 3
                          high-impact findings are added beyond this cap by default
  --high-impact-max-findings <n>
                          additional high-impact findings to force through follow-up, default 24
  --no-high-impact-verification
                          disable high-impact follow-up expansion
  --dry-run               no model calls; local checklist seeders only
  --no-project-learning   disable model initialization learning notes
  --no-dynamic-lenses     disable model-generated project lens packs
  --local-seeders         add deterministic local checklist seeders
  --no-local-seeders      require checklist items to come from model enumeration
  --repro <mode>          off|plan|execute, default off for run; reproduce defaults to plan
  --repro-max-commands <n>
                          cap local reproduction commands per finding, default 3
  --repro-timeout-ms <n>  timeout per local reproduction command, default 120000
  --max-steps <n>         hunt: max agent actions before stopping, default 40
  --scope-note <text>     hunt: one-line authorized-scope hint for the agent
  --mock-llm              run with the deterministic mock model
`);
}

function applyReproductionStatuses(summary: AuditSummary, reproductions: Reproduction[]): void {
  const byFindingId = new Map(reproductions.map((reproduction) => [reproduction.findingId, reproduction]));
  for (const finding of summary.findings) {
    const reproduction = byFindingId.get(finding.id);
    if (!reproduction) continue;
    finding.reproductionStatus = reproduction.status;
    if (reproduction.confirmationStatus === "confirmed-executable") {
      finding.confirmationStatus = "confirmed-executable";
    }
  }
}

function updateVerificationCoverage(summary: AuditSummary): void {
  const verified = summary.findings.filter(
    (finding) => finding.confirmationStatus === "confirmed-source" || finding.confirmationStatus === "confirmed-executable" || finding.verificationVerdict === "false-positive",
  ).length;
  summary.coverage.verifiedFindings = verified;
  summary.coverage.unverifiedFindings = Math.max(0, summary.findings.length - verified);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
