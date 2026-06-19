import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { loadSource } from "../ingest/source.js";
import { listWorkspaceFiles, normalizeRelativePath, prepareSandboxWorkspace, writeSandboxFiles, type SandboxWorkspace } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";
import { consolidateByFixEquivalence, type FixEquivEdge, type FixEquivItem } from "./consolidate.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";
import { findingContentKey } from "../util/finding-key.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type FixPatch, type ToolContext } from "./tools.js";

// `flounder confirm` — the open-world counterpart to the network-sealed `flounder run`. It does
// NOT discover: it takes a prior run's CONFIRMED findings, freezes their provenance
// (found blind, no network), then runs one network-enabled session whose job is to
// CONSOLIDATE the findings into distinct bugs, REPRODUCE each against real-world ground
// truth (fork the live target, etc.), check NOVELTY/corroboration online, and emit a
// submit/no-submit decision sheet. The framework supplies the network capability + the
// freeze + the decision contract; the model decides what "real ground truth" is for the
// target and how to reach it. Nothing here is per-technology.

export interface ConfirmRunResult {
  runDir: string;
  decisionRows: number;
}

interface ConfirmProvenance {
  inputRunDir: string;
  frozenAt: string;
  frozenFiles: Array<{ path: string; sha256: string; bytes: number }>;
}

