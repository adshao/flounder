import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { withRole, type AuditorConfig } from "../config.js";
import { deriveScopeNote } from "../scope-note.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { createLlmClient } from "../llm/client.js";
import { renderDisclosure, reportArtifactName } from "../reports/disclosure.js";
import { projectHistoryDir, projectHistoryManifestPath, updateProjectHistory } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { AuditSummary, ConfirmationStatus, Doc, LlmClient, RankedFinding, Severity } from "../types.js";
import { publicPath } from "../util/paths.js";
import { materialFingerprint, phaseInputFingerprint } from "../util/material-fingerprint.js";
import { canonicalFindingKey } from "../util/finding-identity.js";
import { positiveIntegerId } from "../util/ids.js";
import { compactSandboxWorkspace, listWorkspaceFiles, normalizeRelativePath, prepareSandboxWorkspace, writeSandboxFiles, type SandboxWorkspace } from "../security/sandbox.js";
import { runDifferentialConfirmation, type DifferentialResult } from "./differential.js";
import { runDischargeChallenge, runRefutation, type RefutationError, type RefutationVerdict } from "./refutation.js";
import { runAuditLoop } from "./loop.js";
import { ProjectMemory } from "./memory.js";
import { loadScopeInventory, mergeScopeInventory, saveScopeInventory, scopeProgress } from "./scope-store.js";
import { RunRecorder, toDiscoveryBacklogRows, toFindingStatus, type RunTrackerFactory } from "../db/record.js";
import type { RunKind } from "../db/store.js";
import { isPiSessionProvider, runAuditSession, SessionLlmClient } from "./pi-session.js";
import type { TranscriptStep } from "./prompts.js";
import { buildTools, clearScratchFindings, dedupeFindings, ingestFindingsFromScratch, isRefutedFindingTitle, newSession, readScratchScopes, type AgentFinding, type AgentSession, type AuditScope, type ToolContext } from "./tools.js";
import {
  COVERAGE_GAPS_FILE,
  FOLLOWUP_SCOPES_FILE,
  RESOURCE_REQUESTS_FILE,
  RUN_HEALTH_FILE,
  buildRunHealth,
  mergeFollowupScopes,
  readDiscoveryArtifacts,
  type CoverageGap,
  type ResourceRequest,
  type RunHealth,
} from "./discovery-artifacts.js";
import { prepareResourceRequests, prepareWorkspaceToolchain } from "./prepare.js";
import {
  SCOPE_OUTCOMES_FILE,
  appendScopeOutcomes,
  clearScratchScopeOutcome,
  incompleteScopeOutcome,
  latestScopeOutcomes,
  loadScopeOutcomes,
  mergeScopeOutcomes,
  nextScopeOutcomeSample,
  readScratchScopeOutcome,
  saveScopeOutcomes,
  scopeOutcomeNeedsAnotherSample,
  scopeOutcomeNeedsCoverage,
  type ScopeOutcome,
} from "./scope-outcomes.js";

const APPEND_MAP_EXISTING_SCOPES_PATH = "map_existing_scopes.json";
const SYNTHESIS_SCOPE_OUTCOMES_PATH = "synthesis_scope_outcomes.json";

// Orchestrates one autonomous audit: load authorized material, give the model the
// capability surface, run the ReAct loop, then turn whatever it proved into the
// same finding/summary/report/history artifacts the rest of the toolchain uses.
// All discrimination about *what* is a bug comes from the model; this function
// only wires capability, persistence, and reporting around it.

export interface AuditRunResult {
  runDir: string;
  summary: AuditSummary;
  /** Scope-inventory coverage for the resumable map → dig flow (omitted otherwise). */
  scopeCoverage?: { total: number; audited: number; pending: number };
}

export interface AuditRunControl {
  /** Runtime override for how many auto-selected scopes this run should dig. */
  getRunScopesTarget?: () => number | undefined;
}

