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

function stripFence(text: string): string {
  return text
    .replace(/^```(?:json|markdown|md)?/gm, "")
    .replace(/```$/gm, "")
    .trim();
}
