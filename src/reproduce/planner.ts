import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { buildReproductionPrompt, REPRODUCTION_SYSTEM } from "../agents/prompts.js";
import { selectFindingsForFollowUp } from "../audit/impact.js";
import { SourceIndex } from "../index/source-index.js";
import { renderProjectLearning } from "../learn/project.js";
import {
  firstBlockedSandboxCommand,
  firstBlockedSandboxFile,
  matchSuccessPatterns,
  normalizeRelativePath,
  prepareSandboxWorkspace,
  runSandboxCommand,
  safeName,
  writeSandboxFiles,
} from "../security/sandbox.js";
import type {
  ConfirmationStatus,
  Doc,
  LlmClient,
  ProjectLearning,
  RankedFinding,
  Reproduction,
  ReproductionCommand,
  ReproductionCommandResult,
  ReproductionFile,
  ReproductionPlan,
  Verification,
} from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonObject } from "../util/json.js";

export async function reproduceTop(input: {
  cfg: AuditorConfig;
  findings: RankedFinding[];
  verifications: Verification[];
  source: Doc[];
  projectLearning?: ProjectLearning;
  llm?: LlmClient;
  logger: RunLogger;
  topK: number;
}): Promise<Reproduction[]> {
  if (input.cfg.reproductionMode === "off" || input.topK <= 0) return [];

  const byId = new Map(input.verifications.map((verification) => [verification.id, verification]));
  const index = new SourceIndex(input.source);
  const out: Reproduction[] = [];
  const selectedFindings = selectFindingsForFollowUp(input.findings, input.topK, input.cfg);

  for (const finding of selectedFindings) {
    const verification = byId.get(finding.id);
    const sourceStatus = confirmationStatusFor(finding, verification);
    if (verification?.verdict === "false-positive") {
      out.push(skippedReproduction(finding, "Source verifier marked the finding false-positive."));
      continue;
    }

    if (input.cfg.dryRun || !input.llm) {
      out.push(skippedReproduction(finding, "Reproduction planning requires a live model client."));
      continue;
    }

    const sourceText = index.contextForItem(
      {
        id: finding.id,
        location: finding.location,
        securityProperty: finding.description,
        failureMode: finding.failureMode,
        why: finding.evidence,
      },
      input.cfg.contextCharBudget,
    );
    const prompt = buildReproductionPrompt({
      title: finding.title,
      location: finding.location,
      severity: finding.severity,
      description: finding.description,
      evidence: finding.evidence,
      fix: finding.fix,
      verification: verification?.markdown ?? "(not available)",
      projectLearning: renderProjectLearning(input.projectLearning),
      source: sourceText,
      maxCommands: input.cfg.reproductionMaxCommands,
      commandTimeoutMs: input.cfg.reproductionCommandTimeoutMs,
    });
    const raw = await input.llm.complete({
      tag: `reproduce_${finding.id}`,
      system: REPRODUCTION_SYSTEM,
      user: prompt,
      model: input.cfg.verifyModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    const plan = normalizePlan(raw, input.cfg);
    if (!plan || (plan.files.length === 0 && plan.commands.length === 0)) {
      out.push({
        id: `repro_${finding.id}`,
        findingId: finding.id,
        status: "needs-work",
        confirmationStatus: sourceStatus,
        ...(plan ? { plan } : {}),
        commandResults: [],
        markdown: renderReproductionMarkdown({
          title: finding.title,
          mode: input.cfg.reproductionMode,
          status: "needs-work",
          confirmationStatus: sourceStatus,
          ...(plan ? { plan } : {}),
          reason: "The ReproductionAgent could not produce an executable local test plan from the loaded context.",
        }),
      });
      continue;
    }

    if (input.cfg.reproductionMode === "plan") {
      out.push({
        id: `repro_${finding.id}`,
        findingId: finding.id,
        status: "planned",
        confirmationStatus: sourceStatus,
        plan,
        commandResults: [],
        markdown: renderReproductionMarkdown({
          title: finding.title,
          mode: input.cfg.reproductionMode,
          status: "planned",
          confirmationStatus: sourceStatus,
          plan,
          reason: "Execution was not requested. Run with reproductionMode=execute or --repro execute to create the temp workspace and run local tests.",
        }),
      });
      continue;
    }

    out.push(await executePlan({ cfg: input.cfg, finding, ...(verification ? { verification } : {}), sourceStatus, plan, logger: input.logger }));
  }

  await input.logger.artifact("reproductions.json", out);
  return out;
}

function normalizePlan(raw: string, cfg: AuditorConfig): ReproductionPlan | undefined {
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed) return undefined;
  const files = normalizeFiles(parsed.files, cfg.reproductionMaxFileBytes);
  const commands = normalizeCommands(parsed.commands, cfg);
  return {
    summary: cleanString(parsed.summary) || "Local-only reproduction plan.",
    files,
    commands,
    successCriteria: normalizeStringList(parsed.successCriteria ?? parsed.success_criteria),
    successPatterns: normalizeStringList(parsed.successPatterns ?? parsed.success_patterns),
    safetyNotes: normalizeStringList(parsed.safetyNotes ?? parsed.safety_notes),
  };
}

function normalizeFiles(value: unknown, maxFileBytes: number): ReproductionFile[] {
  if (!Array.isArray(value)) return [];
  const out: ReproductionFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawPath = cleanString(record.path);
    const content = typeof record.content === "string" ? record.content : undefined;
    if (!rawPath || content === undefined || Buffer.byteLength(content, "utf8") > maxFileBytes) continue;
    const normalizedPath = normalizeRelativePath(rawPath);
    if (!normalizedPath) continue;
    out.push({ path: normalizedPath, content });
  }
  return out.slice(0, 8);
}

