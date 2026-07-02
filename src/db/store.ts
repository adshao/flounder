// SQLite metadata store — the system of record for run TRACKING.
//
// flounder writes here on every run (project, run lifecycle, scope coverage, findings, and
// their status transitions, confirm decisions). User-facing structured content and final
// reports live in the DB; large raw evidentiary artifacts stay on disk (transcripts, PoCs,
// provenance, JSON artifacts) with paths recorded for provenance/debugging.
//
// This is NOT a derived/rebuildable projection — it is written live alongside the run.
// node:sqlite is used so the package stays dependency-free. WAL + a busy timeout let one
// flounder process write while a UI (or other flounder processes) read concurrently.

import "./sqlite-quiet.js"; // must run before node:sqlite loads — filters its experimental warning
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A static `import ... from "node:sqlite"` emits the builtin's ExperimentalWarning at link
// time, before sqlite-quiet's body can install the filter. Loading it via require() during
// module evaluation (after the static sqlite-quiet import has run) lets the filter catch it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type RunKind = "run" | "map" | "audit" | "verify" | "confirm" | "prepare" | "report";
export type RunStatus = "running" | "done" | "error" | "killed";
export type ScopeStatus = "pending" | "audited" | "deferred" | "auditing";
export type FindingStatus =
  | "suspected"
  | "needs-evidence"
  | "discharged"
  | "confirmed-executable"
  | "confirmed-differential"
  | "refuted";

export interface ProjectInput {
  name: string;
  sourcePaths?: string[] | undefined; // relative to the project dir
  buildRoot?: string | undefined; // relative to the project dir
  corpusPaths?: string[] | undefined; // relative to the project dir
  config?: unknown; // budgets/max_scopes snapshot the UI can edit (provider/model/thinking now live on the provider profile)
  providerId?: number | undefined; // selected provider profile
  daemonId?: number | undefined; // selected executor daemon; jobs for this project are pinned to it
  dir?: string | undefined; // project subdir under the daemon workspace (default = uuid)
}

export interface ProjectListOptions {
  archived?: boolean | "all" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  search?: string | undefined;
}

export interface RunInput {
  projectId: number;
  kind: RunKind;
  runDir: string;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  budgets?: unknown;
  pid?: number | undefined;
}

export interface ScopeRow {
  scopeId: string;
  title?: string | undefined;
  location?: string | undefined;
  score?: number | undefined;
  priority?: number | undefined; // manual dig-queue ordering (separate from score)
  status: ScopeStatus;
  source?: string | undefined;
  parentScopeId?: string | undefined;
  digSeconds?: number | undefined; // per-scope deep-audit duration (set when it finishes)
}

export interface FindingRow {
  findingKey: string;
  title?: string | undefined;
  location?: string | undefined;
  severity?: string | undefined;
  status: FindingStatus;
  reportPath?: string | undefined;
  reportMarkdown?: string | undefined;
  scopeId?: string | undefined;
  // The rich content the kernel produces (previously only in the run dir's audit_hypotheses /
  // audit_findings artifacts). Persisted so findings are self-contained in the DB — the UI shows
  // full detail and the verify/confirm pipeline feeds on them without scraping run dirs.
  description?: string | undefined;
  evidence?: string | undefined;
  exploitSketch?: string | undefined;
  fix?: string | undefined;
  confidence?: number | undefined;
  // VERIFY: the DB id of the original suspected finding this row's verdict resolves. When set,
  // upsertFindings UPDATES that existing row in place (cross-run) instead of inserting a new one.
  originId?: number | undefined;
}

export interface ConfirmRow {
  bug: string;
  reproduced?: string | undefined;
  recommendation?: string | undefined;
  members?: string[] | undefined;
  severity?: string | undefined;
  evidenceLevel?: string | undefined;
  submissionConfidence?: string | undefined;
  decisionPath?: string | undefined;
  distinctFix?: string | undefined;
  reproEvidence?: string | undefined;
  corroboration?: string | undefined;
  novelty?: string | undefined;
  humanGates?: string | undefined;
  engagementProfile?: unknown;
  adjudication?: unknown;
  mergedFrom?: string[] | undefined;
  reproCommandId?: string | undefined;
  reportMarkdown?: string | undefined;
}

export interface Coverage {
  total: number;
  audited: number;
  pending: number;
  deferred: number;
}

export type DiscoveryBacklogKind = "coverage-gap" | "resource-request" | "followup-scope";
export type DiscoveryBacklogStatus = "open" | "resolved" | "stale" | "ignored";

export interface RunHealthInput {
  status: string;
  reasons: string[];
  signals: Record<string, unknown>;
}

export interface DiscoveryBacklogInput {
  kind: DiscoveryBacklogKind;
  status?: DiscoveryBacklogStatus | undefined;
  scopeId?: string | undefined;
  title?: string | undefined;
  location?: string | undefined;
  reason?: string | undefined;
  nextAction?: string | undefined;
  priority?: string | number | undefined;
  payload?: unknown;
}

