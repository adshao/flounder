import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AuditScope } from "./tools.js";

// The map phase enumerates the full scope inventory once; dig works through it in
// batches. Persisting the inventory (with per-scope status) under the project
// history dir makes the map → dig flow RESUMABLE: re-running the same command
// audits the next un-audited scopes instead of re-mapping or re-digging. This is
// how a large inventory gets full coverage across several budget-limited runs.

const SCOPES_FILE = "scopes.json";
const pendingWrites = new Map<string, Promise<void>>();

function scopesPath(historyDir: string): string {
  return path.join(historyDir, SCOPES_FILE);
}

export async function loadScopeInventory(historyDir: string, materialFingerprint?: string): Promise<AuditScope[]> {
  const file = scopesPath(historyDir);
  const pending = pendingWrites.get(file);
  if (pending) await pending;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Invalid scope inventory at ${file}: expected a JSON array.`);
    const normalized = parsed.map((scope, index) => normalizeAuditScope(scope, index));
    const invalid = normalized.findIndex((scope) => !scope);
    if (invalid >= 0) throw new Error(`Invalid scope inventory at ${file}: entry ${invalid} is incomplete.`);
    const scopes = normalized as AuditScope[];
    if (!materialFingerprint) return scopes;
    // Legacy or different-material inventories remain readable to operators, but
    // the audit fails closed into a fresh MAP instead of silently reusing them.
    return scopes.filter((scope) => scope.materialFingerprint === materialFingerprint);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load scope inventory ${file}: ${detail}`, { cause: error });
  }
}

export function saveScopeInventory(historyDir: string, scopes: AuditScope[]): Promise<void> {
  const file = scopesPath(historyDir);
  const snapshot = `${JSON.stringify(scopes, null, 2)}\n`;
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => atomicWriteScopeInventory(historyDir, file, snapshot));
  pendingWrites.set(file, write);
  return write.finally(() => {
    if (pendingWrites.get(file) === write) pendingWrites.delete(file);
  });
}

async function atomicWriteScopeInventory(historyDir: string, file: string, snapshot: string): Promise<void> {
  await mkdir(historyDir, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(snapshot, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
    try {
      const directory = await open(historyDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      // The rename is still atomic on platforms that do not permit opening or
      // fsyncing a directory handle. Linux/macOS take the durable path above.
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function normalizeAuditScope(value: unknown, index: number): AuditScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const scope = value as Partial<AuditScope>;
  const region = typeof scope.region === "string" ? scope.region.trim() : "";
  const obligation = typeof scope.obligation === "string" ? scope.obligation.trim() : "";
  if (!region || !obligation) return undefined;
  const status: NonNullable<AuditScope["status"]> = ["pending", "audited", "deferred", "auditing"].includes(String(scope.status))
    ? scope.status as NonNullable<AuditScope["status"]>
    : "pending";
  const source: AuditScope["source"] = ["map", "followup", "coverage-gap"].includes(String(scope.source))
    ? scope.source as NonNullable<AuditScope["source"]>
    : undefined;
  return {
    id: typeof scope.id === "string" && scope.id.trim() ? scope.id.trim() : `S${index + 1}`,
    obligation,
    region,
    lenses: Array.isArray(scope.lenses)
      ? scope.lenses.filter((lens): lens is string => typeof lens === "string").map((lens) => lens.trim()).filter(Boolean)
      : [],
    exposure: typeof scope.exposure === "string" ? scope.exposure : "unknown",
    difficulty: typeof scope.difficulty === "string" ? scope.difficulty : "unknown",
    score: typeof scope.score === "number" && Number.isFinite(scope.score) ? scope.score : 0,
    why: typeof scope.why === "string" ? scope.why : "",
    status,
    ...(source ? { source } : {}),
    ...(typeof scope.digSeconds === "number" && Number.isFinite(scope.digSeconds) ? { digSeconds: scope.digSeconds } : {}),
    ...(typeof scope.priority === "number" && Number.isFinite(scope.priority) ? { priority: scope.priority } : {}),
    ...(typeof scope.parentScopeId === "string" && scope.parentScopeId.trim() ? { parentScopeId: scope.parentScopeId.trim() } : {}),
    ...(typeof scope.materialFingerprint === "string" && scope.materialFingerprint.trim() ? { materialFingerprint: scope.materialFingerprint.trim() } : {}),
    ...(Array.isArray(scope.mapSamples)
      ? { mapSamples: [...new Set(scope.mapSamples.filter((sample): sample is number => typeof sample === "number" && Number.isInteger(sample) && sample > 0))].sort((a, b) => a - b) }
      : {}),
    ...(typeof scope.mapAgreement === "number" && Number.isFinite(scope.mapAgreement) ? { mapAgreement: Math.max(1, Math.floor(scope.mapAgreement)) } : {}),
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(String((error as { code?: unknown }).code));
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
