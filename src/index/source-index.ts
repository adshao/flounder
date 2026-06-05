import type { AuditItem, Doc } from "../types.js";
import { numberLines } from "../ingest/source.js";

interface Slice {
  doc: Doc;
  startLine: number;
  endLine: number;
  reason: string;
}

export interface SymbolRef {
  name: string;
  kind: "function" | "struct" | "class" | "contract" | "impl" | "module";
  path: string;
  line: number;
}

export class SourceIndex {
  readonly docs: Doc[];
  readonly symbols: SymbolRef[];

  constructor(docs: Doc[]) {
    this.docs = docs;
    this.symbols = docs.flatMap((doc) => extractSymbols(doc));
  }

  contextForItem(item: AuditItem, budget: number): string {
    const slices = this.slicesForItem(item);
    const seen = new Set<string>();
    const chunks: string[] = [];
    let used = 0;

    for (const slice of slices) {
      const key = `${slice.doc.path}:${slice.startLine}:${slice.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const body = lineSlice(slice.doc, slice.startLine, slice.endLine);
      const block = `\n===== FILE: ${slice.doc.path} lines ${slice.startLine}-${slice.endLine} (${slice.reason}) =====\n${body}\n`;
      if (used + block.length > budget) {
        const remaining = budget - used;
        if (remaining > 1000) chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
        break;
      }
      chunks.push(block);
      used += block.length;
    }

    if (chunks.length > 0) return chunks.join("");
    return fallbackContext(this.docs, budget);
  }

  slicesForItem(item: AuditItem): Slice[] {
    const out: Slice[] = [];
    const direct = parseLocation(item.location);
    if (direct) {
      const doc = this.findDoc(direct.pathHint);
      if (doc) {
        out.push({
          doc,
          startLine: Math.max(1, direct.line - 80),
          endLine: direct.line + 80,
          reason: "direct location",
        });
      }
    }

    const terms = termsForItem(item);
    for (const doc of this.docs) {
      const lineHits = searchLines(doc, terms).slice(0, 6);
      for (const hit of lineHits) {
        out.push({
          doc,
          startLine: Math.max(1, hit - 35),
          endLine: hit + 35,
          reason: "term match",
        });
      }
    }

    for (const symbol of this.symbols) {
      if (!terms.some((term) => symbol.name.toLowerCase().includes(term))) continue;
      const doc = this.findDoc(symbol.path);
      if (!doc) continue;
      out.push({
        doc,
        startLine: Math.max(1, symbol.line - 40),
        endLine: symbol.line + 80,
        reason: `${symbol.kind} ${symbol.name}`,
      });
    }

    return out;
  }

  findDoc(pathHint: string): Doc | undefined {
    const lowered = pathHint.toLowerCase();
    return (
      this.docs.find((doc) => doc.path.toLowerCase() === lowered) ??
      this.docs.find((doc) => lowered.includes(doc.path.toLowerCase())) ??
      this.docs.find((doc) => doc.path.toLowerCase().includes(lowered)) ??
      this.docs.find((doc) => doc.path.toLowerCase().endsWith(lowered.split("/").at(-1) ?? lowered))
    );
  }
}

function fallbackContext(docs: Doc[], budget: number): string {
  const chunks: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const block = `\n===== FILE: ${doc.path} =====\n${numberLines(doc.content)}\n`;
    if (used + block.length > budget) {
      const remaining = budget - used;
      if (remaining > 1000) chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
      break;
    }
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("");
}

function parseLocation(location: string): { pathHint: string; line: number } | undefined {
  const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(location.trim());
  if (!match) return undefined;
  const pathHint = match[1];
  const line = Number.parseInt(match[2] ?? "", 10);
  if (!pathHint || !Number.isFinite(line)) return undefined;
  return { pathHint, line };
}

function termsForItem(item: AuditItem): string[] {
  const text = [
    item.id,
    item.location,
    item.securityProperty,
    item.failureMode,
    item.why,
    ...(item.attackerControlledInputs ?? []),
  ].join(" ");
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 4);
  const priority = [
    "assign_advice",
    "copy_advice",
    "nullifier",
    "balance",
    "supply",
    "signature",
    "verify",
    "owner",
    "admin",
    "external",
    "call",
    "proof",
    "constraint",
  ];
  return [...new Set([...priority.filter((term) => text.toLowerCase().includes(term)), ...raw])].slice(0, 24);
}

function searchLines(doc: Doc, terms: string[]): number[] {
  if (terms.length === 0) return [];
  const hits: number[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lowered = (lines[idx] ?? "").toLowerCase();
    if (terms.some((term) => lowered.includes(term))) hits.push(idx + 1);
  }
  return hits;
}

function lineSlice(doc: Doc, startLine: number, endLine: number): string {
  const lines = doc.content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  return lines
    .slice(start - 1, end)
    .map((line, idx) => `${String(start + idx).padStart(5, " ")}  ${line}`)
    .join("\n");
}

function extractSymbols(doc: Doc): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  const lines = doc.content.split(/\r?\n/);
  const ext = doc.path.split(".").at(-1) ?? "";
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const ref = symbolFromLine(line, ext);
    if (ref) symbols.push({ ...ref, path: doc.path, line: idx + 1 });
  }
  return symbols;
}

function symbolFromLine(line: string, ext: string): Omit<SymbolRef, "path" | "line"> | undefined {
  const patterns: Array<[RegExp, SymbolRef["kind"]]> = [
    [/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/, "function"],
    [/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, "function"],
    [/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, "function"],
    [/\b(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "struct"],
    [/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "class"],
    [/\bcontract\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "contract"],
    [/\bimpl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "impl"],
    [/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\b/, "module"],
  ];
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(line);
    if (!match) continue;
    const name = kind === "struct" ? match[2] : match[1];
    if (!name) continue;
    if (ext === "rs" && kind === "contract") continue;
    return { name, kind };
  }
  return undefined;
}
