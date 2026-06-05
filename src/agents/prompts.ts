import type { AuditItem, FailureMode } from "../types.js";
import { AUDITOR_AGENTS, getAuditorAgent, type AuditorAgentRegistry } from "./registry.js";

export const MODE_GUIDANCE: Record<FailureMode, string> = Object.fromEntries(
  Object.entries(AUDITOR_AGENTS).map(([mode, agent]) => [mode, agent.guidance]),
) as Record<FailureMode, string>;

export const ENUM_SYSTEM = `You are the enumeration stage of an automated white-hat security audit framework.
Your job is not to find bugs yet. Your job is to exhaustively map the audit surface so later specialized agents can check each item.
Optimize for coverage, specificity, and traceability. Ground each item in source and reference material.`;

export function buildEnumerationPrompt(input: {
  target: string;
  failureModes: FailureMode[];
  corpus: string;
  source: string;
}): string {
  return `Target: ${input.target}

Allowed failure modes: ${input.failureModes.join(", ")}

Enumerate concrete audit items. Each item must have:
- id: short slug
- location: file + line range or function/component
- securityProperty: invariant that must hold
- failureMode: one allowed tag
- why: why this spot is worth checking
- specRefs: optional list of cited spec/reference snippets
- attackerControlledInputs: optional list of inputs a malicious actor/prover controls

Prioritize implementation/spec mismatch, under-constrained witness values, conservation of value, uniqueness of spend markers, consensus divergence, and cheap-to-trigger expensive work.

Return only a JSON array. No markdown fences.

===== REFERENCE / SPEC MATERIAL =====
${input.corpus || "(none provided)"}

===== SOURCE UNDER AUDIT =====
${input.source || "(none provided)"}
`;
}

export const AUDIT_SYSTEM = `You are a specialized auditor inside an authorized white-hat audit framework.
Analyze only the assigned item. Real audited code can contain critical bugs, but do not invent findings.
Reason from actual constraints, checks, and data flow. If the invariant is enforced, say so plainly.`;

export function buildAuditPrompt(item: AuditItem, source: string, registry?: AuditorAgentRegistry): string {
  const agent = getAuditorAgent(item.failureMode, registry);
  return `Audit item:
  id: ${item.id}
  location: ${item.location}
  securityProperty: ${item.securityProperty}
  failureMode: ${item.failureMode}
  why: ${item.why}

Specialized auditor:
  id: ${agent.id}
  name: ${agent.displayName}

Failure-mode guidance:
${agent.guidance}

Relevant source:
${source}

Respond as a JSON object only:
{
  "finding": true,
  "title": "...",
  "severity": "info|low|medium|high|critical",
  "confidence": 0.0,
  "description": "what the bug is",
  "evidence": "exact lines, checks, or missing constraints",
  "exploitSketch": "high-level attacker steps, no working exploit code",
  "fix": "minimal change that enforces the property"
}

If there is no bug, return the same object shape with "finding": false and explain why the property is enforced.`;
}

export const VERIFY_SYSTEM = `You are the verification stage of a white-hat audit framework.
Independently confirm or refute the candidate finding by reasoning from the code.

Hard rules:
- Reproduction must target a local unit test, regtest, devnet, or forked node only.
- Never target public testnet or mainnet.
- Verify the bug; do not optimize a value-extraction exploit.
- If the invariant is enforced, mark it false-positive.`;

export function buildVerifyPrompt(input: {
  title: string;
  location: string;
  severity: string;
  description: string;
  evidence: string;
  fix: string;
  source: string;
}): string {
  return `Candidate finding:
  title: ${input.title}
  location: ${input.location}
  severity: ${input.severity}
  description: ${input.description}
  evidence: ${input.evidence}
  proposed fix: ${input.fix}

Relevant source:
${input.source}

Produce markdown:
1. VERDICT: confirmed / needs-investigation / false-positive.
2. Reasoning with specific lines or missing constraints.
3. Confidence ladder from cheapest local check to strongest local-only check.
4. PoC scaffold for the first local-only rung only.
5. Minimal fix and a test that should pass after the fix.`;
}
