import { getModel, getProviders } from "@earendil-works/pi-ai";
import { createAgentSession, defineTool, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuditorConfig } from "../config.js";
import type { RunLogger } from "../trace/logger.js";
import type { LlmClient } from "../types.js";
import { AUDIT_CONFIRM_SYSTEM, AUDIT_PREPARE_SYSTEM, MAP_GRANULARITY_RULES, POC_TRUST_RULE, type TranscriptStep } from "./prompts.js";
import { describeAction, readScratchScopes, scratchHasFindings, type AgentTool, type ToolContext } from "./tools.js";
import { flounderAgentDir } from "../provider-auth.js";

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

export async function runAuditSession(input: {
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
  verify?: string;
  /** Synthesis mode: cross-scope composition pass after dig — carries the per-scope findings/scopes to compose. */
  synthesize?: string;
  /** Confirm mode: the open-world reproduce/consolidate/decide pass over a prior run's findings. */
  confirm?: string;
  /** Report mode: generate formal submission reports from reproduced confirm decisions. */
  report?: string;
  /** Prepare mode: the open-world acquire + mainnet-match phase (runs before map). Carries the clue + posture + match-mainnet constraint. */
  prepare?: string;
  /** Called each turn in confirm mode with the decision rows written so far (raw), so a
   * tracker can project live reproduction progress. Best-effort; must not throw. */
  onConfirmCheckpoint?: (rows: unknown[]) => void;
  /** Abort the run cooperatively (e.g. a UI "stop"): aborts the underlying agent session. */
  signal?: AbortSignal;
  /** Live activity for a UI: fired per streaming delta (thinking_delta / text_delta — token
   * level) and per tool call (step). Best-effort, must not throw. Separate from the
   * block-level events.jsonl logging, which persists the same content for later review. */
  onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number }) => void;
}): Promise<SessionDriverResult> {
  const model = getModelSafe(input.cfg.provider, input.cfg.auditModel);
  if (!model) throw new Error(`audit session: unknown provider/model ${input.cfg.provider}/${input.cfg.auditModel}`);

  const steps: TranscriptStep[] = [];
  let stepNo = 0;
  const customTools = input.tools.map((tool) => toPiTool(tool, input.ctx, () => (stepNo += 1), steps, input.logger));

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
    agentDir: flounderAgentDir(),
    sessionManager: SessionManager.inMemory(),
  });

  // Cooperative stop (e.g. a UI "stop" on an in-process run): abort the agent session.
  if (input.signal) {
    if (input.signal.aborted) void session.abort();
    else input.signal.addEventListener("abort", () => void session.abort(), { once: true });
  }

  // Budget: the continuous session runs until the model stops on its own. A finite
  // auditMaxSteps caps the number of model turns so a run cannot grow unbounded in
  // cost/time; a non-finite or <=0 value means NO turn cap (confirm's default — the
  // run then ends only when the model emits done, or errors). With no cap the model
  // owns when it is finished, so the prompt pushes it to reproduce early rather than
  // survey indefinitely.
  const unbounded = !Number.isFinite(input.cfg.auditMaxSteps) || input.cfg.auditMaxSteps <= 0;
  const maxTurns = unbounded ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(input.cfg.auditMaxSteps));
  // Forced-finalize budget: the loop driver nudges and force-writes when its step
  // budget runs out, but a continuous session has no such hook — on a large
  // codebase the model can spend its whole turn budget exploring and stop (or be
  // aborted) without ever writing scopes.json, leaving a 0-scope map (observed on
  // a 60-turn run). After the main budget is spent we grant a few extra turns and
  // explicitly ask for the artifact the model already has the material to produce.
  const MAX_FINALIZE_TURNS = 3;
  let turns = 0;
  let budgetAborted = false;
  let finalizing = false;
  let finalizeTurns = 0;
  let finalizeAborted = false;
  // Confirm-mode resume: checkpoint the model's decision sheet to the run dir each turn,
  // so an interrupted `flounder confirm` keeps the rows reproduced so far (raw; the end-of-run
  // write replaces them with the consolidated set).
  const checkpointConfirm = async (): Promise<void> => {
    let raw: string | undefined;
    for (const [key, value] of input.ctx.session.scratchFiles) {
      if (key === "confirm_decision.json" || key.endsWith("/confirm_decision.json")) {
        raw = value;
        break;
      }
    }
    if (raw === undefined) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        await input.logger.artifact("confirm_decision.json", parsed);
        try {
          input.onConfirmCheckpoint?.(parsed);
        } catch {
          // live projection is best-effort
        }
      }
    } catch {
      // partial / mid-write JSON — skip this checkpoint
    }
  };
  // Accumulate the model's streaming reasoning/output and log each block when it ends, so
  // a UI can tail events.jsonl and show the LLM's thinking + output live (block-level, not
  // token-by-token — readable and cheap). pi surfaces deltas via message_update's
  // assistantMessageEvent (from @earendil-works/pi-ai: thinking_delta / text_delta / *_end).
  let thinkingBuf = "";
  let textBuf = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "thinking_delta") { thinkingBuf += ame.delta; try { input.onActivity?.({ kind: "thinking_delta", delta: ame.delta }); } catch {} }
      else if (ame.type === "thinking_end") { if (thinkingBuf.trim()) void input.logger.event("audit_thinking", { text: thinkingBuf.trim() }); thinkingBuf = ""; }
      else if (ame.type === "text_delta") { textBuf += ame.delta; try { input.onActivity?.({ kind: "text_delta", delta: ame.delta }); } catch {} }
      else if (ame.type === "text_end") { if (textBuf.trim()) void input.logger.event("audit_text", { text: textBuf.trim() }); textBuf = ""; }
    } else if (event.type === "tool_execution_start") {
      // The rich per-tool line (command/file + result) is logged from toPiTool, where the args are.
      try { input.onActivity?.({ kind: "step", tool: event.toolName, step: stepNo + 1 }); } catch {}
    } else if (event.type === "tool_execution_end" && event.isError) {
      void input.logger.event("audit_tool_error", { tool: event.toolName });
    } else if (event.type === "turn_end") {
      if (input.confirm) void checkpointConfirm();
      if (finalizing) {
        finalizeTurns += 1;
        if (finalizeTurns >= MAX_FINALIZE_TURNS && !finalizeAborted) {
          finalizeAborted = true;
          void session.abort();
        }
        return;
      }
      turns += 1;
      if (turns >= maxTurns && !budgetAborted) {
        budgetAborted = true;
        void input.logger.event("audit_session_budget", { turns, maxTurns });
        void session.abort();
      }
    }
  });

  // Forced finalize: if the phase stopped (cleanly or on budget) without persisting
  // its required artifact, spend a bounded extra turn asking explicitly for it. The
  // map owes scopes.json; every other phase (breadth/deep/dig) owes findings.json —
  // a dig can otherwise spend its whole budget exploring and persist zero obligation
  // analysis (observed: a 50-turn Vault dig wrote no hypotheses). The scratch read is
  // the same in-memory source audit.ts reads after this returns, so the empty checks
  // are exact. The findings finalize must NOT bypass the confirmation gate: it asks
  // only for the obligation analysis (discharged or suspected), never for a confirmed
  // status without a passing test.
  const hasScratch = (basename: string): boolean =>
    [...input.ctx.session.scratchFiles.keys()].some((key) => key === basename || key.endsWith(`/${basename}`));
  const finalizeIfEmpty = async (): Promise<void> => {
    if (finalizing) return;
    if (input.prepare) {
      if (hasScratch("prepare_manifest.json")) return;
      finalizing = true;
      await input.logger.event("audit_prepare_finalize", { reason: "no prepare_manifest.json before stop" });
      try {
        await session.prompt(PREPARE_FINALIZE_PROMPT);
      } catch {
        // best-effort
      }
      await input.logger.event("audit_prepare_finalize_done", { hasManifest: hasScratch("prepare_manifest.json") });
      return;
    }
    if (input.confirm) {
      if (hasScratch("confirm_decision.json")) return;
      finalizing = true;
      await input.logger.event("audit_confirm_finalize", { reason: "no confirm_decision.json before stop" });
      try {
        await session.prompt(CONFIRM_FINALIZE_PROMPT);
      } catch {
        // best-effort
      }
      await input.logger.event("audit_confirm_finalize_done", { hasDecision: hasScratch("confirm_decision.json") });
      return;
    }
    if (input.report) {
      if ([...input.ctx.session.scratchFiles.keys()].some((key) => /^report_[a-z0-9_.-]+\.md$/.test(key) || /\/report_[a-z0-9_.-]+\.md$/.test(key))) return;
      finalizing = true;
      await input.logger.event("audit_report_finalize", { reason: "no report markdown before stop" });
      try {
        await session.prompt(REPORT_FINALIZE_PROMPT);
      } catch {
        // best-effort
      }
      await input.logger.event("audit_report_finalize_done", { hasReport: [...input.ctx.session.scratchFiles.keys()].some((key) => /^report_[a-z0-9_.-]+\.md$/.test(key) || /\/report_[a-z0-9_.-]+\.md$/.test(key)) });
      return;
    }
    if (input.map) {
      if (readScratchScopes(input.ctx.session).length > 0) return;
      finalizing = true;
      await input.logger.event("audit_map_finalize", { reason: "no scopes written before stop" });
      try {
        await session.prompt(MAP_FINALIZE_PROMPT);
      } catch {
        // best-effort: an abort during the finalize turns is expected
      }
      await input.logger.event("audit_map_finalize_done", { scopes: readScratchScopes(input.ctx.session).length });
      return;
    }
    if (scratchHasFindings(input.ctx.session)) return;
    finalizing = true;
    await input.logger.event("audit_findings_finalize", { reason: "no findings written before stop" });
    try {
      await session.prompt(FINDINGS_FINALIZE_PROMPT);
    } catch {
      // best-effort
    }
    await input.logger.event("audit_findings_finalize_done", { hasFindings: scratchHasFindings(input.ctx.session) });
  };

  try {
    try {
      await session.prompt(buildSessionPrompt({
        cfg: input.cfg,
        fileManifest: input.fileManifest,
        ...(input.scopeNote ? { scopeNote: input.scopeNote } : {}),
        ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}),
        ...(input.deep ? { deep: true } : {}),
        ...(input.deepFocus ? { deepFocus: input.deepFocus } : {}),
        ...(input.map ? { map: true } : {}),
        ...(input.verify ? { verify: input.verify } : {}),
        ...(input.synthesize ? { synthesize: input.synthesize } : {}),
        ...(input.confirm ? { confirm: input.confirm } : {}),
        ...(input.report ? { report: input.report } : {}),
        ...(input.prepare ? { prepare: input.prepare } : {}),
      }));
    } catch (error) {
      if (!budgetAborted) {
        const message = error instanceof Error ? error.message : String(error);
        await input.logger.event("audit_session_error", { error: message.slice(0, 500) });
        // Authentication is an environment setup step, not a finding. Surface it
        // loudly and actionably instead of silently producing zero findings.
        if (looksLikeAuthError(message)) {
          throw new Error(
            `audit session could not authenticate provider "${input.cfg.provider}". Run \`flounder daemon provider login ${input.cfg.provider}\` on the daemon machine, or start the daemon with that provider's credentials in the environment. For an offline check, run with --mock-llm. Underlying: ${message.slice(0, 300)}`,
          );
        }
        steps.push({ n: stepNo + 1, thought: "", tool: "(session-error)", args: {}, observation: message.slice(0, 500) });
        return { steps, stoppedReason: "error" };
      }
      // budgetAborted: fall through to the forced finalize below
    }
    await finalizeIfEmpty();
    return { steps, stoppedReason: budgetAborted ? "step-budget" : "finished" };
  } finally {
    unsubscribe();
    await shutdownSession(session);
  }
}

