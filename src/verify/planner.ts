import type { AuditorConfig } from "../config.js";
import { buildVerifyPrompt, VERIFY_SYSTEM } from "../agents/prompts.js";
import { SourceIndex } from "../index/source-index.js";
import type { Doc, LlmClient, RankedFinding, Verification } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export async function verifyTop(input: {
  cfg: AuditorConfig;
  findings: RankedFinding[];
  source: Doc[];
  llm?: LlmClient;
  logger: RunLogger;
  topK: number;
}): Promise<Verification[]> {
  if (input.cfg.dryRun || !input.llm) {
    const out = input.findings.slice(0, input.topK).map((finding) => ({
      id: finding.id,
      markdown: `VERDICT: needs-investigation\n\nDry-run mode skipped model verification for ${finding.title}.`,
    }));
    await input.logger.artifact("verifications.json", out);
    return out;
  }
  const index = new SourceIndex(input.source);
  const out: Verification[] = [];
  for (const finding of input.findings.slice(0, input.topK)) {
    const sourceText = index.contextForItem(
      {
        id: finding.id,
        location: finding.location,
        securityProperty: finding.description,
        failureMode: finding.failureMode,
        why: finding.evidence,
      },
      input.cfg.contextCharBudget,
    );
    const user = buildVerifyPrompt({
      title: finding.title,
      location: finding.location,
      severity: finding.severity,
      description: finding.description,
      evidence: finding.evidence,
      fix: finding.fix,
      source: sourceText,
    });
    const markdown = await input.llm.complete({
      tag: `verify_${finding.id}`,
      system: VERIFY_SYSTEM,
      user,
      model: input.cfg.verifyModel,
      maxTokens: input.cfg.maxTokens,
      thinkingLevel: input.cfg.thinkingLevel,
    });
    out.push({ id: finding.id, markdown });
  }
  await input.logger.artifact("verifications.json", out);
  return out;
}
