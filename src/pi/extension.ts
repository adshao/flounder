import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent, type UserBashEvent } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defaultConfig, type AuditorConfig } from "../config.js";
import { runPrepare } from "../agent/acquire.js";
import { runAudit } from "../agent/audit.js";
import { runConfirm } from "../agent/confirm.js";
import { deriveScopeNote } from "../scope-note.js";
import { analyzeCommandSafety } from "../security/policy.js";
import { isSandboxBackend } from "../security/sandbox.js";

// Budget policy for pi tools that invoke the sealed run/map/audit verbs, kept in step with
// the CLI: UNBOUNDED by default. A real map/dig audit's decisive obligation can surface late,
// and a fixed budget silently truncates it, so the run ends when the model emits done unless
// the caller explicitly caps it.
export function applyFsaRunBudgets(cfg: AuditorConfig, maxSteps?: number): void {
  if (typeof maxSteps === "number" && Number.isFinite(maxSteps)) {
    const capped = Math.max(1, Math.floor(maxSteps));
    cfg.auditMaxSteps = capped;
    cfg.auditMapSteps = capped;
    cfg.auditDigSteps = capped;
    return;
  }
  cfg.auditMaxSteps = Number.POSITIVE_INFINITY;
  cfg.auditMapSteps = Number.POSITIVE_INFINITY;
  cfg.auditDigSteps = Number.POSITIVE_INFINITY;
}

type ToolParams = Record<string, unknown>;

