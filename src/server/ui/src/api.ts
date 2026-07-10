export type RunStatus = "running" | "done" | "error" | "killed" | string;
export type ScopeStatus = "pending" | "audited" | "deferred" | "auditing" | string;
export type FindingStatus =
  | "confirmed-differential"
  | "confirmed-executable"
  | "confirmed-source"
  | "needs-evidence"
  | "suspected"
  | "discharged"
  | "refuted"
  | string;

export interface Coverage {
  total: number;
  audited: number;
  pending: number;
  deferred?: number | null;
}

export interface ProjectSnapshot {
  id?: number;
  uuid: string;
  name: string;
  origin?: "project" | "evaluation" | string;
  provider_id?: number | null;
  daemon_id?: number | null;
  dir?: string | null;
  archived_at?: string | null;
  pinned_at?: string | null;
  sort_order?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  config?: ProjectConfig;
  progress?: Coverage;
  findingCounts?: Record<string, number>;
  findingsTotal?: number;
  auditConfirmedFindings?: number;
  reproducedBugs?: number;
  confirmedBugs?: number;
  verifyPendingFindings?: number;
  confirmPendingFindings?: number;
  confirmDecisionCount?: number;
  activeRuns?: number;
  currentRunCount?: number;
  runCount?: number;
  latestRun?: RunRow | null;
  latestRunHealth?: RunHealth | null;
  backlogCounts?: Record<string, number>;
  material?: MaterialSummary;
}

export type ProjectStatusFilter = "all" | "running" | "needs-work" | "done" | "failed" | "not-started";
export type ProjectStatusCounts = Record<ProjectStatusFilter, number>;

