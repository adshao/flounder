import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const pendingMemoryWrites = new Map<string, Promise<void>>();

// Cross-run learning substrate. The framework provides a durable place to keep
// what the model judged worth remembering between runs of the same target
// (confirmed findings, refuted hypotheses, hard-won domain insight). The model
// decides what to write and when to read; the framework only stores and recalls.
// This is deliberately a thin keyword store, not a strategy engine.

export type MemoryKind = "finding" | "dead-end" | "insight" | "resource" | "build" | "note";

export interface MemoryNote {
  id: string;
  ts: string;
  note: string;
  tags: string[];
  kind: MemoryKind;
  sourceRef?: string;
  materialFingerprint?: string;
  /** Portable notes are deliberately generalized and may cross material versions. */
  portable?: boolean;
}

export interface RememberInput {
  note: string;
  tags?: string[];
  kind?: MemoryKind;
  sourceRef?: string;
  materialFingerprint?: string;
  portable?: boolean;
}

export interface MemoryFilter {
  materialFingerprint?: string;
  includePortable?: boolean;
}

export class ProjectMemory {
  constructor(private readonly filePath: string) {}

  /** Append a note. Returns the stored record (with generated id and timestamp). */
  async remember(input: RememberInput): Promise<MemoryNote> {
    const previous = pendingMemoryWrites.get(this.filePath) ?? Promise.resolve();
    let stored: MemoryNote | undefined;
    const write = previous.catch(() => undefined).then(async () => {
      const note = cleanText(input.note);
      if (!note) throw new Error("memory note must be a non-empty string");
      const normalizedSourceRef = cleanText(input.sourceRef ?? "");
      const existing = (await this.all()).find((candidate) =>
        candidate.note === note
        && candidate.kind === (input.kind ?? "note")
        && (candidate.sourceRef ?? "") === normalizedSourceRef
        && (candidate.materialFingerprint ?? "") === (input.materialFingerprint ?? "")
        && Boolean(candidate.portable) === Boolean(input.portable));
      if (existing) {
        stored = existing;
        return;
      }
      stored = {
        id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        note,
        tags: normalizeTags(input.tags),
        kind: input.kind ?? "note",
        ...(normalizedSourceRef ? { sourceRef: normalizedSourceRef } : {}),
        ...(input.materialFingerprint ? { materialFingerprint: input.materialFingerprint } : {}),
        ...(input.portable ? { portable: true } : {}),
      };
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(stored)}\n`);
    });
    pendingMemoryWrites.set(this.filePath, write);
    try {
      await write;
      return stored!;
    } finally {
      if (pendingMemoryWrites.get(this.filePath) === write) pendingMemoryWrites.delete(this.filePath);
    }
  }

  /** Keyword recall: rank stored notes by token overlap with the query. */
  async recall(query: string, limit = 8, filter: MemoryFilter = {}): Promise<MemoryNote[]> {
    const notes = filterMemory(await this.all(), filter);
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return notes.slice(-limit).reverse();
    const scored = notes
      .map((note) => ({ note, score: overlapScore(queryTokens, note) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.note.ts.localeCompare(a.note.ts));
    return scored.slice(0, limit).map((entry) => entry.note);
  }

  async all(filter: MemoryFilter = {}): Promise<MemoryNote[]> {
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
    return filterMemory(out, filter);
  }
}

function filterMemory(notes: MemoryNote[], filter: MemoryFilter): MemoryNote[] {
  if (!filter.materialFingerprint) return notes;
  return notes.filter((note) =>
    note.materialFingerprint === filter.materialFingerprint
    || (filter.includePortable === true && note.portable === true));
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