export async function runAudit(
  cfg: AuditorConfig,
  options: { llm?: LlmClient; streamEvents?: boolean; kind?: RunKind; signal?: AbortSignal; onRun?: (runId: number) => void; onActivity?: (event: { kind: string; delta?: string; tool?: string; step?: number; streamId?: string }) => void; makeTracker?: RunTrackerFactory; control?: AuditRunControl } = {},
): Promise<AuditRunResult> {
  const startedAt = new Date();
  const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await nonFatalAuditMaintenance(logger, "last_run_pointer_start", () => writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName));

  const source = await loadSource(cfg.sourcePaths, { ...(cfg.buildRoot ? { publicRoot: cfg.buildRoot } : {}) });
  const corpus = await loadCorpus(cfg.corpusPaths);
  const buildDocs = cfg.buildRoot ? await loadSource([cfg.buildRoot], { publicRoot: cfg.buildRoot }) : [];
  cfg.materialFingerprint = materialFingerprint([
    { label: "source", docs: source },
    { label: "build", docs: buildDocs },
    { label: "corpus", docs: corpus },
  ]);
  await logger.event("audit_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    model: cfg.auditModel,
    maxSteps: cfg.auditMaxSteps,
    sourceDocs: source.length,
    corpusDocs: corpus.length,
  });

  if (source.length === 0) throw new Error("audit requires at least one source file (use --source)");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(cfg)), "memory.jsonl"));
  const session = newSession();
  const tools = buildTools();
  const ctx: ToolContext = { cfg, source, corpus, memory, logger, session };
  if (cfg.auditRemap && cfg.auditAppendMap) throw new Error("choose either append-map or remap, not both");

  // Create the shared isolated workspace up front. It is the sandbox for tools
  // and the cwd for the agent session. The toolchain warm-up is lazy (run by the
  // bash tool on the first test command) so read-only or unauthenticated runs do
  // not pay for it.
  let workspaceCwd = process.cwd();
  const corpusManifest: string[] = [];
  const workspaceRoots = cfg.buildRoot ? [cfg.buildRoot] : cfg.sourcePaths;
  if (cfg.sourcePaths.length > 0) {
    // The sandbox copies the build root (a buildable project, e.g. a workspace
    // root) when one is set, so a narrow audit scope can still compile; otherwise
    // it copies the audited source. The model still reads only `sourcePaths`.
    const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "audit/workspace");
    session.workspace = workspace;
    workspaceCwd = workspace.absolute;
    // Persistent, host-isolated package cache so dependency builds are downloaded
    // once and reused across runs (HOME stays the per-run workspace).
    session.buildCacheDir = cfg.buildCacheDir ?? path.join(projectHistoryDir(historyLocation(cfg)), "build-cache");
    // Capture the pristine target source before anything else touches the
    // workspace, so the model cannot modify the code it is auditing — a
    // confirmation must run against untampered source.
    session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
    // Make corpus (specs, papers, books) visible to the agent: copy it into the
    // workspace so the model can read/grep it, and list it in the manifest. This
    // reference material is often what makes a subtle bug discoverable.
    corpusManifest.push(...(await copyCorpusIntoWorkspace(workspace, corpus)));
  }

  let scopeNote = resolveScopeNote(cfg);
  // No explicit scope note (the `run <clue>` pipeline supplies one; a UI-launched map on a prepare
  // workspace does not) — fall back to deriving the focus from a prepare_manifest.json staged in the
  // source. So map/dig concentrate on the in-scope target however the run was started, not only via
  // the pipeline. Silent when no manifest is present (map then treats all source as in scope).
  if (!scopeNote.trim()) {
    const derived = deriveScopeNoteFromSource(cfg.sourcePaths);
    if (derived) {
      scopeNote = derived;
      await logger.event("audit_scope_focus", { source: "prepare_manifest", components: derived.split("\n").filter((l) => l.startsWith("- ")).length });
    }
  }
  // Driver choice: real pi providers (e.g. openai-codex) run a continuous
  // AgentSession that owns the loop; the deterministic mock and CLI fallbacks use
  // the legacy per-step complete() loop.
  const fileManifest = renderFileManifest(source, corpusManifest);
  const memoryHintFor = async (opts: { mode: string; deepFocus?: string }): Promise<string> => {
    const filter = { ...(cfg.materialFingerprint ? { materialFingerprint: cfg.materialFingerprint } : {}), includePortable: true };
    const query = [cfg.targetName, scopeNote, opts.mode, opts.deepFocus].filter(Boolean).join(" ");
    let notes = await memory.recall(query, 8, filter);
    if (notes.length === 0) notes = (await memory.all(filter)).slice(-8).reverse();
    return [renderNextActionsHint(cfg.auditNextActions), renderMemoryHint(notes)].filter(Boolean).join("\n\n");
  };

  // One phase = one driver run (continuous pi session for pi providers, else the
  // per-step loop), specialized to a role's model and a mode (breadth/map/dig).
  let phaseFailureReason: string | undefined;
  const rememberPhase = <T extends { stoppedReason: string }>(phase: T): T => {
    if (!phaseFailureReason && (phase.stoppedReason === "error" || phase.stoppedReason === "stalled")) {
      phaseFailureReason = phase.stoppedReason;
    }
    return phase;
  };
  const runPhase = async (
    phaseCfg: AuditorConfig,
    opts: { mode: "breadth" | "map" | "dig" | "verify" | "synthesize"; deepFocus?: string; verifySeed?: string; synthSeed?: string; maxSteps: number; mapExistingScopesPath?: string; mapExistingScopesCount?: number },
    over?: { ctx: ToolContext; cwd: string; activityStreamId?: string },
  ): Promise<{ steps: TranscriptStep[]; stoppedReason: string }> => {
    const phaseCtx = over?.ctx ?? ctx;
    const phaseCwd = over?.cwd ?? workspaceCwd;
    const memoryHint = await memoryHintFor(opts);
    const flags = {
      ...(opts.mode === "dig" ? { deep: true } : {}),
      ...(opts.mode === "map" ? { map: true } : {}),
      ...(opts.deepFocus ? { deepFocus: opts.deepFocus } : {}),
      ...(opts.verifySeed ? { verify: opts.verifySeed } : {}),
      ...(opts.synthSeed ? { synthesize: opts.synthSeed } : {}),
    };
    if (!options.llm && isPiSessionProvider(phaseCfg.provider)) {
      return rememberPhase(await runAuditSession({
        cfg: { ...phaseCfg, auditMaxSteps: opts.maxSteps },
        ctx: phaseCtx,
        tools,
        logger,
        cwd: phaseCwd,
        fileManifest,
        ...(scopeNote ? { scopeNote } : {}),
        ...(memoryHint ? { memoryHint } : {}),
        ...(opts.mapExistingScopesPath ? { mapExistingScopesPath: opts.mapExistingScopesPath } : {}),
        ...(opts.mapExistingScopesCount !== undefined ? { mapExistingScopesCount: opts.mapExistingScopesCount } : {}),
        ...(over?.activityStreamId ? { activityStreamId: over.activityStreamId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onActivity ? { onActivity: options.onActivity } : {}),
        ...flags,
      }));
    }
    const llm = options.llm ?? createLlmClient(phaseCfg, logger);
    if (llm && "setLogger" in llm && typeof (llm as { setLogger?: unknown }).setLogger === "function") {
      (llm as { setLogger(logger: RunLogger): void }).setLogger(logger);
    }
    return rememberPhase(await runAuditLoop({
      cfg: phaseCfg,
      llm,
      tools,
      ctx: phaseCtx,
      logger,
      maxSteps: Math.max(1, Math.floor(opts.maxSteps)),
      fileManifest,
      ...(scopeNote ? { scopeNote } : {}),
      ...(memoryHint ? { memoryHint } : {}),
      ...(opts.mapExistingScopesPath ? { mapExistingScopesPath: opts.mapExistingScopesPath } : {}),
      ...(opts.mapExistingScopesCount !== undefined ? { mapExistingScopesCount: opts.mapExistingScopesCount } : {}),
      ...flags,
    }));
  };

  const runMapEnsemble = async (coveredScopes: AuditScope[], coveredCount: number): Promise<{ scopes: AuditScope[]; steps: TranscriptStep[] }> => {
    const sampleCount = Math.max(1, Math.floor(cfg.auditMapSamples));
    const sampleMaps: AuditScope[][] = [];
    const mapSteps: TranscriptStep[] = [];
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      if (options.signal?.aborted) throw new Error("audit aborted");
      const ws = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, `audit/map-sample-${sample}`);
      const mapSession = newSession();
      mapSession.workspace = ws;
      if (session.buildCacheDir) mapSession.buildCacheDir = session.buildCacheDir;
      await copyCorpusIntoWorkspace(ws, corpus);
      const mapCtx: ToolContext = { cfg: withRole(cfg, "map"), source, corpus, memory, logger, session: mapSession };
      const seedPath = await writeAppendMapExistingScopesSeed(coveredScopes, ws.absolute);
      const phase = await runPhase(withRole(cfg, "map"), {
        mode: "map",
        maxSteps: cfg.auditMapSteps,
        ...(seedPath ? { mapExistingScopesPath: seedPath, mapExistingScopesCount: coveredCount } : {}),
      }, { ctx: mapCtx, cwd: ws.absolute });
      const scopes = readScratchScopes(mapSession).map((scope) => ({ ...scope, mapSamples: [sample], mapAgreement: 1 }));
      sampleMaps.push(scopes);
      mapSteps.push(...phase.steps);
      session.commandRuns.push(...mapSession.commandRuns.map((run) => ({ ...run, id: `map-s${sample}:${run.id}` })));
      await logger.event("audit_map_sample", { sample, of: sampleCount, scopes: scopes.length });
    }
    return { scopes: unionMapSamples(sampleMaps), steps: mapSteps };
  };

  let steps: TranscriptStep[];
  let stoppedReason: string;
  let auditMode: "breadth" | "map" | "map-dig" | "verify" | "dig" = "breadth";
  let manualFindings = false;
  let scopeInventory: AuditScope[] = [];
  let scopeOutcomes: ScopeOutcome[] = [];
  let newScopeOutcomes: ScopeOutcome[] = [];
  const scopeOutcomeErrors: Array<{ scopeId: string; sample: number; errors: string[] }> = [];
  // SQLite tracking: record the project + a running run, then update scope coverage,
  // findings, and final status as the run progresses. Failure-isolated (never throws).
  const recorder = (options.makeTracker ?? RunRecorder.start)(cfg, logger.runDir, options.kind ?? "run", logger);
  recorder.materialFingerprint?.(cfg.materialFingerprint!);
  if (recorder.runDbId !== undefined) options.onRun?.(recorder.runDbId); // let an in-process caller learn the DB run id
  // Set when concurrent digs already ran differential confirmation in their own
  // isolated workspaces, so the shared post-loop differential stage skips them.
  let digDifferentialDone = false;
  const refutationErrors: Array<{ phase: "refutation" | "appeal-refutation"; findingId: string; error: string }> = [];

  if (cfg.auditVerify) {
    auditMode = "verify";
    // VERIFY posture: confirm-or-refute existing suspected finding(s) by execution.
    // Skips map/dig enumeration; for each finding it runs a focused session seeded
    // with the claim ("write a PoC that triggers it, or refute it"), routed through
    // the same confirmation gate. Each claim gets its own workspace/session so one
    // candidate's generated PoC files cannot influence the next candidate's verdict.
    // This is exactly the confirmation tail of a dig, runnable standalone on a prior finding.
    const verifyInput = await loadFindingsToVerify(cfg.auditVerify);
    const toVerify = dedupeVerifyInputs(verifyInput);
    await logger.event("audit_verify_start", { findings: toVerify.length, inputFindings: verifyInput.length });
    const verifyCfg = withRole(cfg, "dig");
    const aggregated: AgentFinding[] = [];
    const aggregatedSteps: TranscriptStep[] = [];
    const workspaceRoots = cfg.buildRoot ? [cfg.buildRoot] : cfg.sourcePaths;
    recorder.runScopes(0, toVerify.length); // surface "verifying 0/N" before the first verdict lands
    let verifyDone = 0;
    const verifyOne = async (finding: Record<string, unknown>, idx: number): Promise<{
      findings: AgentFinding[];
      steps: TranscriptStep[];
      commandRuns: AgentSession["commandRuns"];
      scratchFiles: Array<[string, string]>;
    }> => {
      const verifyLabel = `verify-${idx + 1}`;
      const claimLabel = String(finding.title ?? "").slice(0, 90);
      const originId = verifyOriginId(finding);
      const inheritedScopeId = typeof finding.scopeId === "string" ? finding.scopeId : typeof finding.scope_id === "string" ? finding.scope_id : undefined;
      const suppliedAttempt = (finding.phaseAttempt ?? finding._phaseAttempt) as Record<string, unknown> | undefined;
      const attempt = originId !== undefined
        ? {
            subjectType: "finding" as const,
            subjectId: typeof suppliedAttempt?.subjectId === "number" ? suppliedAttempt.subjectId : originId,
            inputFingerprint: typeof suppliedAttempt?.inputFingerprint === "string"
              ? suppliedAttempt.inputFingerprint
              : phaseInputFingerprint({ phase: "verify", material: cfg.materialFingerprint, originId, finding }),
          }
        : undefined;
      if (attempt) recorder.phaseAttempt?.({ ...attempt, phase: "verify", state: "running" });
      const verifyWorkspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, `audit/${verifyLabel}`);
      const verifySession = newSession();
      verifySession.workspace = verifyWorkspace;
      verifySession.baselineFiles = await listWorkspaceFiles(verifyWorkspace.absolute);
      if (session.buildCacheDir) verifySession.buildCacheDir = session.buildCacheDir;
      await copyCorpusIntoWorkspace(verifyWorkspace, corpus);
      const verifyCtx: ToolContext = { cfg: verifyCfg, source, corpus, memory, logger, session: verifySession, activityStreamId: verifyLabel };
      clearScratchFindings(verifySession);
      const phase = await runPhase(verifyCfg, { mode: "verify", verifySeed: buildVerifySeed(finding), maxSteps: cfg.auditDigSteps }, { ctx: verifyCtx, cwd: verifyWorkspace.absolute, activityStreamId: verifyLabel });
      ingestFindingsFromScratch(verifySession);
      const normalizedVerdicts = normalizeVerifyVerdicts(verifySession.findings);
      verifySession.findings = normalizedVerdicts.findings;
      const primaryVerdict = verifySession.findings[0];
      if (normalizedVerdicts.conflict) {
        if (!phaseFailureReason) phaseFailureReason = "error";
        await logger.event("audit_verify_conflicting_verdicts", {
          index: idx + 1,
          of: toVerify.length,
          claim: claimLabel,
          rawVerdicts: normalizedVerdicts.inputCount,
        });
      }
      if (verifySession.resourceRequests?.length) {
        const settledRequests = settleVerifyResourceRequests(verifySession.resourceRequests, primaryVerdict);
        session.resourceRequests = mergeResourceRequests(session.resourceRequests ?? [], settledRequests.map((request) => ({
          ...request,
          ...(request.findingId ? {} : { findingId: String(originId ?? (claimLabel || idx + 1)) }),
          ...(request.scopeId || !inheritedScopeId ? {} : { scopeId: inheritedScopeId }),
        })));
      }
      const missingVerdict = verifySession.findings.length === 0;
      if (missingVerdict) {
        if (!phaseFailureReason) phaseFailureReason = "error";
        await logger.event("audit_verify_no_verdict", {
          index: idx + 1,
          of: toVerify.length,
          claim: claimLabel,
          stoppedReason: phase.stoppedReason,
          steps: phase.steps.length,
          commandRuns: verifySession.commandRuns.length,
        });
        if (attempt) recorder.phaseAttempt?.({
          ...attempt,
          phase: "verify",
          state: "blocked",
          outcome: "no-verdict",
          blocker: normalizedVerdicts.conflict
            ? "verify produced contradictory verdicts for the same claim"
            : verifySession.resourceRequests?.[0]?.reason || `verify ended ${phase.stoppedReason} without a verdict`,
          metrics: { steps: phase.steps.length, commandRuns: verifySession.commandRuns.length },
        });
      }
      // Carry the original suspected finding's identity onto THIS claim's verdict so it flips that
      // row (status + PoC) rather than inserting a duplicate. The link is positional — claim N is
      // seeded from input finding N — so it survives the verify session renaming the title. Only the
      // primary verdict inherits it; any extra finding the session split out stays its own new row.
      if (originId !== undefined && primaryVerdict) {
        primaryVerdict.originId = originId;
        if (attempt) primaryVerdict.phaseAttempt = attempt;
      }
      if (inheritedScopeId) {
        for (const produced of verifySession.findings) if (!produced.scopeId) produced.scopeId = inheritedScopeId;
      }
      for (const produced of verifySession.findings) {
        if (produced.confirmationStatus !== "confirmed-executable" || !produced.fixPatch || !produced.commandRunId) continue;
        const exploitRun = verifySession.commandRuns.find((run) => run.id === produced.commandRunId);
        if (!exploitRun) continue;
        const result = await runDifferentialConfirmation({ workspace: verifyWorkspace, finding: produced, exploitRun, baselineFiles: verifySession.baselineFiles, cfg: verifyCfg, logger, ...(verifySession.buildCacheDir ? { cacheDir: verifySession.buildCacheDir } : {}) });
        if (result.confirmed) produced.confirmationStatus = "confirmed-differential";
      }
      recorder.findings(verifySession.findings, logger.runDir, `verify ${idx + 1}/${toVerify.length}`); // persist this verdict live (flips the original when originId is set)
      if (!missingVerdict) {
        verifyDone += 1;
        if (attempt) recorder.phaseAttempt?.({ ...attempt, phase: "verify", state: "settled", outcome: primaryVerdict ? toFindingStatus(primaryVerdict) : "verdict", metrics: { findings: verifySession.findings.length, steps: phase.steps.length } });
      }
      recorder.runScopes(verifyDone, toVerify.length); // verdict count, independent of completion order
      await logger.event("audit_verify_done", { index: idx + 1, of: toVerify.length, claim: claimLabel, produced: verifySession.findings.length, stoppedReason: phase.stoppedReason });
      const commandIdPrefix = `${verifyLabel}:`;
      for (const produced of verifySession.findings) if (produced.commandRunId) produced.commandRunId = `${commandIdPrefix}${produced.commandRunId}`;
      const scratchFiles = [...verifySession.scratchFiles.entries()].map(([scratchPath, content]) => [`${verifyLabel}/${scratchPath}`, content] as [string, string]);
      await compactCompletedAuditWorkspace(verifyWorkspace, verifySession, logger, "verify", verifyLabel);
      return {
        findings: verifySession.findings,
        steps: phase.steps,
        commandRuns: verifySession.commandRuns.map((run) => ({ ...run, id: `${commandIdPrefix}${run.id}` })),
        scratchFiles,
      };
    };
    const verifyResults = await runWithConcurrency(toVerify, Math.max(1, Math.floor(cfg.auditVerifyConcurrency)), (finding, idx) => verifyOne(finding as Record<string, unknown>, idx));
    for (const result of verifyResults) {
      aggregated.push(...result.findings);
      aggregatedSteps.push(...result.steps);
      session.commandRuns.push(...result.commandRuns);
      for (const [scratchPath, content] of result.scratchFiles) session.scratchFiles.set(scratchPath, content);
    }
    aggregated.forEach((produced, i) => {
      produced.id = `f${i + 1}`;
    });
    session.findings = aggregated;
    session.counters.finding = aggregated.length;
    digDifferentialDone = true;
    manualFindings = true;
    steps = aggregatedSteps;
    stoppedReason = verifyBatchStoppedReason(phaseFailureReason, verifyDone, toVerify.length);
  } else if (cfg.auditMapOnly) {
    auditMode = "map";
    // MAP only (`flounder map`): enumerate and persist the scope inventory, then stop — no
    // dig. The resumable `flounder audit` digs from this inventory afterwards.
    const inventoryDir = projectHistoryDir(historyLocation(cfg));
    scopeOutcomes = await loadScopeOutcomes(inventoryDir, cfg.materialFingerprint);
    if (!cfg.auditAppendMap) {
      await clearCurrentMaterialScopeOutcomes(inventoryDir, cfg.materialFingerprint);
      scopeOutcomes = [];
    }
    const existing = cfg.auditAppendMap ? await loadScopeInventory(inventoryDir, cfg.materialFingerprint) : [];
    const seedScopes = await loadAppendMapSeedScopes(cfg);
    if (existing.length > 0 || seedScopes.length > 0) await logger.event("audit_map_append_start", { existing: existing.length, seedScopes: seedScopes.length, samples: cfg.auditMapSamples });
    const mapResult = await runMapEnsemble([...existing, ...seedScopes], existing.length);
    const mapped = mapResult.scopes;
    if (existing.length > 0) {
      const merged = mergeScopeInventory(existing, mapped);
      scopeInventory = merged.scopes;
      await logger.event("audit_map_append_done", { existing: existing.length, produced: mapped.length, added: merged.added, skippedDuplicate: merged.skippedDuplicate, total: scopeInventory.length });
    } else {
      scopeInventory = mapped;
      await logger.event("audit_map_done", { scopes: scopeInventory.length });
    }
    stampScopeInventory(scopeInventory, cfg.materialFingerprint);
    for (const scope of scopeInventory) if (!scope.status) scope.status = "pending";
    await saveScopeInventory(inventoryDir, scopeInventory, { replace: !cfg.auditAppendMap });
    await logger.artifact("audit_scopes.json", scopeInventory);
    await logger.event("audit_scope_progress", { ...scopeProgress(scopeInventory), resumed: false });
    recorder.scopes(scopeInventory);
    clearScratchFindings(session);
    session.findings = [];
    session.counters.finding = 0;
    manualFindings = true; // map produces a scope inventory, not findings
    steps = mapResult.steps;
    stoppedReason = phaseFailureReason ?? "finished";
  } else if (cfg.auditDeep && !cfg.auditDeepFocus) {
    auditMode = "map-dig";
    // MAP → DIG, resumable. The complete scope inventory is persisted under the
    // project history dir; each run deep-audits the next batch of un-audited
    // scopes and updates their status. Re-running the same command therefore
    // continues with the scopes not yet audited instead of re-mapping or
    // re-digging. --remap discards the persisted inventory and enumerates afresh.
    const inventoryDir = projectHistoryDir(historyLocation(cfg));
    const aggregatedSteps: TranscriptStep[] = [];
    const picked = cfg.auditScopeIds ?? [];
    scopeOutcomes = await loadScopeOutcomes(inventoryDir, cfg.materialFingerprint);
    scopeInventory = cfg.auditRemap ? [] : await loadScopeInventory(inventoryDir, cfg.materialFingerprint);
    const appendExisting = cfg.auditAppendMap ? scopeInventory : [];
    const appendSeedScopes = cfg.auditAppendMap ? await loadAppendMapSeedScopes(cfg) : [];
    const resuming = scopeInventory.length > 0 && !cfg.auditAppendMap;
    // Backfill inventories written by older releases that marked every finished
    // DIG attempt audited even when its latest outcome explicitly left coverage
    // incomplete. Requeue generally from durable evidence, never a local id list.
    const latestOutcomesByScope = new Map(latestScopeOutcomes(scopeOutcomes).map((outcome) => [outcome.scopeId, outcome]));
    const requeuedIncompleteScopes: string[] = [];
    const reconciledCompletedScopes: string[] = [];
    for (const scope of scopeInventory) {
      const outcome = latestOutcomesByScope.get(scope.id);
      if (!outcome) continue;
      const needsCoverage = scopeOutcomeNeedsCoverage(outcome);
      if (scope.status === "audited" && needsCoverage) {
        scope.status = "pending";
        requeuedIncompleteScopes.push(scope.id);
      } else if (scope.status === "pending" && !needsCoverage) {
        // Releases that treated unresolved composition leads as incomplete left
        // fully handed-off scopes pending. Repair those checkpoints from the
        // durable outcome so resume advances instead of repeating the same DIG.
        scope.status = "audited";
        reconciledCompletedScopes.push(scope.id);
      }
    }
    if (requeuedIncompleteScopes.length > 0) {
      await logger.event("audit_scope_coverage_requeued", { scopes: requeuedIncompleteScopes });
    }
    if (reconciledCompletedScopes.length > 0) {
      await logger.event("audit_scope_coverage_reconciled", { scopes: reconciledCompletedScopes });
    }
    if (!resuming && !cfg.auditAppendMap) {
      await clearCurrentMaterialScopeOutcomes(inventoryDir, cfg.materialFingerprint);
      scopeOutcomes = [];
    }
    if (!resuming && (picked.length > 0 || cfg.auditRequireInventory)) {
      throw new Error("`flounder audit` needs an existing scope inventory; run `flounder map` first to enumerate scopes (then pick with `--scope` from audit_scopes.json), or `flounder run` to map and audit in one pass.");
    }
    if (!resuming) {
      if (appendExisting.length > 0 || appendSeedScopes.length > 0) await logger.event("audit_map_append_start", { existing: appendExisting.length, seedScopes: appendSeedScopes.length, samples: cfg.auditMapSamples });
      const mapResult = await runMapEnsemble([...appendExisting, ...appendSeedScopes], appendExisting.length);
      const mapped = mapResult.scopes;
      if (appendExisting.length > 0) {
        const merged = mergeScopeInventory(appendExisting, mapped);
        scopeInventory = merged.scopes;
        await logger.event("audit_map_append_done", { existing: appendExisting.length, produced: mapped.length, added: merged.added, skippedDuplicate: merged.skippedDuplicate, total: scopeInventory.length });
      } else {
        scopeInventory = mapped;
        await logger.event("audit_map_done", { scopes: scopeInventory.length });
      }
      aggregatedSteps.push(...mapResult.steps);
      clearScratchFindings(session);
    } else {
      await logger.event("audit_map_resumed", { ...scopeProgress(scopeInventory) });
    }
    stampScopeInventory(scopeInventory, cfg.materialFingerprint);
    for (const scope of scopeInventory) if (!scope.status) scope.status = "pending";
    // Persist the inventory BEFORE digging so a kill mid-run does not lose the map —
    // resume then skips MAP. Each dig below also checkpoints scope status + partial
    // findings, so a killed run only redoes the one in-flight dig.
    await saveScopeInventory(inventoryDir, scopeInventory, {
      replace: !resuming && !cfg.auditAppendMap,
      ...(requeuedIncompleteScopes.length > 0 ? { forceStatusIds: requeuedIncompleteScopes } : {}),
    });
    recorder.scopes(scopeInventory);

    const digCfg = withRole(cfg, "dig");
    let toDig: AuditScope[];
    let autoSelectedScopes = false;
    if (picked.length > 0) {
      // Human-in-the-loop: deep-audit exactly the named scopes (re-auditing an
      // already-audited one is allowed), regardless of score order.
      const wanted = new Set(picked);
      toDig = scopeInventory.filter((scope) => wanted.has(scope.id));
      const missing = picked.filter((id) => !toDig.some((scope) => scope.id === id));
      if (missing.length > 0) await logger.event("audit_scope_unknown", { ids: missing });
      if (toDig.length === 0) throw new Error(`none of the requested scope ids exist in the inventory: ${picked.join(", ")}`);
      await logger.event("audit_scope_picked", { ids: toDig.map((scope) => scope.id) });
    } else {
      autoSelectedScopes = true;
      // Audit the highest-scored scopes not yet audited; the rest stay pending for
      // a future run (visible, never silently dropped). A "deferred" scope is one the
      // operator chose to skip, so auto-selection excludes it (an explicit --scope still digs it).
      toDig = scopeInventory
        .filter((scope) => scope.status !== "audited" && scope.status !== "deferred")
        .sort((a, b) => ((b.priority ?? 0) - (a.priority ?? 0)) || (b.score - a.score)) // manual "↑ Top" priority first, then score
        ;
    }
    // This run's dig batch: toDig is the set of scopes THIS run audits (capped by --max-scopes),
    // distinct from the project-cumulative coverage. Report it so the UI can show "M / N this run".
    const requestedRunScopesTarget = (): number => {
      if (!autoSelectedScopes) return toDig.length;
      const live = options.control?.getRunScopesTarget?.();
      const raw = typeof live === "number" && Number.isFinite(live) ? live : cfg.auditMaxScopes;
      if (toDig.length === 0) return 0;
      return Math.min(toDig.length, Math.max(0, Math.floor(raw)));
    };
    const effectiveRunScopesTarget = (done: number): number => Math.max(done, requestedRunScopesTarget());
    let reportedRunScopesTarget = effectiveRunScopesTarget(0);
    recorder.runScopes(0, reportedRunScopesTarget);
    let digDone = 0;
    const aggregated: AgentFinding[] = [];
    // Checkpoint the run's confirmed findings so far to the run dir after each dig, so a
    // killed run keeps the completed digs' findings (raw confirmed-executable; the
    // end-of-run write replaces them with the differential/refutation-processed set).
    const checkpointFindings = async (): Promise<void> => {
      const confirmedSoFar = aggregated.filter(isExecutionConfirmedFinding).map((finding, idx) => ({ ...finding, id: `f${idx + 1}` }));
      await logger.artifact("audit_findings.json", confirmedSoFar);
      recorder.findings(aggregated, logger.runDir, "dig checkpoint"); // persist live so the UI shows findings as each scope lands (content-keyed, so statuses update in place later)
    };
    const samples = Math.max(1, Math.floor(cfg.auditDigSamples));
    const maxSamples = Math.max(samples, Math.floor(cfg.auditDigMaxSamples));
    const concurrency = Math.max(1, Math.floor(cfg.auditDigConcurrency));
    if (cfg.auditEagerPrepare && session.workspace && toDig.length > 0) {
      const report = await prepareWorkspaceToolchain({
        workspace: session.workspace,
        cfg,
        logger,
        focusPaths: toDig.map((scope) => scope.region),
        ...(session.buildCacheDir ? { cacheDir: session.buildCacheDir } : {}),
      });
      const requests = prepareResourceRequests(report);
      if (requests.length > 0) session.resourceRequests = mergeResourceRequests(session.resourceRequests ?? [], requests);
      recorder.stage("build-readiness", {
        status: requests.length > 0 ? "blocked" : "ready",
        detected: report.detected,
        commands: report.results.length,
        failed: report.results.filter((result) => !result.ok).length + report.toolVersionChecks.filter((check) => !check.ok).length,
      });
    }
    // The region is the audit boundary; the map's obligation is only a starting
    // hint, never a limit (the dig system prompt's own rule is to independently
    // enumerate ALL of a region's obligations).
    const buildDeepFocus = (scope: AuditScope): string =>
      `scope ${scope.id}; code region ${scope.region} — audit this WHOLE region: independently enumerate and discharge ALL of its security obligations; ` +
      `do NOT limit yourself to any single one. The map flagged one concern as a starting point (not a boundary): "${scope.obligation}"`;
    const coverageCompleted = (outcomes: ScopeOutcome[]): boolean => {
      const latest = outcomes.at(-1);
      return Boolean(latest && !scopeOutcomeNeedsCoverage(latest));
    };
    // Run a scope's dig `samples` times and union the findings. Per-pass recall on a
    // subtle obligation is < 1 and stochastic; K independent passes raise cumulative
    // recall (1 - (1-p)^K). `over` isolates a concurrent dig in its own session.
    const resetInFlightScope = async (scope: AuditScope): Promise<void> => {
      if (scope.status !== "auditing") return;
      scope.status = "pending";
      await saveScopeInventory(inventoryDir, scopeInventory, { forceStatusIds: [scope.id] });
      recorder.scopes(scopeInventory);
      await logger.event("audit_dig_requeued", { scope: scope.id, reason: options.signal?.aborted ? "aborted" : "interrupted" });
    };
    const digSamples = async (scope: AuditScope, sess: AgentSession, over?: { ctx: ToolContext; cwd: string; activityStreamId?: string }): Promise<{ findings: AgentFinding[]; outcomes: ScopeOutcome[]; steps: TranscriptStep[] }> => {
      const deepFocus = buildDeepFocus(scope);
      const perScope: AgentFinding[] = [];
      const perScopeOutcomes: ScopeOutcome[] = [];
      const stepsOut: TranscriptStep[] = [];
      const sampleOffset = nextScopeOutcomeSample(scopeOutcomes, scope.id) - 1;
      for (let sample = 1; sample <= maxSamples; sample += 1) {
        if (options.signal?.aborted) throw new Error("audit aborted");
        clearScratchFindings(sess);
        clearScratchScopeOutcome(sess);
        const dig = await runPhase(digCfg, { mode: "dig", deepFocus, maxSteps: cfg.auditDigSteps }, over);
        if (options.signal?.aborted) throw new Error("audit aborted");
        stepsOut.push(...dig.steps);
        ingestFindingsFromScratch(sess);
        for (const finding of sess.findings) {
          finding.scopeId = scope.id;
          perScope.push(finding);
        }
        const persistedSample = sampleOffset + sample;
        const parsedOutcome = readScratchScopeOutcome(sess, { scopeId: scope.id, sample: persistedSample, ...(cfg.materialFingerprint ? { materialFingerprint: cfg.materialFingerprint } : {}) });
        if (parsedOutcome.errors.length > 0) {
          scopeOutcomeErrors.push({ scopeId: scope.id, sample: persistedSample, errors: parsedOutcome.errors });
          await logger.event("audit_scope_outcome_invalid", { scope: scope.id, sample: persistedSample, errors: parsedOutcome.errors });
        }
        perScopeOutcomes.push(parsedOutcome.outcome ?? incompleteScopeOutcome(scope.id, persistedSample, parsedOutcome.errors.join("; ") || "scope outcome missing", cfg.materialFingerprint));
        await logger.event("audit_dig_sample", {
          scope: scope.id,
          sample: persistedSample,
          runSample: sample,
          minimum: samples,
          maximum: maxSamples,
          findings: sess.findings.length,
          coverageComplete: perScopeOutcomes.at(-1)?.coverageComplete ?? false,
        });
        if (sample >= samples && (!cfg.auditAdaptiveDig || sample >= maxSamples || !scopeOutcomeNeedsAnotherSample(perScopeOutcomes))) break;
      }
      return { findings: dedupeFindings(perScope), outcomes: perScopeOutcomes, steps: stepsOut };
    };

    if (concurrency > 1) {
      // Concurrent dig: each scope runs in its OWN isolated workspace + session +
      // differential confirmation, so parallel digs cannot corrupt each other's
      // test files, build output, or findings. A bounded pool caps simultaneous digs.
      // Schedule in small batches until the requested number of scopes reaches
      // coverage-complete. An incomplete attempt remains pending and must not consume
      // one of the run's audited-scope slots.
      const workspaceRoots = cfg.buildRoot ? [cfg.buildRoot] : cfg.sourcePaths;
      const digScope = async (scope: AuditScope): Promise<{ findings: AgentFinding[]; outcomes: ScopeOutcome[]; steps: TranscriptStep[]; commandRuns: typeof session.commandRuns; scratchFiles: Array<[string, string]>; resourceRequests: ResourceRequest[] }> => {
        scope.status = "auditing"; // mark in-progress so the live UI shows which scope is being dug
        recorder.scopes(scopeInventory);
        const digT0 = Date.now();
        try {
          const ws = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, `audit/dig-${scopeWorkspaceKey(scope.id)}`);
          const digSession = newSession();
          digSession.workspace = ws;
          digSession.baselineFiles = await listWorkspaceFiles(ws.absolute);
          if (session.buildCacheDir) digSession.buildCacheDir = session.buildCacheDir; // shared dep cache; per-dig target/
          await copyCorpusIntoWorkspace(ws, corpus);
          const digCtx: ToolContext = { cfg: digCfg, source, corpus, memory, logger, session: digSession };
          const { findings: unioned, outcomes, steps: digSteps } = await digSamples(scope, digSession, { ctx: digCtx, cwd: ws.absolute, activityStreamId: scope.id });
          for (const finding of unioned) {
            if (finding.confirmationStatus !== "confirmed-executable" || !finding.fixPatch || !finding.commandRunId) continue;
            const exploitRun = digSession.commandRuns.find((run) => run.id === finding.commandRunId);
            if (!exploitRun) continue;
            const dr = await runDifferentialConfirmation({ workspace: ws, finding, exploitRun, baselineFiles: digSession.baselineFiles, cfg: digCfg, logger, ...(digSession.buildCacheDir ? { cacheDir: digSession.buildCacheDir } : {}) });
            if (dr.confirmed) finding.confirmationStatus = "confirmed-differential";
          }
          // Each isolated dig session numbers its command runs cmd1.. independently, so
          // they collide across concurrent scopes. Namespace by scope id and rewrite
          // each finding's commandRunId link so the aggregated audit_command_runs.json
          // keeps every dig's evidence and a confirmed finding's citation still resolves
          // (the differential above already ran with the original, per-session ids).
          const scopedRuns = digSession.commandRuns.map((run) => ({ ...run, id: `${scope.id}:${run.id}` }));
          for (const finding of unioned) {
            if (finding.commandRunId) finding.commandRunId = `${scope.id}:${finding.commandRunId}`;
          }
          const scopedScratchFiles = [...digSession.scratchFiles.entries()].map(([scratchPath, content]) => [`dig-${scopeWorkspaceKey(scope.id)}/${scratchPath}`, content] as [string, string]);
          const completed = coverageCompleted(outcomes);
          // Finishing a model attempt is not the same as completing coverage. An
          // incomplete handoff must remain resumable instead of disappearing from
          // the next run's pending inventory.
          scope.status = completed ? "audited" : "pending";
          scope.digSeconds = Math.max(1, Math.round((Date.now() - digT0) / 1000));
          await logger.event("audit_dig_done", { scope: scope.id, samples, findings: unioned.length, concurrent: true, coverageComplete: completed, digSeconds: scope.digSeconds });
          // Resume checkpoint: only complete coverage is skipped on the next run;
          // incomplete attempts stay pending (their findings still survive below).
          await saveScopeInventory(inventoryDir, scopeInventory, completed ? {} : { forceStatusIds: [scope.id] });
          await appendScopeOutcomes(inventoryDir, outcomes);
          recorder.scopes(scopeInventory);
          recorder.findings(unioned, logger.runDir, "dig checkpoint"); // persist this scope's findings live (content-keyed upsert)
          if (completed) digDone += 1;
          recorder.runScopes(digDone, reportedRunScopesTarget);
          await compactCompletedAuditWorkspace(ws, digSession, logger, "dig", scope.id);
          return { findings: unioned, outcomes, steps: digSteps, commandRuns: scopedRuns, scratchFiles: scopedScratchFiles, resourceRequests: digSession.resourceRequests ?? [] };
        } catch (error) {
          await resetInFlightScope(scope);
          throw error;
        }
      };
      await logger.event("audit_dig_concurrent_start", { scopes: toDig.length, target: reportedRunScopesTarget, concurrency });
      const perScope: Awaited<ReturnType<typeof digScope>>[] = [];
      let cursor = 0;
      while (cursor < toDig.length && digDone < reportedRunScopesTarget) {
        const remaining = reportedRunScopesTarget - digDone;
        const batchSize = Math.min(concurrency, remaining, toDig.length - cursor);
        const batch = toDig.slice(cursor, cursor + batchSize);
        cursor += batchSize;
        perScope.push(...await runWithConcurrency(batch, concurrency, digScope));
      }
      // Merge every dig's findings, transcript steps, and command runs into the run
      // aggregates so the persisted artifacts reflect the concurrent digs, not just
      // the map phase. runWithConcurrency preserves scope order.
      for (const result of perScope) {
        aggregated.push(...result.findings);
        newScopeOutcomes.push(...result.outcomes);
        aggregatedSteps.push(...result.steps);
        session.commandRuns.push(...result.commandRuns);
        for (const [scratchPath, content] of result.scratchFiles) session.scratchFiles.set(scratchPath, content);
        if (result.resourceRequests.length > 0) session.resourceRequests = mergeResourceRequests(session.resourceRequests ?? [], result.resourceRequests);
      }
      digDifferentialDone = true; // each dig confirmed differentially in its own workspace
    } else {
      // Sequential: reuse the shared map workspace (one warm-up) and let the
      // post-loop differential stage confirm.
      for (const scope of toDig) {
        const targetNow = effectiveRunScopesTarget(digDone);
        if (digDone >= targetNow) break;
        if (targetNow !== reportedRunScopesTarget) {
          reportedRunScopesTarget = targetNow;
          recorder.runScopes(digDone, reportedRunScopesTarget);
          await logger.event("audit_dig_target_changed", { done: digDone, target: reportedRunScopesTarget });
        }
        scope.status = "auditing"; // mark in-progress so the live UI shows which scope is being dug
        recorder.scopes(scopeInventory);
        const digT0 = Date.now();
        try {
          const { findings: unioned, outcomes, steps: digSteps } = await digSamples(scope, session);
          aggregatedSteps.push(...digSteps);
          aggregated.push(...unioned);
          newScopeOutcomes.push(...outcomes);
          const completed = coverageCompleted(outcomes);
          scope.status = completed ? "audited" : "pending";
          scope.digSeconds = Math.max(1, Math.round((Date.now() - digT0) / 1000));
          await logger.event("audit_dig_done", { scope: scope.id, samples, findings: unioned.length, coverageComplete: completed, digSeconds: scope.digSeconds });
          // Resume checkpoint: persist coverage status + findings-so-far after each
          // attempt so incomplete coverage remains eligible for a later resume.
          await saveScopeInventory(inventoryDir, scopeInventory, completed ? {} : { forceStatusIds: [scope.id] });
          await appendScopeOutcomes(inventoryDir, outcomes);
          await checkpointFindings();
          recorder.scopes(scopeInventory);
          if (completed) digDone += 1;
          const targetAfter = effectiveRunScopesTarget(digDone);
          if (targetAfter !== reportedRunScopesTarget) {
            reportedRunScopesTarget = targetAfter;
            await logger.event("audit_dig_target_changed", { done: digDone, target: reportedRunScopesTarget });
          }
          recorder.runScopes(digDone, reportedRunScopesTarget);
        } catch (error) {
          await resetInFlightScope(scope);
          throw error;
        }
      }
    }
    // G2 — cross-scope synthesis. Each per-scope dig saw ONE region in isolation, so a bug that
    // exists only in the COMPOSITION of components (an input left unbound in one region that reaches
    // a security-critical sink in another) is invisible to them. Run one sink-driven composition
    // pass over the union of scopes + findings, then fold its chains into the finding set so they go
    // through the same differential/refutation/finalize. General method, no per-target special case.
    scopeOutcomes = mergeScopeOutcomes(scopeOutcomes, newScopeOutcomes);
    await logger.artifact(SCOPE_OUTCOMES_FILE, scopeOutcomes);
    if (scopeOutcomeErrors.length > 0) await logger.artifact("scope_outcome_errors.json", scopeOutcomeErrors);
    const priorSynthesis = cfg.auditSynthesisContext ?? [];
    if (cfg.auditSynthesize !== false && scopeInventory.length > 1 && newScopeOutcomes.length > 0 && !options.signal?.aborted) {
      clearScratchFindings(session);
      await writeSandboxFiles(workspaceCwd, [{ path: SYNTHESIS_SCOPE_OUTCOMES_PATH, content: `${JSON.stringify(scopeOutcomes, null, 2)}\n` }]);
      const synthesisFingerprint = phaseInputFingerprint({ phase: "synthesis", material: cfg.materialFingerprint, prior: priorSynthesis.map(synthesisIdentity), outcomes: newScopeOutcomes });
      await logger.event("audit_synthesis_start", { scopes: scopeInventory.length, findings: aggregated.length, outcomes: scopeOutcomes.length, deltaOutcomes: newScopeOutcomes.length, prior: priorSynthesis.length, inputFingerprint: synthesisFingerprint });
      recorder.stage("synthesis", { scopes: scopeInventory.length, pool: aggregated.length, outcomes: scopeOutcomes.length, deltaOutcomes: newScopeOutcomes.length, prior: priorSynthesis.length, inputFingerprint: synthesisFingerprint, status: "running" });
      const synthPhase = await runPhase(withRole(cfg, "dig"), { mode: "synthesize", synthSeed: buildSynthesisSeed(aggregated, scopeInventory, priorSynthesis, SYNTHESIS_SCOPE_OUTCOMES_PATH), maxSteps: cfg.auditDigSteps });
      aggregatedSteps.push(...synthPhase.steps);
      ingestFindingsFromScratch(session);
      for (const composed of session.findings) aggregated.push(composed);
      const produced = session.findings.length;
      await logger.event("audit_synthesis_done", { produced });
      recorder.findings(aggregated, logger.runDir, "synthesis");
      recorder.stage("synthesis", { scopes: scopeInventory.length, produced, pool: aggregated.length, outcomes: scopeOutcomes.length, deltaOutcomes: newScopeOutcomes.length, prior: priorSynthesis.length, inputFingerprint: synthesisFingerprint, status: "done" }); // funnel: cross-scope chains ADDED
    } else if (cfg.auditSynthesize !== false && scopeInventory.length > 1 && newScopeOutcomes.length === 0) {
      recorder.stage("synthesis", { scopes: scopeInventory.length, pool: aggregated.length, outcomes: scopeOutcomes.length, deltaOutcomes: 0, status: "skipped", reason: "no new scope outcomes" });
      await logger.event("audit_synthesis_skipped", { reason: "no-outcome-delta", outcomes: scopeOutcomes.length, findings: aggregated.length });
    }
    // Each scope/dig session numbered its findings independently (f1, f2, …), so
    // aggregating across scopes collides. Re-id uniquely so every finding gets its
    // own disclosure report and is individually addressable.
    aggregated.forEach((finding, idx) => {
      finding.id = `f${idx + 1}`;
    });
    session.findings = aggregated;
    session.counters.finding = aggregated.length;
    manualFindings = true;
    steps = aggregatedSteps;
    stoppedReason = phaseFailureReason ?? "finished";
    await saveScopeInventory(inventoryDir, scopeInventory);
    await logger.artifact("audit_scopes.json", scopeInventory);
    await logger.event("audit_scope_progress", { ...scopeProgress(scopeInventory), resumed: resuming });
  } else {
    // Single run: breadth (default role) or a pinned deep-focus dig (dig role).
    const pinned = Boolean(cfg.auditDeep && cfg.auditDeepFocus);
    const directScopeId = pinned ? `region-${createHash("sha256").update(cfg.auditDeepFocus ?? "pinned").digest("hex").slice(0, 12)}` : undefined;
    auditMode = pinned ? "dig" : "breadth";
    const result = await runPhase(withRole(cfg, pinned ? "dig" : "default"), {
      mode: pinned ? "dig" : "breadth",
      ...(cfg.auditDeepFocus ? { deepFocus: `scope ${directScopeId}; code region ${cfg.auditDeepFocus}` } : {}),
      maxSteps: cfg.auditMaxSteps,
    });
    steps = result.steps;
    stoppedReason = result.stoppedReason;
    if (pinned && directScopeId) {
      const outcomeHistoryDir = projectHistoryDir(historyLocation(cfg));
      const previousOutcomes = await loadScopeOutcomes(outcomeHistoryDir, cfg.materialFingerprint);
      const sample = nextScopeOutcomeSample(previousOutcomes, directScopeId);
      const parsedOutcome = readScratchScopeOutcome(session, { scopeId: directScopeId, sample, ...(cfg.materialFingerprint ? { materialFingerprint: cfg.materialFingerprint } : {}) });
      if (parsedOutcome.errors.length > 0) scopeOutcomeErrors.push({ scopeId: directScopeId, sample, errors: parsedOutcome.errors });
      newScopeOutcomes = [parsedOutcome.outcome ?? incompleteScopeOutcome(directScopeId, sample, parsedOutcome.errors.join("; ") || "scope outcome missing", cfg.materialFingerprint)];
      scopeOutcomes = mergeScopeOutcomes(previousOutcomes, newScopeOutcomes);
      await appendScopeOutcomes(outcomeHistoryDir, newScopeOutcomes);
      await logger.artifact(SCOPE_OUTCOMES_FILE, scopeOutcomes);
      if (scopeOutcomeErrors.length > 0) await logger.artifact("scope_outcome_errors.json", scopeOutcomeErrors);
    }
  }

  const findingParse = manualFindings ? { parsed: session.findings.length, errors: [] } : ingestFindingsFromScratch(session);
  if (findingParse.errors.length > 0) {
    await logger.artifact("audit_findings_errors.json", findingParse.errors);
    await logger.event("audit_findings_parse_errors", { errors: findingParse.errors.length });
  }

  const discoveryArtifacts = readDiscoveryArtifacts(session);
  let coverageGaps: CoverageGap[] = mergeCoverageGaps([
    ...discoveryArtifacts.coverageGaps,
    ...latestScopeOutcomes(newScopeOutcomes).map((outcome) => {
      const needsCoverage = scopeOutcomeNeedsCoverage(outcome);
      return {
        id: `scope-outcome-${outcome.scopeId}`,
        status: needsCoverage ? "open" as const : "resolved" as const,
        phase: "dig",
        scopeId: outcome.scopeId,
        obligation: `Complete the coverage handoff for ${outcome.scopeId}`,
        reason: needsCoverage
          ? outcome.blockers.join("; ") || "The model did not persist a complete scope outcome."
          : "The latest scope outcome discharged the current coverage handoff.",
        ...(needsCoverage ? { nextAction: "Re-audit this scope after resolving any named blocker." } : {}),
      };
    }),
  ]);
  let resourceRequests: ResourceRequest[] = mergeResourceRequests(discoveryArtifacts.resourceRequests, session.resourceRequests ?? []);
  let followupScopes: AuditScope[] = discoveryArtifacts.followupScopes;
  if (followupScopes.length > 0) {
    const merged = mergeFollowupScopes(scopeInventory, followupScopes);
    scopeInventory = merged.scopes;
    stampScopeInventory(scopeInventory, cfg.materialFingerprint);
    if (merged.added > 0) {
      const inventoryDir = projectHistoryDir(historyLocation(cfg));
      await saveScopeInventory(inventoryDir, scopeInventory);
      recorder.scopes(scopeInventory);
      await logger.event("audit_followup_scopes_added", { proposed: followupScopes.length, added: merged.added });
    }
  }
  if (coverageGaps.length > 0) {
    await logger.artifact(COVERAGE_GAPS_FILE, coverageGaps);
    recorder.stage("coverage-gaps", { open: coverageGaps.filter((gap) => gap.status !== "resolved").length, total: coverageGaps.length });
  }
  if (resourceRequests.length > 0) {
    await logger.artifact(RESOURCE_REQUESTS_FILE, resourceRequests);
    recorder.stage("resource-requests", { open: resourceRequests.filter((request) => request.status !== "resolved").length, total: resourceRequests.length });
  }
  if (followupScopes.length > 0) {
    await logger.artifact(FOLLOWUP_SCOPES_FILE, followupScopes);
    recorder.stage("followup-scopes", { proposed: followupScopes.length, pending: followupScopes.length });
  }

  // Differential confirmation: for confirmed-executable findings that declared a
  // machine-applicable fix, apply it to the pristine target source and re-run the
  // same exploit test. A real bug's test is blocked by its fix; a tautology is
  // not. Survivors reach the strongest status, confirmed-differential.
  if (session.workspace && session.baselineFiles && !digDifferentialDone) {
    const differentials: DifferentialResult[] = [];
    for (const finding of session.findings) {
      if (!isExecutionConfirmedFinding(finding) || finding.confirmationStatus !== "confirmed-executable" || !finding.fixPatch || !finding.commandRunId) continue;
      const exploitRun = session.commandRuns.find((run) => run.id === finding.commandRunId);
      if (!exploitRun) continue;
      options.onActivity?.({ kind: "step", tool: `differential ${finding.id}` }); // surface the post-dig stage in Live Activity
      const result = await runDifferentialConfirmation({ workspace: session.workspace, finding, exploitRun, baselineFiles: session.baselineFiles, cfg, logger, ...(session.buildCacheDir ? { cacheDir: session.buildCacheDir } : {}) });
      differentials.push(result);
      if (result.confirmed) finding.confirmationStatus = "confirmed-differential";
    }
    if (differentials.length > 0) await logger.artifact("audit_differential.json", differentials);
    recorder.findings(session.findings, logger.runDir, "differential"); // push status upgrades (confirmed-differential) to the UI live
    if (differentials.length > 0) recorder.stage("differential", { tested: differentials.length, confirmed: differentials.filter((d) => d.confirmed).length }); // funnel: executable→differential
  }

  // Independent refutation: a fresh-context skeptic re-derives the invariant and
  // tries to break each confirmed finding. A single-test confirmation it debunks
  // is downgraded to a hypothesis; an execution-proven (differential) finding it
  // disputes is kept but flagged for humans (execution is ground truth).
  if (cfg.auditRefute) {
    const candidates = session.findings.filter(isExecutionConfirmedFinding);
    if (candidates.length > 0) {
      const refuteCfg = withRole(cfg, "refute");
      // Session-only providers (e.g. openai-codex via OAuth) have no API key, so the
      // pi-ai complete() path errors out. Route refutation through an AgentSession,
      // the same authenticated mechanism the dig uses, so the skeptic actually runs.
      const refuteLlm = options.llm ?? (isPiSessionProvider(refuteCfg.provider) ? new SessionLlmClient(refuteCfg, logger) : createLlmClient(refuteCfg, logger));
      // Give the skeptic the PoC/scratch test files so it can audit the
      // confirmation's TRUST ASSUMPTIONS (e.g. an out-of-spec mocked verifier that
      // makes a vacuous "confirmation"), not just re-derive the invariant.
      const pocFiles = [...session.scratchFiles.entries()]
        .filter(([scratchPath]) => /\.t\.(sol|rs|ts|js)$/i.test(scratchPath) || /(^|\/)tests?\//i.test(scratchPath) || /(poc|exploit)/i.test(scratchPath))
        .map(([scratchPath, content]) => ({ path: scratchPath, content }));
      for (const finding of candidates) {
        finding.refutationStatus = "running";
        delete finding.refutationReason;
      }
      recorder.findings(session.findings, logger.runDir, "refutation running");
      const refutation = { attempted: 0, verdicts: [] as RefutationVerdict[], errors: [] as RefutationError[] };
      // Bound each model batch for context/transport safety, but cover every
      // confirmed candidate. No finding silently escapes independent review.
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const chunk = candidates.slice(offset, offset + 8);
        const result = await runRefutation({ findings: chunk, source, cfg: refuteCfg, llm: refuteLlm, logger, max: chunk.length, onProgress: (id) => options.onActivity?.({ kind: "step", tool: `refute ${id}` }), ...(pocFiles.length > 0 ? { pocFiles } : {}) });
        refutation.attempted += result.attempted;
        refutation.verdicts.push(...result.verdicts);
        refutation.errors.push(...result.errors);
        const errorsById = new Map(result.errors.map((error) => [error.findingId, error.error]));
        for (const finding of chunk) {
          const error = errorsById.get(finding.id);
          if (error) {
            finding.refutationStatus = "blocked";
            finding.refutationReason = error;
          } else if (finding.refutation) {
            finding.refutationStatus = finding.refutation.refuted ? "refuted" : "passed";
            finding.refutationReason = finding.refutation.reason;
          } else {
            finding.refutationStatus = "blocked";
            finding.refutationReason = "independent reviewer returned no structured verdict";
            refutation.errors.push({ findingId: finding.id, error: finding.refutationReason });
          }
        }
        recorder.findings(session.findings, logger.runDir, `refutation ${Math.min(offset + chunk.length, candidates.length)}/${candidates.length}`);
      }
      refutationErrors.push(...refutation.errors.map((error) => ({ phase: "refutation" as const, ...error })));
      for (const finding of candidates) {
        if (!finding.refutation?.refuted) continue;
        if (finding.refutation.unrealistic) {
          // Vacuous confirmation: the PoC only triggers under an out-of-spec trusted
          // component, so the exploit is NOT reachable in the deployed system.
          // Execution is ground truth only for a realistic scenario — downgrade even
          // a confirmed-differential to a (disputed) hypothesis.
          finding.confirmationStatus = "suspected";
          finding.disputed = true;
        } else if (finding.confirmationStatus === "confirmed-executable") {
          finding.confirmationStatus = "suspected";
        } else if (finding.confirmationStatus === "confirmed-differential") {
          finding.disputed = true;
        }
      }
      if (refutation.verdicts.length > 0) await logger.artifact("audit_refutation.json", refutation.verdicts);

      // Appeal: a finding the skeptic rejected as UNREALISTIC gets ONE chance to
      // answer the objection with a faithful PoC. A real bug whose first PoC was
      // merely unfaithful survives; a vacuous one cannot. The original confirmation,
      // the refutation, and the appeal outcome are all kept (finding.appeal) so a
      // wrong refutation is recoverable, never silently lost.
      if (cfg.auditAppeal !== false) {
        const appealCfg = withRole(cfg, "dig");
        for (const finding of candidates) {
          if (!finding.refutation?.refuted || !finding.refutation.unrealistic) continue;
          const critique = finding.refutation.reason;
          // Run the appeal in isolation: snapshot the real finding set, let the verify
          // session produce its own, then restore so only the original finding is updated.
          const mainFindings = session.findings;
          const mainCount = session.counters.finding;
          clearScratchFindings(session);
          session.findings = [];
          await runPhase(appealCfg, { mode: "verify", verifySeed: buildAppealSeed(finding, critique), maxSteps: cfg.auditDigSteps });
          ingestFindingsFromScratch(session);
          const appealOut = session.findings;
          session.findings = mainFindings;
          session.counters.finding = mainCount;
          const reConfirmed = appealOut.find(isExecutionConfirmedFinding);
          let upheld = false;
          if (reConfirmed) {
            // Re-judge the NEW PoC by the same skeptic standard. Survives → real bug recovered.
            const appealPocFiles = [...session.scratchFiles.entries()]
              .filter(([scratchPath]) => /\.t\.(sol|rs|ts|js)$/i.test(scratchPath) || /(^|\/)tests?\//i.test(scratchPath) || /(poc|exploit)/i.test(scratchPath))
              .map(([scratchPath, content]) => ({ path: scratchPath, content }));
            const appealRefutation = await runRefutation({ findings: [reConfirmed], source, cfg: refuteCfg, llm: refuteLlm, logger, max: 1, ...(appealPocFiles.length > 0 ? { pocFiles: appealPocFiles } : {}) });
            refutationErrors.push(...appealRefutation.errors.map((error) => ({ phase: "appeal-refutation" as const, ...error })));
            upheld = appealRefutation.errors.length === 0 && !(reConfirmed.refutation?.refuted && reConfirmed.refutation.unrealistic);
            if (upheld) {
              finding.confirmationStatus = reConfirmed.confirmationStatus;
              if (reConfirmed.commandRunId) finding.commandRunId = reConfirmed.commandRunId;
              if (reConfirmed.fixPatch) finding.fixPatch = reConfirmed.fixPatch;
              finding.disputed = false;
              finding.refutationStatus = "passed";
              finding.refutationReason = "appeal rebuilt a faithful PoC that survived independent review";
            }
          }
          finding.appeal = {
            attempted: true,
            upheld,
            reason: upheld
              ? "rebuilt a faithful PoC that survived re-refutation"
              : refutationErrors.some((error) => error.phase === "appeal-refutation" && error.findingId === reConfirmed?.id)
                ? "appeal re-refutation did not produce a verdict"
                : reConfirmed?.refutation?.reason ?? "no faithful PoC produced on appeal",
          };
          await logger.event("audit_appeal", { findingId: finding.id, upheld });
          recorder.findings(session.findings, logger.runDir, "appeal"); // reflect this finding's appeal outcome live
        }
        clearScratchFindings(session);
      }
      recorder.stage("refutation", {
        candidates: candidates.length,
        attempted: refutation.attempted,
        verdicts: refutation.verdicts.length,
        errors: refutation.errors.length,
        refuted: candidates.filter((f) => f.refutation?.refuted).length, // funnel: confirmations the skeptic broke
        disputed: candidates.filter((f) => f.disputed).length, // execution-proven but flagged for humans
      });
      if (refutationErrors.length > 0) await logger.artifact("audit_refutation_errors.json", refutationErrors);
    }
    recorder.findings(session.findings, logger.runDir, "refutation"); // push refutation downgrades (suspected/refuted) to the UI
  }

  // Discharge challenge (the false-negative guard, symmetric to the refutation skeptic above): the
  // dig records many obligations as DISCHARGED, and a wrong discharge is otherwise a silent miss
  // with no review. An independent skeptic re-examines the highest-stakes discharges and tries to
  // BREAK each; an UNSOUND discharge is RE-OPENED as a suspected candidate (high severity) so it
  // flows on to verify like any other suspicion. General method — it challenges the discharge
  // reasoning, never a specific bug shape.
  if (cfg.auditChallengeDischarges !== false && !options.signal?.aborted) {
    const sevRank = (s: string | undefined): number => ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>)[s ?? "info"] ?? 4;
    const legacyDischarged = session.findings.filter((f) => f.confirmationStatus === "discharged");
    // Challenge only outcomes produced by THIS run. Persisted outcomes were already
    // challenged when their scopes were audited; replaying the whole project on every
    // one-scope continuation multiplies model work and can reopen unrelated historical
    // obligations with no new evidence.
    const challengeOutcomes = dischargeChallengeScopeOutcomes(scopeOutcomes, newScopeOutcomes);
    const outcomeDischarged = challengeOutcomes.flatMap((outcome) => {
      const scope = scopeInventory.find((candidate) => candidate.id === outcome.scopeId);
      const severity = severityFromExposure(scope?.exposure);
      return outcome.obligations
        .filter((obligation) => obligation.status === "discharged")
        .map((obligation): AgentFinding => ({
          id: `discharge:${outcome.scopeId}:${obligation.id}`,
          title: `DISCHARGED: ${obligation.statement}`,
          severity,
          location: obligation.location ?? scope?.region ?? "unknown",
          description: obligation.evidence ?? "The scope outcome declared this obligation discharged without additional evidence text.",
          evidence: obligation.evidence ?? obligation.location ?? scope?.region ?? "",
          exploitSketch: "",
          fix: "",
          confidence: obligation.confidence ?? 0.5,
          confirmationStatus: "discharged",
          scopeId: outcome.scopeId,
        }));
    });
    const outcomeById = new Map(outcomeDischarged.map((finding) => [finding.id, finding]));
    const discharged = [...legacyDischarged, ...outcomeDischarged].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    if (discharged.length > 0) {
      const challengeCfg = withRole(cfg, "refute");
      const challengeLlm = options.llm ?? (isPiSessionProvider(challengeCfg.provider) ? new SessionLlmClient(challengeCfg, logger) : createLlmClient(challengeCfg, logger));
      await logger.event("audit_discharge_challenge_start", {
        discharged: discharged.length,
        runOutcomes: challengeOutcomes.length,
        persistedOutcomes: latestScopeOutcomes(scopeOutcomes).length,
      });
      const verdicts = await runDischargeChallenge({ findings: discharged, source, cfg: challengeCfg, llm: challengeLlm, logger, max: cfg.auditChallengeMax ?? 12, onProgress: (id) => options.onActivity?.({ kind: "step", tool: `challenge ${id}` }) });
      let overturned = 0;
      for (const v of verdicts) {
        if (!v.unsound) continue;
        let finding = session.findings.find((x) => x.id === v.findingId);
        if (!finding) {
          const dischargedOutcome = outcomeById.get(v.findingId);
          if (!dischargedOutcome) continue;
          finding = { ...dischargedOutcome, id: `f${session.findings.length + 1}` };
          session.findings.push(finding);
        }
        finding.confirmationStatus = "suspected"; // no longer "safe" — re-open as a real lead (flows to verify)
        finding.title = "DISCHARGE OVERTURNED: " + dischargeChallengeFindingTitle(v, finding.title);
        finding.description = `An independent discharge-skeptic overturned this discharge — the cited enforcement does not clear the obligation end-to-end. Missed case: ${v.gap || v.reason}\n\n[original discharge reasoning] ${finding.description || ""}`.slice(0, 4000);
        if (sevRank(finding.severity) > 1) finding.severity = "high"; // a real missed obligation is not info-level
        overturned += 1;
      }
      if (verdicts.length > 0) await logger.artifact("audit_discharge_challenge.json", verdicts);
      await logger.event("audit_discharge_challenge_done", { challenged: verdicts.length, overturned });
      if (overturned > 0) recorder.findings(session.findings, logger.runDir, "discharge-challenge");
      recorder.stage("discharge-challenge", { discharged: discharged.length, challenged: verdicts.length, overturned }); // funnel: re-opened misses ADDED
    }
  }

  // Hard artifact semantics: only an execution-confirmed candidate is a finding.
  // Unresolved leads are hypotheses; explicit false-positive verdicts are terminal
  // refutations. Neither gets a disclosure report or counts as a vulnerability.
  const confirmed = session.findings.filter(isExecutionConfirmedFinding);
  const refuted = session.findings.filter((finding) => isRefutedFindingTitle(finding.title));
  const hypotheses = session.findings.filter((finding) => !isExecutionConfirmedFinding(finding) && !isRefutedFindingTitle(finding.title));
  // Keep terminal refutations in the historical hypotheses artifact for backwards
  // compatibility, while summary/report/run-health semantics distinguish them from
  // unresolved leads that still need work.
  const nonFindings = [...hypotheses, ...refuted];
  const runHealth: RunHealth = buildRunHealth({
    stoppedReason,
    steps,
    commandRuns: session.commandRuns,
    scopes: scopeInventory,
    confirmed,
    hypotheses,
    coverageGaps,
    resourceRequests,
    followupScopes,
    scopeOutcomes,
    findingParseErrors: findingParse.errors.length,
    infraErrors: refutationErrors.length,
    mode: auditMode,
  });
  await logger.artifact(RUN_HEALTH_FILE, runHealth);
  recorder.stage("run-health", { status: runHealth.status, ...runHealth.signals });
  recorder.health?.(runHealth);
  recorder.backlog?.(toDiscoveryBacklogRows({ coverageGaps, resourceRequests, followupScopes }));

  await logger.artifact("audit_transcript.json", { stoppedReason, steps });
  await logger.artifact("audit_findings.json", confirmed);
  await logger.artifact("audit_hypotheses.json", nonFindings);
  await logger.artifact("audit_command_runs.json", session.commandRuns);
  if (scopeInventory.length > 0) await logger.artifact("audit_scopes.json", scopeInventory);

  const summary = buildSummary(confirmed, hypotheses, refuted, steps);
  await logger.artifact("summary.json", summary);

  for (const finding of summary.findings) {
    await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding));
  }

  // One consolidated, human-readable results file so collecting a run's output is
  // "read this one file" — confirmed findings (with scope, location, exploit, fix),
  // suspected hypotheses, and the scope-coverage map, aggregated across all digs
  // (including concurrent ones).
  await logger.artifact(
    "audit_report.md",
    renderRunReport({
      target: cfg.targetName,
      provider: cfg.provider,
      model: cfg.auditModel,
      confirmed,
      hypotheses,
      refuted,
      scopes: scopeInventory,
      reportName: reportArtifactName,
      coverageGaps,
      resourceRequests,
      followupScopes,
      runHealth,
    }),
  );

  await nonFatalAuditMaintenance(logger, "finding_memory", () => persistFindingMemory(memory, confirmed, nonFindings, cfg.materialFingerprint, resourceRequests));

  await logger.event("audit_done", {
    stoppedReason,
    steps: steps.length,
    findings: confirmed.length,
    hypotheses: hypotheses.length,
    refuted: refuted.length,
    confirmedExecutable: confirmed.length,
    commandRuns: session.commandRuns.length,
    runHealth: runHealth.status,
    coverageGaps: coverageGaps.length,
    resourceRequests: resourceRequests.length,
    followupScopes: followupScopes.length,
    finishSummary: session.finishSummary ?? "",
  });
  await nonFatalAuditMaintenance(logger, "last_run_pointer_finish", () => writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName));

  const history = await nonFatalAuditMaintenance(logger, "project_history", () => updateProjectHistory({
    cfg,
    runDir: logger.runDir,
    summary,
    items: [],
    results: [],
    completedRounds: 1,
    startedAt: startedAt.toISOString(),
  }));
  if (history) {
    await logger.event("project_history_updated", {
      target: cfg.targetName,
      runs: history.aggregate.totalRuns,
      materials: history.aggregate.materialsTotal,
      manifest: publicPath(projectHistoryManifestPath(historyLocation(cfg))),
    });
  }

  // SQLite tracking: final scope coverage, all findings (with their end-of-run status,
  // recorded on the timeline), and the run marked done.
  const finalCoverage = scopeInventory.length > 0 ? scopeProgress(scopeInventory) : undefined;
  if (!cfg.auditVerify) recorder.scopes(scopeInventory);
  recorder.findings(session.findings, logger.runDir, "run finalize");
  const finalStatus = options.signal?.aborted ? "killed" : stoppedReason === "error" || stoppedReason === "stalled" ? "error" : "done";
  recorder.finish(finalStatus, finalCoverage, confirmed.length);

  return {
    runDir: logger.runDir,
    summary,
    ...(finalCoverage ? { scopeCoverage: finalCoverage } : {}),
  };
}