function looksLikeAuthError(message: string): boolean {
  return /no api key|not logged in|unauthorized|authenticate|\/login|oauth|credential/i.test(message);
}

function toPiTool(tool: AgentTool, ctx: ToolContext, nextStep: () => number, steps: TranscriptStep[], logger: RunLogger): ToolDefinition {
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
      // Rich live-activity line: the actual command/file the agent ran + its outcome.
      const a = describeAction(tool.name, args, observation);
      void logger.event("audit_action", { step: n, tool: tool.name, detail: a.detail, ok: a.ok, result: a.result });
      return { content: [{ type: "text", text: observation }], details: {} };
    },
  });
}

export const toolSchemas: Record<string, ReturnType<typeof Type.Object>> = {
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
    purpose: Type.Optional(Type.Union([Type.Literal("inspect"), Type.Literal("build"), Type.Literal("confirm")])),
    cwd: Type.Optional(Type.String()),
    success_patterns: Type.Optional(Type.Array(Type.String())),
    expected_exit_code: Type.Optional(Type.Integer()),
    timeout_ms: Type.Optional(Type.Integer()),
  }),
};

export function buildSessionPrompt(input: { cfg: AuditorConfig; scopeNote?: string; fileManifest: string; memoryHint?: string; deep?: boolean; deepFocus?: string; map?: boolean; verify?: string; synthesize?: string; confirm?: string; report?: string; prepare?: string }): string {
  // Confirm is the open-world mode: it has its own white-hat line (fork/read live
  // networks OK, never broadcast), so it does NOT share the local-only scaffold below.
  if (input.prepare) return buildPrepareSessionPrompt({ prepare: input.prepare, fileManifest: input.fileManifest, ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}) });
  if (input.confirm) return buildConfirmSessionPrompt({ confirm: input.confirm, fileManifest: input.fileManifest, ...(input.scopeNote ? { scopeNote: input.scopeNote } : {}), ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}) });
  if (input.report) return buildReportSessionPrompt({ report: input.report, fileManifest: input.fileManifest, ...(input.memoryHint ? { memoryHint: input.memoryHint } : {}) });
  const intro = input.synthesize ? synthesizeIntro(input.synthesize) : input.verify ? verifyIntro(input.verify) : input.map ? mapIntro() : input.deep ? deepIntro(input.deepFocus) : breadthIntro();
  const reportingBlock = input.map
    ? ""
    : `
How to report:
- Record candidates by writing findings.json at the workspace root: a JSON array of objects with fields title, severity (info|low|medium|high|critical), location ("file:line"), description, evidence, exploit_sketch, fix, confidence (0..1), and optionally command_id.
- findings.json is not a work log. Write only credible unmet obligations, suspected bugs, and confirmed bugs. Do NOT write safe/no-issue notes, discharged obligations, ranked shortlist notes, or obligation-ledger entries to findings.json. If this pass found no actionable bug, write [].
- The one hard rule the framework enforces: a claim is only confirmed-executable if it cites command_id of a purpose=confirm bash run that actually passed. Everything else is recorded as an unconfirmed hypothesis.
- A confirm test must exercise the ACTUAL vulnerable code path: construct the malicious input or condition and show the code accepts it or the invariant breaks. A test that merely prints a success string without triggering the bug proves nothing — do not cite it. The dependency toolchain is prepared automatically on your first test run, so allow extra time for that first compile.
- A standalone reimplementation of the algorithm is analysis, not confirmation. If you write a new test file, it must import the pristine target source or run through the target project's native test runner before its command_id can confirm a finding.
${POC_TRUST_RULE}
- For the STRONGEST confirmation (confirmed-differential), also supply on the finding: "fix_patch": {"path": target-source file, "old": exact text to replace, "new": the minimal fix}, and "patched_success_patterns": [strings your test prints once the exploit is BLOCKED]. The framework applies your fix to the pristine source and re-runs your test: a real bug's exploit reproduces before the fix and is blocked after it. You cannot apply the fix yourself (you may not modify target source) — that is deliberate, so the proof is the framework's, not yours.

Trust boundaries (do not lose a real bug just because its proof lives outside this source):
- If a security property's correctness depends on a component NOT in the loaded source — a ZK circuit / verification key, an oracle, a proxy/upgradeable implementation, an external contract's semantics, or an off-chain service — do NOT assume that component enforces what the in-scope code trusts it to, and do NOT drop the concern just because no in-scope confirm test can reach it. The in-scope code "correctly trusting the proof/oracle/impl" is exactly where such bugs hide. Record it as a "suspected" finding that names the trusted assumption, the exact line relying on it, the attacker impact if the assumption fails, and what is needed to settle it (e.g. "needs the circuit/VK to confirm"). A surfaced cross-boundary suspicion beats a silently dropped real bug.
`;
  return `${intro}

Use the provided tools to investigate:
- read: read loaded source/corpus or files you create in the sandbox.
- write / edit: create or modify your own test/scratch files inside the copied workspace. You CANNOT modify the target source under audit — write tests as new files; to show a fix, declare it in the finding's "fix" field and the framework applies it during confirmation.
- bash: run one local command. Use purpose="inspect" to explore (ls/find/rg/cat/sed/jq), check tool availability (which nargo), and read local JSON (python -m json.tool file). Use purpose="build" for dependency resolution or compilation that makes the workspace buildable (cargo build, cmake -S/-B/--build, ninja, make, forge build, npm install, …); it is not confirmation-eligible. For CMake, prefer generator-neutral commands like cmake -S <src> -B <build> then cmake --build <build> --parallel 2 on large targets; pass -G Ninja only after ninja --version succeeds, and keep parallelism bounded. Use purpose="confirm" to PROVE a bug with a real local test runner (cargo test, ctest, forge test, go test, node --test, pytest, …) and declared success_patterns. A model-written standalone test that does not import pristine target source will run, but it cannot become confirmation-eligible.
${reportingBlock}

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
    ? `Apply the three lenses and write scopes.json early as a checkpoint, then keep expanding and splitting it until it is the COMPLETE scope inventory (each: id, obligation, region, lenses, exposure, difficulty, score, why). Do not deep-dive or prove bugs in this phase; coverage over depth. Emit done only after a final completeness pass over the loaded first-party tree.

