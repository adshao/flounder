import type { AuditorConfig } from "./config.js";
import { aggregate } from "./audit/aggregate.js";
import { runAudit } from "./audit/runner.js";
import { enumerateAuditItems } from "./enumerate.js";
import { loadCorpus, loadSource } from "./ingest/source.js";
import { SourceIndex } from "./index/source-index.js";
import { PiAiClient } from "./llm/pi-ai.js";
import { renderDisclosure } from "./reports/disclosure.js";
import { summarizeChecklist, summarizeRun, summarizeSourceIndex } from "./reports/coverage.js";
import { RunLogger } from "./trace/logger.js";
import type { AuditSummary, LlmClient } from "./types.js";
import { publicPath } from "./util/paths.js";
import { verifyTop } from "./verify/planner.js";

export interface PipelineResult {
  runDir: string;
  summary: AuditSummary;
}

export async function runPipeline(cfg: AuditorConfig, options: { verifyTopK?: number; llm?: LlmClient } = {}): Promise<PipelineResult> {
  const logger = new RunLogger(cfg.outputDir, cfg.targetName);
  await logger.init();
  await logger.event("run_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    dryRun: cfg.dryRun,
  });

  const corpus = await loadCorpus(cfg.corpusPaths);
  const source = await loadSource(cfg.sourcePaths);
  const sourceIndex = new SourceIndex(source);
  await logger.event("knowledge_loaded", { corpusDocs: corpus.length, sourceDocs: source.length });
  await logger.artifact("source_index.json", summarizeSourceIndex(source, sourceIndex.symbols));

  const llm = cfg.dryRun ? undefined : options.llm ?? new PiAiClient(cfg.provider, logger);
  if (llm && "setLogger" in llm && typeof llm.setLogger === "function") {
    llm.setLogger(logger);
  }
  const items = await enumerateAuditItems({ cfg, corpus, source, ...(llm ? { llm } : {}), logger });
  await logger.artifact("checklist_coverage.json", summarizeChecklist(items));
  const results = await runAudit({ cfg, items, source, ...(llm ? { llm } : {}), logger });
  await logger.artifact("run_coverage.json", summarizeRun(items, results));
  const summary = aggregate(results);
  await logger.artifact("summary.json", summary);

  if (summary.findings.length > 0) {
    const verifications = await verifyTop({
      cfg,
      findings: summary.findings,
      source,
      ...(llm ? { llm } : {}),
      logger,
      topK: options.verifyTopK ?? 3,
    });
    const byId = new Map(verifications.map((verification) => [verification.id, verification]));
    for (const finding of summary.findings.slice(0, options.verifyTopK ?? 3)) {
      await logger.artifact(`report_${finding.id}.md`, renderDisclosure(cfg.targetName, finding, byId.get(finding.id)));
    }
  }

  await logger.event("run_done", { findings: summary.findings.length });
  return { runDir: logger.runDir, summary };
}
