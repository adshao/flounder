import type { ProjectContext } from "./types.js";

export interface AuditorConfig {
  targetName: string;
  sourcePaths: string[];
  corpusPaths: string[];
  // Directory copied into the sandbox so the workspace is buildable (e.g. a Cargo
  // workspace root whose members the audited crate path-depends on). Defaults to
  // sourcePaths. Separates "what gets built" from "what the model reads" so a
  // narrow audit scope can still compile against its full project.
  buildRoot?: string;
  outputDir: string;
  historyDir?: string;
  provider: string;
  auditModel: string;
  maxTokens: number;
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
  projectContext: ProjectContext;
  // Sandbox limits shared with the bash tool and warm-up.
  reproductionCommandTimeoutMs: number;
  reproductionMaxFileBytes: number;
  reproductionMaxLogBytes: number;
  // Audit controls.
  auditMaxSteps: number;
  auditScopeNote?: string;
  auditPrepare: boolean;
  auditPrepareTimeoutMs: number;
  auditRefute: boolean;
  auditAppeal: boolean;
  // Deep narrow-scope audit posture: obligation-driven, no breadth/wrap-up
  // pressure. Optionally pin the focus region; otherwise the model ranks and
  // picks the most soundness-critical region itself.
  auditDeep: boolean;
  auditDeepFocus?: string;
  // Map → dig flow (used when --deep runs without a pinned focus): map enumerates
  // an obligation/scope inventory, dig deep-audits the top scopes one at a time.
  auditMapSteps: number;
  auditDigSteps: number;
  auditMaxScopes: number;
  // How many independent dig passes to run per scope; findings are unioned. Raises
  // recall on scopes where a single pass finds a subtle obligation only sometimes
  // (cumulative recall 1 - (1-p)^K) — a variance lever, not a bug-specific tweak.
  auditDigSamples: number;
  // How many scopes the dig phase audits in parallel. Each concurrent dig runs in
  // its own isolated workspace + session (and its own differential confirmation),
  // so they cannot corrupt each other's test files, build output, or findings.
  // 1 = sequential (default).
  auditDigConcurrency: number;
  // Re-enumerate the scope inventory from scratch instead of resuming the
  // persisted one (which would otherwise continue with the next un-audited scopes).
  auditRemap: boolean;
  // `fsa map`: run only the MAP phase (enumerate + persist the scope inventory) and
  // stop — no dig. The resumable `fsa audit` then digs from the persisted inventory.
  auditMapOnly: boolean;
  // `fsa audit` (dig stage): require an existing scope inventory rather than auto-mapping.
  // `fsa run` (the map -> audit one-stop) leaves this false so it enumerates first.
  auditRequireInventory: boolean;
  // Manually pick specific scope ids from the persisted inventory to deep-audit
  // (the human-in-the-loop seam), instead of the automatic top-by-score selection.
  auditScopeIds?: string[];
  // VERIFY posture: path to a JSON file of suspected finding(s) to confirm-or-refute
  // by execution (write a PoC -> build -> run -> differential). Skips map/dig
  // enumeration; reuses the confirmation gate. The confirmation step the dig
  // produces on its own, runnable standalone against an existing suspected finding.
  auditVerify?: string;
  // CONFIRM mode (`fsa confirm`): the open-world counterpart to the network-sealed
  // `fsa run`. When set, the bash tool swaps to the network-enabled policy (fork/read
  // live networks, fetch, search — never BROADCAST). This is the only capability
  // difference; the white-hat broadcast line and the confirmation gate are unchanged.
  confirmMode: boolean;
  // Per-role model assignment. A role (map/dig/refute) resolves to its own entry,
  // else `default`, else the top-level provider/auditModel/thinkingLevel. Nothing
  // is auto-downgraded: an unspecified role inherits the main model.
  models?: Partial<Record<AuditRole, Partial<RoleModel>>>;
  dryRun: boolean;
}

// The phases that may run on different models. `map` = scope enumeration,
// `dig` = per-scope deep audit, `refute` = independent refutation, `default` =
// everything else / fallback.
export type AuditRole = "default" | "map" | "dig" | "refute";

