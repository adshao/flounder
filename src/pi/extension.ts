import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent, type UserBashEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultConfig } from "../config.js";
import { runAudit } from "../agent/audit.js";
import { analyzeCommandSafety } from "../security/policy.js";

export default function fullStackAuditorExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fsa_run",
    label: "Autonomous Security Audit",
    description:
      "Run the thin agentic audit: the model drives its own investigation with pi-style read/write/edit/bash tools. The framework supplies capability and verification, not a checklist. Verification is local-only; a finding only reaches confirmed-executable when a sandboxed local command passes. Requires a live model provider.",
    parameters: Type.Object({
      target: Type.String({ description: "Target name used for run artifacts and durable memory." }),
      sourcePaths: Type.Array(Type.String(), { description: "Local authorized source files or directories to audit." }),
      corpusPaths: Type.Optional(Type.Array(Type.String(), { description: "Local spec/reference files or directories." })),
      provider: Type.Optional(Type.String({ description: "pi-ai provider, for example openai; use codex-cli or claude-code only as explicit local CLI fallbacks." })),
      model: Type.Optional(Type.String({ description: "Model id used to drive the agent loop." })),
      maxSteps: Type.Optional(Type.Number({ description: "Maximum agent actions before stopping. Default 40." })),
      scopeNote: Type.Optional(Type.String({ description: "One-line authorized-scope hint surfaced to the agent." })),
      outputDir: Type.Optional(Type.String({ description: "Artifact output directory." })),
      historyDir: Type.Optional(Type.String({ description: "Project history directory. Defaults to outputDir/history." })),
    }),
    async execute(_toolCallId, params) {
      const cfg = defaultConfig();
      cfg.targetName = params.target;
      cfg.sourcePaths = params.sourcePaths;
      cfg.corpusPaths = params.corpusPaths ?? [];
      cfg.provider = params.provider ?? cfg.provider;
      if (params.model) cfg.auditModel = params.model;
      if (typeof params.maxSteps === "number" && Number.isFinite(params.maxSteps)) cfg.auditMaxSteps = Math.max(1, Math.floor(params.maxSteps));
      if (params.scopeNote) cfg.auditScopeNote = params.scopeNote;
      cfg.outputDir = params.outputDir ?? cfg.outputDir;
      if (params.historyDir !== undefined) cfg.historyDir = params.historyDir;
      cfg.auditDeep = true; // fsa_run = map -> audit, matching the `fsa run` CLI verb

      const result = await runAudit(cfg);
      const confirmed = result.summary.findings.filter((finding) => finding.confirmationStatus === "confirmed-executable").length;
      return {
        content: [
          {
            type: "text",
            text: `Run dir: ${result.runDir}\nFindings: ${result.summary.findings.length} (confirmed-executable: ${confirmed})\nBy severity: ${JSON.stringify(result.summary.coverage.bySeverity)}`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerCommand("fsa", {
    description: "Show full-stack-auditor usage.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Use the fsa_run tool or run `fsa run --target <name> --source <paths...>` from the terminal.", "info");
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const decision = analyzeCommandSafety(event.input.command);
    if (decision.blocked) {
      return {
        block: true,
        reason: decision.reason ?? "Blocked by full-stack-auditor.",
      };
    }
    return undefined;
  });

  pi.on("user_bash", async (event: UserBashEvent) => {
    const decision = analyzeCommandSafety(event.command);
    if (!decision.blocked) return undefined;
    return {
      result: {
        output: decision.reason ?? "Blocked by full-stack-auditor.",
        exitCode: 2,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