function normalizeCommands(value: unknown, cfg: AuditorConfig): ReproductionCommand[] {
  if (!Array.isArray(value)) return [];
  const out: ReproductionCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const program = cleanString(record.program);
    const args = Array.isArray(record.args) ? record.args.map((arg) => String(arg)).filter((arg) => arg.length > 0) : [];
    if (!program) continue;
    const command: ReproductionCommand = { program, args };
    const cwd = cleanString(record.cwd);
    if (cwd && cwd !== ".") {
      const normalizedCwd = normalizeRelativePath(cwd);
      if (!normalizedCwd) continue;
      command.cwd = normalizedCwd;
    }
    const timeoutMs = numberInRange(record.timeoutMs ?? record.timeout_ms, 1000, cfg.reproductionCommandTimeoutMs, cfg.reproductionCommandTimeoutMs);
    command.timeoutMs = timeoutMs;
    const expectedExitCode = numberInRange(record.expectedExitCode ?? record.expected_exit_code, 0, 255, 0);
    command.expectedExitCode = expectedExitCode;
    out.push(command);
  }
  return out.slice(0, cfg.reproductionMaxCommands);
}

async function executePlan(input: {
  cfg: AuditorConfig;
  finding: RankedFinding;
  verification?: Verification;
  sourceStatus: ConfirmationStatus;
  plan: ReproductionPlan;
  logger: RunLogger;
}): Promise<Reproduction> {
  const blocked = firstBlockedSandboxCommand(input.plan.commands);
  if (blocked) {
    return {
      id: `repro_${input.finding.id}`,
      findingId: input.finding.id,
      status: "blocked",
      confirmationStatus: input.sourceStatus,
      plan: input.plan,
      commandResults: [],
      markdown: renderReproductionMarkdown({
        title: input.finding.title,
        mode: input.cfg.reproductionMode,
        status: "blocked",
        confirmationStatus: input.sourceStatus,
        plan: input.plan,
        reason: blocked,
      }),
      blockedReason: blocked,
    };
  }
  const blockedFile = firstBlockedSandboxFile(input.plan.files);
  if (blockedFile) {
    return {
      id: `repro_${input.finding.id}`,
      findingId: input.finding.id,
      status: "blocked",
      confirmationStatus: input.sourceStatus,
      plan: input.plan,
      commandResults: [],
      markdown: renderReproductionMarkdown({
        title: input.finding.title,
        mode: input.cfg.reproductionMode,
        status: "blocked",
        confirmationStatus: input.sourceStatus,
        plan: input.plan,
        reason: blockedFile,
      }),
      blockedReason: blockedFile,
    };
  }

  const workspace = await prepareSandboxWorkspace(
    input.cfg.sourcePaths,
    input.logger.runDir,
    path.posix.join("reproduction", safeName(input.finding.id), "workspace"),
  );
  await writeSandboxFiles(workspace.absolute, input.plan.files);
  const commandResults: ReproductionCommandResult[] = [];
  for (const command of input.plan.commands) {
    commandResults.push(await runSandboxCommand(command, workspace.absolute, input.cfg.reproductionMaxLogBytes, input.cfg.sourcePaths));
  }
  const exitStatusMatched = commandResults.length > 0 && commandResults.every((result) => result.exitCode === result.expectedExitCode && !result.timedOut);
  const patternCheck = matchSuccessPatterns(input.verification?.executableSuccessPatterns ?? [], commandResults);
  const confirmed = exitStatusMatched && patternCheck.missing.length === 0 && patternCheck.matched.length > 0;
  const status = confirmed ? "confirmed-executable" : "needs-work";
  const confirmationStatus = confirmed ? "confirmed-executable" : input.sourceStatus;
  return {
    id: `repro_${input.finding.id}`,
    findingId: input.finding.id,
    status,
    confirmationStatus,
    plan: input.plan,
    workspace: workspace.relative,
    commandResults,
    successPatternsMatched: patternCheck.matched,
    successPatternsMissing: patternCheck.missing,
    markdown: renderReproductionMarkdown({
      title: input.finding.title,
      mode: input.cfg.reproductionMode,
      status,
      confirmationStatus,
      plan: input.plan,
      commandResults,
      successPatternsMatched: patternCheck.matched,
      successPatternsMissing: patternCheck.missing,
      reason: confirmed
        ? "Local commands matched expected exit status and all machine-checkable success patterns."
        : reproductionFailureReason(exitStatusMatched, patternCheck),
    }),
  };
}

