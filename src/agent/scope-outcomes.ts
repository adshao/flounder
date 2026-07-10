import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentSession } from "./tools.js";

const pendingWrites = new Map<string, Promise<void>>();

export const SCOPE_OUTCOME_FILE = "scope_outcome.json";
export const SCOPE_OUTCOMES_FILE = "scope_outcomes.json";

export type ScopeObligationStatus = "discharged" | "unmet" | "uncertain" | "blocked";

export interface ScopeObligationOutcome {
  id: string;
  statement: string;
  status: ScopeObligationStatus;
  location?: string;
  evidence?: string;
  confidence?: number;
}

export interface CompositionEdge {
  id: string;
  kind: "input" | "authority" | "binding" | "transformation" | "sink" | "boundary";
  description: string;
  status: "observed" | "unresolved";
  location?: string;
  from?: string;
  to?: string;
}

export interface ScopeOutcome {
  scopeId: string;
  sample: number;
  materialFingerprint?: string;
  coverageComplete: boolean;
  obligations: ScopeObligationOutcome[];
  compositionEdges: CompositionEdge[];
  blockers: string[];
  summary?: string;
}

export interface ScopeOutcomeParseResult {
  outcome?: ScopeOutcome;
  errors: string[];
}

export function clearScratchScopeOutcome(session: AgentSession): void {
  for (const key of [...session.scratchFiles.keys()]) {
    if (path.posix.basename(key) === SCOPE_OUTCOME_FILE) session.scratchFiles.delete(key);
  }
}

export function scratchHasScopeOutcome(session: AgentSession): boolean {
  return scratchOutcomeEntry(session) !== undefined;
}

