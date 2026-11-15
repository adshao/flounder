import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Doc } from "../types.js";

// The system model is the one piece of context every later phase needs in order
// to judge whether a behavior is a vulnerability: who the principals are and what
// each is trusted to do, what is worth attacking, where an outsider can enter, and
// which properties must hold across components. Without it each scope is audited
// cold and cannot tell an attacker-reachable violation from a behavior that only a
// trusted principal can cause.
//
// The framework owns the plumbing only. MAP writes the file with a method and a
// structure of its own choosing; the framework persists it beside the scope
// inventory (bound to the same material fingerprint) and stages it, read-only, as
// corpus material for every later workspace and for the independent skeptic. It
// is context, never evidence: it cannot confirm or refute a finding.

/** File MAP writes at its workspace root. */
export const SYSTEM_MODEL_FILE = "system_model.md";
/** Corpus-relative path later phases read it from (staged as corpus/audit-context/system_model.md). */
export const SYSTEM_MODEL_CORPUS_PATH = "audit-context/system_model.md";
/** Workspace-relative path of the staged copy, as named in prompts. */
export const SYSTEM_MODEL_WORKSPACE_PATH = `corpus/${SYSTEM_MODEL_CORPUS_PATH}`;

const MAX_SYSTEM_MODEL_CHARS = 120_000;
const STORE_FILE = "system_model.json";

interface StoredSystemModel {
  materialFingerprint?: string;
  updatedAt: string;
  text: string;
}

/** Read the model MAP wrote in a workspace, if it wrote one. */
export async function readWorkspaceSystemModel(workspaceAbsolute: string): Promise<string | undefined> {
  try {
    return normalizeSystemModel(await readFile(path.join(workspaceAbsolute, SYSTEM_MODEL_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

export function normalizeSystemModel(text: string | undefined): string | undefined {
  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_SYSTEM_MODEL_CHARS
    ? `${trimmed.slice(0, MAX_SYSTEM_MODEL_CHARS)}\n\n[system model truncated at ${MAX_SYSTEM_MODEL_CHARS} characters]`
    : trimmed;
}

/**
 * Independent MAP samples each author a model. They are kept side by side rather
 * than merged by the framework: reconciling two descriptions of a system is
 * analysis, and the framework encodes none.
 */
export function unionSystemModels(models: Array<string | undefined>): string | undefined {
  const present = models.map(normalizeSystemModel).filter((model): model is string => model !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return normalizeSystemModel(present.map((model, index) => `# Independent map sample ${index + 1}\n\n${model}`).join("\n\n---\n\n"));
}

/** Load the persisted model for the current material; a different or missing fingerprint yields none. */
export async function loadSystemModel(historyDir: string, materialFingerprint?: string): Promise<string | undefined> {
  let stored: StoredSystemModel;
  try {
    stored = JSON.parse(await readFile(path.join(historyDir, STORE_FILE), "utf8")) as StoredSystemModel;
  } catch {
    return undefined;
  }
  if (!stored || typeof stored.text !== "string") return undefined;
  // Same fail-closed rule as the scope inventory: a model written for other
  // material is not silently reused as context for this material.
  if (materialFingerprint && stored.materialFingerprint !== materialFingerprint) return undefined;
  return normalizeSystemModel(stored.text);
}

export async function saveSystemModel(historyDir: string, text: string, materialFingerprint?: string): Promise<void> {
  const normalized = normalizeSystemModel(text);
  if (!normalized) return;
  await mkdir(historyDir, { recursive: true });
  const stored: StoredSystemModel = {
    ...(materialFingerprint ? { materialFingerprint } : {}),
    updatedAt: new Date().toISOString(),
    text: normalized,
  };
  const file = path.join(historyDir, STORE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`);
  await rename(tmp, file);
}

export function systemModelDoc(text: string): Doc {
  return { path: SYSTEM_MODEL_CORPUS_PATH, content: text, kind: "corpus" };
}

export function isSystemModelDoc(doc: Doc): boolean {
  return doc.kind === "corpus" && doc.path === SYSTEM_MODEL_CORPUS_PATH;
}

/** Bounded excerpt for a single-completion reviewer that cannot open files. */
export function clipSystemModel(text: string | undefined, maxChars: number): string {
  const normalized = normalizeSystemModel(text);
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n…(system model truncated)` : normalized;
}