export interface RoleModel {
  provider: string;
  model: string;
  thinking: AuditorConfig["thinkingLevel"];
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Resolve the effective model for a phase: role entry → `default` entry → top-level config. */
export function resolveRole(cfg: AuditorConfig, role: AuditRole): RoleModel {
  const roleCfg = cfg.models?.[role] ?? {};
  const def = cfg.models?.default ?? {};
  return {
    provider: roleCfg.provider ?? def.provider ?? cfg.provider,
    model: roleCfg.model ?? def.model ?? cfg.auditModel,
    thinking: roleCfg.thinking ?? def.thinking ?? cfg.thinkingLevel,
  };
}

/** A copy of the config specialized to a role's model, so role-agnostic callers stay unchanged. */
export function withRole(cfg: AuditorConfig, role: AuditRole): AuditorConfig {
  const resolved = resolveRole(cfg, role);
  return { ...cfg, provider: resolved.provider, auditModel: resolved.model, thinkingLevel: resolved.thinking };
}

/** Parse a config-file `models` block into the validated per-role shape. */
export function normalizeRoleModels(input: unknown): AuditorConfig["models"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Partial<Record<AuditRole, Partial<RoleModel>>> = {};
  for (const role of ["default", "map", "dig", "refute"] as AuditRole[]) {
    const raw = (input as Record<string, unknown>)[role];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const entry: Partial<RoleModel> = {};
    if (typeof r.provider === "string" && r.provider.trim()) entry.provider = r.provider.trim();
    if (typeof r.model === "string" && r.model.trim()) entry.model = r.model.trim();
    if (typeof r.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(r.thinking)) {
      entry.thinking = r.thinking as RoleModel["thinking"];
    }
    if (Object.keys(entry).length > 0) out[role] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function defaultConfig(): AuditorConfig {
  return {
    targetName: "target",
    sourcePaths: [],
    corpusPaths: [],
    outputDir: "runs",
    provider: "openai-codex",
    auditModel: "gpt-5.5",
    maxTokens: 8000,
    thinkingLevel: "xhigh",
    projectContext: {},
    reproductionCommandTimeoutMs: 120_000,
    reproductionMaxFileBytes: 200_000,
    reproductionMaxLogBytes: 40_000,
    auditMaxSteps: 40,
    auditPrepare: true,
    auditPrepareTimeoutMs: 600_000,
    auditRefute: true,
    auditAppeal: true,
    auditDeep: false,
    auditMapSteps: 20,
    auditDigSteps: 30,
    auditMaxScopes: 10,
    auditDigSamples: 1,
    auditDigConcurrency: 1,
    auditRemap: false,
    auditMapOnly: false,
    auditRequireInventory: false,
    confirmMode: false,
    dryRun: false,
  };
}

const MAX_CONTEXT_LIST_ITEMS = 24;
const MAX_CONTEXT_FIELD_CHARS = 1600;

/** Parse a configured/CLI project-context object into the bounded scope-note shape audit uses. */
export function normalizeProjectContext(input: unknown): ProjectContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const out: ProjectContext = {};
  const summary = cleanContextString(raw.summary);
  if (summary) out.summary = summary;
  setContextList(out, "criticalAssets", raw.criticalAssets ?? raw.critical_assets);
  setContextList(out, "attackerCapabilities", raw.attackerCapabilities ?? raw.attacker_capabilities);
  setContextList(out, "trustBoundaries", raw.trustBoundaries ?? raw.trust_boundaries);
  setContextList(out, "securityInvariants", raw.securityInvariants ?? raw.security_invariants);
  setContextList(out, "focusAreas", raw.focusAreas ?? raw.focus_areas);
  setContextList(out, "outOfScope", raw.outOfScope ?? raw.out_of_scope);
  setContextList(out, "scenarioGuidance", raw.scenarioGuidance ?? raw.scenario_guidance);
  return Object.keys(out).length === 0 ? undefined : out;
}

function setContextList<K extends keyof ProjectContext>(out: ProjectContext, key: K, value: unknown): void {
  if (!Array.isArray(value)) return;
  const cleaned = [
    ...new Set(value.map((item) => cleanContextString(item)).filter((item): item is string => item !== undefined)),
  ].slice(0, MAX_CONTEXT_LIST_ITEMS);
  if (cleaned.length > 0) out[key] = cleaned as ProjectContext[K];
}

function cleanContextString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, MAX_CONTEXT_FIELD_CHARS);
}