export function readScratchScopeOutcome(
  session: AgentSession,
  context: { scopeId: string; sample: number; materialFingerprint?: string },
): ScopeOutcomeParseResult {
  const entry = scratchOutcomeEntry(session);
  if (!entry) return { errors: [`${SCOPE_OUTCOME_FILE}: missing required per-scope coverage artifact`] };
  let raw: unknown;
  try {
    raw = JSON.parse(entry.content);
  } catch (error) {
    return { errors: [`${entry.path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: [`${entry.path}: expected a JSON object`] };
  const row = raw as Record<string, unknown>;
  const obligationsRaw = Array.isArray(row.obligations) ? row.obligations : [];
  const edgesRaw = Array.isArray(row.composition_edges ?? row.compositionEdges) ? (row.composition_edges ?? row.compositionEdges) as unknown[] : [];
  const errors: string[] = [];
  const obligations = obligationsRaw.map((item, index) => normalizeObligation(item, index, errors)).filter((item): item is ScopeObligationOutcome => Boolean(item));
  const compositionEdges = edgesRaw.map((item, index) => normalizeEdge(item, index, errors)).filter((item): item is CompositionEdge => Boolean(item));
  const blockers = stringList(row.blockers);
  const summary = stringValue(row.summary);
  const declaredScopeId = stringValue(row.scope_id ?? row.scopeId);
  if (declaredScopeId && declaredScopeId !== context.scopeId) errors.push(`${entry.path}: scope_id ${declaredScopeId} does not match ${context.scopeId}`);
  const outcome: ScopeOutcome = {
    scopeId: context.scopeId,
    sample: context.sample,
    ...(context.materialFingerprint ? { materialFingerprint: context.materialFingerprint } : {}),
    coverageComplete: row.coverage_complete === true || row.coverageComplete === true,
    obligations,
    compositionEdges,
    blockers,
    ...(summary ? { summary } : {}),
  };
  if (obligations.length === 0) errors.push(`${entry.path}: obligations must contain the model's checked security obligations`);
  if (blockers.length > 0 && outcome.coverageComplete) {
    outcome.coverageComplete = false;
    errors.push(`${entry.path}: coverage_complete cannot be true while blockers remain`);
  }
  if (errors.length > 0) outcome.coverageComplete = false;
  return { outcome, errors };
}

export function incompleteScopeOutcome(
  scopeId: string,
  sample: number,
  reason: string,
  materialFingerprint?: string,
): ScopeOutcome {
  return {
    scopeId,
    sample,
    ...(materialFingerprint ? { materialFingerprint } : {}),
    coverageComplete: false,
    obligations: [],
    compositionEdges: [],
    blockers: [reason],
    summary: "The dig did not persist a complete scope outcome.",
  };
}

export function scopeOutcomeNeedsAnotherSample(outcomes: ScopeOutcome[]): boolean {
  const latest = outcomes[outcomes.length - 1];
  if (!latest) return true;
  if (latest.blockers.length > 0) return false; // repeating cannot repair an external resource
  if (!latest.coverageComplete) return true;
  if (latest.obligations.some((obligation) => obligation.status === "unmet" || obligation.status === "uncertain")) return true;
  if (latest.compositionEdges.some((edge) => edge.status === "unresolved")) return true;
  if (outcomes.length < 2) return false;
  const prior = outcomes[outcomes.length - 2]!;
  const priorStatuses = new Map(prior.obligations.map((obligation) => [obligationKey(obligation), obligation.status]));
  return latest.obligations.some((obligation) => {
    const previous = priorStatuses.get(obligationKey(obligation));
    return previous !== undefined && previous !== obligation.status;
  });
}

/** Latest sample is the current coverage verdict for a scope. Earlier samples
 * remain available to synthesis as disagreement/provenance, but they must not
 * keep a scope incomplete after a later sample resolves it. */
export function latestScopeOutcomes(outcomes: ScopeOutcome[]): ScopeOutcome[] {
  const latest = new Map<string, ScopeOutcome>();
  for (const outcome of outcomes) {
    const key = `${outcome.materialFingerprint ?? ""}::${outcome.scopeId}`;
    const current = latest.get(key);
    if (!current || outcome.sample >= current.sample) latest.set(key, outcome);
  }
  return [...latest.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

/** Samples are durable across runs. A later re-audit must append after the
 * largest stored sample so an older high-numbered verdict cannot remain latest. */
export function nextScopeOutcomeSample(outcomes: ScopeOutcome[], scopeId: string): number {
  return outcomes
    .filter((outcome) => outcome.scopeId === scopeId)
    .reduce((maximum, outcome) => Math.max(maximum, outcome.sample), 0) + 1;
}

export function scopeOutcomeNeedsCoverage(outcome: ScopeOutcome): boolean {
  return !outcome.coverageComplete
    || outcome.blockers.length > 0
    || outcome.obligations.some((obligation) => obligation.status === "uncertain" || obligation.status === "blocked")
    || outcome.compositionEdges.some((edge) => edge.status === "unresolved");
}

export function mergeScopeOutcomes(existing: ScopeOutcome[], additions: ScopeOutcome[]): ScopeOutcome[] {
  const byKey = new Map<string, ScopeOutcome>();
  for (const outcome of [...existing, ...additions]) byKey.set(scopeOutcomeKey(outcome), outcome);
  return [...byKey.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.sample - b.sample);
}

export async function loadScopeOutcomes(historyDir: string, materialFingerprint?: string): Promise<ScopeOutcome[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(historyDir, SCOPE_OUTCOMES_FILE), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const outcomes = parsed.map((item, index) => validatePersistedScopeOutcome(item, index));
    return materialFingerprint ? outcomes.filter((outcome) => outcome.materialFingerprint === materialFingerprint) : outcomes;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function saveScopeOutcomes(historyDir: string, outcomes: ScopeOutcome[]): Promise<void> {
  const file = path.join(historyDir, SCOPE_OUTCOMES_FILE);
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => atomicSaveScopeOutcomes(historyDir, file, outcomes));
  pendingWrites.set(file, write);
  return write.finally(() => {
    if (pendingWrites.get(file) === write) pendingWrites.delete(file);
  });
}

export async function appendScopeOutcomes(historyDir: string, additions: ScopeOutcome[]): Promise<ScopeOutcome[]> {
  const file = path.join(historyDir, SCOPE_OUTCOMES_FILE);
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  let merged: ScopeOutcome[] = [];
  const write = previous.catch(() => undefined).then(async () => {
    merged = mergeScopeOutcomes(await loadScopeOutcomes(historyDir), additions);
    await atomicSaveScopeOutcomes(historyDir, file, merged);
  });
  pendingWrites.set(file, write);
  await write.finally(() => {
    if (pendingWrites.get(file) === write) pendingWrites.delete(file);
  });
  return merged;
}

async function atomicSaveScopeOutcomes(historyDir: string, file: string, outcomes: ScopeOutcome[]): Promise<void> {
  await mkdir(historyDir, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(outcomes, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

function scratchOutcomeEntry(session: AgentSession): { path: string; content: string } | undefined {
  const direct = session.scratchFiles.get(SCOPE_OUTCOME_FILE);
  if (direct !== undefined) return { path: SCOPE_OUTCOME_FILE, content: direct };
  const match = [...session.scratchFiles.entries()]
    .filter(([filePath]) => path.posix.basename(filePath) === SCOPE_OUTCOME_FILE)
    .sort((a, b) => a[0].length - b[0].length)[0];
  return match ? { path: match[0], content: match[1] } : undefined;
}

function normalizeObligation(value: unknown, index: number, errors: string[]): ScopeObligationOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`obligations[${index}]: expected object`);
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const statement = stringValue(row.statement ?? row.obligation ?? row.property);
  const status = stringValue(row.status);
  if (!statement || !status || !["discharged", "unmet", "uncertain", "blocked"].includes(status)) {
    errors.push(`obligations[${index}]: statement and valid status are required`);
    return undefined;
  }
  const confidence = numberValue(row.confidence);
  const location = stringValue(row.location);
  const evidence = stringValue(row.evidence);
  return {
    id: stringValue(row.id) ?? `O${index + 1}`,
    statement,
    status: status as ScopeObligationStatus,
    ...(location ? { location } : {}),
    ...(evidence ? { evidence } : {}),
    ...(confidence !== undefined ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
  };
}

function normalizeEdge(value: unknown, index: number, errors: string[]): CompositionEdge | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`composition_edges[${index}]: expected object`);
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const description = stringValue(row.description ?? row.edge);
  const kind = stringValue(row.kind);
  if (!description || !kind || !["input", "authority", "binding", "transformation", "sink", "boundary"].includes(kind)) {
    errors.push(`composition_edges[${index}]: description and valid kind are required`);
    return undefined;
  }
  const status = stringValue(row.status);
  if (status !== "observed" && status !== "unresolved") {
    errors.push(`composition_edges[${index}]: status must be observed or unresolved`);
    return undefined;
  }
  const location = stringValue(row.location);
  const from = stringValue(row.from);
  const to = stringValue(row.to);
  return {
    id: stringValue(row.id) ?? `E${index + 1}`,
    kind: kind as CompositionEdge["kind"],
    description,
    status,
    ...(location ? { location } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

function validatePersistedScopeOutcome(value: unknown, index: number): ScopeOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid scope outcomes entry ${index}: expected object`);
  const row = value as Record<string, unknown>;
  const scopeId = stringValue(row.scopeId);
  if (!scopeId || !Number.isInteger(row.sample) || Number(row.sample) < 1 || typeof row.coverageComplete !== "boolean") {
    throw new Error(`Invalid scope outcomes entry ${index}: scopeId, positive sample, and coverageComplete are required`);
  }
  if (!Array.isArray(row.obligations) || !Array.isArray(row.compositionEdges) || !Array.isArray(row.blockers)) {
    throw new Error(`Invalid scope outcomes entry ${index}: obligations, compositionEdges, and blockers must be arrays`);
  }
  const errors: string[] = [];
  const obligations = row.obligations.map((item, obligationIndex) => normalizeObligation(item, obligationIndex, errors)).filter((item): item is ScopeObligationOutcome => Boolean(item));
  const compositionEdges = row.compositionEdges.map((item, edgeIndex) => normalizeEdge(item, edgeIndex, errors)).filter((item): item is CompositionEdge => Boolean(item));
  const blockers = stringList(row.blockers);
  if (errors.length > 0 || obligations.length !== row.obligations.length || compositionEdges.length !== row.compositionEdges.length || blockers.length !== row.blockers.length) {
    throw new Error(`Invalid scope outcomes entry ${index}: ${errors.join("; ") || "invalid array value"}`);
  }
  const materialFingerprint = stringValue(row.materialFingerprint);
  const summary = stringValue(row.summary);
  return {
    scopeId,
    sample: Number(row.sample),
    ...(materialFingerprint ? { materialFingerprint } : {}),
    coverageComplete: row.coverageComplete,
    obligations,
    compositionEdges,
    blockers,
    ...(summary ? { summary } : {}),
  };
}

function scopeOutcomeKey(outcome: ScopeOutcome): string {
  return `${outcome.materialFingerprint ?? ""}::${outcome.scopeId}::${outcome.sample}`;
}

function obligationKey(obligation: ScopeObligationOutcome): string {
  return `${obligation.location ?? ""}::${obligation.statement}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