${MAP_GRANULARITY_RULES}`
    : input.synthesize
      ? "Begin the sink-driven synthesis: enumerate the security-critical sinks, trace each backward across components for an input that arrives un-bound to a legitimate authority, compose the cross-component chains, and write findings.json (each composed exploit with its entry → unbound input → sink links and confirmation). Do not just re-list the per-scope findings."
      : input.deep
        ? "Begin the obligation-driven method: model the system, rank and commit to the most soundness-critical region (unless one is pinned above), then enumerate its obligations from design intent and discharge each by naming the enforcing line or flagging its absence. Write only UNMET or uncertain obligations with a concrete missing edge to findings.json; discharged obligations are not findings. Do not wrap up while obligations remain unchecked."
        : "Begin the audit. When you have investigated thoroughly, write findings.json with only actionable suspected/confirmed bugs (or [] if none), then stop."}`;
}

const MAP_FINALIZE_PROMPT = `Your exploration budget is spent. Do NOT read, grep, or run anything else. Based ONLY on what you have already examined, WRITE scopes.json now at the workspace root as your very next action — call the write tool once with a JSON array of objects {"id","obligation","region":"file:lines","lenses":[...],"exposure","difficulty","score","why"} covering every concrete scope you identified under the three general lenses: spec conditions, value/asset flow, and trusted-but-unbound inputs. If a scope covers multiple independent gates, proof boundaries, invariants, or attacker-controlled inputs, split it before writing. Partial but broad beats empty; do not collapse the inventory into a shortlist or a 30-scope dig batch. After writing, emit {"done": true}. Output only the write tool call.`;

