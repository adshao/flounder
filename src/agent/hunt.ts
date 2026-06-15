import path from "node:path";
import { withRole, type AuditorConfig } from "../config.js";
import { loadCorpus, loadSource } from "../ingest/source.js";
import { createLlmClient } from "../llm/client.js";
import { renderDisclosure, reportArtifactName } from "../reports/disclosure.js";
import { projectHistoryDir, projectHistoryManifestPath, updateProjectHistory } from "../trace/history.js";
import { writeLastRunPointer } from "../trace/last-run.js";
import { RunLogger } from "../trace/logger.js";
import type { AuditSummary, ConfirmationStatus, Doc, LlmClient, RankedFinding, Severity } from "../types.js";
import { publicPath } from "../util/paths.js";
import { listWorkspaceFiles, normalizeRelativePath, prepareSandboxWorkspace, writeSandboxFiles, type SandboxWorkspace } from "../security/sandbox.js";
import { runDifferentialConfirmation, type DifferentialResult } from "./differential.js";
import { runRefutation } from "./refutation.js";
import { runHuntLoop } from "./loop.js";
import { ProjectMemory } from "./memory.js";
import { loadScopeInventory, saveScopeInventory, scopeProgress } from "./scope-store.js";
import { isPiSessionProvider, runHuntSession } from "./pi-session.js";
import type { TranscriptStep } from "./prompts.js";
import { buildTools, clearScratchFindings, dedupeFindings, ingestFindingsFromScratch, newSession, readScratchScopes, type AgentFinding, type AgentSession, type AuditScope, type ToolContext } from "./tools.js";

// Orchestrates one autonomous hunt: load authorized material, give the model the
// capability surface, run the ReAct loop, then turn whatever it proved into the
// same finding/summary/report/history artifacts the rest of the toolchain uses.
// All discrimination about *what* is a bug comes from the model; this function
// only wires capability, persistence, and reporting around it.

export interface HuntResult {
  runDir: string;
  summary: AuditSummary;
  /** Scope-inventory coverage for the resumable map → dig flow (omitted otherwise). */
  scopeCoverage?: { total: number; audited: number; pending: number };
}

