import path from "node:path";
import { flounderHomeDir, type AuditorConfig } from "../config.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { listWorkspaceFiles, prepareSandboxWorkspace } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type AgentTool, type ToolContext, type ToolResult } from "./tools.js";

export interface ReportFindingInput {
  findingId: number;
  findingKey: string;
  title: string;
  evidenceMode?: "real-target-reproduced" | "source-only-local-confirmed" | undefined;
  location?: string | undefined;
  severity?: string | undefined;
  status?: string | undefined;
  confirmStatus?: string | undefined;
  description?: string | undefined;
  evidence?: string | undefined;
  exploitSketch?: string | undefined;
  fix?: string | undefined;
  confidence?: number | undefined;
  decisions?: Array<Record<string, unknown>> | undefined;
}

export interface ReportRunResult {
  runDir: string;
  reports: number;
}

export async function runReport(
  cfg: AuditorConfig,
  options: {
    findings: ReportFindingInput[];
    maxSteps?: number;
    signal?: AbortSignal;
    onRun?: (runId: number) => void;
    onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number }) => void;
    makeTracker?: RunTrackerFactory;
  },
): Promise<ReportRunResult> {
  if (!isPiSessionProvider(cfg.provider)) {
    throw new Error(`flounder report needs a session provider (e.g. openai-codex); provider "${cfg.provider}" cannot generate formal reports.`);
  }
  if (options.findings.length === 0) throw new Error("flounder report needs at least one reportable finding");

  const reportCfg: AuditorConfig = { ...cfg, auditMaxSteps: options.maxSteps ?? cfg.auditMaxSteps };
  const startedAt = new Date();
  const logger = new RunLogger(reportCfg.outputDir, `${reportCfg.targetName}-report`, startedAt, { streamEvents: false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, `${reportCfg.targetName}-report`);

  const recorder = (options.makeTracker ?? RunRecorder.start)(reportCfg, logger.runDir, "report", logger);
  if (recorder.runDbId !== undefined) options.onRun?.(recorder.runDbId);

  try {
    const source = await loadSource(reportCfg.sourcePaths);
    const corpus = reportCfg.corpusPaths.length ? await loadCorpus(reportCfg.corpusPaths) : [];
    if (source.length === 0) throw new Error("flounder report needs readable source paths so the daemon can verify report details");

    const workspaceRoots = reportCfg.buildRoot ? [reportCfg.buildRoot] : reportCfg.sourcePaths;
    const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "report/workspace");
    const session: AgentSession = newSession();
    session.workspace = workspace;
    session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
    session.buildCacheDir = path.join(projectHistoryDir(historyLocation(reportCfg)), "build-cache");

    const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(reportCfg)), "memory.jsonl"));
    const ctx: ToolContext = { cfg: reportCfg, source, corpus, memory, logger, session };
    const seed = renderReportSeed(options.findings);

    await logger.event("audit_report_start", {
      target: reportCfg.targetName,
      findings: options.findings.length,
      provider: reportCfg.provider,
      model: reportCfg.auditModel,
      workspace: publicPath(workspace.absolute),
    });

    const result = await runAuditSession({
      cfg: reportCfg,
      ctx,
      tools: buildReportTools(),
      logger,
      cwd: workspace.absolute,
      fileManifest: renderReportFileManifest(source, corpus, options.findings),
      report: seed,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });

    const reports = collectReports(options.findings, session.scratchFiles);
    const missing = options.findings.filter((finding) => !reports.some((report) => report.findingId === finding.findingId));
    if (missing.length > 0) {
      throw new Error(`report run finished without required report file(s): ${missing.map((finding) => reportFileName(finding)).join(", ")}`);
    }
    for (const report of reports) await logger.artifact(report.fileName, report.markdown);
    recorder.findingReports(reports.map((report) => ({ findingId: report.findingId, markdown: report.markdown })));
    await logger.event("audit_report_done", { stoppedReason: result.stoppedReason, steps: result.steps.length, reports: reports.length });
    recorder.finish(options.signal?.aborted ? "killed" : "done", undefined, reports.length);
    return { runDir: logger.runDir, reports: reports.length };
  } catch (error) {
    await logger.event("audit_report_error", { error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    recorder.finish(options.signal?.aborted ? "killed" : "error");
    throw error;
  }
}

function buildReportTools(): AgentTool[] {
  return buildTools().map((tool) => {
    if (tool.name !== "bash") return tool;
    return {
      ...tool,
      description:
        'Run one local inspection command in the copied sandbox workspace. Report mode only allows purpose="inspect" for commands such as rg, sed, cat, ls, find, or jq; it cannot build, confirm, or create new execution claims.',
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const purpose = typeof args.purpose === "string" ? args.purpose : "inspect";
        if (purpose !== "inspect") {
          return { observation: 'error: report mode only allows bash purpose="inspect"; use existing reproduced evidence and source/corpus checks, not new build or confirm runs.' };
        }
        return tool.run({ ...args, purpose: "inspect" }, ctx);
      },
    };
  });
}