function str(params: ToolParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(params: ToolParams, key: string): boolean | undefined {
  return typeof params[key] === "boolean" ? (params[key] as boolean) : undefined;
}

function num(params: ToolParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(params: ToolParams, key: string): string[] {
  const value = params[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function applyCommonConfig(cfg: AuditorConfig, params: ToolParams): void {
  cfg.targetName = str(params, "target") ?? cfg.targetName;
  cfg.provider = str(params, "provider") ?? cfg.provider;
  cfg.auditModel = str(params, "model") ?? cfg.auditModel;
  const thinking = str(params, "thinking");
  if (thinking === "off" || thinking === "minimal" || thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh") {
    cfg.thinkingLevel = thinking;
  }
  cfg.outputDir = str(params, "outputDir") ?? cfg.outputDir;
  const historyDir = str(params, "historyDir");
  if (historyDir !== undefined) cfg.historyDir = historyDir;
}

function applyMaterialConfig(cfg: AuditorConfig, params: ToolParams): void {
  const sourcePaths = stringArray(params, "sourcePaths");
  if (sourcePaths.length > 0) cfg.sourcePaths = sourcePaths;
  const corpusPaths = stringArray(params, "corpusPaths");
  if (corpusPaths.length > 0) cfg.corpusPaths = corpusPaths;
  const buildRoot = str(params, "buildRoot");
  if (buildRoot !== undefined) cfg.buildRoot = buildRoot;
  const scopeNote = str(params, "scopeNote");
  if (scopeNote) cfg.auditScopeNote = scopeNote;
}

function applySandboxConfig(cfg: AuditorConfig, params: ToolParams): void {
  const backend = str(params, "sandboxBackend");
  if (isSandboxBackend(backend)) cfg.sandboxBackend = backend;
  cfg.sandboxImage = str(params, "sandboxImage") ?? cfg.sandboxImage;
  const allowHost = bool(params, "sandboxAllowHostFallback");
  if (allowHost !== undefined) cfg.sandboxAllowHostFallback = allowHost;
  const prepareNetwork = str(params, "sandboxPrepareNetwork");
  if (prepareNetwork === "none" || prepareNetwork === "enabled") cfg.sandboxPrepareNetwork = prepareNetwork;
  const confirmNetwork = str(params, "sandboxConfirmNetwork");
  if (confirmNetwork === "none" || confirmNetwork === "enabled") cfg.sandboxConfirmNetwork = confirmNetwork;
  const memoryMb = num(params, "sandboxMemoryMb");
  if (memoryMb !== undefined) cfg.sandboxMemoryMb = Math.max(64, Math.floor(memoryMb));
  const cpus = num(params, "sandboxCpus");
  if (cpus !== undefined) cfg.sandboxCpus = Math.max(0.1, cpus);
}

function applyAuditBudgets(cfg: AuditorConfig, params: ToolParams): void {
  applyFsaRunBudgets(cfg, num(params, "maxSteps"));
  const mapSteps = num(params, "mapSteps");
  if (mapSteps !== undefined) cfg.auditMapSteps = Math.max(1, Math.floor(mapSteps));
  const digSteps = num(params, "digSteps");
  if (digSteps !== undefined) cfg.auditDigSteps = Math.max(1, Math.floor(digSteps));
  const maxScopes = num(params, "maxScopes");
  if (maxScopes !== undefined) cfg.auditMaxScopes = Math.max(1, Math.floor(maxScopes));
  const digSamples = num(params, "digSamples");
  if (digSamples !== undefined) cfg.auditDigSamples = Math.max(1, Math.floor(digSamples));
  const digConcurrency = num(params, "digConcurrency");
  if (digConcurrency !== undefined) cfg.auditDigConcurrency = Math.max(1, Math.floor(digConcurrency));
  if (bool(params, "remap")) cfg.auditRemap = true;
  if (bool(params, "appendMap")) cfg.auditAppendMap = true;
}

function configured(params: ToolParams): AuditorConfig {
  const cfg = defaultConfig();
  applyCommonConfig(cfg, params);
  applyMaterialConfig(cfg, params);
  applySandboxConfig(cfg, params);
  return cfg;
}

function confirmedCount(findings: Array<{ confirmationStatus: string }>): number {
  return findings.filter((finding) => finding.confirmationStatus === "confirmed-executable" || finding.confirmationStatus === "confirmed-differential").length;
}

function summaryLine(runDir: string, total: number, confirmed: number): string {
  return `Run dir: ${runDir}\nFindings: ${total} (confirmed: ${confirmed})`;
}

function details(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

async function runPipeline(params: ToolParams): Promise<Record<string, unknown>> {
  const clue = str(params, "clue");
  if (!clue) throw new Error("flounder_run needs either sourcePaths for a sealed source audit or clue for the prepare -> run -> confirm pipeline.");

  const prepCfg = configured(params);
  const posture = str(params, "posture") === "informed" ? "informed" : "blind";
  const matchDeployed = bool(params, "matchDeployed") ?? true;
  const endpoint = str(params, "endpoint");
  const prepareMaxSteps = num(params, "prepareMaxSteps");
  const prep = await runPrepare(prepCfg, {
    clue,
    posture,
    matchDeployed,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(prepareMaxSteps !== undefined ? { maxSteps: Math.max(1, Math.floor(prepareMaxSteps)) } : {}),
  });

  const auditParams: ToolParams = { ...params, sourcePaths: [prep.workspaceDir], buildRoot: prep.workspaceDir };
  const auditCfg = configured(auditParams);
  applyAuditBudgets(auditCfg, auditParams);
  if (!bool(params, "quick")) auditCfg.auditDeep = true;
  const derived = deriveScopeNote(prep.manifest);
  if (derived) auditCfg.auditScopeNote = [str(params, "scopeNote"), derived].filter(Boolean).join("\n\n");

  const audit = await runAudit(auditCfg, { kind: "run" });
  const confirmed = confirmedCount(audit.summary.findings);
  let confirm: Awaited<ReturnType<typeof runConfirm>> | undefined;
  if (!bool(params, "noConfirm") && audit.summary.findings.length > 0) {
    const confirmCfg = configured({ ...params, sourcePaths: [prep.workspaceDir], buildRoot: prep.workspaceDir });
    const confirmMaxSteps = num(params, "confirmMaxSteps");
    confirm = await runConfirm(confirmCfg, {
      inputRunDir: audit.runDir,
      ...(confirmMaxSteps !== undefined ? { maxSteps: Math.max(1, Math.floor(confirmMaxSteps)) } : {}),
    });
  }

  return { prepare: prep, audit, confirm, confirmed };
}

const sharedParams = {
  target: Type.String({ description: "Target name used for run artifacts and durable memory." }),
  provider: Type.Optional(Type.String({ description: "pi-ai provider, for example openai-codex." })),
  model: Type.Optional(Type.String({ description: "Model id used to drive the agent loop." })),
  thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh." })),
  outputDir: Type.Optional(Type.String({ description: "Artifact output directory." })),
  historyDir: Type.Optional(Type.String({ description: "Project history directory. Defaults to outputDir/history." })),
  sandboxBackend: Type.Optional(Type.String({ description: "auto|oci|apple-container|host." })),
  sandboxImage: Type.Optional(Type.String({ description: "OCI image for sandboxed commands." })),
  sandboxAllowHostFallback: Type.Optional(Type.Boolean({ description: "Trusted-local opt-in for host fallback when OCI is unavailable." })),
  sandboxPrepareNetwork: Type.Optional(Type.String({ description: "none|enabled for prepare/build warm-up commands." })),
  sandboxConfirmNetwork: Type.Optional(Type.String({ description: "none|enabled for open-world confirm commands." })),
  sandboxMemoryMb: Type.Optional(Type.Number({ description: "Memory limit for OCI sandbox commands." })),
  sandboxCpus: Type.Optional(Type.Number({ description: "CPU limit for OCI sandbox commands." })),
};

const materialParams = {
  sourcePaths: Type.Array(Type.String(), { description: "Local authorized source files or directories to audit." }),
  buildRoot: Type.Optional(Type.String({ description: "Directory copied into the sandbox so the target is buildable. Defaults to sourcePaths." })),
  corpusPaths: Type.Optional(Type.Array(Type.String(), { description: "Local spec/reference files or directories." })),
  scopeNote: Type.Optional(Type.String({ description: "One-line authorized-scope hint surfaced to map/dig." })),
};

const auditBudgetParams = {
  maxSteps: Type.Optional(Type.Number({ description: "Cap on agent actions. Default: unbounded." })),
  mapSteps: Type.Optional(Type.Number({ description: "Cap on map actions. Default: unbounded." })),
  digSteps: Type.Optional(Type.Number({ description: "Cap on each dig. Default: unbounded." })),
  maxScopes: Type.Optional(Type.Number({ description: "How many mapped scopes the next dig batch audits. Default follows Flounder config." })),
  digSamples: Type.Optional(Type.Number({ description: "Independent dig passes per selected scope." })),
  digConcurrency: Type.Optional(Type.Number({ description: "How many scopes run in parallel." })),
  remap: Type.Optional(Type.Boolean({ description: "Re-enumerate scopes from scratch instead of resuming inventory." })),
  appendMap: Type.Optional(Type.Boolean({ description: "Expand the existing scope inventory by appending novel scopes; preserves existing scope status." })),
};

export default function fullStackAuditorExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "flounder_prepare",
    label: "Prepare Audit Target",
    description:
      "Open-world acquisition phase. Turn a clue (transaction, address, package, repo, project link, or other authorized target pointer) into staged source/corpus with provenance and deployment-match evidence. Runs before map; does not hunt bugs.",
    parameters: Type.Object({
      ...sharedParams,
      clue: Type.String({ description: "Transaction, address, package, repo, project link, or other authorized target clue." }),
      posture: Type.Optional(Type.String({ description: "blind|informed. Default blind." })),
      matchDeployed: Type.Optional(Type.Boolean({ description: "Prove deployed/published components match staged source when possible. Default true." })),
      endpoint: Type.Optional(Type.String({ description: "Read-only access hint, such as an RPC URL." })),
      maxSteps: Type.Optional(Type.Number({ description: "Cap on prepare actions. Default: unbounded." })),
    }),
    async execute(_toolCallId, params) {
      const cfg = configured(params);
      const result = await runPrepare(cfg, {
        clue: params.clue,
        posture: params.posture === "informed" ? "informed" : "blind",
        matchDeployed: params.matchDeployed ?? true,
        ...(params.endpoint ? { endpoint: params.endpoint } : {}),
        ...(typeof params.maxSteps === "number" && Number.isFinite(params.maxSteps) ? { maxSteps: Math.max(1, Math.floor(params.maxSteps)) } : {}),
      });
      return {
        content: [{ type: "text", text: `Prepare dir: ${result.runDir}\nWorkspace: ${result.workspaceDir}\nComponents: ${result.validation.components} (matched: ${result.validation.matched}, unverified: ${result.validation.unverified})` }],
        details: details(result),
      };
    },
  });

  pi.registerTool({
    name: "flounder_run",
    label: "Continue Audit",
    description:
      "Current flounder run semantics. With clue and no sourcePaths, run the full prepare -> sealed map/dig -> confirm pipeline. With sourcePaths, run the sealed source audit: map scopes if needed, then dig the next batch. The model drives read/write/edit/bash inside Flounder's sandbox; findings require execution evidence.",
    parameters: Type.Object({
      ...sharedParams,
      clue: Type.Optional(Type.String({ description: "When set without sourcePaths, runs prepare -> sealed map/dig -> confirm." })),
      sourcePaths: Type.Optional(Type.Array(Type.String(), { description: "Local authorized source files or directories. When set, runs sealed map/dig on this source." })),
      buildRoot: Type.Optional(Type.String({ description: "Directory copied into the sandbox so the target is buildable. Defaults to sourcePaths." })),
      corpusPaths: Type.Optional(Type.Array(Type.String(), { description: "Local spec/reference files or directories." })),
      scopeNote: Type.Optional(Type.String({ description: "One-line authorized-scope hint surfaced to map/dig." })),
      quick: Type.Optional(Type.Boolean({ description: "Source audit only: run one breadth pass instead of map/dig." })),
      noConfirm: Type.Optional(Type.Boolean({ description: "Clue pipeline only: stop after sealed audit instead of running open-world confirm." })),
      posture: Type.Optional(Type.String({ description: "Clue pipeline prepare posture: blind|informed. Default blind." })),
      matchDeployed: Type.Optional(Type.Boolean({ description: "Clue pipeline prepare: deployment-match staged source when possible. Default true." })),
      endpoint: Type.Optional(Type.String({ description: "Clue pipeline prepare read-only endpoint hint." })),
      prepareMaxSteps: Type.Optional(Type.Number({ description: "Clue pipeline prepare cap. Default: unbounded." })),
      confirmMaxSteps: Type.Optional(Type.Number({ description: "Clue pipeline confirm cap. Default: unbounded." })),
      ...auditBudgetParams,
    }),
    async execute(_toolCallId, params) {
      const sourcePaths = stringArray(params, "sourcePaths");
      const clue = str(params, "clue");
      if (sourcePaths.length > 0 && clue) throw new Error("flounder_run accepts either sourcePaths or clue, not both.");
      if (sourcePaths.length === 0 && clue) {
        const result = await runPipeline(params);
        const audit = result.audit as Awaited<ReturnType<typeof runAudit>>;
        const confirm = result.confirm as Awaited<ReturnType<typeof runConfirm>> | undefined;
        return {
          content: [{
            type: "text",
            text: `Prepare dir: ${(result.prepare as Awaited<ReturnType<typeof runPrepare>>).runDir}\n${summaryLine(audit.runDir, audit.summary.findings.length, result.confirmed as number)}${confirm ? `\nConfirm dir: ${confirm.runDir}\nDecision rows: ${confirm.decisionRows}` : "\nConfirm skipped or no findings to confirm."}`,
          }],
          details: details(result),
        };
      }
      if (sourcePaths.length === 0) throw new Error("flounder_run needs sourcePaths for a sealed source audit, or clue for the prepare -> run -> confirm pipeline.");

      const cfg = configured(params);
      applyAuditBudgets(cfg, params);
      if (!params.quick) cfg.auditDeep = true; // source run = map -> dig; quick = breadth pass

      const result = await runAudit(cfg, { kind: "run" });
      const confirmed = confirmedCount(result.summary.findings);
      return {
        content: [
          {
            type: "text",
            text: `${summaryLine(result.runDir, result.summary.findings.length, confirmed)}\nBy severity: ${JSON.stringify(result.summary.coverage.bySeverity)}`,
          },
        ],
        details: details(result),
      };
    },
  });

  pi.registerTool({
    name: "flounder_map",
    label: "Map Audit Scopes",
    description:
      "Sealed map phase. Enumerate and persist the scope inventory for authorized source/corpus without digging or producing findings. Use before flounder_audit when you want separate map and dig steps.",
    parameters: Type.Object({
      ...sharedParams,
      ...materialParams,
      maxSteps: Type.Optional(Type.Number({ description: "Alias for mapSteps. Default: unbounded." })),
      mapSteps: Type.Optional(Type.Number({ description: "Cap on map actions. Default: unbounded." })),
      remap: Type.Optional(Type.Boolean({ description: "Re-enumerate scopes from scratch instead of resuming inventory." })),
    }),
    async execute(_toolCallId, params) {
      const cfg = configured(params);
      applyFsaRunBudgets(cfg, num(params, "maxSteps"));
      const mapSteps = num(params, "mapSteps");
      if (mapSteps !== undefined) cfg.auditMapSteps = Math.max(1, Math.floor(mapSteps));
      if (bool(params, "remap")) cfg.auditRemap = true;
      if (bool(params, "appendMap")) cfg.auditAppendMap = true;
      cfg.auditDeep = true;
      cfg.auditMapOnly = true;
      const result = await runAudit(cfg, { kind: "map" });
      return {
        content: [{ type: "text", text: `Map dir: ${result.runDir}\nScopes: ${result.scopeCoverage?.total ?? 0}` }],
        details: details(result),
      };
    },
  });

  pi.registerTool({
    name: "flounder_audit",
    label: "Dig Or Verify",
    description:
      "Sealed audit phase. Dig pending scopes from an existing map, dig a named region, dig selected scope ids, or verify supplied suspected finding JSON by execution. Network remains sealed; local confirmation still requires a sandboxed test command.",
    parameters: Type.Object({
      ...sharedParams,
      ...materialParams,
      region: Type.Optional(Type.String({ description: "Deep-audit one pinned region, e.g. src/Foo.sol:120-180." })),
      scope: Type.Optional(Type.String({ description: "Comma-separated scope ids from the persisted inventory." })),
      verifyFindings: Type.Optional(Type.Any({ description: "Inline suspected finding object or array to confirm-or-refute by execution." })),
      ...auditBudgetParams,
    }),
    async execute(_toolCallId, params) {
      const cfg = configured(params);
      applyAuditBudgets(cfg, params);
      let verifyTempDir: string | undefined;
      if (params.verifyFindings !== undefined) {
        const dir = await mkdtemp(path.join(tmpdir(), "flounder-verify-"));
        verifyTempDir = dir;
        const file = path.join(dir, "findings.json");
        await writeFile(file, JSON.stringify(params.verifyFindings), "utf8");
        cfg.auditVerify = file;
      } else {
        cfg.auditDeep = true;
        const region = str(params, "region");
        if (region) cfg.auditDeepFocus = region;
        else {
          cfg.auditRequireInventory = true;
          const scope = str(params, "scope");
          if (scope) cfg.auditScopeIds = scope.split(",").map((item) => item.trim()).filter(Boolean);
        }
      }
      try {
        const result = await runAudit(cfg, { kind: "audit" });
        const confirmed = confirmedCount(result.summary.findings);
        return {
          content: [{ type: "text", text: `${summaryLine(result.runDir, result.summary.findings.length, confirmed)}${result.scopeCoverage ? `\nScopes: ${result.scopeCoverage.audited}/${result.scopeCoverage.total} audited (${result.scopeCoverage.pending} pending)` : ""}` }],
          details: details(result),
        };
      } finally {
        if (verifyTempDir) await rm(verifyTempDir, { recursive: true, force: true });
      }
    },
  });

  pi.registerTool({
    name: "flounder_confirm",
    label: "Open-World Confirmation",
    description:
      "Open-world confirmation phase. Take a finished run's confirmed findings to a real-world standard: freeze provenance, reproduce against real ground truth, consolidate duplicates, check novelty online, and emit a submit/no-submit decision sheet. Networked but white-hat: may fork/read/fetch/search, never broadcast to a live target.",
    parameters: Type.Object({
      ...sharedParams,
      runDir: Type.String({ description: "Directory of the finished flounder_run to confirm (it must contain audit_findings.json with confirmed findings)." }),
      sourcePaths: Type.Array(Type.String(), { description: "Local authorized source/target code to reproduce the findings against." }),
      buildRoot: Type.Optional(Type.String({ description: "Directory copied into the sandbox so the target is buildable (e.g. a Foundry/cargo workspace root). Defaults to sourcePaths." })),
      corpusPaths: Type.Optional(Type.Array(Type.String(), { description: "Local spec/reference files or directories." })),
      maxSteps: Type.Optional(Type.Number({ description: "Cap on agent actions. Default: unbounded — the run ends when the model emits done. Reproduction is heavy; a fixed budget silently truncates it." })),
      fresh: Type.Optional(Type.Boolean({ description: "Ignore any prior interrupted confirm of this run and start over (default: auto-resume, carrying already-settled rows forward)." })),
    }),
    async execute(_toolCallId, params) {
      const cfg = configured(params);

      // Confirm is UNBOUNDED by default: runConfirm sets the budget to non-finite unless a
      // finite maxSteps is passed. Resume is automatic unless `fresh` is set.
      const maxSteps = typeof params.maxSteps === "number" && Number.isFinite(params.maxSteps) ? Math.max(1, Math.floor(params.maxSteps)) : undefined;
      const result = await runConfirm(cfg, {
        inputRunDir: params.runDir,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(params.fresh ? { fresh: true } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Confirm dir: ${result.runDir}\nDecision rows (distinct bugs): ${result.decisionRows}\nDecision sheet: ${result.runDir}/confirm_report.md\nProvenance (frozen pre-network): ${result.runDir}/confirm_provenance.json`,
          },
        ],
        details: details(result),
      };
    },
  });

  pi.registerCommand("flounder", {
    description: "Show flounder usage.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Tools: flounder_prepare, flounder_run, flounder_map, flounder_audit, flounder_confirm. They mirror the top-level Flounder workflow verbs.", "info");
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const decision = analyzeCommandSafety(event.input.command);
    if (decision.blocked) {
      return {
        block: true,
        reason: decision.reason ?? "Blocked by flounder.",
      };
    }
    return undefined;
  });

  pi.on("user_bash", async (event: UserBashEvent) => {
    const decision = analyzeCommandSafety(event.command);
    if (!decision.blocked) return undefined;
    return {
      result: {
        output: decision.reason ?? "Blocked by flounder.",
        exitCode: 2,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
