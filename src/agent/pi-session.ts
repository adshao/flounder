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
  deep?: boolean;
  deepFocus?: string;
  map?: boolean;
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
    // with no sandbox or confirmation gate) but KEEP our custom tools. Per the pi
    // SDK, "all" disables every tool (including custom) while "builtin" disables
    // only the defaults — so "builtin" is required to expose our isolated tools.
    noTools: "builtin",
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
    await session.prompt(buildSessionPrompt({
      cfg: input.cfg,
      fileManifest: input.fileManifest,
      ...(input.scopeNote ? { scopeNote: input.scopeNote } : {}),
      ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}),
      ...(input.deep ? { deep: true } : {}),
      ...(input.deepFocus ? { deepFocus: input.deepFocus } : {}),
      ...(input.map ? { map: true } : {}),
    }));
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

function buildSessionPrompt(input: { cfg: AuditorConfig; scopeNote?: string; fileManifest: string; memoryHint?: string; deep?: boolean; deepFocus?: string; map?: boolean }): string {
  const intro = input.map ? mapIntro() : input.deep ? deepIntro(input.deepFocus) : breadthIntro();
  return `${intro}

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

${input.map
    ? "Apply the three lenses and write scopes.json — the COMPLETE scope inventory (each: id, obligation, region, lenses, exposure, difficulty, score, why) — then stop. Do not deep-dive or prove bugs in this phase; coverage over depth."
    : input.deep
      ? "Begin the obligation-driven method: model the system, rank and commit to the most soundness-critical region (unless one is pinned above), then enumerate its obligations from design intent and discharge each by naming the enforcing line or flagging its absence. Record every obligation and its status to findings.json. Do not wrap up while obligations remain unchecked."
      : "Begin the audit. When you have investigated thoroughly and written findings.json, stop."}`;
}

function mapIntro(): string {
  return `You are an autonomous white-hat security auditor doing the MAP phase: enumerate the COMPLETE set of audit SCOPES for this target. You are NOT finding or proving bugs yet — a later phase deep-audits each scope. Your job is COVERAGE, not a ranked shortlist that drops things.

Apply THREE lenses (general method, not a hint about this target); be exhaustive, over-list rather than silently omit:
1. SPEC CONDITIONS — read the design/spec material under corpus/ (and higher-level code) and list every security statement the system must enforce; each maps to the code that enforces it. A stated condition with NO enforcing code is itself a scope.
2. VALUE / ASSET FLOW — every place value or authority is created, destroyed, transferred, or authorized, and the gate on each.
3. TRUSTED-BUT-UNBOUND INPUTS — every attacker-controlled value (witnessed/decoded/assigned/external) later logic trusts; the scope is "what binds this to its required value?". A trusted value with no visible binding is the highest-value scope.

Do not judge importance by gut feel or "looks like a bug". A region whose link to the asset is indirect (e.g. a key/address-integrity check that only matters because breaking it enables a later double-spend) MUST still be listed — those are exactly what a rank-and-pick misses. Assign each scope: exposure (critical|high|medium|low, by asset at risk), difficulty (high|medium|low, how hard to be sure it is correct), score (0-10, only to order the dig phase; low score defers, never drops).

Write scopes.json at the workspace root EARLY — after a first broad pass — then UPDATE it (rewrite the full array) as you find more, so a complete-as-of-now inventory survives if you run out of budget. It is a JSON array of {"id","obligation","region":"file:lines","lenses":[...],"exposure","difficulty","score","why"}. On a large codebase do NOT read every file first — use bash (ls/grep for public/external entrypoints, state writes, value transfers) to enumerate, and spend little per scope (broad and shallow). You CANNOT modify the target source.`;
}

function breadthIntro(): string {
  return `You are an autonomous white-hat security auditor working on AUTHORIZED source code that has been copied into your working directory.
Your goal is to find real, exploitable, high-impact security vulnerabilities and to prove them.

You are in full control of the investigation. There is no fixed checklist and no required bug taxonomy. Decide for yourself what to read, what to suspect, which hypotheses to test, and when to stop. Use the full depth of your own security knowledge: form a model of what the code must guarantee (its invariants and trust boundaries), then look for where the implementation lets an attacker break that guarantee.

General method (applies to any code, not a hint about this target): for every value the code trusts — especially anything assigned, witnessed, decoded, or taken as input — explicitly ask "what MUST this equal for the security property to hold, and is there a visible check/constraint that enforces it?" A value later logic relies on but nothing binds to its required value is a classic bug. Reaching a file is not auditing it: when a component looks standard, state the exact invariant it must satisfy and find the line that enforces it before concluding it is correct. Trust nothing external as ground truth: agreement with a reference implementation, an upstream version, a spec, a book, or a prior audit is NOT evidence of correctness — the reference can carry the same bug, and some bugs live in the canonical implementation itself. Never clear a component because it "matches upstream", looks "standard", or matches the spec; clear it only by naming the exact invariant and the constraint that enforces it, or by an executable counterexample. Reason from the security property itself, not from what the materials say the code does. Record credible suspicions to findings.json as hypotheses (with location and why) as you go — do not hold them only in your head.`;
}

function deepIntro(deepFocus?: string): string {
  const focus = deepFocus && deepFocus.trim().length > 0 ? deepFocus.trim() : "";
  return `You are an autonomous white-hat security auditor performing a DEEP, NARROW-SCOPE audit of AUTHORIZED source code copied into your working directory.
This is NOT a breadth survey. You are auditing a small, high-criticality slice to a much higher standard of rigor: either prove it enforces every security property it is responsible for, or find the exact point where it does not.

${focus ? `Focus region (pinned): ${focus}. Audit this region.` : "No focus is pinned: first model the system and RANK the most soundness-critical region (a region is critical when a top-level balance/supply/authorization/uniqueness/integrity property the whole system depends on is ENFORCED there), commit your budget to it, and record your ranked shortlist to findings.json early."}

Obligation-driven method (general, not a hint about this target):
- ENUMERATE obligations from DESIGN INTENT, not the code's appearance. Read the design material under corpus/ and the higher-level code that USES this region to determine what it is SUPPOSED to guarantee. Write each obligation explicitly as "value/relationship X must equal/hold Y for property P". The code cannot tell you what it should enforce; the intent does.
- DISCHARGE each obligation one at a time. Finding that "a constraint exists" is NOT discharge: state exactly what the constraint binds the value to and confirm that referent is the value the obligation actually requires — not merely an adjacent/internal value, and not merely a relationship among witnessed values when the property names a specific trusted source. A value bound to the wrong referent leaves the obligation UNMET.
- A MISSING enforcing constraint is the finding. Missing-constraint bugs look like ordinary assignment/witnessing on every line — reason from the obligation, never from whether the code "looks standard", "matches upstream", or is "the canonical implementation" (the reference can carry the same bug; some bugs live in the canonical code itself).
- Record every obligation and its status (discharged-with-line / UNMET / uncertain) to findings.json as you go; an UNMET obligation is a finding (or a hypothesis with location and the exact missing edge).`;
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
