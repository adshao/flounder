import os from "node:os";
import type { AuditorConfig } from "../config.js";
import { AUDIT_SYSTEM, buildAuditPrompt } from "../agents/prompts.js";
import { createAgentRegistry } from "../agents/registry.js";
import { SourceIndex } from "../index/source-index.js";
import type { AuditItem, AuditResult, Doc, LlmClient, TrialFinding } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonObject } from "../util/json.js";

export async function runAudit(input: {
  cfg: AuditorConfig;
  items: AuditItem[];
  source: Doc[];
  llm?: LlmClient;
  logger: RunLogger;
}): Promise<AuditResult[]> {
  if (input.cfg.dryRun || !input.llm) {
    const dry = input.items.map((item) => ({
      item,
      nTrials: 0,
      nHits: 0,
      hitRate: 0,
      trials: [],
    }));
    await input.logger.artifact("audit_results.json", dry);
    return dry;
  }

  const index = new SourceIndex(input.source);
  const agentRegistry = createAgentRegistry(input.cfg.auditorAgents);
  const results = await mapLimit(input.items, input.cfg.maxWorkers, async (item) =>
    auditItem({
      cfg: input.cfg,
      item,
      index,
      agentRegistry,
      llm: input.llm!,
      logger: input.logger,
    }),
  );
  await input.logger.artifact("audit_results.json", results);
  return results;
}

async function auditItem(input: {
  cfg: AuditorConfig;
  item: AuditItem;
  index: SourceIndex;
  agentRegistry: ReturnType<typeof createAgentRegistry>;
  llm: LlmClient;
  logger: RunLogger;
}): Promise<AuditResult> {
  const sourceContext = input.index.contextForItem(input.item, input.cfg.contextCharBudget);
  const user = buildAuditPrompt(input.item, sourceContext, input.agentRegistry);
  const trials = await mapLimit(
    Array.from({ length: input.cfg.trials }, (_, idx) => idx),
    Math.min(input.cfg.trials, Math.max(1, Math.floor(os.cpus().length / 2))),
    async (trial) => {
      const text = await input.llm.complete({
        tag: `audit_${input.item.id}_t${trial}`,
        system: AUDIT_SYSTEM,
        user,
        model: input.cfg.auditModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
      });
      return parseFinding(text);
    },
  );
  const hits = trials.filter((trial) => trial.finding);
  const result = {
    item: input.item,
    nTrials: trials.length,
    nHits: hits.length,
    hitRate: hits.length / Math.max(1, trials.length),
    trials,
  };
  await input.logger.event("item_done", { id: input.item.id, hitRate: result.hitRate });
  return result;
}

function parseFinding(text: string): TrialFinding {
  const parsed = extractJsonObject<Partial<TrialFinding>>(text);
  if (!parsed) {
    return {
      finding: false,
      title: "Parse error",
      severity: "info",
      confidence: 0,
      description: "The model did not return valid JSON.",
      evidence: "",
      exploitSketch: "",
      fix: "",
      parseError: true,
      raw: text.slice(0, 4000),
    };
  }
  return {
    finding: Boolean(parsed.finding),
    title: String(parsed.title ?? ""),
    severity: normalizeSeverity(parsed.severity),
    confidence: normalizeConfidence(parsed.confidence),
    description: String(parsed.description ?? ""),
    evidence: String(parsed.evidence ?? ""),
    exploitSketch: String(parsed.exploitSketch ?? ""),
    fix: String(parsed.fix ?? ""),
  };
}

function normalizeSeverity(value: unknown): TrialFinding["severity"] {
  if (value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info") return value;
  return "info";
}

function normalizeConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const current = items[idx];
      idx += 1;
      if (current !== undefined) out.push(await fn(current));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return out;
}