export function verifyBatchStoppedReason(
  phaseFailureReason: string | undefined,
  settledVerdicts: number,
  totalClaims: number,
): string {
  // A provider transport may close after the model has already persisted a valid
  // terminal verdict. Durable verdicts are the Verify completion contract; only a
  // claim without one remains blocked by the transport failure.
  if (totalClaims > 0 && settledVerdicts === totalClaims) return "finished";
  return phaseFailureReason ?? "finished";
}

export function dischargeChallengeFindingTitle(verdict: { title?: string }, fallback: string): string {
  const mechanism = (verdict.title ?? "").replace(/^\s*(?:DISCHARGE\s+OVERTURNED|DISCHARGED)\s*:\s*/i, "").replace(/\s+/g, " ").trim();
  if (mechanism) return mechanism.slice(0, 240);
  return (fallback || "Discharged obligation is unsound").replace(/^(obligation\s+)?discharged:?\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 240);
}

export function dischargeChallengeScopeOutcomes(_persistedOutcomes: ScopeOutcome[], runOutcomes: ScopeOutcome[]): ScopeOutcome[] {
  return latestScopeOutcomes(runOutcomes);
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

function renderRunReport(input: {
  target: string;
  provider: string;
  model: string;
  confirmed: AgentFinding[];
  hypotheses: AgentFinding[];
  refuted: AgentFinding[];
  scopes: AuditScope[];
  reportName: (id: string) => string;
  coverageGaps?: CoverageGap[];
  resourceRequests?: ResourceRequest[];
  followupScopes?: AuditScope[];
  runHealth?: RunHealth;
}): string {
  const clip = (text: string | undefined, max: number): string => {
    const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  };
  const bySeverity = (a: AgentFinding, b: AgentFinding): number =>
    (SEVERITY_ORDER.indexOf(a.severity) + 1 || 99) - (SEVERITY_ORDER.indexOf(b.severity) + 1 || 99);
  const sevCounts = (findings: AgentFinding[]): string =>
    SEVERITY_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const)
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `${sev}: ${n}`)
      .join(", ");

  const audited = input.scopes.filter((scope) => scope.status === "audited").length;
  const out: string[] = [];
  out.push(`# Audit results: ${input.target}`, "");
  out.push(`- Provider / model: ${input.provider} / ${input.model}`);
  out.push(`- Confirmed findings: ${input.confirmed.length}${input.confirmed.length ? ` (${sevCounts(input.confirmed)})` : ""}`);
  out.push(`- Hypotheses (suspected, unconfirmed): ${input.hypotheses.length}`);
  out.push(`- Refuted claims (terminal): ${input.refuted.length}`);
  if (input.runHealth) out.push(`- Run health: ${input.runHealth.status} — ${input.runHealth.reasons.join("; ")}`);
  if (input.scopes.length > 0) {
    const pending = input.scopes.length - audited;
    out.push(`- Scope coverage: audited ${audited} / ${input.scopes.length}${pending > 0 ? `, ${pending} pending (re-run to continue)` : ""}`);
  }
  if ((input.coverageGaps?.length ?? 0) > 0) out.push(`- Coverage gaps: ${input.coverageGaps?.length}`);
  if ((input.resourceRequests?.length ?? 0) > 0) out.push(`- Resource requests: ${input.resourceRequests?.length}`);
  if ((input.followupScopes?.length ?? 0) > 0) out.push(`- Follow-up scopes proposed: ${input.followupScopes?.length}`);
  out.push("");

  out.push(`## Confirmed findings (${input.confirmed.length})`, "");
  if (input.confirmed.length === 0) out.push("_None reached execution-confirmed status this run._", "");
  for (const finding of [...input.confirmed].sort(bySeverity)) {
    out.push(`### [${finding.severity.toUpperCase()}] ${finding.title} — ${finding.confirmationStatus}${finding.disputed ? " — ⚠ DISPUTED by independent refutation" : ""}${finding.appeal?.upheld ? " — recovered on appeal (faithful PoC survived re-refutation)" : ""}`);
    if (finding.scopeId) out.push(`- Scope: \`${finding.scopeId}\``);
    out.push(`- Location: ${finding.location}`);
    if (finding.description) out.push(`- ${clip(finding.description, 700)}`);
    if (finding.exploitSketch) out.push(`- Exploit: ${clip(finding.exploitSketch, 500)}`);
    if (finding.fix) out.push(`- Fix: ${clip(finding.fix, 400)}`);
    out.push(`- Full disclosure: ${input.reportName(finding.id)}`, "");
  }

  if (input.hypotheses.length > 0) {
    out.push(`## Hypotheses — suspected, need a human or a test (${input.hypotheses.length})`, "");
    for (const finding of [...input.hypotheses].sort(bySeverity)) {
      out.push(`- **[${finding.severity.toUpperCase()}]** ${finding.title} — ${finding.location}${finding.scopeId ? ` (scope \`${finding.scopeId}\`)` : ""}${finding.appeal?.attempted ? " — refuted; appeal not upheld" : finding.disputed ? " — ⚠ disputed by refutation" : ""}`);
    }
    out.push("");
  }

  if (input.refuted.length > 0) {
    out.push(`## Refuted claims — terminal, no further verification required (${input.refuted.length})`, "");
    for (const finding of [...input.refuted].sort(bySeverity)) {
      out.push(`- **${finding.title.replace(/^\s*REFUTED\s*:\s*/i, "")}** — ${finding.location}${finding.scopeId ? ` (scope \`${finding.scopeId}\`)` : ""}`);
    }
    out.push("");
  }

  if (input.scopes.length > 0) {
    out.push("## Scope coverage", "");
    for (const scope of [...input.scopes].sort((a, b) => (b.score || 0) - (a.score || 0))) {
      out.push(`- \`${(scope.status ?? "pending").padEnd(8)}\` score ${scope.score} — ${scope.region} — ${clip(scope.obligation, 90)}`);
    }
    out.push("");
  }

  if ((input.coverageGaps?.length ?? 0) > 0 || (input.resourceRequests?.length ?? 0) > 0 || (input.followupScopes?.length ?? 0) > 0) {
    out.push("## Discovery backlog", "");
    for (const gap of input.coverageGaps ?? []) {
      out.push(`- Coverage gap${gap.scopeId ? ` (${gap.scopeId})` : ""}: ${clip(gap.obligation, 120)} — ${clip(gap.reason, 180)}`);
    }
    for (const request of input.resourceRequests ?? []) {
      out.push(`- Resource request [${request.kind}]: ${clip(request.needed, 120)} — ${clip(request.reason, 180)}`);
    }
    for (const scope of input.followupScopes ?? []) {
      out.push(`- Follow-up scope: ${scope.region} — ${clip(scope.obligation, 120)}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function buildSummary(confirmed: AgentFinding[], hypotheses: AgentFinding[], refuted: AgentFinding[], steps: { tool: string }[]): AuditSummary {
  const ranked = confirmed.map(toRankedFinding).sort((a, b) => b.score - a.score);
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of ranked) bySeverity[finding.severity] += 1;
  return {
    coverage: {
      itemsTotal: ranked.length + hypotheses.length + refuted.length,
      itemsWithFinding: ranked.length,
      bySeverity,
      itemsNeedingRetry: 0,
      modelErrorTrials: steps.filter((step) => step.tool === "(model-error)").length,
      parseErrorTrials: steps.filter((step) => step.tool === "(parse-error)").length,
      needsMoreContextTrials: 0,
      verifiedFindings: ranked.length,
      unverifiedFindings: 0,
      hypotheses: hypotheses.length,
      refuted: refuted.length,
    },
    findings: ranked,
  };
}

async function persistFindingMemory(
  memory: ProjectMemory,
  confirmed: AgentFinding[],
  hypotheses: AgentFinding[],
  materialFingerprint: string | undefined,
  resourceRequests: ResourceRequest[],
): Promise<void> {
  for (const finding of confirmed) {
    await memory.remember({
      note: `${finding.title} (${finding.confirmationStatus}) at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: "finding",
      tags: ["audit", finding.severity, finding.confirmationStatus],
      sourceRef: finding.location,
      ...(materialFingerprint ? { materialFingerprint } : {}),
    });
  }
  // Remember hypotheses too, but as notes — a future run starts knowing which
  // leads were explored without treating them as established findings.
  for (const finding of hypotheses) {
    const refuted = isRefutedFindingTitle(finding.title);
    await memory.remember({
      note: `${refuted ? "Refuted lead" : "Unconfirmed hypothesis"}: ${finding.title} at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: refuted ? "dead-end" : "note",
      tags: ["audit", refuted ? "refuted" : "hypothesis", finding.severity],
      sourceRef: finding.location,
      ...(materialFingerprint ? { materialFingerprint } : {}),
    });
  }
  for (const request of resourceRequests) {
    await memory.remember({
      note: `Resource blocker (${request.kind}): ${request.needed}. ${request.reason}${request.unblock ? ` Unblock: ${request.unblock}` : ""}`.slice(0, 600),
      kind: "resource",
      tags: ["audit", "resource", request.kind, request.status],
      ...((request.scopeId ?? request.findingId) ? { sourceRef: request.scopeId ?? request.findingId } : {}),
      ...(materialFingerprint ? { materialFingerprint } : {}),
    });
  }
}

async function nonFatalAuditMaintenance<T>(logger: RunLogger, name: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    await logger.event("audit_maintenance_warning", {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function isConfirmed(status: ConfirmationStatus): boolean {
  return status === "confirmed-executable" || status === "confirmed-differential";
}

/** Artifact/report semantics are stricter than the raw confirmation enum: a
 * passed command attached to `REFUTED:` proves the mitigation, not the bug. */
export function isExecutionConfirmedFinding(finding: AgentFinding): boolean {
  return !isRefutedFindingTitle(finding.title) && isConfirmed(finding.confirmationStatus);
}

/** A failed eager/full-project warm-up is no longer a blocker when the same
 * isolated Verify worker subsequently execution-confirms its primary claim.
 * Model-authored requests remain open because they may ask for stronger or
 * more realistic evidence than the command that produced the verdict. */
export function settleVerifyResourceRequests(
  requests: ResourceRequest[],
  primaryVerdict: AgentFinding | undefined,
): ResourceRequest[] {
  if (!primaryVerdict || !isExecutionConfirmedFinding(primaryVerdict)) return requests;
  return requests.map((request) => request.origin === "framework-prepare" && request.status !== "resolved"
    ? { ...request, status: "resolved" }
    : request);
}

/** Collapse same-claim duplicates from one Verify worker and reject contradictory
 * polarities before any row or phase outcome is persisted. Distinct extra findings
 * remain independent, although the Verify prompt asks the model to stop after one. */
export function normalizeVerifyVerdicts(findings: AgentFinding[]): { findings: AgentFinding[]; conflict: boolean; inputCount: number } {
  const kept = new Map<string, { finding: AgentFinding; polarity: string }>();
  for (const finding of findings) {
    const cleanTitle = finding.title.replace(/^\s*(?:REFUTED|CONFIRMED|DISCHARGED)\s*:\s*/i, "").trim();
    const key = canonicalFindingKey(cleanTitle, finding.location);
    const polarity = isRefutedFindingTitle(finding.title)
      ? "refuted"
      : isExecutionConfirmedFinding(finding)
        ? "confirmed"
        : finding.confirmationStatus;
    const prior = kept.get(key);
    if (!prior) {
      kept.set(key, { finding, polarity });
      continue;
    }
    if (prior.polarity !== polarity) return { findings: [], conflict: true, inputCount: findings.length };
    if (polarity === "confirmed" && finding.confirmationStatus === "confirmed-differential") {
      kept.set(key, { finding, polarity });
    }
  }
  return { findings: [...kept.values()].map((entry) => entry.finding), conflict: false, inputCount: findings.length };
}

// --verify input: a JSON file holding one suspected finding, an array of them, or
// a {findings:[...]} object (so a prior run's audit_findings.json / audit_hypotheses.json
// can be fed directly). Returns the loose finding records to confirm-or-refute.
async function loadFindingsToVerify(filePath: string): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import("node:fs/promises");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`--verify: cannot read or parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).findings)
      ? ((raw as Record<string, unknown>).findings as unknown[])
      : raw && typeof raw === "object"
        ? [raw]
        : [];
  const findings = list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (findings.length === 0) throw new Error(`--verify: no finding objects found in ${filePath}`);
  return findings;
}

/** One durable finding must have at most one stochastic Verify worker per run.
 * Duplicate anonymous leads remain independent, but repeated canonical origin ids
 * are collapsed deterministically so concurrent workers cannot race contradictory
 * verdicts into the same lifecycle row. */
export function dedupeVerifyInputs(findings: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seenOrigins = new Set<number>();
  return findings.filter((finding) => {
    const originId = verifyOriginId(finding);
    if (originId === undefined) return true;
    if (seenOrigins.has(originId)) return false;
    seenOrigins.add(originId);
    return true;
  });
}

function verifyOriginId(finding: Record<string, unknown>): number | undefined {
  return positiveIntegerId(finding.originId ?? finding.origin_id);
}

// Format one suspected finding into the claim text the verify session must
// confirm-or-refute. The auditor's prior reasoning is included as a lead to CHECK,
// explicitly not as ground truth.
function buildVerifySeed(finding: Record<string, unknown>): string {
  const str = (key: string): string => {
    const value = finding[key];
    return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  };
  const lines = [
    `Title: ${str("title")}`,
    `Claimed severity: ${str("severity")}`,
    `Location: ${str("location")}`,
    `Claim / root cause: ${str("description") || str("claim") || str("why")}`,
  ];
  const evidence = str("evidence");
  if (evidence) lines.push(`Suspecting auditor's reasoning (a lead to CHECK, not ground truth): ${evidence.slice(0, 1200)}`);
  const sketch = str("exploit_sketch") || str("exploitSketch");
  if (sketch) lines.push(`Claimed exploit sketch: ${sketch.slice(0, 800)}`);
  const fix = str("fix");
  if (fix) lines.push(`Proposed fix: ${fix.slice(0, 400)}`);
  const fixPatch = finding["fix_patch"] ?? finding["fixPatch"];
  if (fixPatch) lines.push(`Proposed fix_patch: ${JSON.stringify(fixPatch).slice(0, 800)}`);
  return lines.join("\n");
}

// Format the per-scope audit (scopes + findings) into the material the synthesis pass composes
// across components: the scope inventory (candidate sinks / gates / inputs) and the findings
// (especially the suspected unbound-input / missing-constraint ones — exactly the links that may
// complete a cross-scope chain). Compact; leads to CHAIN, not ground truth.
function buildSynthesisSeed(findings: AgentFinding[], scopes: AuditScope[], prior: Array<Record<string, unknown>> = [], scopeOutcomesPath?: string): string {
  const scopeLines = [...scopes]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 50)
    .map((s) => `- [${s.id}] ${s.obligation} @ ${s.region}`)
    .join("\n");
  const rank = (s: string): number => (s === "confirmed-differential" ? 0 : s === "confirmed-executable" ? 1 : s === "suspected" ? 2 : 3);
  const findLines = [...findings]
    .sort((a, b) => rank(a.confirmationStatus) - rank(b.confirmationStatus))
    .slice(0, 80)
    .map((f) => {
      const lead = (f.exploitSketch || f.description || "").replace(/\s+/g, " ").slice(0, 180);
      return `- (${f.confirmationStatus}) ${f.title} @ ${f.location}${lead ? ` — ${lead}` : ""}`;
    })
    .join("\n");
  const priorLines = prior.slice(0, 80).map((finding) => {
    const lead = String(finding.exploit_sketch ?? finding.exploitSketch ?? finding.description ?? "").replace(/\s+/g, " ").slice(0, 180);
    return `- (${String(finding.status ?? finding.confirmationStatus ?? "unknown")}) ${String(finding.title ?? "Untitled")} @ ${String(finding.location ?? "unknown")}${lead ? ` — ${lead}` : ""}`;
  }).join("\n");
  return `FULL MODEL-AUTHORED SCOPE OUTCOMES:
${scopeOutcomesPath ? `Read ${scopeOutcomesPath}. It contains every persisted obligation outcome and composition edge for the current material snapshot. Do not infer a vulnerability from the artifact; use it only to identify cross-scope chains that must still be tested.` : "(not available)"}

SCOPES (compact index only; use the full outcome artifact above for complete coverage):
${scopeLines || "(none)"}

PRIOR CANONICAL FINDINGS (settled in earlier batches; use only for cross-batch composition and duplicate avoidance):
${priorLines || "(none)"}

NEW BATCH FINDINGS (each found in ONE scope in isolation; compose these with each other and with prior findings):
${findLines || "(none)"}`;
}

function mergeCoverageGaps(gaps: CoverageGap[]): CoverageGap[] {
  const out = new Map<string, CoverageGap>();
  for (const gap of gaps) {
    const key = `${gap.scopeId ?? ""}::${gap.region ?? ""}::${gap.obligation}::${gap.reason}`.toLowerCase();
    if (!out.has(key)) out.set(key, gap);
  }
  return [...out.values()];
}

function synthesisIdentity(finding: Record<string, unknown>): string {
  return `${canonicalFindingKey(finding.title, finding.location, finding.canonical_key ?? finding.finding_key)}|${String(finding.status ?? finding.confirmationStatus ?? "")}`;
}

// Seed for the ONE appeal a refuted finding may make. Same claim the verify session
// gets, plus the skeptic's exact objection and an instruction to answer it with a
// FAITHFUL PoC (assume only what the attacker can actually cause), or concede.
function buildAppealSeed(finding: AgentFinding, critique: string): string {
  const base = buildVerifySeed({
    title: finding.title,
    severity: finding.severity,
    location: finding.location,
    description: finding.description,
    evidence: finding.evidence,
    exploit_sketch: finding.exploitSketch,
    fix: finding.fix,
    ...(finding.fixPatch ? { fix_patch: finding.fixPatch } : {}),
  });
  return `${base}

APPEAL: this finding was confirmed by a prior PoC, then an independent skeptic refuted that confirmation as UNREALISTIC with this objection:
"${critique}"

The underlying bug may still be real — the prior PoC may simply have been unfaithful (e.g. it gave a trusted/pinned component blanket success the attacker cannot actually obtain). Answer the objection DIRECTLY: build a NEW PoC whose setup assumes only what an attacker can actually cause in the deployed system, then confirm by execution. If, after genuine effort, the bug truly cannot be triggered without behavior the real system would never exhibit, refute it with a "REFUTED:" finding that explains why.`;
}

function toRankedFinding(finding: AgentFinding): RankedFinding {
  const severityWeight: Record<Severity, number> = { info: 0.2, low: 0.4, medium: 0.6, high: 0.85, critical: 1 };
  const confirmBoost = finding.confirmationStatus === "confirmed-differential" ? 1.5 : finding.confirmationStatus === "confirmed-executable" ? 1.3 : 1;
  const score = round2(severityWeight[finding.severity] * (0.5 + 0.5 * finding.confidence) * confirmBoost);
  return {
    id: finding.id,
    location: finding.location,
    failureMode: "autonomous",
    title: finding.title,
    severity: finding.severity,
    hitRate: 1,
    confidence: finding.confidence,
    score,
    description: finding.description,
    evidence: finding.evidence,
    exploitSketch: finding.exploitSketch,
    fix: finding.fix,
    confirmationStatus: finding.confirmationStatus,
    ...(finding.commandRunId ? { commandRunId: finding.commandRunId } : {}),
    ...(finding.patchedSuccessPatterns ? { patchedSuccessPatterns: finding.patchedSuccessPatterns } : {}),
    ...(isExecutionConfirmedFinding(finding) ? { reproductionStatus: "confirmed-executable" as const } : {}),
    ...(finding.disputed ? { disputed: true } : {}),
    ...(finding.refutation?.refuted ? { refutationReason: finding.refutation.reason } : {}),
    ...(finding.appeal ? { appeal: finding.appeal } : {}),
  };
}

function resolveScopeNote(cfg: AuditorConfig): string {
  const parts: string[] = [];
  const pc = cfg.projectContext;
  if (cfg.auditScopeNote) parts.push(cfg.auditScopeNote);
  if (pc.summary) parts.push(pc.summary);
  // The richer projectContext fields are scaffold-only no longer: an opted-in `--config`
  // profile (off by default) gets its whole threat model — assets, attacker model, and
  // especially TRUST BOUNDARIES — woven into the scope note, not just summary/focus/scope.
  if (pc.criticalAssets?.length) parts.push(`Critical assets: ${pc.criticalAssets.join("; ")}`);
  if (pc.attackerCapabilities?.length) parts.push(`Attacker capabilities: ${pc.attackerCapabilities.join("; ")}`);
  if (pc.trustBoundaries?.length) parts.push(`Trust boundaries: ${pc.trustBoundaries.join("; ")}`);
  if (pc.securityInvariants?.length) parts.push(`Security invariants: ${pc.securityInvariants.join("; ")}`);
  if (pc.focusAreas?.length) parts.push(`Focus areas: ${pc.focusAreas.join("; ")}`);
  if (pc.scenarioGuidance?.length) parts.push(`Scenario guidance: ${pc.scenarioGuidance.join("; ")}`);
  if (pc.outOfScope?.length) parts.push(`Out of scope: ${pc.outOfScope.join("; ")}`);
  return parts.join("\n");
}

// Fallback focus: when no explicit scope note is set, look for a prepare_manifest.json at a source
// root (prepare writes it at the staged workspace root) and derive the in-scope-target focus from
// it — the same note the `run <clue>` pipeline builds, so any map on a prepare workspace focuses.
function deriveScopeNoteFromSource(sourcePaths: string[]): string | undefined {
  for (const sp of sourcePaths) {
    const candidate = sp.endsWith("prepare_manifest.json") ? sp : path.join(sp, "prepare_manifest.json");
    try {
      const note = deriveScopeNote(JSON.parse(readFileSync(candidate, "utf8")));
      if (note) return note;
    } catch {
      /* no manifest at this source root — try the next */
    }
  }
  return undefined;
}

function renderMemoryHint(notes: { kind: string; note: string; sourceRef?: string }[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `- [${note.kind}] ${note.note}${note.sourceRef ? ` (ref: ${note.sourceRef})` : ""}`).join("\n");
}

function renderNextActionsHint(actions: AuditorConfig["auditNextActions"]): string {
  const open = actions.filter((action) => action.kind);
  if (open.length === 0) return "";
  const rows = open.slice(0, 20).map((action, idx) => {
    const id = action.id !== undefined ? `#${action.id}` : `#${idx + 1}`;
    const parts = [
      `${id} ${action.kind}`,
      action.actionability ? `actionability=${action.actionability}` : "",
      action.recommendedAction ? `recommended=${action.recommendedAction}` : "",
      action.scopeId ? `scope=${action.scopeId}` : "",
      action.title ? `title=${action.title}` : "",
      action.summary ? `summary=${action.summary}` : "",
      action.reason ? `reason=${action.reason}` : "",
    ].filter(Boolean);
    return `- ${parts.join("; ")}`;
  }).join("\n");
  return `Project Next Actions (control-plane worklist):
These are open discovery-backlog rows from prior runs. Before opening unrelated fresh coverage, resolve or route them with the available local workflow: continue/dig/append-map for coverage work, retry safe setup for setup work, and ask the operator only for explicit credentials, authorization, or unavailable external resources.
${rows}`;
}

async function loadAppendMapSeedScopes(cfg: AuditorConfig): Promise<AuditScope[]> {
  const out: AuditScope[] = [];
  for (const seedPath of cfg.auditAppendMapSeedPaths) {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as unknown;
    const scopes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { scopes?: unknown }).scopes)
        ? (parsed as { scopes: unknown[] }).scopes
        : undefined;
    if (!scopes) throw new Error(`append-map seed must be a scope array or {scopes}: ${seedPath}`);
    for (const scope of scopes) {
      if (!scope || typeof scope !== "object") continue;
      const candidate = scope as Partial<AuditScope>;
      if (typeof candidate.region !== "string" || typeof candidate.obligation !== "string") continue;
      out.push({
        id: typeof candidate.id === "string" ? candidate.id : `seed-${out.length + 1}`,
        status: candidate.status ?? "pending",
        region: candidate.region,
        obligation: candidate.obligation,
        lenses: Array.isArray(candidate.lenses) ? candidate.lenses : [],
        exposure: typeof candidate.exposure === "string" ? candidate.exposure : "",
        difficulty: typeof candidate.difficulty === "string" ? candidate.difficulty : "",
        score: typeof candidate.score === "number" ? candidate.score : 0,
        why: typeof candidate.why === "string" ? candidate.why : "",
        source: candidate.source ?? "map",
      });
    }
  }
  return out;
}