export async function runConfirm(
  cfg: AuditorConfig,
  options: { inputRunDir: string; inputRunDirs?: string[]; confirmKeys?: string[]; maxSteps?: number; fresh?: boolean; streamEvents?: boolean; signal?: AbortSignal; onRun?: (runId: number) => void; onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number }) => void; makeTracker?: RunTrackerFactory },
): Promise<ConfirmRunResult> {
  // Confirm needs a real agent that can fork a live network and run real nodes; the
  // mock/CLI fallbacks cannot, so this mode requires a pi-session provider.
  if (!isPiSessionProvider(cfg.provider)) {
    throw new Error(
      `flounder confirm needs a pi-session provider (e.g. openai-codex) for real-world reproduction; provider "${cfg.provider}" cannot fork a live network. Set --provider openai-codex (and log pi in).`,
    );
  }
  if (cfg.sourcePaths.length === 0) throw new Error("flounder confirm needs --source (the target code to reproduce against)");
  // AGGREGATE confirm: when several run dirs are supplied (the project's distinct confirmed-finding
  // sources, located by the control plane from the findings' run_ids), union + dedup their findings
  // and freeze each. A single inputRunDir is the back-compatible case. The first dir is "primary":
  // it anchors resume + the public inputRunDir reference.
  const runDirs = (options.inputRunDirs && options.inputRunDirs.length > 0 ? options.inputRunDirs : [options.inputRunDir]).map((p) => path.resolve(p));
  const inputRunDir = runDirs[0]!;

  // Confirm runs UNBOUNDED by default: reproduction on a real target is heavy, and the
  // step count should never silently truncate productive work. A turn cap applies only
  // when the caller explicitly asks for one (--max-steps). The run otherwise ends when
  // the model emits done (the prompt pushes it to reproduce early, not survey forever).
  const confirmCfg: AuditorConfig = { ...cfg, confirmMode: true, auditMaxSteps: options.maxSteps ?? Number.POSITIVE_INFINITY };
  const startedAt = new Date();
  const logger = new RunLogger(confirmCfg.outputDir, `${confirmCfg.targetName}-confirm`, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, `${confirmCfg.targetName}-confirm`);

  // 1. Freeze + fingerprint the input run BEFORE any network access. This anchors the
  // claim that the findings were produced blind (no network), independent of anything
  // the open-world pass later reads online.
  const provenances = [];
  for (const dir of runDirs) provenances.push(await freezeInputRun(dir));
  const provenance = { ...provenances[0]!, frozenFiles: provenances.flatMap((p) => p.frozenFiles) };
  await logger.artifact("confirm_provenance.json", { ...provenance, runDirs: runDirs.map((d) => publicPath(d)) });
  await logger.event("audit_confirm_freeze", { runDirs: runDirs.map((d) => publicPath(d)), files: provenance.frozenFiles.length });

  // 2. Load every source run's confirmed findings and union them as the work list, deduped by the
  // SAME content key the DB uses (util/finding-key) so the same bug across batches counts once. When
  // confirmKeys is given (the control plane's pending/target set), keep ONLY those — that is how a
  // project-level confirm skips already-decided findings and a finding-level confirm does just one.
  // The work-list id IS the content key, so each confirm_decision's members map straight back to the
  // DB finding whose confirm_status to update.
  const wantKeys = options.confirmKeys && options.confirmKeys.length > 0 ? new Set(options.confirmKeys) : undefined;
  const seenKeys = new Set<string>();
  const priorFindings: Array<Record<string, unknown>> = [];
  for (const dir of runDirs) {
    for (const finding of await loadConfirmedFindings(dir)) {
      const key = findingContentKey(finding.scopeId, finding.location, finding.title);
      if (wantKeys && !wantKeys.has(key)) continue;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      finding.id = key;
      priorFindings.push(finding);
    }
  }
  if (priorFindings.length === 0) {
    throw new Error(`flounder confirm: no matching confirmed findings across ${runDirs.length} run dir(s) (nothing pending to confirm).`);
  }
  // SQLite tracking: record a `confirm` run under the same project (failure-isolated).
  const recorder = (options.makeTracker ?? RunRecorder.start)(confirmCfg, logger.runDir, "confirm", logger);
  if (recorder.runDbId !== undefined) options.onRun?.(recorder.runDbId);
  // RESUME (auto, unless --fresh): an interrupted prior confirm of THIS input run left a
  // decision sheet; carry its already-SETTLED rows (reproduced yes/no) forward and tell
  // the model to skip them, so a re-run continues instead of re-reproducing from scratch.
  const settled = options.fresh ? [] : await loadSettledFromPriorConfirm(confirmCfg.outputDir, confirmCfg.targetName, inputRunDir, logger.runDir);
  let seed = renderFindingsSeed(priorFindings);
  if (settled.length > 0) {
    seed += `\n\n=== ALREADY SETTLED in a prior confirm run — copy these rows into confirm_decision.json VERBATIM and do NOT reproduce them again; work ONLY on findings not settled here ===\n${JSON.stringify(settled, null, 1)}`;
    await logger.event("audit_confirm_resume", { settled: settled.length });
  }

  // 3. Workspace: copy the build root (reproducible) and the FROZEN report + per-finding
  // disclosures as corpus, so the model can read each finding's claimed exploit/fix.
  const source = await loadSource(confirmCfg.sourcePaths);
  if (source.length === 0) throw new Error("flounder confirm requires at least one readable source file (use --source)");
  const workspaceRoots = confirmCfg.buildRoot ? [confirmCfg.buildRoot] : confirmCfg.sourcePaths;
  const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "confirm/workspace");
  const frozenDocs = (await Promise.all(runDirs.map((dir) => loadFrozenReportDocs(dir)))).flat();
  const corpusManifest = await copyDocsIntoWorkspace(workspace, frozenDocs);

  const session: AgentSession = newSession();
  session.workspace = workspace;
  session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
  session.buildCacheDir = path.join(projectHistoryDir(historyLocation(confirmCfg)), "build-cache");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(confirmCfg)), "memory.jsonl"));
  const ctx: ToolContext = { cfg: confirmCfg, source, corpus: frozenDocs, memory, logger, session };
  const tools = buildTools();

  await logger.event("audit_confirm_start", {
    target: confirmCfg.targetName,
    inputRunDir: publicPath(inputRunDir),
    findings: priorFindings.length,
    provider: confirmCfg.provider,
    model: confirmCfg.auditModel,
    maxSteps: Number.isFinite(confirmCfg.auditMaxSteps) ? confirmCfg.auditMaxSteps : "unlimited",
  });

  // 4. Run the confirm session. confirmMode=true makes the bash tool use the
  // network-enabled policy (fork/read live networks, fetch, search — never broadcast).
  const result = await runAuditSession({
    cfg: confirmCfg,
    ctx,
    tools,
    logger,
    cwd: workspace.absolute,
    fileManifest: renderFileManifest(source, corpusManifest),
    confirm: seed,
    // Project the decision rows to SQLite each turn so a UI shows live reproduction
    // progress (reproduced X / N) during the run, not only at the end.
    onConfirmCheckpoint: (raw) => recorder.confirmDecisions(toLiveConfirmRows(raw)),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });

  // 5. Read the model's decision rows, then CONSOLIDATE by execution: run the
  // fix-equivalence matrix (apply one row's fix to pristine source, re-run another's
  // PoC) and merge rows a single fix neutralizes. This is the framework's call, not the
  // model's — "distinct bugs" is decided by execution, not by the model's grouping alone.
  let rows = readConfirmDecision(session);
  // Resume safety net: guarantee every prior-settled row survives even if the model
  // dropped it from confirm_decision.json (it was told to carry them verbatim).
  if (settled.length > 0) {
    const present = new Set(rows.map((row) => row.bug.trim().toLowerCase()));
    for (const row of settled) if (!present.has(row.bug.trim().toLowerCase())) rows.push(row);
  }
  let equivalence: { clusters: string[][]; edges: FixEquivEdge[]; skipped?: boolean } = { clusters: rows.map((_, idx) => [String(idx)]), edges: [] };
  if (rows.length > 1 && session.workspace && session.baselineFiles) {
    const items: FixEquivItem[] = rows.map((row, idx) => {
      const run = row.reproCommandId ? session.commandRuns.find((record) => record.id === row.reproCommandId) : undefined;
      return {
        id: String(idx),
        ...(row.fixPatch ? { fixPatch: row.fixPatch } : {}),
        ...(run ? { exploitRun: run } : {}),
        ...(row.patchedSuccessPatterns ? { patchedSuccessPatterns: row.patchedSuccessPatterns } : {}),
      };
    });
    equivalence = await consolidateByFixEquivalence({
      items,
      workspace: session.workspace,
      baselineFiles: session.baselineFiles,
      cfg: confirmCfg,
      logger,
      ...(session.buildCacheDir ? { cacheDir: session.buildCacheDir } : {}),
    });
    rows = mergeRowsByClusters(rows, equivalence.clusters);
  }
  await logger.artifact("confirm_equivalence.json", equivalence);
  await logger.artifact("confirm_decision.json", rows);
  await logger.artifact("confirm_transcript.json", { stoppedReason: result.stoppedReason, steps: result.steps });
  await logger.artifact(
    "confirm_report.md",
    renderConfirmReport({ target: confirmCfg.targetName, provider: confirmCfg.provider, model: confirmCfg.auditModel, inputRunDir, provenance, priorFindings: priorFindings.length, rows }),
  );
  await logger.event("audit_confirm_done", {
    stoppedReason: result.stoppedReason,
    steps: result.steps.length,
    rows: rows.length,
    reproducedYes: rows.filter((row) => row.reproduced === "yes").length,
    submitCandidates: rows.filter((row) => row.recommendation === "submit-candidate").length,
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, `${confirmCfg.targetName}-confirm`);

  // SQLite tracking: the decision sheet (one row per distinct bug) + mark the run done.
  recorder.confirmDecisions(
    rows.map((row) => ({ bug: row.bug, reproduced: row.reproduced, recommendation: row.recommendation, members: row.members })),
    path.join(logger.runDir, "confirm_report.md"),
  );
  recorder.finish(options.signal?.aborted ? "killed" : "done");

  return { runDir: logger.runDir, decisionRows: rows.length };
}

