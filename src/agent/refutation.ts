import type { AuditorConfig } from "../config.js";
import type { RunLogger } from "../trace/logger.js";
import type { Doc, LlmClient } from "../types.js";
import { extractJsonObject } from "../util/json.js";
import type { AgentFinding } from "./tools.js";

// Independent refutation. A confirmed finding rests on one chain of reasoning (and
// possibly one self-authored test). A fresh-context skeptic — which never saw the
// finder's investigation — re-derives the invariant from first principles and
// tries to BREAK the claim: show the property is actually enforced, or the exploit
// does not work. Disagreement is surfaced; a single-test confirmation a skeptic
// debunks is downgraded. This guards against a single chain inheriting a wrong
// assumption (including "it matches upstream").

export const REFUTE_SYSTEM = `You are an independent adversarial reviewer. Another auditor produced an UNVERIFIED vulnerability claim. You did NOT do the original investigation; do not assume the claim is right or wrong.
The claim sometimes comes with a PoC test it says confirms the bug. REFUTE it on EITHER of two independent grounds:
1. INVARIANT: from the actual code and first principles, the alleged security property is in fact enforced (so the claim is wrong), or the exploit reasoning has a flaw that makes it not exploitable.
2. POC REALISM / TRUST ASSUMPTIONS: even a PoC that "passes" only confirms a real bug if the exploit is reachable in the ACTUALLY DEPLOYED system. Scrutinize the PoC's setup — every mock, stub, vm.store, fake deployed contract, and assumption. If triggering the bug REQUIRES a trusted/fixed component to behave CONTRARY to its real or specified contract (e.g. a verifier that returns false instead of REVERTING on an invalid proof; an oracle/bridge/admin the real system pins and that cannot be replaced or made to misbehave), the "confirmation" is VACUOUS — it proves a counterfactual, not a real bug. A PoC may mock a trusted component ONLY if the mock faithfully matches that component's real/spec'd behavior.
Do not clear code because it "matches upstream", a spec, or looks standard — a reference can carry the same bug. But DO refute a confirmation whose only triggering path needs an out-of-spec trusted component.
Be skeptical, but honest: if you genuinely cannot refute it on either ground, say so.
Respond with ONLY a JSON object and nothing else (no prose, no fences): {"refuted": true|false, "unrealistic": true|false, "reason": "<concise and specific>"}.
- refuted=true: the claim/confirmation does not hold — say which ground. Set unrealistic=true when it fails ground 2 (the PoC needs a trusted component to act out of its real contract, so the exploit is not reachable in the deployed system); cite the real component's actual behavior.
- refuted=false: you could not refute it on either ground; the concern appears to stand (then unrealistic must be false).`;

export interface RefutationVerdict {
  findingId: string;
  refuted: boolean;
  unrealistic: boolean;
  reason: string;
}

export async function runRefutation(input: {
  findings: AgentFinding[];
  source: Doc[];
  cfg: AuditorConfig;
  llm: LlmClient;
  logger: RunLogger;
  max: number;
  // PoC/scratch test files the finder wrote, so the skeptic can audit the
  // confirmation's trust assumptions (e.g. an out-of-spec mocked verifier), not
  // just the invariant. Keyed by path; passed verbatim.
  pocFiles?: Array<{ path: string; content: string }>;
}): Promise<RefutationVerdict[]> {
  const out: RefutationVerdict[] = [];
  for (const finding of input.findings.slice(0, Math.max(0, input.max))) {
    const user = buildRefutationPrompt(finding, sourceForLocation(input.source, finding.location), input.pocFiles ?? []);
    try {
      const raw = await input.llm.complete({
        tag: `refute_${finding.id}`,
        system: REFUTE_SYSTEM,
        user,
        model: input.cfg.auditModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
        agentic: true,
      });
      const parsed = extractJsonObject<{ refuted?: unknown; unrealistic?: unknown; reason?: unknown }>(raw);
      if (parsed && typeof parsed.refuted === "boolean") {
        const unrealistic = parsed.unrealistic === true && parsed.refuted === true;
        const verdict: RefutationVerdict = { findingId: finding.id, refuted: parsed.refuted, unrealistic, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 800) : "" };
        finding.refutation = { refuted: verdict.refuted, reason: verdict.reason, unrealistic };
        out.push(verdict);
        await input.logger.event("hunt_refutation", { findingId: finding.id, refuted: verdict.refuted, unrealistic });
      }
    } catch (error) {
      await input.logger.event("hunt_refutation_error", { findingId: finding.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return out;
}

function buildRefutationPrompt(finding: AgentFinding, sourceSlice: string, pocFiles: Array<{ path: string; content: string }>): string {
  const poc = pocFiles.length > 0
    ? pocFiles.map((file) => `----- ${file.path} -----\n${file.content.length > 6000 ? file.content.slice(0, 6000) + "\n…(truncated)" : file.content}`).join("\n\n")
    : "(no PoC test files were provided)";
  return `A vulnerability claim from another auditor:
- Title: ${finding.title}
- Location: ${finding.location}
- Asserted status: ${finding.confirmationStatus}
- Description: ${finding.description || "(none)"}
- Evidence: ${finding.evidence || "(none)"}
- Exploit sketch: ${finding.exploitSketch || "(none)"}
- Proposed fix: ${finding.fix || "(none)"}

Relevant source:
${sourceSlice}

PoC / scratch test file(s) the finder wrote to confirm it (audit their setup, mocks, and trust assumptions — a passing test against an out-of-spec mocked component is a vacuous confirmation):
${poc}

Independently determine whether this claim/confirmation holds, on EITHER the invariant ground or the PoC-realism ground. Respond with the JSON verdict only.`;
}

function sourceForLocation(source: Doc[], location: string): string {
  const match = location.match(/([A-Za-z0-9_./-]+\.(?:rs|sol|go|ts|tsx|js|jsx|mjs|cjs|py|cairo|move))(?::(\d+))?/);
  if (!match) return "(no source slice could be resolved from the location; reason from the claim and your knowledge)";
  const file = match[1] ?? "";
  const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
  const doc = source.find((d) => d.path === file) ?? source.find((d) => d.path.endsWith(`/${file}`) || d.path.endsWith(file)) ?? source.find((d) => d.path.includes(file));
  if (!doc) return `(source file "${file}" not found in scope)`;
  const lines = doc.content.split(/\r?\n/);
  if (lines.length <= 500) return `${doc.path} (${lines.length} lines):\n${numbered(lines, 1)}`;
  const start = line ? Math.max(1, line - 120) : 1;
  const end = Math.min(lines.length, start + 399);
  return `${doc.path} lines ${start}-${end} of ${lines.length}:\n${numbered(lines.slice(start - 1, end), start)}`;
}

function numbered(lines: string[], start: number): string {
  return lines.map((line, idx) => `${start + idx}\t${line}`).join("\n");
}