async function writeAppendMapExistingScopesSeed(scopes: AuditScope[], workspaceCwd: string): Promise<string | undefined> {
  if (scopes.length === 0) return undefined;
  const snapshot = scopes.map((scope) => ({
    id: scope.id,
    status: scope.status ?? "pending",
    region: scope.region,
    obligation: scope.obligation,
    lenses: scope.lenses,
    exposure: scope.exposure,
    difficulty: scope.difficulty,
    score: scope.score,
    why: scope.why,
  }));
  await writeSandboxFiles(workspaceCwd, [{ path: APPEND_MAP_EXISTING_SCOPES_PATH, content: `${JSON.stringify(snapshot, null, 2)}\n` }]);
  return APPEND_MAP_EXISTING_SCOPES_PATH;
}

// Bounded worker pool: run `worker` over `items` with at most `limit` in flight,
// returning results in input order. Used to deep-audit scopes concurrently.
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx] as T, idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

/** Sanitize a scope id without allowing normalization/truncation collisions. */
export function scopeWorkspaceKey(id: string): string {
  const normalized = id.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === id && normalized.length <= 48 && normalized.length > 0) return normalized;
  const prefix = normalized.slice(0, 32) || "scope";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

function mergeResourceRequests(existing: ResourceRequest[], next: ResourceRequest[]): ResourceRequest[] {
  const out = [...existing];
  const seen = new Set(out.map(resourceRequestKey));
  for (const request of next) {
    const key = resourceRequestKey(request);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(request);
  }
  return out;
}

