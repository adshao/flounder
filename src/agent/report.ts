import path from "node:path";
import { copyFile, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { flounderHomeDir, type AuditorConfig } from "../config.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { listWorkspaceFiles, prepareSandboxWorkspace } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";
import { materialFingerprint, phaseInputFingerprint } from "../util/material-fingerprint.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type AgentTool, type ToolContext, type ToolResult } from "./tools.js";

export interface ReportFindingInput {
  findingId?: number | undefined;
  decisionId?: number | undefined;
  evidenceRunDir?: string | undefined;
  reportKey?: string | undefined;
  unit?: "finding" | "decision" | undefined;
  findingKey: string;
  title: string;
  evidenceMode?: "real-target-reproduced" | "source-only-local-confirmed" | undefined;
  evidenceLevel?: string | undefined;
  submissionConfidence?: string | undefined;
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
  linkedFindings?: Array<Record<string, unknown>> | undefined;
  phaseInputFingerprint?: string | undefined;
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
    const source = await loadSource(reportCfg.sourcePaths, { ...(reportCfg.buildRoot ? { publicRoot: reportCfg.buildRoot } : {}) });
    const corpus = reportCfg.corpusPaths.length ? await loadCorpus(reportCfg.corpusPaths) : [];
    if (source.length === 0) throw new Error("flounder report needs readable source paths so the daemon can verify report details");
    const buildDocs = reportCfg.buildRoot ? await loadSource([reportCfg.buildRoot], { publicRoot: reportCfg.buildRoot }) : [];
    reportCfg.materialFingerprint = materialFingerprint([
      { label: "source", docs: source },
      { label: "build", docs: buildDocs },
      { label: "corpus", docs: corpus },
    ]);
    recorder.materialFingerprint?.(reportCfg.materialFingerprint);
    for (const finding of options.findings) {
      const attempt = reportAttempt(finding, reportCfg.materialFingerprint);
      if (attempt) recorder.phaseAttempt?.({ ...attempt, phase: "report", state: "running" });
    }

    const workspaceRoots = reportCfg.buildRoot ? [reportCfg.buildRoot] : reportCfg.sourcePaths;
    const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "report/workspace");
    const stagedEvidence = await stageReportEvidence(options.findings, workspace.absolute, reportCfg.outputDir);
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
      fileManifest: renderReportFileManifest(source, corpus, options.findings, stagedEvidence),
      report: seed,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    });

    const reports = collectReports(options.findings, session.scratchFiles);
    const missing = options.findings.filter((finding) => !reports.some((report) => report.fileName === reportFileName(finding)));
    // Persist every valid report before evaluating completeness. A partial model
    // response must not discard finished work or force already-written reports to rerun.
    for (const report of reports) await logger.artifact(report.fileName, report.markdown);
    recorder.findingReports(reports.map((report) => ({
      ...(report.findingId !== undefined ? { findingId: report.findingId } : {}),
      ...(report.decisionId !== undefined ? { decisionId: report.decisionId } : {}),
      markdown: report.markdown,
    })));
    for (const finding of options.findings) {
      const attempt = reportAttempt(finding, reportCfg.materialFingerprint);
      if (!attempt) continue;
      const produced = reports.some((report) => report.fileName === reportFileName(finding));
      recorder.phaseAttempt?.({
        ...attempt,
        phase: "report",
        state: produced ? "settled" : "blocked",
        outcome: produced ? "report-written" : "missing-report-file",
        blocker: produced ? undefined : `report run did not write ${reportFileName(finding)}`,
      });
    }
    if (missing.length > 0) {
      throw new Error(`report run finished without required report file(s): ${missing.map((finding) => reportFileName(finding)).join(", ")}`);
    }
    await logger.event("audit_report_done", { stoppedReason: result.stoppedReason, steps: result.steps.length, reports: reports.length });
    recorder.finish(options.signal?.aborted ? "killed" : "done", undefined, reports.length);
    return { runDir: logger.runDir, reports: reports.length };
  } catch (error) {
    await logger.event("audit_report_error", { error: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    recorder.finish(options.signal?.aborted ? "killed" : "error");
    throw error;
  }
}

function reportAttempt(finding: ReportFindingInput, material: string): { subjectType: "finding" | "decision"; subjectId: number; inputFingerprint: string } | undefined {
  const subjectType = finding.decisionId !== undefined ? "decision" as const : "finding" as const;
  const subjectId = finding.decisionId ?? finding.findingId;
  if (subjectId === undefined) return undefined;
  return {
    subjectType,
    subjectId,
    inputFingerprint: finding.phaseInputFingerprint ?? phaseInputFingerprint({ phase: "report", material, subjectType, subjectId, findingKey: finding.findingKey, evidenceLevel: finding.evidenceLevel }),
  };
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
      submission_unit: finding.unit ?? (finding.decisionId !== undefined ? "decision" : "finding"),
      decision_id: finding.decisionId,
      report_key: finding.reportKey,
      finding_id: finding.findingId,
      finding_key: finding.findingKey,
      evidence_mode: finding.evidenceMode ?? "real-target-reproduced",
      evidence_level: finding.evidenceLevel,
      submission_confidence: finding.submissionConfidence,
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
      linked_findings: finding.linkedFindings ?? [],
    })),
    null,
    2,
  );
}

