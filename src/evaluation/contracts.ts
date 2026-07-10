import path from "node:path";

export const RUN_GROUP_STATES = ["draft", "queued", "running", "paused", "finished", "failed", "cancelled"] as const;
export type RunGroupState = (typeof RUN_GROUP_STATES)[number];

export const WORK_ITEM_KINDS = ["audit-target", "verify-claim", "benchmark-case", "regression-replay", "custom"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const WORK_ITEM_STATES = ["queued", "claimed", "running", "finished", "failed", "cancelled"] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export const WORK_ITEM_OUTCOMES = [
  "reproduced",
  "confirmed",
  "not_reproduced",
  "refuted",
  "blocked",
  "invalid",
  "no_findings",
  "findings_reported",
] as const;
export type WorkItemOutcome = (typeof WORK_ITEM_OUTCOMES)[number];

export const TARGET_CLASSES = ["memory-safety", "logic", "crypto-zk", "capability-surface", "general"] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

export const EVIDENCE_GATE_KINDS = ["confirmation-command", "benchmark-oracle", "replay-package", "manual-review"] as const;
export type EvidenceGateKind = (typeof EVIDENCE_GATE_KINDS)[number];
export type ExpectedOutcome = "detect-positive" | "reject-positive";
export type MaterialPosture = "blind" | "informed" | "open-world" | "private";
export type MaterialDecision = "included" | "excluded" | "warning";
export type NetworkPolicy = "sealed" | "open-world-read" | "local-only";

export interface CapabilitySurface {
  entrypoints: string[];
  inputs: string[];
  effects: string[];
  authorities: string[];
  boundaries: string[];
  localFixtures: string[];
}

export interface TargetBundle {
  target: string;
  targetClass: TargetClass;
  sourcePaths: string[];
  corpusPaths: string[];
  buildRoot?: string;
  scopeNote?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  daemonId?: number;
  mockLlm?: boolean;
  maxScopes?: number;
  mapSteps?: number;
  mapSamples?: number;
  digSteps?: number;
  maxSteps?: number;
  digSamples?: number;
  digMaxSamples?: number;
  adaptiveDig?: boolean;
  eagerPrepare?: boolean;
  digConcurrency?: number;
  sandboxBackend?: "auto" | "oci" | "apple-container";
  sandboxImage?: string;
  capabilitySurface?: CapabilitySurface;
  claim?: unknown;
}

export interface MaterialEntry {
  path: string;
  provenance: string;
  operatorLabel: string;
  policyDecision: MaterialDecision;
  reason: string;
}

export interface MaterialPolicy {
  posture: MaterialPosture;
  materials: MaterialEntry[];
}

export interface EvidenceContract {
  kind: EvidenceGateKind;
  command?: string;
  successPatterns: string[];
  failurePatterns: string[];
  requiresDifferential: boolean;
  requiresRefutation: boolean;
  networkPolicy: NetworkPolicy;
  expectedOutcome?: ExpectedOutcome;
  /** Evaluator-only generalization metadata; never shown to the audit model. */
  caseId?: string;
  caseFamily?: string;
  targetStack?: string;
  holdout?: boolean;
}

export interface WorkItemInput {
  itemKey: string;
  kind: WorkItemKind;
  targetBundle: TargetBundle;
  materialPolicy: MaterialPolicy;
  evidenceContract: EvidenceContract;
  projectId?: number;
}

export interface RunGroupManifest {
  version: 1;
  name: string;
  kind: string;
  parallelism: number;
  config: Record<string, unknown>;
  budget: Record<string, unknown>;
  items: WorkItemInput[];
}

const RISKY_BLIND_LABELS = [
  "disclosure",
  "incident",
  "post-mortem",
  "postmortem",
  "exploit",
  "benchmark-answer",
  "issue",
  "pull-request",
  "prior-audit",
  "unknown",
] as const;

export function normalizeRunGroupManifest(input: unknown): RunGroupManifest {
  const record = requireRecord(input, "run-group manifest");
  const version = record.version === undefined ? 1 : positiveInteger(record.version, "version");
  if (version !== 1) throw new Error(`Unsupported run-group manifest version: ${version}`);
  const rawItems = Array.isArray(record.items) ? record.items : [];
  if (rawItems.length === 0) throw new Error("run-group manifest needs at least one work item");
  const itemKeys = new Set<string>();
  const items = rawItems.map((item, index) => {
    const normalized = normalizeWorkItemInput(item, index);
    if (itemKeys.has(normalized.itemKey)) throw new Error(`Duplicate work-item key: ${normalized.itemKey}`);
    itemKeys.add(normalized.itemKey);
    return normalized;
  });
  return {
    version: 1,
    name: requiredString(record.name, "name"),
    kind: optionalString(record.kind) ?? "evaluation",
    parallelism: positiveInteger(record.parallelism ?? 1, "parallelism"),
    config: optionalRecord(record.config),
    budget: optionalRecord(record.budget ?? record.budgets),
    items,
  };
}

export function normalizeWorkItemInput(input: unknown, index = 0): WorkItemInput {
  const record = requireRecord(input, `work item ${index + 1}`);
  const kind = enumValue(record.kind, WORK_ITEM_KINDS, `work item ${index + 1} kind`);
  const targetBundle = normalizeTargetBundle(record.targetBundle ?? record.target_bundle, `work item ${index + 1} target bundle`);
  const materialPolicy = normalizeMaterialPolicy(record.materialPolicy ?? record.material_policy, targetBundle);
  if ((kind === "benchmark-case" || kind === "regression-replay") && materialPolicy.posture === "blind" && targetBundle.scopeNote) {
    throw new Error(`${kind} blind work items cannot inject a free-form scopeNote; use structured target metadata`);
  }
  const evidenceContract = normalizeEvidenceContract(record.evidenceContract ?? record.evidence_contract, kind);
  if ((kind === "benchmark-case" || kind === "regression-replay") && evidenceContract.expectedOutcome === undefined) {
    throw new Error(`${kind} work items need an explicit evidence expectedOutcome`);
  }
  const projectId = optionalPositiveInteger(record.projectId ?? record.project_id, `work item ${index + 1} projectId`);
  return {
    itemKey: requiredString(record.itemKey ?? record.item_key, `work item ${index + 1} itemKey`),
    kind,
    targetBundle,
    materialPolicy,
    evidenceContract,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

export function normalizeTargetBundle(input: unknown, label = "target bundle"): TargetBundle {
  const record = requireRecord(input, label);
  const targetClass = enumValue(record.targetClass ?? record.target_class ?? "general", TARGET_CLASSES, `${label} targetClass`);
  const sourcePaths = stringList(record.sourcePaths ?? record.source_paths, `${label} sourcePaths`);
  if (sourcePaths.length === 0) throw new Error(`${label} needs at least one source path`);
  const sandboxBackend = optionalString(record.sandboxBackend ?? record.sandbox_backend);
  if (sandboxBackend === "host") throw new Error(`${label} cannot enable host execution; run-group jobs must stay sandboxed`);
  if (sandboxBackend !== undefined && sandboxBackend !== "auto" && sandboxBackend !== "oci" && sandboxBackend !== "apple-container") {
    throw new Error(`${label} sandboxBackend must be auto, oci, or apple-container`);
  }
  const capabilitySurface = record.capabilitySurface ?? record.capability_surface;
  if (targetClass === "capability-surface" && capabilitySurface === undefined) throw new Error(`${label} with targetClass=capability-surface needs capabilitySurface metadata`);
  const normalizedCapabilitySurface = capabilitySurface === undefined ? undefined : normalizeCapabilitySurface(capabilitySurface);
  if (targetClass === "capability-surface" && normalizedCapabilitySurface) {
    for (const [field, values] of Object.entries(normalizedCapabilitySurface)) {
      if (values.length === 0) throw new Error(`${label} capabilitySurface.${field} must not be empty`);
    }
  }
  return {
    target: requiredString(record.target, `${label} target`),
    targetClass,
    sourcePaths,
    corpusPaths: stringList(record.corpusPaths ?? record.corpus_paths, `${label} corpusPaths`),
    ...optionalStringField("buildRoot", record.buildRoot ?? record.build_root),
    ...optionalStringField("scopeNote", record.scopeNote ?? record.scope_note),
    ...optionalStringField("provider", record.provider),
    ...optionalStringField("model", record.model),
    ...optionalStringField("thinking", record.thinking),
    ...optionalNumberField("daemonId", record.daemonId ?? record.daemon_id, true),
    ...optionalBooleanField("mockLlm", record.mockLlm ?? record.mock_llm),
    ...optionalNumberField("maxScopes", record.maxScopes ?? record.max_scopes, true),
    ...optionalNumberField("mapSteps", record.mapSteps ?? record.map_steps, true),
    ...optionalNumberField("mapSamples", record.mapSamples ?? record.map_samples, true),
    ...optionalNumberField("digSteps", record.digSteps ?? record.dig_steps, true),
    ...optionalNumberField("maxSteps", record.maxSteps ?? record.max_steps, true),
    ...optionalNumberField("digSamples", record.digSamples ?? record.dig_samples, true),
    ...optionalNumberField("digMaxSamples", record.digMaxSamples ?? record.dig_max_samples, true),
    ...optionalBooleanField("adaptiveDig", record.adaptiveDig ?? record.adaptive_dig),
    ...optionalBooleanField("eagerPrepare", record.eagerPrepare ?? record.eager_prepare),
    ...optionalNumberField("digConcurrency", record.digConcurrency ?? record.dig_concurrency, true),
    ...(sandboxBackend !== undefined ? { sandboxBackend } : {}),
    ...optionalStringField("sandboxImage", record.sandboxImage ?? record.sandbox_image),
    ...(normalizedCapabilitySurface !== undefined ? { capabilitySurface: normalizedCapabilitySurface } : {}),
    ...(record.claim !== undefined ? { claim: record.claim } : {}),
  };
}

export function normalizeCapabilitySurface(input: unknown): CapabilitySurface {
  const record = requireRecord(input, "capability surface");
  return {
    entrypoints: stringList(record.entrypoints, "capability surface entrypoints"),
    inputs: stringList(record.inputs, "capability surface inputs"),
    effects: stringList(record.effects, "capability surface effects"),
    authorities: stringList(record.authorities, "capability surface authorities"),
    boundaries: stringList(record.boundaries, "capability surface boundaries"),
    localFixtures: stringList(record.localFixtures ?? record.local_fixtures, "capability surface localFixtures"),
  };
}

export function normalizeMaterialPolicy(input: unknown, targetBundle: TargetBundle): MaterialPolicy {
  if (input === undefined || input === null) {
    if (targetBundle.corpusPaths.length > 0) throw new Error("materialPolicy is required when a target bundle includes corpus paths");
    return { posture: "blind", materials: [] };
  }
  const record = requireRecord(input, "material policy");
  const posture = enumValue(record.posture ?? "blind", ["blind", "informed", "open-world", "private"] as const, "material posture");
  const materials = (Array.isArray(record.materials) ? record.materials : []).map((entry, index) => {
    const material = requireRecord(entry, `material ${index + 1}`);
    const normalized: MaterialEntry = {
      path: requiredString(material.path, `material ${index + 1} path`),
      provenance: optionalString(material.provenance) ?? "operator",
      operatorLabel: optionalString(material.operatorLabel ?? material.operator_label) ?? "unknown",
      policyDecision: enumValue(material.policyDecision ?? material.policy_decision ?? "warning", ["included", "excluded", "warning"] as const, `material ${index + 1} policyDecision`),
      reason: optionalString(material.reason) ?? "No reason supplied.",
    };
    if (posture === "blind" && normalized.policyDecision === "included" && riskyBlindLabel(normalized.operatorLabel)) {
      throw new Error(`Blind material policy cannot include ${normalized.operatorLabel}: ${normalized.path}`);
    }
    return normalized;
  });
  const decisionsByPath = new Map<string, MaterialEntry>();
  for (const material of materials) {
    if (decisionsByPath.has(material.path)) throw new Error(`Material policy has duplicate decisions for: ${material.path}`);
    decisionsByPath.set(material.path, material);
  }
  for (const corpusPath of targetBundle.corpusPaths) {
    if (!decisionsByPath.has(corpusPath)) throw new Error(`Material policy must explicitly decide corpus path: ${corpusPath}`);
  }
  for (const material of materials) {
    if (material.policyDecision === "included" && !targetBundle.corpusPaths.includes(material.path)) {
      throw new Error(`Included material is not declared in targetBundle.corpusPaths: ${material.path}`);
    }
  }
  return { posture, materials };
}

function riskyBlindLabel(label: string): boolean {
  const normalized = label.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  return RISKY_BLIND_LABELS.some((risky) => normalized === risky || normalized.startsWith(`${risky}-`) || normalized.endsWith(`-${risky}`));
}

export function normalizeEvidenceContract(input: unknown, kind: WorkItemKind): EvidenceContract {
  const defaults: EvidenceContract = {
    kind: kind === "benchmark-case" ? "benchmark-oracle" : "confirmation-command",
    successPatterns: [],
    failurePatterns: [],
    requiresDifferential: false,
    requiresRefutation: true,
    networkPolicy: "sealed",
  };
  if (input === undefined || input === null) return defaults;
  const record = requireRecord(input, "evidence contract");
  const gateKind = enumValue(record.kind ?? defaults.kind, EVIDENCE_GATE_KINDS, "evidence contract kind");
  const networkPolicy = enumValue(record.networkPolicy ?? record.network_policy ?? defaults.networkPolicy, ["sealed", "open-world-read", "local-only"] as const, "evidence contract networkPolicy");
  const expectedOutcome = record.expectedOutcome ?? record.expected_outcome;
  return {
    kind: gateKind,
    ...optionalStringField("command", record.command),
    successPatterns: stringList(record.successPatterns ?? record.success_patterns, "evidence successPatterns"),
    failurePatterns: stringList(record.failurePatterns ?? record.failure_patterns, "evidence failurePatterns"),
    requiresDifferential: booleanValue(record.requiresDifferential ?? record.requires_differential, defaults.requiresDifferential),
    requiresRefutation: booleanValue(record.requiresRefutation ?? record.requires_refutation, defaults.requiresRefutation),
    networkPolicy,
    ...(expectedOutcome !== undefined ? { expectedOutcome: enumValue(expectedOutcome, ["detect-positive", "reject-positive"] as const, "evidence expectedOutcome") } : {}),
    ...optionalStringField("caseId", record.caseId ?? record.case_id),
    ...optionalStringField("caseFamily", record.caseFamily ?? record.case_family),
    ...optionalStringField("targetStack", record.targetStack ?? record.target_stack),
    ...optionalBooleanField("holdout", record.holdout),
  };
}

export function absolutizeRunGroupManifest(manifest: RunGroupManifest, baseDir: string): RunGroupManifest {
  const absolute = (input: string): string => path.isAbsolute(input) ? path.normalize(input) : path.resolve(baseDir, input);
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      targetBundle: {
        ...item.targetBundle,
        sourcePaths: item.targetBundle.sourcePaths.map(absolute),
        corpusPaths: item.targetBundle.corpusPaths.map(absolute),
        ...(item.targetBundle.buildRoot ? { buildRoot: absolute(item.targetBundle.buildRoot) } : {}),
        ...(item.targetBundle.capabilitySurface
          ? { capabilitySurface: { ...item.targetBundle.capabilitySurface, localFixtures: item.targetBundle.capabilitySurface.localFixtures.map(absolute) } }
          : {}),
      },
      materialPolicy: {
        ...item.materialPolicy,
        materials: item.materialPolicy.materials.map((material) => ({ ...material, path: absolute(material.path) })),
      },
    })),
  };
}