export const FINDINGS_FINALIZE_PROMPT = `Your budget is spent. Do NOT read, grep, or run anything else. Based ONLY on the analysis and command results you have already produced, WRITE findings.json now at the workspace root as your very next action — call the write tool once with ONLY actionable findings: UNMET obligations, concrete suspected bugs, and confirmed bugs that cite an already-passing purpose=confirm command_id. Do NOT include discharged/safe/no-issue obligations, ranked shortlist notes, or obligation ledgers. If you found no actionable bug, write [] exactly. Do NOT invent a confirmation and DO NOT mark anything confirmed by assertion. After writing, emit {"done": true}. Output only the write tool call.`;

const PREPARE_FINALIZE_PROMPT = `Your budget is spent. Do NOT fetch or run anything else. WRITE prepare_manifest.json now at the workspace root as your very next action — call the write tool once with an object: {"clue","posture","match_deployed"(bool),"scope_declaration":"<where the in-scope set came from: the audited addresses and/or the project's own scope doc>","components":[{"role":"target|dependency|implementation|verifier|other","identity":"<address / package / path / etc.>","platform":"<chain / registry / host, or 'none'>","revision":"<block / version / commit / digest>","source":"<verified|published|repo@commit|unverified>","staged_path":"<workspace-relative path/glob of this component's code>","in_scope":(bool),"scope_basis":"deployed-match|project-scope-doc|first-party|dependency|off-deployment-boundary","match":"matched|unverified|n/a","match_evidence"}],"offscope":[{"kind":"circuit|spec|docs|prior-audit|other","resolved":(bool),"where","note"}],"gaps":[...],"answer_firewall":"clean|flagged: ...","notes"}. Record honestly: a deployed component you could not match is "unverified"; a non-deployed one is "n/a" with its source origin pinned; in_scope=true for the deployment-matched target / project-declared in-scope / first-party code, false for third-party deps and off-deployment trust boundaries (a FACT from deployment + the project's scope, not a guess about bugs); anything you could not find is a gap, not a guess. After writing, emit {"done": true}. Output only the write tool call.`;