// --- freeze / provenance -----------------------------------------------------

const FROZEN_FILE = /^(audit_report\.md|audit_findings\.json|report_f\d+\.md)$/;

async function freezeInputRun(runDir: string): Promise<ConfirmProvenance> {
  let names: string[] = [];
  try {
    names = await readdir(runDir);
  } catch (error) {
    throw new Error(`flounder confirm: cannot read run dir ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const frozenFiles: ConfirmProvenance["frozenFiles"] = [];
  for (const name of names.filter((n) => FROZEN_FILE.test(n)).sort()) {
    try {
      const buf = await readFile(path.join(runDir, name));
      frozenFiles.push({ path: name, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
    } catch {
      // skip unreadable
    }
  }
  return { inputRunDir: publicPath(runDir), frozenAt: new Date().toISOString(), frozenFiles };
}

// --- loading the prior run ---------------------------------------------------

async function loadConfirmedFindings(runDir: string): Promise<Array<Record<string, unknown>>> {
  const file = path.join(runDir, "audit_findings.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`flounder confirm: cannot read or parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).findings)
      ? ((raw as Record<string, unknown>).findings as unknown[])
      : [];
  return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function renderFindingsSeed(findings: Array<Record<string, unknown>>): string {
  const str = (value: unknown): string => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));
  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
  return findings
    .map((finding, idx) => {
      const id = str(finding.id) || `f${idx + 1}`;
      const lines = [
        `[${id}] (${str(finding.severity) || "?"} | ${str(finding.confirmationStatus) || "?"}) ${str(finding.title)}`,
        `   location: ${str(finding.location)}`,
      ];
      const desc = str(finding.description);
      if (desc) lines.push(`   claim: ${clip(desc, 600)}`);
      const sketch = str(finding.exploitSketch) || str(finding.exploit_sketch);
      if (sketch) lines.push(`   claimed exploit: ${clip(sketch, 500)}`);
      const fix = str(finding.fix);
      if (fix) lines.push(`   claimed fix: ${clip(fix, 300)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

async function loadFrozenReportDocs(runDir: string): Promise<Doc[]> {
  let names: string[] = [];
  try {
    names = await readdir(runDir);
  } catch {
    return [];
  }
  const wanted = names.filter((n) => FROZEN_FILE.test(n)).sort();
  const docs: Doc[] = [];
  for (const name of wanted) {
    try {
      const content = await readFile(path.join(runDir, name), "utf8");
      docs.push({ path: `prior-run/${name}`, content, kind: "corpus" });
    } catch {
      // skip
    }
  }
  return docs;
}

async function copyDocsIntoWorkspace(workspace: SandboxWorkspace, docs: Doc[]): Promise<string[]> {
  if (docs.length === 0) return [];
  const seen = new Set<string>();
  const files = docs.map((doc, index) => {
    const safe = normalizeRelativePath(doc.path) ?? `doc-${index}`;
    let rel = `corpus/${safe}`;
    while (seen.has(rel)) rel = `corpus/${index}-${safe}`;
    seen.add(rel);
    return { path: rel, content: doc.content };
  });
  await writeSandboxFiles(workspace.absolute, files);
  return files.map((file) => file.path);
}

function renderFileManifest(source: Doc[], corpusEntries: string[]): string {
  const lines = source.slice(0, 600).map((doc) => `- ${doc.path} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const more = source.length > 600 ? `\n…and ${source.length - 600} more files` : "";
  let out = `${lines.join("\n")}${more}`;
  if (corpusEntries.length > 0) {
    out += `\n\nFrozen prior-run report + per-finding disclosures under corpus/:\n${corpusEntries.map((entry) => `- ${entry}`).join("\n")}`;
  }
  return out;
}

// Map the model's raw, mid-run decision rows to the minimal shape the tracker stores, for
// LIVE reproduction progress. The end-of-run write replaces these with the consolidated set.
function toLiveConfirmRows(raw: unknown[]): Array<{ bug: string; reproduced?: string; recommendation?: string; members?: string[] }> {
  const rows: Array<{ bug: string; reproduced?: string; recommendation?: string; members?: string[] }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.bug !== "string" || !obj.bug.trim()) continue;
    const row: { bug: string; reproduced?: string; recommendation?: string; members?: string[] } = { bug: obj.bug };
    if (typeof obj.reproduced === "string") row.reproduced = obj.reproduced;
    if (typeof obj.recommendation === "string") row.recommendation = obj.recommendation;
    if (Array.isArray(obj.members)) row.members = obj.members.filter((m): m is string => typeof m === "string");
    rows.push(row);
  }
  return rows;
}

