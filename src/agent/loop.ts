import type { AuditorConfig } from "../config.js";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonObject } from "../util/json.js";
import { buildHuntKickoff, HUNT_SYSTEM, renderTranscript, type TranscriptStep } from "./prompts.js";
import type { AgentTool, ToolContext } from "./tools.js";

// Provider-agnostic ReAct driver. It runs on top of the plain text-in/text-out
// LlmClient.complete, so it works identically for pi-ai, the CLI fallbacks, and
// the deterministic mock. The framework's role here is mechanism only: parse one
// action, run the tool, feed back the observation, enforce the step budget, and
// record a replayable transcript. It never injects strategy.

export interface HuntLoopResult {
  steps: TranscriptStep[];
  stoppedReason: "finished" | "step-budget" | "stalled";
}

export async function runHuntLoop(input: {
  cfg: AuditorConfig;
  llm: LlmClient;
  tools: AgentTool[];
  ctx: ToolContext;
  logger: RunLogger;
  maxSteps: number;
  scopeNote?: string;
  fileManifest: string;
  memoryHint?: string;
}): Promise<HuntLoopResult> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const kickoff = buildHuntKickoff({
    target: input.cfg.targetName,
    tools: input.tools,
    fileManifest: input.fileManifest,
    maxSteps: input.maxSteps,
    ...(input.scopeNote ? { scopeNote: input.scopeNote } : {}),
    ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}),
  });
  const steps: TranscriptStep[] = [];
  let consecutiveParseErrors = 0;

  for (let n = 1; n <= input.maxSteps; n += 1) {
    const user = `${kickoff}\n\n===== TRANSCRIPT SO FAR =====\n${renderTranscript(steps)}\n\n===== YOUR NEXT ACTION =====\nRespond with one JSON action.`;
    let raw: string;
    try {
      raw = await input.llm.complete({
        tag: "hunt",
        system: HUNT_SYSTEM,
        user,
        model: input.cfg.auditModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.logger.event("hunt_model_error", { step: n, error: message.slice(0, 500) });
      steps.push({ n, thought: "", tool: "(model-error)", args: {}, observation: `model error: ${message.slice(0, 300)}` });
      if (++consecutiveParseErrors >= 3) return { steps, stoppedReason: "stalled" };
      continue;
    }

    const action = parseAction(raw);
    if (!action) {
      consecutiveParseErrors += 1;
      steps.push({
        n,
        thought: "",
        tool: "(parse-error)",
        args: {},
        observation: 'error: could not parse a JSON action. Respond with exactly one object: {"thought": "...", "tool": "...", "args": {...}}.',
      });
      await input.logger.event("hunt_parse_error", { step: n });
      if (consecutiveParseErrors >= 3) return { steps, stoppedReason: "stalled" };
      continue;
    }
    consecutiveParseErrors = 0;

    const tool = toolsByName.get(action.tool);
    if (!tool) {
      steps.push({
        n,
        thought: action.thought,
        tool: action.tool,
        args: action.args,
        observation: `error: unknown tool "${action.tool}". Available: ${input.tools.map((t) => t.name).join(", ")}.`,
      });
      continue;
    }

    let observation: string;
    try {
      const result = await tool.run(action.args, input.ctx);
      observation = result.observation;
    } catch (error) {
      observation = `error: tool "${action.tool}" failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    steps.push({ n, thought: action.thought, tool: action.tool, args: action.args, observation });
    await input.logger.event("hunt_step", { step: n, tool: action.tool });

    if (input.ctx.session.finished) return { steps, stoppedReason: "finished" };
  }

  return { steps, stoppedReason: "step-budget" };
}

interface ParsedAction {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
}

function parseAction(raw: string): ParsedAction | undefined {
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
  if (!tool) return undefined;
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? (parsed.args as Record<string, unknown>) : {};
  const thought = typeof parsed.thought === "string" ? parsed.thought.trim() : "";
  return { thought, tool, args };
}
