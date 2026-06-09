import path from "node:path";
import type { AuditorConfig } from "../config.js";
import {
  firstBlockedSandboxCommand,
  firstBlockedSandboxFile,
  matchSuccessPatterns,
  prepareSandboxWorkspace,
  runSandboxCommand,
  safeName,
  writeSandboxFiles,
} from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import type { ConfirmationStatus, Doc, ReproductionCommand, ReproductionFile, Severity } from "../types.js";
import type { ProjectMemory } from "./memory.js";

// The capability surface. Each tool gives the model an affordance it physically
// lacks (read the repo, search it, run a local test, recall prior runs) or a way
// to record an outcome. No tool tells the model what to look for or how to think.
// The single hard opinion lives here: a finding only reaches confirmed-executable
// when a sandboxed local test actually passed — never on the model's say-so.

export interface AgentFinding {
  id: string;
  title: string;
  severity: Severity;
  location: string;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
  confidence: number;
  confirmationStatus: ConfirmationStatus;
  testRunId?: string;
}

export interface TestRunRecord {
  id: string;
  passed: boolean;
  command: string;
  matched: string[];
  missing: string[];
  exitCode: number | null;
  expectedExitCode: number;
  timedOut: boolean;
  workspace: string;
}

export interface AgentSession {
  findings: AgentFinding[];
  testRuns: TestRunRecord[];
  finished: boolean;
  finishSummary?: string;
  counters: { test: number; finding: number };
}

export function newSession(): AgentSession {
  return { findings: [], testRuns: [], finished: false, counters: { test: 0, finding: 0 } };
}

export interface ToolContext {
  cfg: AuditorConfig;
  source: Doc[];
  corpus: Doc[];
  memory: ProjectMemory;
  logger: RunLogger;
  session: AgentSession;
}

