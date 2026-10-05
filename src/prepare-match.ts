// Normalize provenance labels from external verifiers before the Prepare gate or UI
// interprets them. A similar/partial verification does not prove that staged
// source is the exact code running at the target address.
export function normalizePrepareMatchStatus(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (words === "na" || words === "none" || words.startsWith("n/a") || words.includes("not applicable")) return "n/a";
  if (/\b(unverified|similar|partial|mixed|mismatch|unknown)\b/.test(words)
    || /\b(not verified|not matched|not exact|no match)\b/.test(words)) return "unverified";
  if (words === "matched" || words === "exact" || /\bexact match\b/.test(words)
    || /\bverified exact\b/.test(words)
    || /\bfull match\b/.test(words)
    || /\bfull sourcify\b/.test(words)) return "matched";
  return raw;
}

export function isPrepareDeploymentMatchRequired(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["required", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isUnresolvedPrepareScopeDeclaration(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return ["partial", "partially_resolved", "pending", "unresolved", "in_progress", "unknown"].includes(status);
}