function resourceRequestKey(request: ResourceRequest): string {
  return `${request.kind}::${request.findingId ?? ""}::${request.scopeId ?? ""}::${request.needed}::${request.reason}`.toLowerCase();
}

function renderFileManifest(source: Doc[], corpusEntries: string[] = []): string {
  const lines = source.slice(0, 600).map((doc) => `- ${doc.path} (${doc.content ? doc.content.split("\n").length : 0} lines)`);
  const more = source.length > 600 ? `\n…and ${source.length - 600} more files` : "";
  let out = `${lines.join("\n")}${more}`;
  if (corpusEntries.length > 0) {
    const shown = corpusEntries.slice(0, 200).map((entry) => `- ${entry}`);
    const moreCorpus = corpusEntries.length > 200 ? `\n…and ${corpusEntries.length - 200} more` : "";
    out += `\n\nReference material (specs, papers, books) under corpus/:\n${shown.join("\n")}${moreCorpus}`;
  }
  return out;
}

async function copyCorpusIntoWorkspace(workspace: SandboxWorkspace, corpus: Doc[]): Promise<string[]> {
  if (corpus.length === 0) return [];
  const seen = new Set<string>();
  const files = corpus.map((doc, index) => {
    const safe = normalizeRelativePath(doc.path) ?? `doc-${index}`;
    let rel = `corpus/${safe}`;
    while (seen.has(rel)) rel = `corpus/${index}-${safe}`;
    seen.add(rel);
    return { path: rel, content: doc.content };
  });
  await writeSandboxFiles(workspace.absolute, files);
  return files.map((file) => file.path);
}