function collectReports(findings: ReportFindingInput[], scratchFiles: Map<string, string>): Array<{ findingId?: number; decisionId?: number; fileName: string; markdown: string }> {
  const out: Array<{ findingId?: number; decisionId?: number; fileName: string; markdown: string }> = [];
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
    if (markdown?.trim()) {
      out.push({
        ...(finding.findingId !== undefined ? { findingId: finding.findingId } : {}),
        ...(finding.decisionId !== undefined ? { decisionId: finding.decisionId } : {}),
        fileName,
        markdown,
      });
    }
  }
  return out;
}

function reportFileName(finding: ReportFindingInput): string {
  if (finding.decisionId !== undefined) return `report_decision_${finding.decisionId}.md`;
  if (finding.reportKey) return `report_${safeReportId(finding.reportKey)}.md`;
  return `report_${safeReportId(finding.findingKey || String(finding.findingId))}.md`;
}

function safeReportId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "finding";
}

export function renderReportFileManifest(source: Doc[], corpus: Doc[], findings: ReportFindingInput[], evidenceFiles: string[] = []): string {
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
  if (evidenceFiles.length > 0) {
    sections.push(`Read-only Confirm evidence staged for report accuracy (${evidenceFiles.length} files):\n${evidenceFiles.map((file) => `- ${file}`).join("\n")}`);
  }
  return sections.join("\n\n") || "(no files loaded)";
}

const REPORT_EVIDENCE_TOP_LEVEL = [
  "confirm_decision.json",
  "confirm_report.md",
  "impact_inventory.json",
  "confirm_provenance.json",
  "confirm_equivalence.json",
  "confirm_transcript.json",
] as const;
const REPORT_EVIDENCE_EXTENSIONS = new Set([".sol", ".rs", ".nr", ".ts", ".js", ".py", ".go", ".json", ".toml", ".md", ".txt"]);
const REPORT_EVIDENCE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const REPORT_EVIDENCE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const REPORT_EVIDENCE_MAX_FILES = 240;

export async function stageReportEvidence(
  findings: ReportFindingInput[],
  workspaceRoot: string,
  outputRoot: string,
): Promise<string[]> {
  const unique = new Map<string, ReportFindingInput>();
  for (const finding of findings) {
    if (finding.evidenceRunDir) unique.set(path.resolve(finding.evidenceRunDir), finding);
  }
  if (unique.size === 0) return [];

  const outputReal = await realpath(path.resolve(outputRoot));
  const staged: string[] = [];
  let totalBytes = 0;
  for (const [runDir, finding] of unique) {
    const runReal = await realpath(runDir).catch(() => undefined);
    if (!runReal) throw new Error(`Report evidence run is unavailable for decision ${finding.decisionId ?? "unknown"}.`);
    if (!isPathWithin(outputReal, runReal)) {
      throw new Error(`Unsafe Report evidence run for decision ${finding.decisionId ?? "unknown"}: path is outside the daemon output root.`);
    }
    const label = finding.decisionId !== undefined ? `decision-${finding.decisionId}` : safeReportId(finding.findingKey);
    const destinationRoot = path.join(workspaceRoot, "report-evidence", label);
    await mkdir(destinationRoot, { recursive: true });

    const candidates: Array<{ source: string; relative: string }> = REPORT_EVIDENCE_TOP_LEVEL.map((name) => ({
      source: path.join(runReal, name),
      relative: name,
    }));
    const scratchRoot = path.join(runReal, "confirm", "workspace", "scratch");
    for (const entry of await reportEvidenceScratchFiles(scratchRoot)) {
      candidates.push({ source: entry.source, relative: path.posix.join("scratch", entry.relative) });
    }

    let copiedForRun = 0;
    for (const candidate of candidates) {
      if (staged.length >= REPORT_EVIDENCE_MAX_FILES || totalBytes >= REPORT_EVIDENCE_MAX_TOTAL_BYTES) break;
      const info = await lstat(candidate.source).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > REPORT_EVIDENCE_MAX_FILE_BYTES) continue;
      if (totalBytes + info.size > REPORT_EVIDENCE_MAX_TOTAL_BYTES) continue;
      const destination = path.join(destinationRoot, ...candidate.relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(candidate.source, destination);
      totalBytes += info.size;
      copiedForRun += 1;
      staged.push(path.posix.join("report-evidence", label, candidate.relative));
    }
    if (copiedForRun === 0) {
      throw new Error(`Report evidence run has no readable Confirm artifacts for decision ${finding.decisionId ?? "unknown"}.`);
    }
  }
  return staged;
}

async function reportEvidenceScratchFiles(root: string): Promise<Array<{ source: string; relative: string }>> {
  const rootInfo = await stat(root).catch(() => undefined);
  if (!rootInfo?.isDirectory()) return [];
  const out: Array<{ source: string; relative: string }> = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    if (out.length >= REPORT_EVIDENCE_MAX_FILES) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (out.length >= REPORT_EVIDENCE_MAX_FILES) return;
      if (entry.isSymbolicLink() || entry.name === "out" || entry.name === "cache" || entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(current, entry.name);
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile() && REPORT_EVIDENCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push({ source: child, relative: childRelative });
      }
    }
  };
  await visit(root, "");
  return out;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
    if (finding.linkedFindings) add(JSON.stringify(finding.linkedFindings));
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
