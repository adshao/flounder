import type { AuditItem, Doc } from "../types.js";
import { genericSecuritySeeders } from "./generic.js";
import { halo2MissingConstraintSeeder } from "./halo2.js";

export function runSeeders(source: Doc[]): AuditItem[] {
  return dedupeItems([...halo2MissingConstraintSeeder(source), ...genericSecuritySeeders(source)]);
}

function dedupeItems(items: AuditItem[]): AuditItem[] {
  const seen = new Set<string>();
  const out: AuditItem[] = [];
  for (const item of items) {
    const key = `${item.location}|${item.failureMode}|${item.securityProperty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
