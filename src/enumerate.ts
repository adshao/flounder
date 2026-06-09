import type { AuditorConfig } from "./config.js";
import { effectiveFailureModes } from "./config.js";
import {
  buildBaselineEnumerationPrompt,
  buildCairoStarknetPortfolioEnumerationPrompt,
  buildEnumerationPrompt,
  buildEvmPortfolioEnumerationPrompt,
  buildPortfolioEnumerationPrompt,
  buildSolanaPortfolioEnumerationPrompt,
  ENUM_SYSTEM,
} from "./agents/prompts.js";
import { buildEnumerationContext } from "./enumeration/context.js";
import { SourceIndex } from "./index/source-index.js";
import { renderProjectLearning } from "./learn/project.js";
import { renderLensPacks, renderProjectContext } from "./lens/context.js";
import { renderProofObligations } from "./obligations/extract.js";
import { renderProjectProfile } from "./profile/project.js";
import { renderProvenanceGraph } from "./provenance/halo2.js";
import { runSeeders } from "./seeders/index.js";
import type { AuditItem, Doc, LlmClient, ProjectLearning, ProjectProfile, ProofObligation, ProvenanceGraph } from "./types.js";
import { extractJsonArray } from "./util/json.js";
import type { RunLogger } from "./trace/logger.js";
import { auditItemKey, dedupeAuditItems, normalizeAuditItem, selectDiverseAuditItems, type RawAuditItem } from "./items.js";

