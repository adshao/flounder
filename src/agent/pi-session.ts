import { getModel, getProviders } from "@earendil-works/pi-ai";
import { createAgentSession, defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuditorConfig } from "../config.js";
import type { RunLogger } from "../trace/logger.js";
import type { TranscriptStep } from "./prompts.js";
import type { AgentTool, ToolContext } from "./tools.js";

// Continuous-session driver (point 5). Instead of re-driving a stateless
// complete() once per step — which re-sends the whole transcript every turn and
// burns quota quadratically — this hands the loop to a pi-coding-agent
// AgentSession. The session keeps context server-side and natively orchestrates
// tool calls. The framework's job stays the same: it registers ONLY the
// sandboxed tools (read/write/edit/bash with the confirmation gate) so isolation
// and the no-confirmation-no-finding guarantee still hold; the model owns
// strategy. Per project constraint this targets pi providers (e.g. openai-codex),
// not claude-code.

export interface SessionDriverResult {
  steps: TranscriptStep[];
  stoppedReason: "finished" | "error" | "step-budget";
}

export function isPiSessionProvider(provider: string): boolean {
  // CLI fallbacks and the mock are driven by the legacy complete() loop; only
  // real pi-ai providers can run a continuous AgentSession.
  if (provider === "claude-code" || provider === "codex-cli" || provider === "mock") return false;
  try {
    return getProviders().includes(provider as never);
  } catch {
    return false;
  }
}

export async function runHuntSession(input: {
  cfg: AuditorConfig;
  ctx: ToolContext;
  tools: AgentTool[];
  logger: RunLogger;
  cwd: string;
  scopeNote?: string;
  fileManifest: string;
  memoryHint?: string;
}): Promise<SessionDriverResult> {
  const model = getModelSafe(input.cfg.provider, input.cfg.auditModel);
  if (!model) throw new Error(`hunt session: unknown provider/model ${input.cfg.provider}/${input.cfg.auditModel}`);

  const steps: TranscriptStep[] = [];
  let stepNo = 0;
  const customTools = input.tools.map((tool) => toPiTool(tool, input.ctx, () => (stepNo += 1), steps));

  const { session } = await createAgentSession({
    model,
    thinkingLevel: mapThinkingLevel(input.cfg.thinkingLevel),
    // Disable pi's built-in read/bash/edit/write (they touch the real filesystem
    // with no sandbox or confirmation gate) and expose only our isolated tools.
    noTools: "all",
    customTools,
    cwd: input.cwd,
    sessionManager: SessionManager.inMemory(),
  });

  // Budget: the continuous session runs until the model stops on its own. Cap the
  // number of model turns so a real run cannot grow unbounded in cost/time.
  const maxTurns = Math.max(1, Math.floor(input.cfg.huntMaxSteps));
  let turns = 0;
  let budgetAborted = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      void input.logger.event("hunt_step", { step: stepNo + 1, tool: event.toolName });
    } else if (event.type === "tool_execution_end" && event.isError) {
      void input.logger.event("hunt_tool_error", { tool: event.toolName });
    } else if (event.type === "turn_end") {
      turns += 1;
      if (turns >= maxTurns && !budgetAborted) {
        budgetAborted = true;
        void input.logger.event("hunt_session_budget", { turns, maxTurns });
        void session.abort();
      }
    }
  });

  try {
    await session.prompt(buildSessionPrompt(input));
    return { steps, stoppedReason: budgetAborted ? "step-budget" : "finished" };
  } catch (error) {
    if (budgetAborted) return { steps, stoppedReason: "step-budget" };
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.event("hunt_session_error", { error: message.slice(0, 500) });
    // Authentication is an environment setup step, not a finding. Surface it
    // loudly and actionably instead of silently producing zero findings.
    if (looksLikeAuthError(message)) {
      throw new Error(
        `hunt session could not authenticate provider "${input.cfg.provider}". Log pi into the provider (e.g. \`pi\` then /login for ${input.cfg.provider}), or run with --mock-llm for an offline check. Underlying: ${message.slice(0, 300)}`,
      );
    }
    steps.push({ n: stepNo + 1, thought: "", tool: "(session-error)", args: {}, observation: message.slice(0, 500) });
    return { steps, stoppedReason: "error" };
  } finally {
    unsubscribe();
    await shutdownSession(session);
  }
}

function looksLikeAuthError(message: string): boolean {
  return /no api key|not logged in|unauthorized|authenticate|\/login|oauth|credential/i.test(message);
}