function renderReportSeed(findings: ReportFindingInput[]): string {
  return JSON.stringify(
    findings.map((finding) => ({
      required_file: reportFileName(finding),
      finding_id: finding.findingId,
      finding_key: finding.findingKey,
      evidence_mode: finding.evidenceMode ?? "real-target-reproduced",
      title: finding.title,
      location: finding.location,
      severity: finding.severity,
      status: finding.status,
      confirm_status: finding.confirmStatus,
      description: finding.description,
      evidence: finding.evidence,
      exploit_sketch: finding.exploitSketch,
      fix: finding.fix,
      confidence: finding.confidence,
      confirm_decisions: finding.decisions ?? [],
    })),
    null,
    2,
  );
}

function collectReports(findings: ReportFindingInput[], scratchFiles: Map<string, string>): Array<{ findingId: number; fileName: string; markdown: string }> {
  const out: Array<{ findingId: number; fileName: string; markdown: string }> = [];
  for (const finding of findings) {
    const fileName = reportFileName(finding);
    let markdown = scratchFiles.get(fileName);
    if (!markdown) {
      for (const [file, content] of scratchFiles) {
        if (path.posix.basename(file) === fileName) {
          markdown = content;
          break;
        }
      }
    }
    if (markdown?.trim()) out.push({ findingId: finding.findingId, fileName, markdown });
  }
  return out;
}

function reportFileName(finding: ReportFindingInput): string {
  return `report_${safeReportId(finding.findingKey || String(finding.findingId))}.md`;
}

function safeReportId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "finding";
}

export function renderReportFileManifest(source: Doc[], corpus: Doc[], findings: ReportFindingInput[]): string {
  const relevant = reportPathHints(findings).slice(0, 80);
  const sourceLines = source.slice(0, 300).map((doc) => `- source ${publicPath(doc.path)} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const corpusLines = corpus.slice(0, 120).map((doc) => `- corpus ${publicPath(doc.path)} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const sections: string[] = [];

  sections.push(`Loaded workspace source: ${source.length} files. The list below is intentionally capped for report mode; use read with exact evidence paths or bash purpose="inspect" (rg/find/ls/sed/cat/jq) to inspect any copied workspace file needed for accuracy.`);
  if (relevant.length > 0) {
    sections.push(`Report-relevant path hints from findings and reproduced decisions:\n${relevant.map((entry) => `- ${entry}`).join("\n")}`);
  }
  if (sourceLines.length > 0) {
    sections.push(`Source inventory sample (${sourceLines.length}/${source.length} shown):\n${sourceLines.join("\n")}${source.length > sourceLines.length ? `\n…and ${source.length - sourceLines.length} more source files` : ""}`);
  }
  if (corpusLines.length > 0) {
    sections.push(`Corpus inventory sample (${corpusLines.length}/${corpus.length} shown):\n${corpusLines.join("\n")}${corpus.length > corpusLines.length ? `\n…and ${corpus.length - corpusLines.length} more corpus files` : ""}`);
  }
  return sections.join("\n\n") || "(no files loaded)";
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir || flounderHomeDir(),
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function reportPathHints(findings: ReportFindingInput[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    for (const hint of extractPathLikeTokens(value)) {
      const normalized = hint.replace(/^\.\/+/, "").replace(/,$/, "");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  };
  for (const finding of findings) {
    add(finding.location);
    add(finding.evidence);
    add(finding.description);
    add(finding.exploitSketch);
    add(finding.fix);
    if (finding.decisions) add(JSON.stringify(finding.decisions));
  }
  return out;
}

function extractPathLikeTokens(text: string): string[] {
  const exts = [
    "rs", "sol", "nr", "ts", "tsx", "js", "jsx", "mjs", "cjs", "cpp", "cc", "c", "hpp", "h", "go", "py",
    "json", "toml", "yaml", "yml", "md", "txt", "cairo", "move", "circom", "proto", "graphql", "gql",
  ];
  const pattern = new RegExp(`(?:^|[\\s"'()\\[\\]{},;])([A-Za-z0-9_.@/-]+\\.(${exts.join("|")})(?::\\d+(?:-\\d+)?)?)`, "gi");
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (!value || value.includes("..")) continue;
    out.push(value);
  }
  return out;
}