function buildPrepareSessionPrompt(input: { prepare: string; fileManifest: string; memoryHint?: string }): string {
  return `${AUDIT_PREPARE_SYSTEM}

Your task for THIS run (clue + posture + match-mainnet constraint):
${input.prepare}

Workspace (initially empty — stage everything you fetch here; this directory becomes the audit's source):
${input.fileManifest}

Durable memory from prior prepares of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Begin: resolve the clue, stage the target/security-critical source and official answer-free docs, mainnet-match or source-pin each component, write prepare_manifest.json early, record gaps honestly, and stop once the sealed audit has enough neutral material to proceed.`;
}

const CONFIRM_FINALIZE_PROMPT = `Your budget is spent. Do NOT read, fork, fetch, or run anything else. Based ONLY on what you have already reproduced, WRITE confirm_decision.json now at the workspace root as your very next action — call the write tool once with a JSON array, one row per DISTINCT bug: {"bug","members":[...],"distinct_fix","reproduced":"yes"|"no"|"could-not-set-up","repro_evidence","repro_command_id","fix_patch":{"path","old","new"},"patched_success_patterns":[...],"corroboration","novelty","human_gates","recommendation":"submit-candidate"|"needs-human"|"drop"}. Mark "reproduced":"yes" ONLY for a bug you actually reproduced on the real target with a passing command_id; otherwise "no"/"could-not-set-up" with the crutch/blocker named. Include repro_command_id + fix_patch + patched_success_patterns for any source-level PoC so the framework can verify consolidation by execution. Partial but honest beats empty. After writing, emit {"done": true}. Output only the write tool call.`;

// Confirm session prompt = the confirm mission/rules (shared with the loop driver's
// system prompt) plus this run's frozen findings and context. It deliberately does
// NOT reuse the local-only scaffold buildSessionPrompt builds for the other modes.
function buildConfirmSessionPrompt(input: { confirm: string; fileManifest: string; scopeNote?: string; memoryHint?: string }): string {
  return `${AUDIT_CONFIRM_SYSTEM}

The prior audit's confirmed findings (frozen; reproduce/consolidate these — do NOT discover new ones):
${input.confirm}

The frozen audit report and per-finding disclosures are under corpus/ in your workspace — read them for each finding's claimed exploit and fix.

Authorized scope note:
${input.scopeNote && input.scopeNote.trim().length > 0 ? input.scopeNote.trim() : "(none provided — treat all loaded source as in scope)"}

Durable memory from prior runs of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Loaded source files:
${input.fileManifest}

Consolidate the findings into distinct bugs, reproduce each distinct bug against real ground truth, check novelty/corroboration online (leads only, never proof), then write confirm_decision.json and emit done.`;
}

const REPORT_FINALIZE_PROMPT = `Your budget is spent. Do NOT inspect anything else. Based ONLY on the reproduced decision data, existing evidence, and source/code facts you already checked, WRITE the missing report_*.md files now at the workspace root. If a detail is not established, say "Not established by the available evidence" or list it as a human gate. Do NOT invent impact, versions, exploitability, affected deployments, novelty, or fix validation. After writing the reports, emit {"done": true}. Output only write tool calls followed by done.`;

