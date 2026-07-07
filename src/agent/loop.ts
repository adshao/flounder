import type { AuditorConfig } from "../config.js";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import { extractJsonArray, extractJsonObject } from "../util/json.js";
import { buildConfirmKickoff, buildDeepKickoff, buildAuditKickoff, buildMapKickoff, buildSynthesisKickoff, buildVerifyKickoff, AUDIT_CONFIRM_SYSTEM, AUDIT_DEEP_SYSTEM, AUDIT_SYNTHESIS_SYSTEM, AUDIT_SYSTEM, AUDIT_VERIFY_SYSTEM, MAP_SYSTEM, renderTranscript, type TranscriptStep } from "./prompts.js";
import { describeAction, type AgentTool, type ToolContext } from "./tools.js";

// Provider-agnostic ReAct driver. It runs on top of the plain text-in/text-out
// LlmClient.complete, so it works identically for pi-ai, the CLI fallbacks, and
// the deterministic mock. The framework's role here is mechanism only: parse one
// action, run the tool, feed back the observation, enforce the step budget, and
// record a replayable transcript. It never injects strategy.

export interface AuditLoopResult {
  steps: TranscriptStep[];
  stoppedReason: "finished" | "step-budget" | "stalled";
}

export async function runAuditLoop(input: {
  cfg: AuditorConfig;
  llm: LlmClient;
  tools: AgentTool[];
  ctx: ToolContext;
  logger: RunLogger;
  maxSteps: number;
  scopeNote?: string;
  fileManifest: string;
  memoryHint?: string;
  /** Deep narrow-scope audit posture (obligation-driven, no breadth/wrap-up pressure). */
  deep?: boolean;
  deepFocus?: string;
  /** Map (scope-enumeration) phase: writes scopes.json instead of findings.json. */
  map?: boolean;
  /** Append-map mode: existing inventory snapshot the model should avoid duplicating. */
  mapExistingScopesPath?: string;
  mapExistingScopesCount?: number;
  /** Verify posture: confirm-or-refute ONE specific suspected finding (the claim text). */
  verify?: string;
  /** Synthesis mode: compose per-scope deep-audit output into cross-component findings. */
  synthesize?: string;
  /** Confirm mode: open-world reproduce/consolidate/decide over a prior run's findings (the seed text). */
  confirm?: string;
  /** Base backoff for transient-throttle retries; overridable for tests. */
  transientRetryBaseMs?: number;
}): Promise<AuditLoopResult> {
  const transientRetryBaseMs = input.transientRetryBaseMs ?? 4000;
  // An unbounded budget (the sealed verbs' default) is capped to a large finite ceiling
  // here so this legacy/mock loop cannot spin forever if a model never emits done; the
  // continuous pi-session driver (used for real runs) handles non-finite budgets natively.
  const unboundedSteps = !Number.isFinite(input.maxSteps);
  const maxSteps = unboundedSteps ? 100000 : input.maxSteps;
  const systemPrompt = input.confirm ? AUDIT_CONFIRM_SYSTEM : input.synthesize ? AUDIT_SYNTHESIS_SYSTEM : input.verify ? AUDIT_VERIFY_SYSTEM : input.map ? MAP_SYSTEM : input.deep ? AUDIT_DEEP_SYSTEM : AUDIT_SYSTEM;
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const kickoffCommon = {
    target: input.cfg.targetName,
    tools: input.tools,
    fileManifest: input.fileManifest,
    maxSteps: input.maxSteps,
    ...(input.scopeNote ? { scopeNote: input.scopeNote } : {}),
    ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}),
  };
  const kickoff = input.confirm
    ? buildConfirmKickoff({ ...kickoffCommon, confirm: input.confirm })
    : input.synthesize
      ? buildSynthesisKickoff({ ...kickoffCommon, synthesize: input.synthesize })
      : input.verify
      ? buildVerifyKickoff({ ...kickoffCommon, verify: input.verify })
      : input.map
        ? buildMapKickoff({ ...kickoffCommon, ...(input.mapExistingScopesPath ? { mapExistingScopesPath: input.mapExistingScopesPath } : {}), ...(input.mapExistingScopesCount !== undefined ? { mapExistingScopesCount: input.mapExistingScopesCount } : {}) })
        : input.deep
          ? buildDeepKickoff({ ...kickoffCommon, ...(input.deepFocus ? { deepFocus: input.deepFocus } : {}) })
          : buildAuditKickoff(kickoffCommon);
  const steps: TranscriptStep[] = [];
  let consecutiveParseErrors = 0;

  const finalizeThreshold = unboundedSteps ? 0 : Math.max(4, Math.floor(maxSteps * 0.35));

  // Framework guarantee: a run must not end empty. If the model never wrote
  // findings.json (it tends to keep investigating "one more lead" until cut off),
  // make one dedicated call that extracts its confirmed findings AND every
  // residual hypothesis into findings.json. Skips when the model is unresponsive
  // (e.g. provider quota), where another call would also fail.
  const finalizeFindings = async (): Promise<void> => {
    if (input.map || input.confirm) return; // map writes scopes.json; confirm writes confirm_decision.json
    if (input.ctx.session.scratchFiles.has("findings.json")) return;
    const ask = `Your audit is ending now. Output ONLY a JSON array for findings.json and nothing else (no prose, no fences): every confirmed finding AND every residual hypothesis you formed, each as {"title","severity","location","description","evidence","exploit_sketch","fix","confidence","command_id"?}. Include lower-confidence hypotheses with their location and why they are suspected. If you genuinely found nothing, output [].`;
    try {
      const raw = await input.llm.complete({
        tag: "audit_finalize",
        system: systemPrompt,
        user: `${kickoff}\n\n===== TRANSCRIPT SO FAR =====\n${renderTranscript(steps)}\n\n===== FINALIZE =====\n${ask}`,
        model: input.cfg.auditModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
        agentic: true,
      });
      const items = extractJsonArray<unknown>(raw);
      if (Array.isArray(items)) {
        input.ctx.session.scratchFiles.set("findings.json", JSON.stringify(items));
        await input.logger.event("audit_finalize", { items: items.length });
      }
    } catch (error) {
      await input.logger.event("audit_finalize_error", { error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  };
  // Each phase (map, then each dig) is its own loop over the shared session. Clear
  // the done flag so a previous phase's completion does not abort this one after
  // its first step.
  input.ctx.session.finished = false;
  delete input.ctx.session.finishSummary;
  for (let n = 1; n <= maxSteps; n += 1) {
    const remaining = maxSteps - n + 1;
    // Budget awareness + finalization: the model otherwise investigates until it
    // is cut off and records nothing. Tell it the budget every turn, and near the
    // end force it to write findings.json (findings + best hypotheses) so a deep
    // investigation always produces something.
    const budgetLine = unboundedSteps
      ? `You are on step ${n}. There is no fixed action cap; continue until the phase is genuinely complete, then emit done.`
      : `You are on step ${n} of ${maxSteps} (${remaining} action${remaining === 1 ? "" : "s"} left).`;
    // Deep mode keeps checking obligations to the end — it must NOT be told to
    // stop investigating; it is told to keep findings.json current. Breadth mode
    // is told to stop opening new leads and write out its hypotheses.
    const finalizeLine =
      remaining > finalizeThreshold
        ? ""
        : input.map
          ? input.mapExistingScopesPath
            ? "\nBUDGET LOW — write scopes.json NOW with only the NEW non-duplicate scopes you found beyond map_existing_scopes.json (each with id, obligation, region, score as integer 0-100), then emit done. Unrecorded new scopes are lost."
            : "\nBUDGET LOW — write scopes.json NOW with the COMPLETE scope inventory you have so far (each with id, obligation, region, score as integer 0-100), then emit done. Unrecorded scopes are lost."
          : input.deep
            ? "\nBUDGET LOW — make sure findings.json records EVERY obligation and its status (discharged-with-line / UNMET / uncertain). Keep working through the remaining obligations; an UNMET obligation with its exact missing edge is a finding. Unrecorded obligations are lost."
            : "\nALMOST OUT OF STEPS — do not open new investigations. Write findings.json NOW with any confirmed findings AND your best unconfirmed hypotheses (each with location and why it is suspected), then emit done. Unrecorded hypotheses are lost.";
    const user = `${kickoff}\n\n===== TRANSCRIPT SO FAR =====\n${renderTranscript(steps)}\n\n===== YOUR NEXT ACTION =====\n${budgetLine}${finalizeLine}\nRespond with one JSON tool action or done object.`;
    // Transient throttles (provider rate limits, overload, timeouts) are retried
    // with backoff rather than counted toward the stall guard — a short server-side
    // rate limit should not kill a whole run.
    let raw: string | undefined;
    let modelError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        raw = await input.llm.complete({
          tag: "audit",
          system: systemPrompt,
          user,
          model: input.cfg.auditModel,
          maxTokens: input.cfg.maxTokens,
          thinkingLevel: input.cfg.thinkingLevel,
          agentic: true,
        });
        modelError = undefined;
        break;
      } catch (error) {
        modelError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientError(message) && attempt < MAX_TRANSIENT_RETRIES) {
          const waitMs = Math.min(60_000, transientRetryBaseMs * 2 ** attempt);
          await input.logger.event("audit_transient_retry", { step: n, attempt: attempt + 1, waitMs });
          await sleep(waitMs);
          continue;
        }
        break;
      }
    }
    if (raw === undefined) {
      const message = modelError instanceof Error ? modelError.message : String(modelError);
      await input.logger.event("audit_model_error", { step: n, error: message.slice(0, 500) });
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
        observation:
          'error: could not parse a JSON action. Respond with exactly one object: {"thought": "...", "tool": "...", "args": {...}} or {"thought": "...", "done": true, "summary": "..."}',
      });
      await input.logger.event("audit_parse_error", { step: n });
      if (consecutiveParseErrors >= 3) return { steps, stoppedReason: "stalled" };
      continue;
    }
    consecutiveParseErrors = 0;

    if (action.done) {
      input.ctx.session.finished = true;
      input.ctx.session.finishSummary = action.summary;
      steps.push({ n, thought: action.thought, tool: "(done)", args: {}, observation: action.summary || "audit finished." });
      await input.logger.event("audit_step", { step: n, tool: "(done)" });
      await finalizeFindings();
      return { steps, stoppedReason: "finished" };
    }

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
    const a = describeAction(action.tool, action.args, observation);
    await input.logger.event("audit_action", { step: n, tool: action.tool, detail: a.detail, ok: a.ok, result: a.result });

    if (input.ctx.session.finished) {
      await finalizeFindings();
      return { steps, stoppedReason: "finished" };
    }
  }

  await finalizeFindings();
  return { steps, stoppedReason: "step-budget" };
}

const MAX_TRANSIENT_RETRIES = 5;

// A transient throttle (provider-side rate limit, overload, gateway/timeout) is
// retryable and should not count toward the stall guard. A genuine usage-limit
// exhaustion is NOT transient (the daily quota is gone) — it falls through to the
// stall path, where retrying would also fail.
export function isTransientError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("not your usage limit")) return true; // explicit transient server throttle
  if (m.includes("usage limit") || m.includes("quota")) return false; // real exhaustion
  return /\b429\b|\b502\b|\b503\b|\b504\b|rate.?limit|temporarily|overloaded|timed? ?out|timeout|econnreset|etimedout|socket hang up/.test(m);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedAction {
  thought: string;
  tool: string;
  args: Record<string, unknown>;
  done: boolean;
  summary: string;
}

function parseAction(raw: string): ParsedAction | undefined {
  const parsed = extractJsonObject<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const thought = typeof parsed.thought === "string" ? parsed.thought.trim() : "";
  if (parsed.done === true) {
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return { thought, tool: "(done)", args: {}, done: true, summary };
  }
  const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : "";
  if (!tool) return undefined;
  const args = parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args) ? (parsed.args as Record<string, unknown>) : {};
  return { thought, tool, args, done: false, summary: "" };
}
