import path from "node:path";
import type { AuditorConfig } from "./config.js";
import { aggregate } from "./audit/aggregate.js";
import { selectFindingsForFollowUp } from "./audit/impact.js";
import { runAudit } from "./audit/runner.js";
import { enumerateAuditItems } from "./enumerate.js";
import { loadCorpus, loadSource } from "./ingest/source.js";
import { SourceIndex } from "./index/source-index.js";
import { learnProject } from "./learn/project.js";
import { mergeProjectContexts } from "./lens/context.js";
import { discoverLensPacks } from "./lens/discover.js";
import { createLlmClient } from "./llm/client.js";
import { extractProofObligations } from "./obligations/extract.js";
import { profileProject } from "./profile/project.js";
import { extractAllProvenanceGraphs } from "./provenance/all.js";
import { renderDisclosure, reportArtifactName } from "./reports/disclosure.js";
import { summarizeChecklist, summarizeRun, summarizeSourceIndex } from "./reports/coverage.js";
import { reproduceTop } from "./reproduce/planner.js";
import { projectHistoryManifestPath, updateProjectHistory } from "./trace/history.js";
import { deepenAuditItems } from "./rounds/deepen.js";
import { writeLastRunPointer } from "./trace/last-run.js";
import { RunLogger } from "./trace/logger.js";
import { loadResumedRunState } from "./trace/run-state.js";
import type { AuditItem, AuditLensPackDefinition, AuditResult, AuditSummary, LlmClient, ProjectLearning, ProofObligation, Reproduction, Verification } from "./types.js";
import { publicPath } from "./util/paths.js";
import { verifyTop } from "./verify/planner.js";

export interface PipelineResult {
  runDir: string;
  summary: AuditSummary;
}