export async function runHunt(
  cfg: AuditorConfig,
  options: { llm?: LlmClient; streamEvents?: boolean } = {},
): Promise<HuntResult> {
  const startedAt = new Date();
  const logger = new RunLogger(cfg.outputDir, cfg.targetName, startedAt, { streamEvents: options.streamEvents ?? false });
  await logger.init();
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const source = await loadSource(cfg.sourcePaths);
  const corpus = await loadCorpus(cfg.corpusPaths);
  await logger.event("hunt_start", {
    target: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => publicPath(sourcePath)),
    corpusPaths: cfg.corpusPaths.map((corpusPath) => publicPath(corpusPath)),
    provider: cfg.provider,
    model: cfg.auditModel,
    maxSteps: cfg.huntMaxSteps,
    sourceDocs: source.length,
    corpusDocs: corpus.length,
  });

  if (source.length === 0) throw new Error("hunt requires at least one source file (use --source)");

  const memory = new ProjectMemory(path.join(projectHistoryDir(historyLocation(cfg)), "memory.jsonl"));
  const session = newSession();
  const tools = buildTools();
  const ctx: ToolContext = { cfg, source, corpus, memory, logger, session };

  // Create the shared isolated workspace up front. It is the sandbox for tools
  // and the cwd for the agent session. The toolchain warm-up is lazy (run by the
  // bash tool on the first test command) so read-only or unauthenticated runs do
  // not pay for it.
  let workspaceCwd = process.cwd();
  const corpusManifest: string[] = [];
  if (cfg.sourcePaths.length > 0) {
    // The sandbox copies the build root (a buildable project, e.g. a workspace
    // root) when one is set, so a narrow audit scope can still compile; otherwise
    // it copies the audited source. The model still reads only `sourcePaths`.
    const workspaceRoots = cfg.buildRoot ? [cfg.buildRoot] : cfg.sourcePaths;
    const workspace = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, "hunt/workspace");
    session.workspace = workspace;
    workspaceCwd = workspace.absolute;
    // Persistent, host-isolated package cache so dependency builds are downloaded
    // once and reused across runs (HOME stays the per-run workspace).
    session.buildCacheDir = path.join(projectHistoryDir(historyLocation(cfg)), "build-cache");
    // Capture the pristine target source before anything else touches the
    // workspace, so the model cannot modify the code it is auditing — a
    // confirmation must run against untampered source.
    session.baselineFiles = await listWorkspaceFiles(workspace.absolute);
    // Make corpus (specs, papers, books) visible to the agent: copy it into the
    // workspace so the model can read/grep it, and list it in the manifest. This
    // reference material is often what makes a subtle bug discoverable.
    corpusManifest.push(...(await copyCorpusIntoWorkspace(workspace, corpus)));
  }

  const scopeNote = resolveScopeNote(cfg);
  // Surface prior-run lessons at kickoff: the most relevant notes for this scope,
  // falling back to the most recent ones so memory is always visible.
  let memoryNotes = await memory.recall([cfg.targetName, scopeNote].filter(Boolean).join(" "), 8);
  if (memoryNotes.length === 0) memoryNotes = (await memory.all()).slice(-8).reverse();
  const memoryHint = renderMemoryHint(memoryNotes);

  // Driver choice: real pi providers (e.g. openai-codex) run a continuous
  // AgentSession that owns the loop; the deterministic mock and CLI fallbacks use
  // the legacy per-step complete() loop.
  const fileManifest = renderFileManifest(source, corpusManifest);

  // One phase = one driver run (continuous pi session for pi providers, else the
  // per-step loop), specialized to a role's model and a mode (breadth/map/dig).
  const runPhase = async (
    phaseCfg: AuditorConfig,
    opts: { mode: "breadth" | "map" | "dig" | "verify"; deepFocus?: string; verifySeed?: string; maxSteps: number },
    over?: { ctx: ToolContext; cwd: string },
  ): Promise<{ steps: TranscriptStep[]; stoppedReason: string }> => {
    const phaseCtx = over?.ctx ?? ctx;
    const phaseCwd = over?.cwd ?? workspaceCwd;
    const flags = {
      ...(opts.mode === "dig" ? { deep: true } : {}),
      ...(opts.mode === "map" ? { map: true } : {}),
      ...(opts.deepFocus ? { deepFocus: opts.deepFocus } : {}),
      ...(opts.verifySeed ? { verify: opts.verifySeed } : {}),
    };
    if (!options.llm && isPiSessionProvider(phaseCfg.provider)) {
      return runHuntSession({
        cfg: { ...phaseCfg, huntMaxSteps: opts.maxSteps },
        ctx: phaseCtx,
        tools,
        logger,
        cwd: phaseCwd,
        fileManifest,
        ...(scopeNote ? { scopeNote } : {}),
        ...(memoryHint ? { memoryHint } : {}),
        ...flags,
      });
    }
    const llm = options.llm ?? createLlmClient(phaseCfg, logger);
    if (llm && "setLogger" in llm && typeof (llm as { setLogger?: unknown }).setLogger === "function") {
      (llm as { setLogger(logger: RunLogger): void }).setLogger(logger);
    }
    return runHuntLoop({
      cfg: phaseCfg,
      llm,
      tools,
      ctx: phaseCtx,
      logger,
      maxSteps: Math.max(1, Math.floor(opts.maxSteps)),
      fileManifest,
      ...(scopeNote ? { scopeNote } : {}),
      ...(memoryHint ? { memoryHint } : {}),
      ...flags,
    });
  };

  let steps: TranscriptStep[];
  let stoppedReason: string;
  let manualFindings = false;
  let scopeInventory: AuditScope[] = [];
  // Set when concurrent digs already ran differential confirmation in their own
  // isolated workspaces, so the shared post-loop differential stage skips them.
  let digDifferentialDone = false;

  if (cfg.huntVerify) {
    // VERIFY posture: confirm-or-refute existing suspected finding(s) by execution.
    // Skips map/dig enumeration; for each finding it runs a focused session seeded
    // with the claim ("write a PoC that triggers it, or refute it"), routed through
    // the same confirmation gate. The shared post-loop differential stage then
    // upgrades any confirmed-executable finding to confirmed-differential. This is
    // exactly the confirmation tail of a dig, runnable standalone on a prior finding.
    const toVerify = await loadFindingsToVerify(cfg.huntVerify);
    await logger.event("hunt_verify_start", { findings: toVerify.length });
    const verifyCfg = withRole(cfg, "dig");
    const aggregated: AgentFinding[] = [];
    const aggregatedSteps: TranscriptStep[] = [];
    for (const [idx, finding] of toVerify.entries()) {
      clearScratchFindings(session);
      const phase = await runPhase(verifyCfg, { mode: "verify", verifySeed: buildVerifySeed(finding), maxSteps: cfg.huntDigSteps });
      aggregatedSteps.push(...phase.steps);
      ingestFindingsFromScratch(session);
      for (const produced of session.findings) aggregated.push(produced);
      await logger.event("hunt_verify_done", { index: idx + 1, of: toVerify.length, claim: String(finding.title ?? "").slice(0, 90), produced: session.findings.length });
    }
    aggregated.forEach((produced, i) => {
      produced.id = `f${i + 1}`;
    });
    session.findings = aggregated;
    session.counters.finding = aggregated.length;
    manualFindings = true;
    steps = aggregatedSteps;
    stoppedReason = "finished";
  } else if (cfg.huntDeep && !cfg.huntDeepFocus) {
    // MAP → DIG, resumable. The complete scope inventory is persisted under the
    // project history dir; each run deep-audits the next batch of un-audited
    // scopes and updates their status. Re-running the same command therefore
    // continues with the scopes not yet audited instead of re-mapping or
    // re-digging. --remap discards the persisted inventory and enumerates afresh.
    const inventoryDir = projectHistoryDir(historyLocation(cfg));
    const aggregatedSteps: TranscriptStep[] = [];
    const picked = cfg.huntScopeIds ?? [];
    scopeInventory = cfg.huntRemap ? [] : await loadScopeInventory(inventoryDir);
    const resuming = scopeInventory.length > 0;
    if (picked.length > 0 && !resuming) {
      throw new Error("--scope needs an existing scope inventory; run `fsa hunt --deep` first to enumerate scopes, then pick from hunt_scopes.json.");
    }
    if (!resuming) {
      const mapPhase = await runPhase(withRole(cfg, "map"), { mode: "map", maxSteps: cfg.huntMapSteps });
      scopeInventory = readScratchScopes(session);
      aggregatedSteps.push(...mapPhase.steps);
      await logger.event("hunt_map_done", { scopes: scopeInventory.length });
      clearScratchFindings(session);
    } else {
      await logger.event("hunt_map_resumed", { ...scopeProgress(scopeInventory) });
    }
    for (const scope of scopeInventory) if (!scope.status) scope.status = "pending";

    const digCfg = withRole(cfg, "dig");
    let toDig: AuditScope[];
    if (picked.length > 0) {
      // Human-in-the-loop: deep-audit exactly the named scopes (re-auditing an
      // already-audited one is allowed), regardless of score order.
      const wanted = new Set(picked);
      toDig = scopeInventory.filter((scope) => wanted.has(scope.id));
      const missing = picked.filter((id) => !toDig.some((scope) => scope.id === id));
      if (missing.length > 0) await logger.event("hunt_scope_unknown", { ids: missing });
      if (toDig.length === 0) throw new Error(`none of the requested scope ids exist in the inventory: ${picked.join(", ")}`);
      await logger.event("hunt_scope_picked", { ids: toDig.map((scope) => scope.id) });
    } else {
      // Audit the highest-scored scopes not yet audited; the rest stay pending for
      // a future run (visible, never silently dropped).
      toDig = scopeInventory
        .filter((scope) => scope.status !== "audited")
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, cfg.huntMaxScopes));
    }
    const aggregated: AgentFinding[] = [];
    const samples = Math.max(1, Math.floor(cfg.huntDigSamples));
    const concurrency = Math.max(1, Math.floor(cfg.huntDigConcurrency));
    // The region is the audit boundary; the map's obligation is only a starting
    // hint, never a limit (the dig system prompt's own rule is to independently
    // enumerate ALL of a region's obligations).
    const buildDeepFocus = (scope: AuditScope): string =>
      `code region ${scope.region} — audit this WHOLE region: independently enumerate and discharge ALL of its security obligations; ` +
      `do NOT limit yourself to any single one. The map flagged one concern as a starting point (not a boundary): "${scope.obligation}"`;
    // Run a scope's dig `samples` times and union the findings. Per-pass recall on a
    // subtle obligation is < 1 and stochastic; K independent passes raise cumulative
    // recall (1 - (1-p)^K). `over` isolates a concurrent dig in its own session.
    const digSamples = async (scope: AuditScope, sess: AgentSession, over?: { ctx: ToolContext; cwd: string }): Promise<{ findings: AgentFinding[]; steps: TranscriptStep[] }> => {
      const deepFocus = buildDeepFocus(scope);
      const perScope: AgentFinding[] = [];
      const stepsOut: TranscriptStep[] = [];
      for (let sample = 1; sample <= samples; sample += 1) {
        clearScratchFindings(sess);
        const dig = await runPhase(digCfg, { mode: "dig", deepFocus, maxSteps: cfg.huntDigSteps }, over);
        stepsOut.push(...dig.steps);
        ingestFindingsFromScratch(sess);
        for (const finding of sess.findings) {
          finding.scopeId = scope.id;
          perScope.push(finding);
        }
        if (samples > 1) await logger.event("hunt_dig_sample", { scope: scope.id, sample, of: samples, findings: sess.findings.length });
      }
      return { findings: dedupeFindings(perScope), steps: stepsOut };
    };

    if (concurrency > 1) {
      // Concurrent dig: each scope runs in its OWN isolated workspace + session +
      // differential confirmation, so parallel digs cannot corrupt each other's
      // test files, build output, or findings. A bounded pool caps simultaneous digs.
      const workspaceRoots = cfg.buildRoot ? [cfg.buildRoot] : cfg.sourcePaths;
      const digScope = async (scope: AuditScope): Promise<{ findings: AgentFinding[]; steps: TranscriptStep[]; commandRuns: typeof session.commandRuns }> => {
        const ws = await prepareSandboxWorkspace(workspaceRoots, logger.runDir, `hunt/dig-${safeScopeDir(scope.id)}`);
        const digSession = newSession();
        digSession.workspace = ws;
        digSession.baselineFiles = await listWorkspaceFiles(ws.absolute);
        if (session.buildCacheDir) digSession.buildCacheDir = session.buildCacheDir; // shared dep cache; per-dig target/
        await copyCorpusIntoWorkspace(ws, corpus);
        const digCtx: ToolContext = { cfg: digCfg, source, corpus, memory, logger, session: digSession };
        const { findings: unioned, steps: digSteps } = await digSamples(scope, digSession, { ctx: digCtx, cwd: ws.absolute });
        for (const finding of unioned) {
          if (finding.confirmationStatus !== "confirmed-executable" || !finding.fixPatch || !finding.commandRunId) continue;
          const exploitRun = digSession.commandRuns.find((run) => run.id === finding.commandRunId);
          if (!exploitRun) continue;
          const dr = await runDifferentialConfirmation({ workspace: ws, finding, exploitRun, baselineFiles: digSession.baselineFiles, cfg: digCfg, logger, ...(digSession.buildCacheDir ? { cacheDir: digSession.buildCacheDir } : {}) });
          if (dr.confirmed) finding.confirmationStatus = "confirmed-differential";
        }
        // Each isolated dig session numbers its command runs cmd1.. independently, so
        // they collide across concurrent scopes. Namespace by scope id and rewrite
        // each finding's commandRunId link so the aggregated hunt_command_runs.json
        // keeps every dig's evidence and a confirmed finding's citation still resolves
        // (the differential above already ran with the original, per-session ids).
        const scopedRuns = digSession.commandRuns.map((run) => ({ ...run, id: `${scope.id}:${run.id}` }));
        for (const finding of unioned) {
          if (finding.commandRunId) finding.commandRunId = `${scope.id}:${finding.commandRunId}`;
        }
        scope.status = "audited";
        await logger.event("hunt_dig_done", { scope: scope.id, samples, findings: unioned.length, concurrent: true });
        return { findings: unioned, steps: digSteps, commandRuns: scopedRuns };
      };
      await logger.event("hunt_dig_concurrent_start", { scopes: toDig.length, concurrency });
      const perScope = await runWithConcurrency(toDig, concurrency, digScope);
      // Merge every dig's findings, transcript steps, and command runs into the run
      // aggregates so the persisted artifacts reflect the concurrent digs, not just
      // the map phase. runWithConcurrency preserves scope order.
      for (const result of perScope) {
        aggregated.push(...result.findings);
        aggregatedSteps.push(...result.steps);
        session.commandRuns.push(...result.commandRuns);
      }
      digDifferentialDone = true; // each dig confirmed differentially in its own workspace
    } else {
      // Sequential: reuse the shared map workspace (one warm-up) and let the
      // post-loop differential stage confirm.
      for (const scope of toDig) {
        const { findings: unioned, steps: digSteps } = await digSamples(scope, session);
        aggregatedSteps.push(...digSteps);
        aggregated.push(...unioned);
        scope.status = "audited";
        await logger.event("hunt_dig_done", { scope: scope.id, samples, findings: unioned.length });
      }
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
    stoppedReason = "finished";
    await saveScopeInventory(inventoryDir, scopeInventory);
    await logger.artifact("hunt_scopes.json", scopeInventory);
    await logger.event("hunt_scope_progress", { ...scopeProgress(scopeInventory), resumed: resuming });
  } else {
    // Single run: breadth (default role) or a pinned deep-focus dig (dig role).
    const pinned = Boolean(cfg.huntDeep && cfg.huntDeepFocus);
    const result = await runPhase(withRole(cfg, pinned ? "dig" : "default"), {
      mode: pinned ? "dig" : "breadth",
      ...(cfg.huntDeepFocus ? { deepFocus: cfg.huntDeepFocus } : {}),
      maxSteps: cfg.huntMaxSteps,
    });
    steps = result.steps;
    stoppedReason = result.stoppedReason;
  }

  const findingParse = manualFindings ? { parsed: session.findings.length, errors: [] } : ingestFindingsFromScratch(session);
  if (findingParse.errors.length > 0) {
    await logger.artifact("hunt_findings_errors.json", findingParse.errors);
    await logger.event("hunt_findings_parse_errors", { errors: findingParse.errors.length });
  }

  // Differential confirmation: for confirmed-executable findings that declared a
  // machine-applicable fix, apply it to the pristine target source and re-run the
  // same exploit test. A real bug's test is blocked by its fix; a tautology is
  // not. Survivors reach the strongest status, confirmed-differential.
  if (session.workspace && session.baselineFiles && !digDifferentialDone) {
    const differentials: DifferentialResult[] = [];
    for (const finding of session.findings) {
      if (finding.confirmationStatus !== "confirmed-executable" || !finding.fixPatch || !finding.commandRunId) continue;
      const exploitRun = session.commandRuns.find((run) => run.id === finding.commandRunId);
      if (!exploitRun) continue;
      const result = await runDifferentialConfirmation({ workspace: session.workspace, finding, exploitRun, baselineFiles: session.baselineFiles, cfg, logger, ...(session.buildCacheDir ? { cacheDir: session.buildCacheDir } : {}) });
      differentials.push(result);
      if (result.confirmed) finding.confirmationStatus = "confirmed-differential";
    }
    if (differentials.length > 0) await logger.artifact("hunt_differential.json", differentials);
  }

  // Independent refutation: a fresh-context skeptic re-derives the invariant and
  // tries to break each confirmed finding. A single-test confirmation it debunks
  // is downgraded to a hypothesis; an execution-proven (differential) finding it
  // disputes is kept but flagged for humans (execution is ground truth).
  if (cfg.huntRefute) {
    const candidates = session.findings.filter((finding) => isConfirmed(finding.confirmationStatus));
    if (candidates.length > 0) {
      const refuteCfg = withRole(cfg, "refute");
      const refuteLlm = options.llm ?? createLlmClient(refuteCfg, logger);
      // Give the skeptic the PoC/scratch test files so it can audit the
      // confirmation's TRUST ASSUMPTIONS (e.g. an out-of-spec mocked verifier that
      // makes a vacuous "confirmation"), not just re-derive the invariant.
      const pocFiles = [...session.scratchFiles.entries()]
        .filter(([scratchPath]) => /\.t\.(sol|rs|ts|js)$/i.test(scratchPath) || /(^|\/)tests?\//i.test(scratchPath) || /(poc|exploit)/i.test(scratchPath))
        .map(([scratchPath, content]) => ({ path: scratchPath, content }));
      const verdicts = await runRefutation({ findings: candidates, source, cfg: refuteCfg, llm: refuteLlm, logger, max: 8, ...(pocFiles.length > 0 ? { pocFiles } : {}) });
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
      if (verdicts.length > 0) await logger.artifact("hunt_refutation.json", verdicts);
    }
  }

  // Hard artifact semantics: only an execution-confirmed candidate is a finding.
  // Everything else is a hypothesis. Hypotheses are surfaced as their own artifact
  // (not buried), but they do not get disclosure reports and are not counted as
  // findings — that is the whole point of the confirmation gate.
  const confirmed = session.findings.filter((finding) => isConfirmed(finding.confirmationStatus));
  const hypotheses = session.findings.filter((finding) => !isConfirmed(finding.confirmationStatus));

  await logger.artifact("hunt_transcript.json", { stoppedReason, steps });
  await logger.artifact("hunt_findings.json", confirmed);
  await logger.artifact("hunt_hypotheses.json", hypotheses);
  await logger.artifact("hunt_command_runs.json", session.commandRuns);

  const summary = buildSummary(confirmed, hypotheses, steps);
  await logger.artifact("summary.json", summary);

  for (const finding of summary.findings) {
    await logger.artifact(reportArtifactName(finding.id), renderDisclosure(cfg.targetName, finding));
  }

  // One consolidated, human-readable results file so collecting a run's output is
  // "read this one file" — confirmed findings (with scope, location, exploit, fix),
  // suspected hypotheses, and the scope-coverage map, aggregated across all digs
  // (including concurrent ones).
  await logger.artifact(
    "hunt_report.md",
    renderRunReport({ target: cfg.targetName, provider: cfg.provider, model: cfg.auditModel, confirmed, hypotheses, scopes: scopeInventory, reportName: reportArtifactName }),
  );

  await persistFindingMemory(memory, confirmed, hypotheses);

  await logger.event("hunt_done", {
    stoppedReason,
    steps: steps.length,
    findings: confirmed.length,
    hypotheses: hypotheses.length,
    confirmedExecutable: confirmed.length,
    commandRuns: session.commandRuns.length,
    finishSummary: session.finishSummary ?? "",
  });
  await writeLastRunPointer(path.dirname(logger.runDir), logger.runDir, cfg.targetName);

  const history = await updateProjectHistory({
    cfg,
    runDir: logger.runDir,
    summary,
    items: [],
    results: [],
    completedRounds: 1,
    startedAt: startedAt.toISOString(),
  });
  await logger.event("project_history_updated", {
    target: cfg.targetName,
    runs: history.aggregate.totalRuns,
    materials: history.aggregate.materialsTotal,
    manifest: publicPath(projectHistoryManifestPath(historyLocation(cfg))),
  });

  return {
    runDir: logger.runDir,
    summary,
    ...(scopeInventory.length > 0 ? { scopeCoverage: scopeProgress(scopeInventory) } : {}),
  };
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

function renderRunReport(input: {
  target: string;
  provider: string;
  model: string;
  confirmed: AgentFinding[];
  hypotheses: AgentFinding[];
  scopes: AuditScope[];
  reportName: (id: string) => string;
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
  if (input.scopes.length > 0) {
    const pending = input.scopes.length - audited;
    out.push(`- Scope coverage: audited ${audited} / ${input.scopes.length}${pending > 0 ? `, ${pending} pending (re-run to continue)` : ""}`);
  }
  out.push("");

  out.push(`## Confirmed findings (${input.confirmed.length})`, "");
  if (input.confirmed.length === 0) out.push("_None reached execution-confirmed status this run. See hypotheses below._", "");
  for (const finding of [...input.confirmed].sort(bySeverity)) {
    out.push(`### [${finding.severity.toUpperCase()}] ${finding.title} — ${finding.confirmationStatus}${finding.disputed ? " — ⚠ DISPUTED by independent refutation" : ""}`);
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
      out.push(`- **[${finding.severity.toUpperCase()}]** ${finding.title} — ${finding.location}${finding.scopeId ? ` (scope \`${finding.scopeId}\`)` : ""}`);
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

  return out.join("\n");
}

function buildSummary(confirmed: AgentFinding[], hypotheses: AgentFinding[], steps: { tool: string }[]): AuditSummary {
  const ranked = confirmed.map(toRankedFinding).sort((a, b) => b.score - a.score);
  const bySeverity: Record<Severity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const finding of ranked) bySeverity[finding.severity] += 1;
  return {
    coverage: {
      itemsTotal: ranked.length + hypotheses.length,
      itemsWithFinding: ranked.length,
      bySeverity,
      itemsNeedingRetry: 0,
      modelErrorTrials: steps.filter((step) => step.tool === "(model-error)").length,
      parseErrorTrials: steps.filter((step) => step.tool === "(parse-error)").length,
      needsMoreContextTrials: 0,
      verifiedFindings: ranked.length,
      unverifiedFindings: 0,
      hypotheses: hypotheses.length,
    },
    findings: ranked,
  };
}

async function persistFindingMemory(memory: ProjectMemory, confirmed: AgentFinding[], hypotheses: AgentFinding[]): Promise<void> {
  for (const finding of confirmed) {
    await memory.remember({
      note: `${finding.title} (${finding.confirmationStatus}) at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: "finding",
      tags: ["hunt", finding.severity, finding.confirmationStatus],
      sourceRef: finding.location,
    });
  }
  // Remember hypotheses too, but as notes — a future run starts knowing which
  // leads were explored without treating them as established findings.
  for (const finding of hypotheses) {
    await memory.remember({
      note: `Unconfirmed hypothesis: ${finding.title} at ${finding.location}: ${finding.description}`.slice(0, 600),
      kind: "note",
      tags: ["hunt", "hypothesis", finding.severity],
      sourceRef: finding.location,
    });
  }
}

function isConfirmed(status: ConfirmationStatus): boolean {
  return status === "confirmed-executable" || status === "confirmed-differential";
}

// --verify input: a JSON file holding one suspected finding, an array of them, or
// a {findings:[...]} object (so a prior run's hunt_findings.json / hunt_hypotheses.json
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
    ...(isConfirmed(finding.confirmationStatus) ? { reproductionStatus: "confirmed-executable" as const } : {}),
    ...(finding.disputed ? { disputed: true } : {}),
    ...(finding.refutation?.refuted ? { refutationReason: finding.refutation.reason } : {}),
  };
}

function resolveScopeNote(cfg: AuditorConfig): string {
  const parts: string[] = [];
  if (cfg.huntScopeNote) parts.push(cfg.huntScopeNote);
  if (cfg.projectContext.summary) parts.push(cfg.projectContext.summary);
  if (cfg.projectContext.focusAreas?.length) parts.push(`Focus areas: ${cfg.projectContext.focusAreas.join("; ")}`);
  if (cfg.projectContext.outOfScope?.length) parts.push(`Out of scope: ${cfg.projectContext.outOfScope.join("; ")}`);
  return parts.join("\n");
}

function renderMemoryHint(notes: { kind: string; note: string; sourceRef?: string }[]): string {
  if (notes.length === 0) return "";
  return notes.map((note) => `- [${note.kind}] ${note.note}${note.sourceRef ? ` (ref: ${note.sourceRef})` : ""}`).join("\n");
}

// Bounded worker pool: run `worker` over `items` with at most `limit` in flight,
// returning results in input order. Used to deep-audit scopes concurrently.
async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

/** Sanitize a scope id into a safe per-dig workspace directory name. */
function safeScopeDir(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "scope";
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
