import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AuditorConfig } from "../config.js";
import { listWorkspaceFiles, normalizeRelativePath, prepareSandboxWorkspace, writeSandboxFiles, type SandboxWorkspace } from "../security/sandbox.js";
import { projectHistoryDir } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";
import { enforceSubmissionReadiness, isResumeSettledDecision } from "../util/submission-readiness.js";
import { consolidateByFixEquivalence, type FixEquivEdge, type FixEquivItem } from "./consolidate.js";
import { RunRecorder, type RunTrackerFactory } from "../db/record.js";
import { findingContentKey } from "../util/finding-key.js";
import { matchConfirmSelector, parseConfirmSelectors } from "../util/confirm-selector.js";
import { ProjectMemory } from "./memory.js";
import { isPiSessionProvider, runAuditSession } from "./pi-session.js";
import { buildTools, newSession, type AgentSession, type CommandRunRecord, type FixPatch, type ToolContext } from "./tools.js";

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

type ConfirmStructuredValue = Record<string, unknown> | unknown[];

export const IMPACT_INVENTORY_FILE = "impact_inventory.json";

export async function runConfirm(
  cfg: AuditorConfig,
  options: { inputRunDir: string; inputRunDirs?: string[]; confirmKeys?: string[]; inlineFindings?: Array<Record<string, unknown>>; settledDecisions?: ConfirmDecisionRow[]; engagement?: Record<string, unknown>; maxSteps?: number; fresh?: boolean; streamEvents?: boolean; signal?: AbortSignal; onRun?: (runId: number) => void; onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number }) => void; makeTracker?: RunTrackerFactory },
): Promise<ConfirmRunResult> {
  // Confirm needs a real agent that can fork a live network and run real nodes; the
  // mock/CLI fallbacks cannot, so this mode requires a pi-session provider.
  if (!isPiSessionProvider(cfg.provider)) {
    throw new Error(
      `flounder confirm needs a session provider (e.g. openai-codex) for real-world reproduction; provider "${cfg.provider}" cannot fork a live network. Set --provider openai-codex and run \`flounder daemon provider login openai-codex\` on the daemon machine first.`,
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
  const inlineFindings = (options.inlineFindings ?? []).filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (inlineFindings.length > 0) await logger.artifact(INLINE_FINDINGS_FILE, inlineFindings);

  // 1. Freeze + fingerprint the input run BEFORE any network access. This anchors the
  // claim that the findings were produced blind (no network), independent of anything
  // the open-world pass later reads online.
  const provenances = [];
  const skippedRunDirs: Array<{ inputRunDir: string; error: string }> = [];
  for (const dir of runDirs) {
    try {
      provenances.push(await freezeInputRun(dir));
    } catch (error) {
      if (inlineFindings.length === 0) throw error;
      skippedRunDirs.push({ inputRunDir: publicPath(dir), error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (inlineFindings.length > 0) provenances.push(freezeInlineFindings(inlineFindings));
  const provenance = provenances.length > 0
    ? { ...provenances[0]!, frozenFiles: provenances.flatMap((p) => p.frozenFiles) }
    : { inputRunDir: publicPath(inputRunDir), frozenAt: new Date().toISOString(), frozenFiles: [] };
  await logger.artifact("confirm_provenance.json", { ...provenance, runDirs: runDirs.map((d) => publicPath(d)), ...(skippedRunDirs.length > 0 ? { skippedRunDirs } : {}) });
  await logger.event("audit_confirm_freeze", { runDirs: runDirs.map((d) => publicPath(d)), files: provenance.frozenFiles.length });

  // 2. Load every source run's confirmed findings and union them as the work list, deduped by the
  // SAME content key the DB uses (util/finding-key) so the same bug across batches counts once. When
  // confirmKeys is given, keep ONLY those. Project-level confirm passes the full current
  // confirmed-finding context so consolidation can see previously decided rows; finding-level
  // confirm can still pass a narrow target set.
  // The seed id is the DB finding key selected by the control plane. For verify-origin updates, the
  // artifact may have a newer content key, so origin selectors map it back to the DB row that needs
  // confirm_status updated.
  const selectors = parseConfirmSelectors(options.confirmKeys);
  const seenKeys = new Set<string>();
  const priorFindings: Array<Record<string, unknown>> = [];
  const addPriorFinding = (finding: Record<string, unknown>) => {
    const key = findingContentKey(finding.scopeId, finding.location, finding.title);
    const selectedKey = matchConfirmSelector(selectors, key, finding.originId);
    if (!selectedKey) return;
    if (seenKeys.has(selectedKey)) return;
    seenKeys.add(selectedKey);
    finding.id = selectedKey;
    priorFindings.push(finding);
  };
  for (const dir of runDirs) {
    try {
      for (const finding of await loadConfirmedFindings(dir)) addPriorFinding(finding);
    } catch (error) {
      if (inlineFindings.length === 0) throw error;
    }
  }
  for (const finding of inlineFindings) addPriorFinding(finding);
  if (priorFindings.length === 0) {
    throw new Error(`flounder confirm: no matching confirmed findings across ${runDirs.length} run dir(s) (nothing pending to confirm).`);
  }
  // SQLite tracking: record a `confirm` run under the same project (failure-isolated).
  const recorder = (options.makeTracker ?? RunRecorder.start)(confirmCfg, logger.runDir, "confirm", logger);
  if (confirmCfg.materialFingerprint) recorder.materialFingerprint?.(confirmCfg.materialFingerprint);
  if (recorder.runDbId !== undefined) options.onRun?.(recorder.runDbId);
  const confirmProgress = {
    commandRuns: 0,
    confirmRuns: 0,
    passed: 0,
    failed: 0,
    rows: 0,
    reproducedYes: 0,
    submitCandidates: 0,
    needsHuman: 0,
  };
  const recordConfirmStage = (extra: Record<string, unknown> = {}) => {
    recorder.stage("confirm", {
      status: "running",
      findings: priorFindings.length,
      startedAt: startedAt.toISOString(),
      ...confirmProgress,
      at: new Date().toISOString(),
      ...extra,
    });
  };
  const recordCommandProgress = (record: CommandRunRecord) => {
    confirmProgress.commandRuns += 1;
    if (record.purpose === "confirm") {
      confirmProgress.confirmRuns += 1;
      if (record.passed) confirmProgress.passed += 1;
      else confirmProgress.failed += 1;
    }
    recordConfirmStage();
  };
  recordConfirmStage();
  // RESUME (auto, unless --fresh): an interrupted prior confirm of THIS input run left a
  // decision sheet; carry only rows that are actually final for the pipeline, so a re-run
  // continues instead of re-reproducing settled work while still retrying open submit gates.
  const settled = options.fresh ? [] : mergeSettledRows([...(options.settledDecisions ?? []), ...await loadSettledFromPriorConfirm(confirmCfg.outputDir, confirmCfg.targetName, inputRunDir, logger.runDir, runDirs)]);
  let seed = renderFindingsSeed(priorFindings);
  if (settled.length > 0) {
    seed += `\n\n=== ALREADY SETTLED in prior confirm run(s) — carry these rows into confirm_decision.json and do NOT reproduce their existing member ids again. Work on findings not settled here. If an unsettled finding is the same distinct bug as a settled row, add that finding id to that row's members and reuse the prior reproduction evidence; otherwise leave settled rows unchanged. ===\n${JSON.stringify(settled, null, 1)}`;
    await logger.event("audit_confirm_resume", { settled: settled.length });
  }

  // 3. Workspace: copy the build root (reproducible) and the FROZEN report + per-finding
  // disclosures as corpus, so the model can read each finding's claimed exploit/fix.
  const workspaceRoots = confirmCfg.buildRoot ? [confirmCfg.buildRoot] : confirmCfg.sourcePaths;
  const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "confirm/workspace");
  const baselineFiles = await listWorkspaceFiles(workspace.absolute);
  if (baselineFiles.size === 0) throw new Error("flounder confirm requires at least one readable source file (use --source)");
  const frozenDocs = (await Promise.all(runDirs.map((dir) => loadFrozenReportDocs(dir)))).flat();
  const corpusManifest = await copyDocsIntoWorkspace(workspace, frozenDocs);

  const session: AgentSession = newSession();
  session.workspace = workspace;
  session.baselineFiles = baselineFiles;
  session.buildCacheDir = path.join(projectHistoryDir(historyLocation(confirmCfg)), "build-cache");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(confirmCfg)), "memory.jsonl"));
  const ctx: ToolContext = { cfg: confirmCfg, source: [], corpus: frozenDocs, memory, logger, session, onCommandRun: recordCommandProgress };
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
    fileManifest: renderConfirmFileManifest(baselineFiles, corpusManifest),
    confirm: seed,
    ...(options.engagement ? { engagement: options.engagement } : {}),
    // Project the decision rows to SQLite each turn so a UI shows live reproduction
    // progress (reproduced X / N) during the run, not only at the end.
    onConfirmCheckpoint: (raw) => {
      const liveRows = enforceBountySubmitReadiness(toLiveConfirmRows(raw), { impactInventory: readImpactInventory(session) });
      recorder.confirmDecisions(liveRows);
      confirmProgress.rows = liveRows.length;
      confirmProgress.reproducedYes = liveRows.filter((row) => row.reproduced === "yes").length;
      confirmProgress.submitCandidates = liveRows.filter((row) => row.recommendation === "submit-candidate").length;
      confirmProgress.needsHuman = liveRows.filter((row) => row.recommendation === "needs-human").length;
      recordConfirmStage();
      void logger.event("audit_confirm_checkpoint", {
        rows: confirmProgress.rows,
        reproducedYes: confirmProgress.reproducedYes,
        submitCandidates: confirmProgress.submitCandidates,
        needsHuman: confirmProgress.needsHuman,
      });
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
  });

  // 5. Read the model's decision rows, then CONSOLIDATE by execution: run the
  // fix-equivalence matrix (apply one row's fix to pristine source, re-run another's
  // PoC) and merge rows a single fix neutralizes. This is the framework's call, not the
  // model's — "distinct bugs" is decided by execution, not by the model's grouping alone.
  let rows = readConfirmDecision(session);
  const impactInventory = readImpactInventory(session);
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
  rows = enforceBountySubmitReadiness(rows, { impactInventory });
  await logger.artifact("confirm_equivalence.json", equivalence);
  await logger.artifact("confirm_decision.json", rows);
  if (impactInventory) await logger.artifact(IMPACT_INVENTORY_FILE, impactInventory);
  await logger.artifact("confirm_transcript.json", { stoppedReason: result.stoppedReason, steps: result.steps });
  await logger.artifact(
    "confirm_report.md",
    renderConfirmReport({
      target: confirmCfg.targetName,
      provider: confirmCfg.provider,
      model: confirmCfg.auditModel,
      inputRunDir,
      provenance,
      priorFindings: priorFindings.length,
      rows,
      ...(impactInventory ? { impactInventory } : {}),
    }),
  );
  await logger.event("audit_confirm_done", {
    stoppedReason: result.stoppedReason,
    steps: result.steps.length,
    rows: rows.length,
    reproducedYes: rows.filter((row) => row.reproduced === "yes").length,
    submitCandidates: rows.filter((row) => row.recommendation === "submit-candidate").length,
  });
  recorder.stage("confirm", {
    status: "done",
    findings: priorFindings.length,
    startedAt: startedAt.toISOString(),
    commandRuns: confirmProgress.commandRuns,
    confirmRuns: confirmProgress.confirmRuns,
    passed: confirmProgress.passed,
    failed: confirmProgress.failed,
    rows: rows.length,
    reproducedYes: rows.filter((row) => row.reproduced === "yes").length,
    submitCandidates: rows.filter((row) => row.recommendation === "submit-candidate").length,
    needsHuman: rows.filter((row) => row.recommendation === "needs-human").length,
    at: new Date().toISOString(),
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, `${confirmCfg.targetName}-confirm`);

  // SQLite tracking: the decision sheet (one row per distinct bug) + mark the run done.
  recorder.confirmDecisions(
    rows.map((row) => ({
      bug: row.bug,
      reproduced: row.reproduced,
      recommendation: row.recommendation,
      members: row.members,
      distinctFix: row.distinctFix,
      reproEvidence: row.reproEvidence,
      corroboration: row.corroboration,
      novelty: row.novelty,
      humanGates: row.humanGates,
      engagementProfile: row.engagementProfile,
      adjudication: row.adjudication,
      evidenceLevel: row.evidenceLevel,
      submissionConfidence: row.submissionConfidence,
      mergedFrom: row.mergedFrom,
      reproCommandId: row.reproCommandId,
    })),
    path.join(logger.runDir, "confirm_report.md"),
  );
  recorder.finish(options.signal?.aborted ? "killed" : "done");

  return { runDir: logger.runDir, decisionRows: rows.length };
}

// --- freeze / provenance -----------------------------------------------------

const FROZEN_FILE = /^(audit_report\.md|audit_findings\.json|report_[a-z0-9_.-]+\.md)$/;
const INLINE_FINDINGS_FILE = "control_plane_confirm_findings.json";

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

function freezeInlineFindings(findings: Array<Record<string, unknown>>): ConfirmProvenance {
  const body = JSON.stringify(findings, null, 2);
  return {
    inputRunDir: "control-plane-db",
    frozenAt: new Date().toISOString(),
    frozenFiles: [{
      path: INLINE_FINDINGS_FILE,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
    }],
  };
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

function renderConfirmFileManifest(sourceFiles: Set<string>, corpusEntries: string[]): string {
  const source = [...sourceFiles].sort();
  const lines = source.slice(0, 600).map((filePath) => `- ${filePath}`);
  const more = source.length > 600 ? `\n…and ${source.length - 600} more files` : "";
  let out = `${lines.join("\n")}${more}`;
  if (corpusEntries.length > 0) {
    out += `\n\nFrozen prior-run report + per-finding disclosures under corpus/:\n${corpusEntries.map((entry) => `- ${entry}`).join("\n")}`;
  }
  return out;
}

// Map the model's raw, mid-run decision rows to the minimal shape the tracker stores, for
// LIVE reproduction progress. The end-of-run write replaces these with the consolidated set.
function toLiveConfirmRows(raw: unknown[]): Array<{
  bug: string;
  reproduced?: string;
  recommendation?: string;
  members?: string[];
  distinctFix?: string;
  reproEvidence?: string;
  corroboration?: string;
  novelty?: string;
  humanGates?: string;
  engagementProfile?: unknown;
  adjudication?: unknown;
  evidenceLevel?: string;
  submissionConfidence?: string;
  reproCommandId?: string;
}> {
  const rows: Array<{
    bug: string;
    reproduced?: string;
    recommendation?: string;
    members?: string[];
    distinctFix?: string;
    reproEvidence?: string;
    corroboration?: string;
    novelty?: string;
    humanGates?: string;
    engagementProfile?: unknown;
    adjudication?: unknown;
    evidenceLevel?: string;
    submissionConfidence?: string;
    reproCommandId?: string;
  }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.bug !== "string" || !obj.bug.trim()) continue;
    const row: {
      bug: string;
      reproduced?: string;
      recommendation?: string;
      members?: string[];
      distinctFix?: string;
      reproEvidence?: string;
      corroboration?: string;
      novelty?: string;
      humanGates?: string;
      engagementProfile?: unknown;
      adjudication?: unknown;
      evidenceLevel?: string;
      submissionConfidence?: string;
      reproCommandId?: string;
    } = { bug: obj.bug };
    if (typeof obj.reproduced === "string") row.reproduced = obj.reproduced;
    if (typeof obj.recommendation === "string") row.recommendation = obj.recommendation;
    if (Array.isArray(obj.members)) row.members = obj.members.filter((m): m is string => typeof m === "string");
    if (typeof obj.distinct_fix === "string") row.distinctFix = obj.distinct_fix;
    else if (typeof obj.distinctFix === "string") row.distinctFix = obj.distinctFix;
    if (typeof obj.repro_evidence === "string") row.reproEvidence = obj.repro_evidence;
    else if (typeof obj.reproEvidence === "string") row.reproEvidence = obj.reproEvidence;
    if (typeof obj.corroboration === "string") row.corroboration = obj.corroboration;
    if (typeof obj.novelty === "string") row.novelty = obj.novelty;
    if (typeof obj.human_gates === "string") row.humanGates = obj.human_gates;
    else if (typeof obj.humanGates === "string") row.humanGates = obj.humanGates;
    const engagementProfile = normalizeStructuredValue(obj.engagement_profile ?? obj.engagementProfile);
    if (engagementProfile) row.engagementProfile = engagementProfile;
    const adjudication = normalizeStructuredValue(obj.adjudication);
    if (adjudication) row.adjudication = adjudication;
    if (typeof obj.evidence_level === "string") row.evidenceLevel = obj.evidence_level;
    else if (typeof obj.evidenceLevel === "string") row.evidenceLevel = obj.evidenceLevel;
    if (typeof obj.submission_confidence === "string") row.submissionConfidence = obj.submission_confidence;
    else if (typeof obj.submissionConfidence === "string") row.submissionConfidence = obj.submissionConfidence;
    if (typeof obj.repro_command_id === "string") row.reproCommandId = obj.repro_command_id;
    else if (typeof obj.reproCommandId === "string") row.reproCommandId = obj.reproCommandId;
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
  engagementProfile?: unknown;
  adjudication?: unknown;
  evidenceLevel?: string;
  submissionConfidence?: string;
  recommendation: "submit-candidate" | "needs-human" | "drop" | "unknown";
  // Structured fields the fix-equivalence matrix needs (present when the row's PoC is a
  // source-level test with a declared fix). Not rendered; consumed by consolidation.
  reproCommandId?: string;
  fixPatch?: FixPatch;
  patchedSuccessPatterns?: string[];
  // Set by the framework when this row is the merge of several rows a single fix neutralized.
  mergedFrom?: string[];
}

function mergeSettledRows(rows: ConfirmDecisionRow[]): ConfirmDecisionRow[] {
  const out: ConfirmDecisionRow[] = [];
  const covered = new Set<string>();
  const memberKeys = (row: ConfirmDecisionRow): string[] => {
    const keys = row.members.map((member) => member.trim().toLowerCase()).filter(Boolean);
    return keys.length > 0 ? keys : [row.bug.trim().toLowerCase()].filter(Boolean);
  };
  for (const row of rows.filter((entry) => isResumeSettledDecision(entry))) {
    const keys = memberKeys(row);
    if (keys.length > 0 && keys.every((key) => covered.has(key))) continue;
    out.push(row);
    for (const key of keys) covered.add(key);
  }
  return out;
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

function readImpactInventory(session: AgentSession): ConfirmStructuredValue | undefined {
  let entry = session.scratchFiles.get(IMPACT_INVENTORY_FILE);
  if (entry === undefined) {
    for (const [key, value] of session.scratchFiles) {
      if (key.endsWith(`/${IMPACT_INVENTORY_FILE}`)) {
        entry = value;
        break;
      }
    }
  }
  return entry === undefined ? undefined : normalizeStructuredValue(entry);
}

type ConfirmDecisionLike = {
  bug: string;
  members?: string[];
  reproduced?: string;
  recommendation?: string;
  humanGates?: string;
  engagementProfile?: unknown;
  adjudication?: unknown;
};

export function enforceBountySubmitReadiness<T extends ConfirmDecisionLike>(rows: T[], options: { impactInventory?: unknown } = {}): T[] {
  return enforceSubmissionReadiness(rows, { impactInventory: options.impactInventory, requireImpactInventory: true });
}

function bountySubmitBlocker(row: ConfirmDecisionLike, impactInventory: unknown): string | undefined {
  if (!isBountyLikePolicy(row.engagementProfile, row.adjudication)) return undefined;
  if (row.reproduced !== "yes") return "the row is not reproduced on the real target";
  if (!impactInventoryCoversRow(row, impactInventory)) return `${IMPACT_INVENTORY_FILE} has no entry covering this reproduced bounty-like row`;
  for (const gate of ["scope", "live_impact", "known_issue", "payout"] as const) {
    const status = bountyGateStatus(row.adjudication, gate);
    if (!isPassingBountyGateStatus(status, gate)) return `${gate} gate is ${status ? JSON.stringify(status) : "missing"}`;
  }
  return undefined;
}

function isBountyLikePolicy(engagementProfile: unknown, adjudication: unknown): boolean {
  const profile = asRecord(engagementProfile);
  const adjudicationRecord = asRecord(adjudication);
  const policyKind = normalizedWord(stringValue(profile?.policy_kind ?? profile?.policyKind ?? profile?.kind));
  if (policyKind.includes("bug_bounty") || policyKind.includes("bounty") || policyKind.includes("contest")) return true;
  const requiredRaw = profile?.required_gates ?? profile?.requiredGates;
  const requiredGates = Array.isArray(requiredRaw) ? requiredRaw.map((entry) => normalizedWord(stringValue(entry))) : [];
  const adjudicationHasPayout = Boolean(adjudicationRecord && ("payout_estimate" in adjudicationRecord || "payoutEstimate" in adjudicationRecord));
  if (policyKind === "custom" && (requiredGates.some((gate) => gate.includes("payout") || gate.includes("reward")) || adjudicationHasPayout)) return true;
  return requiredGates.some((gate) => gate.includes("payout") || gate.includes("reward")) && adjudicationHasPayout;
}

function bountyGateStatus(adjudication: unknown, gate: "scope" | "live_impact" | "known_issue" | "payout"): string | undefined {
  const record = asRecord(adjudication);
  if (!record) return undefined;
  const direct = directGateStatus(record, gate);
  if (direct) return direct;
  const gates = Array.isArray(record.gates) ? record.gates.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
  const needles = gateNeedles(gate);
  for (const entry of gates) {
    const id = normalizedWord(stringValue(entry.id ?? entry.key ?? entry.name ?? entry.gate));
    if (needles.some((needle) => id.includes(needle))) {
      const status = stringValue(entry.status ?? entry.result ?? entry.state);
      if (status) return status;
    }
  }
  return undefined;
}

function directGateStatus(record: Record<string, unknown>, gate: "scope" | "live_impact" | "known_issue" | "payout"): string | undefined {
  const keys: Record<typeof gate, string[]> = {
    scope: ["scope_status", "scopeStatus", "asset_status", "assetStatus", "eligibility_status", "eligibilityStatus"],
    live_impact: ["live_impact_status", "liveImpactStatus", "funds_status", "fundsStatus", "exposure_status", "exposureStatus"],
    known_issue: ["known_issue_status", "knownIssueStatus", "novelty_status", "noveltyStatus", "duplicate_status", "duplicateStatus"],
    payout: ["payout_status", "payoutStatus", "reward_status", "rewardStatus"],
  };
  for (const key of keys[gate]) {
    const status = stringValue(record[key]);
    if (status) return status;
  }
  if (gate === "payout") {
    const payout = asRecord(record.payout_estimate ?? record.payoutEstimate ?? record.reward_estimate ?? record.rewardEstimate);
    const status = stringValue(payout?.status);
    if (status) return status;
  }
  return undefined;
}

function gateNeedles(gate: "scope" | "live_impact" | "known_issue" | "payout"): string[] {
  switch (gate) {
    case "scope": return ["scope", "venue", "eligib", "asset"];
    case "live_impact": return ["live", "impact", "fund", "exposure", "deployment"];
    case "known_issue": return ["known", "novel", "duplicate", "disclos"];
    case "payout": return ["payout", "reward", "collectible", "bounty"];
  }
}

function isPassingBountyGateStatus(status: string | undefined, gate: "scope" | "live_impact" | "known_issue" | "payout"): boolean {
  const normalized = normalizedWord(status);
  if (!normalized) return false;
  if (isNegativeGateStatus(normalized)) return false;
  if (matchesStatus(normalized, ["pass", "passed", "satisfied", "confirmed", "established", "eligible", "ok", "yes"])) return true;
  if (gate === "scope" && matchesStatus(normalized, ["in_scope", "eligible"])) return true;
  if (gate === "live_impact" && matchesStatus(normalized, ["funded", "live", "live_funded", "affected_live_deployment"])) return true;
  if (gate === "known_issue" && matchesStatus(normalized, ["novel", "not_duplicate", "not_disclosed", "no_known_issue", "not_known"])) return true;
  if (gate === "payout" && matchesStatus(normalized, ["estimated", "collectible"])) return true;
  return false;
}

function isNegativeGateStatus(normalized: string): boolean {
  return matchesStatus(normalized, [
    "fail",
    "failed",
    "unknown",
    "needs_human",
    "blocked",
    "missing",
    "unsettled",
    "not_applicable",
    "unfunded",
    "not_funded",
    "not_live",
    "no_live",
    "no_funds",
    "not_novel",
    "not_estimated",
    "already_disclosed",
    "duplicate",
    "disclosed",
  ]);
}

function matchesStatus(normalized: string, tokens: string[]): boolean {
  return tokens.some((token) => normalized === token || normalized.startsWith(`${token}_`));
}

function impactInventoryCoversRow(row: ConfirmDecisionLike, impactInventory: unknown): boolean {
  const inventory = asRecord(impactInventory);
  const inventoryItems = inventory?.items;
  const itemsRaw = Array.isArray(inventoryItems)
    ? inventoryItems
    : Array.isArray(impactInventory)
      ? impactInventory
      : [];
  if (itemsRaw.length === 0) return false;
  const rowMembers = new Set((row.members ?? []).map((member) => normalizedWord(member)).filter(Boolean));
  const rowBug = normalizedWord(row.bug);
  for (const raw of itemsRaw) {
    const item = asRecord(raw);
    if (!item) continue;
    const bug = normalizedWord(stringValue(item.bug ?? item.title));
    if (bug && rowBug && bug === rowBug) return true;
    const members = Array.isArray(item.members) ? item.members.map((member) => normalizedWord(stringValue(member))).filter(Boolean) : [];
    if (members.some((member) => rowMembers.has(member))) return true;
  }
  return false;
}

function appendHumanGate(existing: string | undefined, note: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) return note;
  if (trimmed.includes(note)) return trimmed;
  return `${trimmed} ${note}`;
}

function normalizeDecisionRow(raw: Record<string, unknown>): ConfirmDecisionRow {
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : JSON.stringify(value));
  const members = Array.isArray(raw.members) ? raw.members.map((m) => str(m)).filter(Boolean) : str(raw.members) ? [str(raw.members)] : [];
  const reproduced = ((value: string): ConfirmDecisionRow["reproduced"] => (value === "yes" || value === "no" || value === "could-not-set-up" ? value : "unknown"))(str(raw.reproduced).toLowerCase());
  const recommendation = ((value: string): ConfirmDecisionRow["recommendation"] =>
    value === "submit-candidate" || value === "needs-human" || value === "drop" ? value : "unknown")(str(raw.recommendation).toLowerCase());
  const reproCommandId = str(raw.repro_command_id) || str(raw.reproCommandId);
  const evidenceLevel = str(raw.evidence_level) || str(raw.evidenceLevel);
  const submissionConfidence = str(raw.submission_confidence) || str(raw.submissionConfidence);
  const fixPatch = parseFixPatch(raw.fix_patch ?? raw.fixPatch);
  const patched = asStringList(raw.patched_success_patterns ?? raw.patchedSuccessPatterns);
  const engagementProfile = normalizeStructuredValue(raw.engagement_profile ?? raw.engagementProfile);
  const adjudication = normalizeStructuredValue(raw.adjudication);
  return {
    bug: str(raw.bug) || str(raw.title) || "(unnamed)",
    members,
    distinctFix: str(raw.distinct_fix) || str(raw.distinctFix),
    reproduced,
    reproEvidence: str(raw.repro_evidence) || str(raw.reproEvidence),
    corroboration: str(raw.corroboration),
    novelty: str(raw.novelty),
    humanGates: str(raw.human_gates) || str(raw.humanGates),
    ...(engagementProfile ? { engagementProfile } : {}),
    ...(adjudication ? { adjudication } : {}),
    recommendation,
    ...(evidenceLevel ? { evidenceLevel } : {}),
    ...(submissionConfidence ? { submissionConfidence } : {}),
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

function normalizeStructuredValue(value: unknown): ConfirmStructuredValue | undefined {
  let raw = value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  const normalized = sanitizeJsonValue(raw);
  return normalized && typeof normalized === "object" ? (normalized as ConfirmStructuredValue) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value === undefined || value === null
      ? ""
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
}

function normalizedWord(value: unknown): string {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return String(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = sanitizeJsonValue(entry, depth + 1);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

// Find the latest prior confirm run of THIS input run (same output dir + target, matched
// by frozen provenance) and return its SETTLED decision rows (reproduced yes/no) — the
// resume basis. Skips the current run dir; falls through to an older run if the latest has
// no decision sheet yet (killed before its first checkpoint).
export async function loadSettledFromPriorConfirm(outputDir: string, targetName: string, inputRunDir: string, currentRunDir: string, inputRunDirs?: readonly string[]): Promise<ConfirmDecisionRow[]> {
  const prefix = `${targetName}-confirm-`;
  const currentBase = path.basename(currentRunDir);
  const wantedInputs = new Set((inputRunDirs && inputRunDirs.length > 0 ? inputRunDirs : [inputRunDir]).map((dir) => publicPath(dir)));
  let names: string[] = [];
  try {
    names = await readdir(outputDir);
  } catch {
    return [];
  }
  const candidates = names.filter((name) => name.startsWith(prefix) && name !== currentBase).sort().reverse();
  const rows: ConfirmDecisionRow[] = [];
  const covered = new Set<string>();
  const memberKeys = (row: ConfirmDecisionRow): string[] => {
    const keys = row.members.map((member) => member.trim().toLowerCase()).filter(Boolean);
    return keys.length > 0 ? keys : [row.bug.trim().toLowerCase()].filter(Boolean);
  };
  const provenanceInputs = (prov: { inputRunDir?: unknown; runDirs?: unknown }): string[] => {
    const raw = Array.isArray(prov.runDirs) ? prov.runDirs : [prov.inputRunDir];
    return [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))];
  };
  for (const name of candidates) {
    const dir = path.join(outputDir, name);
    try {
      const prov = JSON.parse(await readFile(path.join(dir, "confirm_provenance.json"), "utf8")) as { inputRunDir?: unknown; runDirs?: unknown };
      const inputs = provenanceInputs(prov);
      if (inputs.length === 0 || !inputs.every((candidate) => wantedInputs.has(candidate))) continue;
      const raw: unknown = JSON.parse(await readFile(path.join(dir, "confirm_decision.json"), "utf8"));
      const items = Array.isArray(raw) ? raw : [];
      const settled = items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map(normalizeDecisionRow);
      for (const row of settled.filter((entry) => isResumeSettledDecision(entry))) {
        const keys = memberKeys(row);
        if (keys.length > 0 && keys.every((key) => covered.has(key))) continue;
        rows.push(row);
        for (const key of keys) covered.add(key);
      }
    } catch {
      // unreadable provenance/decision (e.g. killed before first checkpoint) — try the next-older run
    }
  }
  return rows;
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
  const evidenceRank: Record<string, number> = { unknown: 0, "not-reproduced": 1, "could-not-set-up": 1, reasoned: 2, "source-supported": 3, "source-only-local-confirmed": 4, "locally-reproduced": 4, "execution-reproduced": 4, "local-fork-reproduced": 5, "fork-reproduced": 5, "real-target-reproduced": 6 };
  const confidenceRank: Record<string, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
  const strongest = <T extends string>(values: T[], rank: Record<T, number>, fallback: T): T => values.reduce((best, value) => (rank[value] > rank[best] ? value : best), fallback);
  const engagementProfile = members.map((m) => m.engagementProfile).find(Boolean);
  const adjudication = members.map((m) => m.adjudication).find(Boolean);
  const evidenceLevel = strongest(members.map((m) => m.evidenceLevel ?? "unknown"), evidenceRank, "unknown");
  const submissionConfidence = strongest(members.map((m) => m.submissionConfidence ?? "unknown"), confidenceRank, "unknown");
  return {
    bug: members.map((m) => m.bug).join(" / "),
    members: uniq(members.flatMap((m) => [...m.members, m.bug])),
    distinctFix: members.map((m) => m.distinctFix).find(Boolean) ?? "",
    reproduced: strongest(members.map((m) => m.reproduced), reproRank, "unknown"),
    reproEvidence: uniq(members.map((m) => m.reproEvidence)).join(" | "),
    corroboration: uniq(members.map((m) => m.corroboration)).join(" | "),
    novelty: uniq(members.map((m) => m.novelty)).join(" | "),
    humanGates: uniq(members.map((m) => m.humanGates)).join(" | "),
    ...(engagementProfile ? { engagementProfile } : {}),
    ...(adjudication ? { adjudication } : {}),
    ...(evidenceLevel !== "unknown" ? { evidenceLevel } : {}),
    ...(submissionConfidence !== "unknown" ? { submissionConfidence } : {}),
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
  impactInventory?: unknown;
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
  const bountyLikeRows = input.rows.filter((row) => isBountyLikePolicy(row.engagementProfile, row.adjudication));
  if (input.impactInventory) {
    out.push("## Impact / Exposure Inventory", "");
    out.push(`- Artifact: \`${IMPACT_INVENTORY_FILE}\``);
    out.push(`- Summary: ${formatStructuredSummary(input.impactInventory)}`);
    out.push("");
  } else if (bountyLikeRows.length > 0) {
    out.push("## Impact / Exposure Inventory", "");
    out.push(`_${IMPACT_INVENTORY_FILE} was not written; bounty-like reproduced rows cannot be treated as submit-ready until live exposure is established or explicitly ruled out._`, "");
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
    if (row.engagementProfile) out.push(`- Engagement profile: ${formatStructuredSummary(row.engagementProfile)}`);
    if (row.adjudication) out.push(`- Eligibility / payout adjudication: ${formatStructuredSummary(row.adjudication)}`);
    out.push("");
  }
  return out.join("\n");
}

function formatStructuredSummary(value: unknown): string {
  try {
    return `\`${JSON.stringify(value)}\``;
  } catch {
    return String(value);
  }
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}