export interface ProjectRow {
  id: number;
  uuid: string;
  name: string;
  origin?: "project" | "evaluation" | string;
  source_paths?: string | null;
  build_root?: string | null;
  corpus_paths?: string | null;
  config_json?: string | null;
  provider_id?: number | null;
  daemon_id?: number | null;
  dir?: string | null;
  archived_at?: string | null;
  pinned_at?: string | null;
  sort_order?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface RunRow {
  id: number;
  project_id?: number;
  kind: string;
  run_dir?: string | null;
  status: RunStatus;
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
  budgets_json?: string | null;
  stages_json?: string | null;
  scopes_total?: number | null;
  scopes_audited?: number | null;
  scopes_pending?: number | null;
  run_scopes_target?: number | null;
  run_scopes_done?: number | null;
  findings_total?: number | null;
  started_at?: string | null;
  dig_started_at?: string | null;
  ended_at?: string | null;
  last_activity_at?: string | null;
  inactive_seconds?: number | null;
  stale_activity?: boolean | null;
  material_stale?: boolean | null;
  stale_since_prepare_run_id?: number | null;
  stale_since_prepare_started_at?: string | null;
  job_id?: number | null;
  job_status?: string | null;
  job_error?: string | null;
  health_status?: string | null;
  health_reasons_json?: string | null;
  health_signals_json?: string | null;
  runHealth?: RunHealth | null;
}

export interface ScopeRow {
  id?: number;
  scope_id: string;
  title?: string | null;
  location?: string | null;
  score?: number | null;
  priority?: number | null;
  status: ScopeStatus;
  source?: string | null;
  parent_scope_id?: string | null;
  dig_seconds?: number | null;
}

export interface RunHealth {
  runId?: number | null;
  runKind?: string | null;
  runStatus?: string | null;
  status?: string | null;
  reasons?: string[];
  signals?: Record<string, unknown>;
  startedAt?: string | null;
  endedAt?: string | null;
}

export type DiscoveryBacklogKind = "coverage-gap" | "resource-request" | "followup-scope" | string;
export type DiscoveryBacklogStatus = "open" | "resolved" | "stale" | "ignored" | string;
export type DiscoveryBacklogActionability = "agent-runnable" | "agent-resource" | "agent-review" | string;
export type DiscoveryBacklogOwner = "agent" | string;

export interface DiscoveryBacklogRow {
  id: number;
  project_id?: number;
  run_id?: number | null;
  kind: DiscoveryBacklogKind;
  status: DiscoveryBacklogStatus;
  scope_id?: string | null;
  title?: string | null;
  location?: string | null;
  reason?: string | null;
  next_action?: string | null;
  priority?: string | null;
  payload_json?: string | null;
  payload?: unknown;
  actionability?: DiscoveryBacklogActionability | null;
  action_owner?: DiscoveryBacklogOwner | null;
  recommended_action?: string | null;
  primary_action_label?: string | null;
  autonomous?: boolean | null;
  action_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  run_kind?: string | null;
  run_started_at?: string | null;
}

export interface FindingRow {
  id: number;
  uuid?: string;
  project_name?: string;
  project_uuid?: string;
  source?: "project" | "evaluation" | string;
  evaluation_name?: string | null;
  evaluation_uuid?: string | null;
  project_id?: number;
  run_id?: number | null;
  finding_key?: string;
  canonical_key?: string;
  occurrence_count?: number;
  title?: string | null;
  location?: string | null;
  severity?: string | null;
  status: FindingStatus;
  tracking_status?: string | null;
  confirm_status?: string | null;
  duplicate_of_finding_id?: number | null;
  report_path?: string | null;
  report_markdown?: string | null;
  has_report?: boolean | null;
  scope_id?: string | null;
  description?: string | null;
  evidence?: string | null;
  exploit_sketch?: string | null;
  fix?: string | null;
  confidence?: number | null;
  refutation_status?: "pending" | "running" | "passed" | "refuted" | "blocked" | null;
  refutation_reason?: string | null;
  phase_attempts?: FindingPhaseAttempt[];
  created_at?: string | null;
  updated_at?: string | null;
  timeline?: FindingStatusEvent[];
}

export type FindingPhase = "verify" | "confirm" | "report";

export interface FindingPhaseAttempt {
  id: number;
  subject_type: "finding" | "decision";
  subject_id: number;
  phase: FindingPhase;
  input_fingerprint: string;
  attempt_number: number;
  run_id?: number | null;
  state: "running" | "settled" | "blocked" | "error";
  outcome?: string | null;
  blocker?: string | null;
  metrics_json?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  updated_at?: string | null;
}

export interface FindingOccurrence {
  id: number;
  finding_id: number;
  run_id?: number | null;
  finding_key: string;
  title?: string | null;
  location?: string | null;
  scope_id?: string | null;
  status: string;
  reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FindingLifecycle {
  finding: FindingRow;
  timeline: FindingStatusEvent[];
  occurrences: FindingOccurrence[];
  attempts: FindingPhaseAttempt[];
  decisions: Array<ConfirmDecision & { attempts?: FindingPhaseAttempt[] }>;
}

export interface FindingStatusEvent {
  id?: number;
  finding_id?: number;
  from_status?: string | null;
  to_status?: string | null;
  reason?: string | null;
  run_id?: number | null;
  ts?: string | null;
}

export interface ConfirmDecision {
  id?: number;
  project_id?: number;
  run_id?: number | null;
  bug: string;
  reproduced?: string | null;
  recommendation?: string | null;
  members_json?: string | null;
  severity?: string | null;
  evidence_level?: string | null;
  submission_confidence?: string | null;
  distinct_fix?: string | null;
  repro_evidence?: string | null;
  corroboration?: string | null;
  novelty?: string | null;
  human_gates?: string | null;
  engagement_profile_json?: string | null;
  adjudication_json?: string | null;
  engagement_profile?: Record<string, unknown> | unknown[] | null;
  adjudication?: Record<string, unknown> | unknown[] | null;
  merged_from_json?: string | null;
  repro_command_id?: string | null;
  decision_path?: string | null;
  has_report?: boolean | null;
  created_at?: string;
}

export interface ProjectDetail {
  project: ProjectRow;
  progress: Coverage;
  statusCounts: Record<string, number>;
  findingsTotal: number;
  auditConfirmedFindings: number;
  reproducedBugs: number;
  confirmedBugs: number;
  runs: RunRow[];
  runsTotal: number;
  currentRunsTotal?: number;
  activeScopeCount?: number;
  activeScopeIds?: string[];
  confirmDecisions: ConfirmDecision[];
  scopes?: ScopeRow[];
  latestRunHealth?: RunHealth | null;
  backlogCounts?: Record<string, number>;
  discoveryBacklog?: DiscoveryBacklogRow[];
  openResourceRequests?: DiscoveryBacklogRow[];
  allFindings?: FindingRow[];
  prepareSummary?: PrepareSummary | null;
  material?: MaterialSummary;
}

export interface MaterialSummary {
  currentPrepareRunId?: number | null;
  currentPrepareStatus?: string | null;
  currentPrepareStartedAt?: string | null;
  currentScopeInventoryRunId?: number | null;
  currentScopeInventoryStatus?: string | null;
  currentScopeInventoryStartedAt?: string | null;
  staleRunCount?: number;
  activePrepareRefreshStartedAt?: string;
}

export interface PrepareComponentSummary {
  role?: string;
  identity?: string;
  platform?: string;
  revision?: string;
  source?: string;
  stagedPath?: string;
  inScope?: boolean;
  match?: string;
  matchEvidence?: string;
  deployed?: boolean;
}

export interface PrepareWorkspaceSummary {
  exists?: boolean;
  files?: number;
  fileLimit?: number;
  filesTruncated?: boolean;
  gitDirs?: number;
  sampleFiles?: string[];
}

export interface PrepareGroundTruthSummary {
  kind?: string;
  network?: string;
  chainId?: number;
  address?: string;
  role?: string;
  block?: string;
  sourceMatch?: string;
  evidence?: string;
  stagedComponent?: string;
}

export interface PrepareRealTargetSummary {
  reported?: boolean;
  requiresConfirmation?: boolean;
  mode?: string;
  reason?: string;
  groundTruth?: PrepareGroundTruthSummary[];
  guidance?: {
    required?: boolean;
    allowedNetworkActions?: string;
    recommendedMethod?: string;
    notRequiredReason?: string;
  };
  issues?: string[];
}

export interface PrepareSummary {
  runId?: number;
  status?: string;
  quality?: "ready" | "limited" | "preparing" | "needs-review" | "missing" | "invalid" | string;
  auditReady?: boolean;
  blocked?: boolean;
  blockingIssues?: string[];
  caveats?: string[];
  manifestStatus?: "present" | "missing" | "invalid" | string;
  manifestState?: string;
  manifestArtifact?: string;
  clue?: string;
  posture?: string;
  scopeDeclaration?: string;
  answerFirewall?: string;
  componentsTotal?: number;
  components?: PrepareComponentSummary[];
  inScope?: number;
  matched?: number;
  unverified?: number;
  sourcePinned?: number;
  gaps?: string[];
  offscope?: string[];
  realTarget?: PrepareRealTargetSummary;
  issues?: string[];
  workspace?: PrepareWorkspaceSummary;
}

export interface ProviderProfile {
  id: number;
  name: string;
  provider: string;
  model?: string | null;
  thinking?: string | null;
  roles?: unknown;
}

export interface PiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevels?: string[];
}

export interface DaemonRow {
  id: number;
  name?: string | null;
  capabilities?: unknown;
  workspace?: string | null;
  online?: boolean;
  last_seen_at?: string | null;
}

export type RunGroupState = "draft" | "queued" | "running" | "paused" | "finished" | "failed" | "cancelled" | string;
export type WorkItemState = "queued" | "claimed" | "running" | "finished" | "failed" | "cancelled" | string;
export type WorkItemOutcome = "reproduced" | "confirmed" | "not_reproduced" | "refuted" | "blocked" | "invalid" | "no_findings" | "findings_reported" | string;
export type ExpectedOutcome = "detect-positive" | "reject-positive";

export interface CapabilitySurfacePayload {
  entrypoints: string[];
  inputs: string[];
  effects: string[];
  authorities: string[];
  boundaries: string[];
  localFixtures: string[];
}

export interface TargetBundlePayload {
  target: string;
  targetClass: "memory-safety" | "logic" | "crypto-zk" | "capability-surface" | "general";
  sourcePaths: string[];
  corpusPaths: string[];
  buildRoot?: string;
  scopeNote?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  daemonId?: number;
  maxScopes?: number;
  mapSamples?: number;
  digSamples?: number;
  digMaxSamples?: number;
  adaptiveDig?: boolean;
  eagerPrepare?: boolean;
  digConcurrency?: number;
  verifyConcurrency?: number;
  capabilitySurface?: CapabilitySurfacePayload;
  claim?: unknown;
}

export interface MaterialEntryPayload {
  path: string;
  provenance: string;
  operatorLabel: string;
  policyDecision: "included" | "excluded" | "warning";
  reason: string;
}

export interface MaterialPolicyPayload {
  posture: "blind" | "informed" | "private" | "open-world";
  materials: MaterialEntryPayload[];
}

export interface EvidenceContractPayload {
  kind: "confirmation-command" | "benchmark-oracle" | "replay-package" | "manual-review";
  command?: string;
  successPatterns?: string[];
  failurePatterns?: string[];
  requiresDifferential: boolean;
  requiresRefutation: boolean;
  networkPolicy: "sealed" | "local-only" | "open-world-read";
  expectedOutcome?: ExpectedOutcome;
  caseId?: string;
  caseFamily?: string;
  targetStack?: string;
  holdout?: boolean;
}

export interface WorkItemPayload {
  itemKey: string;
  kind: "audit-target" | "verify-claim" | "benchmark-case" | "regression-replay" | "custom";
  targetBundle: TargetBundlePayload;
  materialPolicy: MaterialPolicyPayload;
  evidenceContract: EvidenceContractPayload;
  projectId?: number;
}

export interface WorkItemAttemptRow {
  id: number;
  work_item_id: number;
  attempt_number: number;
  job_id: number;
  run_id?: number | null;
  state: WorkItemState;
  outcome?: WorkItemOutcome | null;
  result_json?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface WorkItemRow {
  id: number;
  uuid: string;
  run_group_id: number;
  item_key: string;
  kind: WorkItemPayload["kind"];
  state: WorkItemState;
  outcome?: WorkItemOutcome | null;
  project_id?: number | null;
  run_id?: number | null;
  job_id?: number | null;
  attempts: number;
  last_error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  targetBundle: TargetBundlePayload;
  materialPolicy: MaterialPolicyPayload;
  evidenceContract: EvidenceContractPayload;
  result?: Record<string, unknown> | null;
  attemptHistory: WorkItemAttemptRow[];
}

export interface RunGroupRow {
  id: number;
  uuid: string;
  name: string;
  kind: string;
  state: RunGroupState;
  parallelism: number;
  config?: Record<string, unknown> | null;
  budget?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
  items: WorkItemRow[];
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  scheduled?: number;
}

export interface RunGroupListResponse {
  runGroups: RunGroupRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface RunGroupReportResponse {
  group: Record<string, unknown>;
  summary: Record<string, unknown>;
  markdown: string;
}

export interface RunGroupCreatePayload {
  version?: 1;
  name: string;
  kind?: string;
  parallelism?: number;
  config?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  items?: WorkItemPayload[];
}

export type HarnessExperimentState = "needs-evidence" | "proposal-ready" | "evaluating" | "decided";
export type HarnessDecision = "promote" | "reject" | "needs-more-samples";

export interface HarnessPromotionPolicy {
  minimumSamplesPerClass: number;
  minimumDistinctCases: number;
  minimumDistinctFamilies: number;
  minimumHoldoutCases: number;
  minimumImprovedCases: number;
  requireAllControlsPass: boolean;
  maxBlockedRate: number;
  maxDurationRatio: number;
  maxAttemptRatio: number;
}

export interface HarnessFailurePattern {
  id: string;
  kind: "positive-miss" | "control-false-positive" | "execution-blocked" | "policy-invalid";
  mechanism: string;
  verifierCause: string;
  causalStatus: string;
  occurrences: number;
  workItemKeys: string[];
}

export interface HarnessCandidateProposal {
  title: string;
  hypothesis: string;
  failurePatternIds: string[];
  editableFiles: string[];
  changes: Array<{ path: string; summary: string }>;
  preserve: string[];
}

export interface HarnessScoreMetrics {
  total: number;
  scored: number;
  passed: number;
  positives: number;
  positivesPassed: number;
  controls: number;
  controlsPassed: number;
  blocked: number;
  invalid: number;
  attempts: number;
  durationSeconds: number | null;
  passRate: number | null;
  positiveRecall: number | null;
  controlPassRate: number | null;
  blockedRate: number;
  distinctPositiveCases: number;
  distinctControlCases: number;
  distinctFamilies: number;
  distinctStacks: number;
  holdouts: number;
  holdoutsPassed: number;
}

export interface HarnessScorecard {
  decision: HarnessDecision;
  reasons: string[];
  baseline: HarnessScoreMetrics;
  candidate: HarnessScoreMetrics;
  improvedItemKeys: string[];
  regressedItemKeys: string[];
  durationRatio: number | null;
  attemptRatio: number | null;
  evaluatedAt: string;
}

export interface HarnessExperimentRow {
  id: number;
  uuid: string;
  name: string;
  state: HarnessExperimentState;
  decision?: HarnessDecision | null;
  baseline_run_group_id: number;
  candidate_run_group_id?: number | null;
  baseline_name: string;
  baseline_uuid: string;
  baseline_state: RunGroupState;
  candidate_name?: string | null;
  candidate_uuid?: string | null;
  candidate_state?: RunGroupState | null;
  editableFiles: string[];
  promotionPolicy: HarnessPromotionPolicy;
  failurePatterns: HarnessFailurePattern[];
  preservedBehaviors: Array<{ workItemKey: string; expectedOutcome: ExpectedOutcome; evidenceGate: string }>;
  proposal?: HarnessCandidateProposal | null;
  scorecard?: HarnessScorecard | null;
  baselineGroup?: RunGroupRow | null;
  candidateGroup?: RunGroupRow | null;
  created_at?: string | null;
  updated_at?: string | null;
  evaluated_at?: string | null;
}

export interface HarnessExperimentCreatePayload {
  name: string;
  baselineRunGroupUuid: string;
  candidateRunGroupUuid?: string;
  editableFiles: string[];
  promotionPolicy?: Partial<HarnessPromotionPolicy>;
}

export interface HarnessExperimentListResponse {
  experiments: HarnessExperimentRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ActivityRecord {
  kind: string;
  delta?: string;
  text?: string;
  tool?: string;
  streamId?: string;
  scope?: string;
  activeStreams?: string[];
  detail?: string;
  result?: string;
  ok?: boolean;
  step?: number;
  [key: string]: unknown;
}

export interface PhaseRole {
  model?: string;
  thinking?: string;
}

export type PhaseConfig = Partial<Record<"prepare" | "map" | "dig" | "confirm", PhaseRole>>;
export type PhaseProviderConfig = Partial<Record<"prepare" | "map" | "dig" | "confirm", number>>;
export type EngagementKind = "bug-bounty" | "bug-bounty-contest" | "standard" | string;

export interface ContestStrategy {
  batchScopes?: number;
  digConcurrency?: number;
  appendMapWhenExhausted?: boolean;
  skipRealTargetConfirm?: boolean;
  stopAfterHours?: number;
}

export interface EngagementConfig {
  kind?: EngagementKind;
  venue?: string;
  contestUrl?: string;
  startsAt?: string;
  endsAt?: string;
  strategy?: ContestStrategy;
}

export interface ProjectConfig {
  projectIntent?: string;
  prepareClue?: string;
  scopeCoverageMode?: "focused" | "standard" | "half" | "full" | "custom";
  maxScopes?: number;
  mapSteps?: number;
  mapSamples?: number;
  digSteps?: number;
  digSamples?: number;
  digMaxSamples?: number;
  adaptiveDig?: boolean;
  eagerPrepare?: boolean;
  digConcurrency?: number;
  verifyConcurrency?: number;
  phases?: PhaseConfig;
  phaseProviders?: PhaseProviderConfig;
  engagement?: EngagementConfig;
}

export interface RunUpdatePayload {
  runScopesTarget?: number;
  scopeCoverageMode?: "focused" | "standard" | "half" | "full" | "custom";
  coverageTarget?: number;
  maxScopes?: number;
}

export interface ProjectPayload {
  name?: string;
  providerId?: number;
  dir?: string;
  sourcePaths?: string[];
  buildRoot?: string;
  corpusPaths?: string[];
  config?: ProjectConfig;
  daemonId?: number;
  archived?: boolean;
  pinned?: boolean;
  sortOrder?: number | null;
}

export interface ProjectListParams {
  archived?: boolean;
  limit?: number;
  offset?: number;
  q?: string;
  status?: Exclude<ProjectStatusFilter, "all">;
}

export interface ProjectListResponse {
  projects: ProjectSnapshot[];
  total: number;
  limit: number;
  offset: number;
  statusCounts?: Partial<ProjectStatusCounts>;
}

export interface ApiCatalogResponse {
  name: string;
  description: string;
  maintainerMode: boolean;
  resources: string[];
  endpoints: Array<Record<string, unknown>>;
}

export interface LaunchPayload {
  verb: string;
  region?: string;
  scope?: string;
  inputRunDir?: string;
  quick?: boolean;
  mockLlm?: boolean;
  pipeline?: boolean;
  continueCoverage?: boolean;
  remap?: boolean;
  appendMap?: boolean;
  appendMapSeedPaths?: string[];
  verifyFromStart?: boolean;
  findingId?: number;
  findingIds?: number[];
  verifyFindings?: unknown;
  allowMaterialDrift?: boolean;
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function projectListPath(params: ProjectListParams = {}): string {
  const query = new URLSearchParams();
  if (params.archived) query.set("archived", "1");
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  if (params.q?.trim()) query.set("q", params.q.trim());
  if (params.status) query.set("status", params.status);
  const qs = query.toString();
  return `/api/projects${qs ? `?${qs}` : ""}`;
}

export const api = {
  catalog: () => fetchJson<ApiCatalogResponse>("/api"),
  projects: (params?: ProjectListParams) => fetchJson<ProjectListResponse>(projectListPath(params)),
  archivedProjects: (params?: Omit<ProjectListParams, "archived">) => fetchJson<ProjectListResponse>(projectListPath({ ...params, archived: true })),
  project: (uuid: string) => fetchJson<ProjectDetail>(`/api/projects/${encodeURIComponent(uuid)}`),
  scopes: (uuid: string, params = new URLSearchParams()) =>
    fetchJson<{ scopes: ScopeRow[]; progress: Coverage; total: number; limit: number; offset: number }>(`/api/projects/${encodeURIComponent(uuid)}/scopes?${params.toString()}`),
  backlog: (uuid: string, params = new URLSearchParams()) =>
    fetchJson<{ backlog: DiscoveryBacklogRow[]; counts: Record<string, number>; total: number; limit: number; offset: number }>(`/api/projects/${encodeURIComponent(uuid)}/backlog?${params.toString()}`),
  findings: (uuid: string, params: URLSearchParams) =>
    fetchJson<{ findings: FindingRow[]; total: number; limit: number; offset: number }>(`/api/projects/${encodeURIComponent(uuid)}/findings?${params.toString()}`),
  createProject: (body: ProjectPayload) => postJson<{ ok: true; id: number; uuid: string; name: string }>("/api/projects", body),
  updateProject: (uuid: string, body: ProjectPayload) => patchJson<{ ok: true }>(`/api/projects/${encodeURIComponent(uuid)}`, body),
  reorderProjects: (uuids: string[]) => patchJson<{ ok: true; changed: number }>("/api/projects/order", { uuids }),
  deleteProject: (uuid: string) => fetchJson<{ ok: true }>(`/api/projects/${encodeURIComponent(uuid)}`, { method: "DELETE" }),
  launchRun: (uuid: string, body: LaunchPayload) => postJson<unknown>(`/api/projects/${encodeURIComponent(uuid)}/runs`, body),
  updateRun: (id: number, body: RunUpdatePayload) => patchJson<{ ok: true; runScopesTarget: number; applied: boolean; coverageMode?: string; coverageTarget?: number }>(`/api/runs/${id}`, body),
  stopRun: (id: number) => postJson<unknown>(`/api/runs/${id}/stop`, {}),
  deleteRun: (id: number) => fetchJson<unknown>(`/api/runs/${id}`, { method: "DELETE" }),
  runLog: (id: number, tail = 80) => fetchJson<{ events: ActivityRecord[] }>(`/api/runs/${id}/log?tail=${tail}&format=json`),
  patchScope: (uuid: string, scopeId: string, body: unknown) =>
    patchJson<unknown>(`/api/projects/${encodeURIComponent(uuid)}/scopes/${encodeURIComponent(scopeId)}`, body),
  patchBacklog: (id: number, body: { status: string }) => patchJson<unknown>(`/api/backlog/${id}`, body),
  providers: () => fetchJson<{ providers: ProviderProfile[] }>("/api/providers"),
  piProviders: () => fetchJson<{ providers: string[] }>("/api/pi/providers"),
  piModels: (provider: string) => fetchJson<{ models: PiModel[] }>(`/api/pi/models/${encodeURIComponent(provider)}`),
  saveProvider: (id: number | null, body: unknown) =>
    fetchJson<{ ok: true; id?: number }>(id ? `/api/providers/${id}` : "/api/providers", {
      method: id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteProvider: (id: number) => fetchJson<unknown>(`/api/providers/${id}`, { method: "DELETE" }),
  daemons: () => fetchJson<{ daemons: DaemonRow[] }>("/api/daemons"),
  createDaemon: (name: string) => postJson<{ id: number; name: string; token: string }>("/api/daemons", { name }),
  renameDaemon: (id: number, name: string) => patchJson<unknown>(`/api/daemons/${id}`, { name }),
  deleteDaemon: (id: number) => fetchJson<unknown>(`/api/daemons/${id}`, { method: "DELETE" }),
  runGroups: (params = new URLSearchParams({ limit: "500" })) => fetchJson<RunGroupListResponse>(`/api/run-groups?${params.toString()}`),
  runGroup: (uuid: string) => fetchJson<RunGroupRow>(`/api/run-groups/${encodeURIComponent(uuid)}`),
  createRunGroup: (body: RunGroupCreatePayload) => postJson<RunGroupRow>("/api/run-groups", body),
  addRunGroupItems: (uuid: string, items: WorkItemPayload[]) => postJson<RunGroupRow>(`/api/run-groups/${encodeURIComponent(uuid)}/items`, { items }),
  startRunGroup: (uuid: string, parallelism?: number) => postJson<RunGroupRow>(`/api/run-groups/${encodeURIComponent(uuid)}/start`, parallelism === undefined ? {} : { parallelism }),
  pauseRunGroup: (uuid: string) => postJson<RunGroupRow>(`/api/run-groups/${encodeURIComponent(uuid)}/pause`, {}),
  cancelRunGroup: (uuid: string) => postJson<RunGroupRow>(`/api/run-groups/${encodeURIComponent(uuid)}/cancel`, {}),
  runGroupReport: (uuid: string) => fetchJson<RunGroupReportResponse>(`/api/run-groups/${encodeURIComponent(uuid)}/report`),
  retryWorkItem: (id: number) => postJson<RunGroupRow>(`/api/work-items/${id}/retry`, {}),
  harnessExperiments: (params = new URLSearchParams({ limit: "500" })) => fetchJson<HarnessExperimentListResponse>(`/api/harness-experiments?${params.toString()}`),
  harnessExperiment: (uuid: string) => fetchJson<HarnessExperimentRow>(`/api/harness-experiments/${encodeURIComponent(uuid)}`),
  createHarnessExperiment: (body: HarnessExperimentCreatePayload) => postJson<HarnessExperimentRow>("/api/harness-experiments", body),
  updateHarnessProposal: (uuid: string, proposal: HarnessCandidateProposal) => patchJson<HarnessExperimentRow>(`/api/harness-experiments/${encodeURIComponent(uuid)}/proposal`, { proposal }),
  attachHarnessCandidate: (uuid: string, candidateRunGroupUuid: string) => postJson<HarnessExperimentRow>(`/api/harness-experiments/${encodeURIComponent(uuid)}/candidate`, { candidateRunGroupUuid }),
  evaluateHarnessExperiment: (uuid: string) => postJson<HarnessExperimentRow>(`/api/harness-experiments/${encodeURIComponent(uuid)}/evaluate`, {}),
  harnessExperimentBrief: (uuid: string) => fetchJson<{ markdown: string }>(`/api/harness-experiments/${encodeURIComponent(uuid)}/brief`),
  bugs: (params: URLSearchParams) =>
    fetchJson<{ findings: FindingRow[]; total: number; limit: number; offset: number; stats: { total: number; active: number; byStatus: Record<string, number>; byTracking: Record<string, number> } }>(`/api/bugs?${params.toString()}`),
  findingReport: (id: number) => fetchJson<{ markdown: string; source: "db" | "generated" }>(`/api/findings/${id}/report`),
  findingLifecycle: (id: number) => fetchJson<FindingLifecycle>(`/api/findings/${id}/lifecycle`),
  retryFindingPhase: (id: number, phase: FindingPhase) => postJson<{ ok: true; phase: FindingPhase }>(`/api/findings/${id}/retry`, { phase }),
  decisionReport: (id: number) => fetchJson<{ markdown: string; source: "db" | "generated" }>(`/api/confirm-decisions/${id}/report`),
  trackFinding: (id: number, status: string, opts?: { duplicateOfFindingId?: number | null }) =>
    patchJson<unknown>(`/api/findings/${id}/tracking`, { status, duplicateOfFindingId: opts?.duplicateOfFindingId ?? null }),
  artifact: (runId: number, name: string) => fetch(`/api/runs/${runId}/artifact?name=${encodeURIComponent(name)}`),
};

function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
