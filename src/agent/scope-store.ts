import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditScope } from "./tools.js";

// The map phase enumerates the full scope inventory once; dig works through it in
// batches. Persisting the inventory (with per-scope status) under the project
// history dir makes the map → dig flow RESUMABLE: re-running the same command
// audits the next un-audited scopes instead of re-mapping or re-digging. This is
// how a large inventory gets full coverage across several budget-limited runs.

const SCOPES_FILE = "scopes.json";

function scopesPath(historyDir: string): string {
  return path.join(historyDir, SCOPES_FILE);
}

export async function loadScopeInventory(historyDir: string): Promise<AuditScope[]> {
  try {
    const parsed = JSON.parse(await readFile(scopesPath(historyDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is AuditScope => Boolean(scope) && typeof scope === "object" && typeof scope.region === "string" && typeof scope.obligation === "string");
  } catch {
    return [];
  }
}

export async function saveScopeInventory(historyDir: string, scopes: AuditScope[]): Promise<void> {
  await mkdir(historyDir, { recursive: true });
  await writeFile(scopesPath(historyDir), `${JSON.stringify(scopes, null, 2)}\n`);
}

export interface ScopeInventoryMergeResult {
  scopes: AuditScope[];
  added: number;
  skippedDuplicate: number;
}

export function mergeScopeInventory(existing: AuditScope[], additions: AuditScope[]): ScopeInventoryMergeResult {
  const out = existing.map((scope) => ({ ...scope }));
  const keys = new Set(out.map(scopeKey));
  const ids = new Set(out.map((scope) => scope.id.trim().toLowerCase()).filter(Boolean));
  let added = 0;
  let skippedDuplicate = 0;
  for (const addition of additions) {
    const key = scopeKey(addition);
    if (keys.has(key)) {
      skippedDuplicate += 1;
      continue;
    }
    keys.add(key);
    let id = addition.id.trim() || `S${out.length + 1}`;
    if (ids.has(id.toLowerCase())) id = nextScopeId(ids, id);
    ids.add(id.toLowerCase());
    out.push({ ...addition, id, status: addition.status ?? "pending", source: addition.source ?? "map" });
    added += 1;
  }
  return { scopes: out, added, skippedDuplicate };
}

export function scopeProgress(scopes: AuditScope[]): { total: number; audited: number; pending: number; deferred: number } {
  const audited = scopes.filter((scope) => scope.status === "audited").length;
  const deferred = scopes.filter((scope) => scope.status === "deferred").length;
  return { total: scopes.length, audited, deferred, pending: scopes.length - audited - deferred };
}

function scopeKey(scope: AuditScope): string {
  return `${normalizeScopeText(scope.region)}::${normalizeScopeText(scope.obligation)}`;
}

function normalizeScopeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function nextScopeId(existingIds: Set<string>, preferred: string): string {
  const prefix = preferred.replace(/\d+$/, "") || "S";
  let n = 1;
  while (existingIds.has(`${prefix}${n}`.toLowerCase())) n += 1;
  return `${prefix}${n}`;
}