export function capabilitySurfaceScopeNote(surface: CapabilitySurface): string {
  const line = (label: string, values: string[]): string => `${label}: ${values.length ? values.join("; ") : "not supplied"}`;
  return [
    "AUTHORIZED CAPABILITY SURFACE CONTEXT (planning context only; not evidence or a finding).",
    line("Entrypoints", surface.entrypoints),
    line("Untrusted or external inputs", surface.inputs),
    line("Effects", surface.effects),
    line("Authorities", surface.authorities),
    line("Intended boundaries", surface.boundaries),
    "Independently inspect the source and confirm any claim through the normal local execution gate.",
  ].join("\n");
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function optionalRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
}

function requiredString(input: unknown, label: string): string {
  const value = optionalString(input);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function optionalString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function stringList(input: unknown, label: string): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${label} must be a string array`);
  return [...new Set(input.map((value) => String(value).trim()))];
}

function positiveInteger(input: unknown, label: string): number {
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function optionalPositiveInteger(input: unknown, label: string): number | undefined {
  return input === undefined || input === null ? undefined : positiveInteger(input, label);
}

function enumValue<const T extends readonly string[]>(input: unknown, choices: T, label: string): T[number] {
  if (typeof input !== "string" || !choices.includes(input as T[number])) throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  return input as T[number];
}

function booleanValue(input: unknown, fallback: boolean): boolean {
  return typeof input === "boolean" ? input : fallback;
}

function optionalStringField<K extends string>(key: K, input: unknown): { [P in K]?: string } {
  const value = optionalString(input);
  return value === undefined ? {} : { [key]: value } as { [P in K]?: string };
}

function optionalNumberField<K extends string>(key: K, input: unknown, integer: boolean): { [P in K]?: number } {
  if (input === undefined || input === null) return {};
  const value = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) throw new Error(`${key} must be a positive ${integer ? "integer" : "number"}`);
  return { [key]: value } as { [P in K]?: number };
}

function optionalBooleanField<K extends string>(key: K, input: unknown): { [P in K]?: boolean } {
  return typeof input === "boolean" ? { [key]: input } as { [P in K]?: boolean } : {};
}
