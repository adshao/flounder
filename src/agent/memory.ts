import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// Cross-run learning substrate. The framework provides a durable place to keep
// what the model judged worth remembering between runs of the same target
// (confirmed findings, refuted hypotheses, hard-won domain insight). The model
// decides what to write and when to read; the framework only stores and recalls.
// This is deliberately a thin keyword store, not a strategy engine.

export type MemoryKind = "finding" | "dead-end" | "insight" | "note";

export interface MemoryNote {
  id: string;
  ts: string;
  note: string;
  tags: string[];
  kind: MemoryKind;
  sourceRef?: string;
}

export interface RememberInput {
  note: string;
  tags?: string[];
  kind?: MemoryKind;
  sourceRef?: string;
}

export class ProjectMemory {
  constructor(private readonly filePath: string) {}

  /** Append a note. Returns the stored record (with generated id and timestamp). */
  async remember(input: RememberInput): Promise<MemoryNote> {
    const note = cleanText(input.note);
    if (!note) throw new Error("memory note must be a non-empty string");
    const record: MemoryNote = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      note,
      tags: normalizeTags(input.tags),
      kind: input.kind ?? "note",
      ...(cleanText(input.sourceRef ?? "") ? { sourceRef: cleanText(input.sourceRef ?? "") } : {}),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`);
    return record;
  }

  /** Keyword recall: rank stored notes by token overlap with the query. */
  async recall(query: string, limit = 8): Promise<MemoryNote[]> {
    const notes = await this.all();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return notes.slice(-limit).reverse();
    const scored = notes
      .map((note) => ({ note, score: overlapScore(queryTokens, note) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.note.ts.localeCompare(a.note.ts));
    return scored.slice(0, limit).map((entry) => entry.note);
  }

  async all(): Promise<MemoryNote[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const out: MemoryNote[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as MemoryNote;
        if (parsed && typeof parsed.note === "string") out.push(parsed);
      } catch {
        // skip corrupt lines; memory is advisory, not authoritative
      }
    }
    return out;
  }
}

function overlapScore(queryTokens: string[], note: MemoryNote): number {
  const haystack = new Set(tokenize([note.note, note.tags.join(" "), note.sourceRef ?? ""].join(" ")));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

function tokenize(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((token) => token.length >= 3),
    ),
  ];
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => cleanText(tag)).filter((tag): tag is string => Boolean(tag)))].slice(0, 16);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2000);
}