export interface DiscoveryBacklogFilter {
  kind?: DiscoveryBacklogKind | undefined;
  status?: DiscoveryBacklogStatus | "all" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

// A provider profile = the model-selection part of the config, named + reusable. A project
// selects one; launch resolves it into provider/model/thinking (+ per-phase overrides for
// the map/dig/refute roles, mirroring AuditorConfig.models / resolveRole).
export type AuditPhase = "map" | "dig" | "refute";
export interface RoleOverride {
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
}
export type ProviderRoles = Partial<Record<AuditPhase, RoleOverride>>;
export interface ProviderInput {
  name: string;
  provider: string;
  model?: string | undefined;
  thinking?: string | undefined;
  roles?: ProviderRoles | undefined;
}
export interface ProviderProfile {
  id: number;
  name: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  roles: ProviderRoles;
  created_at: string;
  updated_at: string;
}

export interface FindingFilter {
  status?: string | undefined; // exact status, e.g. "confirmed-differential"
  search?: string | undefined; // substring match on title or location
}

export interface FindingQuery extends FindingFilter {
  limit?: number | undefined;
  offset?: number | undefined;
}

const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS project(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT UNIQUE NOT NULL,
  source_paths TEXT,              -- now RELATIVE to the project dir (was absolute)
  build_root TEXT,                -- relative to the project dir
  corpus_paths TEXT,              -- relative to the project dir
  config_json TEXT,               -- budgets only now (provider/model/thinking moved to provider profiles)
  provider_id INTEGER,            -- selected provider profile (plain ref; nulled if the profile is deleted)
  daemon_id INTEGER REFERENCES daemon(id), -- selected executor daemon; null = legacy/unpinned
  dir TEXT,                       -- project subdir relative to the daemon's workspace root (default = uuid)
  archived_at TEXT,               -- hidden from the normal project rail; reversible from Settings
  pinned_at TEXT,                 -- pinned projects sort before unpinned projects
  sort_order INTEGER,             -- rail order; new projects are inserted ahead of existing unpinned items
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL,
  run_dir TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  budgets_json TEXT,
  stages_json TEXT,               -- post-dig stage outcomes (synthesis / differential / refutation / discharge-challenge) for the funnel view
  health_status TEXT,             -- latest run-health verdict emitted by the audit kernel
  health_reasons_json TEXT,       -- human-readable reasons for the health verdict
  health_signals_json TEXT,       -- numeric/structured health signals for UI/API triage
  scopes_total INTEGER,
  scopes_audited INTEGER,
  scopes_pending INTEGER,
  run_scopes_target INTEGER,
  run_scopes_done INTEGER,
  findings_total INTEGER,
  started_at TEXT NOT NULL,
  dig_started_at TEXT,            -- map->dig boundary for a combined run (stamped at dig-loop start), so the UI can split map vs dig elapsed
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_project ON run(project_id);

CREATE TABLE IF NOT EXISTS scope(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  scope_id TEXT NOT NULL,
  title TEXT,
  location TEXT,
  score REAL,
  priority INTEGER DEFAULT 0,     -- manual dig-queue ordering (operator "↑ Top"); orders ABOVE score, never overwrites it
  status TEXT NOT NULL,
  source TEXT,                    -- map | followup | coverage-gap; model-proposed provenance for coverage work
  parent_scope_id TEXT,           -- optional parent scope for follow-up work
  dig_seconds INTEGER,            -- per-scope deep-audit duration, set when the scope finishes
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_scope_project ON scope(project_id);

CREATE TABLE IF NOT EXISTS discovery_backlog(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  kind TEXT NOT NULL,             -- coverage-gap | resource-request | followup-scope
  status TEXT NOT NULL DEFAULT 'open',
  scope_id TEXT,
  title TEXT,
  location TEXT,
  reason TEXT,
  next_action TEXT,
  priority TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_project_status ON discovery_backlog(project_id, status);
CREATE INDEX IF NOT EXISTS idx_backlog_project_kind ON discovery_backlog(project_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_run_item ON discovery_backlog(run_id, kind, title, location, scope_id);

CREATE TABLE IF NOT EXISTS finding(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  finding_key TEXT NOT NULL,
  title TEXT,
  location TEXT,
  severity TEXT,
  status TEXT NOT NULL,
  confirm_status TEXT,            -- per-finding real-target confirm state: NULL=not confirmed yet | confirming | reproduced | not-reproduced
  report_path TEXT,
  report_markdown TEXT,           -- user-facing per-finding report markdown; local artifacts are only provenance/debug fallback
  scope_id TEXT,
  description TEXT,               -- the kernel's rich finding content (was only in run-dir artifacts)
  evidence TEXT,
  exploit_sketch TEXT,
  fix TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_project ON finding(project_id);

CREATE TABLE IF NOT EXISTS finding_status_event(
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES finding(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  run_id INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fse_finding ON finding_status_event(finding_id);

CREATE TABLE IF NOT EXISTS confirm_decision(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  bug TEXT NOT NULL,
  reproduced TEXT,
  recommendation TEXT,
  members_json TEXT,
  severity TEXT,
  evidence_level TEXT,
  submission_confidence TEXT,
  distinct_fix TEXT,
  repro_evidence TEXT,
  corroboration TEXT,
  novelty TEXT,
  human_gates TEXT,
  engagement_profile_json TEXT,
  adjudication_json TEXT,
  merged_from_json TEXT,
  repro_command_id TEXT,
  report_markdown TEXT,
  decision_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cd_project ON confirm_decision(project_id);

CREATE TABLE IF NOT EXISTS daemon(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  capabilities TEXT,
  workspace TEXT,                 -- the daemon's workspace root (it resolves project dirs under this)
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job(
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,           -- queued | dispatched | running | done | error | canceled
  daemon_id INTEGER REFERENCES daemon(id),
  run_id INTEGER REFERENCES run(id),
  cancel INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_status ON job(status);

-- A reusable "model strategy" profile a project selects (provider + model + thinking,
-- with optional per-phase overrides for map/dig/refute). No secrets: credentials stay on the
-- daemon via Flounder daemon-local auth; this is just the model-selection part of the config.
CREATE TABLE IF NOT EXISTS provider(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,         -- pi-ai provider id, or claude-code / codex-cli / mock
  model TEXT,                     -- default model for all phases (null = provider default)
  thinking TEXT,                  -- default thinking level
  roles_json TEXT,                -- { map?, dig?, refute? : { provider?, model?, thinking? } }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

function now(): string {
  return new Date().toISOString();
}

function confirmMemberKeys(member: string): string[] {
  const cleaned = member.trim();
  const keys = new Set<string>();
  const add = (value: string): void => {
    const key = value.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (/^k[0-9a-z]+$/.test(key)) keys.add(key);
  };
  add(cleaned);
  const first = cleaned.split(/\s+/)[0] ?? "";
  add(first);
  const bracketed = cleaned.match(/^\[(k[0-9a-z]+)\]/i)?.[1];
  if (bracketed) add(bracketed);
  const embedded = cleaned.match(/\b(k[0-9a-z]+)\b/i)?.[1];
  if (embedded) add(embedded);
  return [...keys];
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function linkedFindingMetadata(
  findingsByKey: Map<string, { severity?: string }> | undefined,
  members: string[],
): Array<{ severity?: string }> {
  if (!findingsByKey) return [];
  const out: Array<{ severity?: string }> = [];
  const seen = new Set<string>();
  for (const member of members) {
    for (const key of confirmMemberKeys(member)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const linked = findingsByKey.get(key);
      if (linked) out.push(linked);
    }
  }
  return out;
}

function maxSeverity(values: Array<string | undefined>): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const raw of values) {
    const normalized = String(raw ?? "").trim().toLowerCase();
    const rank = SEVERITY_RANK[normalized];
    if (rank === undefined || rank <= bestRank) continue;
    best = normalized;
    bestRank = rank;
  }
  return best;
}

const EVIDENCE_LEVEL_RANK: Record<string, number> = {
  unknown: 0,
  "could-not-set-up": 1,
  "not-reproduced": 1,
  reasoned: 2,
  "source-supported": 3,
  "source-only-local-confirmed": 4,
  "locally-reproduced": 4,
  "execution-reproduced": 4,
  "local-fork-reproduced": 5,
  "fork-reproduced": 5,
  "real-target-reproduced": 6,
};

const CONFIDENCE_RANK: Record<string, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function decisionEvidenceText(row: Pick<ConfirmRow, "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): string {
  return [row.reproEvidence, row.humanGates, row.corroboration, row.novelty, structuredText(row.adjudication)].filter(Boolean).join("\n").toLowerCase();
}

function hasSourceOnlyReproductionCrutch(row: Pick<ConfirmRow, "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): boolean {
  const text = decisionEvidenceText(row);
  if (!text) return false;
  return [
    /\bsource[- ]level\b/,
    /\bmock(?:ed|s)?\b/,
    /\bconstrained mock/,
    /\blocal execution\b/,
    /\bpublished source\b/,
    /\bverified deployed source locally\b/,
    /\bimported (?:the )?(?:verified |published )?.*source\b/,
    /\bforge (?:test|tests|poc|harness)\b/,
    /\blocal (?:forge |foundry |hardhat )?harness\b/,
    /\bharness\b.*\bnot a live\b/,
    /\bnot a live\b/,
    /\brather than a live\b/,
    /\bno live\b/,
    /\bwithout (?:a )?live\b/,
    /\bdid not (?:complete|use|fork)\b/,
    /\blive fork (?:was )?not completed\b/,
    /\bexact (?:live |production |deployment )?(?:state|liveness).*not (?:confirmed|established)\b/,
    /\bproduction (?:impact|exposure|severity|configuration).*depends\b/,
    /\bdeployment liveness is not established\b/,
  ].some((pattern) => pattern.test(text));
}

function hasLocalForkReproduction(row: Pick<ConfirmRow, "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): boolean {
  const text = decisionEvidenceText(row);
  return /\b(?:local |mainnet |polygon |ethereum |arbitrum |optimism |base |bsc |avalanche )?fork(?:ed)?\b/.test(text)
    || /\bforked (?:live|mainnet|polygon|ethereum|arbitrum|optimism|base|bsc|avalanche)\b/.test(text);
}

function hasRealTargetReproduction(row: Pick<ConfirmRow, "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): boolean {
  const text = decisionEvidenceText(row);
  return /\breal[- ]target\b/.test(text)
    || /\breal target effect\b/.test(text)
    || /\bactual deployed (?:artifact|contract|code|state)\b/.test(text)
    || /\bcurrent deployment\b/.test(text);
}

function inferredDecisionEvidenceLevel(row: Pick<ConfirmRow, "reproduced" | "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): string {
  if (row.reproduced === "no") return "not-reproduced";
  if (row.reproduced === "could-not-set-up") return "could-not-set-up";
  if (row.reproduced !== "yes") return "unknown";
  if (hasSourceOnlyReproductionCrutch(row)) return "source-only-local-confirmed";
  if (hasLocalForkReproduction(row)) return "local-fork-reproduced";
  if (hasRealTargetReproduction(row)) return "real-target-reproduced";
  return "real-target-reproduced";
}

function shouldDowngradeEvidence(stored: string, inferred: string): boolean {
  const storedRank = EVIDENCE_LEVEL_RANK[stored] ?? 0;
  const inferredRank = EVIDENCE_LEVEL_RANK[inferred] ?? 0;
  return inferred === "source-only-local-confirmed" && storedRank > inferredRank;
}

function decisionEvidenceLevel(row: Pick<ConfirmRow, "reproduced" | "evidenceLevel" | "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): string {
  const inferred = inferredDecisionEvidenceLevel(row);
  const explicit = row.evidenceLevel?.trim();
  if (explicit && !shouldDowngradeEvidence(explicit, inferred)) return explicit;
  return inferred;
}

function isRealTargetEvidenceLevel(value?: string): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "real-target-reproduced" || normalized === "fork-reproduced" || normalized === "local-fork-reproduced";
}

function hasUnsettledSubmissionGate(row: Pick<ConfirmRow, "humanGates" | "adjudication">): boolean {
  const text = String(row.humanGates ?? "").toLowerCase();
  return hasStructuredBlockingGate(row.adjudication)
    || /\b(?:scope|venue|eligib|bounty|live|deployment|production|current|human gate|needs?|not established|not confirmed|unknown|unclear|unverified|pending|review)\b/.test(text);
}

function inferredDecisionSubmissionConfidence(
  row: Pick<ConfirmRow, "reproduced" | "recommendation" | "humanGates" | "adjudication">,
  evidenceLevel: string,
): string {
  if (row.reproduced === "no" || row.recommendation === "drop") return "low";
  if (row.reproduced === "could-not-set-up") return "low";
  if (row.reproduced !== "yes") return "unknown";
  const realTarget = isRealTargetEvidenceLevel(evidenceLevel);
  if (row.recommendation === "submit-candidate") {
    if (!realTarget) return "low";
    return hasUnsettledSubmissionGate(row) ? "medium" : "high";
  }
  if (row.recommendation === "needs-human") return realTarget ? "medium" : "low";
  return realTarget ? "medium" : "low";
}

function decisionSubmissionConfidence(
  row: Pick<ConfirmRow, "reproduced" | "recommendation" | "submissionConfidence" | "humanGates" | "adjudication">,
  evidenceLevel: string,
): string {
  const inferred = inferredDecisionSubmissionConfidence(row, evidenceLevel);
  const explicit = row.submissionConfidence?.trim();
  if (!explicit) return inferred;
  const explicitRank = CONFIDENCE_RANK[explicit] ?? 0;
  const inferredRank = CONFIDENCE_RANK[inferred] ?? 0;
  if (explicitRank > inferredRank && (!isRealTargetEvidenceLevel(evidenceLevel) || hasUnsettledSubmissionGate(row))) return inferred;
  return explicit;
}

function structuredText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hasStructuredBlockingGate(value: unknown): boolean {
  const root = typeof value === "string" ? jsonParseOrNull(value) : value;
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const obj = root as Record<string, unknown>;
  const gateArrays = [obj.gates, obj.required_gates, obj.requiredGates].filter(Array.isArray) as unknown[][];
  for (const gates of gateArrays) {
    for (const gate of gates) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      const status = String((gate as Record<string, unknown>).status ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!status) continue;
      if (["pass", "passed", "yes", "ok", "satisfied", "not-required", "not-applicable", "in-scope", "eligible", "confirmed"].includes(status)) continue;
      return true;
    }
  }
  return false;
}

function decisionConfirmOutcome(row: Pick<ConfirmRow, "reproduced">, evidenceLevel: string): "reproduced" | "not-reproduced" | null {
  if (row.reproduced === "yes" && isRealTargetEvidenceLevel(evidenceLevel)) return "reproduced";
  if (row.reproduced === "no") return "not-reproduced";
  return null;
}

function decisionEvidenceInput(row: {
  reproduced?: string | null;
  recommendation?: string | null;
  evidence_level?: string | null;
  submission_confidence?: string | null;
  repro_evidence?: string | null;
  human_gates?: string | null;
  corroboration?: string | null;
  novelty?: string | null;
  engagement_profile_json?: string | null;
  adjudication_json?: string | null;
}): ConfirmRow {
  return {
    bug: "",
    reproduced: row.reproduced ?? undefined,
    recommendation: row.recommendation ?? undefined,
    evidenceLevel: row.evidence_level ?? undefined,
    submissionConfidence: row.submission_confidence ?? undefined,
    reproEvidence: row.repro_evidence ?? undefined,
    humanGates: row.human_gates ?? undefined,
    corroboration: row.corroboration ?? undefined,
    novelty: row.novelty ?? undefined,
    engagementProfile: row.engagement_profile_json ? jsonParseOrNull(row.engagement_profile_json) : undefined,
    adjudication: row.adjudication_json ? jsonParseOrNull(row.adjudication_json) : undefined,
  };
}

export class MetadataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL + busy timeout: one writer at a time, concurrent readers, retries instead of
    // SQLITE_BUSY when several flounder processes (multi-project) write the shared DB.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    // Additive migrations for DBs created before these columns existed (CREATE IF NOT EXISTS
    // won't add them). Each is a no-op if the column is already present.
    for (const alter of [
      "ALTER TABLE project ADD COLUMN provider_id INTEGER",
      "ALTER TABLE project ADD COLUMN daemon_id INTEGER",
      "ALTER TABLE project ADD COLUMN dir TEXT",
      "ALTER TABLE project ADD COLUMN uuid TEXT",
      "ALTER TABLE project ADD COLUMN archived_at TEXT",
      "ALTER TABLE project ADD COLUMN pinned_at TEXT",
      "ALTER TABLE project ADD COLUMN sort_order INTEGER",
      "ALTER TABLE daemon ADD COLUMN workspace TEXT",
      "ALTER TABLE run ADD COLUMN run_scopes_target INTEGER",
      "ALTER TABLE run ADD COLUMN run_scopes_done INTEGER",
      "ALTER TABLE run ADD COLUMN dig_started_at TEXT", // map->dig boundary for splitting a combined run's elapsed
      "ALTER TABLE scope ADD COLUMN dig_seconds INTEGER", // per-scope deep-audit duration
      "ALTER TABLE scope ADD COLUMN priority INTEGER DEFAULT 0", // manual dig-queue ordering, separate from score
      "ALTER TABLE finding ADD COLUMN tracking_status TEXT", // submission tracking: open|triaging|submitted|accepted|fixed|duplicate|rejected|ignored
      "ALTER TABLE finding ADD COLUMN confirm_status TEXT", // per-finding real-target confirm state
      "ALTER TABLE finding ADD COLUMN report_markdown TEXT", // user-facing per-finding report markdown
      "ALTER TABLE finding ADD COLUMN description TEXT", // rich finding content, previously only in run-dir artifacts
      "ALTER TABLE finding ADD COLUMN evidence TEXT",
      "ALTER TABLE finding ADD COLUMN exploit_sketch TEXT",
      "ALTER TABLE finding ADD COLUMN fix TEXT",
      "ALTER TABLE finding ADD COLUMN confidence REAL",
      "ALTER TABLE run ADD COLUMN stages_json TEXT", // funnel: post-dig stage outcomes
      "ALTER TABLE run ADD COLUMN health_status TEXT", // audit discovery health verdict
      "ALTER TABLE run ADD COLUMN health_reasons_json TEXT",
      "ALTER TABLE run ADD COLUMN health_signals_json TEXT",
      "ALTER TABLE scope ADD COLUMN source TEXT", // map | followup | coverage-gap
      "ALTER TABLE scope ADD COLUMN parent_scope_id TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN distinct_fix TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN repro_evidence TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN corroboration TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN novelty TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN human_gates TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN engagement_profile_json TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN adjudication_json TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN merged_from_json TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN repro_command_id TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN severity TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN evidence_level TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN submission_confidence TEXT",
      "ALTER TABLE confirm_decision ADD COLUMN report_markdown TEXT",
    ]) {
      try {
        this.db.exec(alter);
      } catch {
        // column already exists
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_backlog(
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES project(id),
        run_id INTEGER REFERENCES run(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        scope_id TEXT,
        title TEXT,
        location TEXT,
        reason TEXT,
        next_action TEXT,
        priority TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_project_status ON discovery_backlog(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_backlog_project_kind ON discovery_backlog(project_id, kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_backlog_run_item ON discovery_backlog(run_id, kind, title, location, scope_id);
    `);
    this.ensureProjectUuids();
    this.reconcileConfirmStatuses();
    this.runDataMigrations();
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  private ensureProjectUuids(): void {
    const rows = this.db.prepare("SELECT id FROM project WHERE uuid IS NULL OR uuid = ''").all() as Array<{ id: number }>;
    const update = this.db.prepare("UPDATE project SET uuid = ? WHERE id = ?");
    for (const row of rows) update.run(randomUUID(), row.id);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_uuid ON project(uuid)");
  }

  private reconcileConfirmStatuses(): void {
    const rows = this.db
      .prepare(
        `SELECT project_id, reproduced, members_json, evidence_level, repro_evidence, human_gates,
                corroboration, novelty
           FROM confirm_decision
          WHERE reproduced IN ('yes','no') AND members_json IS NOT NULL`,
      )
      .all() as Array<{
        project_id: number;
        reproduced: string | null;
        members_json: string;
        evidence_level: string | null;
        repro_evidence: string | null;
        human_gates: string | null;
        corroboration: string | null;
        novelty: string | null;
      }>;
    if (rows.length === 0) return;
    const update = this.db.prepare("UPDATE finding SET confirm_status = ? WHERE project_id = ? AND finding_key = ? AND confirm_status IS NULL");
    for (const row of rows) {
      const members = jsonParseOrNull(row.members_json);
      if (!Array.isArray(members)) continue;
      const evidenceLevel = decisionEvidenceLevel(decisionEvidenceInput(row));
      const outcome = decisionConfirmOutcome({ reproduced: row.reproduced ?? undefined }, evidenceLevel);
      if (!outcome) continue;
      for (const member of members) {
        if (typeof member !== "string") continue;
        for (const key of confirmMemberKeys(member)) update.run(outcome, row.project_id, key);
      }
    }
  }

  private runDataMigrations(): void {
    this.transaction(() => {
      this.reconcileFindingReportRunIds();
      this.reconcileRefutedVerifyArtifacts();
      this.reconcileConfirmDecisionReports();
    });
  }

  private reconcileConfirmDecisionReports(): void {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, reproduced, recommendation, members_json, severity,
                evidence_level, submission_confidence, repro_evidence, corroboration,
                novelty, human_gates
           FROM confirm_decision`,
      )
      .all() as Array<{
        id: number;
        project_id: number;
        reproduced: string | null;
        recommendation: string | null;
        members_json: string | null;
        severity: string | null;
        evidence_level: string | null;
        submission_confidence: string | null;
        repro_evidence: string | null;
        corroboration: string | null;
        novelty: string | null;
        human_gates: string | null;
      }>;
    if (rows.length === 0) return;

    const findingsByProject = new Map<number, Map<string, { severity?: string }>>();
    const findingRows = this.db
      .prepare("SELECT project_id, finding_key, severity FROM finding WHERE finding_key IS NOT NULL AND finding_key <> ''")
      .all() as Array<{ project_id: number; finding_key: string; severity: string | null }>;
    for (const finding of findingRows) {
      let byKey = findingsByProject.get(finding.project_id);
      if (!byKey) {
        byKey = new Map();
        findingsByProject.set(finding.project_id, byKey);
      }
      const metadata: { severity?: string } = {};
      if (finding.severity) metadata.severity = finding.severity;
      byKey.set(finding.finding_key.toLowerCase(), metadata);
    }

    const update = this.db.prepare(
      `UPDATE confirm_decision
          SET severity = ?,
              evidence_level = ?,
              submission_confidence = ?
        WHERE id = ?`,
    );
    for (const row of rows) {
      const members = parseJsonArray(row.members_json).filter((member): member is string => typeof member === "string");
      const linked = linkedFindingMetadata(findingsByProject.get(row.project_id), members);
      const input = decisionEvidenceInput(row);
      const evidenceLevel = decisionEvidenceLevel(input);
      update.run(
        row.severity?.trim() || maxSeverity(linked.map((entry) => entry.severity)),
        evidenceLevel,
        decisionSubmissionConfidence(input, evidenceLevel),
        row.id,
      );
    }
  }

  private reconcileFindingReportRunIds(): void {
    const runs = this.db
      .prepare("SELECT id, project_id, kind, run_dir, budgets_json FROM run WHERE run_dir IS NOT NULL AND run_dir <> ''")
      .all() as Array<{ id: number; project_id: number; kind: string; run_dir: string; budgets_json: string | null }>;
    if (runs.length === 0) return;

    const runByDir = new Map<string, number>();
    for (const run of runs) runByDir.set(reportRunKey(run.project_id, run.run_dir), Number(run.id));

    const findings = this.db
      .prepare("SELECT id, project_id, run_id, report_path FROM finding WHERE report_path IS NOT NULL AND report_path <> ''")
      .all() as Array<{ id: number; project_id: number; run_id: number | null; report_path: string }>;
    if (findings.length === 0) return;

    const update = this.db.prepare("UPDATE finding SET run_id = ?, updated_at = ? WHERE id = ?");
    const ts = now();
    for (const finding of findings) {
      const runId = runByDir.get(reportRunKey(finding.project_id, path.dirname(finding.report_path)));
      if (runId !== undefined && finding.run_id !== runId) update.run(runId, ts, finding.id);
    }
  }

  private reconcileRefutedVerifyArtifacts(): void {
    const runs = this.db
      .prepare("SELECT id, project_id, kind, run_dir, budgets_json FROM run WHERE run_dir IS NOT NULL AND run_dir <> ''")
      .all() as Array<{ id: number; project_id: number; kind: string; run_dir: string; budgets_json: string | null }>;
    if (runs.length === 0) return;

    const selectOriginal = this.db.prepare("SELECT id, project_id, title, status FROM finding WHERE id = ?");
    const updateOriginal = this.db.prepare(
      `UPDATE finding SET run_id = ?, title = ?, location = ?, severity = ?, status = ?,
         scope_id = COALESCE(?, scope_id),
         report_markdown = COALESCE(NULLIF(?, ''), report_markdown),
         description = COALESCE(NULLIF(?, ''), description), evidence = COALESCE(NULLIF(?, ''), evidence),
         exploit_sketch = COALESCE(NULLIF(?, ''), exploit_sketch), fix = COALESCE(NULLIF(?, ''), fix),
         confidence = COALESCE(?, confidence), updated_at = ? WHERE id = ? AND project_id = ?`,
    );

    for (const run of runs) {
      const artifacts = [
        ...readFindingArtifact(path.join(run.run_dir, "audit_hypotheses.json")),
        ...readFindingArtifact(path.join(run.run_dir, "audit_findings.json")),
      ];
      for (const artifact of artifacts) {
        const status = artifactTitleIsRefuted(artifact)
          ? "refuted"
          : runIsVerify(run) && artifactStatus(artifact) === "suspected"
            ? "needs-evidence"
            : undefined;
        if (!status) continue;
        const originId = artifactOriginId(artifact);
        if (originId === undefined) continue;
        const original = selectOriginal.get(originId) as { id: number; project_id: number; title: string | null; status: string } | undefined;
        if (!original || original.project_id !== run.project_id || original.status === status) continue;

        const ts = now();
        updateOriginal.run(
          run.id,
          cleanArtifactTitle(stringValue(artifact.title)) ?? original.title ?? null,
          stringValue(artifact.location) ?? null,
          stringValue(artifact.severity) ?? null,
          status,
          stringValue(artifact.scopeId) ?? null,
          "", // refuted hypotheses do not have a submit-ready report body.
          stringValue(artifact.description) ?? null,
          stringValue(artifact.evidence) ?? null,
          stringValue(artifact.exploitSketch) ?? null,
          stringValue(artifact.fix) ?? null,
          numberValue(artifact.confidence),
          ts,
          original.id,
          run.project_id,
        );
        this.recordStatusEvent(original.id, original.status, status, "verify artifact migration", run.id, ts);
      }
    }
  }

  /** Open the store for a config's output root (DB lives at <outputDir>/flounder.db). */
  static openForOutput(outputDir: string): MetadataStore {
    return new MetadataStore(path.join(outputDir, "flounder.db"));
  }

  close(): void {
    this.db.close();
  }

  // --- projects -------------------------------------------------------------

  /** Upsert a project by name; refreshes its materials + config snapshot. Returns its id. */
  upsertProject(input: ProjectInput): number {
    const ts = now();
    const projectUuid = randomUUID();
    const hasExplicitDir = input.dir !== undefined;
    const insertSortOrder = this.nextProjectSortOrder();
    this.db
      .prepare(
        `INSERT INTO project(uuid, name, source_paths, build_root, corpus_paths, config_json, provider_id, daemon_id, dir, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           source_paths = excluded.source_paths,
           build_root   = excluded.build_root,
           corpus_paths = excluded.corpus_paths,
           config_json  = excluded.config_json,
           -- provider_id / daemon_id / dir are preserved unless the caller explicitly updates them.
           -- A run (which upserts with only name+config) must not wipe the selection the UI made.
           provider_id  = COALESCE(excluded.provider_id, project.provider_id),
           daemon_id    = COALESCE(excluded.daemon_id, project.daemon_id),
           dir          = CASE WHEN ? THEN excluded.dir ELSE project.dir END,
           updated_at   = excluded.updated_at`,
      )
      .run(
        projectUuid,
        input.name,
        jsonOrNull(input.sourcePaths),
        input.buildRoot ?? null,
        jsonOrNull(input.corpusPaths),
        jsonOrNull(input.config),
        input.providerId ?? null,
        input.daemonId ?? null,
        input.dir ?? projectUuid,
        insertSortOrder,
        ts,
        ts,
        hasExplicitDir ? 1 : 0,
      );
    const row = this.db.prepare("SELECT id FROM project WHERE name = ?").get(input.name) as { id: number };
    return row.id;
  }

  listProjects(options: ProjectListOptions = {}): Array<Record<string, unknown>> {
    const { where, args } = projectListWhere(options);
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : undefined;
    const offset = typeof options.offset === "number" && Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0;
    const page = limit === undefined ? "" : " LIMIT ? OFFSET ?";
    const pageArgs = limit === undefined ? [] : [limit, offset];
    return this.db
      .prepare(
        `SELECT * FROM project ${where}
         ORDER BY
           CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END ASC,
           CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END ASC,
           sort_order ASC,
           created_at DESC,
           id DESC${page}`,
      )
      .all(...args, ...pageArgs) as Array<Record<string, unknown>>;
  }

  countProjects(options: ProjectListOptions = {}): number {
    const { where, args } = projectListWhere(options);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM project ${where}`).get(...args) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private nextProjectSortOrder(): number {
    const row = this.db.prepare("SELECT MIN(sort_order) AS min_order FROM project WHERE archived_at IS NULL").get() as { min_order: number | null } | undefined;
    return typeof row?.min_order === "number" ? row.min_order - 10 : 0;
  }

  getProject(name: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM project WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  }

  getProjectById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM project WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  getProjectByUuid(uuid: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM project WHERE uuid = ?").get(uuid) as Record<string, unknown> | undefined;
  }

  /** Resolve public UI/API project refs. Project URLs are UUID-only; names are display text. */
  getProjectByRef(ref: string): Record<string, unknown> | undefined {
    return this.getProjectByUuid(ref);
  }

  setProjectArchived(ref: string, archived: boolean): boolean {
    const project = this.getProjectByRef(ref);
    if (!project) return false;
    const ts = now();
    const info = archived
      ? this.db.prepare("UPDATE project SET archived_at = ?, pinned_at = NULL, updated_at = ? WHERE id = ?").run(ts, ts, Number(project.id))
      : this.db.prepare("UPDATE project SET archived_at = NULL, updated_at = ? WHERE id = ?").run(ts, Number(project.id));
    return Number(info.changes) > 0;
  }

  setProjectPinned(ref: string, pinned: boolean): boolean {
    const project = this.getProjectByRef(ref);
    if (!project) return false;
    const info = this.db
      .prepare("UPDATE project SET pinned_at = ?, updated_at = ? WHERE id = ?")
      .run(pinned ? now() : null, now(), Number(project.id));
    return Number(info.changes) > 0;
  }

  setProjectSortOrder(ref: string, sortOrder: number | null): boolean {
    const project = this.getProjectByRef(ref);
    if (!project) return false;
    const value = typeof sortOrder === "number" && Number.isFinite(sortOrder) ? Math.floor(sortOrder) : null;
    const info = this.db
      .prepare("UPDATE project SET sort_order = ?, updated_at = ? WHERE id = ?")
      .run(value, now(), Number(project.id));
    return Number(info.changes) > 0;
  }

  reorderProjects(uuids: string[]): number {
    let changed = 0;
    const update = this.db.prepare("UPDATE project SET sort_order = ?, updated_at = ? WHERE uuid = ? AND archived_at IS NULL");
    const ts = now();
    this.transaction(() => {
      uuids.forEach((uuid, index) => {
        if (!uuid) return;
        changed += Number(update.run(index * 10, ts, uuid).changes);
      });
    });
    return changed;
  }

  /** Delete a project and everything under it (runs, scopes, findings + their status
   * events, confirm decisions). Returns true if a project was removed. */
  deleteProject(ref: string): boolean {
    const project = this.getProjectByRef(ref);
    if (!project) return false;
    const id = Number(project.id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM finding_status_event WHERE finding_id IN (SELECT id FROM finding WHERE project_id = ?)").run(id);
      this.db.prepare("DELETE FROM finding WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM scope WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM discovery_backlog WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM confirm_decision WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM job WHERE project = ?").run(String(project.name)); // jobs FK-reference runs
      this.db.prepare("DELETE FROM run WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
    });
    return true;
  }

  // --- runs -----------------------------------------------------------------

  /** Record the start of a run (status=running). Returns the run id. */
  startRun(input: RunInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO run(project_id, kind, run_dir, status, pid, provider, model, thinking, budgets_json, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.kind,
        input.runDir,
        input.pid ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.thinking ?? null,
        jsonOrNull(input.budgets),
        now(),
      );
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, status: RunStatus, coverage?: Coverage, findingsTotal?: number): void {
    this.db
      .prepare(
        `UPDATE run SET status = ?, ended_at = ?, scopes_total = ?, scopes_audited = ?, scopes_pending = ?, findings_total = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        status,
        now(),
        coverage?.total ?? null,
        coverage?.audited ?? null,
        coverage?.pending ?? null,
        findingsTotal ?? null,
        runId,
      );
  }

  setRunPid(runId: number, pid: number): void {
    this.db.prepare("UPDATE run SET pid = ? WHERE id = ?").run(pid, runId);
  }

  /** Mark every still-`running` run as ended. Runs execute in the server process, so a
   * server restart ends them all — call this on startup so orphaned rows do not show as
   * running forever. Returns rows changed. */
  reconcileOrphanedRuns(status: RunStatus = "killed"): number {
    const info = this.db.prepare("UPDATE run SET status = ?, ended_at = ? WHERE status = 'running'").run(status, now());
    return Number(info.changes);
  }

  /** Mark a still-running run for this OS pid as ended (a supervisor saw the process exit
   * without the run reaching `done`). No-op if it already finished. Returns rows changed. */
  reconcileRunByPid(pid: number, status: RunStatus): number {
    const info = this.db
      .prepare("UPDATE run SET status = ?, ended_at = ? WHERE pid = ? AND status = 'running'")
      .run(status, now(), pid);
    return Number(info.changes);
  }

  reconcileTerminalRun(id: number, status: RunStatus): number {
    const info = this.db
      .prepare("UPDATE run SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status != 'running'")
      .run(status, now(), id);
    return Number(info.changes);
  }

  /** Live coverage update mid-run (so a UI shows mapped/audited progress as digs land). */
  updateRunCoverage(runId: number, coverage: Coverage): void {
    this.db
      .prepare("UPDATE run SET scopes_total = ?, scopes_audited = ?, scopes_pending = ? WHERE id = ?")
      .run(coverage.total, coverage.audited, coverage.pending, runId);
  }

  /** Per-run dig batch: how many scopes THIS run is digging (target) and how many it has
   * completed (done) — distinct from the project-cumulative scopes_* above. The FIRST call
   * (dig-loop start, done=0) also stamps dig_started_at = the map->dig boundary, so the UI can
   * split a combined map->dig run's elapsed into the two phases. COALESCE keeps it fixed. */
  updateRunScopes(runId: number, done: number, target: number): void {
    this.db
      .prepare("UPDATE run SET run_scopes_done = ?, run_scopes_target = ?, dig_started_at = COALESCE(dig_started_at, ?) WHERE id = ?")
      .run(done, target, now(), runId);
  }

  updateRunScopesTarget(runId: number, target: number): void {
    this.db.prepare("UPDATE run SET run_scopes_target = ? WHERE id = ?").run(target, runId);
  }

  /** Record one post-dig STAGE's outcome on the run (synthesis / differential / refutation /
   * discharge-challenge), merged into stages_json keyed by stage name, for the funnel view. */
  recordStage(runId: number, name: string, info: Record<string, unknown>): void {
    const row = this.db.prepare("SELECT stages_json FROM run WHERE id = ?").get(runId) as { stages_json?: string } | undefined;
    let stages: Record<string, unknown> = {};
    try { if (row?.stages_json) stages = JSON.parse(row.stages_json) as Record<string, unknown>; } catch { /* reset on corruption */ }
    const ts = now();
    const previous = stages[name] && typeof stages[name] === "object" ? (stages[name] as Record<string, unknown>) : {};
    const previousStartedAt = typeof previous.startedAt === "string" ? previous.startedAt : undefined;
    const startedAt = previousStartedAt ?? (info.status === "running" ? ts : undefined);
    stages[name] = { ...previous, ...info, ...(startedAt ? { startedAt } : {}), at: ts };
    this.db.prepare("UPDATE run SET stages_json = ? WHERE id = ?").run(JSON.stringify(stages), runId);
  }

  recordRunHealth(runId: number, health: RunHealthInput): void {
    this.db
      .prepare("UPDATE run SET health_status = ?, health_reasons_json = ?, health_signals_json = ? WHERE id = ?")
      .run(health.status, JSON.stringify(health.reasons), JSON.stringify(health.signals), runId);
  }

  listRuns(projectId?: number, limit?: number): Array<Record<string, unknown>> {
    const tail = typeof limit === "number" ? " LIMIT " + Math.max(1, Math.floor(limit)) : "";
    return projectId === undefined
      ? (this.db.prepare("SELECT * FROM run ORDER BY started_at DESC" + tail).all() as Array<Record<string, unknown>>)
      : (this.db.prepare("SELECT * FROM run WHERE project_id = ? ORDER BY started_at DESC" + tail).all(projectId) as Array<Record<string, unknown>>);
  }

  // Aggregates for the dashboard snapshot — cheap regardless of how many runs/findings a
  // project has, so the live SSE tick does not reload every row each second.
  countRuns(projectId: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM run WHERE project_id = ?").get(projectId) as { n: number }).n);
  }

  latestRun(projectId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
  }

  getRun(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM run WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  latestPrepareAfterRun(projectId: number, runId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT newer.* FROM run newer
         JOIN run source ON source.id = ?
         WHERE newer.project_id = ?
           AND newer.kind = 'prepare'
           AND newer.started_at > source.started_at
         ORDER BY newer.started_at DESC
         LIMIT 1`,
      )
      .get(runId, projectId) as Record<string, unknown> | undefined;
  }

  /** Delete a run and its run-scoped children (findings + their status events, confirm
   * decisions). Scopes are project-level (the persisted inventory) and are left intact.
   * On-disk run artifacts are untouched. Returns true if a run was removed. */
  deleteRun(id: number): boolean {
    if (!this.getRun(id)) return false;
    this.transaction(() => {
      this.db.prepare("DELETE FROM finding_status_event WHERE finding_id IN (SELECT id FROM finding WHERE run_id = ?)").run(id);
      this.db.prepare("DELETE FROM finding WHERE run_id = ?").run(id);
      this.db.prepare("DELETE FROM discovery_backlog WHERE run_id = ?").run(id);
      this.db.prepare("DELETE FROM confirm_decision WHERE run_id = ?").run(id);
      this.db.prepare("UPDATE job SET run_id = NULL WHERE run_id = ?").run(id); // keep the job record, drop the dangling ref
      this.db.prepare("DELETE FROM run WHERE id = ?").run(id);
    });
    return true;
  }

  // --- scopes ---------------------------------------------------------------

  /** Upsert the project's scope inventory (id, title, location, score, status, dig_seconds).
   * updated_at advances ONLY when a scope's status actually changes — the dig re-upserts the
   * whole inventory after every scope, and re-stamping all of them would make each audited scope
   * show the same (latest) time instead of when IT finished. dig_seconds is COALESCE-kept so a
   * later inventory-wide upsert that omits it doesn't wipe a scope's recorded duration. */
  upsertScopes(projectId: number, scopes: ScopeRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO scope(project_id, scope_id, title, location, score, priority, status, source, parent_scope_id, dig_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, scope_id) DO UPDATE SET
         title = excluded.title, location = excluded.location, score = excluded.score,
         status = excluded.status,
         priority = COALESCE(excluded.priority, scope.priority),
         source = COALESCE(excluded.source, scope.source),
         parent_scope_id = COALESCE(excluded.parent_scope_id, scope.parent_scope_id),
         dig_seconds = COALESCE(excluded.dig_seconds, scope.dig_seconds),
         updated_at = CASE WHEN scope.status != excluded.status THEN excluded.updated_at ELSE scope.updated_at END`,
    );
    const ts = now();
    this.transaction(() => {
      for (const s of scopes) {
        stmt.run(projectId, s.scopeId, s.title ?? null, s.location ?? null, s.score ?? null, s.priority ?? null, s.status, s.source ?? null, s.parentScopeId ?? null, s.digSeconds ?? null, ts);
      }
    });
  }

  /** Replace the active project inventory with a complete scope snapshot.
   * Map/dig checkpoints report the full current inventory, not a partial diff; replacing
   * prevents obsolete scopes from older maps from leaking into current coverage. */
  replaceScopes(projectId: number, scopes: ScopeRow[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO scope(project_id, scope_id, title, location, score, priority, status, source, parent_scope_id, dig_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, scope_id) DO UPDATE SET
         title = excluded.title, location = excluded.location, score = excluded.score,
         status = excluded.status,
         priority = COALESCE(excluded.priority, scope.priority),
         source = COALESCE(excluded.source, scope.source),
         parent_scope_id = COALESCE(excluded.parent_scope_id, scope.parent_scope_id),
         dig_seconds = COALESCE(excluded.dig_seconds, scope.dig_seconds),
         updated_at = CASE WHEN scope.status != excluded.status THEN excluded.updated_at ELSE scope.updated_at END`,
    );
    const ts = now();
    this.transaction(() => {
      if (scopes.length === 0) {
        this.db.prepare("DELETE FROM scope WHERE project_id = ?").run(projectId);
        return;
      }
      for (const s of scopes) {
        upsert.run(projectId, s.scopeId, s.title ?? null, s.location ?? null, s.score ?? null, s.priority ?? null, s.status, s.source ?? null, s.parentScopeId ?? null, s.digSeconds ?? null, ts);
      }
      const ids = scopes.map((scope) => scope.scopeId);
      const placeholders = ids.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM scope WHERE project_id = ? AND scope_id NOT IN (${placeholders})`).run(projectId, ...ids);
    });
  }

  listScopes(projectId: number): Array<Record<string, unknown>> {
    // dig order: manual priority first, then score (status groups the display).
    return this.db.prepare("SELECT * FROM scope WHERE project_id = ? ORDER BY status, priority DESC, score DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  countScopes(projectId: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM scope WHERE project_id = ?").get(projectId) as { n: number }).n);
  }

  countScopesByStatus(projectId: number, status: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM scope WHERE project_id = ? AND status = ?").get(projectId, status) as { n: number }).n);
  }

  queryScopes(projectId: number, opts: { limit?: number; offset?: number } = {}): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    return this.db
      .prepare("SELECT * FROM scope WHERE project_id = ? ORDER BY status, priority DESC, score DESC LIMIT ? OFFSET ?")
      .all(projectId, limit, offset) as Array<Record<string, unknown>>;
  }

  scopeProgress(projectId: number): Coverage {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'audited' THEN 1 ELSE 0 END) AS audited,
                SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS deferred
         FROM scope WHERE project_id = ?`,
      )
      .get(projectId) as { total: number; audited: number | null; deferred: number | null };
    const total = row.total ?? 0;
    const audited = row.audited ?? 0;
    const deferred = row.deferred ?? 0;
    return { total, audited, deferred, pending: total - audited - deferred };
  }

  /** Set a scope's status (e.g. mark "deferred" to skip it in auto-dig). Returns rows changed. */
  setScopeStatus(projectId: number, scopeId: string, status: ScopeStatus): number {
    const info = this.db
      .prepare("UPDATE scope SET status = ?, updated_at = ? WHERE project_id = ? AND scope_id = ?")
      .run(status, now(), projectId, scopeId);
    return Number(info.changes);
  }

  /** Clear the current scope projection when project materials are refreshed. Run artifacts keep
   * the historical inventory; this table represents the active material snapshot only. */
  clearScopes(projectId: number): number {
    const info = this.db.prepare("DELETE FROM scope WHERE project_id = ?").run(projectId);
    return Number(info.changes);
  }

  /** Recover scopes left in-flight by a killed daemon or interrupted server process. */
  resetAuditingScopes(projectId: number): number {
    const info = this.db
      .prepare("UPDATE scope SET status = 'pending', updated_at = ? WHERE project_id = ? AND status = 'auditing'")
      .run(now(), projectId);
    return Number(info.changes);
  }

  /** Hand-order the dig queue: bump a scope's PRIORITY one above the project's current max so the
   * dig (which orders by priority then score) audits it next. Leaves the map's score untouched —
   * priority is a separate manual-ordering axis. Returns true if the scope exists. */
  prioritizeScope(projectId: number, scopeId: string): boolean {
    const top = (this.db.prepare("SELECT COALESCE(MAX(priority), 0) AS m FROM scope WHERE project_id = ?").get(projectId) as { m: number }).m;
    return this.db
      .prepare("UPDATE scope SET priority = ?, updated_at = ? WHERE project_id = ? AND scope_id = ?")
      .run(top + 1, now(), projectId, scopeId).changes > 0;
  }

  // --- discovery health + backlog -----------------------------------------

  replaceDiscoveryBacklog(projectId: number, runId: number, rows: DiscoveryBacklogInput[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM discovery_backlog WHERE run_id = ?").run(runId);
      if (rows.length === 0) return;
      const stmt = this.db.prepare(
        `INSERT INTO discovery_backlog(project_id, run_id, kind, status, scope_id, title, location, reason, next_action, priority, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = now();
      for (const row of rows) {
        stmt.run(
          projectId,
          runId,
          row.kind,
          normalizeDiscoveryBacklogStatus(row.status),
          row.scopeId ?? null,
          row.title ?? null,
          row.location ?? null,
          row.reason ?? null,
          row.nextAction ?? null,
          row.priority === undefined ? null : String(row.priority),
          jsonOrNull(row.payload),
          ts,
          ts,
        );
      }
    });
  }

  listDiscoveryBacklog(projectId: number, filter: DiscoveryBacklogFilter = {}): Array<Record<string, unknown>> {
    const clauses = ["b.project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (filter.kind) {
      clauses.push("b.kind = ?");
      params.push(filter.kind);
    }
    if (filter.status && filter.status !== "all") {
      clauses.push("b.status = ?");
      params.push(filter.status);
    }
    const limit = Math.max(1, Math.floor(filter.limit ?? 100));
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    return this.db
      .prepare(
        `SELECT b.*, r.kind AS run_kind, r.started_at AS run_started_at
           FROM discovery_backlog b
           LEFT JOIN run r ON r.id = b.run_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY CASE b.status WHEN 'open' THEN 0 WHEN 'stale' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
                   b.updated_at DESC, b.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
  }

  discoveryBacklogCounts(projectId: number): Record<string, number> {
    const out: Record<string, number> = { total: 0, open: 0 };
    const rows = this.db
      .prepare("SELECT kind, status, COUNT(*) AS n FROM discovery_backlog WHERE project_id = ? GROUP BY kind, status")
      .all(projectId) as Array<{ kind: string; status: string; n: number }>;
    for (const row of rows) {
      const n = Number(row.n);
      out.total = (out.total ?? 0) + n;
      out[`${row.kind}:${row.status}`] = n;
      if (row.status === "open") {
        out.open = (out.open ?? 0) + n;
        out[row.kind] = (out[row.kind] ?? 0) + n;
      }
    }
    return out;
  }

  countDiscoveryBacklog(projectId: number, filter: DiscoveryBacklogFilter = {}): number {
    const clauses = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status && filter.status !== "all") {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM discovery_backlog WHERE ${clauses.join(" AND ")}`).get(...params) as { n: number }).n);
  }

  setDiscoveryBacklogStatus(id: number, status: DiscoveryBacklogStatus): boolean {
    return this.db
      .prepare("UPDATE discovery_backlog SET status = ?, updated_at = ? WHERE id = ?")
      .run(normalizeDiscoveryBacklogStatus(status), now(), id).changes > 0;
  }

  latestRunHealth(projectId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT id, kind, status AS run_status, health_status, health_reasons_json, health_signals_json, started_at, ended_at
           FROM run
          WHERE project_id = ? AND health_status IS NOT NULL AND health_status <> ''
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
  }

  // --- findings + status transitions ---------------------------------------

  /**
   * Upsert findings for a run. When a finding's status changes (or it is new), records a
   * row in finding_status_event so the UI can show the suspect→confirm→refute timeline.
   */
  upsertFindings(projectId: number, runId: number, findings: FindingRow[], reason?: string): void {
    this.transaction(() => {
      for (const f of findings) {
        const ts = now();
        // VERIFY verdict: flip the ORIGINAL suspected finding in place (cross-run). The link is
        // carried (originId = that finding's DB id), so a verify session that renamed the title still
        // updates the right row — status + the PoC writeup — instead of inserting a duplicate.
        if (f.originId != null) {
          const orig = this.db.prepare("SELECT id, status FROM finding WHERE id = ?").get(f.originId) as { id: number; status: string } | undefined;
          if (orig) {
            this.db
              .prepare(
                `UPDATE finding SET run_id = ?, finding_key = ?, title = ?, location = ?, severity = ?, status = ?,
                   report_path = COALESCE(?, report_path), scope_id = ?,
                   report_markdown = COALESCE(NULLIF(?, ''), report_markdown),
                   description = COALESCE(NULLIF(?, ''), description), evidence = COALESCE(NULLIF(?, ''), evidence),
                   exploit_sketch = COALESCE(NULLIF(?, ''), exploit_sketch), fix = COALESCE(NULLIF(?, ''), fix),
                   confidence = COALESCE(?, confidence), updated_at = ? WHERE id = ?`,
              )
              .run(
                runId,
                f.findingKey,
                f.title ?? null,
                f.location ?? null,
                f.severity ?? null,
                f.status,
                f.reportPath ?? null,
                f.scopeId ?? null,
                f.reportMarkdown ?? null,
                f.description ?? null,
                f.evidence ?? null,
                f.exploitSketch ?? null,
                f.fix ?? null,
                f.confidence ?? null,
                ts,
                orig.id,
              );
            if (orig.status !== f.status) this.recordStatusEvent(orig.id, orig.status, f.status, reason, runId, ts);
            continue;
          }
          // stale origin id (the row was deleted) -> fall through and capture the verdict as its own row
        }
        const existing = this.db
          .prepare("SELECT id, status FROM finding WHERE run_id = ? AND finding_key = ?")
          .get(runId, f.findingKey) as { id: number; status: string } | undefined;
        if (!existing) {
          const info = this.db
            .prepare(
              `INSERT INTO finding(project_id, run_id, finding_key, title, location, severity, status, report_path, report_markdown, scope_id, description, evidence, exploit_sketch, fix, confidence, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(projectId, runId, f.findingKey, f.title ?? null, f.location ?? null, f.severity ?? null, f.status, f.reportPath ?? null, f.reportMarkdown ?? null, f.scopeId ?? null, f.description ?? null, f.evidence ?? null, f.exploitSketch ?? null, f.fix ?? null, f.confidence ?? null, ts, ts);
          this.recordStatusEvent(Number(info.lastInsertRowid), null, f.status, reason, runId, ts);
        } else {
          // COALESCE(NULLIF(?, ''), col): keep the stored content when a later re-persist (a status
          // flip through differential / refutation / appeal) carries an empty value, so detail is
          // never wiped — mirrors the dig_seconds keep-on-omit rule.
          this.db
            .prepare(
              `UPDATE finding SET title = ?, location = ?, severity = ?, status = ?, report_path = ?, report_markdown = COALESCE(NULLIF(?, ''), report_markdown), scope_id = ?,
                 description = COALESCE(NULLIF(?, ''), description),
                 evidence = COALESCE(NULLIF(?, ''), evidence),
                 exploit_sketch = COALESCE(NULLIF(?, ''), exploit_sketch),
                 fix = COALESCE(NULLIF(?, ''), fix),
                 confidence = COALESCE(?, confidence),
                 updated_at = ? WHERE id = ?`,
            )
            .run(f.title ?? null, f.location ?? null, f.severity ?? null, f.status, f.reportPath ?? null, f.reportMarkdown ?? null, f.scopeId ?? null, f.description ?? null, f.evidence ?? null, f.exploitSketch ?? null, f.fix ?? null, f.confidence ?? null, ts, existing.id);
          if (existing.status !== f.status) {
            this.recordStatusEvent(existing.id, existing.status, f.status, reason, runId, ts);
          }
        }
      }
    });
  }

  private recordStatusEvent(findingId: number, from: string | null, to: string, reason: string | undefined, runId: number, ts: string): void {
    this.db
      .prepare("INSERT INTO finding_status_event(finding_id, from_status, to_status, reason, run_id, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(findingId, from, to, reason ?? null, runId, ts);
  }

  listFindings(projectId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  getFinding(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT f.*, p.name AS project_name, p.uuid AS project_uuid FROM finding f JOIN project p ON p.id = f.project_id WHERE f.id = ?").get(id) as Record<string, unknown> | undefined;
  }

  // --- global (cross-project) bug view -------------------------------------

  /** Findings across ALL projects (joined with the project name), newest first, optionally
   * filtered by project, status, and/or tracking state. The "Bugs" dashboard's table. */
  listGlobalFindings(opts: { projectUuid?: string | undefined; status?: string | undefined; tracking?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Array<Record<string, unknown>> {
    const cond: string[] = [], params: Array<string | number> = [];
    if (opts.projectUuid) { cond.push("p.uuid = ?"); params.push(opts.projectUuid); }
    if (opts.status) { cond.push("f.status = ?"); params.push(opts.status); }
    if (opts.tracking) { cond.push("COALESCE(f.tracking_status, 'open') = ?"); params.push(opts.tracking); }
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    const limit = Math.max(1, Math.floor(opts.limit ?? 200));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    return this.db
      .prepare("SELECT f.*, p.name AS project_name, p.uuid AS project_uuid FROM finding f JOIN project p ON p.id = f.project_id " + where + " ORDER BY f.updated_at DESC LIMIT ? OFFSET ?")
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
  }

  /** Aggregate counts for the Bugs dashboard: total findings, a breakdown by status, and a
   * breakdown by tracking state (untracked findings count as 'open'). */
  globalFindingStats(): { total: number; byStatus: Record<string, number>; byTracking: Record<string, number> } {
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM finding GROUP BY status").all() as Array<{ status: string; n: number }>) byStatus[r.status] = Number(r.n);
    const byTracking: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT COALESCE(tracking_status, 'open') AS t, COUNT(*) AS n FROM finding GROUP BY t").all() as Array<{ t: string; n: number }>) byTracking[r.t] = Number(r.n);
    const total = Number((this.db.prepare("SELECT COUNT(*) AS n FROM finding").get() as { n: number }).n);
    return { total, byStatus, byTracking };
  }

  /** Update a finding's submission-tracking state (does NOT touch updated_at, so the audit
   * "found" time and newest-first ordering are preserved). */
  setFindingTracking(id: number, status: string): boolean {
    return this.db.prepare("UPDATE finding SET tracking_status = ? WHERE id = ?").run(status || null, id).changes > 0;
  }

  /** Persist a user-facing formal report for one finding. The project id guard preserves
   * server/daemon separation: a daemon can only update findings for the run's project. */
  setFindingReport(projectId: number, findingId: number, markdown: string): boolean {
    return this.db.prepare("UPDATE finding SET report_markdown = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(markdown, now(), projectId, findingId).changes > 0;
  }

  // --- per-finding confirm (real-target reproduction) -----------------------

  /** The project's findings that are confirmed by the audit (source-level) but NOT yet decided on
   * the real target — the work list for a project-level confirm. Carries both the original run dir
   * and the latest report_path so the control plane can route Confirm to the run holding the PoC/fix
   * artifact. confirm_status NULL = pending. */
  pendingConfirmable(projectId: number): Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null }> {
    return this.db
      .prepare(
        `SELECT f.id, f.finding_key, f.title, f.run_id, r.run_dir, f.report_path
           FROM finding f LEFT JOIN run r ON r.id = f.run_id
          WHERE f.project_id = ? AND f.confirm_status IS NULL
            AND COALESCE(f.tracking_status, 'open') <> 'ignored'
            AND f.status IN ('confirmed-differential','confirmed-executable','confirmed-source')
          ORDER BY f.status, f.id`,
      )
      .all(projectId) as Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null }>;
  }

  /** All audit-confirmed findings that belong in a project-level confirm context, including
   * findings that already have a real-target decision. Confirm needs this complete set so later
   * batches can consolidate newly pending findings against prior reproduced/not-reproduced rows. */
  confirmableContext(projectId: number): Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null; confirm_status: string | null }> {
    return this.db
      .prepare(
        `SELECT f.id, f.finding_key, f.title, f.run_id, r.run_dir, f.report_path, f.confirm_status
           FROM finding f LEFT JOIN run r ON r.id = f.run_id
          WHERE f.project_id = ?
            AND COALESCE(f.tracking_status, 'open') <> 'ignored'
            AND f.status IN ('confirmed-differential','confirmed-executable','confirmed-source')
          ORDER BY f.status, f.id`,
      )
      .all(projectId) as Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null; confirm_status: string | null }>;
  }

  /** One pending confirmable finding by project + id (for finding-level confirm). */
  getConfirmable(projectId: number, findingId: number): { id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT f.id, f.finding_key, f.title, f.run_id, r.run_dir, f.report_path
           FROM finding f LEFT JOIN run r ON r.id = f.run_id
          WHERE f.project_id = ? AND f.id = ? AND f.confirm_status IS NULL
            AND COALESCE(f.tracking_status, 'open') <> 'ignored'
            AND f.status IN ('confirmed-differential','confirmed-executable','confirmed-source')`,
      )
      .get(projectId, findingId) as { id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null } | undefined;
  }

  /** Set a finding's real-target confirm state, addressed by its content key within a project
   * (the same key the confirm work list carries). Does not touch updated_at. */
  setFindingConfirmStatus(projectId: number, findingKey: string, confirmStatus: string | null): boolean {
    return this.db
      .prepare("UPDATE finding SET confirm_status = ? WHERE project_id = ? AND finding_key = ?")
      .run(confirmStatus, projectId, findingKey).changes > 0;
  }

  /** Finding counts per status — one GROUP BY, for the dashboard + filter chips. */
  findingStatusCounts(projectId: number): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM finding WHERE project_id = ? GROUP BY status").all(projectId) as Array<{ status: string; n: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  countFindings(projectId: number, filter: FindingFilter = {}): number {
    const where = findingWhere(projectId, filter);
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM finding " + where.sql).get(...where.params) as { n: number }).n);
  }

  /** Paginated + filtered findings (status / text search), newest first — so the detail
   * view stays responsive when a project has hundreds of findings. */
  queryFindings(projectId: number, opts: FindingQuery = {}): Array<Record<string, unknown>> {
    const where = findingWhere(projectId, opts);
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    return this.db
      .prepare("SELECT * FROM finding " + where.sql + " ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(...where.params, limit, offset) as Array<Record<string, unknown>>;
  }

  findingTimeline(findingId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding_status_event WHERE finding_id = ? ORDER BY ts ASC").all(findingId) as Array<Record<string, unknown>>;
  }

  // --- confirm decisions ----------------------------------------------------

  upsertConfirmDecisions(projectId: number, runId: number, rows: ConfirmRow[], decisionPath?: string): void {
    this.transaction(() => {
      // a confirm run's decision sheet is rewritten wholesale, so replace its rows
      this.db.prepare("DELETE FROM confirm_decision WHERE run_id = ?").run(runId);
      const stmt = this.db.prepare(
        `INSERT INTO confirm_decision(project_id, run_id, bug, reproduced, recommendation, members_json,
          severity, evidence_level, submission_confidence, distinct_fix, repro_evidence, corroboration,
          novelty, human_gates, engagement_profile_json, adjudication_json, merged_from_json, repro_command_id,
          report_markdown, decision_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = now();
      // The confirm work-list ids ARE finding content keys, so a decision's members map straight
      // back to findings: reflect each decision's real-target outcome into its findings'
      // confirm_status (reproduced -> reproduced, settled-but-not -> not-reproduced). This is what
      // makes confirm finding-grained + resumable (a later confirm skips non-NULL confirm_status).
      const setConfirm = this.db.prepare("UPDATE finding SET confirm_status = ? WHERE project_id = ? AND finding_key = ?");
      const findingsByKey = new Map<string, { severity?: string }>();
      for (const row of this.db.prepare("SELECT finding_key, severity FROM finding WHERE project_id = ?").all(projectId) as Array<{ finding_key: string | null; severity: string | null }>) {
        if (!row.finding_key) continue;
        const metadata: { severity?: string } = {};
        if (row.severity) metadata.severity = row.severity;
        findingsByKey.set(row.finding_key.toLowerCase(), metadata);
      }
      for (const r of rows) {
        const linked = linkedFindingMetadata(findingsByKey, r.members ?? []);
        const evidenceLevel = decisionEvidenceLevel(r);
        const submissionConfidence = decisionSubmissionConfidence(r, evidenceLevel);
        stmt.run(
          projectId,
          runId,
          r.bug,
          r.reproduced ?? null,
          r.recommendation ?? null,
          jsonOrNull(r.members),
          r.severity ?? maxSeverity(linked.map((entry) => entry.severity)),
          evidenceLevel,
          submissionConfidence,
          r.distinctFix ?? null,
          r.reproEvidence ?? null,
          r.corroboration ?? null,
          r.novelty ?? null,
          r.humanGates ?? null,
          jsonOrNull(r.engagementProfile),
          jsonOrNull(r.adjudication),
          jsonOrNull(r.mergedFrom),
          r.reproCommandId ?? null,
          r.reportMarkdown ?? null,
          r.decisionPath ?? decisionPath ?? null,
          ts,
        );
        const outcome = decisionConfirmOutcome(r, evidenceLevel);
        for (const member of r.members ?? []) {
          for (const key of confirmMemberKeys(member)) {
            if (outcome) setConfirm.run(outcome, projectId, key);
          }
        }
      }
    });
  }

  listConfirmDecisions(projectId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM confirm_decision WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  getConfirmDecision(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM confirm_decision WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  /** Persist the final submission report for one real-target decision. Finding-level reports
   * remain independent evidence summaries; this is the decision-level submission package. */
  setConfirmDecisionReport(projectId: number, decisionId: number, markdown: string): boolean {
    return this.db.prepare("UPDATE confirm_decision SET report_markdown = ? WHERE project_id = ? AND id = ?").run(markdown, projectId, decisionId).changes > 0;
  }

  listConfirmDecisionsForFinding(projectId: number, findingKey: string): Array<Record<string, unknown>> {
    const key = findingKey.toLowerCase();
    return this.listConfirmDecisions(projectId).filter((row) => {
      const members = parseJsonArray(row.members_json);
      return members.some((member) => confirmMemberKeys(String(member)).some((candidate) => candidate.toLowerCase() === key));
    });
  }

  /** Count bugs that actually reproduced on the real target (confirm's real output). */
  countConfirmedBugs(projectId: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM confirm_decision WHERE project_id = ? AND reproduced = 'yes'").get(projectId) as { n: number }).n);
  }

  // --- daemons + job queue (control plane for remote execution) -------------

  /** Mint a bearer token for a new daemon. The operator configures it on the daemon side. */
  createDaemonToken(name: string): { id: number; token: string } {
    const token = randomBytes(24).toString("hex");
    const info = this.db.prepare("INSERT INTO daemon(name, token, created_at) VALUES (?, ?, ?)").run(name, token, now());
    return { id: Number(info.lastInsertRowid), token };
  }

  /** Reuse the local auto-daemon identity across `flounder ui` restarts.
   * Prefer a local daemon already selected by a project so queued/pinned work remains claimable. */
  getOrCreateLocalDaemonToken(): { id: number; token: string; reused: boolean } {
    const row = this.db
      .prepare(
        `SELECT id, token FROM daemon
         WHERE name = 'local' OR name LIKE 'local-%'
         ORDER BY
           CASE WHEN id IN (SELECT daemon_id FROM project WHERE daemon_id IS NOT NULL) THEN 0 ELSE 1 END,
           COALESCE(last_seen_at, created_at) DESC,
           id DESC
         LIMIT 1`,
      )
      .get() as { id: number; token: string } | undefined;
    if (row) return { id: Number(row.id), token: String(row.token), reused: true };
    const created = this.createDaemonToken("local");
    return { ...created, reused: false };
  }

  getDaemon(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT id, name, capabilities, workspace, last_seen_at, created_at FROM daemon WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  getDaemonByToken(token: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM daemon WHERE token = ?").get(token) as Record<string, unknown> | undefined;
  }

  touchDaemon(id: number, capabilities?: unknown, workspace?: string): void {
    this.db
      .prepare("UPDATE daemon SET last_seen_at = ?, capabilities = COALESCE(?, capabilities), workspace = COALESCE(?, workspace) WHERE id = ?")
      .run(now(), capabilities !== undefined ? JSON.stringify(capabilities) : null, workspace ?? null, id);
  }

  listDaemons(): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT id, name, capabilities, workspace, last_seen_at, created_at FROM daemon ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC")
      .all() as Array<Record<string, unknown>>;
  }

  /** Rename a registered daemon (operator-facing; the token is unchanged). */
  renameDaemon(id: number, name: string): boolean {
    return this.db.prepare("UPDATE daemon SET name = ? WHERE id = ?").run(name, id).changes > 0;
  }

  /** Remove a daemon registration (revokes its token). Past jobs keep their history but lose the
   * daemon pointer (FKs are ON, so null it out first rather than orphaning the row). */
  deleteDaemon(id: number): boolean {
    let removed = false;
    this.transaction(() => {
      this.db.prepare("UPDATE job SET daemon_id = NULL WHERE daemon_id = ?").run(id);
      this.db.prepare("UPDATE project SET daemon_id = NULL WHERE daemon_id = ?").run(id);
      removed = this.db.prepare("DELETE FROM daemon WHERE id = ?").run(id).changes > 0;
    });
    return removed;
  }

  enqueueJob(project: string, spec: unknown, daemonId?: number): number {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO job(project, spec_json, status, daemon_id, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .run(project, JSON.stringify(spec), daemonId ?? null, ts, ts);
    return Number(info.lastInsertRowid);
  }

  /** Atomically claim the oldest queued job for a daemon (dispatched). Returns it (spec parsed) or undefined. */
  claimJob(daemonId: number): { id: number; project: string; spec: unknown } | undefined {
    let claimed: { id: number; project: string; spec_json: string } | undefined;
    this.transaction(() => {
      const row = this.db.prepare("SELECT id, project, spec_json FROM job WHERE status = 'queued' AND (daemon_id IS NULL OR daemon_id = ?) ORDER BY created_at LIMIT 1").get(daemonId) as
        | { id: number; project: string; spec_json: string }
        | undefined;
      if (!row) return;
      this.db.prepare("UPDATE job SET status = 'dispatched', daemon_id = ?, updated_at = ? WHERE id = ?").run(daemonId, now(), row.id);
      claimed = row;
    });
    return claimed ? { id: claimed.id, project: claimed.project, spec: jsonParseOrNull(claimed.spec_json) } : undefined;
  }

  setJobRun(jobId: number, runId: number): void {
    this.db.prepare("UPDATE job SET run_id = ?, status = 'running', updated_at = ? WHERE id = ?").run(runId, now(), jobId);
  }

  setJobStatus(jobId: number, status: string, error?: string): void {
    this.db.prepare("UPDATE job SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error ?? null, now(), jobId);
  }

  cancelRunJob(jobId: number, error = "canceled by operator"): boolean {
    const info = this.db
      .prepare("UPDATE job SET status = 'canceled', cancel = 1, error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','dispatched','running')")
      .run(error, now(), jobId);
    return Number(info.changes) > 0;
  }

  cancelJob(jobId: number, error = "canceled by operator"): boolean {
    const info = this.db
      .prepare("UPDATE job SET status = 'canceled', cancel = 1, error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','dispatched','running')")
      .run(error, now(), jobId);
    return Number(info.changes) > 0;
  }

  requestJobCancel(jobId: number): void {
    this.db.prepare("UPDATE job SET cancel = 1, updated_at = ? WHERE id = ?").run(now(), jobId);
  }

  getJob(jobId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM job WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
  }

  getJobByRun(runId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM job WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
  }

  touchJobByRun(runId: number): void {
    this.db.prepare("UPDATE job SET updated_at = ? WHERE run_id = ? AND status IN ('dispatched','running')").run(now(), runId);
  }

  /** Job ids flagged for cancel that a daemon is still working — daemons poll this to abort. */
  canceledJobIds(): number[] {
    return (this.db.prepare("SELECT id FROM job WHERE cancel = 1 AND status IN ('dispatched','running')").all() as Array<{ id: number }>).map((row) => row.id);
  }

  listJobs(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM job ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.floor(limit))) as Array<Record<string, unknown>>;
  }

  /** Jobs still in flight (queued/dispatched/running) — for the dashboard's active counts. */
  runningJobs(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM job WHERE status IN ('queued','dispatched','running') ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
  }

  // --- providers (model-strategy profiles) ----------------------------------

  /** A project selects one of these; launch resolves it into provider/model/thinking
   * (+ per-phase overrides). Stored as a named, reusable profile. */
  createProvider(input: ProviderInput): number {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO provider(name, provider, model, thinking, roles_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.name, input.provider, input.model ?? null, input.thinking ?? null, jsonOrNull(input.roles), ts, ts);
    return Number(info.lastInsertRowid);
  }

  updateProvider(id: number, input: Partial<ProviderInput>): boolean {
    const cur = this.getProvider(id);
    if (!cur) return false;
    this.db
      .prepare("UPDATE provider SET name = ?, provider = ?, model = ?, thinking = ?, roles_json = ?, updated_at = ? WHERE id = ?")
      .run(
        input.name ?? cur.name,
        input.provider ?? cur.provider,
        input.model !== undefined ? (input.model ?? null) : cur.model,
        input.thinking !== undefined ? (input.thinking ?? null) : cur.thinking,
        input.roles !== undefined ? jsonOrNull(input.roles) : jsonOrNull(cur.roles),
        now(),
        id,
      );
    return true;
  }

  deleteProvider(id: number): boolean {
    let removed = false;
    this.transaction(() => {
      // drop the dangling selection on any project that referenced this profile, then delete
      this.db.prepare("UPDATE project SET provider_id = NULL WHERE provider_id = ?").run(id);
      removed = Number(this.db.prepare("DELETE FROM provider WHERE id = ?").run(id).changes) > 0;
    });
    return removed;
  }

  private getProviderRow(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM provider WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  getProvider(id: number): ProviderProfile | undefined {
    const row = this.getProviderRow(id);
    return row ? toProviderProfile(row) : undefined;
  }

  getProviderByName(name: string): ProviderProfile | undefined {
    const row = this.db.prepare("SELECT * FROM provider WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? toProviderProfile(row) : undefined;
  }

  listProviders(): ProviderProfile[] {
    return (this.db.prepare("SELECT * FROM provider ORDER BY name").all() as Array<Record<string, unknown>>).map(toProviderProfile);
  }

  countProviders(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM provider").get() as { n: number }).n);
  }

  /** Ensure the given starter profiles exist (idempotent by profile name). */
  seedProviders(defaults: ProviderInput[]): void {
    this.transaction(() => {
      for (const d of defaults) {
        if (!this.getProviderByName(d.name)) this.createProvider(d);
      }
    });
  }

  // --- internals ------------------------------------------------------------

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

function jsonParseOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  const parsed = jsonParseOrNull(value);
  return Array.isArray(parsed) ? parsed : [];
}

function readFindingArtifact(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) {
      for (const key of ["findings", "hypotheses", "items"]) {
        const value = parsed[key];
        if (Array.isArray(value)) return value.filter(isRecord);
      }
    }
  } catch {
    // Corrupt or missing artifacts must not block opening the DB.
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function artifactTitleIsRefuted(artifact: Record<string, unknown>): boolean {
  const title = stringValue(artifact.title);
  return title !== undefined && /^\s*REFUTED\s*:/i.test(title);
}

function cleanArtifactTitle(title: string | undefined): string | null {
  if (!title) return null;
  const cleaned = title.replace(/^\s*(?:REFUTED|CONFIRMED|DISCHARGED)\s*:\s*/i, "").trim();
  return cleaned || title.trim() || null;
}

function artifactOriginId(artifact: Record<string, unknown>): number | undefined {
  const value = artifact.originId ?? artifact.origin_id;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function artifactStatus(artifact: Record<string, unknown>): string | undefined {
  return stringValue(artifact.confirmationStatus ?? artifact.status);
}

function runIsVerify(run: { kind: string; budgets_json: string | null }): boolean {
  if (run.kind === "verify") return true;
  const budgets = typeof run.budgets_json === "string" ? jsonParseOrNull(run.budgets_json) : null;
  return isRecord(budgets) && budgets.verify === true;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeDiscoveryBacklogStatus(status: unknown): DiscoveryBacklogStatus {
  return status === "resolved" || status === "stale" || status === "ignored" ? status : "open";
}

function reportRunKey(projectId: number, runDir: string): string {
  return `${projectId}\0${path.normalize(runDir).replace(/[\\/]+$/, "")}`;
}

function toProviderProfile(row: Record<string, unknown>): ProviderProfile {
  const roles = typeof row.roles_json === "string" ? (jsonParseOrNull(row.roles_json) as ProviderRoles | null) : null;
  return {
    id: Number(row.id),
    name: String(row.name),
    provider: String(row.provider),
    model: (row.model as string | null) ?? null,
    thinking: (row.thinking as string | null) ?? null,
    roles: roles ?? {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function projectListWhere(options: ProjectListOptions): { where: string; args: string[] } {
  const clauses: string[] = [];
  const args: string[] = [];
  if (options.archived !== "all") clauses.push(options.archived === true ? "archived_at IS NOT NULL" : "archived_at IS NULL");
  const search = typeof options.search === "string" ? options.search.trim().toLowerCase() : "";
  if (search) {
    clauses.push("LOWER(name) LIKE ?");
    args.push(`%${search}%`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

// Build a parameterized WHERE clause for finding queries (status + text search).
function findingWhere(projectId: number, filter: FindingFilter): { sql: string; params: Array<string | number> } {
  const clauses = ["project_id = ?"];
  const params: Array<string | number> = [projectId];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.search) {
    clauses.push("(title LIKE ? OR location LIKE ?)");
    const like = `%${filter.search}%`;
    params.push(like, like);
  }
  return { sql: "WHERE " + clauses.join(" AND "), params };
}