function buildReportSessionPrompt(input: { report: string; fileManifest: string; memoryHint?: string }): string {
  return `You are the REPORT phase of Flounder, an autonomous white-hat security auditor.

Your job is to produce formal, submission-ready Markdown reports for already reproduced bugs. You are NOT discovering new bugs, NOT upgrading suspected claims, and NOT changing confirm decisions. You may read the copied source, official docs/corpus, existing PoC files, and decision evidence to verify exact details before writing. You may run inspect-only commands when needed to check paths, code snippets, versions, or artifact contents. Do not rerun live exploits, do not broadcast, and do not write to live systems.

No-fabrication rule: every concrete statement in the report must be supported by one of:
- the reproduced confirm decision supplied below;
- the finding's stored evidence;
- source/corpus lines you read in this report run;
- command output you produced in this report run.
If a detail is not established, write that it is not established or list it under human gates. Never fill gaps with plausible security-report language.

Write exactly one Markdown file per requested bug at the specified workspace-root filename. These files are persisted to the product DB and shown to users as the official report. Do not emit done until every required file is written.

Use this template for each file:
# <clear vulnerability title>

## Summary
One concise paragraph explaining the bug and the violated security property.

## Severity
Severity, rationale, affected asset or trust boundary, and confidence. Do not invent CVSS; include it only if justified.

## Affected Component
Repository/package/component, version/commit/deployment if known, and code locations. Use relative paths, contract names, package names, command ids, or public URLs. Do not include local absolute paths.

## Root Cause
The exact missing check, invalid assumption, state transition, proof constraint, verifier binding, or authorization error that makes the bug possible.

## Attack Scenario
Step-by-step attacker capabilities and exploit path, written for maintainers. Avoid live-network abuse instructions.

## Impact
Concrete effect and harmed parties/assets, tied to reproduced observable evidence.

## Reproduction Evidence
The real-target reproduction result, observed effect, command_id, and artifacts. Say whether reproduction used a fork, published package, real verifier, deployed bytecode, or another real-world ground truth.

## Proof of Concept
Minimal local-only reproduction steps or code pointers sufficient for the maintainer to reproduce. Never include commands that broadcast to or write to live systems.

## Recommended Fix
Specific remediation guidance and any tested patch result. If a fix was not tested, say so.

## Validation
How maintainers should verify the fix and what regression test should be added.

## Novelty and Disclosure Notes
Corroboration, novelty result, remaining human gates, scope/venue notes, and recommended next action.

Reports to write:
${input.report}

Durable memory from prior runs of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Loaded source files:
${input.fileManifest}

Begin by checking any source/evidence needed for accuracy, then write every required report_*.md file and emit done.`;
}

function verifyIntro(claim: string): string {
  return `You are an autonomous white-hat security auditor in VERIFY mode: you are handed ONE specific suspected finding and must determine BY EXECUTION whether it is REAL or a FALSE POSITIVE. Do NOT enumerate new issues.

The suspected finding to verify:
${claim}

Method: (1) read the cited code + its callers/callees/modifiers, and check whether the claimed-unconstrained value is actually bound elsewhere (a verified hash/proof, a require, a check) — many "X is unconstrained" claims are false. At decode/serialization/proof boundaries, also check whether the value is length-checked, canonical/range-checked, and interpreted in the correct domain/modulus/units rather than silently normalized into a different statement. (2) Write a NEW PoC test in the sandbox that exercises the ACTUAL code path and triggers the claimed bug; run it with purpose=confirm and success_patterns. (3) Verdict in findings.json: if the PoC passes and triggers the bug, record the finding at its true severity citing command_id, and supply fix_patch + patched_success_patterns for differential confirmation; if after genuine effort it cannot reproduce because the claim is mitigated/false, record ONE finding of severity "info" whose title starts "REFUTED:" with evidence citing the exact mitigating line. Never confirm by assertion — default to refuting unless an executable PoC proves it.`;
}

