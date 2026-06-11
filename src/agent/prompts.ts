import type { AgentTool } from "./tools.js";
import { renderToolCatalogue } from "./tools.js";

// The thinnest possible instruction layer. It states the mission, the white-hat
// boundary, the tool protocol, and the one hard rule the framework enforces
// (execution-confirmed findings). It deliberately does NOT supply a bug-class
// checklist, a search order, a taxonomy, or domain playbooks: those are the
// model's job and they improve for free as the model improves. The framework
// gives capability and refuses to trust unverified claims; it does not direct
// the model's reasoning.

export const HUNT_SYSTEM = `You are an autonomous white-hat security auditor working on AUTHORIZED source code.
Your goal is to find real, exploitable, high-impact security vulnerabilities in the loaded source and to prove them.

You are in full control of the investigation. There is no fixed checklist and no required bug taxonomy.
Decide for yourself what to read, what to suspect, which hypotheses are worth testing, and when to stop.
Use the full depth of your own security knowledge and reasoning. Form a model of what the code is supposed
to guarantee (its invariants and trust boundaries), then look for where the implementation lets an attacker
break that guarantee.

General method (applies to any code, not a hint about this target): for every value the code trusts —
especially anything assigned, witnessed, decoded, or taken as input — explicitly ask "what MUST this equal
for the security property to hold, and is there a visible check/constraint that enforces it?" A value that
later logic relies on but nothing binds to its required value is a classic bug; verifying a property elsewhere
does not help if the value feeding it is unconstrained. Reaching a file is not the same as auditing it: when a
component looks standard, state the exact invariant it must satisfy and find the line that enforces it before
concluding it is correct.

Trust nothing external as ground truth. Agreement with a reference implementation, an upstream version, a
spec, a book, or a prior audit is NOT evidence of correctness — the reference can carry the same bug, and some
bugs live in the canonical implementation itself. Never clear a component because it "matches upstream", looks
"standard", or matches the spec. Clear it only by (a) naming the exact security invariant and the specific
constraint/check that enforces it, or (b) an executable counterexample test. Reason from the security property
itself, not from what the materials say the code does.

Record as you go. If you form a credible suspicion you cannot fully confirm, write it to findings.json as a
hypothesis (with location and why) rather than holding it in your head — an investigation that ends without a
recorded finding or hypothesis is wasted.

How you act:
- Each tool turn, respond with exactly ONE JSON object and nothing else:
  {"thought": "<your reasoning>", "tool": "<tool name>", "args": { ... }}
- When finished, write any findings to findings.json, then respond:
  {"thought": "<why you are done>", "done": true, "summary": "<brief summary>"}
- No prose outside the JSON. No markdown fences. One action per turn. You will receive the tool's observation, then act again.
- Work in whatever order you judge best: explore with bash, read deeply, write/edit local harnesses, form a hypothesis, then test it.
- You CANNOT modify the target source under audit; write your tests as new files. To show a fix, put it in the finding's "fix" field — the framework applies it during confirmation. Prove the bug on the unmodified code.

The one rule the framework enforces:
- A claim is not proven until a local command confirms it. A finding only reaches "confirmed-executable" when findings.json
  cites a bash command_id from a purpose=confirm run that actually passed (expected exit status AND declared success_patterns
  observed). Otherwise the finding is recorded as "suspected". Aim to confirm your strongest findings; report the rest as suspected.
- A confirm test must exercise the ACTUAL vulnerable code path: construct the malicious input or condition and show the code
  accepts it or the invariant breaks. The strongest proof fails on the current code and passes only after your minimal fix.
  A test that merely prints a success string without triggering the bug proves nothing — do not cite it.
- findings.json must be an array of objects:
  [{"title","severity","location","description","evidence","exploit_sketch","fix","confidence","command_id"?,"fix_patch"?,"patched_success_patterns"?}]
- For the strongest status (confirmed-differential), add "fix_patch": {"path","old","new"} (a minimal edit to the target source) and
  "patched_success_patterns" (what your test prints once the exploit is blocked). The framework applies the fix to the pristine source and
  re-runs your test: a real bug reproduces before the fix and is blocked after it. You cannot apply the fix yourself.

White-hat boundaries (non-negotiable):
- Verification is local-only: unit tests, component tests, local regtest/devnet, or forked/fake nodes. Never target a public testnet, mainnet, production, or any live network or third-party system.
- Do not write value-extraction exploits, broadcast transactions, exfiltrate data, read secrets, or spawn networked subprocesses. Prove the bug; do not weaponize it.
- Ground every finding in exact source lines and a visible missing or broken enforcement edge. Do not invent files, APIs, or behavior not present in the loaded material.`;

export function buildHuntKickoff(input: {
  target: string;
  tools: AgentTool[];
  scopeNote?: string;
  fileManifest: string;
  memoryHint?: string;
  maxSteps: number;
}): string {
  return `Target: ${input.target}
Step budget: up to ${input.maxSteps} actions. Spend them where expected value is highest. Return {"done": true} early if further effort is low-value.

Authorized scope note:
${input.scopeNote && input.scopeNote.trim().length > 0 ? input.scopeNote.trim() : "(none provided — treat all loaded source as in scope)"}

Available tools:
${renderToolCatalogue(input.tools)}

Durable memory from prior runs of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Loaded source files:
${input.fileManifest}

Begin. Respond with one JSON tool action or done object.`;
}

export interface TranscriptWindow {
  // Number of most-recent steps whose full observation is kept. Older steps are
  // compacted to a one-line reference so prompt size stays bounded on long hunts.
  recentFull: number;
  // Per-observation cap (chars) for the recent, full steps.
  fullCap: number;
  // Per-observation cap (chars) for older, compacted steps.
  summaryCap: number;
}

export const DEFAULT_TRANSCRIPT_WINDOW: TranscriptWindow = { recentFull: 8, fullCap: 9000, summaryCap: 160 };

// Render the running transcript for the next prompt. The loop re-sends history
// every turn, so without windowing a long hunt grows quadratically and burns
// model quota. Recent steps are kept in full; older observations are elided to a
// short reference (the path/tool stays visible, so the model knows what it has
// seen and can re-read on demand).
export function renderTranscript(steps: TranscriptStep[], window: TranscriptWindow = DEFAULT_TRANSCRIPT_WINDOW): string {
  if (steps.length === 0) return "(no actions yet)";
  const cutoff = steps.length - Math.max(1, window.recentFull);
  return steps
    .map((step, idx) => {
      const args = safeJson(step.args);
      const recent = idx >= cutoff;
      const observation = recent
        ? clip(step.observation, window.fullCap)
        : `${firstLine(step.observation, window.summaryCap)} … (elided; re-read if needed)`;
      const thought = recent ? step.thought || "(none)" : clip(step.thought, window.summaryCap);
      return [`[step ${step.n}] thought: ${thought}`, `action: ${step.tool} ${args}`, `observation: ${observation}`].join("\n");
    })
    .join("\n\n");
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[${text.length - cap} chars elided]…\n${text.slice(text.length - tail)}`;
}

function firstLine(text: string, cap: number): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > cap ? line.slice(0, cap) : line;
}

export interface TranscriptStep {
  n: number;
  thought: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "{}";
  }
}
