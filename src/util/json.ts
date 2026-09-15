export function extractJsonArray<T>(text: string): T[] {
  const trimmed = stripFence(text.trim());
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function extractJsonObject<T>(text: string): T | undefined {
  const trimmed = stripFence(text.trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

// Models occasionally emit a JSON object whose final value is missing its
// closing bracket — a truncation-style slip inside a long payload. Appending
// exactly the missing closers recovers it. Everything else is returned
// untouched, so the caller's parse-error path still sees it: trailing text
// after the object, extra closers, a string left open, a mismatched delimiter,
// or JSON wrapped in prose.
export function repairUnbalancedJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const last = trimmed.at(-1);
  if (last !== "}" && last !== "]") return trimmed;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of trimmed) {
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr || stack.length === 0) return trimmed;
  return trimmed + stack.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
}

function stripFence(text: string): string {
  return text
    .replace(/^```(?:json|markdown|md)?/gm, "")
    .replace(/```$/gm, "")
    .trim();
}
