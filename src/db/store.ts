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
import { enforceSubmissionReadiness, needsSubmissionReadinessWork } from "../util/submission-readiness.js";
import { canonicalFindingKey } from "../util/finding-identity.js";
import { phaseInputFingerprint } from "../util/material-fingerprint.js";
import type {
  RunGroupState,
  WorkItemInput as EvaluationWorkItemInput,
  WorkItemOutcome,
  WorkItemState,
} from "../evaluation/contracts.js";
import type { HarnessDecision, HarnessExperimentState, HarnessPromotionPolicy } from "../evaluation/harness-experiments.js";

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
  | "confirmed-source"
  | "confirmed-executable"
  | "confirmed-differential"
  | "refuted";

export interface ProjectInput {
  name: string;
  origin?: "project" | "evaluation" | undefined; // evaluation tracking projects stay out of the normal project surface
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
  origin?: "project" | "evaluation" | "all" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  search?: string | undefined;
}

export interface RunInput {
  projectId: number;
  kind: RunKind;
  runDir: string;
  /** Immutable executor ownership for remotely-created runs. Local runs leave this unset. */
  daemonId?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  budgets?: unknown;
  pid?: number | undefined;
  materialFingerprint?: string | undefined;
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
  refutationStatus?: "pending" | "running" | "passed" | "refuted" | "blocked" | undefined;
  refutationReason?: string | undefined;
  phaseAttempt?: FindingPhaseAttemptRef | undefined;
}

export type FindingPhase = "verify" | "confirm" | "report";
export type FindingPhaseAttemptState = "running" | "settled" | "blocked" | "error";

export interface FindingPhaseAttemptRef {
  subjectType: "finding" | "decision";
  subjectId: number;
  inputFingerprint: string;
}

export interface FindingPhaseAttemptInput extends FindingPhaseAttemptRef {
  phase: FindingPhase;
  state: FindingPhaseAttemptState;
  outcome?: string | undefined;
  blocker?: string | undefined;
  metrics?: unknown;
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
  tracking?: string | undefined; // exact state, or "active" to exclude ignored
  runIds?: number[] | undefined;
  reportable?: boolean | undefined;
}