async function compactCompletedAuditWorkspace(
  workspace: SandboxWorkspace,
  auditSession: Pick<AgentSession, "baselineFiles" | "scratchFiles">,
  logger: RunLogger,
  phase: "verify" | "dig",
  label: string,
): Promise<void> {
  if (!auditSession.baselineFiles) return;
  try {
    const result = await compactSandboxWorkspace(workspace.absolute, auditSession.baselineFiles, auditSession.scratchFiles);
    await logger.event("audit_workspace_compacted", { phase, label, ...result });
  } catch (error) {
    await logger.event("audit_workspace_compaction_failed", {
      phase,
      label,
      errorCode: (error as NodeJS.ErrnoException).code ?? "unknown",
    });
  }
}

function historyLocation(cfg: AuditorConfig): { outputDir: string; targetName: string; historyDir?: string } {
  return {
    outputDir: cfg.outputDir,
    targetName: cfg.targetName,
    ...(cfg.historyDir ? { historyDir: cfg.historyDir } : {}),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function stampScopeInventory(scopes: AuditScope[], materialFingerprint: string | undefined): void {
  if (!materialFingerprint) return;
  for (const scope of scopes) scope.materialFingerprint = materialFingerprint;
}

async function clearCurrentMaterialScopeOutcomes(historyDir: string, materialFingerprint: string | undefined): Promise<void> {
  const stored = await loadScopeOutcomes(historyDir);
  const retained = stored.filter((outcome) => materialFingerprint
    ? outcome.materialFingerprint !== materialFingerprint
    : outcome.materialFingerprint !== undefined);
  if (retained.length !== stored.length) await saveScopeOutcomes(historyDir, retained);
}

export function unionMapSamples(sampleMaps: AuditScope[][]): AuditScope[] {
  const out: AuditScope[] = [];
  const byShape = new Map<string, AuditScope>();
  const ids = new Set<string>();
  for (const [sampleIndex, scopes] of sampleMaps.entries()) {
    const sample = sampleIndex + 1;
    for (const scope of scopes) {
      const shape = `${scope.region.toLowerCase().replace(/\s+/g, " ").trim()}::${scope.obligation.toLowerCase().replace(/\s+/g, " ").trim()}`;
      const current = byShape.get(shape);
      if (current) {
        current.mapSamples = [...new Set([...(current.mapSamples ?? []), sample])].sort((a, b) => a - b);
        current.mapAgreement = current.mapSamples.length;
        current.score = Math.max(current.score, scope.score);
        continue;
      }
      let id = scope.id.trim() || `S${out.length + 1}`;
      if (ids.has(id.toLowerCase())) {
        const prefix = id.replace(/\d+$/, "") || "S";
        let suffix = 1;
        while (ids.has(`${prefix}${suffix}`.toLowerCase())) suffix += 1;
        id = `${prefix}${suffix}`;
      }
      ids.add(id.toLowerCase());
      const mapped = { ...scope, id, mapSamples: [sample], mapAgreement: 1 };
      byShape.set(shape, mapped);
      out.push(mapped);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function severityFromExposure(exposure: string | undefined): Severity {
  const value = (exposure ?? "").toLowerCase();
  if (value === "critical") return "critical";
  if (value === "high") return "high";
  if (value === "low") return "low";
  return "medium";
}
