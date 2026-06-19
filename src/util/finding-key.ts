// The content-stable dedup key for a finding, shared by the DB write path (toFindingRow) and the
// confirm phase (which loads findings from run dirs and must address the SAME DB rows by key). It is
// independent of the display id (f1..fN), which is renumbered, so the same finding keeps one key
// across incremental persists, status updates, and cross-run aggregation.
export function findingContentKey(scopeId?: unknown, location?: unknown, title?: unknown): string {
  const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const basis = `${s(scopeId)}|${s(location)}|${s(title)}`;
  if (!basis.replace(/\|/g, "")) return "k0"; // no content to key on
  let h = 5381;
  for (let i = 0; i < basis.length; i += 1) h = (((h << 5) + h) ^ basis.charCodeAt(i)) | 0;
  return "k" + (h >>> 0).toString(36);
}
