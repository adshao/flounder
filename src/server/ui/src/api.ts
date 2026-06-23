export type RunStatus = "running" | "done" | "error" | "killed" | string;
export type ScopeStatus = "pending" | "audited" | "deferred" | "auditing" | string;
export type FindingStatus =
  | "confirmed-differential"
  | "confirmed-executable"
  | "confirmed-source"
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
  provider_id?: number | null;
  daemon_id?: number | null;
  dir?: string | null;
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
  latestRun?: RunRow | null;
  material?: MaterialSummary;
}

export interface ProjectRow {
  id: number;
  uuid: string;
  name: string;
  source_paths?: string | null;
  build_root?: string | null;
  corpus_paths?: string | null;
  config_json?: string | null;
  provider_id?: number | null;
  daemon_id?: number | null;
  dir?: string | null;
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
}

export interface ScopeRow {
  id?: number;
  scope_id: string;
  title?: string | null;
  location?: string | null;
  score?: number | null;
  priority?: number | null;
  status: ScopeStatus;
  dig_seconds?: number | null;
}

export interface FindingRow {
  id: number;
  project_name?: string;
  project_uuid?: string;
  project_id?: number;
  run_id?: number | null;
  finding_key?: string;
  title?: string | null;
  location?: string | null;
  severity?: string | null;
  status: FindingStatus;
  tracking_status?: string | null;
  confirm_status?: string | null;
  report_path?: string | null;
  report_markdown?: string | null;
  has_report?: boolean | null;
  scope_id?: string | null;
  description?: string | null;
  evidence?: string | null;
  exploit_sketch?: string | null;
  fix?: string | null;
  confidence?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ConfirmDecision {
  id?: number;
  project_id?: number;
  run_id?: number | null;
  bug: string;
  reproduced?: string | null;
  recommendation?: string | null;
  members_json?: string | null;
  distinct_fix?: string | null;
  repro_evidence?: string | null;
  corroboration?: string | null;
  novelty?: string | null;
  human_gates?: string | null;
  merged_from_json?: string | null;
  repro_command_id?: string | null;
  decision_path?: string | null;
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
  confirmDecisions: ConfirmDecision[];
  scopes?: ScopeRow[];
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

export interface ActivityRecord {
  kind: string;
  delta?: string;
  text?: string;
  tool?: string;
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

export interface ProjectConfig {
  scopeCoverageMode?: "focused" | "standard" | "half" | "full" | "custom";
  maxScopes?: number;
  mapSteps?: number;
  digSteps?: number;
  digSamples?: number;
  digConcurrency?: number;
  phases?: PhaseConfig;
  phaseProviders?: PhaseProviderConfig;
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
}

export interface LaunchPayload {
  verb: string;
  region?: string;
  scope?: string;
  inputRunDir?: string;
  quick?: boolean;
  mockLlm?: boolean;
  remap?: boolean;
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

export const api = {
  projects: () => fetchJson<{ projects: ProjectSnapshot[] }>("/api/projects"),
  project: (uuid: string) => fetchJson<ProjectDetail>(`/api/projects/${encodeURIComponent(uuid)}`),
  scopes: (uuid: string, params = new URLSearchParams()) =>
    fetchJson<{ scopes: ScopeRow[]; progress: Coverage; total: number; limit: number; offset: number }>(`/api/projects/${encodeURIComponent(uuid)}/scopes?${params.toString()}`),
  findings: (uuid: string, params: URLSearchParams) =>
    fetchJson<{ findings: FindingRow[]; total: number; limit: number; offset: number }>(`/api/projects/${encodeURIComponent(uuid)}/findings?${params.toString()}`),
  createProject: (body: ProjectPayload) => postJson<{ ok: true; id: number; uuid: string; name: string }>("/api/projects", body),
  updateProject: (uuid: string, body: ProjectPayload) => patchJson<{ ok: true }>(`/api/projects/${encodeURIComponent(uuid)}`, body),
  deleteProject: (uuid: string) => fetchJson<{ ok: true }>(`/api/projects/${encodeURIComponent(uuid)}`, { method: "DELETE" }),
  launchRun: (uuid: string, body: LaunchPayload) => postJson<unknown>(`/api/projects/${encodeURIComponent(uuid)}/runs`, body),
  updateRun: (id: number, body: { runScopesTarget?: number }) => patchJson<unknown>(`/api/runs/${id}`, body),
  stopRun: (id: number) => postJson<unknown>(`/api/runs/${id}/stop`, {}),
  deleteRun: (id: number) => fetchJson<unknown>(`/api/runs/${id}`, { method: "DELETE" }),
  runLog: (id: number, tail = 80) => fetchJson<{ events: ActivityRecord[] }>(`/api/runs/${id}/log?tail=${tail}&format=json`),
  patchScope: (uuid: string, scopeId: string, body: unknown) =>
    patchJson<unknown>(`/api/projects/${encodeURIComponent(uuid)}/scopes/${encodeURIComponent(scopeId)}`, body),
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
  bugs: (params: URLSearchParams) =>
    fetchJson<{ findings: FindingRow[]; total: number; limit: number; offset: number; stats: { total: number; byStatus: Record<string, number>; byTracking: Record<string, number> } }>(`/api/bugs?${params.toString()}`),
  findingReport: (id: number) => fetchJson<{ markdown: string; source: "db" | "generated" }>(`/api/findings/${id}/report`),
  trackFinding: (id: number, status: string) => patchJson<unknown>(`/api/findings/${id}/tracking`, { status }),
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