export interface ToolResult {
  observation: string;
  meta?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function buildTools(): AgentTool[] {
  return [listFilesTool, readFileTool, searchTool, runTestTool, reportFindingTool, recallTool, rememberTool, finishTool];
}

/** Render the tool catalogue for the system prompt. */
export function renderToolCatalogue(tools: AgentTool[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}

const listFilesTool: AgentTool = {
  name: "list_files",
  description:
    'List loaded files. args: {"kind"?: "source"|"corpus"|"all" (default source), "filter"?: substring}. Returns path and line count for each file.',
  async run(args, ctx) {
    const kind = asEnum(args.kind, ["source", "corpus", "all"], "source");
    const filter = asString(args.filter)?.toLowerCase();
    const docs = selectDocs(ctx, kind).filter((doc) => !filter || doc.path.toLowerCase().includes(filter));
    if (docs.length === 0) return { observation: "(no matching files)" };
    const lines = docs.slice(0, 400).map((doc) => `${doc.path} (${countLines(doc.content)} lines, ${doc.kind})`);
    const more = docs.length > 400 ? `\n…and ${docs.length - 400} more` : "";
    return { observation: `${docs.length} file(s):\n${lines.join("\n")}${more}`, meta: { count: docs.length } };
  },
};

const readFileTool: AgentTool = {
  name: "read_file",
  description:
    'Read a loaded file, optionally a line range. args: {"path": string, "start"?: int (1-based), "end"?: int}. Without a range it returns up to 400 lines.',
  async run(args, ctx) {
    const target = asString(args.path);
    if (!target) return { observation: 'error: "path" is required' };
    const doc = findDoc(ctx, target);
    if (!doc) return { observation: `error: no loaded file matches "${target}". Use list_files to see available paths.` };
    const allLines = doc.content.split("\n");
    const start = clampInt(args.start, 1, allLines.length, 1);
    const defaultEnd = Math.min(allLines.length, start + 399);
    const end = clampInt(args.end, start, allLines.length, defaultEnd);
    const slice = allLines.slice(start - 1, end);
    const numbered = slice.map((line, idx) => `${start + idx}\t${line}`).join("\n");
    const header = `${doc.path} lines ${start}-${end} of ${allLines.length}`;
    return { observation: `${header}\n${numbered}`, meta: { path: doc.path, start, end, total: allLines.length } };
  },
};

const searchTool: AgentTool = {
  name: "search",
  description:
    'Regex search across loaded files. args: {"query": regex string, "kind"?: "source"|"corpus"|"all", "max_results"?: int (default 60), "ignore_case"?: bool (default true)}. Returns path:line and the matching line.',
  async run(args, ctx) {
    const query = asString(args.query);
    if (!query) return { observation: 'error: "query" is required' };
    let regex: RegExp;
    try {
      regex = new RegExp(query, asBool(args.ignore_case, true) ? "i" : "");
    } catch (error) {
      return { observation: `error: invalid regex: ${error instanceof Error ? error.message : String(error)}` };
    }
    const kind = asEnum(args.kind, ["source", "corpus", "all"], "source");
    const maxResults = clampInt(args.max_results, 1, 300, 60);
    const hits: string[] = [];
    for (const doc of selectDocs(ctx, kind)) {
      const lines = doc.content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (regex.test(lines[i] ?? "")) {
          hits.push(`${doc.path}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 240)}`);
          if (hits.length >= maxResults) break;
        }
      }
      if (hits.length >= maxResults) break;
    }
    if (hits.length === 0) return { observation: `no matches for /${query}/` };
    return { observation: `${hits.length} match(es):\n${hits.join("\n")}`, meta: { count: hits.length } };
  },
};

const runTestTool: AgentTool = {
  name: "run_test",
  description:
    'Run ONE local test in an isolated copy of the source to prove or disprove a hypothesis. args: {"files": [{"path": relative, "content": string}], "command": {"program": string, "args": [string]}, "expected_exit_code"?: int, "success_patterns": [string]}. Only local test runners are allowed (cargo test, forge test, go test, npm test, pytest, node --test, …); no networks, no subprocess spawning, no secrets. Returns the outcome and a run id you can cite in report_finding to reach confirmed-executable.',
  async run(args, ctx) {
    if (ctx.cfg.sourcePaths.length === 0) {
      return { observation: "error: run_test needs on-disk source roots (sourcePaths); none are configured for this run." };
    }
    const files = normalizeFiles(args.files, ctx.cfg.reproductionMaxFileBytes);
    const command = normalizeCommand(args.command, args, ctx.cfg);
    if (!command) return { observation: 'error: "command" must be {"program": string, "args": [string]}.' };
    const successPatterns = asStringList(args.success_patterns);

    const blockedCommand = firstBlockedSandboxCommand([command]);
    if (blockedCommand) return { observation: `blocked: ${blockedCommand}` };
    const blockedFile = firstBlockedSandboxFile(files);
    if (blockedFile) return { observation: `blocked: ${blockedFile}` };

    ctx.session.counters.test += 1;
    const runId = `t${ctx.session.counters.test}`;
    const relativeDir = path.posix.join("hunt", "tests", safeName(runId), "workspace");
    const workspace = await prepareSandboxWorkspace(ctx.cfg.sourcePaths, ctx.logger.runDir, relativeDir);
    await writeSandboxFiles(workspace.absolute, files);
    const result = await runSandboxCommand(command, workspace.absolute, ctx.cfg.reproductionMaxLogBytes, ctx.cfg.sourcePaths);
    const exitMatched = result.exitCode === result.expectedExitCode && !result.timedOut;
    const patternCheck = matchSuccessPatterns(successPatterns, [result]);
    const passed = exitMatched && patternCheck.missing.length === 0 && patternCheck.matched.length > 0;

    const record: TestRunRecord = {
      id: runId,
      passed,
      command: [command.program, ...command.args].join(" "),
      matched: patternCheck.matched,
      missing: patternCheck.missing,
      exitCode: result.exitCode,
      expectedExitCode: result.expectedExitCode,
      timedOut: result.timedOut,
      workspace: workspace.relative,
    };
    ctx.session.testRuns.push(record);
    await ctx.logger.event("hunt_test_run", {
      runId,
      passed,
      exitCode: result.exitCode,
      expectedExitCode: result.expectedExitCode,
      timedOut: result.timedOut,
      matched: patternCheck.matched.length,
      missing: patternCheck.missing.length,
    });

    const tail = (text: string): string => (text.length > 1600 ? `…${text.slice(-1600)}` : text);
    const verdict = passed
      ? `run ${runId}: PASS — exit=${result.exitCode} (expected ${result.expectedExitCode}); matched success patterns: ${patternCheck.matched.join(", ")}. Cite test_run_id="${runId}" in report_finding for confirmed-executable.`
      : `run ${runId}: NOT CONFIRMED — exit=${result.exitCode} expected=${result.expectedExitCode} timedOut=${result.timedOut}; missing patterns: ${patternCheck.missing.join(" | ")}`;
    return {
      observation: `${verdict}\n--- stdout ---\n${tail(result.stdout) || "(empty)"}\n--- stderr ---\n${tail(result.stderr) || "(empty)"}`,
      meta: { runId, passed },
    };
  },
};

const reportFindingTool: AgentTool = {
  name: "report_finding",
  description:
    'Record a candidate vulnerability. args: {"title", "severity": info|low|medium|high|critical, "location": "file:line", "description", "evidence", "exploit_sketch", "fix", "confidence": 0..1, "test_run_id"?: string}. A finding only becomes confirmed-executable if test_run_id names a run_test that actually passed; otherwise it is recorded as suspected. Reporting does not end the hunt — keep going.',
  async run(args, ctx) {
    const title = asString(args.title);
    const location = asString(args.location);
    if (!title || !location) return { observation: 'error: "title" and "location" are required.' };
    ctx.session.counters.finding += 1;
    const id = `f${ctx.session.counters.finding}`;
    const testRunId = asString(args.test_run_id);
    const citedRun = testRunId ? ctx.session.testRuns.find((run) => run.id === testRunId) : undefined;
    const confirmed = Boolean(citedRun?.passed);
    const finding: AgentFinding = {
      id,
      title,
      severity: asEnum(args.severity, ["info", "low", "medium", "high", "critical"], "medium") as Severity,
      location,
      description: asString(args.description) ?? "",
      evidence: asString(args.evidence) ?? "",
      exploitSketch: asString(args.exploit_sketch) ?? "",
      fix: asString(args.fix) ?? "",
      confidence: clampFloat(args.confidence, 0, 1, 0.5),
      confirmationStatus: confirmed ? "confirmed-executable" : "suspected",
      ...(confirmed && citedRun ? { testRunId: citedRun.id } : {}),
    };
    ctx.session.findings.push(finding);
    await ctx.logger.event("hunt_finding", { id, severity: finding.severity, confirmationStatus: finding.confirmationStatus, location });
    let note = `recorded ${id} as ${finding.confirmationStatus} (${finding.severity}).`;
    if (testRunId && !citedRun) note += ` Note: test_run_id "${testRunId}" does not match any run_test in this session, so it stays suspected.`;
    else if (testRunId && citedRun && !citedRun.passed) note += ` Note: run ${testRunId} did not pass, so it stays suspected — fix the local test to confirm.`;
    return { observation: note, meta: { id, confirmationStatus: finding.confirmationStatus } };
  },
};

const recallTool: AgentTool = {
  name: "recall",
  description: 'Search durable memory from prior runs of this target. args: {"query": string, "limit"?: int}. Returns past notes (confirmed findings, dead ends, insights).',
  async run(args, ctx) {
    const query = asString(args.query) ?? "";
    const limit = clampInt(args.limit, 1, 20, 8);
    const notes = await ctx.memory.recall(query, limit);
    if (notes.length === 0) return { observation: "(no relevant memory)" };
    return {
      observation: notes.map((note) => `[${note.kind}] ${note.note}${note.sourceRef ? ` (ref: ${note.sourceRef})` : ""}`).join("\n"),
      meta: { count: notes.length },
    };
  },
};

const rememberTool: AgentTool = {
  name: "remember",
  description:
    'Persist a durable note for future runs of this target. args: {"note": string, "kind"?: "finding"|"dead-end"|"insight"|"note", "tags"?: [string], "source_ref"?: string}. Use it to bank what would save effort next time.',
  async run(args, ctx) {
    const note = asString(args.note);
    if (!note) return { observation: 'error: "note" is required.' };
    const stored = await ctx.memory.remember({
      note,
      kind: asEnum(args.kind, ["finding", "dead-end", "insight", "note"], "note") as never,
      tags: asStringList(args.tags),
      ...(asString(args.source_ref) ? { sourceRef: asString(args.source_ref) as string } : {}),
    });
    await ctx.logger.event("hunt_remember", { id: stored.id, kind: stored.kind });
    return { observation: `remembered (${stored.kind}).` };
  },
};

const finishTool: AgentTool = {
  name: "finish",
  description: 'End the hunt when you judge coverage is sufficient or further effort has low expected value. args: {"summary": string}.',
  async run(args, ctx) {
    ctx.session.finished = true;
    ctx.session.finishSummary = asString(args.summary) ?? "";
    return { observation: "hunt finished." };
  },
};

function selectDocs(ctx: ToolContext, kind: "source" | "corpus" | "all"): Doc[] {
  if (kind === "source") return ctx.source;
  if (kind === "corpus") return ctx.corpus;
  return [...ctx.source, ...ctx.corpus];
}

function findDoc(ctx: ToolContext, target: string): Doc | undefined {
  const all = [...ctx.source, ...ctx.corpus];
  return (
    all.find((doc) => doc.path === target) ??
    all.find((doc) => doc.path.endsWith(`/${target}`) || doc.path.endsWith(target)) ??
    all.find((doc) => doc.path.includes(target))
  );
}

function normalizeFiles(value: unknown, maxFileBytes: number): ReproductionFile[] {
  if (!Array.isArray(value)) return [];
  const out: ReproductionFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawPath = asString(record.path);
    const content = typeof record.content === "string" ? record.content : undefined;
    if (!rawPath || content === undefined || Buffer.byteLength(content, "utf8") > maxFileBytes) continue;
    out.push({ path: rawPath, content });
  }
  return out.slice(0, 8);
}

function normalizeCommand(value: unknown, args: Record<string, unknown>, cfg: AuditorConfig): ReproductionCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const program = asString(record.program);
  if (!program) return undefined;
  const commandArgs = Array.isArray(record.args) ? record.args.map((arg) => String(arg)).filter((arg) => arg.length > 0) : [];
  const command: ReproductionCommand = { program, args: commandArgs };
  const cwd = asString(record.cwd);
  if (cwd && cwd !== ".") command.cwd = cwd;
  command.timeoutMs = clampInt(record.timeoutMs ?? record.timeout_ms, 1000, cfg.reproductionCommandTimeoutMs, cfg.reproductionCommandTimeoutMs);
  command.expectedExitCode = clampInt(args.expected_exit_code ?? record.expectedExitCode ?? record.expected_exit_code, 0, 255, 0);
  return command;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return asString(value) ? [asString(value) as string] : [];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, 16);
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function countLines(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length;
}