// --- decision sheet ----------------------------------------------------------

export interface ConfirmDecisionRow {
  bug: string;
  members: string[];
  distinctFix: string;
  reproduced: "yes" | "no" | "could-not-set-up" | "unknown";
  reproEvidence: string;
  corroboration: string;
  novelty: string;
  humanGates: string;
  recommendation: "submit-candidate" | "needs-human" | "drop" | "unknown";
  // Structured fields the fix-equivalence matrix needs (present when the row's PoC is a
  // source-level test with a declared fix). Not rendered; consumed by consolidation.
  reproCommandId?: string;
  fixPatch?: FixPatch;
  patchedSuccessPatterns?: string[];
  // Set by the framework when this row is the merge of several rows a single fix neutralized.
  mergedFrom?: string[];
}

function readConfirmDecision(session: AgentSession): ConfirmDecisionRow[] {
  let entry = session.scratchFiles.get("confirm_decision.json");
  if (entry === undefined) {
    for (const [key, value] of session.scratchFiles) {
      if (key.endsWith("/confirm_decision.json")) {
        entry = value;
        break;
      }
    }
  }
  if (entry === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(entry);
  } catch {
    return [];
  }
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).decisions)
      ? ((raw as Record<string, unknown>).decisions as unknown[])
      : [];
  return items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map(normalizeDecisionRow);
}