export async function runPipeline(
  cfg: AuditorConfig,
  options: { verifyTopK?: number; llm?: LlmClient; resumeRunDir?: string; streamEvents?: boolean } = {},
): Promise<PipelineResult> {
  const resumed = options.resumeRunDir ? await loadResumedRunState(options.resumeRunDir) : undefined;
  const startedAt = new Date();
  const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, {
    ...(resumed ? { runDir: resumed.runDir } : {}),
    streamEvents: options.streamEvents ?? false,
  });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);
  const requestedRounds = Math.max(1, Math.floor(cfg.rounds));
  await logger.event("run_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    enumModel: cfg.enumModel,
    auditModel: cfg.auditModel,
    verifyModel: cfg.verifyModel,
    thinkingLevel: cfg.thinkingLevel,
    rounds: requestedRounds,
    explorationStrategy: cfg.explorationStrategy,
    trials: cfg.trials,
    projectLearning: cfg.projectLearning,
    dynamicLensDiscovery: cfg.dynamicLensDiscovery,
    localChecklistSeeders: cfg.localChecklistSeeders,
    dryRun: cfg.dryRun,
    resume: resumed ? { completedRounds: resumed.completedRounds, additionalRounds: requestedRounds } : false,
  });

  const corpus = await loadCorpus(cfg.corpusPaths);
  const source = await loadSource(cfg.sourcePaths);
  const projectProfile = profileProject([...source, ...corpus]);
  const sourceIndex = new SourceIndex(source);
  const provenanceGraphs = extractAllProvenanceGraphs(source);
  await logger.event("knowledge_loaded", { corpusDocs: corpus.length, sourceDocs: source.length });
  await logger.artifact("project_profile.json", projectProfile);
  await logger.artifact("source_index.json", summarizeSourceIndex(source, sourceIndex.symbols));
  for (const graph of provenanceGraphs) {
    await logger.artifact(`${graph.domain}_provenance_graph.json`, graph);
  }

  const llm = cfg.dryRun ? undefined : options.llm ?? createLlmClient(cfg, logger);
  if (llm && "setLogger" in llm && typeof llm.setLogger === "function") {
    llm.setLogger(logger);
  }

  let projectLearning: ProjectLearning | undefined;
  let proofObligations: ProofObligation[];
  let lensPacks: AuditLensPackDefinition[];
  let items: AuditItem[];
  let results: AuditResult[];
  let firstRound: number;
  let lastRound: number;

  if (resumed) {
    projectLearning = resumed.projectLearning;
    proofObligations = extractProofObligations({ source, corpus, ...(projectLearning ? { projectLearning } : {}), provenanceGraphs });
    lensPacks = mergeLensPacks(resumed.lensPacks, cfg.lensPacks);
    items = [...resumed.items];
    results = [...resumed.results];
    firstRound = resumed.completedRounds + 1;
    lastRound = resumed.completedRounds + requestedRounds;
    await logger.artifact("resume_state.json", {
      resumedRun: basename(resumed.runDir),
      completedRounds: resumed.completedRounds,
      additionalRounds: requestedRounds,
      existingItems: items.length,
      existingAuditResults: results.length,
      nextRound: firstRound,
      pendingRoundItems: resumed.pendingRoundItems?.length ?? 0,
    });
    await logger.event("resume_loaded", {
      completedRounds: resumed.completedRounds,
      additionalRounds: requestedRounds,
      existingItems: items.length,
      existingAuditResults: results.length,
      nextRound: firstRound,
      pendingRoundItems: resumed.pendingRoundItems?.length ?? 0,
    });
  } else {
    projectLearning = await learnProject({ cfg, corpus, source, projectProfile, ...(llm ? { llm } : {}), logger });
    proofObligations = extractProofObligations({ source, corpus, projectLearning, provenanceGraphs });
    await logger.artifact("proof_obligations.json", proofObligations);
    await logger.event("proof_obligations_extracted", {
      total: proofObligations.length,
      byKind: countBy(proofObligations, (obligation) => obligation.kind),
    });
    lensPacks = await discoverLensPacks({ cfg, corpus, source, projectProfile, projectLearning, ...(llm ? { llm } : {}), logger });
    const enumCfg = withLensPacks(cfg, lensPacks);
    items = await enumerateAuditItems({
      cfg: enumCfg,
      corpus,
      source,
      sourceIndex,
      projectProfile,
      projectLearning,
      proofObligations,
      provenanceGraphs,
      ...(llm ? { llm } : {}),
      logger,
      round: 1,
    });
    results = [];
    firstRound = 1;
    lastRound = requestedRounds;
    await logger.artifact("checklist_coverage.json", summarizeChecklist(items));
  }

  const runCfg = withLensPacks(cfg, lensPacks);
  await logger.artifact("proof_obligations.json", proofObligations);

  for (let round = firstRound; round <= lastRound; round += 1) {
    await logger.event("round_start", { round });
    const roundItems =
      resumed?.pendingRoundItems && round === firstRound
          ? await loadPendingRoundItems({ logger, round, items: resumed.pendingRoundItems })
        : round === 1
          ? items.filter((item) => (item.round ?? 1) === 1)
          : await deepenAuditItems({
              cfg: runCfg,
              corpus,
              source,
              projectProfile,
              ...(projectLearning ? { projectLearning } : {}),
              existingItems: items,
              results,
              round,
              ...(llm ? { llm } : {}),
              logger,
            });

    if (round > 1) items.push(...itemsNotAlreadyPresent(items, roundItems));
    if (roundItems.length === 0) {
      await logger.event("round_done", { round, newItems: 0, auditedItems: 0 });
      break;
    }

    const roundResults = await runAudit({
      cfg: runCfg,
      items: roundItems,
      source,
      corpus,
      ...(projectLearning ? { projectLearning } : {}),
      ...(llm ? { llm } : {}),
      logger,
      artifactName: `round_${round}_audit_results.json`,
    });
    results.push(...roundResults);
    await logger.event("round_done", { round, newItems: roundItems.length, auditedItems: roundResults.length });
  }

  await logger.artifact("checklist.json", items);
  await logger.artifact("audit_results.json", results);
  await logger.artifact("checklist_coverage.json", summarizeChecklist(items));
  await logger.artifact("run_coverage.json", summarizeRun(items, results));
  const summary = aggregate(results);
  updateVerificationCoverage(summary);
  await logger.artifact("summary.json", summary);

  if (summary.findings.length > 0) {
    const verifications = await verifyTop({
      cfg: runCfg,
      findings: summary.findings,
      source,
      ...(projectLearning ? { projectLearning } : {}),
      ...(llm ? { llm } : {}),
      logger,
      topK: options.verifyTopK ?? 3,
    });
    applyVerificationStatuses(summary, verifications);
    updateVerificationCoverage(summary);
    const reproductions = await reproduceTop({
      cfg: runCfg,
      findings: summary.findings,
      verifications,
      source,
      ...(projectLearning ? { projectLearning } : {}),
      ...(llm ? { llm } : {}),
      logger,
      topK: options.verifyTopK ?? 3,
    });
    applyReproductionStatuses(summary, reproductions);
    updateVerificationCoverage(summary);
    await logger.artifact("summary.json", summary);
    const byId = new Map(verifications.map((verification) => [verification.id, verification]));
    const reproductionByFindingId = new Map(reproductions.map((reproduction) => [reproduction.findingId, reproduction]));
    for (const finding of selectFindingsForFollowUp(summary.findings, options.verifyTopK ?? 3, runCfg)) {
      await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding, byId.get(finding.id), reproductionByFindingId.get(finding.id)));
    }
  }

  await logger.event("run_done", {
    findings: summary.findings.length,
    confirmedSource: summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-source").length,
    confirmedExecutable: summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length,
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);
  const history = await updateProjectHistory({
    cfg,
    runDir: logger.runDir,
    summary,
    items,
    results,
    completedRounds: lastRound,
    startedAt: startedAt.toISOString(),
  });
  await logger.event("project_history_updated", {
    target: cfg.targetName,
    runs: history.aggregate.totalRuns,
    materials: history.aggregate.materialsTotal,
    manifest: publicPath(projectHistoryManifestPath(projectHistoryLocation(cfg))),
  });
  return { runDir: logger.runDir, summary };
}

function projectHistoryLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function mergeLensPacks(existing: AuditLensPackDefinition[], configured: AuditLensPackDefinition[]): AuditLensPackDefinition[] {
  const out = new Map<string, AuditLensPackDefinition>();
  for (const pack of [...existing, ...configured]) {
    out.set(pack.id, pack);
  }
  return [...out.values()];
}

async function loadPendingRoundItems(input: { logger: RunLogger; round: number; items: AuditItem[] }): Promise<AuditItem[]> {
  const items = input.items.map((item) => ({ ...item, round: input.round }));
  await input.logger.event("pending_round_loaded", { round: input.round, items: items.length });
  return items;
}

function itemsNotAlreadyPresent(existing: AuditItem[], next: AuditItem[]): AuditItem[] {
  const keys = new Set(existing.map(itemIdentity));
  return next.filter((item) => !keys.has(itemIdentity(item)));
}

function itemIdentity(item: AuditItem): string {
  return [item.round ?? 1, item.id, item.location, item.failureMode, item.securityProperty].join("\u0000");
}

function withLensPacks(cfg: AuditorConfig, lensPacks: AuditLensPackDefinition[]): AuditorConfig {
  return {
    ...cfg,
    lensPacks,
    projectContext: mergeProjectContexts([cfg.projectContext, ...lensPacks.map((pack) => pack.projectContext)]),
  };
}

function basename(input: string): string {
  return input.split(/[\\/]/).filter(Boolean).at(-1) ?? input;
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function applyVerificationStatuses(summary: AuditSummary, verifications: Verification[]): void {
  const byId = new Map(verifications.map((verification) => [verification.id, verification]));
  for (const finding of summary.findings) {
    const verification = byId.get(finding.id);
    if (!verification) continue;
    finding.verificationVerdict = verification.verdict;
    if (verification.confirmationStatus === "confirmed-source" && finding.confirmationStatus === "suspected") {
      finding.confirmationStatus = "confirmed-source";
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
