import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { createLlmClient } from "../llm/client.js";
import { renderDisclosure, reportArtifactName } from "../reports/disclosure.js";
import { projectHistoryDir, projectHistoryManifestPath, updateProjectHistory } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { AuditSummary, Doc, LlmClient, RankedFinding, Severity } from "../types.js";
import { publicPath } from "../util/paths.js";
import { runHuntLoop } from "./loop.js";
import { ProjectMemory } from "./memory.js";
import { buildTools, newSession, type AgentFinding, type ToolContext } from "./tools.js";

// Orchestrates one autonomous hunt: load authorized material, give the model the
// capability surface, run the ReAct loop, then turn whatever it proved into the
// same finding/summary/report/history artifacts the rest of the toolchain uses.
// All discrimination about *what* is a bug comes from the model; this function
// only wires capability, persistence, and reporting around it.

export interface HuntResult {
  runDir: string;
  summary: AuditSummary;
}

export async function runHunt(
  cfg: AuditorConfig,
  options: { llm?: LlmClient; streamEvents?: boolean } = {},
): Promise<HuntResult> {
  const startedAt = new Date();
  const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const source = await loadSource(cfg.sourcePaths);
  const corpus = await loadCorpus(cfg.corpusPaths);
  await logger.event("hunt_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    model: cfg.auditModel,
    maxSteps: cfg.huntMaxSteps,
    sourceDocs: source.length,
    corpusDocs: corpus.length,
  });

  if (source.length === 0) throw new Error("hunt requires at least one source file (use --source)");

  const llm = options.llm ?? createLlmClient(cfg, logger);
  if (llm && "setLogger" in llm && typeof (llm as { setLogger?: unknown }).setLogger === "function") {
    (llm as { setLogger(logger: RunLogger): void }).setLogger(logger);
  }

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(cfg)), "memory.jsonl"));
  const session = newSession();
  const tools = buildTools();
  const ctx: ToolContext = { cfg, source, corpus, memory, logger, session };

  const scopeNote = resolveScopeNote(cfg);
  // Surface prior-run lessons at kickoff: the most relevant notes for this scope,
  // falling back to the most recent ones so memory is always visible. The agent
  // can still pull more with the recall tool.
  let memoryNotes = await memory.recall([cfg.targetName, scopeNote].filter(Boolean).join(" "), 8);
  if (memoryNotes.length === 0) memoryNotes = (await memory.all()).slice(-8).reverse();
  const memoryHint = renderMemoryHint(memoryNotes);

  const loop = await runHuntLoop({
    cfg,
    llm,
    tools,
    ctx,
    logger,
    maxSteps: Math.max(1, Math.floor(cfg.huntMaxSteps)),
    fileManifest: renderFileManifest(source),
    ...(scopeNote ? { scopeNote } : {}),
    ...(memoryHint ? { memoryHint } : {}),
  });

  await logger.artifact("hunt_transcript.json", { stoppedReason: loop.stoppedReason, steps: loop.steps });
  await logger.artifact("hunt_findings.json", session.findings);
  await logger.artifact("hunt_test_runs.json", session.testRuns);

  const summary = buildSummary(session.findings, loop.steps);
  await logger.artifact("summary.json", summary);

  for (const finding of summary.findings) {
    await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding));
  }

  await logger.event("hunt_done", {
    stoppedReason: loop.stoppedReason,
    steps: loop.steps.length,
    findings: summary.findings.length,
    confirmedExecutable: summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length,
    testRuns: session.testRuns.length,
    finishSummary: session.finishSummary ?? "",
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const history = await updateProjectHistory({
    cfg,
    runDir: logger.runDir,
    summary,
    items: [],
    results: [],
    completedRounds: 1,
    startedAt: startedAt.toISOString(),
  });
  await logger.event("project_history_updated", {
    target: cfg.targetName,
    runs: history.aggregate.totalRuns,
    materials: history.aggregate.materialsTotal,
    manifest: publicPath(projectHistoryManifestPath(historyLocation(cfg))),
  });

  return { runDir: logger.runDir, summary };
}

function buildSummary(findings: AgentFinding[], steps: { tool: string }[]): AuditSummary {
  const ranked = findings.map(toRankedFinding).sort((a, b) => b.score - a.score);
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of ranked) bySeverity[finding.severity] += 1;
  const verified = ranked.filter((finding) => finding.confirmationStatus === "confirmed-executable").length;
  return {
    coverage: {
      itemsTotal: ranked.length,
      itemsWithFinding: ranked.length,
      bySeverity,
      itemsNeedingRetry: 0,
      modelErrorTrials: steps.filter((step) => step.tool === "(model-error)").length,
      parseErrorTrials: steps.filter((step) => step.tool === "(parse-error)").length,
      needsMoreContextTrials: 0,
      verifiedFindings: verified,
      unverifiedFindings: Math.max(0, ranked.length - verified),
    },
    findings: ranked,
  };
}

function toRankedFinding(finding: AgentFinding): RankedFinding {
  const severityWeight: Record<Severity, number> = { info: 0.2, low: 0.4, medium: 0.6, high: 0.85, critical: 1 };
  const confirmBoost = finding.confirmationStatus === "confirmed-executable" ? 1.3 : 1;
  const score = round2(severityWeight[finding.severity] * (0.5 + 0.5 * finding.confidence) * confirmBoost);
  return {
    id: finding.id,
    location: finding.location,
    failureMode: "autonomous",
    title: finding.title,
    severity: finding.severity,
    hitRate: 1,
    confidence: finding.confidence,
    score,
    description: finding.description,
    evidence: finding.evidence,
    exploitSketch: finding.exploitSketch,
    fix: finding.fix,
    confirmationStatus: finding.confirmationStatus,
    ...(finding.confirmationStatus === "confirmed-executable" ? { reproductionStatus: "confirmed-executable" as const } : {}),
  };
}

function resolveScopeNote(cfg: AuditorConfig): string {
  const parts: string[] = [];
  if (cfg.huntScopeNote) parts.push(cfg.huntScopeNote);
  if (cfg.projectContext.summary) parts.push(cfg.projectContext.summary);
  if (cfg.projectContext.focusAreas?.length) parts.push(`Focus areas: ${cfg.projectContext.focusAreas.join("; ")}`);
  if (cfg.projectContext.outOfScope?.length) parts.push(`Out of scope: ${cfg.projectContext.outOfScope.join("; ")}`);
  return parts.join("\n");
}

function renderMemoryHint(notes: { kind: string; note: string; sourceRef?: string }[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `- [${note.kind}] ${note.note}${note.sourceRef ? ` (ref: ${note.sourceRef})` : ""}`).join("\n");
}

function renderFileManifest(source: Doc[]): string {
  const lines = source.slice(0, 600).map((doc) => `- ${doc.path} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const more = source.length > 600 ? `\n…and ${source.length - 600} more files` : "";
  return `${lines.join("\n")}${more}`;
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
