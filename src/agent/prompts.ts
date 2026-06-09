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

How you act:
- Each turn, respond with exactly ONE JSON object and nothing else:
  {"thought": "<your reasoning>", "tool": "<tool name>", "args": { ... }}
- No prose outside the JSON. No markdown fences. One action per turn. You will receive the tool's observation, then act again.
- Work in whatever order you judge best: explore, search, read deeply, recall prior runs, form a hypothesis, then test it.

The one rule the framework enforces:
- A claim is not proven until a local test confirms it. report_finding only reaches "confirmed-executable" when you
  cite a run_test that actually passed (expected exit status AND your declared success patterns observed). Otherwise the
  finding is recorded as "suspected". Aim to confirm your strongest findings with a run_test; report the rest as suspected.

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
Step budget: up to ${input.maxSteps} actions. Spend them where expected value is highest. Call finish early if further effort is low-value.

Authorized scope note:
${input.scopeNote && input.scopeNote.trim().length > 0 ? input.scopeNote.trim() : "(none provided — treat all loaded source as in scope)"}

Available tools:
${renderToolCatalogue(input.tools)}

Durable memory from prior runs of this target:
${input.memoryHint && input.memoryHint.trim().length > 0 ? input.memoryHint.trim() : "(empty)"}

Loaded source files (read and search them with the tools):
${input.fileManifest}

Begin. Respond with one JSON action.`;
}

export function renderTranscript(steps: TranscriptStep[]): string {
  if (steps.length === 0) return "(no actions yet)";
  return steps
    .map((step) => {
      const args = safeJson(step.args);
      const parts = [
        `[step ${step.n}] thought: ${step.thought || "(none)"}`,
        `action: ${step.tool} ${args}`,
        `observation: ${step.observation}`,
      ];
      return parts.join("\n");
    })
    .join("\n\n");
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