export interface FindingQuery extends FindingFilter {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface RunGroupInput {
  name: string;
  kind?: string | undefined;
  parallelism?: number | undefined;
  config?: unknown;
  budget?: unknown;
}

const SCHEMA_VERSION = 9;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS project(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  name TEXT UNIQUE NOT NULL,
  origin TEXT NOT NULL DEFAULT 'project', -- project | evaluation; evaluation rows are internal run tracking
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
  daemon_id INTEGER REFERENCES daemon(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  run_dir TEXT,
  status TEXT NOT NULL,
  pid INTEGER,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  budgets_json TEXT,
  material_fingerprint TEXT,
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
  artifact_reconcile_version INTEGER NOT NULL DEFAULT 0,
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
  uuid TEXT,
  project_id INTEGER NOT NULL REFERENCES project(id),
  run_id INTEGER REFERENCES run(id),
  finding_key TEXT NOT NULL,
  canonical_key TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  location TEXT,
  severity TEXT,
  status TEXT NOT NULL,
  confirm_status TEXT,            -- per-finding real-target confirm state: NULL=not confirmed yet | confirming | reproduced | not-reproduced
  duplicate_of_finding_id INTEGER REFERENCES finding(id),
  report_path TEXT,
  report_markdown TEXT,           -- user-facing per-finding report markdown; local artifacts are only provenance/debug fallback
  scope_id TEXT,
  description TEXT,               -- the kernel's rich finding content (was only in run-dir artifacts)
  evidence TEXT,
  exploit_sketch TEXT,
  fix TEXT,
  confidence REAL,
  refutation_status TEXT,
  refutation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_project ON finding(project_id);

CREATE TABLE IF NOT EXISTS finding_occurrence(
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  finding_key TEXT NOT NULL,
  title TEXT,
  location TEXT,
  scope_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_occurrence_finding ON finding_occurrence(finding_id, created_at);

CREATE TABLE IF NOT EXISTS finding_key_alias(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  finding_id INTEGER NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, alias_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_alias_finding ON finding_key_alias(finding_id);

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

CREATE TABLE IF NOT EXISTS finding_phase_attempt(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  blocker TEXT,
  metrics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(subject_type, subject_id, phase, run_id)
);
CREATE INDEX IF NOT EXISTS idx_finding_phase_subject ON finding_phase_attempt(project_id, subject_type, subject_id, phase, attempt_number);

CREATE TABLE IF NOT EXISTS phase_retry_request(
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY(project_id, subject_type, subject_id, phase)
);

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

CREATE TABLE IF NOT EXISTS run_group(
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  parallelism INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  budget_json TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS work_item(
  id INTEGER PRIMARY KEY,
  uuid TEXT UNIQUE NOT NULL,
  run_group_id INTEGER NOT NULL REFERENCES run_group(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  target_bundle_json TEXT NOT NULL,
  material_policy_json TEXT NOT NULL,
  evidence_contract_json TEXT NOT NULL,
  result_json TEXT,
  project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES job(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(run_group_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_work_item_group_state ON work_item(run_group_id, state);
CREATE INDEX IF NOT EXISTS idx_work_item_project ON work_item(project_id);
CREATE INDEX IF NOT EXISTS idx_work_item_run ON work_item(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_job ON work_item(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_item_attempt(
  id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(work_item_id, attempt_number),
  UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS idx_work_item_attempt_item ON work_item_attempt(work_item_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_work_item_attempt_run ON work_item_attempt(run_id);

CREATE TABLE IF NOT EXISTS harness_experiment(
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'needs-evidence', -- needs-evidence | proposal-ready | evaluating | decided
  baseline_run_group_id INTEGER NOT NULL REFERENCES run_group(id) ON DELETE RESTRICT,
  candidate_run_group_id INTEGER REFERENCES run_group(id) ON DELETE RESTRICT,
  editable_files_json TEXT NOT NULL,
  promotion_policy_json TEXT NOT NULL,
  failure_patterns_json TEXT,
  preserved_behaviors_json TEXT,
  proposal_json TEXT,
  scorecard_json TEXT,
  decision TEXT, -- promote | reject | needs-more-samples
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  evaluated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_harness_experiment_state ON harness_experiment(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_harness_experiment_baseline ON harness_experiment(baseline_run_group_id);
CREATE INDEX IF NOT EXISTS idx_harness_experiment_candidate ON harness_experiment(candidate_run_group_id);
`;

const ADDITIVE_COLUMNS = [
  ["project", "origin", "ALTER TABLE project ADD COLUMN origin TEXT NOT NULL DEFAULT 'project'"],
  ["project", "provider_id", "ALTER TABLE project ADD COLUMN provider_id INTEGER"],
  ["project", "daemon_id", "ALTER TABLE project ADD COLUMN daemon_id INTEGER"],
  ["project", "dir", "ALTER TABLE project ADD COLUMN dir TEXT"],
  ["project", "uuid", "ALTER TABLE project ADD COLUMN uuid TEXT"],
  ["project", "archived_at", "ALTER TABLE project ADD COLUMN archived_at TEXT"],
  ["project", "pinned_at", "ALTER TABLE project ADD COLUMN pinned_at TEXT"],
  ["project", "sort_order", "ALTER TABLE project ADD COLUMN sort_order INTEGER"],
  ["daemon", "workspace", "ALTER TABLE daemon ADD COLUMN workspace TEXT"],
  ["run", "daemon_id", "ALTER TABLE run ADD COLUMN daemon_id INTEGER REFERENCES daemon(id) ON DELETE SET NULL"],
  ["run", "artifact_reconcile_version", "ALTER TABLE run ADD COLUMN artifact_reconcile_version INTEGER NOT NULL DEFAULT 0"],
  ["run", "run_scopes_target", "ALTER TABLE run ADD COLUMN run_scopes_target INTEGER"],
  ["run", "material_fingerprint", "ALTER TABLE run ADD COLUMN material_fingerprint TEXT"],
  ["run", "run_scopes_done", "ALTER TABLE run ADD COLUMN run_scopes_done INTEGER"],
  ["run", "dig_started_at", "ALTER TABLE run ADD COLUMN dig_started_at TEXT"],
  ["scope", "dig_seconds", "ALTER TABLE scope ADD COLUMN dig_seconds INTEGER"],
  ["scope", "priority", "ALTER TABLE scope ADD COLUMN priority INTEGER DEFAULT 0"],
  ["finding", "tracking_status", "ALTER TABLE finding ADD COLUMN tracking_status TEXT"],
  ["finding", "uuid", "ALTER TABLE finding ADD COLUMN uuid TEXT"],
  ["finding", "canonical_key", "ALTER TABLE finding ADD COLUMN canonical_key TEXT"],
  ["finding", "occurrence_count", "ALTER TABLE finding ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1"],
  ["finding", "confirm_status", "ALTER TABLE finding ADD COLUMN confirm_status TEXT"],
  ["finding", "duplicate_of_finding_id", "ALTER TABLE finding ADD COLUMN duplicate_of_finding_id INTEGER REFERENCES finding(id)"],
  ["finding", "report_markdown", "ALTER TABLE finding ADD COLUMN report_markdown TEXT"],
  ["finding", "description", "ALTER TABLE finding ADD COLUMN description TEXT"],
  ["finding", "evidence", "ALTER TABLE finding ADD COLUMN evidence TEXT"],
  ["finding", "exploit_sketch", "ALTER TABLE finding ADD COLUMN exploit_sketch TEXT"],
  ["finding", "fix", "ALTER TABLE finding ADD COLUMN fix TEXT"],
  ["finding", "confidence", "ALTER TABLE finding ADD COLUMN confidence REAL"],
  ["finding", "refutation_status", "ALTER TABLE finding ADD COLUMN refutation_status TEXT"],
  ["finding", "refutation_reason", "ALTER TABLE finding ADD COLUMN refutation_reason TEXT"],
  ["run", "stages_json", "ALTER TABLE run ADD COLUMN stages_json TEXT"],
  ["run", "health_status", "ALTER TABLE run ADD COLUMN health_status TEXT"],
  ["run", "health_reasons_json", "ALTER TABLE run ADD COLUMN health_reasons_json TEXT"],
  ["run", "health_signals_json", "ALTER TABLE run ADD COLUMN health_signals_json TEXT"],
  ["scope", "source", "ALTER TABLE scope ADD COLUMN source TEXT"],
  ["scope", "parent_scope_id", "ALTER TABLE scope ADD COLUMN parent_scope_id TEXT"],
  ["confirm_decision", "distinct_fix", "ALTER TABLE confirm_decision ADD COLUMN distinct_fix TEXT"],
  ["confirm_decision", "repro_evidence", "ALTER TABLE confirm_decision ADD COLUMN repro_evidence TEXT"],
  ["confirm_decision", "corroboration", "ALTER TABLE confirm_decision ADD COLUMN corroboration TEXT"],
  ["confirm_decision", "novelty", "ALTER TABLE confirm_decision ADD COLUMN novelty TEXT"],
  ["confirm_decision", "human_gates", "ALTER TABLE confirm_decision ADD COLUMN human_gates TEXT"],
  ["confirm_decision", "engagement_profile_json", "ALTER TABLE confirm_decision ADD COLUMN engagement_profile_json TEXT"],
  ["confirm_decision", "adjudication_json", "ALTER TABLE confirm_decision ADD COLUMN adjudication_json TEXT"],
  ["confirm_decision", "merged_from_json", "ALTER TABLE confirm_decision ADD COLUMN merged_from_json TEXT"],
  ["confirm_decision", "repro_command_id", "ALTER TABLE confirm_decision ADD COLUMN repro_command_id TEXT"],
  ["confirm_decision", "severity", "ALTER TABLE confirm_decision ADD COLUMN severity TEXT"],
  ["confirm_decision", "evidence_level", "ALTER TABLE confirm_decision ADD COLUMN evidence_level TEXT"],
  ["confirm_decision", "submission_confidence", "ALTER TABLE confirm_decision ADD COLUMN submission_confidence TEXT"],
  ["confirm_decision", "report_markdown", "ALTER TABLE confirm_decision ADD COLUMN report_markdown TEXT"],
  ["run_group", "parallelism", "ALTER TABLE run_group ADD COLUMN parallelism INTEGER NOT NULL DEFAULT 1"],
  ["run_group", "ended_at", "ALTER TABLE run_group ADD COLUMN ended_at TEXT"],
  ["work_item", "evidence_contract_json", "ALTER TABLE work_item ADD COLUMN evidence_contract_json TEXT"],
  ["work_item", "job_id", "ALTER TABLE work_item ADD COLUMN job_id INTEGER"],
  ["work_item", "ended_at", "ALTER TABLE work_item ADD COLUMN ended_at TEXT"],
  ["work_item_attempt", "run_id", "ALTER TABLE work_item_attempt ADD COLUMN run_id INTEGER"],
  ["work_item_attempt", "outcome", "ALTER TABLE work_item_attempt ADD COLUMN outcome TEXT"],
  ["work_item_attempt", "result_json", "ALTER TABLE work_item_attempt ADD COLUMN result_json TEXT"],
  ["work_item_attempt", "error", "ALTER TABLE work_item_attempt ADD COLUMN error TEXT"],
  ["work_item_attempt", "started_at", "ALTER TABLE work_item_attempt ADD COLUMN started_at TEXT"],
  ["work_item_attempt", "ended_at", "ALTER TABLE work_item_attempt ADD COLUMN ended_at TEXT"],
  ["work_item_attempt", "updated_at", "ALTER TABLE work_item_attempt ADD COLUMN updated_at TEXT"],
] as const;

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
  return "source-only-local-confirmed";
}

function shouldDowngradeEvidence(stored: string, inferred: string): boolean {
  const storedRank = EVIDENCE_LEVEL_RANK[stored] ?? 0;
  const inferredRank = EVIDENCE_LEVEL_RANK[inferred] ?? 0;
  return inferred === "source-only-local-confirmed" && storedRank > inferredRank;
}

function decisionEvidenceLevel(row: Pick<ConfirmRow, "reproduced" | "evidenceLevel" | "reproEvidence" | "humanGates" | "corroboration" | "novelty" | "adjudication">): string {
  const inferred = inferredDecisionEvidenceLevel(row);
  const explicit = row.evidenceLevel?.trim();
  if (explicit) {
    if (hasSourceOnlyReproductionCrutch(row) && shouldDowngradeEvidence(explicit, "source-only-local-confirmed")) return "source-only-local-confirmed";
    return explicit;
  }
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

const CANONICAL_STATUS_RANK: Record<string, number> = {
  discharged: 0,
  refuted: 1,
  "needs-evidence": 2,
  suspected: 3,
  "confirmed-source": 4,
  "confirmed-executable": 5,
  "confirmed-differential": 6,
};

function compareCanonicalRows(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const status = (CANONICAL_STATUS_RANK[String(b.status)] ?? -1) - (CANONICAL_STATUS_RANK[String(a.status)] ?? -1);
  if (status !== 0) return status;
  const report = Number(Boolean(b.report_markdown)) - Number(Boolean(a.report_markdown));
  if (report !== 0) return report;
  return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || Number(a.id) - Number(b.id);
}

function findingStatusRank(status: string): number {
  return CANONICAL_STATUS_RANK[status] ?? -1;
}

function isFindingDisclosureStatus(status: string): boolean {
  return status === "confirmed-source" || status === "confirmed-executable" || status === "confirmed-differential";
}

type VerifyArtifactRun = {
  id: number;
  project_id: number;
  daemon_id: number | null;
  kind: string;
  run_dir: string;
  status: string;
  budgets_json: string | null;
  material_fingerprint: string | null;
  artifact_reconcile_version: number;
};

type VerifyArtifactEntry = {
  run: VerifyArtifactRun;
  artifact: Record<string, unknown>;
  originId: number;
  status?: "refuted" | "needs-evidence";
};

export class MetadataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Install the busy handler before changing journal mode: journal_mode itself
    // takes a database lock, so concurrent first opens must wait here too instead
    // of failing before the later schema-migration transaction can serialize them.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Short-lived pre-release evaluation schemas existed before every indexed
    // queue/run linkage landed. These compatibility columns must exist before
    // SCHEMA reaches their CREATE INDEX statements. The remaining additive
    // migration still happens transactionally below.
    const preSchemaColumns = [
      ["work_item", "job_id", "ALTER TABLE work_item ADD COLUMN job_id INTEGER"],
      ["work_item_attempt", "run_id", "ALTER TABLE work_item_attempt ADD COLUMN run_id INTEGER"],
    ] as const;
    const missingPreSchemaColumns = preSchemaColumns.filter(([table, column]) => this.hasTable(table) && !this.hasColumn(table, column));
    if (missingPreSchemaColumns.length > 0) {
      this.transaction(() => {
        for (const [, , statement] of missingPreSchemaColumns) this.db.exec(statement);
      }, "immediate");
    }
    this.db.exec(SCHEMA);
    // CREATE IF NOT EXISTS does not add columns to old tables. Take the SQLite
    // write reservation before inspecting the schema so concurrent processes
    // cannot both decide to add the same column. Unexpected migration failures
    // (permissions, corruption, malformed SQL) still surface.
    this.transaction(() => {
      for (const [table, column, alter] of ADDITIVE_COLUMNS) {
        if (!this.hasColumn(table, column)) this.db.exec(alter);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_project_origin ON project(origin)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_finding_project_canonical ON finding(project_id, canonical_key)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_run_daemon ON run(daemon_id, id)");
    }, "immediate");
    this.ensureProjectUuids();
    this.ensureFindingIdentities();
    this.reconcileConfirmDecisionMembers();
    this.reconcileConfirmStatuses();
    this.reconcileReproducedFindingInvariants();
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

  private ensureFindingIdentities(): void {
    const needsBackfill = this.db.prepare(
      "SELECT 1 AS yes FROM finding WHERE uuid IS NULL OR uuid = '' OR canonical_key IS NULL OR canonical_key = '' LIMIT 1",
    ).get();
    if (!needsBackfill) {
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_uuid ON finding(uuid)");
      return;
    }
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id, project_id, run_id, finding_key, title, location, scope_id, status, created_at, updated_at, uuid, canonical_key FROM finding ORDER BY id")
        .all() as Array<Record<string, unknown>>;
      const updateIdentity = this.db.prepare("UPDATE finding SET uuid = ?, canonical_key = ? WHERE id = ?");
      for (const row of rows) {
        const uuid = typeof row.uuid === "string" && row.uuid ? row.uuid : randomUUID();
        const canonical = typeof row.canonical_key === "string" && row.canonical_key
          ? row.canonical_key
          : canonicalFindingKey(row.title, row.location, row.finding_key);
        updateIdentity.run(uuid, canonical, Number(row.id));
      }

      // Older schemas allowed the same exact finding identity once per run. Collapse
      // only exact normalized title+location identities; semantic similarity is never
      // inferred. Every removed row survives as an occurrence + key alias.
      const refreshed = this.db.prepare("SELECT * FROM finding ORDER BY project_id, canonical_key, id").all() as Array<Record<string, unknown>>;
      const groups = new Map<string, Array<Record<string, unknown>>>();
      for (const row of refreshed) {
        const key = `${row.project_id}:${row.canonical_key}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      const insertOccurrence = this.db.prepare(
        `INSERT OR IGNORE INTO finding_occurrence(finding_id, project_id, run_id, finding_key, title, location, scope_id, status, reason, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'identity migration', ?, ?, ?)`,
      );
      const upsertAlias = this.db.prepare(
        `INSERT INTO finding_key_alias(project_id, alias_key, finding_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, alias_key) DO UPDATE SET finding_id = excluded.finding_id, updated_at = excluded.updated_at`,
      );
      for (const group of groups.values()) {
        const primary = [...group].sort(compareCanonicalRows)[0]!;
        const ts = now();
        for (const row of group) {
          insertOccurrence.run(Number(primary.id), Number(row.project_id), row.run_id == null ? null : Number(row.run_id), String(row.finding_key), row.title == null ? null : String(row.title), row.location == null ? null : String(row.location), row.scope_id == null ? null : String(row.scope_id), String(row.status), jsonOrNull(row), String(row.created_at ?? ts), String(row.updated_at ?? ts));
          upsertAlias.run(Number(row.project_id), String(row.finding_key).toLowerCase(), Number(primary.id), ts, ts);
          if (row.id === primary.id) continue;
          this.db.prepare("UPDATE finding_status_event SET finding_id = ? WHERE finding_id = ?").run(Number(primary.id), Number(row.id));
          this.db.prepare("UPDATE finding SET duplicate_of_finding_id = ? WHERE duplicate_of_finding_id = ?").run(Number(primary.id), Number(row.id));
          this.db.prepare("UPDATE finding_occurrence SET finding_id = ? WHERE finding_id = ?").run(Number(primary.id), Number(row.id));
          this.db.prepare(
            `UPDATE finding SET
               report_path = COALESCE(report_path, ?), report_markdown = COALESCE(NULLIF(report_markdown, ''), ?),
               description = COALESCE(NULLIF(description, ''), ?), evidence = COALESCE(NULLIF(evidence, ''), ?),
               exploit_sketch = COALESCE(NULLIF(exploit_sketch, ''), ?), fix = COALESCE(NULLIF(fix, ''), ?),
               confidence = COALESCE(confidence, ?), confirm_status = COALESCE(confirm_status, ?), updated_at = MAX(updated_at, ?)
             WHERE id = ?`,
          ).run(sqlText(row.report_path), sqlText(row.report_markdown), sqlText(row.description), sqlText(row.evidence), sqlText(row.exploit_sketch), sqlText(row.fix), row.confidence == null ? null : Number(row.confidence), sqlText(row.confirm_status), String(row.updated_at ?? ts), Number(primary.id));
          this.db.prepare("DELETE FROM finding WHERE id = ?").run(Number(row.id));
        }
      }
      this.db.exec("UPDATE finding SET occurrence_count = (SELECT COUNT(*) FROM finding_occurrence fo WHERE fo.finding_id = finding.id)");
    }, "immediate");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_uuid ON finding(uuid)");
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
    for (const row of rows) {
      const members = jsonParseOrNull(row.members_json);
      if (!Array.isArray(members)) continue;
      const evidenceLevel = decisionEvidenceLevel(decisionEvidenceInput(row));
      const outcome = decisionConfirmOutcome({ reproduced: row.reproduced ?? undefined }, evidenceLevel);
      if (!outcome) continue;
      for (const member of members) {
        if (typeof member !== "string") continue;
        for (const key of confirmMemberKeys(member)) {
          const finding = this.resolveFindingByKey(row.project_id, key);
          if (finding) this.applyFindingConfirmStatus(row.project_id, Number(finding.id), outcome, { onlyIfNull: true });
        }
      }
    }
  }

  /** Older decision sheets can retain a finding-key alias after identity
   * migration collapsed the underlying rows. Canonicalize those links once so
   * every API/UI consumer sees the same durable finding identity. */
  private reconcileConfirmDecisionMembers(): void {
    const rows = this.db.prepare("SELECT id, project_id, members_json FROM confirm_decision WHERE members_json IS NOT NULL")
      .all() as Array<{ id: number; project_id: number; members_json: string }>;
    if (rows.length === 0) return;
    this.transaction(() => {
      const update = this.db.prepare("UPDATE confirm_decision SET members_json = ? WHERE id = ?");
      for (const row of rows) {
        const members = parseJsonArray(row.members_json).filter((member): member is string => typeof member === "string");
        const normalized = this.canonicalConfirmMembers(row.project_id, members);
        if (JSON.stringify(members) !== JSON.stringify(normalized)) update.run(JSON.stringify(normalized), row.id);
      }
    }, "immediate");
  }

  private reconcileReproducedFindingInvariants(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id, project_id FROM finding WHERE confirm_status = 'reproduced'")
        .all() as Array<{ id: number; project_id: number }>;
      for (const row of rows) this.applyFindingConfirmStatus(row.project_id, row.id, "reproduced");
    }, "immediate");
  }

  private runDataMigrations(): void {
    this.transaction(() => {
      // `job.run_id` intentionally follows the active pipeline phase. It can only
      // prove ownership for the phase it currently references, so backfill that
      // exact row and never infer older phase ownership from timestamps or paths.
      this.db.exec(`UPDATE run
                       SET daemon_id = (SELECT j.daemon_id FROM job j WHERE j.run_id = run.id)
                     WHERE daemon_id IS NULL
                       AND EXISTS (SELECT 1 FROM job j WHERE j.run_id = run.id AND j.daemon_id IS NOT NULL)`);
      if (this.hasColumn("run_group", "finished_at")) {
        this.db.exec("UPDATE run_group SET ended_at = COALESCE(ended_at, finished_at) WHERE finished_at IS NOT NULL");
      }
      if (this.hasColumn("work_item", "evidence_gate_json")) {
        this.db.exec("UPDATE work_item SET evidence_contract_json = COALESCE(evidence_contract_json, evidence_gate_json) WHERE evidence_gate_json IS NOT NULL");
      }
      if (this.hasColumn("work_item", "finished_at")) {
        this.db.exec("UPDATE work_item SET ended_at = COALESCE(ended_at, finished_at) WHERE finished_at IS NOT NULL");
      }
      this.db.exec("UPDATE work_item SET project_id = (SELECT project_id FROM run WHERE run.id = work_item.run_id) WHERE project_id IS NULL AND run_id IS NOT NULL");
      this.db.exec("UPDATE project SET origin = 'evaluation' WHERE origin = 'project' AND name LIKE 'evaluation:%' AND EXISTS (SELECT 1 FROM work_item WHERE work_item.project_id = project.id)");
      this.db.exec(`UPDATE project AS p SET origin = 'evaluation'
        WHERE p.origin = 'project'
          AND EXISTS (SELECT 1 FROM run r_any WHERE r_any.project_id = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM run r_normal
             WHERE r_normal.project_id = p.id
               AND NOT EXISTS (SELECT 1 FROM work_item wi_run WHERE wi_run.run_id = r_normal.id)
               AND NOT EXISTS (SELECT 1 FROM work_item_attempt wia_run WHERE wia_run.run_id = r_normal.id)
      )`);
      this.reconcileFindingReportRunIds();
      this.reconcileConfirmDecisionReports();
      this.reconcileAuditedScopeBacklog();
      this.reconcileFindingDuplicateLinks();
    }, "immediate");
    // Artifact paths may be remote, slow, or large. Parse them without holding the
    // SQLite writer lock, then apply the collected immutable verdicts atomically.
    this.reconcileRefutedVerifyArtifacts();
  }

  /** Duplicate is a relationship, not a standalone terminal label. Older data
   * could persist orphan duplicates or duplicate chains. Reopen invalid orphans
   * and flatten valid chains so every duplicate points directly at one canonical
   * finding in the same project. */
  private reconcileFindingDuplicateLinks(): void {
    type DuplicateRow = {
      id: number;
      project_id: number;
      tracking_status: string | null;
      duplicate_of_finding_id: number | null;
    };
    const rows = this.db.prepare(
      "SELECT id, project_id, tracking_status, duplicate_of_finding_id FROM finding ORDER BY id",
    ).all() as DuplicateRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const clearOrphan = this.db.prepare(
      "UPDATE finding SET tracking_status = NULL, duplicate_of_finding_id = NULL WHERE id = ?",
    );
    const clearStaleLink = this.db.prepare(
      "UPDATE finding SET duplicate_of_finding_id = NULL WHERE id = ?",
    );
    const flatten = this.db.prepare(
      "UPDATE finding SET duplicate_of_finding_id = ? WHERE id = ?",
    );

    for (const row of rows) {
      if (row.tracking_status !== "duplicate") {
        if (row.duplicate_of_finding_id !== null) clearStaleLink.run(row.id);
        continue;
      }

      const seen = new Set<number>([row.id]);
      let targetId = row.duplicate_of_finding_id;
      let canonical: DuplicateRow | undefined;
      while (targetId !== null) {
        const target = byId.get(targetId);
        if (!target || target.project_id !== row.project_id || seen.has(target.id)) break;
        seen.add(target.id);
        if (target.tracking_status !== "duplicate") {
          canonical = target;
          break;
        }
        targetId = target.duplicate_of_finding_id;
      }

      if (!canonical) {
        clearOrphan.run(row.id);
      } else if (row.duplicate_of_finding_id !== canonical.id) {
        flatten.run(canonical.id, row.id);
      }
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private hasTable(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  private reconcileConfirmDecisionReports(): void {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, reproduced, recommendation, members_json, severity,
                evidence_level, submission_confidence, repro_evidence, corroboration,
                novelty, human_gates, engagement_profile_json, adjudication_json
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
        engagement_profile_json: string | null;
        adjudication_json: string | null;
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
          SET recommendation = ?,
              human_gates = ?,
              severity = ?,
              evidence_level = ?,
              submission_confidence = ?
        WHERE id = ?`,
    );
    for (const row of rows) {
      const members = parseJsonArray(row.members_json).filter((member): member is string => typeof member === "string");
      const linked = linkedFindingMetadata(findingsByProject.get(row.project_id), members);
      const input = decisionEvidenceInput(row);
      const enforced = enforceSubmissionReadiness([input], { requireImpactInventory: false })[0] ?? input;
      const evidenceLevel = decisionEvidenceLevel(enforced);
      update.run(
        enforced.recommendation ?? row.recommendation,
        enforced.humanGates ?? row.human_gates,
        row.severity?.trim() || maxSeverity(linked.map((entry) => entry.severity)),
        evidenceLevel,
        decisionSubmissionConfidence(enforced, evidenceLevel),
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
      .prepare("SELECT id, project_id, daemon_id, kind, run_dir, status, budgets_json, material_fingerprint, artifact_reconcile_version FROM run WHERE run_dir IS NOT NULL AND run_dir <> ''")
      .all() as VerifyArtifactRun[];
    if (runs.length === 0) return;

    const artifactsByRun = new Map<number, Array<Record<string, unknown>>>();
    for (const run of runs) {
      // A running process may still be writing its checkpoint. Startup repair must
      // never guess that a partial artifact is its terminal verdict.
      if (!runIsVerify(run) || run.status === "running") continue;
      artifactsByRun.set(run.id, [
        ...readFindingArtifact(path.join(run.run_dir, "audit_hypotheses.json")),
        ...readFindingArtifact(path.join(run.run_dir, "audit_findings.json")),
      ]);
    }
    this.applyRefutedVerifyArtifacts(runs, artifactsByRun);
  }

  /** Terminal verify runs whose artifacts live on a particular daemon and have not
   * been replayed for the current protocol version. Ownership is immutable on the
   * run; `job.run_id` remains the mutable active-phase pointer. */
  listDaemonArtifactReconciliationRuns(daemonId: number, version: number, beforeId?: number, limit = 50): VerifyArtifactRun[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const before = Number.isInteger(beforeId) && Number(beforeId) > 0 ? Number(beforeId) : Number.MAX_SAFE_INTEGER;
    return this.db.prepare(
      `SELECT id, project_id, daemon_id, kind, run_dir, status, budgets_json, material_fingerprint, artifact_reconcile_version
         FROM run
        WHERE daemon_id = ?
          AND id < ?
          AND status <> 'running'
          AND run_dir IS NOT NULL AND run_dir <> ''
          AND COALESCE(artifact_reconcile_version, 0) < ?
          AND (kind = 'verify' OR (json_valid(budgets_json) AND json_extract(budgets_json, '$.verify') = 1))
        ORDER BY id DESC
        LIMIT ?`,
    ).all(daemonId, before, version, boundedLimit) as VerifyArtifactRun[];
  }

  /** Apply a daemon-uploaded terminal verify artifact through the exact same
   * canonical ordering, conflict, and real-target protection logic as local startup
   * repair. The version marker is committed in the same transaction. */
  reconcileTerminalVerifyArtifacts(runId: number, artifacts: Array<Record<string, unknown>>, version: number): boolean {
    const run = this.db.prepare(
      `SELECT id, project_id, daemon_id, kind, run_dir, status, budgets_json, material_fingerprint, artifact_reconcile_version
         FROM run WHERE id = ?`,
    ).get(runId) as VerifyArtifactRun | undefined;
    if (!run || run.status === "running" || !runIsVerify(run)) return false;
    if (run.artifact_reconcile_version >= version) return true;
    this.applyRefutedVerifyArtifacts([run], new Map([[run.id, artifacts]]), () => {
      this.db.prepare("UPDATE run SET artifact_reconcile_version = ? WHERE id = ? AND artifact_reconcile_version < ?")
        .run(version, run.id, version);
    });
    return true;
  }

  private applyRefutedVerifyArtifacts(
    runs: VerifyArtifactRun[],
    artifactsByRun: Map<number, Array<Record<string, unknown>>>,
    onApplied?: () => void,
  ): void {
    const byOrigin = new Map<number, VerifyArtifactEntry[]>();
    for (const run of runs) {
      for (const artifact of artifactsByRun.get(run.id) ?? []) {
        const status = artifactTitleIsRefuted(artifact)
          ? "refuted"
          : artifactStatus(artifact) === "suspected"
            ? "needs-evidence"
            : undefined;
        const originId = artifactOriginId(artifact);
        if (originId === undefined) continue;
        const entries = byOrigin.get(originId) ?? [];
        entries.push({ run, artifact, originId, ...(status ? { status } : {}) });
        byOrigin.set(originId, entries);
      }
    }

    const selectOriginal = this.db.prepare(
      `SELECT id, project_id, run_id, title, location, severity, status, scope_id,
              report_path, report_markdown, description, evidence, exploit_sketch, fix, confidence,
              confirm_status, refutation_status, refutation_reason
         FROM finding WHERE id = ?`,
    );
    const selectLatestAttempt = this.db.prepare(
      `SELECT run_id FROM finding_phase_attempt
        WHERE project_id = ? AND subject_type = 'finding' AND subject_id = ? AND phase = 'verify'
        ORDER BY attempt_number DESC LIMIT 1`,
    );
    const updateOriginal = this.db.prepare(
      `UPDATE finding SET run_id = ?, title = ?, location = ?, severity = ?, status = ?,
         scope_id = ?, report_path = NULL, report_markdown = NULL,
         description = ?, evidence = ?, exploit_sketch = ?, fix = ?, confidence = ?,
         refutation_status = NULL, refutation_reason = NULL, updated_at = ?
       WHERE id = ? AND project_id = ?`,
    );
    const updateAttempt = this.db.prepare(
      `UPDATE finding_phase_attempt
          SET state = 'settled', outcome = ?, blocker = NULL, updated_at = ?, ended_at = COALESCE(ended_at, ?)
        WHERE project_id = ? AND subject_type = 'finding' AND subject_id = ? AND phase = 'verify' AND run_id = ?
          AND (state IS NOT 'settled' OR outcome IS NOT ? OR blocker IS NOT NULL OR ended_at IS NULL)`,
    );
    const preserveReproduced = this.db.prepare(
      `UPDATE finding SET status = ?, refutation_status = ?, refutation_reason = ?, updated_at = ?
        WHERE id = ? AND project_id = ?`,
    );

    this.transaction(() => {
      for (const [originId, entries] of byOrigin) {
        const original = selectOriginal.get(originId) as Record<string, unknown> | undefined;
        if (!original) continue;
        const projectId = Number(original.project_id);
        const projectEntries = entries.filter((entry) => entry.run.project_id === projectId);
        if (projectEntries.length === 0) continue;

        const entriesByRun = new Map<number, VerifyArtifactEntry[]>();
        for (const entry of projectEntries) {
          const runEntries = entriesByRun.get(entry.run.id) ?? [];
          runEntries.push(entry);
          entriesByRun.set(entry.run.id, runEntries);
        }
        // A run that emitted multiple verdict artifacts for one origin is internally
        // inconsistent. Do not guess which stochastic worker won; preserve both
        // artifacts for diagnosis and require an explicit retry.
        const unambiguousNegative = (runEntries: VerifyArtifactEntry[]): VerifyArtifactEntry | undefined =>
          runEntries.length === 1 && runEntries[0]?.status ? runEntries[0] : undefined;
        // Repair each unambiguous historical attempt independently. Conflicting runs
        // remain untouched and cannot mutate the canonical finding below.
        for (const runEntries of entriesByRun.values()) {
          const verdict = unambiguousNegative(runEntries);
          if (!verdict?.status) continue;
          const ts = now();
          updateAttempt.run(verdict.status, ts, ts, projectId, originId, verdict.run.id, verdict.status);
        }

        const latestAttempt = selectLatestAttempt.get(projectId, originId) as { run_id: number | null } | undefined;
        const authoritativeRunId = latestAttempt
          ? Number(latestAttempt.run_id)
          : Math.max(...projectEntries.map((entry) => entry.run.id));
        // All artifacts from the latest run act as an ordering barrier. If that run
        // confirmed the finding (or produced no complete semantic verdict), an older
        // REFUTED artifact is not allowed to win by migration order.
        const sameRun = entriesByRun.get(authoritativeRunId) ?? [];
        const authoritative = unambiguousNegative(sameRun);
        if (!authoritative?.status) continue;
        // The latest verify attempt orders the verify chain. A newer canonical run
        // is a barrier only when it carries terminal/stronger evidence; an ordinary
        // suspected rediscovery must not hide an older execution-backed refutation.
        const canonicalStatus = String(original.status);
        const canonicalHasBarrierEvidence = isFindingDisclosureStatus(canonicalStatus)
          || canonicalStatus === "refuted"
          || original.confirm_status === "reproduced";
        const canonicalRunId = Number(original.run_id ?? 0);
        if (authoritative.run.id < canonicalRunId) {
          const canonicalRun = this.getRun(canonicalRunId);
          const sameKnownMaterial = Boolean(authoritative.run.material_fingerprint)
            && authoritative.run.material_fingerprint === canonicalRun?.material_fingerprint;
          if (canonicalHasBarrierEvidence || !sameKnownMaterial) continue;
        }

        if (original.confirm_status === "reproduced") {
          const previousStatus = String(original.status);
          const protectedStatus = isFindingDisclosureStatus(previousStatus) ? previousStatus : "confirmed-executable";
          const conflict = authoritative.status === "refuted";
          const protectedRefutationStatus = conflict ? "conflict" : nullableText(original.refutation_status);
          const protectedRefutationReason = conflict
            ? "Local verification conflicts with an existing real-target reproduction; human adjudication is required."
            : nullableText(original.refutation_reason);
          if (previousStatus !== protectedStatus
            || nullableText(original.refutation_status) !== protectedRefutationStatus
            || nullableText(original.refutation_reason) !== protectedRefutationReason) {
            const ts = now();
            preserveReproduced.run(protectedStatus, protectedRefutationStatus, protectedRefutationReason, ts, originId, projectId);
            if (previousStatus !== protectedStatus) {
              this.recordStatusEvent(originId, previousStatus, protectedStatus, "real-target reproduction preserved against local conflict", authoritative.run.id, ts);
            }
          }
          continue;
        }

        const artifact = authoritative.artifact;
        const desired = {
          runId: authoritative.run.id,
          title: cleanArtifactTitle(stringValue(artifact.title)) ?? nullableText(original.title),
          location: stringValue(artifact.location) ?? nullableText(original.location),
          severity: stringValue(artifact.severity) ?? nullableText(original.severity),
          status: authoritative.status,
          scopeId: stringValue(artifact.scopeId ?? artifact.scope_id) ?? nullableText(original.scope_id),
          description: stringValue(artifact.description) ?? nullableText(original.description),
          evidence: stringValue(artifact.evidence) ?? nullableText(original.evidence),
          exploitSketch: stringValue(artifact.exploitSketch ?? artifact.exploit_sketch) ?? nullableText(original.exploit_sketch),
          fix: stringValue(artifact.fix) ?? nullableText(original.fix),
          confidence: numberValue(artifact.confidence) ?? nullableNumber(original.confidence),
        };
        const changed = Number(original.run_id ?? 0) !== desired.runId
          || nullableText(original.title) !== desired.title
          || nullableText(original.location) !== desired.location
          || nullableText(original.severity) !== desired.severity
          || String(original.status) !== desired.status
          || nullableText(original.scope_id) !== desired.scopeId
          || original.report_path != null
          || original.report_markdown != null
          || nullableText(original.description) !== desired.description
          || nullableText(original.evidence) !== desired.evidence
          || nullableText(original.exploit_sketch) !== desired.exploitSketch
          || nullableText(original.fix) !== desired.fix
          || nullableNumber(original.confidence) !== desired.confidence
          || original.refutation_status != null
          || original.refutation_reason != null;
        if (!changed) continue;

        const previousStatus = String(original.status);
        const ts = now();
        updateOriginal.run(
          desired.runId,
          desired.title,
          desired.location,
          desired.severity,
          desired.status,
          desired.scopeId,
          desired.description,
          desired.evidence,
          desired.exploitSketch,
          desired.fix,
          desired.confidence,
          ts,
          originId,
          projectId,
        );
        if (previousStatus !== desired.status) {
          this.recordStatusEvent(originId, previousStatus, desired.status, "verify artifact migration", desired.runId, ts);
        }
      }
      onApplied?.();
    }, "immediate");
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
        `INSERT INTO project(uuid, name, origin, source_paths, build_root, corpus_paths, config_json, provider_id, daemon_id, dir, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.origin ?? "project",
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
    const row = this.db.prepare("SELECT MIN(sort_order) AS min_order FROM project WHERE archived_at IS NULL AND origin = 'project'").get() as { min_order: number | null } | undefined;
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
      this.db.prepare("DELETE FROM phase_retry_request WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM finding_phase_attempt WHERE project_id = ?").run(id);
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
        `INSERT INTO run(project_id, daemon_id, kind, run_dir, status, pid, provider, model, thinking, budgets_json, material_fingerprint, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.daemonId ?? null,
        input.kind,
        input.runDir,
        input.pid ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.thinking ?? null,
        jsonOrNull(input.budgets),
        input.materialFingerprint ?? null,
        now(),
      );
    return Number(info.lastInsertRowid);
  }

  updateRunMaterialFingerprint(runId: number, fingerprint: string): void {
    this.db.prepare("UPDATE run SET material_fingerprint = ? WHERE id = ?").run(fingerprint, runId);
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
      this.db.prepare("DELETE FROM finding_phase_attempt WHERE run_id = ?").run(id);
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
    this.reconcileAuditedScopeBacklog(projectId);
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
    this.reconcileAuditedScopeBacklog(projectId);
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
    if (status === "audited") this.reconcileAuditedScopeBacklog(projectId);
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
      if (rows.length === 0) {
        this.reconcileAuditedScopeBacklog(projectId);
        return;
      }
      const reconcile = this.db.prepare(
        `UPDATE discovery_backlog
            SET status = ?, updated_at = ?
          WHERE project_id = ? AND run_id <> ? AND kind = ? AND status = 'open'
            AND COALESCE(scope_id, '') = COALESCE(?, '')
            AND COALESCE(title, '') = COALESCE(?, '')
            AND COALESCE(location, '') = COALESCE(?, '')`,
      );
      const stmt = this.db.prepare(
        `INSERT INTO discovery_backlog(project_id, run_id, kind, status, scope_id, title, location, reason, next_action, priority, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = now();
      for (const row of rows) {
        const status = normalizeDiscoveryBacklogStatus(row.status);
        // Keep historical rows without leaving an older copy of the same action open.
        // A fresh open row supersedes its predecessor; an explicit resolved/stale row
        // closes it. The narrow identity avoids closing unrelated gaps in one scope.
        reconcile.run(status === "open" ? "stale" : status, ts, projectId, runId, row.kind, row.scopeId ?? null, row.title ?? null, row.location ?? null);
        stmt.run(
          projectId,
          runId,
          row.kind,
          status,
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
      this.reconcileAuditedScopeBacklog(projectId);
    });
  }

  /** Close coverage work whose exact mapped scope has completed. Older releases
   * left these rows open forever, so this runs both after live scope/backlog
   * updates and as an idempotent startup data migration. Resource requests are
   * deliberately excluded: an audited scope does not prove its setup blocker
   * was resolved. */
  private reconcileAuditedScopeBacklog(projectId?: number): number {
    const projectClause = projectId === undefined ? "" : "AND b.project_id = ?";
    const params: Array<string | number> = [now()];
    if (projectId !== undefined) params.push(projectId);
    return Number(this.db.prepare(
      `UPDATE discovery_backlog AS b
          SET status = 'resolved', updated_at = ?
        WHERE b.status = 'open'
          AND b.kind IN ('coverage-gap', 'followup-scope')
          AND b.scope_id IS NOT NULL
          ${projectClause}
          AND EXISTS (
            SELECT 1 FROM scope AS s
             WHERE s.project_id = b.project_id
               AND s.scope_id = b.scope_id
               AND s.status = 'audited'
          )`,
    ).run(...params).changes);
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
        const canonicalKey = canonicalFindingKey(f.title, f.location, f.findingKey);
        const origin = f.originId != null
          ? this.db.prepare("SELECT * FROM finding WHERE id = ? AND project_id = ?").get(f.originId, projectId) as Record<string, unknown> | undefined
          : undefined;
        const alias = !origin
          ? this.db.prepare("SELECT f.* FROM finding_key_alias a JOIN finding f ON f.id = a.finding_id WHERE a.project_id = ? AND a.alias_key = ?")
            .get(projectId, f.findingKey.toLowerCase()) as Record<string, unknown> | undefined
          : undefined;
        const canonical = !origin && !alias
          ? this.db.prepare("SELECT * FROM finding WHERE project_id = ? AND canonical_key = ? ORDER BY id LIMIT 1").get(projectId, canonicalKey) as Record<string, unknown> | undefined
          : undefined;
        const existing = origin ?? alias ?? canonical;
        if (!existing) {
          const hasDisclosureReport = isFindingDisclosureStatus(f.status);
          const info = this.db
            .prepare(
              `INSERT INTO finding(uuid, project_id, run_id, finding_key, canonical_key, occurrence_count,
                 title, location, severity, status, report_path, report_markdown, scope_id, description,
                 evidence, exploit_sketch, fix, confidence, refutation_status, refutation_reason, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(randomUUID(), projectId, runId, f.findingKey, canonicalKey, f.title ?? null, f.location ?? null, f.severity ?? null, f.status, hasDisclosureReport ? f.reportPath ?? null : null, hasDisclosureReport ? f.reportMarkdown ?? null : null, f.scopeId ?? null, f.description ?? null, f.evidence ?? null, f.exploitSketch ?? null, f.fix ?? null, f.confidence ?? null, f.refutationStatus ?? null, f.refutationReason ?? null, ts, ts);
          const findingId = Number(info.lastInsertRowid);
          this.recordStatusEvent(findingId, null, f.status, reason, runId, ts);
          this.recordFindingOccurrence(findingId, projectId, runId, f, reason, ts);
          this.upsertFindingAlias(projectId, f.findingKey, findingId, ts);
        } else {
          const findingId = Number(existing.id);
          const previousStatus = String(existing.status);
          const sameRun = Number(existing.run_id) === runId;
          const latestVerifyAttempt = origin
            ? this.db.prepare(
              `SELECT run_id FROM finding_phase_attempt
                WHERE project_id = ? AND subject_type = 'finding' AND subject_id = ? AND phase = 'verify'
                ORDER BY attempt_number DESC LIMIT 1`,
            ).get(projectId, findingId) as { run_id: number | null } | undefined
            : undefined;
          const existingRunId = Number(existing.run_id ?? 0);
          const canonicalRunIsNewer = existingRunId > runId;
          const incomingRun = canonicalRunIsNewer ? this.getRun(runId) : undefined;
          const canonicalRun = canonicalRunIsNewer ? this.getRun(existingRunId) : undefined;
          const sameKnownMaterial = canonicalRunIsNewer
            && typeof incomingRun?.material_fingerprint === "string"
            && incomingRun.material_fingerprint.length > 0
            && incomingRun.material_fingerprint === canonicalRun?.material_fingerprint;
          const canonicalHasBarrierEvidence = isFindingDisclosureStatus(String(existing.status))
            || existing.status === "refuted"
            || existing.confirm_status === "reproduced";
          const staleOriginVerdict = Boolean(origin)
            && (Number(latestVerifyAttempt?.run_id ?? 0) > runId
              || (canonicalRunIsNewer && (canonicalHasBarrierEvidence || !sameKnownMaterial)));
          const authoritative = Boolean(origin) || sameRun;
          if (!staleOriginVerdict) {
          const acceptsIncoming = authoritative || findingStatusRank(f.status) >= findingStatusRank(previousStatus);
          // Real-target reproduction is stronger evidence than a later sealed/local
          // negative verdict. Preserve the reproduced canonical finding and surface
          // the disagreement for human adjudication instead of deleting its report.
          const reproducedConflict = existing.confirm_status === "reproduced"
            && !isFindingDisclosureStatus(f.status)
            && acceptsIncoming;
          const reproducedPositiveDowngrade = existing.confirm_status === "reproduced"
            && isFindingDisclosureStatus(previousStatus)
            && isFindingDisclosureStatus(f.status)
            && findingStatusRank(f.status) < findingStatusRank(previousStatus);
          const reproducedProtection = reproducedConflict || reproducedPositiveDowngrade;
          const nextStatus = reproducedProtection
            ? (isFindingDisclosureStatus(previousStatus) ? previousStatus : "confirmed-executable")
            : acceptsIncoming ? f.status : previousStatus as FindingStatus;
          const hasDisclosureReport = isFindingDisclosureStatus(nextStatus);
          const updateCanonicalContent = !reproducedProtection;
          const replaceRefutation = (reproducedConflict && f.status === "refuted")
            || (!reproducedConflict && !sameRun && acceptsIncoming);
          const nextRefutationStatus = reproducedConflict && f.status === "refuted" ? "conflict" : f.refutationStatus ?? null;
          const nextRefutationReason = reproducedConflict && f.status === "refuted"
            ? "Local verification conflicts with an existing real-target reproduction; human adjudication is required."
            : f.refutationReason ?? null;
          // A weaker cross-run occurrence is provenance, not a new evidence owner. If it
          // stole run_id here, its next checkpoint in the same run would become
          // `sameRun`/authoritative and could downgrade the stronger canonical verdict.
          const nextEvidenceRunId = reproducedProtection || !acceptsIncoming
            ? (existing.run_id == null ? null : Number(existing.run_id))
            : runId;
          // COALESCE(NULLIF(?, ''), col): keep the stored content when a later re-persist (a status
          // flip through differential / refutation / appeal) carries an empty value, so detail is
          // never wiped — mirrors the dig_seconds keep-on-omit rule.
          this.db
            .prepare(
              `UPDATE finding SET run_id = ?,
                 title = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), title) ELSE title END,
                 location = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), location) ELSE location END,
                 severity = CASE WHEN ? THEN COALESCE(?, severity) ELSE severity END,
                 status = ?,
                 report_path = CASE WHEN ? THEN COALESCE(?, report_path) ELSE NULL END,
                 report_markdown = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), report_markdown) ELSE NULL END,
                 scope_id = CASE WHEN ? THEN COALESCE(?, scope_id) ELSE scope_id END,
                 description = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), description) ELSE description END,
                 evidence = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), evidence) ELSE evidence END,
                 exploit_sketch = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), exploit_sketch) ELSE exploit_sketch END,
                 fix = CASE WHEN ? THEN COALESCE(NULLIF(?, ''), fix) ELSE fix END,
                 confidence = CASE WHEN ? THEN COALESCE(?, confidence) ELSE confidence END,
                 refutation_status = CASE WHEN ? THEN ? ELSE COALESCE(?, refutation_status) END,
                 refutation_reason = CASE WHEN ? THEN NULLIF(?, '') ELSE COALESCE(NULLIF(?, ''), refutation_reason) END,
                 updated_at = ? WHERE id = ?`,
            )
            .run(
              nextEvidenceRunId,
              authoritative && updateCanonicalContent ? 1 : 0, f.title ?? null,
              authoritative && updateCanonicalContent ? 1 : 0, f.location ?? null,
              acceptsIncoming && updateCanonicalContent ? 1 : 0, f.severity ?? null,
              nextStatus,
              hasDisclosureReport ? 1 : 0, f.reportPath ?? null,
              hasDisclosureReport ? 1 : 0, f.reportMarkdown ?? null,
              updateCanonicalContent ? 1 : 0, f.scopeId ?? null,
              updateCanonicalContent ? 1 : 0, f.description ?? null,
              updateCanonicalContent ? 1 : 0, f.evidence ?? null,
              updateCanonicalContent ? 1 : 0, f.exploitSketch ?? null,
              updateCanonicalContent ? 1 : 0, f.fix ?? null,
              updateCanonicalContent ? 1 : 0, f.confidence ?? null,
              replaceRefutation ? 1 : 0, nextRefutationStatus, nextRefutationStatus,
              replaceRefutation ? 1 : 0, nextRefutationReason, nextRefutationReason,
              ts,
              findingId,
            );
          if (previousStatus !== nextStatus) {
            this.recordStatusEvent(findingId, previousStatus, nextStatus, reproducedConflict ? "real-target reproduction preserved against local conflict" : reason, runId, ts);
          }
          }
          this.recordFindingOccurrence(findingId, projectId, runId, f, reason, ts);
          this.upsertFindingAlias(projectId, f.findingKey, findingId, ts);
        }
        if (f.phaseAttempt) {
          this.recordFindingPhaseAttempt(projectId, runId, { ...f.phaseAttempt, phase: "verify", state: "settled", outcome: f.status });
        }
      }
    });
  }

  private upsertFindingAlias(projectId: number, key: string, findingId: number, ts: string): void {
    this.db.prepare(
      `INSERT INTO finding_key_alias(project_id, alias_key, finding_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, alias_key) DO UPDATE SET finding_id = excluded.finding_id, updated_at = excluded.updated_at`,
    ).run(projectId, key.toLowerCase(), findingId, ts, ts);
  }

  private recordFindingOccurrence(findingId: number, projectId: number, runId: number, finding: FindingRow, reason: string | undefined, ts: string): void {
    this.db.prepare(
      `INSERT INTO finding_occurrence(finding_id, project_id, run_id, finding_key, title, location, scope_id, status, reason, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, finding_key) DO UPDATE SET
         finding_id = excluded.finding_id, title = excluded.title, location = excluded.location,
         scope_id = excluded.scope_id, status = excluded.status, reason = excluded.reason,
         payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    ).run(findingId, projectId, runId, finding.findingKey, finding.title ?? null, finding.location ?? null, finding.scopeId ?? null, finding.status, reason ?? null, jsonOrNull(finding), ts, ts);
    this.db.prepare("UPDATE finding SET occurrence_count = (SELECT COUNT(*) FROM finding_occurrence WHERE finding_id = ?) WHERE id = ?").run(findingId, findingId);
  }

  private recordStatusEvent(findingId: number, from: string | null, to: string, reason: string | undefined, runId: number | null, ts: string): void {
    this.db
      .prepare("INSERT INTO finding_status_event(finding_id, from_status, to_status, reason, run_id, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(findingId, from, to, reason ?? null, runId, ts);
  }

  listFindings(projectId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding WHERE project_id = ? ORDER BY updated_at DESC, id DESC").all(projectId) as Array<Record<string, unknown>>;
  }

  getFinding(id: number): Record<string, unknown> | undefined {
    return this.db.prepare(globalFindingSelect("WHERE f.id = ?") + " LIMIT 1").get(id) as Record<string, unknown> | undefined;
  }

  // --- global (cross-project) bug view -------------------------------------

  /** Findings across tracked projects, newest first. Evaluation findings are excluded by
   * default so benchmark evidence cannot silently enter the product finding registry. */
  listGlobalFindings(opts: { projectUuid?: string | undefined; status?: string | undefined; tracking?: string | undefined; source?: "project" | "evaluation" | "all" | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Array<Record<string, unknown>> {
    const { where, params } = globalFindingWhere(opts);
    const limit = Math.max(1, Math.floor(opts.limit ?? 200));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    return this.db
      .prepare(globalFindingSelect(where) + " ORDER BY f.updated_at DESC, f.id DESC LIMIT ? OFFSET ?")
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
  }

  countGlobalFindings(opts: { projectUuid?: string | undefined; status?: string | undefined; tracking?: string | undefined; source?: "project" | "evaluation" | "all" | undefined } = {}): number {
    const { where, params } = globalFindingWhere(opts);
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM finding f JOIN project p ON p.id = f.project_id ${where}`).get(...params) as { n: number }).n);
  }

  /** Aggregate counts for the Bugs dashboard: total findings, a breakdown by status, and a
   * breakdown by tracking state (untracked findings count as 'open'). */
  globalFindingStats(opts: { projectUuid?: string | undefined; source?: "project" | "evaluation" | "all" | undefined } = {}): { total: number; byStatus: Record<string, number>; byTracking: Record<string, number> } {
    const { where, params } = globalFindingWhere(opts);
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT f.status AS status, COUNT(*) AS n FROM finding f JOIN project p ON p.id = f.project_id ${where} GROUP BY f.status`).all(...params) as Array<{ status: string; n: number }>) byStatus[r.status] = Number(r.n);
    const byTracking: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT COALESCE(f.tracking_status, 'open') AS t, COUNT(*) AS n FROM finding f JOIN project p ON p.id = f.project_id ${where} GROUP BY t`).all(...params) as Array<{ t: string; n: number }>) byTracking[r.t] = Number(r.n);
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM finding f JOIN project p ON p.id = f.project_id ${where}`).get(...params) as { n: number }).n);
    return { total, byStatus, byTracking };
  }

  /** Update a finding's submission-tracking state (does NOT touch updated_at, so the audit
   * "found" time and newest-first ordering are preserved). */
  setFindingTracking(id: number, status: string, duplicateOfFindingId?: number | null): boolean {
    let duplicateOf: number | null = null;
    if (status === "duplicate") {
      if (!Number.isInteger(duplicateOfFindingId) || Number(duplicateOfFindingId) <= 0 || Number(duplicateOfFindingId) === id) return false;
      const source = this.db.prepare("SELECT project_id FROM finding WHERE id = ?").get(id) as { project_id: number } | undefined;
      const target = this.db.prepare("SELECT project_id, tracking_status FROM finding WHERE id = ?").get(Number(duplicateOfFindingId)) as { project_id: number; tracking_status: string | null } | undefined;
      if (!source || !target || source.project_id !== target.project_id || target.tracking_status === "duplicate") return false;
      duplicateOf = Number(duplicateOfFindingId);
    }
    return this.db.prepare("UPDATE finding SET tracking_status = ?, duplicate_of_finding_id = ? WHERE id = ?").run(status || null, duplicateOf, id).changes > 0;
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
  confirmableContext(projectId: number): Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null; confirm_status: string | null; refutation_status: string | null }> {
    return this.db
      .prepare(
        `SELECT f.id, f.finding_key, f.title, f.run_id, r.run_dir, f.report_path, f.confirm_status, f.refutation_status
           FROM finding f LEFT JOIN run r ON r.id = f.run_id
          WHERE f.project_id = ?
            AND COALESCE(f.tracking_status, 'open') <> 'ignored'
            AND f.status IN ('confirmed-differential','confirmed-executable','confirmed-source')
          ORDER BY f.status, f.id`,
      )
      .all(projectId) as Array<{ id: number; finding_key: string; title: string; run_id: number | null; run_dir: string | null; report_path: string | null; confirm_status: string | null; refutation_status: string | null }>;
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
   * (the same key the confirm work list carries). A reproduced result also restores the
   * disclosure invariant and therefore updates the finding timestamp when repair is needed. */
  setFindingConfirmStatus(projectId: number, findingKey: string, confirmStatus: string | null): boolean {
    const finding = this.resolveFindingByKey(projectId, findingKey);
    if (!finding) return false;
    return this.applyFindingConfirmStatus(projectId, Number(finding.id), confirmStatus);
  }

  private applyFindingConfirmStatus(
    projectId: number,
    findingId: number,
    confirmStatus: string | null,
    options: { onlyIfNull?: boolean; runId?: number } = {},
  ): boolean {
    const finding = this.db.prepare(
      "SELECT id, status, confirm_status, report_path, report_markdown, refutation_status, refutation_reason FROM finding WHERE project_id = ? AND id = ?",
    ).get(projectId, findingId) as Record<string, unknown> | undefined;
    if (!finding || (options.onlyIfNull && finding.confirm_status != null)) return false;
    if (confirmStatus !== "reproduced") {
      if (confirmStatus === "not-reproduced" && finding.refutation_status === "conflict") {
        const previousStatus = String(finding.status);
        const ts = now();
        const changed = this.db.prepare(
          `UPDATE finding SET confirm_status = 'not-reproduced', status = 'refuted',
             report_path = NULL, report_markdown = NULL,
             refutation_status = 'refuted',
             refutation_reason = 'A later real-target confirmation no longer reproduced the claim; the local refutation is authoritative.',
             updated_at = ?
           WHERE project_id = ? AND id = ?`,
        ).run(ts, projectId, findingId).changes > 0;
        if (changed && previousStatus !== "refuted") {
          this.recordStatusEvent(findingId, previousStatus, "refuted", "real-target retry resolved the evidence conflict in favor of the local refutation", options.runId ?? null, ts);
        }
        return changed;
      }
      return this.db.prepare("UPDATE finding SET confirm_status = ? WHERE project_id = ? AND id = ?")
        .run(confirmStatus, projectId, findingId).changes > 0;
    }

    let restoredPath: string | null = null;
    let restoredMarkdown: string | null = null;
    const occurrences = this.db.prepare(
      `SELECT payload_json FROM finding_occurrence
        WHERE finding_id = ? AND status IN ('confirmed-source','confirmed-executable','confirmed-differential')
        ORDER BY id DESC`,
    ).all(findingId) as Array<{ payload_json: string | null }>;
    for (const occurrence of occurrences) {
      const payload = typeof occurrence.payload_json === "string" ? jsonParseOrNull(occurrence.payload_json) : null;
      if (!isRecord(payload)) continue;
      restoredPath ??= stringValue(payload.reportPath ?? payload.report_path) ?? null;
      restoredMarkdown ??= stringValue(payload.reportMarkdown ?? payload.report_markdown) ?? null;
      if (restoredPath && restoredMarkdown) break;
    }

    const previousStatus = String(finding.status);
    const localConflict = previousStatus === "refuted";
    const nextStatus = isFindingDisclosureStatus(previousStatus) ? previousStatus : "confirmed-executable";
    const nextRefutationStatus = localConflict ? "conflict" : nullableText(finding.refutation_status);
    const nextRefutationReason = localConflict
      ? "Local verification conflicts with an existing real-target reproduction; human adjudication is required."
      : nullableText(finding.refutation_reason);
    const nextReportPath = nullableText(finding.report_path) ?? restoredPath;
    const nextReportMarkdown = nullableText(finding.report_markdown) ?? restoredMarkdown;
    if (finding.confirm_status === "reproduced"
      && previousStatus === nextStatus
      && nullableText(finding.report_path) === nextReportPath
      && nullableText(finding.report_markdown) === nextReportMarkdown
      && nullableText(finding.refutation_status) === nextRefutationStatus
      && nullableText(finding.refutation_reason) === nextRefutationReason) return false;
    const ts = now();
    const changed = this.db.prepare(
      `UPDATE finding SET confirm_status = 'reproduced', status = ?,
         report_path = COALESCE(report_path, ?), report_markdown = COALESCE(report_markdown, ?),
         refutation_status = ?, refutation_reason = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
    ).run(nextStatus, nextReportPath, nextReportMarkdown, nextRefutationStatus, nextRefutationReason, ts, projectId, findingId).changes > 0;
    if (previousStatus !== nextStatus) {
      this.recordStatusEvent(findingId, previousStatus, nextStatus, "real-target reproduction superseded local verdict", options.runId ?? null, ts);
    }
    return changed;
  }

  resolveFindingByKey(projectId: number, findingKey: string): Record<string, unknown> | undefined {
    return this.db.prepare(
      `SELECT f.* FROM finding f
       LEFT JOIN finding_key_alias a ON a.finding_id = f.id AND a.project_id = f.project_id
       WHERE f.project_id = ? AND (LOWER(f.finding_key) = LOWER(?) OR LOWER(a.alias_key) = LOWER(?))
       ORDER BY f.id LIMIT 1`,
    ).get(projectId, findingKey, findingKey) as Record<string, unknown> | undefined;
  }

  private canonicalConfirmMembers(projectId: number, members: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const member of members) {
      let canonical = member;
      for (const key of confirmMemberKeys(member)) {
        const finding = this.resolveFindingByKey(projectId, key);
        const findingKey = finding ? nullableText(finding.finding_key) : null;
        if (findingKey) {
          canonical = findingKey;
          break;
        }
      }
      const dedupeKey = canonical.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(canonical);
    }
    return out;
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
      .prepare("SELECT * FROM finding " + where.sql + " ORDER BY CASE LOWER(COALESCE(severity,'')) WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 WHEN 'info' THEN 1 ELSE 0 END DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(...where.params, limit, offset) as Array<Record<string, unknown>>;
  }

  findingTimeline(findingId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding_status_event WHERE finding_id = ? ORDER BY ts ASC").all(findingId) as Array<Record<string, unknown>>;
  }

  findingOccurrences(findingId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM finding_occurrence WHERE finding_id = ? ORDER BY created_at ASC, id ASC").all(findingId) as Array<Record<string, unknown>>;
  }

  recordFindingPhaseAttempt(projectId: number, runId: number, input: FindingPhaseAttemptInput): number {
    const ts = now();
    const existing = this.db.prepare(
      "SELECT id, attempt_number FROM finding_phase_attempt WHERE subject_type = ? AND subject_id = ? AND phase = ? AND run_id = ?",
    ).get(input.subjectType, input.subjectId, input.phase, runId) as { id: number; attempt_number: number } | undefined;
    const terminal = input.state !== "running";
    if (existing) {
      this.db.prepare(
        `UPDATE finding_phase_attempt SET input_fingerprint = ?, state = ?, outcome = ?, blocker = ?, metrics_json = COALESCE(?, metrics_json),
           updated_at = ?, started_at = COALESCE(started_at, ?), ended_at = ? WHERE id = ?`,
      ).run(input.inputFingerprint, input.state, input.outcome ?? null, input.blocker ?? null, jsonOrNull(input.metrics), ts, ts, terminal ? ts : null, existing.id);
      if (input.state === "running") this.clearFindingPhaseRetry(projectId, input.subjectType, input.subjectId, input.phase);
      return existing.id;
    }
    const previous = this.db.prepare(
      "SELECT COALESCE(MAX(attempt_number), 0) AS n FROM finding_phase_attempt WHERE project_id = ? AND subject_type = ? AND subject_id = ? AND phase = ?",
    ).get(projectId, input.subjectType, input.subjectId, input.phase) as { n: number };
    const info = this.db.prepare(
      `INSERT INTO finding_phase_attempt(project_id, subject_type, subject_id, phase, input_fingerprint, attempt_number,
         run_id, state, outcome, blocker, metrics_json, created_at, updated_at, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, input.subjectType, input.subjectId, input.phase, input.inputFingerprint, Number(previous.n) + 1, runId, input.state, input.outcome ?? null, input.blocker ?? null, jsonOrNull(input.metrics), ts, ts, ts, terminal ? ts : null);
    if (input.state === "running") this.clearFindingPhaseRetry(projectId, input.subjectType, input.subjectId, input.phase);
    return Number(info.lastInsertRowid);
  }

  listFindingPhaseAttempts(subjectType: "finding" | "decision", subjectId: number): Array<Record<string, unknown>> {
    return this.db.prepare(
      "SELECT * FROM finding_phase_attempt WHERE subject_type = ? AND subject_id = ? ORDER BY phase, attempt_number",
    ).all(subjectType, subjectId) as Array<Record<string, unknown>>;
  }

  latestFindingPhaseAttempt(subjectType: "finding" | "decision", subjectId: number, phase: FindingPhase): Record<string, unknown> | undefined {
    return this.db.prepare(
      "SELECT * FROM finding_phase_attempt WHERE subject_type = ? AND subject_id = ? AND phase = ? ORDER BY attempt_number DESC LIMIT 1",
    ).get(subjectType, subjectId, phase) as Record<string, unknown> | undefined;
  }

  latestFindingPhaseAttempts(subjectType: "finding" | "decision", subjectIds: number[]): Array<Record<string, unknown>> {
    const ids = [...new Set(subjectIds.filter(Number.isFinite))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const sql = "SELECT a.* FROM finding_phase_attempt a JOIN (SELECT subject_id, phase, MAX(attempt_number) AS attempt_number FROM finding_phase_attempt WHERE subject_type = ? AND subject_id IN (" + placeholders + ") GROUP BY subject_id, phase) latest ON latest.subject_id = a.subject_id AND latest.phase = a.phase AND latest.attempt_number = a.attempt_number WHERE a.subject_type = ?";
    return this.db.prepare(sql).all(subjectType, ...ids, subjectType) as Array<Record<string, unknown>>;
  }

  phaseEligible(projectId: number, subjectType: "finding" | "decision", subjectId: number, phase: FindingPhase, inputFingerprint: string): boolean {
    const retry = this.db.prepare(
      "SELECT 1 AS yes FROM phase_retry_request WHERE project_id = ? AND subject_type = ? AND subject_id = ? AND phase = ?",
    ).get(projectId, subjectType, subjectId, phase);
    if (retry) return true;
    const latest = this.latestFindingPhaseAttempt(subjectType, subjectId, phase);
    return !(latest?.state === "blocked" && latest.input_fingerprint === inputFingerprint);
  }

  hasFindingPhaseRetry(projectId: number, subjectType: "finding" | "decision", subjectId: number, phase: FindingPhase): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 AS yes FROM phase_retry_request WHERE project_id = ? AND subject_type = ? AND subject_id = ? AND phase = ?",
    ).get(projectId, subjectType, subjectId, phase));
  }

  requestFindingPhaseRetry(projectId: number, subjectType: "finding" | "decision", subjectId: number, phase: FindingPhase): boolean {
    const subject = subjectType === "finding" ? this.getFinding(subjectId) : this.getConfirmDecision(subjectId);
    if (!subject || Number(subject.project_id) !== projectId) return false;
    this.db.prepare(
      `INSERT INTO phase_retry_request(project_id, subject_type, subject_id, phase, requested_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, subject_type, subject_id, phase) DO UPDATE SET requested_at = excluded.requested_at`,
    ).run(projectId, subjectType, subjectId, phase, now());
    return true;
  }

  private clearFindingPhaseRetry(projectId: number, subjectType: "finding" | "decision", subjectId: number, phase: FindingPhase): void {
    this.db.prepare("DELETE FROM phase_retry_request WHERE project_id = ? AND subject_type = ? AND subject_id = ? AND phase = ?")
      .run(projectId, subjectType, subjectId, phase);
  }

  // --- confirm decisions ----------------------------------------------------

  upsertConfirmDecisions(projectId: number, runId: number, rows: ConfirmRow[], decisionPath?: string): void {
    this.transaction(() => {
      const readyRows = enforceSubmissionReadiness(
        rows.map((row) => ({ ...row, evidenceLevel: row.evidenceLevel ?? decisionEvidenceLevel(row) })),
        { requireImpactInventory: false },
      );
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
      const markDuplicate = this.db.prepare(
        `UPDATE finding
            SET tracking_status = 'duplicate', duplicate_of_finding_id = ?
          WHERE project_id = ? AND id = ?
            AND COALESCE(tracking_status, 'open') IN ('open', 'triaging', 'duplicate')`,
      );
      type ConfirmFindingMetadata = { id: number; findingKey: string; severity?: string; updatedAt?: string; canonicalKey?: string; status?: string; confirmStatus?: string | null; trackingStatus?: string | null; runId?: number };
      const findingsByKey = new Map<string, ConfirmFindingMetadata>();
      for (const row of this.db.prepare("SELECT id, run_id, finding_key, canonical_key, severity, status, confirm_status, tracking_status, updated_at FROM finding WHERE project_id = ?").all(projectId) as Array<{ id: number; run_id: number | null; finding_key: string | null; canonical_key: string | null; severity: string | null; status: string | null; confirm_status: string | null; tracking_status: string | null; updated_at: string | null }>) {
        if (!row.finding_key) continue;
        const metadata: ConfirmFindingMetadata = { id: row.id, findingKey: row.finding_key, confirmStatus: row.confirm_status, trackingStatus: row.tracking_status };
        if (row.severity) metadata.severity = row.severity;
        if (row.updated_at) metadata.updatedAt = row.updated_at;
        if (row.canonical_key) metadata.canonicalKey = row.canonical_key;
        if (row.status) metadata.status = row.status;
        if (row.run_id != null) metadata.runId = row.run_id;
        findingsByKey.set(row.finding_key.toLowerCase(), metadata);
      }
      const byId = new Map<number, ConfirmFindingMetadata>();
      for (const metadata of findingsByKey.values()) byId.set(metadata.id, metadata);
      for (const alias of this.db.prepare("SELECT alias_key, finding_id FROM finding_key_alias WHERE project_id = ?").all(projectId) as Array<{ alias_key: string; finding_id: number }>) {
        const canonical = byId.get(alias.finding_id);
        if (canonical) findingsByKey.set(alias.alias_key.toLowerCase(), canonical);
      }
      for (const r of readyRows) {
        const members = [...new Set((r.members ?? []).map((member) => {
          for (const key of confirmMemberKeys(member)) {
            const finding = findingsByKey.get(key.toLowerCase());
            if (finding) return finding.findingKey;
          }
          return member;
        }))];
        const linked = linkedFindingMetadata(findingsByKey, members);
        const evidenceLevel = decisionEvidenceLevel(r);
        const submissionConfidence = decisionSubmissionConfidence(r, evidenceLevel);
        stmt.run(
          projectId,
          runId,
          r.bug,
          r.reproduced ?? null,
          r.recommendation ?? null,
          jsonOrNull(members),
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
        const linkedIds = new Set<number>();
        for (const member of members) {
          for (const key of confirmMemberKeys(member)) {
            const finding = findingsByKey.get(key.toLowerCase());
            if (!finding) continue;
            linkedIds.add(finding.id);
            if (outcome) this.applyFindingConfirmStatus(projectId, finding.id, outcome, { runId });
          }
        }
        // `mergedFrom` is emitted only by the execution-based fix-equivalence
        // consolidation step. Reflect that proven bug identity into the product
        // lifecycle so operators see one canonical bug instead of spending review
        // time on every discovery-path variant. Never overwrite explicit terminal
        // tracking choices such as submitted or ignored.
        if ((r.mergedFrom?.length ?? 0) > 1 && linkedIds.size > 1) {
          const linkedRows = [...linkedIds].map((id) => byId.get(id)).filter((row): row is ConfirmFindingMetadata => Boolean(row));
          const trackingRank = (status: string | null | undefined): number => status === "submitted" ? 4
            : status === "triaging" ? 3
              : status === "open" || status == null ? 2
                : status === "duplicate" ? 1
                  : 0;
          const canonical = linkedRows
            .filter((row) => row.trackingStatus !== "duplicate")
            .sort((a, b) => trackingRank(b.trackingStatus) - trackingRank(a.trackingStatus) || a.id - b.id)[0]
            ?? linkedRows.sort((a, b) => a.id - b.id)[0];
          if (canonical) {
            for (const finding of linkedRows) {
              if (finding.id === canonical.id) continue;
              if (markDuplicate.run(canonical.id, projectId, finding.id).changes > 0) finding.trackingStatus = "duplicate";
            }
          }
        }
        const blocked = r.reproduced === "could-not-set-up" || r.reproduced === "unknown" || needsSubmissionReadinessWork(r);
        for (const findingId of linkedIds) {
          const metadata = byId.get(findingId);
          const current = this.getFinding(findingId);
          const currentRunId = current?.run_id != null ? Number(current.run_id) : metadata?.runId;
          const sourceRun = currentRunId !== undefined ? this.getRun(currentRunId) : undefined;
          this.recordFindingPhaseAttempt(projectId, runId, {
            subjectType: "finding",
            subjectId: findingId,
            phase: "confirm",
            inputFingerprint: phaseInputFingerprint({
              phase: "confirm",
              material: sourceRun?.material_fingerprint ?? null,
              findingId,
              canonicalKey: current?.canonical_key ?? metadata?.canonicalKey ?? null,
              status: current?.status ?? metadata?.status ?? null,
              updatedAt: current?.updated_at ?? metadata?.updatedAt ?? null,
            }),
            state: blocked ? "blocked" : "settled",
            outcome: r.reproduced ?? "unknown",
            blocker: blocked ? (r.humanGates || `confirmation ended as ${r.reproduced ?? "unknown"}`) : undefined,
            metrics: { evidenceLevel, recommendation: r.recommendation },
          });
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
    const finding = this.resolveFindingByKey(projectId, findingKey);
    const keys = new Set<string>([findingKey.toLowerCase()]);
    if (finding) {
      keys.add(String(finding.finding_key).toLowerCase());
      for (const alias of this.db.prepare("SELECT alias_key FROM finding_key_alias WHERE finding_id = ?").all(Number(finding.id)) as Array<{ alias_key: string }>) keys.add(alias.alias_key.toLowerCase());
    }
    return this.listConfirmDecisions(projectId).filter((row) => {
      const members = parseJsonArray(row.members_json);
      return members.some((member) => confirmMemberKeys(String(member)).some((candidate) => keys.has(candidate.toLowerCase())));
    });
  }

  /** Count bugs that actually reproduced on the real target (confirm's real output). */
  countConfirmedBugs(projectId: number): number {
    return Number((this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM confirm_decision
        WHERE project_id = ?
          AND reproduced = 'yes'
          AND evidence_level IN ('real-target-reproduced', 'fork-reproduced', 'local-fork-reproduced')`,
    ).get(projectId) as { n: number }).n);
  }

  // --- run groups + independently resumable work items ---------------------

  createRunGroup(input: RunGroupInput): Record<string, unknown> {
    const ts = now();
    const uuid = randomUUID();
    const parallelism = Math.max(1, Math.floor(input.parallelism ?? 1));
    const info = this.db
      .prepare(
        `INSERT INTO run_group(uuid, name, kind, state, parallelism, config_json, budget_json, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(uuid, input.name, input.kind ?? "evaluation", parallelism, jsonOrNull(input.config), jsonOrNull(input.budget), ts, ts);
    return this.getRunGroupById(Number(info.lastInsertRowid))!;
  }

  getRunGroupById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM run_group WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  getRunGroupByUuid(uuid: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM run_group WHERE uuid = ?").get(uuid) as Record<string, unknown> | undefined;
  }

  getRunGroupByName(name: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM run_group WHERE name = ?").get(name) as Record<string, unknown> | undefined;
  }

  listRunGroups(limit = 100, offset = 0): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM run_group ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset))) as Array<Record<string, unknown>>;
  }

  countRunGroups(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM run_group").get() as { n: number }).n);
  }

  addWorkItems(runGroupId: number, items: EvaluationWorkItemInput[]): Array<Record<string, unknown>> {
    const insert = this.db.prepare(
      `INSERT INTO work_item(uuid, run_group_id, item_key, kind, state, target_bundle_json, material_policy_json,
                             evidence_contract_json, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    );
    const ts = now();
    this.transaction(() => {
      for (const item of items) {
        insert.run(
          randomUUID(),
          runGroupId,
          item.itemKey,
          item.kind,
          JSON.stringify(item.targetBundle),
          JSON.stringify(item.materialPolicy),
          JSON.stringify(item.evidenceContract),
          item.projectId ?? null,
          ts,
          ts,
        );
      }
      this.db.prepare("UPDATE run_group SET updated_at = ? WHERE id = ?").run(ts, runGroupId);
    });
    return this.listWorkItems(runGroupId);
  }

  listWorkItems(runGroupId: number): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM work_item WHERE run_group_id = ? ORDER BY id").all(runGroupId) as Array<Record<string, unknown>>;
  }

  getWorkItem(id: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM work_item WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  getWorkItemByJob(jobId: number): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM work_item WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
  }

  listWorkItemAttempts(workItemId: number): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM work_item_attempt WHERE work_item_id = ? ORDER BY attempt_number")
      .all(workItemId) as Array<Record<string, unknown>>;
  }

  runGroupForJob(jobId: number): Record<string, unknown> | undefined {
    return this.db
      .prepare("SELECT rg.* FROM run_group rg JOIN work_item wi ON wi.run_group_id = rg.id WHERE wi.job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
  }

  startRunGroup(uuid: string, parallelism?: number): boolean {
    const group = this.getRunGroupByUuid(uuid);
    if (!group || group.state === "finished" || group.state === "cancelled" || group.state === "failed") return false;
    const nextParallelism = Math.max(1, Math.floor(parallelism ?? (Number(group.parallelism) || 1)));
    const ts = now();
    return Number(this.db
      .prepare("UPDATE run_group SET state = 'running', parallelism = ?, started_at = COALESCE(started_at, ?), ended_at = NULL, updated_at = ? WHERE id = ?")
      .run(nextParallelism, ts, ts, Number(group.id)).changes) > 0;
  }

  setRunGroupState(uuid: string, state: RunGroupState): boolean {
    const terminal = state === "finished" || state === "failed" || state === "cancelled";
    const ts = now();
    return Number(this.db
      .prepare("UPDATE run_group SET state = ?, ended_at = CASE WHEN ? THEN COALESCE(ended_at, ?) ELSE NULL END, updated_at = ? WHERE uuid = ?")
      .run(state, terminal ? 1 : 0, ts, ts, uuid).changes) > 0;
  }

  pendingRunGroupDispatch(runGroupId: number, limit: number): Array<Record<string, unknown>> {
    const group = this.getRunGroupById(runGroupId);
    if (!group || group.state !== "running") return [];
    const active = Number((this.db
      .prepare("SELECT COUNT(*) AS n FROM work_item WHERE run_group_id = ? AND job_id IS NOT NULL AND state IN ('queued','claimed','running')")
      .get(runGroupId) as { n: number }).n);
    const available = Math.max(0, Math.min(Math.max(1, Math.floor(limit)), Number(group.parallelism) - active));
    if (available === 0) return [];
    return this.db
      .prepare("SELECT * FROM work_item WHERE run_group_id = ? AND state = 'queued' AND job_id IS NULL ORDER BY id LIMIT ?")
      .all(runGroupId, available) as Array<Record<string, unknown>>;
  }

  attachWorkItemJob(workItemId: number, jobId: number): boolean {
    const ts = now();
    let attached = false;
    this.transaction(() => {
      const info = this.db
        .prepare("UPDATE work_item SET job_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND job_id IS NULL")
        .run(jobId, ts, workItemId);
      if (Number(info.changes) === 0) return;
      const item = this.getWorkItem(workItemId)!;
      this.db
        .prepare(
          `INSERT INTO work_item_attempt(work_item_id, attempt_number, job_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(workItemId, Number(item.attempts), jobId, ts, ts);
      attached = true;
    });
    return attached;
  }

  markWorkItemClaimed(jobId: number): void {
    const ts = now();
    // claimJob already holds an IMMEDIATE transaction; keep these statements in
    // that transaction instead of trying to nest another SQLite transaction.
    this.db.prepare("UPDATE work_item SET state = 'claimed', updated_at = ? WHERE job_id = ? AND state = 'queued'").run(ts, jobId);
    this.db.prepare("UPDATE work_item_attempt SET state = 'claimed', updated_at = ? WHERE job_id = ? AND state = 'queued'").run(ts, jobId);
  }

  markWorkItemRunning(jobId: number, runId: number): void {
    const ts = now();
    this.transaction(() => {
      this.db
        .prepare("UPDATE work_item SET state = 'running', run_id = ?, project_id = (SELECT project_id FROM run WHERE id = ?), started_at = COALESCE(started_at, ?), updated_at = ? WHERE job_id = ? AND state IN ('queued','claimed')")
        .run(runId, runId, ts, ts, jobId);
      this.db
        .prepare("UPDATE work_item_attempt SET state = 'running', run_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE job_id = ? AND state IN ('queued','claimed')")
        .run(runId, ts, ts, jobId);
    });
  }

  settleWorkItemByJob(
    jobId: number,
    state: Extract<WorkItemState, "finished" | "failed" | "cancelled">,
    outcome: WorkItemOutcome,
    result: unknown,
    error?: string,
  ): boolean {
    const ts = now();
    let settled = false;
    this.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE work_item SET state = ?, outcome = ?, result_json = ?, last_error = ?, ended_at = ?, updated_at = ?
            WHERE job_id = ? AND state IN ('queued','claimed','running')`,
        )
        .run(state, outcome, jsonOrNull(result), error ?? null, ts, ts, jobId);
      if (Number(info.changes) === 0) return;
      this.db
        .prepare(
          `UPDATE work_item_attempt SET state = ?, outcome = ?, result_json = ?, error = ?, ended_at = ?, updated_at = ?
            WHERE job_id = ? AND state IN ('queued','claimed','running')`,
        )
        .run(state, outcome, jsonOrNull(result), error ?? null, ts, ts, jobId);
      settled = true;
    });
    return settled;
  }

  failUnscheduledWorkItem(workItemId: number, outcome: Extract<WorkItemOutcome, "invalid" | "blocked">, error: string): boolean {
    const ts = now();
    return Number(this.db
      .prepare("UPDATE work_item SET state = 'failed', outcome = ?, result_json = ?, last_error = ?, ended_at = ?, updated_at = ? WHERE id = ? AND state = 'queued' AND job_id IS NULL")
      .run(outcome, JSON.stringify({ accepted: false, reason: outcome, error }), error, ts, ts, workItemId).changes) > 0;
  }

  cancelRunGroupItems(runGroupId: number): number[] {
    const activeJobs = (this.db
      .prepare("SELECT job_id FROM work_item WHERE run_group_id = ? AND job_id IS NOT NULL AND state IN ('queued','claimed','running')")
      .all(runGroupId) as Array<{ job_id: number }>).map((row) => Number(row.job_id));
    const ts = now();
    this.transaction(() => {
      this.db
        .prepare("UPDATE work_item_attempt SET state = 'cancelled', outcome = COALESCE(outcome, 'blocked'), error = COALESCE(error, 'run group cancelled'), ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE job_id IN (SELECT job_id FROM work_item WHERE run_group_id = ? AND job_id IS NOT NULL AND state IN ('queued','claimed','running'))")
        .run(ts, ts, runGroupId);
      this.db
        .prepare("UPDATE work_item SET state = 'cancelled', outcome = COALESCE(outcome, 'blocked'), last_error = COALESCE(last_error, 'run group cancelled'), ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE run_group_id = ? AND state IN ('queued','claimed','running')")
        .run(ts, ts, runGroupId);
    });
    return activeJobs;
  }

  retryBlockedWorkItem(workItemId: number): boolean {
    const item = this.getWorkItem(workItemId);
    if (!item || (item.state !== "failed" && item.state !== "cancelled") || item.outcome !== "blocked") return false;
    const group = this.getRunGroupById(Number(item.run_group_id));
    if (!group || group.state === "cancelled") return false;
    const ts = now();
    let retried = false;
    this.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE work_item
              SET state = 'queued', outcome = NULL, result_json = NULL, job_id = NULL, run_id = NULL,
                  last_error = NULL, started_at = NULL, ended_at = NULL, updated_at = ?
            WHERE id = ? AND state IN ('failed','cancelled') AND outcome = 'blocked'`,
        )
        .run(ts, workItemId);
      if (Number(info.changes) === 0) return;
      if (group.state === "finished" || group.state === "failed") {
        this.db.prepare("UPDATE run_group SET state = 'paused', ended_at = NULL, updated_at = ? WHERE id = ?").run(ts, Number(group.id));
      } else {
        this.db.prepare("UPDATE run_group SET updated_at = ? WHERE id = ?").run(ts, Number(group.id));
      }
      retried = true;
    });
    return retried;
  }

  refreshRunGroupCompletion(runGroupId: number): Record<string, unknown> | undefined {
    const group = this.getRunGroupById(runGroupId);
    if (!group) return undefined;
    const rows = this.listWorkItems(runGroupId);
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.outcome ?? row.state)] = (counts[String(row.outcome ?? row.state)] ?? 0) + 1;
    const summary = { totalItems: rows.length, counts };
    const active = rows.some((row) => row.state === "queued" || row.state === "claimed" || row.state === "running");
    const ts = now();
    const state = group.state === "running" && !active ? "finished" : String(group.state);
    this.db
      .prepare("UPDATE run_group SET state = ?, summary_json = ?, ended_at = CASE WHEN ? = 'finished' THEN COALESCE(ended_at, ?) ELSE ended_at END, updated_at = ? WHERE id = ?")
      .run(state, JSON.stringify(summary), state, ts, ts, runGroupId);
    return this.getRunGroupById(runGroupId);
  }

  // --- harness experiments -------------------------------------------------

  createHarnessExperiment(input: {
    name: string;
    baselineRunGroupId: number;
    candidateRunGroupId?: number | undefined;
    editableFiles: string[];
    promotionPolicy: HarnessPromotionPolicy;
    failurePatterns: unknown[];
    preservedBehaviors: unknown[];
    proposal?: unknown;
    state: HarnessExperimentState;
  }): Record<string, unknown> {
    const ts = now();
    const uuid = randomUUID();
    const info = this.db.prepare(
      `INSERT INTO harness_experiment(
         uuid, name, state, baseline_run_group_id, candidate_run_group_id,
         editable_files_json, promotion_policy_json, failure_patterns_json,
         preserved_behaviors_json, proposal_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      input.name,
      input.state,
      input.baselineRunGroupId,
      input.candidateRunGroupId ?? null,
      JSON.stringify(input.editableFiles),
      JSON.stringify(input.promotionPolicy),
      JSON.stringify(input.failurePatterns),
      JSON.stringify(input.preservedBehaviors),
      jsonOrNull(input.proposal),
      ts,
      ts,
    );
    return this.getHarnessExperimentById(Number(info.lastInsertRowid))!;
  }

  listHarnessExperiments(limit = 100, offset = 0): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT he.*,
              baseline.name AS baseline_name, baseline.uuid AS baseline_uuid, baseline.state AS baseline_state,
              candidate.name AS candidate_name, candidate.uuid AS candidate_uuid, candidate.state AS candidate_state
         FROM harness_experiment he
         JOIN run_group baseline ON baseline.id = he.baseline_run_group_id
    LEFT JOIN run_group candidate ON candidate.id = he.candidate_run_group_id
        ORDER BY he.updated_at DESC, he.id DESC
        LIMIT ? OFFSET ?`,
    ).all(Math.max(1, limit), Math.max(0, offset)) as Array<Record<string, unknown>>;
  }

  countHarnessExperiments(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM harness_experiment").get() as { n: number }).n);
  }

  getHarnessExperimentById(id: number): Record<string, unknown> | undefined {
    return this.db.prepare(
      `SELECT he.*,
              baseline.name AS baseline_name, baseline.uuid AS baseline_uuid, baseline.state AS baseline_state,
              candidate.name AS candidate_name, candidate.uuid AS candidate_uuid, candidate.state AS candidate_state
         FROM harness_experiment he
         JOIN run_group baseline ON baseline.id = he.baseline_run_group_id
    LEFT JOIN run_group candidate ON candidate.id = he.candidate_run_group_id
        WHERE he.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
  }

  getHarnessExperimentByUuid(uuid: string): Record<string, unknown> | undefined {
    return this.db.prepare(
      `SELECT he.*,
              baseline.name AS baseline_name, baseline.uuid AS baseline_uuid, baseline.state AS baseline_state,
              candidate.name AS candidate_name, candidate.uuid AS candidate_uuid, candidate.state AS candidate_state
         FROM harness_experiment he
         JOIN run_group baseline ON baseline.id = he.baseline_run_group_id
    LEFT JOIN run_group candidate ON candidate.id = he.candidate_run_group_id
        WHERE he.uuid = ?`,
    ).get(uuid) as Record<string, unknown> | undefined;
  }

  attachHarnessExperimentCandidate(id: number, candidateRunGroupId: number): boolean {
    const ts = now();
    return Number(this.db.prepare(
      `UPDATE harness_experiment
          SET candidate_run_group_id = ?, state = 'evaluating', scorecard_json = NULL,
              decision = NULL, evaluated_at = NULL, updated_at = ?
        WHERE id = ? AND baseline_run_group_id <> ?`,
    ).run(candidateRunGroupId, ts, id, candidateRunGroupId).changes) > 0;
  }

  updateHarnessExperimentProposal(id: number, proposal: unknown): boolean {
    return Number(this.db.prepare(
      `UPDATE harness_experiment
          SET proposal_json = ?, state = CASE WHEN candidate_run_group_id IS NULL THEN 'proposal-ready' ELSE 'evaluating' END,
              scorecard_json = NULL, decision = NULL, evaluated_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(proposal), now(), id).changes) > 0;
  }