function normalizeDecisionRow(raw: Record<string, unknown>): ConfirmDecisionRow {
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : JSON.stringify(value));
  const members = Array.isArray(raw.members) ? raw.members.map((m) => str(m)).filter(Boolean) : str(raw.members) ? [str(raw.members)] : [];
  const reproduced = ((value: string): ConfirmDecisionRow["reproduced"] => (value === "yes" || value === "no" || value === "could-not-set-up" ? value : "unknown"))(str(raw.reproduced).toLowerCase());
  const recommendation = ((value: string): ConfirmDecisionRow["recommendation"] =>
    value === "submit-candidate" || value === "needs-human" || value === "drop" ? value : "unknown")(str(raw.recommendation).toLowerCase());
  const reproCommandId = str(raw.repro_command_id) || str(raw.reproCommandId);
  const fixPatch = parseFixPatch(raw.fix_patch ?? raw.fixPatch);
  const patched = asStringList(raw.patched_success_patterns ?? raw.patchedSuccessPatterns);
  return {
    bug: str(raw.bug) || str(raw.title) || "(unnamed)",
    members,
    distinctFix: str(raw.distinct_fix) || str(raw.distinctFix),
    reproduced,
    reproEvidence: str(raw.repro_evidence) || str(raw.reproEvidence),
    corroboration: str(raw.corroboration),
    novelty: str(raw.novelty),
    humanGates: str(raw.human_gates) || str(raw.humanGates),
    recommendation,
    ...(reproCommandId ? { reproCommandId } : {}),
    ...(fixPatch ? { fixPatch } : {}),
    ...(patched.length > 0 ? { patchedSuccessPatterns: patched } : {}),
  };
}

function parseFixPatch(value: unknown): FixPatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const filePath = typeof raw.path === "string" ? raw.path.trim() : "";
  const oldText = typeof raw.old === "string" ? raw.old : undefined;
  const newText = typeof raw.new === "string" ? raw.new : undefined;
  if (!filePath || oldText === undefined || oldText.length === 0 || newText === undefined) return undefined;
  return { path: filePath, old: oldText, new: newText };
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean).slice(0, 16);
}

// Find the latest prior confirm run of THIS input run (same output dir + target, matched
// by frozen provenance) and return its SETTLED decision rows (reproduced yes/no) — the
// resume basis. Skips the current run dir; falls through to an older run if the latest has
// no decision sheet yet (killed before its first checkpoint).
export async function loadSettledFromPriorConfirm(outputDir: string, targetName: string, inputRunDir: string, currentRunDir: string): Promise<ConfirmDecisionRow[]> {
  const prefix = `${targetName}-confirm-`;
  const currentBase = path.basename(currentRunDir);
  const wantInput = publicPath(inputRunDir);
  let names: string[] = [];
  try {
    names = await readdir(outputDir);
  } catch {
    return [];
  }
  const candidates = names.filter((name) => name.startsWith(prefix) && name !== currentBase).sort().reverse();
  for (const name of candidates) {
    const dir = path.join(outputDir, name);
    try {
      const prov = JSON.parse(await readFile(path.join(dir, "confirm_provenance.json"), "utf8")) as { inputRunDir?: unknown };
      if (prov?.inputRunDir !== wantInput) continue;
      const raw: unknown = JSON.parse(await readFile(path.join(dir, "confirm_decision.json"), "utf8"));
      const items = Array.isArray(raw) ? raw : [];
      const rows = items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map(normalizeDecisionRow);
      return rows.filter((row) => row.reproduced === "yes" || row.reproduced === "no");
    } catch {
      // unreadable provenance/decision (e.g. killed before first checkpoint) — try the next-older run
    }
  }
  return [];
}

// Collapse the model's rows per the fix-equivalence clusters: each cluster of row ids
// (indices) becomes one row. Singletons pass through unchanged; multi-row clusters merge.
function mergeRowsByClusters(rows: ConfirmDecisionRow[], clusters: string[][]): ConfirmDecisionRow[] {
  const out: ConfirmDecisionRow[] = [];
  for (const cluster of clusters) {
    const members = cluster.map((id) => rows[Number(id)]).filter((row): row is ConfirmDecisionRow => Boolean(row));
    if (members.length === 0) continue;
    out.push(members.length === 1 ? (members[0] as ConfirmDecisionRow) : mergeRows(members));
  }
  return out;
}

