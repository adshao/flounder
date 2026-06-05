#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defaultConfig, type AuditorConfig } from "./config.js";
import { runPipeline } from "./pipeline.js";
import type { AuditItem } from "./types.js";
import { loadSource } from "./ingest/source.js";
import { RunLogger } from "./trace/logger.js";
import { runAudit } from "./audit/runner.js";
import { aggregate } from "./audit/aggregate.js";
import { PiAiClient } from "./llm/pi-ai.js";
import { MockAuditLlmClient } from "./llm/mock.js";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "run") {
    const { cfg, verifyTopK } = parseConfig(rest);
    const result = await runPipeline(cfg, { verifyTopK, ...(hasFlag(rest, "--mock-llm") ? { llm: new MockAuditLlmClient() } : {}) });
    printCoverage(result.runDir, result.summary.coverage);
    return;
  }

  if (cmd === "audit") {
    const { cfg } = parseConfig(rest);
    const checklistPath = readFlag(rest, "--checklist");
    if (!checklistPath) throw new Error("--checklist is required");
    const checklist = JSON.parse(await readFile(checklistPath, "utf8")) as AuditItem[];
    const logger = new RunLogger(cfg.outputDir, cfg.targetName);
    await logger.init();
    const source = await loadSource(cfg.sourcePaths);
    const llm = cfg.dryRun ? undefined : hasFlag(rest, "--mock-llm") ? new MockAuditLlmClient(logger) : new PiAiClient(cfg.provider, logger);
    const results = await runAudit({ cfg, items: checklist, source, ...(llm ? { llm } : {}), logger });
    const summary = aggregate(results);
    await logger.artifact("summary.json", summary);
    printCoverage(logger.runDir, summary.coverage);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

function parseConfig(args: string[]): { cfg: AuditorConfig; verifyTopK: number } {
  const cfg = defaultConfig();
  cfg.targetName = readFlag(args, "--target") ?? cfg.targetName;
  cfg.sourcePaths = readMultiFlag(args, "--source");
  cfg.corpusPaths = readMultiFlag(args, "--corpus");
  cfg.outputDir = readFlag(args, "--out") ?? cfg.outputDir;
  cfg.provider = readFlag(args, "--provider") ?? cfg.provider;
  cfg.enumModel = readFlag(args, "--enum-model") ?? readFlag(args, "--model") ?? cfg.enumModel;
  cfg.auditModel = readFlag(args, "--audit-model") ?? readFlag(args, "--model") ?? cfg.auditModel;
  cfg.verifyModel = readFlag(args, "--verify-model") ?? readFlag(args, "--model") ?? cfg.verifyModel;
  cfg.trials = readIntFlag(args, "--trials") ?? cfg.trials;
  cfg.maxWorkers = readIntFlag(args, "--max-workers") ?? cfg.maxWorkers;
  cfg.maxTokens = readIntFlag(args, "--max-tokens") ?? cfg.maxTokens;
  cfg.contextCharBudget = readIntFlag(args, "--context-chars") ?? cfg.contextCharBudget;
  cfg.dryRun = args.includes("--dry-run");
  const thinking = readFlag(args, "--thinking");
  if (thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  return { cfg, verifyTopK: readIntFlag(args, "--verify-top") ?? 3 };
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
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

function printCoverage(runDir: string, coverage: { itemsTotal: number; itemsWithFinding: number; bySeverity: Record<string, number> }): void {
  console.log(`[run dir] ${runDir}`);
  console.log(`[coverage] findings=${coverage.itemsWithFinding}/${coverage.itemsTotal} by_severity=${JSON.stringify(coverage.bySeverity)}`);
}

function printHelp(): void {
  console.log(`full-stack-auditor

Usage:
  fsa run --target <name> --source <paths...> [--corpus <paths...>] [--dry-run]
  fsa audit --checklist <file> --source <paths...>

Options:
  --provider <name>       pi-ai provider, default anthropic
  --model <name>          set enum/audit/verify model
  --enum-model <name>     model for checklist enumeration
  --audit-model <name>    model for audit trials
  --verify-model <name>   model for verification planning
  --trials <n>            independent trials per item, default 4
  --thinking <level>      minimal|low|medium|high|xhigh
  --dry-run               no model calls; static seeders only
  --mock-llm              run full pipeline with deterministic mock model
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