  settleHarnessExperiment(id: number, expectedCandidateRunGroupId: number, scorecard: unknown, decision: HarnessDecision): boolean {
    const ts = now();
    return Number(this.db.prepare(
      `UPDATE harness_experiment
          SET state = 'decided', scorecard_json = ?, decision = ?, evaluated_at = ?, updated_at = ?
        WHERE id = ? AND candidate_run_group_id = ?`,
    ).run(JSON.stringify(scorecard), decision, ts, ts, id, expectedCandidateRunGroupId).changes) > 0;
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
      this.db.prepare("UPDATE run SET daemon_id = NULL WHERE daemon_id = ?").run(id);
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

  /** Atomically claim queued work for a daemon. Operator-launched project work takes priority
   * over background evaluation work; FIFO is preserved inside each class. Running work is never
   * preempted, so a claimed evaluation keeps its isolated workspace until it settles. */
  claimJob(daemonId: number): { id: number; project: string; spec: unknown } | undefined {
    let claimed: { id: number; project: string; spec_json: string } | undefined;
    this.transaction(() => {
      const row = this.db.prepare(
        `SELECT j.id, j.project, j.spec_json
           FROM job j
          WHERE j.status = 'queued' AND (j.daemon_id IS NULL OR j.daemon_id = ?)
          ORDER BY CASE WHEN EXISTS (SELECT 1 FROM work_item wi WHERE wi.job_id = j.id) THEN 1 ELSE 0 END,
                   j.created_at,
                   j.id
          LIMIT 1`,
      ).get(daemonId) as
        | { id: number; project: string; spec_json: string }
        | undefined;
      if (!row) return;
      this.db.prepare("UPDATE job SET status = 'dispatched', daemon_id = ?, updated_at = ? WHERE id = ?").run(daemonId, now(), row.id);
      this.markWorkItemClaimed(row.id);
      claimed = row;
    });
    return claimed ? { id: claimed.id, project: claimed.project, spec: jsonParseOrNull(claimed.spec_json) } : undefined;
  }

  setJobRun(jobId: number, runId: number): void {
    this.db.prepare("UPDATE job SET run_id = ?, status = 'running', updated_at = ? WHERE id = ?").run(runId, now(), jobId);
    this.markWorkItemRunning(jobId, runId);
  }

  setJobStatus(jobId: number, status: string, error?: string): void {
    this.db.prepare("UPDATE job SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error ?? null, now(), jobId);
  }

  /** Terminal daemon updates may race an operator cancellation. Never revive or rewrite a terminal job. */
  setActiveJobTerminalStatus(jobId: number, status: "done" | "error" | "canceled", error?: string): boolean {
    const info = this.db
      .prepare("UPDATE job SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('dispatched','running')")
      .run(status, error ?? null, now(), jobId);
    return Number(info.changes) > 0;
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

  private transaction(fn: () => void, mode: "deferred" | "immediate" = "deferred"): void {
    this.db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
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

function sqlText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
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

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
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

const FINDING_SOURCE_SQL = `CASE
  WHEN p.origin = 'evaluation'
    OR EXISTS (SELECT 1 FROM work_item wi_source WHERE wi_source.run_id = f.run_id)
    OR EXISTS (SELECT 1 FROM work_item_attempt wia_source WHERE wia_source.run_id = f.run_id)
  THEN 'evaluation'
  ELSE 'project'
END`;

function globalFindingWhere(opts: { projectUuid?: string | undefined; status?: string | undefined; tracking?: string | undefined; source?: "project" | "evaluation" | "all" | undefined }): { where: string; params: Array<string | number> } {
  const cond: string[] = ["f.status <> 'discharged'", "(LOWER(COALESCE(f.severity, '')) <> 'info' OR f.status IN ('confirmed-source','confirmed-executable','confirmed-differential','refuted'))"];
  const params: Array<string | number> = [];
  if (opts.projectUuid) { cond.push("p.uuid = ?"); params.push(opts.projectUuid); }
  if (opts.status === "execution-confirmed") cond.push("f.status IN ('confirmed-executable','confirmed-differential')");
  else if (opts.status) { cond.push("f.status = ?"); params.push(opts.status); }
  if (opts.tracking === "active") cond.push("COALESCE(f.tracking_status, 'open') <> 'ignored'");
  else if (opts.tracking) { cond.push("COALESCE(f.tracking_status, 'open') = ?"); params.push(opts.tracking); }
  const source = opts.source ?? "project";
  if (source !== "all") { cond.push(`${FINDING_SOURCE_SQL} = ?`); params.push(source); }
  return { where: cond.length ? "WHERE " + cond.join(" AND ") : "", params };
}

function evaluationGroupFieldSql(field: "name" | "uuid"): string {
  return `(SELECT rg_source.${field}
    FROM work_item wi_group
    JOIN run_group rg_source ON rg_source.id = wi_group.run_group_id
   WHERE wi_group.project_id = p.id
      OR wi_group.run_id = f.run_id
      OR EXISTS (
        SELECT 1 FROM work_item_attempt wia_group
         WHERE wia_group.work_item_id = wi_group.id AND wia_group.run_id = f.run_id
      )
   ORDER BY wi_group.id DESC
   LIMIT 1)`;
}

function globalFindingSelect(where: string): string {
  return `SELECT f.*, p.name AS project_name, p.uuid AS project_uuid,
      ${FINDING_SOURCE_SQL} AS source,
      ${evaluationGroupFieldSql("name")} AS evaluation_name,
      ${evaluationGroupFieldSql("uuid")} AS evaluation_uuid
    FROM finding f
    JOIN project p ON p.id = f.project_id
    ${where}`;
}

function projectListWhere(options: ProjectListOptions): { where: string; args: string[] } {
  const clauses: string[] = [];
  const args: string[] = [];
  const origin = options.origin ?? "project";
  if (origin !== "all") {
    clauses.push("origin = ?");
    args.push(origin);
  }
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
  if (filter.status === "execution-confirmed") {
    clauses.push("status IN ('confirmed-executable','confirmed-differential')");
  } else if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.search) {
    const id = filter.search.trim().match(/^#?(\d+)$/)?.[1];
    if (id) {
      clauses.push("id = ?");
      params.push(Number(id));
    } else {
      clauses.push("(title LIKE ? OR location LIKE ?)");
      const like = `%${filter.search}%`;
      params.push(like, like);
    }
  }
  if (filter.tracking === "active") clauses.push("COALESCE(tracking_status, 'open') <> 'ignored'");
  else if (filter.tracking) { clauses.push("COALESCE(tracking_status, 'open') = ?"); params.push(filter.tracking); }
  if (filter.runIds) {
    if (filter.runIds.length === 0) clauses.push("1 = 0");
    else {
      clauses.push(`run_id IN (${filter.runIds.map(() => "?").join(",")})`);
      params.push(...filter.runIds);
    }
  }
  if (filter.reportable) clauses.push("status <> 'discharged' AND (LOWER(COALESCE(severity, '')) <> 'info' OR status IN ('confirmed-source','confirmed-executable','confirmed-differential','refuted'))");
  return { sql: "WHERE " + clauses.join(" AND "), params };
}