function toPiTool(tool: AgentTool, ctx: ToolContext, nextStep: () => number, steps: TranscriptStep[]): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: toolSchemas[tool.name] ?? Type.Object({}, { additionalProperties: true }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const n = nextStep();
      let observation: string;
      try {
        const result = await tool.run(args, ctx);
        observation = result.observation;
      } catch (error) {
        observation = `error: tool "${tool.name}" failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      steps.push({ n, thought: "", tool: tool.name, args, observation });
      return { content: [{ type: "text", text: observation }], details: {} };
    },
  });
}

const toolSchemas: Record<string, ReturnType<typeof Type.Object>> = {
  read: Type.Object({
    path: Type.String(),
    start: Type.Optional(Type.Integer()),
    end: Type.Optional(Type.Integer()),
  }),
  write: Type.Object({
    path: Type.String(),
    content: Type.String(),
  }),
  edit: Type.Object({
    path: Type.String(),
    old: Type.String(),
    new: Type.String(),
    replace_all: Type.Optional(Type.Boolean()),
  }),
  bash: Type.Object({
    cmd: Type.String(),
    purpose: Type.Optional(Type.Union([Type.Literal("inspect"), Type.Literal("confirm")])),
    cwd: Type.Optional(Type.String()),
    success_patterns: Type.Optional(Type.Array(Type.String())),
    expected_exit_code: Type.Optional(Type.Integer()),
    timeout_ms: Type.Optional(Type.Integer()),
  }),
};

function buildSessionPrompt(input: { cfg: AuditorConfig; scopeNote?: string; fileManifest: string; memoryHint?: string }): string {
  return `You are an autonomous white-hat security auditor working on AUTHORIZED source code that has been copied into your working directory.
Your goal is to find real, exploitable, high-impact security vulnerabilities and to prove them.

You are in full control of the investigation. There is no fixed checklist and no required bug taxonomy. Decide for yourself what to read, what to suspect, which hypotheses to test, and when to stop. Use the full depth of your own security knowledge: form a model of what the code must guarantee (its invariants and trust boundaries), then look for where the implementation lets an attacker break that guarantee.

General method (applies to any code, not a hint about this target): for every value the code trusts — especially anything assigned, witnessed, decoded, or taken as input — explicitly ask "what MUST this equal for the security property to hold, and is there a visible check/constraint that enforces it?" A value later logic relies on but nothing binds to its required value is a classic bug. Reaching a file is not auditing it: when a component looks standard, state the exact invariant it must satisfy and find the line that enforces it before concluding it is correct. Trust nothing external as ground truth: agreement with a reference implementation, an upstream version, a spec, a book, or a prior audit is NOT evidence of correctness — the reference can carry the same bug, and some bugs live in the canonical implementation itself. Never clear a component because it "matches upstream", looks "standard", or matches the spec; clear it only by naming the exact invariant and the constraint that enforces it, or by an executable counterexample. Reason from the security property itself, not from what the materials say the code does. Record credible suspicions to findings.json as hypotheses (with location and why) as you go — do not hold them only in your head.

Use the provided tools to investigate:
- read: read loaded source/corpus or files you create in the sandbox.
- write / edit: create or modify your own test/scratch files inside the copied workspace. You CANNOT modify the target source under audit — write tests as new files; to show a fix, declare it in the finding's "fix" field and the framework applies it during confirmation.
- bash: run one local command. Use purpose="inspect" to explore (ls/find/rg/cat). Use purpose="confirm" to PROVE a bug with a real local test/build runner (cargo test, forge test, go test, node --test, pytest, …) and declared success_patterns.

How to report:
- Record candidates by writing findings.json at the workspace root: a JSON array of objects with fields title, severity (info|low|medium|high|critical), location ("file:line"), description, evidence, exploit_sketch, fix, confidence (0..1), and optionally command_id.
- The one hard rule the framework enforces: a claim is only confirmed-executable if it cites command_id of a purpose=confirm bash run that actually passed. Everything else is recorded as an unconfirmed hypothesis.
- A confirm test must exercise the ACTUAL vulnerable code path: construct the malicious input or condition and show the code accepts it or the invariant breaks. A test that merely prints a success string without triggering the bug proves nothing — do not cite it. The dependency toolchain is prepared automatically on your first test run, so allow extra time for that first compile.
- For the STRONGEST confirmation (confirmed-differential), also supply on the finding: "fix_patch": {"path": target-source file, "old": exact text to replace, "new": the minimal fix}, and "patched_success_patterns": [strings your test prints once the exploit is BLOCKED]. The framework applies your fix to the pristine source and re-runs your test: a real bug's exploit reproduces before the fix and is blocked after it. You cannot apply the fix yourself (you may not modify target source) — that is deliberate, so the proof is the framework's, not yours.

White-hat boundaries (non-negotiable):
- Verification is local-only: unit tests, component tests, local regtest/devnet, or forked/fake nodes. Never target a public testnet, mainnet, production, or any live network.
- Do not write value-extraction exploits, broadcast transactions, exfiltrate data, or read secrets. Prove the bug; do not weaponize it.
- Ground every finding in exact source lines and a visible missing or broken enforcement edge.

Authorized scope note:
${input.scopeNote && input.scopeNote.trim().length > 0 ? input.scopeNote.trim() : "(none provided — treat all loaded source as in scope)"}

Durable memory from prior runs of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Loaded source files:
${input.fileManifest}

Begin the audit. When you have investigated thoroughly and written findings.json, stop.`;
}

function getModelSafe(provider: string, modelId?: string): ReturnType<typeof getModel> | undefined {
  try {
    return getModel(provider as never, (modelId ?? "") as never) ?? undefined;
  } catch {
    return undefined;
  }
}

export function mapThinkingLevel(level: AuditorConfig["thinkingLevel"]): AuditorConfig["thinkingLevel"] {
  return level;
}

async function shutdownSession(session: unknown): Promise<void> {
  const candidate = session as { shutdown?: () => unknown; dispose?: () => unknown };
  try {
    if (typeof candidate.shutdown === "function") await candidate.shutdown();
    else if (typeof candidate.dispose === "function") await candidate.dispose();
  } catch {
    // best-effort cleanup
  }
}