function mapIntro(): string {
  return `You are an autonomous white-hat security auditor doing the MAP phase: enumerate the COMPLETE set of audit SCOPES for this target. You are NOT finding or proving bugs yet — a later phase deep-audits each scope. Your job is COVERAGE, not a ranked shortlist that drops things.

Apply THREE lenses (general method, not a hint about this target); be exhaustive, over-list rather than silently omit:
1. SPEC CONDITIONS — read the design/spec material under corpus/ (and higher-level code) and list every security statement the system must enforce; each maps to the code that enforces it. A stated condition with NO enforcing code is itself a scope.
2. VALUE / ASSET FLOW — every place value or authority is created, destroyed, transferred, or authorized, and the gate on each. Count/length/index values that decide how many asset, message, state-transition, or proof/public-input records are processed are their own scopes; each must be bound to the same legitimate authority, commitment, or proof statement as the records it gates.
3. TRUSTED-BUT-UNBOUND INPUTS — every attacker-controlled value (witnessed/decoded/assigned/external) later logic trusts; the scope is "what binds this to its required value?". A trusted value with no visible binding is the highest-value scope.

Do not judge importance by gut feel or "looks like a bug". A region whose link to the asset is indirect (e.g. a key/address-integrity check that only matters because breaking it enables a later double-spend) MUST still be listed — those are exactly what a rank-and-pick misses. Assign each scope: exposure (critical|high|medium|low, by asset at risk), difficulty (high|medium|low, how hard to be sure it is correct), score (0-10, only to order the dig phase; low score defers, never drops).

${MAP_GRANULARITY_RULES}

Write scopes.json at the workspace root EARLY — after the initial directory/entrypoint scan, and no later than 10 inspect commands — then UPDATE it (rewrite the full array) as you find more, so a complete-as-of-now inventory survives if you run out of budget. The first write is a checkpoint, not completion. Do not stop at 30 scopes or any dig-batch cap; those caps apply only after mapping. It is a JSON array of {"id","obligation","region":"file:lines","lenses":[...],"exposure","difficulty","score","why"}. On a large codebase do NOT read every file first — use bash (ls/grep for public/external entrypoints, state writes, value transfers) to enumerate, and spend little per scope (broad and shallow). Before done, make a final expansion pass over the first-party tree, split broad scopes, update scopes.json, and only then stop. You CANNOT modify the target source.`;
}

function breadthIntro(): string {
  return `You are an autonomous white-hat security auditor working on AUTHORIZED source code that has been copied into your working directory.
Your goal is to find real, exploitable, high-impact security vulnerabilities and to prove them.

You are in full control of the investigation. There is no fixed checklist and no required bug taxonomy. Decide for yourself what to read, what to suspect, which hypotheses to test, and when to stop. Use the full depth of your own security knowledge: form a model of what the code must guarantee (its invariants and trust boundaries), then look for where the implementation lets an attacker break that guarantee.

General method (applies to any code, not a hint about this target): for every value the code trusts — especially anything assigned, witnessed, decoded, or taken as input — explicitly ask "what MUST this equal for the security property to hold, and is there a visible check/constraint that enforces it?" A value later logic relies on but nothing binds to its required value is a classic bug. Reaching a file is not auditing it: when a component looks standard, state the exact invariant it must satisfy and find the line that enforces it before concluding it is correct. At serialization, ABI, FFI, proof, and transcript boundaries, discharge the one-to-one interpretation obligation explicitly: exact length, canonical/range-checked encoding, correct domain/modulus/units, and no silent normalization that changes the statement the rest of the code believes it is checking. When a count, length, index, or loop bound decides how many asset, message, state-transition, or proof/public-input records are processed, trace that cardinality back to the same legitimate authority, commitment, or proof statement as the records it gates. Trust nothing external as ground truth: agreement with a reference implementation, an upstream version, a spec, a book, or a prior audit is NOT evidence of correctness — the reference can carry the same bug, and some bugs live in the canonical implementation itself. Never clear a component because it "matches upstream", looks "standard", or matches the spec; clear it only by naming the exact invariant and the constraint that enforces it, or by an executable counterexample. Reason from the security property itself, not from what the materials say the code does. Record credible suspicions to findings.json as hypotheses (with location and why) as you go — do not hold them only in your head.`;
}

function deepIntro(deepFocus?: string): string {
  const focus = deepFocus && deepFocus.trim().length > 0 ? deepFocus.trim() : "";
  return `You are an autonomous white-hat security auditor performing a DEEP, NARROW-SCOPE audit of AUTHORIZED source code copied into your working directory.
This is NOT a breadth survey. You are auditing a small, high-criticality slice to a much higher standard of rigor: either prove it enforces every security property it is responsible for, or find the exact point where it does not.

${focus ? `Focus region (pinned): ${focus}. Audit this region.` : "No focus is pinned: first model the system and RANK the most soundness-critical region (a region is critical when a top-level balance/supply/authorization/uniqueness/integrity property the whole system depends on is ENFORCED there), commit your budget to it, and keep the ranked shortlist in the transcript. Do not write shortlist notes to findings.json."}

Obligation-driven method (general, not a hint about this target):
- ENUMERATE obligations from DESIGN INTENT, not the code's appearance. Read the design material under corpus/ and the higher-level code that USES this region to determine what it is SUPPOSED to guarantee. Write each obligation explicitly as "value/relationship X must equal/hold Y for property P". The code cannot tell you what it should enforce; the intent does.
- DISCHARGE each obligation one at a time. Finding that "a constraint exists" is NOT discharge: state exactly what the constraint binds the value to and confirm that referent is the value the obligation actually requires — not merely an adjacent/internal value, and not merely a relationship among witnessed values when the property names a specific trusted source. A value bound to the wrong referent leaves the obligation UNMET.
- At serialization, ABI, FFI, proof, and transcript boundaries, discharge includes one-to-one interpretation: exact length, canonical/range-checked encoding, correct domain/modulus/units, and no silent normalization that changes the statement being checked.
- When a count, length, index, or loop bound decides how many asset, message, state-transition, or proof/public-input records are processed, discharge it separately: it must be bound to the same legitimate authority, commitment, or proof statement as the records it gates.
- A MISSING enforcing constraint is the finding. Missing-constraint bugs look like ordinary assignment/witnessing on every line — reason from the obligation, never from whether the code "looks standard", "matches upstream", or is "the canonical implementation" (the reference can carry the same bug; some bugs live in the canonical code itself).
- Write only UNMET or uncertain obligations with a concrete missing edge to findings.json. Discharged-with-line obligations are reasoning, not findings; keep them in the transcript and do not write them to findings.json.`;
}

