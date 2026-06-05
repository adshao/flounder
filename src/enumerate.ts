import type { AuditorConfig } from "./config.js";
import { buildEnumerationPrompt, ENUM_SYSTEM } from "./agents/prompts.js";
import { assemble } from "./ingest/source.js";
import { runSeeders } from "./seeders/index.js";
import type { AuditItem, Doc, LlmClient } from "./types.js";
import { extractJsonArray } from "./util/json.js";
import type { RunLogger } from "./trace/logger.js";

interface RawAuditItem {
  id?: string;
  location?: string;
  securityProperty?: string;
  security_property?: string;
  failureMode?: string;
  failure_mode?: string;
  why?: string;
  specRefs?: string[];
  spec_refs?: string[];
  attackerControlledInputs?: string[];
  attacker_controlled_inputs?: string[];
}

export async function enumerateAuditItems(input: {
  cfg: AuditorConfig;
  corpus: Doc[];
  source: Doc[];
  llm?: LlmClient;
  logger: RunLogger;
}): Promise<AuditItem[]> {
  const seeded = runSeeders(input.source);
  await input.logger.event("seeders_done", { nItems: seeded.length });

  if (input.cfg.dryRun || !input.llm) {
    await input.logger.artifact("checklist.json", seeded);
    return seeded;
  }

  const corpusText = assemble(input.corpus, Math.floor(input.cfg.contextCharBudget / 2));
  const sourceText = assemble(input.source, Math.floor(input.cfg.contextCharBudget / 2), true);
  const user = buildEnumerationPrompt({
    target: input.cfg.targetName,
    failureModes: input.cfg.failureModes,
    corpus: corpusText,
    source: sourceText,
  });
  const text = await input.llm.complete({
    tag: "enumerate",
    system: ENUM_SYSTEM,
    user,
    model: input.cfg.enumModel,
    maxTokens: input.cfg.maxTokens,
    thinkingLevel: input.cfg.thinkingLevel,
  });

  const llmItems = extractJsonArray<RawAuditItem>(text).map(normalizeItem).filter((item): item is AuditItem => item !== undefined);
  const all = dedupe([...seeded, ...llmItems]);
  await input.logger.artifact("checklist.json", all);
  await input.logger.event("enumeration_done", { seeded: seeded.length, llm: llmItems.length, total: all.length });
  return all;
}

function normalizeItem(raw: RawAuditItem): AuditItem | undefined {
  const location = raw.location?.trim();
  const securityProperty = (raw.securityProperty ?? raw.security_property)?.trim();
  const failureMode = (raw.failureMode ?? raw.failure_mode)?.trim();
  if (!location || !securityProperty || !failureMode) return undefined;
  const item: AuditItem = {
    id: raw.id?.trim() || slug(`${failureMode}-${location}`),
    location,
    securityProperty,
    failureMode: failureMode as AuditItem["failureMode"],
    why: raw.why?.trim() || "Enumerated by model.",
  };
  const specRefs = raw.specRefs ?? raw.spec_refs;
  const attackerControlledInputs = raw.attackerControlledInputs ?? raw.attacker_controlled_inputs;
  if (specRefs) item.specRefs = specRefs;
  if (attackerControlledInputs) item.attackerControlledInputs = attackerControlledInputs;
  return item;
}

function dedupe(items: AuditItem[]): AuditItem[] {
  const seen = new Set<string>();
  const out: AuditItem[] = [];
  for (const item of items) {
    const key = `${item.location}|${item.failureMode}|${item.securityProperty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.map((item, idx) => ({ ...item, id: item.id || `item-${idx}` }));
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