function renderReproductionMarkdown(input: {
  title: string;
  mode: string;
  status: string;
  confirmationStatus: ConfirmationStatus;
  plan?: ReproductionPlan;
  commandResults?: ReproductionCommandResult[];
  successPatternsMatched?: string[];
  successPatternsMissing?: string[];
  reason: string;
}): string {
  const commands = input.plan?.commands.map((command) => `- ${[command.program, ...command.args].join(" ")} (expected exit ${command.expectedExitCode ?? 0})`).join("\n") || "- (none)";
  const files = input.plan?.files.map((file) => `- ${file.path}`).join("\n") || "- (none)";
  const results = input.commandResults?.length
    ? input.commandResults
        .map((result) => `- ${[result.command.program, ...result.command.args].join(" ")}: exit=${result.exitCode ?? "null"} expected=${result.expectedExitCode} timedOut=${result.timedOut}`)
        .join("\n")
    : "- (not run)";
  const matched = input.successPatternsMatched?.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  const missing = input.successPatternsMissing?.map((entry) => `- ${entry}`).join("\n") || "- (none)";
  return `### ReproductionAgent

- Finding: ${input.title}
- Mode: ${input.mode}
- Status: ${input.status}
- Confirmation status: ${input.confirmationStatus}
- Reason: ${input.reason}

Planned files:
${files}

Planned commands:
${commands}

Command results:
${results}

Matched success patterns:
${matched}

Missing success patterns:
${missing}

Success criteria:
${input.plan?.successCriteria.map((entry) => `- ${entry}`).join("\n") || "- (none)"}

Safety notes:
${input.plan?.safetyNotes.map((entry) => `- ${entry}`).join("\n") || "- Local-only reproduction stage; no public network target is allowed."}`;
}

function skippedReproduction(finding: RankedFinding, reason: string): Reproduction {
  return {
    id: `repro_${finding.id}`,
    findingId: finding.id,
    status: "skipped",
    confirmationStatus: finding.confirmationStatus,
    commandResults: [],
    markdown: renderReproductionMarkdown({
      title: finding.title,
      mode: "off",
      status: "skipped",
      confirmationStatus: finding.confirmationStatus,
      reason,
    }),
  };
}

function confirmationStatusFor(finding: RankedFinding, verification: Verification | undefined): ConfirmationStatus {
  if (finding.confirmationStatus === "confirmed-executable") return "confirmed-executable";
  if (verification?.confirmationStatus === "confirmed-source") return "confirmed-source";
  return finding.confirmationStatus === "confirmed-source" ? "confirmed-source" : "suspected";
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => cleanString(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, 8);
}

function reproductionFailureReason(exitStatusMatched: boolean, patternCheck: { matched: string[]; missing: string[] }): string {
  if (!exitStatusMatched) return "At least one local reproduction command did not match its expected exit status.";
  if (patternCheck.missing.length > 0) return "Local commands exited as expected, but machine-checkable success patterns were missing.";
  return "Local reproduction did not produce a machine-checkable confirmation signal.";
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