function synthesizeIntro(seed: string): string {
  return `You are an autonomous white-hat security auditor in SYNTHESIS mode on AUTHORIZED source code. The per-scope deep audit has finished; each scope was audited IN ISOLATION. Your job is to find exploits that NO single scope could see — bugs that exist only in the COMPOSITION of multiple components, where each part can look acceptable on its own.

Sink-driven method (general, not a hint about this target):
1. ENUMERATE the security-critical SINKS — every place the system produces an irreversible, privileged effect: value or authority leaves the system (funds out, mint, burn, role/owner/allowance change), or a guarded state transition commits. A sink is critical wherever it lives, in any component or language.
2. For EACH sink, trace BACKWARD across components every value that decides the effect — recipient, amount, asset, the caller, any count/length/index that decides how many records or effects are processed, and whatever is supposed to AUTHORIZE it (a proof, a signature, a balance, on-chain state). Follow each to where it is established and ask: is it bound to a LEGITIMATE authority along the WHOLE path to the sink? A value constrained inside one component but arriving UN-bound at the sink — or a sink reachable by a caller/path that never proves the authority the effect requires — is the bug, even when every individual component looked correct in its own scope.
3. A "by-design" / emergency / escape / admin / fallback / privileged path is itself a trust boundary, never a discharge: ask what effect it grants and whether each effect is bound to a legitimate authority. "This path is intended to exist" is NOT a reason it is safe; "this parameter cannot be forged" does NOT clear the path if the path still authorizes the effect.
4. COMPOSE the chain: who can reach the sink (entry + authorization) + the unbound or under-constrained input it carries + the sink effect = ONE concrete attacker action. The links may come from DIFFERENT scopes below; assembling them across scope boundaries is the entire point of this phase.

Confirm at the SINK, not the link: a composition finding is confirmed-executable only when a PoC demonstrates the END effect — funds move, an invariant breaks, or an unauthorized state change commits — not when one intermediate constraint is shown missing. Where the full chain genuinely cannot be built locally (e.g. it needs a real proof/circuit/oracle), record a "suspected" finding that names the exact chain (entry → unbound input → sink), each link's file:line, and the attacker impact — a surfaced cross-component chain beats a silently dropped one.

Prior per-scope audit (the material to compose — do NOT just re-list it; find what its pieces ENABLE together):
${seed}`;
}

// One-shot completion over a codex/pi AgentSession (OAuth-authed). Needed for code
// paths that want a single completion on a SESSION-only provider (e.g. openai-codex),
// where pi-ai's API-key-based complete() fails with "No API key". Used for the
// refutation/realism pass so it actually runs on codex instead of erroring out.
export class SessionLlmClient implements LlmClient {
  constructor(private readonly cfg: AuditorConfig, private readonly logger?: RunLogger) {}
  async complete(input: { tag: string; system: string; user: string; model?: string; maxTokens?: number; thinkingLevel?: AuditorConfig["thinkingLevel"]; agentic?: boolean }): Promise<string> {
    const modelName = input.model ?? this.cfg.auditModel;
    const model = getModelSafe(this.cfg.provider, modelName);
    if (!model) throw new Error(`session completion: unknown provider/model ${this.cfg.provider}/${modelName}`);
    const { session } = await createAgentSession({
      model,
      thinkingLevel: mapThinkingLevel(input.thinkingLevel ?? this.cfg.thinkingLevel),
      noTools: "all",
      customTools: [],
      cwd: process.cwd(),
      agentDir: flounderAgentDir(),
      sessionManager: SessionManager.inMemory(),
    });
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        const messages = (event as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.role === "assistant") {
            text = extractMessageText(messages[i]?.content);
            break;
          }
        }
      }
    });
    try {
      await session.prompt(`${input.system}\n\n${input.user}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (looksLikeAuthError(message)) {
        throw new Error(`session completion could not authenticate provider "${this.cfg.provider}". Run \`flounder daemon provider login ${this.cfg.provider}\` on the daemon machine, or start the daemon with that provider's credentials in the environment. Underlying: ${message.slice(0, 200)}`);
      }
      throw error;
    } finally {
      unsubscribe();
      await shutdownSession(session);
    }
    await this.logger?.call({ tag: input.tag, model: `${this.cfg.provider}/${modelName}`, system: input.system, user: input.user, response: text });
    if (text.trim().length === 0) throw new Error(`session completion returned no text: ${this.cfg.provider}/${modelName}`);
    return text;
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
      .join("");
  }
  return "";
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