function mergeRows(members: ConfirmDecisionRow[]): ConfirmDecisionRow {
  const uniq = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
  const reproRank: Record<ConfirmDecisionRow["reproduced"], number> = { yes: 3, "could-not-set-up": 2, no: 1, unknown: 0 };
  const recRank: Record<ConfirmDecisionRow["recommendation"], number> = { "submit-candidate": 3, "needs-human": 2, drop: 1, unknown: 0 };
  const strongest = <T extends string>(values: T[], rank: Record<T, number>, fallback: T): T => values.reduce((best, value) => (rank[value] > rank[best] ? value : best), fallback);
  return {
    bug: members.map((m) => m.bug).join(" / "),
    members: uniq(members.flatMap((m) => [...m.members, m.bug])),
    distinctFix: members.map((m) => m.distinctFix).find(Boolean) ?? "",
    reproduced: strongest(members.map((m) => m.reproduced), reproRank, "unknown"),
    reproEvidence: uniq(members.map((m) => m.reproEvidence)).join(" | "),
    corroboration: uniq(members.map((m) => m.corroboration)).join(" | "),
    novelty: uniq(members.map((m) => m.novelty)).join(" | "),
    humanGates: uniq(members.map((m) => m.humanGates)).join(" | "),
    recommendation: strongest(members.map((m) => m.recommendation), recRank, "unknown"),
    mergedFrom: members.map((m) => m.bug),
  };
}

function renderConfirmReport(input: {
  target: string;
  provider: string;
  model: string;
  inputRunDir: string;
  provenance: ConfirmProvenance;
  priorFindings: number;
  rows: ConfirmDecisionRow[];
}): string {
  const out: string[] = [];
  out.push(`# Confirm results: ${input.target}`, "");
  out.push(`- Provider / model: ${input.provider} / ${input.model}`);
  out.push(`- Input run (frozen): ${input.inputRunDir}`);
  out.push(`- Prior confirmed findings: ${input.priorFindings} → distinct bugs after consolidation: ${input.rows.length}`);
  const repro = input.rows.filter((row) => row.reproduced === "yes").length;
  const candidates = input.rows.filter((row) => row.recommendation === "submit-candidate").length;
  out.push(`- Reproduced on real target: ${repro} / ${input.rows.length}; submit candidates: ${candidates}`);
  out.push("");
  out.push("## Provenance (frozen before any network access)", "");
  if (input.provenance.frozenFiles.length === 0) {
    out.push("_No report artifacts were found to fingerprint in the input run._", "");
  } else {
    out.push(`Fingerprinted at ${input.provenance.frozenAt}:`, "");
    for (const file of input.provenance.frozenFiles) out.push(`- \`${file.path}\` — sha256 \`${file.sha256}\` (${file.bytes} bytes)`);
    out.push("");
  }
  out.push("## Decision sheet", "");
  if (input.rows.length === 0) {
    out.push("_The confirm session produced no decision rows (confirm_decision.json missing or empty)._", "");
    return out.join("\n");
  }
  for (const [idx, row] of input.rows.entries()) {
    const badge = row.reproduced === "yes" ? "✅ reproduced" : row.reproduced === "no" ? "❌ not reproduced" : row.reproduced === "could-not-set-up" ? "⚠ could not set up" : "? unknown";
    out.push(`### ${idx + 1}. ${row.bug} — ${badge} — recommendation: ${row.recommendation}`);
    if (row.mergedFrom && row.mergedFrom.length > 1) out.push(`- Consolidated by fix-equivalence (a single fix neutralized all of these): ${row.mergedFrom.join(" / ")}`);
    if (row.members.length > 0) out.push(`- Merged prior findings: ${row.members.join(", ")}`);
    if (row.distinctFix) out.push(`- Distinct fix: ${row.distinctFix}`);
    if (row.reproEvidence) out.push(`- Reproduction: ${row.reproEvidence}`);
    if (row.corroboration) out.push(`- Corroboration (web — a lead, not proof): ${row.corroboration}`);
    if (row.novelty) out.push(`- Novelty: ${row.novelty}`);
    if (row.humanGates) out.push(`- Human gates (not settled by execution): ${row.humanGates}`);
    out.push("");
  }
  return out.join("\n");
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}
