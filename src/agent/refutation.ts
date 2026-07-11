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

export interface RefutationError {
  findingId: string;
  error: string;
}

export interface RefutationResult {
  attempted: number;
  verdicts: RefutationVerdict[];
  errors: RefutationError[];
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
  // Reports which finding is being refuted, so the caller can surface progress in the live UI
  // (the refutation runs after the dig's scope batch, where the activity stream otherwise goes quiet).
  onProgress?: (findingId: string) => void;
}): Promise<RefutationResult> {
  const attemptedFindings = input.findings.slice(0, Math.max(0, input.max));
  const verdicts: RefutationVerdict[] = [];
  const errors: RefutationError[] = [];
  for (const finding of attemptedFindings) {
    input.onProgress?.(finding.id);
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
        verdicts.push(verdict);
        await input.logger.event("audit_refutation", { findingId: finding.id, refuted: verdict.refuted, unrealistic });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      errors.push({ findingId: finding.id, error: message });
      await input.logger.event("audit_refutation_error", { findingId: finding.id, error: message });
    }
  }
  return { attempted: attemptedFindings.length, verdicts, errors };
}

// Discharge challenge — the FALSE-NEGATIVE counterpart of runRefutation. The dig marks many
// obligations DISCHARGED (judged satisfied) and moves on; a wrong discharge is a silent miss with
// no guard, while a wrong confirmation gets the refutation skeptic above. This restores the
// symmetry: an independent skeptic re-examines each discharge and tries to BREAK it; an UNSOUND
// discharge is re-opened as a candidate. (This is what catches the "discharged a narrower
// sub-property than the obligation required" trap — e.g. proving a value can't be forged but not
// that the by-design path it enables is authorized.)
export const CHALLENGE_DISCHARGE_SYSTEM = `You are an independent adversarial reviewer guarding against FALSE NEGATIVES. Another auditor judged a security OBLIGATION SATISFIED ("discharged") and moved on. You did NOT do their investigation; do not assume the discharge is correct.

A discharge is UNSOUND when the cited enforcement clears only a NARROWER property than the obligation actually requires. The classic traps:
- it proves a value cannot be FORGED, but not that the path that value enables is AUTHORIZED — a legitimately-reachable "by-design" / escape / emergency / admin / fallback path is itself a trust boundary; "intended to exist" and "its parameter cannot be forged" do NOT make the path safe;
- it binds the value to an ADJACENT or internal referent, not the specific trusted source the obligation names;
- it checks the value on the CANONICAL path while a sibling / edge / fallback path reaches the SAME sink unchecked;
- it relies on "matches upstream / the spec / looks standard" — a reference can carry the same gap.

From the actual code and first principles, try to BREAK the discharge: trace whether the obligation's real security property holds end-to-end — all the way to the value/authority SINK it protects, across every reachable path and CALLER, not just the one the auditor examined. Who can reach the protected effect, and is each input that decides it (recipient, amount, the caller, the proof/signature that authorizes it) bound to a legitimate authority?

Respond with ONLY a JSON object (no prose, no fences): {"unsound": true|false, "title": "<if unsound: concise mechanism-specific root-cause title; else empty>", "gap": "<if unsound: the exact missed path/case, with file:line and the resulting attacker impact; else empty>", "reason": "<concise and specific>"}.
- unsound=true: the discharge does NOT actually clear the obligation — give the candidate a concise mechanism-specific title, then name the missed path/case and attacker impact. The title must identify this exact root cause rather than repeat the broad obligation.
- unsound=false: after genuine effort the obligation holds end-to-end — say why.
Be skeptical but honest: default to challenging hard, but if the property genuinely holds, say unsound=false.`;

export interface DischargeVerdict {
  findingId: string;
  unsound: boolean;
  title: string;
  gap: string;
  reason: string;
}

export async function runDischargeChallenge(input: {
  findings: AgentFinding[];
  source: Doc[];
  cfg: AuditorConfig;
  llm: LlmClient;
  logger: RunLogger;
  max: number;
  onProgress?: (findingId: string) => void;
}): Promise<DischargeVerdict[]> {
  const out: DischargeVerdict[] = [];
  for (const finding of input.findings.slice(0, Math.max(0, input.max))) {
    input.onProgress?.(finding.id);
    const user = buildChallengePrompt(finding, sourceForLocation(input.source, finding.location));
    try {
      const raw = await input.llm.complete({
        tag: `challenge_${finding.id}`,
        system: CHALLENGE_DISCHARGE_SYSTEM,
        user,
        model: input.cfg.auditModel,
        maxTokens: input.cfg.maxTokens,
        thinkingLevel: input.cfg.thinkingLevel,
        agentic: true,
      });
      const parsed = extractJsonObject<{ unsound?: unknown; title?: unknown; gap?: unknown; reason?: unknown }>(raw);
      if (parsed && typeof parsed.unsound === "boolean") {
        const verdict: DischargeVerdict = {
          findingId: finding.id,
          unsound: parsed.unsound,
          title: typeof parsed.title === "string" ? parsed.title.slice(0, 240) : "",
          gap: typeof parsed.gap === "string" ? parsed.gap.slice(0, 800) : "",
          reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 800) : "",
        };
        out.push(verdict);
        await input.logger.event("audit_discharge_challenge", { findingId: finding.id, unsound: verdict.unsound, gap: verdict.gap.slice(0, 160) });
      }
    } catch (error) {
      await input.logger.event("audit_discharge_challenge_error", { findingId: finding.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return out;
}

function buildChallengePrompt(finding: AgentFinding, sourceSlice: string): string {
  return `Another auditor judged this security obligation SATISFIED (discharged) and moved on:
- Obligation / title: ${finding.title}
- Location: ${finding.location}
- Their discharge reasoning: ${finding.description || "(none)"}
- Evidence they cited: ${finding.evidence || "(none)"}

Relevant source:
${sourceSlice}

Independently try to BREAK this discharge: does the cited enforcement clear the obligation's FULL security property end-to-end (to the sink/effect it protects, across every reachable path and caller), or only a narrower sub-property? Respond with the JSON verdict only.`;
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