export async function enumerateAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  sourceIndex?: SourceIndex;
  projectProfile?: ProjectProfile;
  projectLearning?: ProjectLearning;
  proofObligations?: ProofObligation[];
  provenanceGraphs?: ProvenanceGraph[];
  llm?: LlmClient;
  logger: RunLogger;
  round?: number;
}): Promise<AuditItem[]> {
  const round = input.round ?? 1;
  const seeded = input.cfg.localChecklistSeeders ? runSeeders(input.source).map((item) => ({ ...item, round })) : [];
  await input.logger.event("seeders_done", { round, enabled: input.cfg.localChecklistSeeders, nItems: seeded.length });

  if (input.cfg.dryRun || !input.llm) {
    await input.logger.artifact("checklist.json", seeded);
    return seeded;
  }

  const sourceIndex = input.sourceIndex ?? new SourceIndex(input.source);
  const proofObligations = input.proofObligations ?? [];
  const provenanceGraphs = input.provenanceGraphs ?? [];
  const enumContext = await buildEnumerationContext({
    cfg: input.cfg,
    corpus: input.corpus,
    source: input.source,
    sourceIndex,
    proofObligations,
    provenanceGraphs,
    round,
  });
  await input.logger.artifact(`round_${round}_enumeration_context_retrieval.json`, enumContext.trace);
  const user = buildEnumerationPrompt({
    target: input.cfg.targetName,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    scopeMode: input.cfg.scopeMode,
    proofObligations: renderProofObligations(proofObligations),
    provenanceFacts: provenanceGraphs.map((graph) => renderProvenanceGraph(graph)).filter(Boolean).join("\n\n"),
    corpus: enumContext.corpus,
    source: enumContext.source,
  });
  const text = await input.llm.complete({
    tag: "enumerate",
    system: ENUM_SYSTEM,
    user,
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const llmItems = extractJsonArray<RawAuditItem>(text)
    .map((item) => withEnumerationSource(normalizeAuditItem(item, round), "model"))
    .filter((item): item is AuditItem => item !== undefined);
  const portfolioItems = await enumeratePortfolios({
    cfg: input.cfg,
    corpus: enumContext.corpus,
    source: enumContext.source,
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    lensPacks: renderLensPacks(input.cfg.lensPacks),
    proofObligations,
    provenanceGraphs,
    llm: input.llm,
    logger: input.logger,
    round,
  });
  const roundOneBudget = initialEnumerationBudget(input.cfg);
  const baselineItems = await enumerateBaseline({
    cfg: input.cfg,
    corpus: enumContext.corpus,
    source: enumContext.source,
    projectProfile: input.projectProfile ? renderProjectProfile(input.projectProfile) : "",
    projectLearning: renderProjectLearning(input.projectLearning),
    projectContext: renderProjectContext(input.cfg.projectContext),
    proofObligations,
    provenanceGraphs,
    llm: input.llm,
    logger: input.logger,
    round,
    roundOneBudget,
  });
  const seededWithSource = seeded.map((item) => ({ ...item, enumerationSource: "seeder" as const }));
  const deduped = dedupeAuditItems([...seededWithSource, ...portfolioItems, ...llmItems, ...baselineItems]);
  const all = selectWithBaselineReserve(deduped, baselineItems, roundOneBudget, input.cfg);
  if (all.length < deduped.length) {
    await input.logger.event("enumeration_limited", {
      maxAuditItems: input.cfg.maxAuditItems,
      roundOneBudget,
      reservedForLaterRounds: reservedForLaterRounds(input.cfg),
      before: deduped.length,
      after: all.length,
      baselineReserved: baselineReservation(roundOneBudget, baselineItems.length, input.cfg),
    });
  }
  await input.logger.artifact("checklist.json", all);
  await input.logger.event("enumeration_done", {
    seeded: seeded.length,
    llm: llmItems.length,
    portfolio: portfolioItems.length,
    baseline: baselineItems.length,
    deduped: deduped.length,
    total: all.length,
    scopeMode: input.cfg.scopeMode,
  });
  return all;
}

async function enumerateBaseline(input: {
  cfg: AuditorConfig;
  corpus: string;
  source: string;
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  proofObligations: ProofObligation[];
  provenanceGraphs: ProvenanceGraph[];
  llm: LlmClient;
  logger: RunLogger;
  round: number;
  roundOneBudget: number | undefined;
}): Promise<AuditItem[]> {
  if (input.round !== 1 || input.cfg.scopeMode !== "augment" || input.cfg.lensPacks.length === 0) return [];
  const maxItems = baselinePromptMaxItems(input.roundOneBudget, input.cfg);
  if (maxItems <= 0) return [];
  const user = buildBaselineEnumerationPrompt({
    target: input.cfg.targetName,
    maxItems,
    failureModes: effectiveFailureModes(input.cfg),
    projectProfile: input.projectProfile,
    projectLearning: input.projectLearning,
    projectContext: input.projectContext,
    proofObligations: renderProofObligations(input.proofObligations, Math.max(12, maxItems * 4)),
    provenanceFacts: input.provenanceGraphs.map((graph) => renderProvenanceGraph(graph, Math.max(40, maxItems * 8))).filter(Boolean).join("\n\n"),
    corpus: input.corpus,
    source: input.source,
  });
  try {
    const text = await input.llm.complete({
      tag: "enumerate_baseline",
      system: ENUM_SYSTEM,
      user,
      model: input.cfg.enumModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const items = extractJsonArray<RawAuditItem>(text)
      .slice(0, maxItems)
      .map((item) => withEnumerationSource(normalizeAuditItem(item, input.round), "baseline"))
      .filter((item): item is AuditItem => item !== undefined);
    await input.logger.event("baseline_enumeration_done", { items: items.length, maxItems });
    return items;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.event("baseline_enumeration_error", { error: message.slice(0, 500) });
    return [];
  }
}

async function enumeratePortfolios(input: {
  cfg: AuditorConfig;
  corpus: string;
  source: string;
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  proofObligations: ProofObligation[];
  provenanceGraphs: ProvenanceGraph[];
  llm: LlmClient;
  logger: RunLogger;
  round: number;
}): Promise<AuditItem[]> {
  if (!input.cfg.portfolioEnumeration) return [];
  if (input.provenanceGraphs.length === 0) return [];
  const maxItems = Math.max(1, Math.floor(input.cfg.portfolioMaxItems));
  const graphs = input.provenanceGraphs.filter((graph) => graph.obligations.length > 0);
  if (graphs.length === 0) return [];
  const perPortfolioMaxItems = Math.max(1, Math.ceil(maxItems / graphs.length));
  const out: AuditItem[] = [];
  for (const graph of graphs) {
    const portfolio = portfolioName(graph.domain);
    const user = portfolioPromptForDomain({
      domain: graph.domain,
      target: input.cfg.targetName,
      portfolio,
      maxItems: perPortfolioMaxItems,
      failureModes: effectiveFailureModes(input.cfg),
      projectProfile: input.projectProfile,
      projectLearning: input.projectLearning,
      projectContext: input.projectContext,
      lensPacks: input.lensPacks,
      proofObligations: renderProofObligations(graph.obligations, Math.max(12, perPortfolioMaxItems * 6)),
      provenanceFacts: renderProvenanceGraph(graph, Math.max(80, perPortfolioMaxItems * 12)),
      corpus: input.corpus,
      source: input.source,
    });
    try {
      const text = await input.llm.complete({
        tag: `enumerate_${graph.domain}_portfolio`,
        system: ENUM_SYSTEM,
        user,
        model: input.cfg.enumModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
      });
      const items = extractJsonArray<RawAuditItem>(text)
        .slice(0, perPortfolioMaxItems)
        .map((item) => withEnumerationSource(normalizeAuditItem(item, input.round), "portfolio"))
        .filter((item): item is AuditItem => item !== undefined);
      out.push(...items);
      await input.logger.event("portfolio_enumeration_done", { portfolio, domain: graph.domain, items: items.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.logger.event("portfolio_enumeration_error", { portfolio, domain: graph.domain, error: message.slice(0, 500) });
    }
  }
  return selectDiverseAuditItems(dedupeAuditItems(out), maxItems);
}

function portfolioPromptForDomain(input: {
  domain: string;
  target: string;
  portfolio: string;
  maxItems: number;
  failureModes: ReturnType<typeof effectiveFailureModes>;
  projectProfile: string;
  projectLearning: string;
  projectContext: string;
  lensPacks: string;
  proofObligations: string;
  provenanceFacts: string;
  corpus: string;
  source: string;
}): string {
  const common = {
    target: input.target,
    portfolio: input.portfolio,
    maxItems: input.maxItems,
    failureModes: input.failureModes,
    projectProfile: input.projectProfile,
    projectLearning: input.projectLearning,
    projectContext: input.projectContext,
    lensPacks: input.lensPacks,
    proofObligations: input.proofObligations,
    provenanceFacts: input.provenanceFacts,
    corpus: input.corpus,
    source: input.source,
  };
  if (input.domain === "solidity") return buildEvmPortfolioEnumerationPrompt(common);
  if (input.domain === "solana-rust") return buildSolanaPortfolioEnumerationPrompt(common);
  if (input.domain === "cairo-starknet") return buildCairoStarknetPortfolioEnumerationPrompt(common);
  return buildPortfolioEnumerationPrompt(common);
}

function initialEnumerationBudget(cfg: Pick<AuditorConfig, "maxAuditItems" | "rounds" | "maxNewItemsPerRound">): number | undefined {
  if (typeof cfg.maxAuditItems !== "number" || !Number.isFinite(cfg.maxAuditItems) || cfg.maxAuditItems < 1) return undefined;
  const maxAuditItems = Math.floor(cfg.maxAuditItems);
  const rounds = Math.max(1, Math.floor(cfg.rounds));
  if (rounds <= 1) return maxAuditItems;
  const reserved = reservedForLaterRounds(cfg);
  return Math.max(1, maxAuditItems - reserved);
}

function reservedForLaterRounds(cfg: Pick<AuditorConfig, "maxAuditItems" | "rounds" | "maxNewItemsPerRound">): number {
  if (typeof cfg.maxAuditItems !== "number" || !Number.isFinite(cfg.maxAuditItems) || cfg.maxAuditItems < 1) return 0;
  const maxAuditItems = Math.floor(cfg.maxAuditItems);
  const rounds = Math.max(1, Math.floor(cfg.rounds));
  const perRound = Math.max(1, Math.floor(cfg.maxNewItemsPerRound));
  const laterCapacity = Math.max(0, rounds - 1) * perRound;
  return Math.min(maxAuditItems - 1, laterCapacity);
}

function portfolioName(domain: string): string {
  if (domain === "solidity") return "solidity/evm provenance evidence";
  if (domain === "solana-rust") return "solana/rust provenance evidence";
  if (domain === "cairo-starknet") return "cairo/starknet provenance evidence";
  if (domain === "go-wormhole") return "wormhole guardian/go provenance evidence";
  return "assignment/dataflow evidence";
}

function baselinePromptMaxItems(roundOneBudget: number | undefined, cfg: AuditorConfig): number {
  if (roundOneBudget !== undefined) return baselineReservation(roundOneBudget, Number.POSITIVE_INFINITY, cfg);
  return Math.max(1, Math.floor(cfg.portfolioMaxItems * Math.max(0.1, cfg.baselineExplorationShare)));
}

function baselineReservation(roundOneBudget: number | undefined, baselineItems: number, cfg: AuditorConfig): number {
  if (baselineItems <= 0) return 0;
  const share = Math.max(0, Math.min(0.8, cfg.baselineExplorationShare));
  if (share <= 0) return 0;
  const budget = roundOneBudget ?? cfg.portfolioMaxItems;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 1) return Math.min(baselineItems, Math.max(1, Math.floor(cfg.portfolioMaxItems * share)));
  return Math.min(baselineItems, Math.max(1, Math.floor(budget * share)));
}

function selectWithBaselineReserve(
  items: AuditItem[],
  baselineItems: AuditItem[],
  maxItems: number | undefined,
  cfg: AuditorConfig,
): AuditItem[] {
  if (typeof maxItems !== "number" || !Number.isFinite(maxItems) || maxItems < 1) return items;
  const limit = Math.floor(maxItems);
  if (items.length <= limit) return items;
  const baselineLimit = baselineReservation(limit, baselineItems.length, cfg);
  if (baselineLimit <= 0) return selectDiverseAuditItems(items, limit);
  const baselineSelected = selectDiverseAuditItems(dedupeAuditItems(baselineItems), baselineLimit);
  const selectedKeys = new Set(baselineSelected.map((item) => auditItemKey(item)));
  const remaining = items.filter((item) => !selectedKeys.has(auditItemKey(item)));
  return [...baselineSelected, ...selectDiverseAuditItems(remaining, limit - baselineSelected.length)];
}

function withEnumerationSource(item: AuditItem | undefined, enumerationSource: NonNullable<AuditItem["enumerationSource"]>): AuditItem | undefined {
  return item ? { ...item, enumerationSource } : undefined;
}
