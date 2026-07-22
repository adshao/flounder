import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  type ActivityRecord,
  type ConfirmDecision,
  type Coverage,
  type DaemonRow,
  type DiscoveryBacklogRow,
  type FindingRow,
  type FindingLifecycle,
  type FindingPhase,
  type FindingPhaseAttempt,
  type ProjectDetail,
  type ProjectConfig,
  type ProjectPayload,
  type ProjectSnapshot,
  type ProjectStatusCounts,
  type ProjectStatusFilter,
  type PrepareSummary,
  type PiModel,
  type ProviderProfile,
  type RunUpdatePayload,
  type RunRow,
  type RunHealth,
  type ScopeRow,
  type DiskStorageStatus,
  type ProjectStorageCleanupResult,
  type ProjectStorageUsage,
  type StorageOverview,
} from "./api";
import { Button, Card, Counter, IconButton, Modal, StateBadge, StatusBadge, useDialogFocus } from "./components";
import { EvaluationsWorkspace } from "./EvaluationsView";
import {
  activeFindings,
  bugBountyEngagementLabel,
  confirmedDecisions,
  contestReviewState,
  contestStrategy,
  confirmDecisionMemberKeys,
  decisionHasUnresolvedEvidenceConflict,
  currentMaterialDetail,
  currentMaterialConfirmDecisions,
  currentMaterialFindings,
  currentMaterialProgress,
  currentMaterialRuns,
  materialRefreshInProgress,
  fmtDur,
  fmtTime,
  hasUnresolvedEvidenceConflict,
  isVerifyRun,
  isBugBountyConfig,
  isSubmissionReadyDecision,
  isExecutionConfirmedFinding,
  verifyRunProgress,
  verifyRunRechecksConfirmed,
  needsSubmissionReadinessWork,
  needsRealTargetConfirmation,
  normalizeActivityBody,
  splitActivitySummaries,
  localVerifiedFindings,
  pendingConfirmFindings,
  pendingDecisionReports,
  pendingFormalReports,
  pendingVerifyFindings,
  pct,
  phaseState,
  PHASES,
  projectConfig,
  parseJson,
  PHASE_DESC,
  PROVIDER_PHASES,
  rawPendingVerifyCount,
  reportableDecisions,
  reportableFindings,
  runProgress,
  runScopeBatchComplete,
  sortConfirmDecisionsForSubmission,
  STATUSES,
  THINKING_LEVELS,
  TRACKING,
  topCandidateFindings,
  projectSourceState,
  type ProjectPhase,
  type ProviderPhase,
} from "./domain";
import { Icon, type IconName } from "./icons";

const DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.6-sol";

type View = "projects" | "evaluations" | "findings" | "settings";
type SettingsPane = "providers" | "daemons" | "storage" | "archived";
type ProjectTab = "overview" | "next-actions" | "decisions" | "findings" | "scopes" | "runs" | "activity" | "setup";
type ModalName = "new-project" | "run" | "edit-project" | "report" | "decision-report" | "run-log" | "artifact" | null;
type ArtifactPreview = { title: string; runId: number; name: string };
type LaunchAction = "run" | "run-next-coverage" | "prepare" | "map" | "map-expand" | "audit" | "confirm" | "verify" | "report";

const PROJECT_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "next-actions", label: "Next Actions" },
  { id: "decisions", label: "Decisions" },
  { id: "findings", label: "Findings" },
  { id: "scopes", label: "Scopes" },
  { id: "runs", label: "Runs" },
  { id: "setup", label: "Setup" },
];

interface RouteState {
  view: View;
  projectUuid?: string;
  evaluationUuid?: string;
  settingsPane: SettingsPane;
}

interface Toast {
  tone: "info" | "success" | "warning" | "error";
  message: string;
}

interface BugStats {
  total: number;
  active: number;
  byStatus: Record<string, number>;
  byTracking: Record<string, number>;
}

interface LaunchResult {
  jobId?: number;
  verb?: string;
  queued?: boolean;
  daemons?: number;
  queueReason?: string;
  blockingJobId?: number;
  message?: string;
}

const ONLINE_MS = 90_000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const READ_WATERMARK_LIMIT = 300;
const SETUP_READ_WATERMARKS_KEY = "flounder-setup-read-watermarks";
const ACTIVITY_READ_WATERMARKS_KEY = "flounder-activity-read-watermarks";
const COVERAGE_MODES = [
  { value: "standard", label: "Standard - until 30 audited scopes" },
  { value: "full", label: "Full - finish every pending scope" },
  { value: "half", label: "Half - finish half of pending scopes" },
  { value: "focused", label: "Focused - until 10 audited scopes" },
  { value: "custom", label: "Custom per-run cap" },
] as const;
type CoverageMode = (typeof COVERAGE_MODES)[number]["value"];

function initialTheme(): "light" | "dark" {
  const explicit = localStorage.getItem("flounder-theme-explicit") === "1";
  return explicit && localStorage.getItem("flounder-theme") === "dark" ? "dark" : "light";
}

function readStoredStringMap(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

function pruneStringMap(values: Record<string, string>): Record<string, string> {
  const entries = Object.entries(values).filter(([, value]) => value);
  return Object.fromEntries(entries.slice(-READ_WATERMARK_LIMIT));
}

function writeStoredStringMap(key: string, values: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(pruneStringMap(values)));
  } catch {
    // Ignore storage failures; unread dots still work for the current session.
  }
}

function readRoute(): RouteState {
  const pathname = window.location.pathname;
  const projectMatch = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (projectMatch) return { view: "projects", projectUuid: decodeURIComponent(projectMatch[1] ?? ""), settingsPane: "providers" };
  const evaluationMatch = pathname.match(/^\/evaluations\/([^/]+)\/?$/);
  if (evaluationMatch) return { view: "evaluations", evaluationUuid: decodeURIComponent(evaluationMatch[1] ?? ""), settingsPane: "providers" };
  if (pathname === "/evaluations" || pathname.startsWith("/evaluations/")) return { view: "evaluations", settingsPane: "providers" };
  if (pathname === "/findings" || pathname.startsWith("/findings/")) return { view: "findings", settingsPane: "providers" };
  if (pathname === "/settings/archived" || pathname.startsWith("/settings/archived/")) return { view: "settings", settingsPane: "archived" };
  if (pathname === "/settings/storage" || pathname.startsWith("/settings/storage/")) return { view: "settings", settingsPane: "storage" };
  if (pathname === "/settings/daemons" || pathname.startsWith("/settings/daemons/")) return { view: "settings", settingsPane: "daemons" };
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return { view: "settings", settingsPane: "providers" };

  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("p/")) {
    const uuid = decodeURIComponent(hash.slice(2));
    window.history.replaceState(null, "", projectPath(uuid));
    return { view: "projects", projectUuid: uuid, settingsPane: "providers" };
  }
  if (hash.startsWith("settings/daemons")) {
    window.history.replaceState(null, "", "/settings/daemons");
    return { view: "settings", settingsPane: "daemons" };
  }
  if (hash.startsWith("settings/archived")) {
    window.history.replaceState(null, "", "/settings/archived");
    return { view: "settings", settingsPane: "archived" };
  }
  if (hash.startsWith("settings/storage")) {
    window.history.replaceState(null, "", "/settings/storage");
    return { view: "settings", settingsPane: "storage" };
  }
  if (hash.startsWith("settings")) {
    window.history.replaceState(null, "", "/settings");
    return { view: "settings", settingsPane: "providers" };
  }
  if (hash.startsWith("findings")) {
    window.history.replaceState(null, "", "/findings");
    return { view: "findings", settingsPane: "providers" };
  }
  if (window.location.hash) window.history.replaceState(null, "", pathname || "/");
  return { view: "projects", settingsPane: "providers" };
}

function isProjectRoutePath(pathname: string): boolean {
  return pathname === "/" || /^\/projects\/[^/]+\/?$/.test(pathname);
}

function withProjectListFilters(pathname: string): string {
  const [pathPart, hashPart = ""] = pathname.split("#", 2);
  const [basePath, searchPart = ""] = pathPart.split("?", 2);
  if (!isProjectRoutePath(basePath) || searchPart) return pathname;
  const current = new URLSearchParams(window.location.search);
  const next = new URLSearchParams();
  const query = current.get("q")?.trim();
  const status = normalizeProjectStatusFilterValue(current.get("status"));
  if (query) next.set("q", query);
  if (status !== "all") next.set("status", status);
  const search = next.toString();
  return `${basePath}${search ? `?${search}` : ""}${hashPart ? `#${hashPart}` : ""}`;
}

function go(pathname: string) {
  const next = withProjectListFilters(pathname || "/");
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current === next) {
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  window.history.pushState(null, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function scrollToProjectSection(id: string): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function projectPath(uuid: string): string {
  return `/projects/${encodeURIComponent(uuid)}`;
}

function projectPathFor(project: Pick<ProjectSnapshot, "uuid">): string {
  return projectPath(project.uuid);
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function shortName(name: string, max = 34): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function statusCount(project: ProjectSnapshot, status: string): number {
  return project.findingCounts?.[status] ?? 0;
}

function totalConfirmed(project: ProjectSnapshot): number {
  return project.auditConfirmedFindings ?? (statusCount(project, "confirmed-differential") + statusCount(project, "confirmed-executable"));
}

function detailSnapshotDiffers(project: ProjectSnapshot, detail: ProjectDetail | null): boolean {
  if (!detail || project.uuid !== detail.project.uuid) return true;
  const detailRuns = currentMaterialRuns(detail.runs, detail.material);
  const detailLatest = detailRuns[0] ?? null;
  const progress = project.progress ?? { total: 0, audited: 0, pending: 0, deferred: 0 };
  return (
    (progress.total ?? 0) !== (detail.progress.total ?? 0)
    || (progress.audited ?? 0) !== (detail.progress.audited ?? 0)
    || (progress.pending ?? 0) !== (detail.progress.pending ?? 0)
    || (progress.deferred ?? 0) !== (detail.progress.deferred ?? 0)
    || (project.findingsTotal ?? 0) !== detail.findingsTotal
    || (project.auditConfirmedFindings ?? 0) !== detail.auditConfirmedFindings
    || (project.reproducedBugs ?? project.confirmedBugs ?? 0) !== detail.reproducedBugs
    || (project.confirmDecisionCount ?? 0) !== detail.confirmDecisions.length
    || (project.currentRunCount ?? 0) !== (detail.currentRunsTotal ?? detailRuns.length)
    || (project.latestRun?.id ?? null) !== (detailLatest?.id ?? null)
    || (project.latestRun?.status ?? null) !== (detailLatest?.status ?? null)
    || (project.latestRunHealth?.status ?? null) !== (detail.latestRunHealth?.status ?? null)
    || (project.backlogCounts?.open ?? 0) !== (detail.backlogCounts?.open ?? 0)
    || (project.material?.currentPrepareRunId ?? null) !== (detail.material?.currentPrepareRunId ?? null)
    || (project.material?.currentPrepareStatus ?? null) !== (detail.material?.currentPrepareStatus ?? null)
    || (project.material?.activePrepareRefreshStartedAt ?? null) !== (detail.material?.activePrepareRefreshStartedAt ?? null)
  );
}

function snapshotFromDetail(project: ProjectSnapshot, detail: ProjectDetail): ProjectSnapshot {
  const current = currentMaterialDetail(detail);
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const requiresConfirmation = needsRealTargetConfirmation(current);
  const currentRunningRuns = currentRuns.filter((run) => run.status === "running").length;
  const materialRefreshActive = materialRefreshInProgress(detail.material);
  return {
    ...project,
    progress: current.progress,
    findingCounts: current.statusCounts,
    findingsTotal: current.findingsTotal,
    auditConfirmedFindings: current.auditConfirmedFindings,
    reproducedBugs: current.reproducedBugs,
    confirmedBugs: current.confirmedBugs,
    verifyPendingFindings: pendingVerifyFindings(current.allFindings).length,
    confirmPendingFindings: pendingConfirmFindings(current.allFindings, requiresConfirmation, current.confirmDecisions).length,
    confirmDecisionCount: current.confirmDecisions.length,
    latestRun: currentRuns[0] ?? null,
    latestRunHealth: current.latestRunHealth,
    backlogCounts: current.backlogCounts,
    currentRunCount: current.currentRunsTotal ?? currentRuns.length,
    activeRuns: Math.max(project.activeRuns ?? 0, currentRunningRuns, materialRefreshActive ? 1 : 0),
    material: current.material,
  };
}

function snapshotFromProjectDetail(detail: ProjectDetail): ProjectSnapshot {
  const current = currentMaterialDetail(detail);
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const base: ProjectSnapshot = {
    id: current.project.id,
    uuid: current.project.uuid,
    name: current.project.name,
    provider_id: current.project.provider_id,
    daemon_id: current.project.daemon_id,
    dir: current.project.dir,
    archived_at: current.project.archived_at,
    pinned_at: current.project.pinned_at,
    sort_order: current.project.sort_order,
    created_at: current.project.created_at,
    updated_at: current.project.updated_at,
    progress: current.progress,
    findingCounts: current.statusCounts,
    findingsTotal: current.findingsTotal,
    auditConfirmedFindings: current.auditConfirmedFindings,
    reproducedBugs: current.reproducedBugs,
    confirmedBugs: current.confirmedBugs,
    confirmDecisionCount: current.confirmDecisions.length,
    latestRun: currentRuns[0] ?? null,
    latestRunHealth: current.latestRunHealth,
    backlogCounts: current.backlogCounts,
    activeRuns: currentRuns.filter((run) => run.status === "running").length,
    currentRunCount: current.currentRunsTotal ?? currentRuns.length,
    material: current.material,
  };
  return snapshotFromDetail(base, detail);
}

function appendProjectPage(current: ProjectSnapshot[], incoming: ProjectSnapshot[]): ProjectSnapshot[] {
  const seen = new Set(current.map((project) => project.uuid));
  return [...current, ...incoming.filter((project) => !seen.has(project.uuid))];
}

function projectStatusParam(filter: ProjectStatusFilter): Exclude<ProjectStatusFilter, "all"> | undefined {
  return filter === "all" ? undefined : filter;
}

function normalizeProjectStatusCounts(value: Partial<ProjectStatusCounts> | undefined, total: number): ProjectStatusCounts {
  return {
    all: value?.all ?? total,
    running: value?.running ?? 0,
    "needs-work": value?.["needs-work"] ?? 0,
    done: value?.done ?? 0,
    failed: value?.failed ?? 0,
    "not-started": value?.["not-started"] ?? 0,
  };
}

function projectFilterStatus(project: ProjectSnapshot): ProjectStatusFilter {
  const status = projectBadgeStatus(project);
  if (status === "running") return "running";
  if (status === "partial") return "needs-work";
  if (status === "done") return "done";
  if (status === "error" || status === "killed") return "failed";
  return "not-started";
}

function projectMatchesStatusFilter(project: ProjectSnapshot, filter: ProjectStatusFilter): boolean {
  return filter === "all" || projectFilterStatus(project) === filter;
}

function countLoadedProjectStatuses(projects: ProjectSnapshot[], total = projects.length): ProjectStatusCounts {
  const counts: ProjectStatusCounts = { ...EMPTY_PROJECT_STATUS_COUNTS, all: total };
  for (const project of projects) counts[projectFilterStatus(project)] += 1;
  return counts;
}

function normalizeProjectListResponse(
  res: { projects: ProjectSnapshot[]; total: number; statusCounts?: Partial<ProjectStatusCounts> },
  filter: ProjectStatusFilter,
): { projects: ProjectSnapshot[]; total: number; statusCounts: ProjectStatusCounts; serverFiltered: boolean } {
  if (res.statusCounts) {
    return { projects: res.projects, total: res.total, statusCounts: normalizeProjectStatusCounts(res.statusCounts, res.total), serverFiltered: true };
  }
  const projects = filter === "all" ? res.projects : res.projects.filter((project) => projectMatchesStatusFilter(project, filter));
  return {
    projects,
    total: filter === "all" ? res.total : projects.length,
    statusCounts: countLoadedProjectStatuses(res.projects, res.total),
    serverFiltered: false,
  };
}

function mergeProjectSnapshots(current: ProjectSnapshot[], incoming: ProjectSnapshot[], prependNew: boolean): ProjectSnapshot[] {
  if (!incoming.length) return current;
  const byUuid = new Map(incoming.map((project) => [project.uuid, project]));
  const updated = current.map((project) => byUuid.get(project.uuid) ?? project);
  if (!prependNew) return updated;
  const loaded = new Set(updated.map((project) => project.uuid));
  return [...incoming.filter((project) => !loaded.has(project.uuid)), ...updated];
}

function daemonAgeMs(daemon: DaemonRow): number {
  if (!daemon.last_seen_at) return Number.POSITIVE_INFINITY;
  const t = new Date(daemon.last_seen_at).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t;
}

function daemonHealth(daemon: DaemonRow): "online" | "recent" | "stale" {
  if (daemon.online === true) return "online";
  const age = daemonAgeMs(daemon);
  if (age <= ONLINE_MS) return "online";
  if (age <= RECENT_MS) return "recent";
  return "stale";
}

function relativeAge(daemon: DaemonRow): string {
  if (daemon.online === true) return "online";
  const age = daemonAgeMs(daemon);
  if (!Number.isFinite(age)) return "never seen";
  if (age < ONLINE_MS) return "online";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function runInactiveLabel(run: RunRow): string | null {
  if (!run.stale_activity || typeof run.inactive_seconds !== "number") return null;
  return fmtDur(Math.max(0, run.inactive_seconds) * 1000);
}

function daemonCapabilityPayload(daemon: DaemonRow | undefined): Record<string, unknown> | null {
  const caps = daemon?.capabilities;
  if (!caps) return null;
  if (typeof caps === "object" && !Array.isArray(caps)) return caps as Record<string, unknown>;
  return parseJson<Record<string, unknown>>(caps, {});
}

function daemonProviderStatuses(daemon: DaemonRow | undefined): Array<{ provider: string; configured: boolean; required?: boolean }> {
  const caps = daemonCapabilityPayload(daemon);
  if (!caps) return [];
  const providers = (caps as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((entry) => {
    if (typeof entry === "string") return [{ provider: entry, configured: true, required: true }];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const provider = (entry as { provider?: unknown }).provider;
    if (typeof provider !== "string") return [];
    return [{ provider, configured: Boolean((entry as { configured?: unknown }).configured), required: Boolean((entry as { required?: unknown }).required) }];
  });
}

function daemonHasProvider(daemon: DaemonRow | undefined, providerName: string | undefined): boolean | null {
  if (!providerName) return false;
  const statuses = daemonProviderStatuses(daemon);
  if (!statuses.length) return null;
  const match = statuses.find((status) => status.provider === providerName);
  return match ? match.configured : false;
}

function daemonAuthSummary(daemon: DaemonRow): string {
  const configured = daemonProviderStatuses(daemon)
    .filter((status) => status.configured)
    .map((status) => status.provider)
    .slice(0, 4);
  if (configured.length) return `provider auth: ${configured.join(", ")}`;
  return daemonProviderStatuses(daemon).length ? "provider auth: none configured" : "provider auth: not reported";
}

function daemonSandboxStatus(daemon: DaemonRow | undefined): { ok: boolean; state: string; message: string; signature: string } | null {
  if (!daemon) return null;
  const caps = daemonCapabilityPayload(daemon);
  const sandbox = caps?.sandbox;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    const message = "Restart this daemon so it reports sandbox readiness before launching audit phases.";
    return {
      ok: false,
      state: "Sandbox not reported",
      message,
      signature: JSON.stringify({ ok: false, reason: "not-reported" }),
    };
  }
  const read = sandbox as { ok?: unknown; backend?: unknown; image?: unknown; allowHostFallback?: unknown; autoBuild?: unknown; message?: unknown };
  const ok = read.ok === true;
  const autoBuild = read.autoBuild === true;
  const backend = typeof read.backend === "string" ? read.backend : "auto";
  const image = typeof read.image === "string" && read.image.trim() ? read.image : "flounder-sandbox:latest";
  const allowHostFallback = read.allowHostFallback === true;
  const message = typeof read.message === "string" && read.message.trim()
    ? read.message
    : ok
      ? `Sandbox is ready using the ${backend} backend.`
      : `Sandbox is not ready for image ${image}.`;
  return {
    ok,
    state: ok ? (autoBuild ? "Sandbox auto-setup" : `Sandbox ready (${backend})`) : `Sandbox missing (${image})`,
    message,
    signature: JSON.stringify({ ok, backend, image, allowHostFallback, autoBuild, message }),
  };
}

function phaseProviderId(config: ProjectConfig, phase: ProviderPhase): number | undefined {
  const id = config.phaseProviders?.[phase];
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

function phaseProvider(detail: ProjectDetail, providers: ProviderProfile[], phase: ProviderPhase): ProviderProfile | undefined {
  const cfg = projectConfig(detail).cfg;
  const id = phaseProviderId(cfg, phase);
  return id ? providers.find((provider) => provider.id === id) : undefined;
}

function requiredProviderProfiles(detail: ProjectDetail, providers: ProviderProfile[]): ProviderProfile[] {
  const ids = new Set<number>();
  if (typeof detail.project.provider_id === "number") ids.add(detail.project.provider_id);
  const cfg = projectConfig(detail).cfg;
  for (const phase of PROVIDER_PHASES) {
    const id = phaseProviderId(cfg, phase);
    if (id) ids.add(id);
  }
  return [...ids].flatMap((id) => {
    const provider = providers.find((entry) => entry.id === id);
    return provider ? [provider] : [];
  });
}

function providerProfileLabel(provider: ProviderProfile): string {
  const parts = [provider.name];
  const normalizedName = provider.name.toLowerCase();
  if (provider.model && !normalizedName.includes(provider.model.toLowerCase())) parts.push(provider.model);
  if (provider.thinking && !normalizedName.includes(provider.thinking.toLowerCase())) parts.push(provider.thinking);
  return parts.join(" · ");
}

function defaultProjectProviderId(providers: ProviderProfile[]): string {
  const preferred = providers.find((provider) =>
    provider.provider === "openai-codex"
    && provider.model === DEFAULT_OPENAI_CODEX_MODEL
    && provider.thinking === "xhigh",
  );
  return preferred?.id ? String(preferred.id) : providers[0]?.id ? String(providers[0].id) : "";
}

function findingStatusOptionLabel(status: string): string {
  return {
    "confirmed-differential": "Differential confirmed",
    "confirmed-executable": "Execution confirmed",
    "confirmed-source": "Source-confirmed lead",
    "needs-evidence": "Needs evidence",
    suspected: "Needs verification",
    discharged: "Discharged",
    refuted: "Refuted",
  }[status] ?? status;
}

function findingTrackingOptionLabel(status: string): string {
  return {
    open: "Open",
    triaging: "Triaging",
    submitted: "Submitted",
    accepted: "Accepted",
    fixed: "Fixed",
    duplicate: "Duplicate",
    rejected: "Rejected",
    ignored: "Ignored",
  }[status] ?? status;
}

function duplicateOfLabel(finding: FindingRow): string | null {
  return finding.duplicate_of_finding_id ? `Duplicate of #${finding.duplicate_of_finding_id}` : null;
}

function nextAction(finding: FindingRow): string {
  const tracking = finding.tracking_status ?? "open";
  if (tracking === "ignored") return "Ignored";
  if (tracking === "duplicate") return duplicateOfLabel(finding) ?? "Duplicate";
  if (hasUnresolvedEvidenceConflict(finding)) return "Resolve evidence conflict";
  if (tracking === "submitted") return "Watch vendor response";
  if (tracking === "accepted") return "Track fix";
  if (tracking === "fixed") return "Close";
  if (finding.status.startsWith("confirmed") && finding.confirm_status === "reproduced" && !finding.has_report) return "Generate report";
  if (finding.status.startsWith("confirmed") && finding.confirm_status === "reproduced") return "Prepare disclosure";
  if (finding.status.startsWith("confirmed") && finding.confirm_status === "not-reproduced") return "Review reproduction";
  if (finding.status.startsWith("confirmed")) return "Confirm real target";
  if (finding.status === "needs-evidence") return "Collect evidence";
  if (finding.status === "suspected") return "Triage";
  if (finding.status === "refuted" || finding.status === "discharged") return "Archive";
  return "Review";
}

function findingWorkflow(finding: FindingRow): { label: string; detail: string; className: string } {
  const tracking = finding.tracking_status ?? "open";
  if (tracking === "ignored") return { label: "Ignored", detail: "Hidden from active workflow", className: "s-discharged" };
  if (tracking === "duplicate") return { label: "Duplicate", detail: duplicateOfLabel(finding) ?? "Linked duplicate", className: "s-discharged" };
  if (hasUnresolvedEvidenceConflict(finding)) return { label: "Needs review", detail: "Local verification conflicts with real-target reproduction", className: "s-needs-evidence" };
  if (tracking === "accepted" || tracking === "fixed") return { label: tracking === "accepted" ? "Accepted" : "Fixed", detail: nextAction(finding), className: "s-confirmed-executable" };
  if (tracking === "submitted") return { label: "Submitted", detail: "Waiting for vendor response", className: "s-confirmed-source" };
  if (finding.status === "refuted" || finding.status === "discharged") return { label: "Closed", detail: nextAction(finding), className: "s-discharged" };
  if (finding.status === "needs-evidence") return { label: "Needs evidence", detail: "Collect external proof", className: "s-needs-evidence" };
  if (finding.confirm_status === "not-reproduced" || finding.confirm_status === "not_reproduced") return { label: "Needs review", detail: "Real-target proof failed", className: "s-refuted" };
  if (finding.confirm_status === "reproduced" && !finding.has_report) return { label: "Needs report", detail: "Package reproduced bug", className: "s-pending" };
  if (finding.confirm_status === "reproduced") return { label: "Ready to disclose", detail: "Formal report exists", className: "s-confirmed-executable" };
  if (isLocallyVerified(finding)) return { label: "Needs confirm", detail: "Reproduce on real target", className: "s-pending" };
  if (finding.status === "confirmed-source" || finding.status === "suspected") return { label: "Needs verify", detail: "Run local execution check", className: "s-suspected" };
  return { label: "Review", detail: nextAction(finding), className: "s-discharged" };
}

function isLocallyVerified(finding: FindingRow): boolean {
  return finding.status === "confirmed-executable" || finding.status === "confirmed-differential";
}

function findingCheckBadges(finding: FindingRow): { label: string; className: string; title: string }[] {
  const verify = hasUnresolvedEvidenceConflict(finding)
    ? { label: "Conflict", className: "s-needs-evidence", title: "Local verification conflicts with the real-target reproduction and requires human review." }
    : isLocallyVerified(finding)
    ? { label: "Verified", className: "s-confirmed-executable", title: "Local execution verification passed." }
    : finding.status === "refuted" || finding.status === "discharged"
      ? { label: "Refuted", className: "s-refuted", title: "Local verification refuted or discharged this finding." }
      : finding.status === "needs-evidence"
        ? { label: "Needs evidence", className: "s-needs-evidence", title: "Local verification reviewed this finding, but external evidence is needed to settle it." }
      : { label: "Needs verify", className: "s-suspected", title: "This finding still needs local execution verification." };
  const confirm = finding.confirm_status === "reproduced"
    ? { label: "Confirmed", className: "s-confirmed-executable", title: "Real-target confirmation reproduced this finding." }
    : finding.confirm_status === "not-reproduced" || finding.confirm_status === "not_reproduced"
      ? { label: "Not confirmed", className: "s-refuted", title: "Real-target confirmation did not reproduce this finding." }
      : isLocallyVerified(finding)
        ? { label: "Needs confirm", className: "s-pending", title: "This locally verified finding still needs real-target confirmation." }
        : { label: "Not ready", className: "s-discharged", title: "Real-target confirmation starts after local verification." };
  return [verify, confirm];
}

function FindingChecks({ finding }: { finding: FindingRow }) {
  return (
    <span className="finding-checks">
      {findingCheckBadges(finding).map((badge) => (
        <span key={badge.label} className={`label check-label ${badge.className}`} title={badge.title}>{badge.label}</span>
      ))}
    </span>
  );
}

function findingOriginBadge(finding: FindingRow): { label: string; title: string } | null {
  const reasons = (finding.timeline ?? []).map((event) => String(event.reason ?? ""));
  if (reasons.includes("synthesis")) {
    return { label: "Synthesized", title: "This candidate was synthesized from findings across scopes." };
  }
  if (reasons.some((reason) => reason === "audit" || reason === "dig" || reason === "differential")) {
    return { label: "Dig", title: "This candidate came from scope-level audit work." };
  }
  return null;
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return `${pct}%`;
}

function confidenceTone(value: number | null | undefined): { className: string; label: string } {
  if (value == null || !Number.isFinite(value)) return { className: "confidence-low", label: "low" };
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  if (pct >= 85) return { className: "confidence-high", label: "high" };
  if (pct >= 70) return { className: "confidence-medium", label: "medium" };
  return { className: "confidence-low", label: "low" };
}

function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  const label = formatConfidence(value);
  if (!label) return null;
  const tone = confidenceTone(value);
  return <span className={`label confidence-label ${tone.className}`} title={`Model confidence: ${label} (${tone.label})`}>{label}</span>;
}

function coverageModeFromConfig(cfg: { scopeCoverageMode?: string; maxScopes?: number }): CoverageMode {
  if (cfg.scopeCoverageMode && COVERAGE_MODES.some((mode) => mode.value === cfg.scopeCoverageMode)) return cfg.scopeCoverageMode as CoverageMode;
  if (cfg.maxScopes === 10) return "focused";
  if (cfg.maxScopes === 30) return "standard";
  if (cfg.maxScopes == null) return "standard";
  return "custom";
}

function coverageConfig(mode: CoverageMode, maxScopes: string): ProjectConfig {
  const cfg: ProjectConfig = { scopeCoverageMode: mode };
  if (mode === "custom") cfg.maxScopes = numberOrUndefined(maxScopes);
  return cfg;
}

function coverageLabel(cfg: ProjectConfig): string {
  const contest = contestStrategy(cfg);
  if (contest.enabled) return `Contest - ${contest.batchScopes}-scope rounds`;
  const mode = coverageModeFromConfig(cfg);
  const label = mode === "focused"
    ? "Focused - until 10 scopes"
    : mode === "standard"
      ? "Standard - until 30 scopes"
      : mode === "half"
        ? "Half of pending"
        : mode === "full"
          ? "Full pending coverage"
          : `Custom - ${cfg.maxScopes ?? 30} scopes per run`;
  return isBugBountyConfig(cfg) ? `Bug bounty - ${label}` : label;
}

function coverageModeName(cfg: ProjectConfig): string {
  if (contestStrategy(cfg).enabled) return "Contest";
  const mode = coverageModeFromConfig(cfg);
  if (mode === "focused") return "Focused";
  if (mode === "standard") return "Standard";
  if (mode === "half") return "Half";
  if (mode === "full") return "Full";
  return "Custom";
}

function coverageCapText(mode: CoverageMode, maxScopes: string): string {
  if (mode === "focused") return "until 10 audited scopes";
  if (mode === "standard") return "until 30 audited scopes";
  if (mode === "half") return "half pending";
  if (mode === "full") return "all pending";
  return maxScopes;
}

function projectBadgeStatus(project: ProjectSnapshot): string | null | undefined {
  const latest = project.latestRun?.status;
  if ((project.activeRuns ?? 0) > 0 || latest === "running") return "running";
  if (latest === "error" || latest === "killed") return latest;
  const total = project.progress?.total ?? 0;
  const pending = project.progress?.pending ?? 0;
  if (total > 0 && pending > 0) return "partial";
  if ((project.verifyPendingFindings ?? 0) > 0 || (project.confirmPendingFindings ?? 0) > 0) return "partial";
  if (total > 0 || (project.findingsTotal ?? 0) > 0 || (project.reproducedBugs ?? 0) > 0 || (project.confirmedBugs ?? 0) > 0) return "done";
  return latest ?? (total > 0 ? "done" : undefined);
}

function phaseLabel(phase: ProjectPhase): string {
  return {
    prepare: "Prepare",
    map: "Map",
    dig: "Dig",
    synthesis: "Synthesize",
    verify: "Verify candidates",
    confirm: "Confirm",
    report: "Report",
  }[phase];
}

function phaseIcon(phase: ProjectPhase): IconName {
  return {
    prepare: "sync",
    map: "search",
    dig: "bug",
    synthesis: "package",
    verify: "search",
    confirm: "shieldcheck",
    report: "file",
  }[phase] as IconName;
}

function phaseStatusLabel(status: string): string {
  return {
    running: "Running",
    done: "Done",
    partial: "Partial",
    pending: "Pending",
    ready: "Ready",
    none: "Not started",
    error: "Error",
    killed: "Stopped",
  }[status] ?? status;
}

function phaseStatusIcon(status: string): IconName {
  if (status === "done" || status === "ready") return "shieldcheck";
  if (status === "running") return "sync";
  if (status === "pending" || status === "partial") return "clock";
  if (status === "error" || status === "killed") return "x";
  return "clock";
}

function projectStatusTitle(project: ProjectSnapshot): string {
  const status = projectBadgeStatus(project);
  const label = phaseStatusLabel(status ?? "none");
  const latest = project.latestRun?.status;
  const latestContext = latest === "error" ? " The latest run failed; inspect its log if this was unexpected." : latest === "killed" ? " The latest run was stopped; recorded progress is kept." : "";
  if (status === "running") return `${label}: a run is active for this project.`;
  if (status === "partial") return `${label}: coverage, verification, or confirmation work remains.${latestContext}`;
  if (status === "done") return `${label}: no active run and current workflow has completed.${latestContext}`;
  if (status === "error") return `${label}: the latest run failed.`;
  if (status === "killed") return `${label}: the latest run was stopped.`;
  return "No runs yet.";
}

function projectStatusIcon(project: ProjectSnapshot): IconName {
  const status = projectBadgeStatus(project);
  if (status === "running") return "sync";
  if (status === "done") return "shieldcheck";
  if (status === "partial") return "clock";
  if (status === "error" || status === "killed") return "x";
  return "clock";
}

function runKindLabel(kind: string, run?: RunRow): string {
  if (runScopeBatchComplete(run)) return isVerifyRun(run) ? "Finalize candidate verification" : "Finalize audit";
  if (isVerifyRun(run)) return "Verify candidates";
  return {
    prepare: "Prepare target",
    run: "Run pipeline",
    map: "Map",
    audit: "Dig scopes",
    confirm: "Confirm findings",
    report: "Generate reports",
  }[kind] ?? kind;
}

function configuredCoverageTarget(detail: ProjectDetail): number | undefined {
  const total = Math.max(0, detail.progress.total ?? 0);
  if (total <= 0) return undefined;
  const cfg = projectConfig(detail).cfg;
  const mode = coverageModeFromConfig(cfg);
  if (mode === "standard") return Math.min(30, total);
  if (mode === "focused") return Math.min(10, total);
  if (mode === "half") return Math.min(Math.ceil(total / 2), total);
  if (mode === "full") return total;
  return Math.min(Math.max(1, cfg.maxScopes ?? 30), total);
}

function pipelineCoverageRoundComplete(detail: ProjectDetail): boolean {
  const audited = Math.max(0, detail.progress.audited ?? 0);
  const pending = Math.max(0, detail.progress.pending ?? 0);
  const target = configuredCoverageTarget(detail);
  if (target !== undefined && audited >= target) return true;
  return audited > 0 && pending === 0;
}

function pipelineRunActionDetail(detail: ProjectDetail, hasPipelineRun: boolean): string {
  const cfg = projectConfig(detail).cfg;
  const contest = contestStrategy(cfg);
  if (!hasPipelineRun) {
    return contest.enabled
      ? `Contest pipeline: Prepare when needed, then map/dig ${plural(contest.batchScopes, "scope")} per round, verify locally, and generate source-only reports.`
      : "Run the automatic pipeline: Prepare when needed, then map/dig, confirm reproduced impact, and generate reports.";
  }
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  const verifyCount = rawPendingVerifyCount(detail.allFindings);
  if (verifyCount > 0) return `Continue the current pipeline by verifying ${plural(verifyCount, "candidate")} before this round can finish.`;
  const confirmCount = pendingConfirmFindings(detail.allFindings, requiresConfirmation, detail.confirmDecisions).length;
  if (confirmCount > 0) return `Continue the current pipeline by confirming ${plural(confirmCount, "finding")} before this round can finish.`;
  const reportCount = requiresConfirmation ? pendingDecisionReports(detail.confirmDecisions, detail.allFindings).length : pendingFormalReports(detail.allFindings, requiresConfirmation).length;
  if (reportCount > 0) return `Continue the current pipeline by generating ${plural(reportCount, "report")} before this round can finish.`;
  const mode = coverageModeFromConfig(cfg);
  const audited = Math.max(0, detail.progress.audited ?? 0);
  const pending = Math.max(0, detail.progress.pending ?? 0);
  if (contest.enabled) {
    if (pending > 0) return `Continue will audit the next contest batch: up to ${plural(Math.min(contest.batchScopes, pending), "pending scope")}.`;
    return contest.appendMapWhenExhausted
      ? `Continue will expand the map, append novel scopes, then audit up to ${plural(contest.batchScopes, "scope")}.`
      : "Contest scope inventory is exhausted; expand the map or edit the stop policy before continuing.";
  }
  if (pipelineCoverageRoundComplete(detail)) {
    return pending
      ? `Current ${coverageModeName(cfg)} round is complete. Continue stays stopped; use Start next scope round to open another batch from ${plural(pending, "pending scope")}.`
      : "Current pipeline round is complete. Continue stays stopped; no pending mapped scopes remain.";
  }
  if (mode === "standard") {
    if (pending === 0) return "Continue any remaining pipeline work; no pending mapped scopes remain.";
    return `Continue will audit up to ${plural(Math.min(30 - audited, pending), "scope")} to finish the first Standard batch (${audited}/30 audited).`;
  }
  if (mode === "focused") {
    if (pending === 0) return "Continue any remaining pipeline work; no pending mapped scopes remain.";
    return `Continue will audit up to ${plural(Math.min(10 - audited, pending), "scope")} to finish Focused coverage (${audited}/10 audited).`;
  }
  if (mode === "half") return pending ? `Continue will audit about half of the ${plural(pending, "pending scope")}.` : "Continue any remaining pipeline work; no pending mapped scopes remain.";
  if (mode === "full") return pending ? `Continue will audit all ${plural(pending, "pending scope")}.` : "Continue any remaining pipeline work; no pending mapped scopes remain.";
  const cap = projectConfig(detail).cfg.maxScopes ?? 30;
  return pending ? `Continue will audit up to ${plural(Math.min(cap, pending), "pending scope")} using Custom coverage.` : "Continue any remaining pipeline work; no pending mapped scopes remain.";
}

function reportDecisionFindings(detail: ProjectDetail, missingOnly: boolean): FindingRow[] {
  const decisions = missingOnly ? pendingDecisionReports(detail.confirmDecisions, detail.allFindings) : reportableDecisions(detail.confirmDecisions, detail.allFindings);
  const keys = new Set(decisions.flatMap(confirmDecisionMemberKeys));
  if (!keys.size) return [];
  return activeFindings(detail.allFindings).filter((finding) => finding.finding_key && keys.has(finding.finding_key.toLowerCase()));
}

function selectedReportDecisions(detail: ProjectDetail, selectedIds: Set<number>): ConfirmDecision[] {
  return reportableDecisions(detail.confirmDecisions, detail.allFindings).filter((decision) => decisionFindings(decision, detail.allFindings ?? []).some((finding) => selectedIds.has(finding.id)));
}

function verifyButtonLabel(count: number): string {
  return count > 0 ? `Verify candidates (${count})` : "Verify candidates";
}

function verifyButtonTitle(count: number): string {
  return count > 0
    ? `Confirm-or-refute ${plural(count, "candidate")} by local execution before real-target confirmation.`
    : "No unresolved dig or synthesis candidates are waiting for execution verification.";
}

function confirmButtonTitle(count: number, locallyVerified: number, launchLocked: boolean): string {
  if (launchLocked) return "A run is already active for this project.";
  if (count > 0) return `Reproduce ${plural(count, "finding")} on the real target.`;
  if (locallyVerified > 0) return "All locally confirmed findings already have real-target decisions.";
  return "Confirm becomes available after local verification produces an execution-confirmed finding.";
}

function verifyStatusSummary(rows: FindingRow[] | undefined): string {
  const passed = localVerifiedFindings(rows).length;
  const pending = rawPendingVerifyCount(rows);
  const needsEvidence = activeFindings(rows).filter((finding) => finding.status === "needs-evidence").length;
  const refuted = activeFindings(rows).filter((finding) => finding.status === "refuted").length;
  const parts = [];
  if (passed) parts.push(`${passed} passed`);
  if (pending) parts.push(`${pending} pending`);
  if (needsEvidence) parts.push(`${needsEvidence} need evidence`);
  if (refuted) parts.push(`${refuted} refuted`);
  return parts.length ? `Local verification: ${parts.join(" · ")}` : "";
}

function activeVerifySummary(run: RunRow | undefined): string {
  const progress = verifyRunProgress(run);
  return progress ? `Local verification: ${progress.done} checked · ${progress.remaining} pending` : "";
}

function findingsSummary(detail: ProjectDetail): string {
  const suspected = detail.statusCounts.suspected ?? 0;
  const source = detail.statusCounts["confirmed-source"] ?? 0;
  const needsEvidence = detail.statusCounts["needs-evidence"] ?? 0;
  const confirmed = detail.auditConfirmedFindings;
  const pieces = [];
  if (suspected) pieces.push(`${plural(suspected, "suspected lead")}`);
  if (source) pieces.push(`${plural(source, "source-confirmed lead")}`);
  if (needsEvidence) pieces.push(`${plural(needsEvidence, "lead needing evidence")}`);
  if (confirmed) pieces.push(`${plural(confirmed, "audit-confirmed finding")}`);
  return pieces.length ? pieces.join(" · ") : "No candidate findings yet";
}

interface RunStages {
  synthesis?: { scopes?: number; produced?: number; pool?: number; status?: string; startedAt?: string; at?: string };
  differential?: { tested?: number; confirmed?: number; at?: string };
  refutation?: { candidates?: number; refuted?: number; disputed?: number; at?: string };
}

function runStages(run: RunRow | undefined): RunStages {
  if (!run?.stages_json) return {};
  try {
    return JSON.parse(run.stages_json) as RunStages;
  } catch {
    return {};
  }
}

function latestRunWithStage(detail: ProjectDetail, stage: keyof RunStages): RunRow | undefined {
  return currentMaterialRuns(detail.runs, detail.material).find((run) => Boolean(runStages(run)[stage]));
}

interface ActivityLine {
  id: number;
  kind: "thinking" | "text" | "event";
  label: string;
  body: string;
  step?: number;
  meta?: string;
  streamId?: string;
  streaming?: boolean;
  time: number;
}

const STREAM_MERGE_WINDOW_MS = 15_000;
const REASONING_DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_ACTIVITY_LINES = 300;
const PIPELINE_ACTIVITY_STREAM = "__pipeline";
const STICKY_SCROLL_THRESHOLD_PX = 32;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PROJECT_PAGE_SIZE = 100;
const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "needs-work", label: "Needs work" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "not-started", label: "New" },
];
const EMPTY_PROJECT_STATUS_COUNTS: ProjectStatusCounts = {
  all: 0,
  running: 0,
  "needs-work": 0,
  done: 0,
  failed: 0,
  "not-started": 0,
};

function normalizeProjectStatusFilterValue(value: string | null | undefined): ProjectStatusFilter {
  return PROJECT_STATUS_OPTIONS.some((option) => option.value === value) ? value as ProjectStatusFilter : "all";
}

function readProjectListFilters(): { query: string; status: ProjectStatusFilter } {
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get("q") ?? "",
    status: normalizeProjectStatusFilterValue(params.get("status")),
  };
}

function projectListFilterUrl(query: string, status: ProjectStatusFilter): string {
  const params = new URLSearchParams(window.location.search);
  if (query.trim()) params.set("q", query.trim());
  else params.delete("q");
  if (status !== "all") params.set("status", status);
  else params.delete("status");
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
}

function activityPreviewLimit(kind: ActivityLine["kind"]): number {
  return kind === "thinking" ? 900 : kind === "text" ? 1400 : 900;
}

function displayPath(pathLike: string, parts = 3): string {
  const normalized = pathLike.trim().replaceAll("\\", "/");
  if (!normalized) return "";
  return tailPath(normalized, parts);
}

function commandLabel(command: string): string {
  const cmd = command.trim();
  if (/^(rg|grep|find)\b/.test(cmd)) return "Search source";
  if (/^(ls|cat|sed|awk|head|tail|tree)\b/.test(cmd)) return "Inspect workspace";
  if (/^(npm|pnpm|yarn|bun)\s+(install|ci)\b/.test(cmd) || /^(cargo|go)\s+(fetch|mod download)\b/.test(cmd)) return "Prepare dependencies";
  if (/^(forge|cargo|go|npm|pnpm|yarn|bun|node|python\d*|pytest|uv)\b/.test(cmd)) return "Run check";
  if (/^git\b/.test(cmd)) return "Inspect repository";
  if (/^jq\b/.test(cmd)) return "Parse data";
  return "Run command";
}

function shortCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  const head = normalized.split(/\s+/).slice(0, 8).join(" ");
  return head.length < normalized.length ? `${head} ...\n${normalized}` : normalized;
}

function looksLikeSourcePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(source|sources|docs|corpus|verified-sources|deployed-source|provenance)\//.test(trimmed)) return true;
  return /\/[^/]+\.(sol|nr|ts|tsx|js|jsx|rs|go|py|cpp|hpp|h|c|md|json|toml|yaml|yml)$/i.test(trimmed);
}

function actionSummary(detail: string): { label: string; body: string } {
  const value = detail.trim();
  const readMatch = value.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (readMatch) {
    const file = readMatch[1];
    const start = readMatch[2];
    const end = readMatch[3];
    return {
      label: "Reading source",
      body: `${displayPath(file)}:${start}${end ? `-${end}` : ""}`,
    };
  }
  if (looksLikeSourcePath(value)) {
    return { label: "Reading source", body: displayPath(value, 4) };
  }
  if (/^(rg|grep|find|ls|cat|sed|awk|head|tail|tree|npm|pnpm|yarn|bun|npx|forge|cargo|go|python\d*|pytest|uv|node|git|jq)\b/.test(value)) {
    return { label: commandLabel(value), body: shortCommand(value) };
  }
  return { label: "Working", body: value };
}

function eventPayload(event: ActivityRecord): Record<string, unknown> {
  const detail = parseJson<Record<string, unknown>>(event.detail, {});
  const payload = { ...detail };
  for (const key of ["path", "bytes", "produced", "total", "audited", "pending", "deferred", "scopes", "findings", "hypotheses", "refuted", "confirmedExecutable", "commandRuns", "steps", "stoppedReason", "resumed", "target", "runs", "toolchain", "command", "runId", "purpose", "passed", "exitCode", "timedOut", "matched", "missing", "output", "ok"] as const) {
    if (event[key] !== undefined) payload[key] = event[key];
  }
  return payload;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function payloadBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function writeSummary(event: ActivityRecord, verb: "Wrote" | "Edited"): { label: string; body: string } {
  const payload = eventPayload(event);
  const file = payloadString(payload, "path");
  const bytes = payloadNumber(payload, "bytes");
  return {
    label: `${verb} file`,
    body: [file ? displayPath(file) : undefined, bytes !== undefined ? `${bytes.toLocaleString()} bytes` : undefined].filter(Boolean).join(" · ") || "Sandbox file updated",
  };
}

function eventSummary(event: ActivityRecord, fallbackBody: string): { label: string; body: string } | undefined {
  const payload = eventPayload(event);
  switch (event.kind) {
    case "audit_write":
      return writeSummary(event, "Wrote");
    case "audit_edit":
      return writeSummary(event, "Edited");
    case "artifact": {
      const body = fallbackBody.replace(/^wrote\s+/i, "").trim();
      return { label: "Saved artifact", body: body || fallbackBody };
    }
    case "audit_confirm_freeze": {
      const files = payloadNumber(payload, "files");
      return { label: "Confirm inputs frozen", body: files !== undefined ? `${files} files fingerprinted before open-world confirmation.` : fallbackBody };
    }
    case "audit_confirm_resume": {
      const settled = payloadNumber(payload, "settled");
      return { label: "Resumed decisions", body: settled !== undefined ? `${settled} previously settled decisions carried forward.` : fallbackBody };
    }
    case "audit_confirm_start": {
      const findings = payloadNumber(payload, "findings");
      const maxSteps = payloadString(payload, "maxSteps");
      return {
        label: "Confirm started",
        body: [
          findings !== undefined ? `${findings} findings in context` : undefined,
          maxSteps ? `${maxSteps} step budget` : undefined,
        ].filter(Boolean).join(" · ") || fallbackBody,
      };
    }
    case "audit_report_start": {
      const findings = payloadNumber(payload, "findings");
      return { label: "Report started", body: findings !== undefined ? `${findings} submit candidates selected for formal reports.` : fallbackBody };
    }
    case "audit_scope_progress": {
      const total = payloadNumber(payload, "total");
      const audited = payloadNumber(payload, "audited");
      const pending = payloadNumber(payload, "pending");
      const deferred = payloadNumber(payload, "deferred");
      const pieces = [
        total !== undefined && audited !== undefined ? `${audited}/${total} scopes audited` : undefined,
        pending !== undefined ? `${pending} pending` : undefined,
        deferred ? `${deferred} deferred` : undefined,
        payload.resumed ? "resumed" : undefined,
      ].filter(Boolean);
      return { label: "Scope progress", body: pieces.join(" · ") || fallbackBody };
    }
    case "audit_synthesis_start":
      return { label: "Synthesis started", body: `${payloadNumber(payload, "findings") ?? 0} findings across ${payloadNumber(payload, "scopes") ?? 0} scopes` };
    case "audit_synthesis_done":
      return { label: "Synthesis finished", body: `${payloadNumber(payload, "produced") ?? 0} project-level candidates produced` };
    case "audit_done": {
      const pieces = [
        payloadString(payload, "stoppedReason") ?? "finished",
        payloadNumber(payload, "findings") !== undefined ? `${payloadNumber(payload, "findings")} findings` : undefined,
        payloadNumber(payload, "hypotheses") !== undefined ? `${payloadNumber(payload, "hypotheses")} hypotheses` : undefined,
        payloadNumber(payload, "refuted") !== undefined ? `${payloadNumber(payload, "refuted")} refuted` : undefined,
        payloadNumber(payload, "commandRuns") !== undefined ? `${payloadNumber(payload, "commandRuns")} command runs` : undefined,
      ].filter(Boolean);
      return { label: "Run finished", body: pieces.join(" · ") || fallbackBody };
    }
    case "project_history_updated": {
      const target = payloadString(payload, "target");
      const runs = payloadNumber(payload, "runs");
      return { label: "Project updated", body: [target, runs !== undefined ? `${runs} runs stored` : undefined].filter(Boolean).join(" · ") || fallbackBody };
    }
    case "audit_prepare_command": {
      const toolchain = payloadString(payload, "toolchain");
      const command = payloadString(payload, "command");
      const exitCode = payloadNumber(payload, "exitCode");
      return { label: "Prepare command", body: [toolchain, command ? shortCommand(command) : undefined, exitCode !== undefined ? `exit ${exitCode}` : undefined].filter(Boolean).join(" · ") || fallbackBody };
    }
    case "audit_command_start": {
      const command = payloadString(payload, "command");
      const runId = payloadString(payload, "runId");
      const purpose = payloadString(payload, "purpose");
      return {
        label: "Running command",
        body: [runId, purpose, command ? shortCommand(command) : undefined].filter(Boolean).join(" · ") || fallbackBody,
      };
    }
    case "audit_confirm_finalize":
      return { label: "Finalizing decisions", body: "Requesting the required real-target decision sheet before finishing." };
    case "audit_confirm_finalize_done":
      return {
        label: payloadBoolean(payload, "hasDecision") === false ? "Decision sheet missing" : "Decision sheet ready",
        body: payloadBoolean(payload, "hasDecision") === false ? "The confirm run finished without a decision sheet." : "The confirm run produced its decision sheet.",
      };
    case "audit_confirm_checkpoint": {
      const rows = payloadNumber(payload, "rows");
      const reproduced = payloadNumber(payload, "reproducedYes");
      const needsHuman = payloadNumber(payload, "needsHuman");
      const submit = payloadNumber(payload, "submitCandidates");
      return {
        label: "Decision checkpoint",
        body: [
          rows !== undefined ? `${rows} decisions` : undefined,
          reproduced !== undefined ? `${reproduced} reproduced` : undefined,
          needsHuman ? `${needsHuman} need human` : undefined,
          submit ? `${submit} submit candidates` : undefined,
        ].filter(Boolean).join(" · ") || fallbackBody,
      };
    }
    case "audit_confirm_equiv_skipped": {
      const items = payloadNumber(payload, "items");
      const maxItems = payloadNumber(payload, "maxItems");
      return {
        label: "Equivalence check skipped",
        body: items !== undefined && maxItems !== undefined
          ? `${items} decisions exceeded the automatic comparison limit of ${maxItems}.`
          : fallbackBody,
      };
    }
    case "audit_confirm_done": {
      const rows = payloadNumber(payload, "rows");
      const reproduced = payloadNumber(payload, "reproducedYes");
      const submit = payloadNumber(payload, "submitCandidates");
      return {
        label: "Confirm finished",
        body: [
          rows !== undefined ? `${rows} decisions` : undefined,
          reproduced !== undefined ? `${reproduced} reproduced` : undefined,
          submit !== undefined ? `${submit} submit candidates` : undefined,
        ].filter(Boolean).join(" · ") || fallbackBody,
      };
    }
    case "audit_report_finalize":
      return { label: "Finalizing reports", body: "Requesting any missing formal report files before finishing." };
    case "audit_report_finalize_done": {
      const reports = payloadNumber(payload, "reports");
      return { label: "Reports ready", body: reports !== undefined ? `${reports} formal reports produced` : fallbackBody };
    }
    case "audit_report_done": {
      const reports = payloadNumber(payload, "reports");
      return { label: "Report finished", body: reports !== undefined ? `${reports} formal reports produced` : fallbackBody };
    }
    default:
      return undefined;
  }
}

function formatActivityTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function usePinnedScroll(trigger: unknown, resetKey: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);

  const scrollToBottom = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    pinnedRef.current = true;
    setIsPinned(true);
  };

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const pinned = node.scrollHeight - node.scrollTop - node.clientHeight <= STICKY_SCROLL_THRESHOLD_PX;
    pinnedRef.current = pinned;
    setIsPinned(pinned);
  };

  useEffect(() => {
    pinnedRef.current = true;
    setIsPinned(true);
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [resetKey]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [trigger]);

  return { scrollRef, onScroll, scrollToBottom, isPinned };
}

function commandRunSummary(detail: string, payload: Record<string, unknown> = {}): string {
  try {
    const parsed = { ...JSON.parse(detail), ...payload } as {
      runId?: string;
      purpose?: string;
      passed?: boolean;
      exitCode?: number;
      timedOut?: boolean;
      missing?: number;
      matched?: number;
      output?: string;
    };
    const status = parsed.timedOut
      ? "timed out"
      : parsed.purpose === "inspect"
        ? parsed.exitCode === 0
          ? "completed"
          : parsed.exitCode === 1
            ? "no matches"
            : "error"
        : parsed.passed
          ? "passed"
          : "failed";
    const pieces = [
      parsed.runId,
      parsed.purpose,
      status,
      typeof parsed.exitCode === "number" && status !== `exit ${parsed.exitCode}` ? `exit ${parsed.exitCode}` : undefined,
      parsed.missing ? `${parsed.missing} missing` : undefined,
      parsed.matched ? `${parsed.matched} matched` : undefined,
    ].filter(Boolean);
    const summary = pieces.join(" · ");
    return parsed.output ? `${summary}\n${parsed.output}` : summary;
  } catch {
    return detail;
  }
}

function stepMatchesActivity(tool: unknown, label: string): boolean {
  const name = typeof tool === "string" ? tool : "";
  if (!name) return true;
  if (name === "read") return label === "Reading source";
  if (name === "bash") return label === "Running command";
  if (name === "write") return label === "Write" || label === "Working";
  return label === "Working";
}

function activityDelta(event: ActivityRecord): string | undefined {
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.detail !== "string") return undefined;
  try {
    const parsed = JSON.parse(event.detail) as { delta?: unknown; text?: unknown };
    if (typeof parsed.delta === "string") return parsed.delta;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // Some persisted streams store the token directly in detail.
  }
  return event.detail;
}

function activityEventStreamId(event: ActivityRecord): string | undefined {
  if (typeof event.streamId === "string" && event.streamId.trim()) return event.streamId.trim();
  if (typeof event.scope === "string" && event.scope.trim()) return event.scope.trim();
  return undefined;
}

function updateActiveActivityStreams(current: string[], event: ActivityRecord): string[] {
  if (event.kind === "activity_stream_state") {
    return Array.isArray(event.activeStreams)
      ? [...new Set(event.activeStreams.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
      : [];
  }
  const streamId = activityEventStreamId(event);
  if (!streamId) return current;
  if (event.kind === "audit_dig_done") return current.filter((id) => id !== streamId);
  return current.includes(streamId) ? current : [...current, streamId];
}

function appendStreamLine(next: ActivityLine[], now: number, kind: ActivityLine["kind"], label: string, delta: string, streamId?: string): void {
  const normalizedDelta = normalizeActivityBody(delta);
  if (!normalizedDelta.trim()) return;
  const last = next[next.length - 1];
  const recentStreamIndex = [...next]
    .reverse()
    .findIndex((line) => line.streaming && line.kind === kind && line.label === label && line.streamId === streamId && now - line.time <= STREAM_MERGE_WINDOW_MS);
  if (last?.streaming && last.kind === kind && last.label === label && last.streamId === streamId) {
    next[next.length - 1] = { ...last, body: normalizeActivityBody(`${last.body}${delta}`), time: now };
  } else if (recentStreamIndex >= 0) {
    const index = next.length - 1 - recentStreamIndex;
    const line = next[index];
    next[index] = { ...line, body: normalizeActivityBody(`${line.body}${delta}`), time: now };
  } else {
    next.push({ id: now + next.length, kind, label, body: normalizedDelta, time: now, streaming: true, ...(streamId ? { streamId } : {}) });
  }
}

function appendFinalStreamLine(next: ActivityLine[], now: number, kind: ActivityLine["kind"], label: string, body: string, streamId?: string): void {
  const segments = kind === "thinking"
    ? splitActivitySummaries(body)
    : [normalizeActivityBody(body).trim()].filter(Boolean);
  const activeIndex = [...next]
    .reverse()
    .findIndex((line) => line.streaming && line.kind === kind && line.label === label && line.streamId === streamId);
  if (activeIndex >= 0) next.splice(next.length - 1 - activeIndex, 1);
  if (!segments.length) return;
  for (const segment of segments) {
    appendEventLine(next, {
      id: now + next.length,
      kind,
      label,
      body: segment,
      time: now,
      streaming: false,
      ...(streamId ? { streamId } : {}),
    });
  }
}

function activityLineDedupeBody(value: string): string {
  return normalizeActivityBody(value).replace(/\s+/g, " ").trim();
}

function appendEventLine(next: ActivityLine[], line: ActivityLine): void {
  const key = activityLineDedupeBody(line.body);
  if (!key) return;
  const dedupeWindow = line.kind === "thinking" ? REASONING_DEDUPE_WINDOW_MS : STREAM_MERGE_WINDOW_MS;
  const recentIndex = [...next]
    .reverse()
    .findIndex((existing) =>
      existing.kind === line.kind &&
      existing.label === line.label &&
      existing.streamId === line.streamId &&
      activityLineDedupeBody(existing.body) === key &&
      Math.abs(line.time - existing.time) <= dedupeWindow,
    );
  if (recentIndex >= 0) {
    const index = next.length - 1 - recentIndex;
    next[index] = { ...next[index], time: line.time, step: line.step ?? next[index].step, meta: line.meta ?? next[index].meta };
    return;
  }
  next.push(line);
}

function activityEventLabel(kind: string): string {
  switch (kind) {
    case "audit_thinking":
      return "Thinking";
    case "audit_text":
      return "Output";
    case "audit_action":
      return "Action";
    case "audit_command_start":
      return "Running command";
    case "audit_command_run":
      return "Command result";
    case "audit_write":
      return "Write";
    case "audit_start":
      return "Start";
    default:
      return kind.replace(/^audit_/, "").replaceAll("_", " ");
  }
}

function appendActivityLine(lines: ActivityLine[], event: ActivityRecord): ActivityLine[] {
  if (event.kind === "activity_stream_state") return lines;
  const next = [...lines];
  const last = next[next.length - 1];
  const streamId = activityEventStreamId(event);
  const eventTs = typeof event.ts === "string" ? new Date(event.ts).getTime() : Date.now();
  const now = Number.isFinite(eventTs) ? eventTs : Date.now();
  if (event.kind === "thinking_delta") {
    const delta = activityDelta(event);
    if (delta) appendStreamLine(next, now, "thinking", "Thinking", delta, streamId);
    return next.slice(-MAX_ACTIVITY_LINES);
  }
  if (event.kind === "text_delta") {
    const delta = activityDelta(event);
    if (delta) appendStreamLine(next, now, "text", "Output", delta, streamId);
  } else if (event.kind === "step") {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const line = next[index];
      if (!line.streaming || line.streamId !== streamId) continue;
      next[index] = { ...line, streaming: false };
      break;
    }
    const canAnnotateAction =
      last?.kind === "event" &&
      last.streamId === streamId &&
      !["Command result", "Start"].includes(last.label) &&
      stepMatchesActivity(event.tool, last.label);
    if (canAnnotateAction && now - last.time <= 4_000) {
      next[next.length - 1] = {
        ...last,
        step: typeof event.step === "number" ? event.step : last.step,
        meta: typeof event.step === "number" ? `Step ${event.step}` : last.meta,
        time: now,
      };
    }
  } else {
    const body = typeof event.detail === "string"
      ? event.detail
      : typeof event.text === "string"
        ? event.text
        : typeof event.result === "string"
          ? event.result
          : event.kind;
    const label = activityEventLabel(event.kind);
    const action = event.kind === "audit_action" ? actionSummary(body) : undefined;
    const summary = event.kind === "audit_action" ? undefined : eventSummary(event, body);
    const actionFailed = event.kind === "audit_action" && event.ok === false;
    if (event.kind === "audit_action" && !actionFailed && event.tool === "bash") return next.slice(-MAX_ACTIVITY_LINES);
    if (event.kind === "audit_action" && !actionFailed && ["bash", "read", "write", "edit"].includes(body.trim())) return next.slice(-MAX_ACTIVITY_LINES);
    const normalizedBody = event.kind === "audit_command_run"
      ? commandRunSummary(body, eventPayload(event))
      : actionFailed
        ? [action?.body ?? body, typeof event.result === "string" ? event.result : undefined].filter(Boolean).join("\n")
        : action?.body ?? summary?.body ?? body;
    if (event.kind === "audit_thinking") {
      appendFinalStreamLine(next, now, "thinking", "Thinking", normalizedBody, streamId);
      return next.slice(-MAX_ACTIVITY_LINES);
    }
    if (event.kind === "audit_text") {
      appendFinalStreamLine(next, now, "text", "Output", normalizedBody, streamId);
      return next.slice(-MAX_ACTIVITY_LINES);
    }
    appendEventLine(next, {
      id: now + next.length,
      kind: event.kind === "audit_thinking" ? "thinking" : "event",
      label: actionFailed ? "Action blocked" : action?.label ?? summary?.label ?? label,
      body: normalizeActivityBody(normalizedBody),
      time: now,
      ...(streamId ? { streamId } : {}),
    });
  }
  return next.slice(-MAX_ACTIVITY_LINES);
}

function ActivityBody({ line, pre = false, defaultExpanded = false }: { line: ActivityLine; pre?: boolean; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const limit = activityPreviewLimit(line.kind);
  const canExpand = line.body.length > limit;
  const visibleBody = canExpand && !expanded ? `${line.body.slice(0, limit).trimEnd()}...` : line.body;

  useEffect(() => {
    setExpanded(canExpand && defaultExpanded);
  }, [canExpand, defaultExpanded, line.id]);

  return (
    <div className={`activity-body-wrap ${pre ? "pre" : ""}`}>
      {pre ? <pre>{visibleBody}</pre> : <span className="activity-body">{visibleBody}</span>}
      {canExpand ? (
        <button
          className="activity-expand"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function PaginationControls(props: {
  total: number;
  page: number;
  pageSize: number;
  label: string;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}) {
  if (props.total <= 0) return null;
  const pageCount = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), pageCount);
  const start = (page - 1) * props.pageSize + 1;
  const end = Math.min(props.total, page * props.pageSize);
  return (
    <div className="pagination" aria-label={`${props.label} pagination`}>
      <span>{start}-{end} of {plural(props.total, props.label)}</span>
      <select
        value={props.pageSize}
        aria-label={`${props.label} per page`}
        onChange={(event) => {
          props.onPageSize(Number(event.target.value));
          props.onPage(1);
        }}
      >
        {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} / page</option>)}
      </select>
      <div className="pagination-buttons">
        <Button size="sm" disabled={page <= 1} onClick={() => props.onPage(page - 1)}>Previous</Button>
        <span>Page {page} / {pageCount}</span>
        <Button size="sm" disabled={page >= pageCount} onClick={() => props.onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

function savedBugViews(stats: BugStats): Array<{ id: string; label: string; status?: string; tracking?: string; count: number }> {
  return [
    { id: "active", label: "Active", tracking: "active", count: stats.active ?? Math.max(0, stats.total - (stats.byTracking.ignored ?? 0)) },
    { id: "all", label: "All", count: stats.total },
    { id: "differential", label: "Differential", status: "confirmed-differential", tracking: "open", count: stats.byStatus["confirmed-differential"] ?? 0 },
    { id: "executable", label: "Executable", status: "confirmed-executable", tracking: "open", count: stats.byStatus["confirmed-executable"] ?? 0 },
    { id: "triage", label: "Needs triage", status: "suspected", tracking: "open", count: stats.byStatus.suspected ?? 0 },
    { id: "evidence", label: "Needs evidence", status: "needs-evidence", tracking: "open", count: stats.byStatus["needs-evidence"] ?? 0 },
    { id: "submitted", label: "Submitted", tracking: "submitted", count: stats.byTracking.submitted ?? 0 },
    { id: "accepted", label: "Accepted", tracking: "accepted", count: stats.byTracking.accepted ?? 0 },
    { id: "ignored", label: "Ignored", tracking: "ignored", count: stats.byTracking.ignored ?? 0 },
  ];
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => readRoute());
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectSnapshot[]>([]);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [archivedProjectsTotal, setArchivedProjectsTotal] = useState(0);
  const [projectQuery, setProjectQuery] = useState(() => readProjectListFilters().query);
  const [projectStatusFilter, setProjectStatusFilter] = useState<ProjectStatusFilter>(() => readProjectListFilters().status);
  const [projectStatusCounts, setProjectStatusCounts] = useState<ProjectStatusCounts>(EMPTY_PROJECT_STATUS_COUNTS);
  const [projectLoading, setProjectLoading] = useState(false);
  const [archivedProjectLoading, setArchivedProjectLoading] = useState(false);
  const [activeJobsTotal, setActiveJobsTotal] = useState(0);
  const [maintainerMode, setMaintainerMode] = useState(false);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [daemons, setDaemons] = useState<DaemonRow[]>([]);
  const [bugs, setBugs] = useState<FindingRow[]>([]);
  const [bugsTotal, setBugsTotal] = useState(0);
  const [bugStats, setBugStats] = useState<BugStats>({ total: 0, active: 0, byStatus: {}, byTracking: {} });
  const [bugProject, setBugProject] = useState("");
  const [bugSource, setBugSource] = useState<"project" | "evaluation" | "all">("project");
  const [bugStatus, setBugStatus] = useState("");
  const [bugTracking, setBugTracking] = useState("active");
  const [bugPage, setBugPage] = useState(1);
  const [bugPageSize, setBugPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [bugLoading, setBugLoading] = useState(false);
  const [bugError, setBugError] = useState("");
  const [bugReloadKey, setBugReloadKey] = useState(0);
  const [projectTab, setProjectTab] = useState<ProjectTab>("overview");
  const [projectFindingQuery, setProjectFindingQuery] = useState("");
  const [projectFindingStatus, setProjectFindingStatus] = useState("");
  const [modal, setModal] = useState<ModalName>(null);
  const [reportFinding, setReportFinding] = useState<FindingRow | null>(null);
  const [reportDecision, setReportDecision] = useState<ConfirmDecision | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [logRun, setLogRun] = useState<RunRow | null>(null);
  const [stopConfirmRun, setStopConfirmRun] = useState<RunRow | null>(null);
  const [launchConfirmAction, setLaunchConfirmAction] = useState<LaunchAction | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<ProjectSnapshot | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => initialTheme());
  const [, setClockTick] = useState(0);
  const detailRef = useRef<ProjectDetail | null>(null);
  const detailRefreshRef = useRef(0);
  const projectListRefreshRef = useRef(0);

  useEffect(() => {
    const onRoute = () => {
      setRoute(readRoute());
      const filters = readProjectListFilters();
      setProjectQuery(filters.query);
      setProjectStatusFilter(filters.status);
    };
    addEventListener("popstate", onRoute);
    addEventListener("hashchange", onRoute);
    return () => {
      removeEventListener("popstate", onRoute);
      removeEventListener("hashchange", onRoute);
    };
  }, []);

  useEffect(() => {
    if (route.view !== "projects") return;
    const next = projectListFilterUrl(projectQuery, projectStatusFilter);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, "", next);
  }, [route.view, route.projectUuid, projectQuery, projectStatusFilter]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("flounder-theme", theme);
  }, [theme]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCmdOpen(true);
      }
      if (event.key === "Escape") {
        setCmdOpen(false);
        setModal(null);
        setStopConfirmRun(null);
        setLaunchConfirmAction(null);
        setDeleteProjectConfirm(null);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  async function loadProjectPage(append = false) {
    setProjectLoading(true);
    try {
      const res = await api.projects({ limit: PROJECT_PAGE_SIZE, offset: append ? projects.length : 0, q: projectQuery, status: projectStatusParam(projectStatusFilter) });
      const normalized = normalizeProjectListResponse(res, projectStatusFilter);
      if (append) {
        const nextProjects = appendProjectPage(projects, normalized.projects);
        setProjects(nextProjects);
        if (!normalized.serverFiltered) setProjectStatusCounts(countLoadedProjectStatuses(nextProjects, projectStatusFilter === "all" ? Math.max(normalized.total, nextProjects.length) : nextProjects.length));
      } else {
        setProjects(normalized.projects);
      }
      setProjectsTotal(normalized.total);
      if (normalized.serverFiltered || !append) setProjectStatusCounts(normalized.statusCounts);
    } finally {
      setProjectLoading(false);
    }
  }

  async function loadArchivedProjectPage(append = false) {
    setArchivedProjectLoading(true);
    try {
      const res = await api.archivedProjects({ limit: PROJECT_PAGE_SIZE, offset: append ? archivedProjects.length : 0 });
      setArchivedProjects((current) => append ? appendProjectPage(current, res.projects) : res.projects);
      setArchivedProjectsTotal(res.total);
    } finally {
      setArchivedProjectLoading(false);
    }
  }

  async function refreshBase() {
    const [catalogRes, projectRes, archivedRes, providerRes, daemonRes] = await Promise.all([
      api.catalog().catch(() => ({ maintainerMode: false })),
      api.projects({ limit: PROJECT_PAGE_SIZE, q: projectQuery, status: projectStatusParam(projectStatusFilter) }),
      api.archivedProjects({ limit: PROJECT_PAGE_SIZE }),
      api.providers(),
      api.daemons(),
    ]);
    const normalizedProjects = normalizeProjectListResponse(projectRes, projectStatusFilter);
    setMaintainerMode(catalogRes.maintainerMode === true);
    setProjects(normalizedProjects.projects);
    setArchivedProjects(archivedRes.projects);
    setProjectsTotal(normalizedProjects.total);
    setProjectStatusCounts(normalizedProjects.statusCounts);
    setArchivedProjectsTotal(archivedRes.total);
    setProviders(providerRes.providers);
    setDaemons(daemonRes.daemons);
  }

  useEffect(() => {
    void refreshBase().catch((error: unknown) => setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) }));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProjectPage(false).catch((error: unknown) => setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [projectQuery, projectStatusFilter]);

  useEffect(() => {
    if (!route.projectUuid) {
      setDetail(null);
      return;
    }
    setProjectTab("overview");
    setProjectFindingQuery("");
    setProjectFindingStatus("");
    void api
      .project(route.projectUuid)
      .then(setDetail)
      .catch((error: unknown) => setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) }));
  }, [route.projectUuid]);

  useEffect(() => {
    if (route.view !== "findings") return;
    const params = new URLSearchParams({
      limit: String(bugPageSize),
      offset: String((bugPage - 1) * bugPageSize),
    });
    if (bugProject) params.set("project", bugProject);
    params.set("source", bugSource);
    if (bugStatus) params.set("status", bugStatus);
    if (bugTracking) params.set("tracking", bugTracking);
    setBugLoading(true);
    setBugError("");
    void api
      .bugs(params)
      .then((res) => {
        setBugs(res.findings);
        setBugsTotal(res.total);
        setBugStats(res.stats);
      })
      .catch((error: unknown) => {
        setBugError(String(error instanceof Error ? error.message : error));
        setBugs([]);
      })
      .finally(() => setBugLoading(false));
  }, [route.view, bugProject, bugSource, bugStatus, bugTracking, bugPage, bugPageSize, bugReloadKey]);

  useEffect(() => {
    setBugPage(1);
  }, [bugProject, bugSource, bugStatus, bugTracking]);

  const bugPageCount = Math.max(1, Math.ceil(bugsTotal / bugPageSize));
  useEffect(() => {
    if (bugPage > bugPageCount) setBugPage(bugPageCount);
  }, [bugPage, bugPageCount]);

  const selectedProject = route.projectUuid ? projects.find((p) => p.uuid === route.projectUuid) : undefined;
  const selectedProjectForDetail = selectedProject ?? (detail && detail.project.uuid === route.projectUuid ? snapshotFromProjectDetail(detail) : undefined);
  const currentDetailForModal = detail ? currentMaterialDetail(detail) : null;
  const sidebarProjects = detail && selectedProject
    ? projects.map((project) => project.uuid === detail.project.uuid ? snapshotFromDetail(project, detail) : project)
    : projects;
  const onlineDaemons = daemons.filter((daemon) => daemonHealth(daemon) === "online");
  const loadedRunning = projects.reduce((n, project) => n + (project.activeRuns ?? (project.latestRun?.status === "running" ? 1 : 0)), 0);
  const latestRunning = Math.max(activeJobsTotal, loadedRunning);
  const visibleRunningRun = detail?.runs.some((run) => run.status === "running") ?? false;
  const emptyProjectListTitle = projectQuery.trim() && projects.length === 0
    ? "No matching projects"
    : projectStatusFilter !== "all" && projects.length === 0
      ? "No projects in this status"
      : "Select a project";
  const emptyProjectListBody = projectQuery.trim() && projects.length === 0
    ? "Clear or change the project search to pick a target."
    : projectStatusFilter !== "all" && projects.length === 0
      ? "Change the status filter to pick another target."
      : "Pick a target from the project list, or create one when you have source, build root, and an execution profile ready.";

  useEffect(() => {
    if (!latestRunning && !visibleRunningRun) return;
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [latestRunning, visibleRunningRun]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as { projects?: ProjectSnapshot[]; active?: unknown[] };
        if (Array.isArray(payload.active)) setActiveJobsTotal(payload.active.length);
        if (Array.isArray(payload.projects)) {
          const filtersActive = Boolean(projectQuery.trim()) || projectStatusFilter !== "all";
          const incoming = projectStatusFilter === "all" ? payload.projects : payload.projects.filter((project) => projectMatchesStatusFilter(project, projectStatusFilter));
          setProjects((current) => {
            const merged = mergeProjectSnapshots(current, incoming, !filtersActive);
            return projectStatusFilter === "all" ? merged : merged.filter((project) => projectMatchesStatusFilter(project, projectStatusFilter));
          });
          if (filtersActive) {
            const now = Date.now();
            if (now - projectListRefreshRef.current > 3_000) {
              projectListRefreshRef.current = now;
              void api
                .projects({ limit: PROJECT_PAGE_SIZE, q: projectQuery, status: projectStatusParam(projectStatusFilter) })
                .then((res) => {
                  const normalized = normalizeProjectListResponse(res, projectStatusFilter);
                  setProjects(normalized.projects);
                  setProjectsTotal(normalized.total);
                  setProjectStatusCounts(normalized.statusCounts);
                })
                .catch(() => {
                  // Direct user-triggered refreshes still surface errors; avoid toast spam from live list refreshes.
                });
            }
          }
          const currentUuid = route.projectUuid;
          const current = currentUuid ? payload.projects.find((project) => project.uuid === currentUuid) : undefined;
          const detailStillRunning = detailRef.current
            ? currentMaterialRuns(detailRef.current.runs, detailRef.current.material).some((run) => run.status === "running")
            : false;
          const shouldRefreshDetail = Boolean(current && (
            (current.activeRuns ?? 0) > 0
            || current.latestRun?.status === "running"
            || detailStillRunning
            || detailSnapshotDiffers(current, detailRef.current)
          ));
          const now = Date.now();
          if (currentUuid && shouldRefreshDetail && now - detailRefreshRef.current > 2500) {
            detailRefreshRef.current = now;
            void api
              .project(currentUuid)
              .then((next) => {
                if (detailRef.current?.project.uuid === next.project.uuid || route.projectUuid === next.project.uuid) setDetail(next);
              })
              .catch(() => {
                // The normal route fetch and user actions still surface errors; avoid toast spam from the live stream.
              });
          }
        }
      } catch {
        // Ignore malformed stream frames; direct API refreshes still work.
      }
    };
    return () => source.close();
  }, [route.projectUuid, projectQuery, projectStatusFilter]);

  async function launch(action: LaunchAction, selectedFindings?: FindingRow[]) {
    if (!route.projectUuid) return;
    let verifyCandidates: FindingRow[] = [];
    let runHint = "";
    const opensNextCoverage = action === "run-next-coverage";
    if (detail?.project.uuid === route.projectUuid) {
      const currentDetail = currentMaterialDetail(detail);
      const running = currentMaterialRuns(detail.runs, detail.material).find((run) => run.status === "running");
      const selectedDaemon = daemons.find((daemon) => daemon.id === currentDetail.project.daemon_id);
      if (!selectedDaemon) {
        setToast({ tone: "warning", message: "Select a project daemon before launching. Project paths and provider credentials live on the daemon machine." });
        setModal(null);
        return;
      }
      if (daemonHealth(selectedDaemon) !== "online") {
        setToast({ tone: "warning", message: `${selectedDaemon.name ?? `daemon-${selectedDaemon.id}`} is not online. Start that daemon before launching this project.` });
        setModal(null);
        return;
      }
      const missingAuth = requiredProviderProfiles(currentDetail, providers).filter((profile) => daemonHasProvider(selectedDaemon, profile.provider) === false);
      if (missingAuth.length > 0) {
        setToast({ tone: "warning", message: `Configure ${missingAuth.map((profile) => profile.provider).join(", ")} on ${selectedDaemon.name ?? `daemon-${selectedDaemon.id}`} before launching.` });
        setModal(null);
        return;
      }
      if (running) {
        setToast({ tone: "warning", message: `${runKindLabel(running.kind, running)} is already running. Stop it or wait for it to finish before starting another run.` });
        setModal(null);
        return;
      }
      if (action === "run") runHint = pipelineRunActionDetail(currentDetail, currentDetail.runs.some((run) => run.kind === "run"));
      if (opensNextCoverage) runHint = "Explicit next scope round requested; the control plane will still settle any current-round work first.";
      const requiresConfirmation = needsRealTargetConfirmation(currentDetail);
      if (opensNextCoverage && (currentDetail.progress.pending ?? 0) === 0) {
        setToast({ tone: "warning", message: "There are no pending mapped scopes for another scope round. Map new scopes first." });
        setModal(null);
        return;
      }
      if (action === "confirm" && pendingConfirmFindings(currentDetail.allFindings, requiresConfirmation, currentDetail.confirmDecisions).length === 0) {
        setToast({ tone: "warning", message: "There are no audit-confirmed findings waiting for real-target confirmation yet." });
        setModal(null);
        return;
      }
      const reportableCount = requiresConfirmation ? reportableDecisions(currentDetail.confirmDecisions, currentDetail.allFindings).length : reportableFindings(currentDetail.allFindings, requiresConfirmation).length;
      if (action === "report" && reportableCount === 0) {
        setToast({ tone: "warning", message: requiresConfirmation ? "There are no real-target decisions ready for submission reports yet." : "There are no locally execution-confirmed findings ready for formal reports yet." });
        setModal(null);
        return;
      }
      if (action === "verify") {
        verifyCandidates = pendingVerifyFindings(currentDetail.allFindings);
        if (verifyCandidates.length === 0) {
          setToast({ tone: "warning", message: "There are no suspected or source-confirmed candidates waiting for execution verification." });
          setModal(null);
          return;
        }
      }
      if (action === "audit" && (currentDetail.progress.pending ?? 0) === 0) {
        setToast({ tone: "warning", message: "There are no pending scopes to dig. Run the pipeline first or map new scopes." });
        setModal(null);
        return;
      }
      if ((action === "verify" || action === "confirm" || action === "report") && selectedFindings && selectedFindings.length === 0) {
        setToast({ tone: "warning", message: "Select at least one finding before launching." });
        setModal(null);
        return;
      }
    }
    setBusy(true);
    try {
      const verb = action === "verify" ? "audit" : opensNextCoverage ? "run" : action;
      const selected = selectedFindings && selectedFindings.length ? selectedFindings : undefined;
      const result = (await api.launchRun(route.projectUuid, {
        verb,
        ...(action === "run" || opensNextCoverage ? { pipeline: true } : {}),
        ...(opensNextCoverage ? { continueCoverage: true } : {}),
        ...(action === "map-expand" ? { verb: "map", appendMap: true } : {}),
        ...(action === "verify" ? { verifyFindings: selected ?? verifyCandidates } : {}),
        ...((action === "confirm" || action === "report") && selected ? { findingIds: selected.map((finding) => finding.id) } : {}),
      })) as LaunchResult;
      const waiting = (result.daemons ?? 0) === 0;
      const waitingForProject = result.queueReason === "project-run-active";
      const label = action === "verify" ? "verify" : action === "map-expand" ? "expand map" : opensNextCoverage ? "run" : verb;
      setToast({
        tone: waiting || waitingForProject ? "warning" : "success",
        message: waitingForProject
          ? result.message ?? `${label} queued behind another run for this project and will start automatically when it finishes.`
          : waiting
          ? `${label} queued, but no online daemon is connected. Start a daemon to claim the job.`
          : `${label} queued for ${plural(result.daemons ?? 0, "daemon")}.${runHint && (action === "run" || opensNextCoverage) ? ` ${runHint}` : ""}`,
      });
      await refreshBase();
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    } finally {
      setBusy(false);
      setModal(null);
    }
  }

  function requestLaunch(action: LaunchAction) {
    if (action === "verify" || action === "confirm" || action === "report") {
      setLaunchConfirmAction(action);
      return;
    }
    void launch(action);
  }

  async function updateTracking(finding: FindingRow, status: string) {
    try {
      let duplicateOfFindingId: number | null = null;
      if (status === "duplicate") {
        const raw = window.prompt("Canonical finding id this duplicates", finding.duplicate_of_finding_id ? String(finding.duplicate_of_finding_id) : "");
        if (raw === null) return;
        const trimmed = raw.trim().replace(/^#/, "");
        if (trimmed) {
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            setToast({ tone: "error", message: "Duplicate target must be a positive finding id." });
            return;
          }
          duplicateOfFindingId = parsed;
        }
      }
      await api.trackFinding(finding.id, status, { duplicateOfFindingId });
      if (route.view === "findings") {
        setBugReloadKey((key) => key + 1);
      } else if (route.projectUuid) {
        setDetail(await api.project(route.projectUuid));
      }
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  async function patchScope(scopeId: string, body: unknown) {
    if (!route.projectUuid) return;
    try {
      await api.patchScope(route.projectUuid, scopeId, body);
      const [nextDetail] = await Promise.all([api.project(route.projectUuid), refreshBase()]);
      setDetail(nextDetail);
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  async function patchBacklog(id: number, status: string) {
    if (!route.projectUuid) return;
    try {
      await api.patchBacklog(id, { status });
      const [nextDetail] = await Promise.all([api.project(route.projectUuid), refreshBase()]);
      setDetail(nextDetail);
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  async function stopRun(run: RunRow) {
    setBusy(true);
    try {
      await api.stopRun(run.id);
      setStopConfirmRun(null);
      setToast({ tone: "success", message: `Stop requested for ${run.kind} run #${run.id}.` });
      if (route.projectUuid) setDetail(await api.project(route.projectUuid));
      await refreshBase();
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    } finally {
      setBusy(false);
    }
  }

  async function updateRunTarget(run: RunRow, body: RunUpdatePayload) {
    try {
      const result = await api.updateRun(run.id, body);
      setToast({ tone: "success", message: `Run #${run.id} target updated to ${result.runScopesTarget}.` });
      if (route.projectUuid) setDetail(await api.project(route.projectUuid));
      await refreshBase();
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  async function updateProjectDisplay(project: ProjectSnapshot, body: ProjectPayload, message: string) {
    try {
      await api.updateProject(project.uuid, body);
      if (body.archived === true && route.projectUuid === project.uuid) {
        setDetail(null);
        go("/");
      } else if (route.projectUuid === project.uuid) {
        setDetail(await api.project(project.uuid));
      }
      await refreshBase();
      setToast({ tone: "success", message });
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  async function deleteProject(project: ProjectSnapshot) {
    setBusy(true);
    try {
      await api.deleteProject(project.uuid);
      setDeleteProjectConfirm(null);
      setProjects((current) => current.filter((entry) => entry.uuid !== project.uuid));
      setArchivedProjects((current) => current.filter((entry) => entry.uuid !== project.uuid));
      if (route.projectUuid === project.uuid) {
        setDetail(null);
        go("/");
      }
      await refreshBase();
      setToast({ tone: "success", message: `${project.name} deleted.` });
    } catch (error) {
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    } finally {
      setBusy(false);
    }
  }

  async function reorderProjects(uuids: string[]) {
    const rank = new Map(uuids.map((uuid, index) => [uuid, index]));
    setProjects((current) => [...current].sort((a, b) => (rank.get(a.uuid) ?? current.length) - (rank.get(b.uuid) ?? current.length)));
    try {
      await api.reorderProjects(uuids);
      await refreshBase();
    } catch (error) {
      await refreshBase().catch(() => undefined);
      setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  function openRunLog(run: RunRow) {
    setLogRun(run);
    setModal("run-log");
  }

  return (
    <>
      <ShellHeader
        route={route}
        running={latestRunning}
        onTheme={() => {
          localStorage.setItem("flounder-theme-explicit", "1");
          setTheme(theme === "dark" ? "light" : "dark");
        }}
        onCommands={() => setCmdOpen(true)}
        onMenu={() => setMobileMenuOpen(true)}
        theme={theme}
      />
      <StorageWarningBanner />
      {mobileMenuOpen ? <MobileMenu route={route} running={latestRunning} theme={theme} onClose={() => setMobileMenuOpen(false)} onTheme={() => {
        localStorage.setItem("flounder-theme-explicit", "1");
        setTheme(theme === "dark" ? "light" : "dark");
      }} /> : null}
      <div className={`app-shell view-${route.view}${route.projectUuid ? " has-project" : ""}${route.evaluationUuid ? " has-evaluation" : ""}`}>
        {route.view === "projects" ? (
          <>
            <ProjectSidebar
              projects={sidebarProjects}
              total={projectsTotal}
              query={projectQuery}
              statusFilter={projectStatusFilter}
              statusCounts={projectStatusCounts}
              loading={projectLoading}
              selected={route.projectUuid}
              onNew={() => setModal("new-project")}
              onSelect={(uuid) => go(projectPath(uuid))}
              onQuery={setProjectQuery}
              onStatusFilter={setProjectStatusFilter}
              onLoadMore={() => void loadProjectPage(true)}
              onUpdate={(project, body, message) => void updateProjectDisplay(project, body, message)}
              onDeleteRequest={setDeleteProjectConfirm}
              onReorder={(uuids) => void reorderProjects(uuids)}
            />
            <main className="workspace">
              {detail && selectedProjectForDetail ? (
                <ProjectDetailView
                  project={selectedProjectForDetail}
                  detail={detail}
                  providers={providers}
                  daemons={daemons}
                  tab={projectTab}
                  setTab={setProjectTab}
                  findingQuery={projectFindingQuery}
                  setFindingQuery={setProjectFindingQuery}
                  findingStatus={projectFindingStatus}
                  setFindingStatus={setProjectFindingStatus}
                  busy={busy}
                  onLaunch={requestLaunch}
                  onOpenRunModal={() => setModal("run")}
                  onOpenEdit={() => setModal("edit-project")}
                  onOpenReport={(finding) => {
                    setReportFinding(finding);
                    setModal("report");
                  }}
                  onOpenDecisionReport={(decision) => {
                    setReportDecision(decision);
                    setModal("decision-report");
                  }}
                  onOpenArtifact={(artifact) => {
                    setArtifactPreview(artifact);
                    setModal("artifact");
                  }}
                  onTracking={updateTracking}
                  onPatchScope={patchScope}
                  onPatchBacklog={patchBacklog}
                  onStopRun={setStopConfirmRun}
                  onUpdateRunTarget={(run, body) => void updateRunTarget(run, body)}
                  onOpenRunLog={openRunLog}
                />
              ) : projects.length || projectsTotal > 0 || projectQuery.trim() || projectStatusFilter !== "all" ? (
                <EmptyState
                  title={emptyProjectListTitle}
                  body={emptyProjectListBody}
                  action={<Button variant="primary" icon="package" onClick={() => setModal("new-project")}>New project</Button>}
                />
              ) : (
                <FirstRunGuide providers={providers} daemons={daemons} onNewProject={() => setModal("new-project")} />
              )}
            </main>
          </>
        ) : null}
        {route.view === "evaluations" ? (
          <EvaluationsWorkspace
            selectedUuid={route.evaluationUuid}
            providers={providers}
            daemons={daemons}
            maintainerMode={maintainerMode}
            onSelect={(uuid) => go(uuid ? `/evaluations/${encodeURIComponent(uuid)}` : "/evaluations")}
            onToast={(tone, message) => setToast({ tone, message })}
          />
        ) : null}
        {route.view === "findings" ? (
          <GlobalFindingsView
            stats={bugStats}
            projects={[...projects, ...archivedProjects]}
            findings={bugs}
            total={bugsTotal}
            page={Math.min(bugPage, bugPageCount)}
            pageSize={bugPageSize}
            loading={bugLoading}
            error={bugError}
            projectUuid={bugProject}
            source={bugSource}
            status={bugStatus}
            tracking={bugTracking}
            setProjectUuid={setBugProject}
            setSource={(source) => {
              setBugSource(source);
              if (source !== "project") setBugProject("");
              setBugTracking(source === "evaluation" ? "" : "active");
            }}
            setStatus={setBugStatus}
            setTracking={setBugTracking}
            setPage={setBugPage}
            setPageSize={setBugPageSize}
            onTracking={updateTracking}
            onOpenProject={(uuid) => go(projectPath(uuid))}
            onOpenEvaluation={(uuid) => go(`/evaluations/${encodeURIComponent(uuid)}`)}
            onOpenReport={(finding) => {
              setReportFinding(finding);
              setModal("report");
            }}
          />
        ) : null}
        {route.view === "settings" ? (
          <SettingsView
            pane={route.settingsPane}
            providers={providers}
            daemons={daemons}
            archivedProjects={archivedProjects}
            archivedTotal={archivedProjectsTotal}
            archivedLoading={archivedProjectLoading}
            onRefresh={refreshBase}
            onUnarchive={(project) => void updateProjectDisplay(project, { archived: false }, `${project.name} restored.`)}
            onDeleteRequest={setDeleteProjectConfirm}
            onLoadMoreArchived={() => void loadArchivedProjectPage(true)}
          />
        ) : null}
      </div>
      {cmdOpen ? <CommandPalette projects={projects} currentProjectUuid={route.projectUuid} onClose={() => setCmdOpen(false)} onNewProject={() => setModal("new-project")} onLaunch={() => requestLaunch("run")} /> : null}
      {modal === "new-project" ? (
        <NewProjectModal
          providers={providers}
          daemons={daemons}
          onClose={() => setModal(null)}
          onCreated={async (uuid, runAfterCreate) => {
            await refreshBase();
            setModal(null);
            go(projectPath(uuid));
            if (runAfterCreate) {
              setBusy(true);
              try {
                const result = (await api.launchRun(uuid, { verb: "run", pipeline: true })) as LaunchResult;
                const waiting = (result.daemons ?? 0) === 0;
                const waitingForProject = result.queueReason === "project-run-active";
                setToast({
                  tone: waiting || waitingForProject ? "warning" : "success",
                  message: waitingForProject
                    ? result.message ?? "run queued behind another run for this project and will start automatically when it finishes."
                    : waiting
                    ? "run queued, but no online daemon is connected. Start a daemon to claim the job."
                    : `run queued for ${plural(result.daemons ?? 0, "daemon")}.`,
                });
                const [nextDetail] = await Promise.all([api.project(uuid), refreshBase()]);
                setDetail(nextDetail);
              } catch (error) {
                setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) });
              } finally {
                setBusy(false);
              }
            }
          }}
          onError={(message) => setToast({ tone: "error", message })}
        />
      ) : null}
      {modal === "run" && currentDetailForModal ? <RunModal detail={currentDetailForModal} busy={busy} onClose={() => setModal(null)} onLaunch={requestLaunch} onUpdateRunTarget={(run, body) => void updateRunTarget(run, body)} onError={(message) => setToast({ tone: "error", message })} /> : null}
      {modal === "edit-project" && detail ? <EditProjectModal detail={detail} providers={providers} daemons={daemons} onClose={() => setModal(null)} onSaved={async () => { setDetail(await api.project(detail.project.uuid)); setModal(null); }} onError={(message) => setToast({ tone: "error", message })} /> : null}
      {modal === "report" && reportFinding ? <ReportModal finding={reportFinding} onClose={() => setModal(null)} /> : null}
      {modal === "decision-report" && reportDecision ? <DecisionReportModal decision={reportDecision} onClose={() => setModal(null)} /> : null}
      {modal === "artifact" && artifactPreview ? <ArtifactModal artifact={artifactPreview} onClose={() => { setModal(null); setArtifactPreview(null); }} /> : null}
      {modal === "run-log" && logRun ? <RunLogModal run={logRun} onClose={() => { setModal(null); setLogRun(null); }} /> : null}
      {stopConfirmRun ? (
        <StopRunConfirmModal
          run={stopConfirmRun}
          busy={busy}
          onCancel={() => setStopConfirmRun(null)}
          onConfirm={() => void stopRun(stopConfirmRun)}
        />
      ) : null}
      {launchConfirmAction && currentDetailForModal ? (
        <LaunchConfirmModal
          action={launchConfirmAction}
          detail={currentDetailForModal}
          busy={busy}
          onCancel={() => setLaunchConfirmAction(null)}
          onConfirm={(selectedFindings) => {
            const action = launchConfirmAction;
            setLaunchConfirmAction(null);
            void launch(action, selectedFindings);
          }}
        />
      ) : null}
      {deleteProjectConfirm ? (
        <DeleteProjectConfirmModal
          project={deleteProjectConfirm}
          busy={busy}
          onCancel={() => setDeleteProjectConfirm(null)}
          onConfirm={() => void deleteProject(deleteProjectConfirm)}
        />
      ) : null}
      {toast ? <ToastView toast={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

function ShellHeader({ route, running, theme, onTheme, onCommands, onMenu }: { route: RouteState; running: number; theme: string; onTheme: () => void; onCommands: () => void; onMenu: () => void }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => go("/")} aria-label="Go to projects">
        <img className="brand-logo" src={theme === "dark" ? "/flounder-white.png" : "/flounder-black.png"} alt="Flounder" />
      </button>
      <nav className="topnav desktop-nav" aria-label="Primary">
        <button className={route.view === "projects" ? "sel" : ""} onClick={() => go(route.projectUuid ? projectPath(route.projectUuid) : "/")}>Projects</button>
        <button className={route.view === "findings" ? "sel" : ""} onClick={() => go("/findings")}>Findings</button>
        <button className={route.view === "evaluations" ? "sel" : ""} onClick={() => go(route.evaluationUuid ? `/evaluations/${encodeURIComponent(route.evaluationUuid)}` : "/evaluations")}>Evaluations</button>
      </nav>
      <div className="topbar-spacer" />
      {running > 0 ? <Counter live>{`${running} running`}</Counter> : null}
      <IconButton icon="search" title="Commands (Cmd-K)" aria-label="Commands" onClick={onCommands} />
      <IconButton className="desktop-tool" icon="gear" title="Settings" aria-label="Settings" selected={route.view === "settings"} onClick={() => go("/settings")} />
      <IconButton className="desktop-tool" icon={theme === "dark" ? "sun" : "moon"} title="Toggle theme" aria-label="Toggle theme" onClick={onTheme} />
      <IconButton className="mobile-menu-button" icon="menu" title="Menu" aria-label="Menu" onClick={onMenu} />
    </header>
  );
}

function MobileMenu({ route, running, theme, onClose, onTheme }: { route: RouteState; running: number; theme: string; onClose: () => void; onTheme: () => void }) {
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const navigate = (pathname: string) => {
    go(pathname);
    onClose();
  };
  return (
    <div className="mobile-menu-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown} className="mobile-menu" role="dialog" aria-modal="true" aria-label="Navigation menu">
        <div className="mobile-menu-head">
          <strong>Menu</strong>
          <IconButton icon="x" title="Close" aria-label="Close menu" onClick={onClose} />
        </div>
        {running > 0 ? <Counter live>{`${running} running`}</Counter> : null}
        <button className={route.view === "projects" ? "sel" : ""} onClick={() => navigate(route.projectUuid ? projectPath(route.projectUuid) : "/")}>Projects</button>
        <button className={route.view === "findings" ? "sel" : ""} onClick={() => navigate("/findings")}>Findings</button>
        <button className={route.view === "evaluations" ? "sel" : ""} onClick={() => navigate(route.evaluationUuid ? `/evaluations/${encodeURIComponent(route.evaluationUuid)}` : "/evaluations")}>Evaluations</button>
        <button className={route.view === "settings" ? "sel" : ""} onClick={() => navigate("/settings")}>Settings</button>
        <button onClick={() => { onTheme(); onClose(); }}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
      </section>
    </div>
  );
}

function ProjectSidebar({
  projects,
  total,
  query,
  statusFilter,
  statusCounts,
  loading,
  selected,
  onSelect,
  onNew,
  onQuery,
  onStatusFilter,
  onLoadMore,
  onUpdate,
  onDeleteRequest,
  onReorder,
}: {
  projects: ProjectSnapshot[];
  total: number;
  query: string;
  statusFilter: ProjectStatusFilter;
  statusCounts: ProjectStatusCounts;
  loading: boolean;
  selected?: string;
  onSelect: (uuid: string) => void;
  onNew: () => void;
  onQuery: (query: string) => void;
  onStatusFilter: (status: ProjectStatusFilter) => void;
  onLoadMore: () => void;
  onUpdate: (project: ProjectSnapshot, body: ProjectPayload, message: string) => void;
  onDeleteRequest: (project: ProjectSnapshot) => void;
  onReorder: (uuids: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const visibleTotal = Math.max(total, projects.length);
  const hasMore = projects.length < visibleTotal;
  const canReorder = !query.trim() && statusFilter === "all" && projects.length > 1 && projects.length >= visibleTotal;
  const activeStatus = PROJECT_STATUS_OPTIONS.find((option) => option.value === statusFilter) ?? PROJECT_STATUS_OPTIONS[0];
  const activeStatusCount = statusCounts[statusFilter] ?? 0;
  const emptyMessage = (() => {
    if (query.trim()) return "No active projects match this search.";
    if (statusFilter === "running") return "No running projects.";
    if (statusFilter === "needs-work") return "No projects need work.";
    if (statusFilter === "done") return "No completed projects.";
    if (statusFilter === "failed") return "No failed projects.";
    if (statusFilter === "not-started") return "No new projects.";
    return "No active projects.";
  })();
  useEffect(() => {
    if (!openMenu) return undefined;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-project-menu]")) return;
      setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);
  function dropProject(targetUuid: string) {
    if (!dragging || dragging === targetUuid || !canReorder) {
      setDragging(null);
      return;
    }
    const uuids = projects.map((project) => project.uuid);
    const from = uuids.indexOf(dragging);
    const to = uuids.indexOf(targetUuid);
    if (from < 0 || to < 0) {
      setDragging(null);
      return;
    }
    const next = [...uuids];
    const [moved] = next.splice(from, 1);
    if (!moved) {
      setDragging(null);
      return;
    }
    next.splice(to, 0, moved);
    setDragging(null);
    onReorder(next);
  }
  return (
    <aside className="project-rail" aria-label="Projects">
      <div className="rail-head">
        <div>
          <h2>Projects</h2>
          <Counter>{visibleTotal > projects.length ? `${projects.length}/${visibleTotal}` : visibleTotal}</Counter>
        </div>
        <Button variant={projects.length ? "primary" : undefined} icon="package" onClick={onNew}>New project</Button>
      </div>
      <div className="project-search-row">
        <input className="searchbar" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search projects..." aria-label="Search projects" />
        <IconButton
          icon="filter"
          className="project-filter-button"
          selected={filterOpen || statusFilter !== "all"}
          aria-expanded={filterOpen}
          aria-controls="project-status-filter"
          title={statusFilter === "all" ? "Advanced filters" : `Filtering by ${activeStatus.label} (${activeStatusCount})`}
          aria-label={statusFilter === "all" ? "Advanced project filters" : `Project status filter: ${activeStatus.label} (${activeStatusCount})`}
          onClick={() => setFilterOpen((open) => !open)}
        />
      </div>
      {!filterOpen && statusFilter !== "all" ? (
        <div className="project-active-filter">
          <span>{activeStatus.label}</span>
          <span>{activeStatusCount}</span>
          <IconButton
            icon="x"
            className="project-filter-clear"
            title="Clear project status filter"
            aria-label="Clear project status filter"
            onClick={() => {
              onStatusFilter("all");
              setFilterOpen(false);
            }}
          />
        </div>
      ) : null}
      {filterOpen ? (
        <div id="project-status-filter" className="project-status-filter" role="tablist" aria-label="Project status filter">
          {PROJECT_STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={statusFilter === option.value}
              className={statusFilter === option.value ? "sel" : ""}
              onClick={() => {
                onStatusFilter(option.value);
                setFilterOpen(false);
              }}
            >
              <span>{option.label}</span>
              <span>{statusCounts[option.value] ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="project-rail-pager" aria-live="polite">
        <span>Showing {projects.length} of {visibleTotal}</span>
        {hasMore ? (
          <Button size="sm" icon="sync" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading..." : `Load ${Math.min(PROJECT_PAGE_SIZE, visibleTotal - projects.length)} more`}
          </Button>
        ) : null}
      </div>
      <ul className="project-list" role="list">
        {projects.map((project) => (
          <li
            key={project.uuid}
            onDragOver={(event) => {
              if (canReorder && dragging && dragging !== project.uuid) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              dropProject(project.uuid);
            }}
            onDragEnd={() => setDragging(null)}
          >
            <div
              className={`project-row${selected === project.uuid ? " sel" : ""}${dragging === project.uuid ? " dragging" : ""}${(project.progress?.total ?? 0) > 0 ? " has-progress-meter" : ""}`}
              draggable={canReorder}
              onDragStart={(event) => {
                const target = event.target;
                if (!canReorder || (target instanceof Element && target.closest("[data-project-menu]"))) {
                  event.preventDefault();
                  return;
                }
                setOpenMenu(null);
                setDragging(project.uuid);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", project.uuid);
              }}
            >
            <button
              type="button"
              className="project-row-main"
              aria-current={selected === project.uuid ? "page" : undefined}
              aria-label={`Open project ${project.name}. ${projectStatusTitle(project)}`}
              onClick={() => onSelect(project.uuid)}
            >
              <span className="project-row-top">
                <span className="project-name">{shortName(project.name, 31)}</span>
                {bugBountyEngagementLabel(project.config) ? <span className="project-type-badge">{bugBountyEngagementLabel(project.config)}</span> : null}
                {project.pinned_at ? <span className="project-pin-indicator" title="Pinned"><Icon name="pin" size={13} /></span> : null}
                <ProjectStatusIcon project={project} />
              </span>
              <ProjectProgress project={project} />
            </button>
              <span className="project-row-actions">
                <span className="project-action-menu" data-project-menu>
                  <IconButton
                    className="project-mini-action"
                    icon="kebab"
                    title="Project actions"
                    aria-label={`Project actions for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === project.uuid}
                    onClick={() => setOpenMenu(openMenu === project.uuid ? null : project.uuid)}
                  />
                  {openMenu === project.uuid ? (
                    <span className="project-action-popover" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenu(null);
                          onUpdate(project, { pinned: !project.pinned_at }, project.pinned_at ? `${project.name} unpinned.` : `${project.name} pinned.`);
                        }}
                      >
                        <Icon name="pin" size={14} />
                        <span>{project.pinned_at ? "Unpin" : "Pin"}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenu(null);
                          onUpdate(project, { archived: true }, `${project.name} archived.`);
                        }}
                      >
                        <Icon name="archive" size={14} />
                        <span>Archive</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setOpenMenu(null);
                          onDeleteRequest(project);
                        }}
                      >
                        <Icon name="trash" size={14} />
                        <span>Delete</span>
                      </button>
                    </span>
                  ) : null}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {projects.length === 0 ? <div className="project-list-empty">{emptyMessage}</div> : null}
      {hasMore ? (
        <div className="project-rail-more">
          <Button size="sm" icon="sync" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading..." : `Load more (${visibleTotal - projects.length})`}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

function ProjectStatusIcon({ project }: { project: ProjectSnapshot }) {
  const status = projectBadgeStatus(project) ?? "none";
  const title = projectStatusTitle(project);
  return (
    <span className={`project-status-icon ${status}`} title={title} aria-hidden="true">
      <Icon name={projectStatusIcon(project)} size={14} />
    </span>
  );
}

function ProjectProgress({ project }: { project: ProjectSnapshot }) {
  const total = project.progress?.total ?? 0;
  const audited = project.progress?.audited ?? 0;
  const confirmed = totalConfirmed(project);
  const reproduced = project.reproducedBugs ?? project.confirmedBugs ?? 0;
  const suspected = statusCount(project, "suspected");
  const confirmPending = project.confirmPendingFindings ?? 0;
  return (
    <span className="project-progress">
      {total > 0 ? <span className="mini-progress"><span style={{ width: `${pct(audited, total)}%` }} /></span> : null}
      <span className="project-progress-line">
        <span className="muted">{total > 0 ? `${audited}/${total} scopes` : `${project.findingsTotal ?? 0} findings`}</span>
        {reproduced > 0 ? <span className="good">{reproduced} reproduced</span> : null}
        {confirmed > 0 ? <span>{confirmed} verified</span> : null}
        {confirmPending > 0 ? <span>{confirmPending} confirm pending</span> : null}
        {suspected > 0 ? <span className="muted">{suspected} suspected</span> : null}
      </span>
    </span>
  );
}

function ProjectDetailView(props: {
  project: ProjectSnapshot;
  detail: ProjectDetail;
  providers: ProviderProfile[];
  daemons: DaemonRow[];
  tab: ProjectTab;
  setTab: (tab: ProjectTab) => void;
  findingQuery: string;
  setFindingQuery: (query: string) => void;
  findingStatus: string;
  setFindingStatus: (status: string) => void;
  busy: boolean;
  onLaunch: (action: LaunchAction) => void;
  onOpenRunModal: () => void;
  onOpenEdit: () => void;
  onOpenReport: (finding: FindingRow) => void;
  onOpenDecisionReport: (decision: ConfirmDecision) => void;
  onOpenArtifact: (artifact: ArtifactPreview) => void;
  onTracking: (finding: FindingRow, status: string) => void;
  onPatchScope: (scopeId: string, body: unknown) => Promise<void> | void;
  onPatchBacklog: (id: number, status: string) => Promise<void> | void;
  onStopRun: (run: RunRow) => void;
  onUpdateRunTarget: (run: RunRow, body: RunUpdatePayload) => void;
  onOpenRunLog: (run: RunRow) => void;
}) {
  const { project, detail, providers, daemons, tab, setTab } = props;
  const provider = providers.find((p) => p.id === detail.project.provider_id);
  const selectedDaemon = daemons.find((daemon) => daemon.id === detail.project.daemon_id);
  const config = projectConfig(detail);
  const contestProfile = contestStrategy(config.cfg);
  const engagementLabel = bugBountyEngagementLabel(config.cfg);
  const selectedDaemonOnline = selectedDaemon ? daemonHealth(selectedDaemon) === "online" : false;
  const online = selectedDaemonOnline ? [selectedDaemon] : [];
  const progress = currentMaterialProgress(detail);
  const allFindings = currentMaterialFindings(detail);
  const confirmDecisions = currentMaterialConfirmDecisions(detail);
  const materialRefreshActive = materialRefreshInProgress(detail.material);
  const currentDetail = currentMaterialDetail(detail);
  const phases = phaseState(currentDetail, progress);
  const contestReview = contestReviewState(currentDetail, config.cfg);
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const coverageHealth = currentRuns.find((run) => run.kind === "run" || run.kind === "map" || run.kind === "audit")?.runHealth ?? null;
  const topCandidates = topCandidateFindings(allFindings);
  const verifyCandidates = pendingVerifyFindings(allFindings);
  const overviewCandidates = verifyCandidates.length ? verifyCandidates : topCandidates;
  const locallyVerifiedRows = localVerifiedFindings(allFindings);
  const confirmed = locallyVerifiedRows.length;
  const uniqueConfirmed = locallyVerifiedRows.filter((finding) =>
    finding.tracking_status !== "duplicate"
    && finding.tracking_status !== "ignored").length;
  const reproduced = confirmedDecisions(confirmDecisions).length;
  const runningRun = currentRuns.find((run) => run.status === "running");
  const runningVerify = isVerifyRun(runningRun) ? runningRun : undefined;
  const runningVerifyProgress = verifyRunProgress(runningVerify);
  const hasPipelineRun = detail.runs.some((run) => run.kind === "run");
  const pipelineActionDetail = pipelineRunActionDetail(currentDetail, hasPipelineRun);
  const runningInactive = runningRun ? runInactiveLabel(runningRun) : null;
  const [activityReadWatermarks, setActivityReadWatermarks] = useState<Record<string, string>>(() => readStoredStringMap(ACTIVITY_READ_WATERMARKS_KEY));
  const [setupReadWatermarks, setSetupReadWatermarks] = useState<Record<string, string>>(() => readStoredStringMap(SETUP_READ_WATERMARKS_KEY));
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  const rawPendingVerify = rawPendingVerifyCount(allFindings);
  const needsEvidenceCount = activeFindings(allFindings).filter((finding) => finding.status === "needs-evidence").length;
  const verifyRechecksConfirmed = verifyRunRechecksConfirmed(runningVerify, rawPendingVerify, activeFindings(allFindings).length);
  const pendingConfirmBase = pendingConfirmFindings(allFindings, requiresConfirmation, confirmDecisions).length;
  const pendingConfirm = verifyRechecksConfirmed ? 0 : pendingConfirmBase;
  const pendingVerify = runningVerifyProgress ? runningVerifyProgress.remaining : verifyCandidates.length;
  const pendingReports = requiresConfirmation ? pendingDecisionReports(confirmDecisions, allFindings).length : pendingFormalReports(allFindings, requiresConfirmation).length;
  const locallyVerified = localVerifiedFindings(allFindings).length;
  const displayedVerified = runningVerifyProgress ? runningVerifyProgress.done : locallyVerified;
  const reportsReady = requiresConfirmation
    ? reportableDecisions(confirmDecisions, allFindings).filter((decision) => decision.has_report).length
    : reportableFindings(allFindings, requiresConfirmation).filter((finding) => finding.has_report).length;
  const reportStat = pendingReports > 0 ? pendingReports : reportsReady;
  const reportLabel = pendingReports > 0 ? "to report" : "reports";
  const candidateStat = pendingVerify > 0 ? pendingVerify : needsEvidenceCount > 0 ? needsEvidenceCount : overviewCandidates.length;
  const candidateLabel = pendingVerify > 0 ? "to verify" : needsEvidenceCount > 0 ? "need evidence" : "top findings";
  const currentRoundWorkPending = rawPendingVerify > 0 || pendingConfirmBase > 0 || pendingReports > 0;
  const currentRoundComplete = hasPipelineRun && !currentRoundWorkPending && pipelineCoverageRoundComplete(currentDetail);
  const localVerifySummary = activeVerifySummary(runningVerify) || verifyStatusSummary(allFindings);
  const setupAttention = prepareMaterialsAttention(detail.prepareSummary);
  const sandboxStatus = daemonSandboxStatus(selectedDaemon);
  const setupAttentionSignals = [
    ...(setupAttention ? [{ tone: setupAttention.tone, label: setupAttention.label, signature: prepareAttentionSignature(detail.prepareSummary, setupAttention) }] : []),
    ...(sandboxStatus && !sandboxStatus.ok ? [{ tone: "warn" as const, label: sandboxStatus.state, signature: sandboxStatus.signature }] : []),
  ].filter((entry) => entry.signature);
  const setupAttentionDisplay = setupAttentionSignals.length
    ? {
      tone: setupAttentionSignals.some((entry) => entry.tone === "warn") ? "warn" as const : "pending" as const,
      label: setupAttentionSignals.length === 1 ? setupAttentionSignals[0]!.label : `${plural(setupAttentionSignals.length, "setup issue")} needs attention`,
    }
    : null;
  const setupAttentionSignature = setupAttentionSignals.length ? JSON.stringify(setupAttentionSignals) : "";
  const setupUnread = Boolean(
    setupAttentionDisplay
    && setupAttentionSignature
    && tab !== "setup"
    && setupReadWatermarks[project.uuid] !== setupAttentionSignature
  );
  const launchLocked = props.busy || Boolean(runningRun);
  const contestCanContinue = contestProfile.enabled && ((progress.pending ?? 0) > 0 || (progress.total ?? 0) === 0 || contestProfile.appendMapWhenExhausted);
  const runLaunchLocked = launchLocked || (currentRoundComplete && !contestCanContinue);
  const requiredProviders = requiredProviderProfiles(detail, providers);
  const authStatuses = requiredProviders.map((profile) => ({ profile, status: daemonHasProvider(selectedDaemon, profile.provider) }));
  const authUnknown = authStatuses.some((entry) => entry.status === null);
  const authMissing = authStatuses.filter((entry) => entry.status === false);
  const phaseOverrides = PROVIDER_PHASES
    .map((phase) => ({ phase, provider: phaseProvider(detail, providers, phase) }))
    .filter((entry) => entry.provider);
  const currentRunningRuns = currentRuns.filter((run) => run.status === "running").length;
  const sourceState = projectSourceState(detail, config.sourcePaths);
  const activityRunKey = runningRun ? `${project.uuid}:${runningRun.id}` : "";
  const activityWatermark = runningRun ? (runningRun.last_activity_at ?? runningRun.started_at ?? "") : "";
  const activityUnread = Boolean(
    runningRun
    && activityRunKey
    && activityWatermark
    && tab !== "activity"
    && (activityReadWatermarks[activityRunKey] ?? "") < activityWatermark
  );
  const openProjectSection = (nextTab: ProjectTab, sectionId?: string) => {
    setTab(nextTab);
    if (sectionId) window.setTimeout(() => scrollToProjectSection(sectionId), 0);
  };
  const openLinkedFinding = (finding: FindingRow) => {
    props.setFindingStatus("");
    props.setFindingQuery(`#${finding.id}`);
    openProjectSection("findings", "project-findings");
  };
  const openSetupTab = () => {
    openProjectSection("setup", "project-setup-tab");
  };
  useEffect(() => {
    if (tab !== "activity" || !activityRunKey || !activityWatermark) return;
    setActivityReadWatermarks((current) => {
      if (current[activityRunKey] === activityWatermark) return current;
      const next = pruneStringMap({ ...current, [activityRunKey]: activityWatermark });
      writeStoredStringMap(ACTIVITY_READ_WATERMARKS_KEY, next);
      return next;
    });
  }, [activityRunKey, activityWatermark, tab]);
  useEffect(() => {
    if (tab !== "setup" || !setupAttentionSignature) return;
    setSetupReadWatermarks((current) => {
      if (current[project.uuid] === setupAttentionSignature) return current;
      const next = pruneStringMap({ ...current, [project.uuid]: setupAttentionSignature });
      writeStoredStringMap(SETUP_READ_WATERMARKS_KEY, next);
      return next;
    });
  }, [project.uuid, setupAttentionSignature, tab]);
  const currentProject: ProjectSnapshot = {
    ...project,
    progress,
    findingCounts: materialRefreshActive ? {} : detail.statusCounts,
    findingsTotal: allFindings.length,
    auditConfirmedFindings: confirmed,
    reproducedBugs: reproduced,
    confirmedBugs: requiresConfirmation ? reproduced : confirmed,
    verifyPendingFindings: pendingVerify,
    confirmPendingFindings: pendingConfirm,
    confirmDecisionCount: confirmDecisions.length,
    latestRun: currentRuns[0] ?? null,
    activeRuns: Math.max(project.activeRuns ?? 0, currentRunningRuns, materialRefreshActive ? 1 : 0),
    currentRunCount: detail.currentRunsTotal ?? currentRuns.length,
    material: detail.material,
  };
  const prepareClue = config.cfg.prepareClue?.trim() ?? "";
  const readyItems = [
    {
      label: "Daemon",
      state: selectedDaemon ? `${selectedDaemon.name ?? `daemon-${selectedDaemon.id}`} · ${relativeAge(selectedDaemon)}` : "No daemon selected",
      ok: selectedDaemonOnline,
      actionLabel: selectedDaemonOnline ? "View" : "Fix",
      onClick: selectedDaemon ? () => go("/settings/daemons") : props.onOpenEdit,
    },
    {
      label: "Provider auth",
      state: !provider
        ? "No default provider selected"
        : !selectedDaemon
          ? "Select a daemon to check auth"
          : authMissing.length
            ? `${authMissing.map((entry) => entry.profile.provider).join(", ")} not configured`
            : authUnknown
              ? "Daemon has not reported provider auth"
              : `${plural(requiredProviders.length, "provider")} ready on daemon`,
      ok: Boolean(provider && selectedDaemon && authMissing.length === 0 && !authUnknown),
      actionLabel: provider && selectedDaemon && authMissing.length === 0 && !authUnknown ? "View" : "Fix",
      onClick: !provider || !selectedDaemon ? props.onOpenEdit : () => go("/settings/daemons"),
    },
    ...(sandboxStatus ? [{
      label: "Sandbox",
      state: sandboxStatus.state,
      ok: sandboxStatus.ok,
      actionLabel: sandboxStatus.ok ? "View" : "Fix",
      onClick: () => go("/settings/daemons"),
      title: sandboxStatus.message,
    }] : []),
    { label: "Coverage", state: coverageLabel(config.cfg), ok: true, actionLabel: "Edit", onClick: props.onOpenEdit },
    {
      label: "Source",
      state: sourceState.kind === "configured" ? `${plural(config.sourcePaths.length, "path")}` : sourceState.kind === "prepared" ? "Prepared workspace" : "No source paths",
      ok: sourceState.ok,
      actionLabel: sourceState.ok ? "View" : "Fix",
      onClick: sourceState.ok ? openSetupTab : props.onOpenEdit,
    },
    ...(setupAttention ? [{
      label: "Prepared materials",
      state: setupAttention.label,
      ok: false,
      actionLabel: "Review",
      onClick: openSetupTab,
    }] : []),
  ] satisfies SetupDisclosureItem[];
  const prepareInfo = (() => {
    if (runningRun?.kind === "prepare" && online.length === 0) {
      return {
        stat: "Waiting for daemon",
        detail: "Stage source, match target, warm sandbox",
      };
    }
    if (phases.prepare.status === "none" && (config.sourcePaths.length || config.buildRoot)) {
      return {
        stat: "Source configured",
        detail: "Use configured source and build root for map",
      };
    }
    return {
      stat: phases.prepare.stat,
      detail: "Stage source, match target, warm sandbox",
    };
  })();
  const phaseDisplayStatus = (phase: ProjectPhase) => {
    if (phase === "prepare" && phases.prepare.status === "none" && (config.sourcePaths.length || config.buildRoot)) return "ready";
    return phases[phase].status;
  };
  const jumpToPhase = (phase: ProjectPhase) => {
    if (phase === "prepare") {
      openProjectSection("setup", "project-setup-tab");
      return;
    }
    if (phase === "map") {
      openProjectSection("scopes");
      return;
    }
    if (phase === "dig" || phase === "verify") {
      openProjectSection("overview", "project-top-candidates");
      return;
    }
    if (phase === "synthesis") {
      openProjectSection("overview", "project-audit-status");
      return;
    }
    if (phase === "confirm" || phase === "report") {
      openProjectSection("decisions", "project-real-target-decisions");
      return;
    }
    openProjectSection("overview", "project-setup");
  };
  return (
    <div className="project-page">
      <Card>
        <div className="project-hero">
          <div className="hero-main">
            <div className="title-line">
              <h1>{detail.project.name}</h1>
              {engagementLabel ? <span className="project-type-badge hero-badge">{engagementLabel}</span> : null}
              <StateBadge status={projectBadgeStatus(currentProject)} />
            </div>
            <div className="subtle-line">
              {provider ? providerProfileLabel(provider) : "no provider set"} · {selectedDaemon ? selectedDaemon.name ?? `daemon-${selectedDaemon.id}` : "no daemon selected"} · {detail.project.dir || detail.project.name}
            </div>
            {engagementLabel ? (
              <div className="subtle-line contest-summary">
                {contestProfile.enabled
                  ? `${contestProfile.batchScopes} scopes/round · ${contestProfile.digConcurrency} parallel digs · ${contestProfile.skipRealTargetConfirm ? "source-only reports" : "real-target confirm required"}${contestProfile.stopAfterHours ? ` · review after ${contestProfile.stopAfterHours}h` : ""}`
                  : "standard coverage · real-target confirm required · report after reproduction"}
              </div>
            ) : null}
            {localVerifySummary ? <div className="subtle-line verify-summary">{localVerifySummary}</div> : null}
            {phaseOverrides.length ? (
              <div className="subtle-line phase-summary">
                {phaseOverrides.map((entry) => `${phaseLabel(entry.phase)}: ${entry.provider?.name}`).join(" · ")}
              </div>
            ) : null}
          </div>
          <div className="hero-actions">
            <Button
              variant="primary"
              icon="play"
              disabled={runLaunchLocked}
              title={runningRun ? "A run is already active for this project." : pipelineActionDetail}
              onClick={() => props.onLaunch("run")}
            >
              {runningRun ? "Running" : hasPipelineRun ? "Continue" : "Run"}
            </Button>
            {runningRun ? <Button variant="danger" icon="x" onClick={() => props.onStopRun(runningRun)}>Stop</Button> : null}
            <IconButton
              icon="kebab"
              title={runningRun ? "Run settings" : "More actions"}
              aria-label={runningRun ? "Run settings" : "More actions"}
              onClick={props.onOpenRunModal}
            />
            <IconButton icon="pencil" title="Edit config" aria-label="Edit config" onClick={props.onOpenEdit} />
          </div>
        </div>
        {runningRun ? (
          <div className={`info-panel run-notice${runningInactive ? " stale" : ""}`}>
            <strong>
              {runningInactive
                ? `${runKindLabel(runningRun.kind, runningRun)} has no recent activity.`
                : online.length
                  ? `${runKindLabel(runningRun.kind, runningRun)} is running.`
                  : `${runKindLabel(runningRun.kind, runningRun)} is waiting for a daemon.`}
            </strong>
            <span>
              {runningInactive
                ? `Last activity was ${runningInactive} ago. Stop the run if the daemon is no longer making progress.`
                : online.length
                  ? "New launches are locked until this run finishes or you stop it."
                : "No daemon is online, so the run may be stalled until an executor reconnects."} Current progress: {runProgress(runningRun, confirmDecisions)}.
            </span>
          </div>
        ) : null}
        {contestReview ? (
          <div className={`info-panel contest-review ${contestReview.tone}`}>
            <strong>{contestReview.label}</strong>
            <span>{contestReview.detail}</span>
          </div>
        ) : null}
        <div className="pipeline" aria-label="Audit pipeline">
          {PHASES.map((phase, index) => {
            const displayStatus = phaseDisplayStatus(phase);
            const label = phaseLabel(phase);
            const footer = phases[phase].dur || phaseStatusLabel(displayStatus);
            const stat = phase === "prepare" ? prepareInfo.stat : phases[phase].stat;
            const detailText = phase === "prepare"
              ? prepareInfo.detail
              : phase === "confirm" && !requiresConfirmation
                ? "Skipped for source-only local evidence"
                : PHASE_DESC[phase];
            return (
              <button key={phase} type="button" className={`phase ${displayStatus}`} onClick={() => jumpToPhase(phase)} title={`Open ${label} output`}>
                <span className="phase-head">
                  <span className="phase-title">
                    <span className="phase-index">{index + 1}</span>
                    <span className="phase-marker"><Icon name={phaseIcon(phase)} size={13} /></span>
                    {label}
                  </span>
                  <span className={`phase-state ${displayStatus}`} title={phaseStatusLabel(displayStatus)} aria-label={phaseStatusLabel(displayStatus)}>
                    <Icon name={phaseStatusIcon(displayStatus)} size={12} />
                  </span>
                </span>
                <strong title={stat}>{stat}</strong>
                <small className="phase-detail">
                  <span title={detailText}>{detailText}</span>
                  <span className="phase-time" title={footer}>{footer}</span>
                </small>
              </button>
            );
          })}
        </div>
        <div className="stats">
          <Stat n={progress.total} label="mapped" onClick={() => openProjectSection("scopes")} />
          <Stat n={progress.audited} label="audited" onClick={() => openProjectSection("scopes")} />
          <Stat n={candidateStat} label={candidateLabel} onClick={() => { props.setFindingStatus(""); props.setFindingQuery(""); openProjectSection("overview", "project-top-candidates"); }} />
          <Stat n={displayedVerified} label={runningVerifyProgress ? "checked" : "verified"} good onClick={() => { props.setFindingStatus("execution-confirmed"); props.setFindingQuery(""); openProjectSection("findings", "project-findings"); }} />
          <Stat n={reproduced} label="reproduced" onClick={() => openProjectSection("decisions", "project-real-target-decisions")} />
          <Stat n={reportStat} label={reportLabel} onClick={() => openProjectSection("decisions", "project-real-target-decisions")} />
        </div>
        <CoverageQualityStrip
          progress={progress}
          findings={allFindings}
          confirmedBugs={requiresConfirmation ? reproduced : uniqueConfirmed}
          health={coverageHealth}
          configuredMapSamples={config.cfg.mapSamples ?? 1}
          resourceRequests={detail.backlogCounts?.["resource-request"] ?? 0}
        />
        <RealTargetCallout decisions={confirmDecisions} findings={allFindings} onOpen={() => openProjectSection("decisions", "project-real-target-decisions")} />
        <ProjectSetupDisclosure items={readyItems} clue={prepareClue} />
      </Card>
      <div className="tabs" role="tablist" aria-label="Project sections">
        {PROJECT_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "sel" : ""}
            title={t.id === "setup" && setupAttentionDisplay ? (setupUnread ? setupAttentionDisplay.label : "Setup attention reviewed") : t.id === "activity" && runningRun ? (activityUnread ? `New activity in ${runKindLabel(runningRun.kind, runningRun)}` : `${runKindLabel(runningRun.kind, runningRun)} is running`) : undefined}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
            {t.id === "decisions" && confirmDecisions.length ? <Counter>{confirmDecisions.length}</Counter> : null}
            {t.id === "activity" && activityUnread ? <span className="tab-alert-dot pending" aria-label="New activity" /> : null}
            {t.id === "setup" && setupAttentionDisplay && setupUnread ? <span className={`tab-alert-dot ${setupAttentionDisplay.tone}`} aria-label="Setup attention" /> : null}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <ProjectOverview
          detail={currentDetail}
          candidates={overviewCandidates}
          verifyCount={pendingVerify}
          verifyLocked={launchLocked || pendingVerify === 0}
          onVerifyCandidates={() => props.onLaunch("verify")}
          onOpenReport={props.onOpenReport}
          onOpenDecisionReport={props.onOpenDecisionReport}
          onOpenDecisions={() => openProjectSection("decisions", "project-real-target-decisions")}
          onOpenActivity={() => openProjectSection("activity")}
        />
      ) : null}
      {tab === "next-actions" ? (
        <NextActionsView
          detail={currentDetail}
          onLaunch={props.onLaunch}
          onPatchScope={props.onPatchScope}
          onPatchBacklog={props.onPatchBacklog}
        />
      ) : null}
      {tab === "decisions" ? <ProjectDecisions detail={currentDetail} onOpenFinding={openLinkedFinding} onOpenDecisionReport={props.onOpenDecisionReport} /> : null}
      {tab === "findings" ? (
        <ProjectFindings
          detail={currentDetail}
          query={props.findingQuery}
          setQuery={props.setFindingQuery}
          status={props.findingStatus}
          setStatus={props.setFindingStatus}
          onOpenReport={props.onOpenReport}
          onTracking={props.onTracking}
        />
      ) : null}
      {tab === "scopes" ? <ScopesView detail={currentDetail} onPatchScope={props.onPatchScope} /> : null}
      {tab === "runs" ? <RunsView detail={currentDetail} onStopRun={props.onStopRun} onOpenLog={props.onOpenRunLog} /> : null}
      {tab === "activity" ? <ProjectActivity detail={currentDetail} /> : null}
      {tab === "setup" ? <ProjectSetupTab detail={detail} /> : null}
    </div>
  );
}

function CoverageQualityStrip({ progress, findings, confirmedBugs, health, configuredMapSamples, resourceRequests }: {
  progress: Coverage;
  findings: FindingRow[];
  confirmedBugs: number;
  health?: RunHealth | null;
  configuredMapSamples: number;
  resourceRequests: number;
}) {
  if (progress.total === 0 && findings.length === 0 && !health) return null;
  const signals = health?.signals ?? {};
  const outcomes = finiteSignal(signals.scopeOutcomes);
  const incomplete = finiteSignal(signals.scopeOutcomesIncomplete);
  const actualMapSamples = finiteSignal(signals.mapSamples);
  const mapSamples = actualMapSamples || configuredMapSamples;
  const agreedScopes = finiteSignal(signals.mapScopesWithAgreement);
  const duplicates = findings.filter((finding) => finding.tracking_status === "duplicate").length;
  const yieldPerScope = progress.audited > 0 ? (confirmedBugs / progress.audited).toFixed(2) : "0.00";
  return (
    <div className="coverage-quality-strip" aria-label="Coverage quality and unique yield">
      <span><strong>{mapSamples}</strong> {actualMapSamples ? "Map samples" : "configured Map samples"}{agreedScopes ? ` · ${agreedScopes} scopes agreed` : ""}</span>
      <span className={outcomes > 0 && incomplete === 0 ? "good" : incomplete > 0 ? "warn" : ""}><strong>{outcomes ? `${outcomes - incomplete}/${outcomes}` : "—"}</strong> complete scope outcomes</span>
      <span className={resourceRequests ? "warn" : "good"}><strong>{resourceRequests}</strong> resource blockers</span>
      <span><strong>{duplicates}</strong> consolidated variants</span>
      <span><strong>{yieldPerScope}</strong> unique bugs / audited scope</span>
    </div>
  );
}

function finiteSignal(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function prepareMaterialsAttention(summary?: PrepareSummary | null): { tone: "warn" | "pending"; label: string } | null {
  if (!summary) return null;
  if (summary.quality === "ready") return null;
  if (summary.quality === "preparing") {
    return { tone: "pending", label: "Prepared materials are still being resolved" };
  }
  const { blockingIssues, caveats } = prepareIssueBuckets(summary);
  const blocking = blockingIssues.length;
  const manifestMissing = summary.manifestStatus && summary.manifestStatus !== "present" ? 1 : 0;
  const manifestState = summary.manifestState?.toLowerCase();
  const manifestPartial = manifestState && !["complete", "ready", "ok"].includes(manifestState) ? 1 : 0;
  const count = blocking + caveats.length + manifestMissing + manifestPartial;
  if (count <= 0) return null;
  if (summary.auditReady || summary.quality === "limited") {
    return { tone: "warn", label: `Prepared materials are usable with caveats: ${plural(count, "note")}` };
  }
  return {
    tone: summary.quality === "missing" ? "pending" : "warn",
    label: summary.blocked || summary.quality === "needs-review" || summary.quality === "invalid"
      ? `Prepared materials need repair: ${plural(count, "issue")}`
      : `Prepared materials need attention: ${plural(count, "issue")}`,
  };
}

function prepareAttentionSignature(summary: PrepareSummary | null | undefined, attention: { tone: "warn" | "pending"; label: string } | null): string {
  if (!summary || !attention) return "";
  return JSON.stringify({
    tone: attention.tone,
    label: attention.label,
    runId: summary.runId ?? null,
    status: summary.status ?? null,
    quality: summary.quality ?? null,
    auditReady: summary.auditReady ?? null,
    blocked: summary.blocked ?? null,
    manifestStatus: summary.manifestStatus ?? null,
    manifestState: summary.manifestState ?? null,
    blockingIssues: summary.blockingIssues ?? [],
    caveats: summary.caveats ?? [],
    gaps: summary.gaps ?? [],
    issues: summary.issues ?? [],
    realTargetIssues: summary.realTarget?.issues ?? [],
  });
}

function uniqueText(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compactText(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function isCleanFirewallIssue(value: string): boolean {
  const text = value
    .replace(/^.*?\banswer firewall is\b/i, "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (text === "clean" || text.startsWith("clean ")) return true;
  if (hasUnnegatedFirewallInclusion(text)) return false;
  if (text.includes("blind")) return true;
  if (/(^|[.;:]\s*)(no|not|never|without)\b[^.;:]*(material|vulnerability|exploit|poc|proof|incident|post-mortem|bug writeup|opened|staged|fetched|copied|included)/.test(text)) return true;
  return text.includes("not fetched")
    || text.includes("not staged")
    || text.includes("not copied")
    || text.includes("skipped")
    || text.includes("excluded")
    || text.includes("removed");
}

function hasUnnegatedFirewallInclusion(text: string): boolean {
  return text
    .split(/[.;]\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      if (!part.includes("included")) return false;
      return !/\b(no|not|never|without)\b[^.;:]*\bincluded\b/.test(part)
        && !/\bincluded\b[^.;:]*\b(no|not|never|without)\b/.test(part);
    });
}

function prepareIssueBuckets(summary: PrepareSummary): { blockingIssues: string[]; caveats: string[] } {
  const rawBlocking = summary.blockingIssues ?? [];
  const blockingIssues = rawBlocking.filter((item) => !isCleanFirewallIssue(item));
  const caveats = summary.caveats ?? uniqueText([...(summary.issues ?? []), ...(summary.gaps ?? [])]);
  return {
    blockingIssues,
    caveats,
  };
}

function answerFirewallBadge(summary: PrepareSummary): { label: string; title?: string } {
  const detail = summary.answerFirewall || (summary.blockingIssues ?? []).find(isCleanFirewallIssue) || "";
  if (!detail.trim()) return { label: "not reported" };
  const lower = detail.toLowerCase();
  if (lower.startsWith("clean") || isCleanFirewallIssue(detail)) return { label: "clean", title: detail };
  if (lower.includes("blocked") || lower.includes("violation") || lower.includes("answer-bearing")) return { label: "review", title: detail };
  return { label: compactText(detail, 36), title: detail };
}

function prepareScopeSummary(value?: string): { label: string; title?: string } {
  const readable = readableScopeDeclaration(value);
  if (!readable) return { label: "" };
  const lower = readable.toLowerCase();
  if (lower.includes("crates.io package metadata/manifests") && lower.includes("source-only")) {
    return {
      label: "Source-only package audit",
      title: readable,
    };
  }
  if (lower.includes("source-only") && lower.includes("blind")) {
    return {
      label: "Source-only blind audit",
      title: readable,
    };
  }
  return {
    label: compactText(readable, 80),
    title: readable,
  };
}

function realTargetMethodSummary(realTarget: NonNullable<PrepareSummary["realTarget"]>, detail: string): string {
  const lower = detail.toLowerCase();
  if (realTarget.requiresConfirmation === false && lower.includes("source-only")) {
    return "No live target required; confirm against staged packages.";
  }
  if (realTarget.requiresConfirmation === true && (lower.includes("fork") || lower.includes("chain"))) {
    return "Use read-only chain fork for confirmation.";
  }
  return compactText(detail, 120);
}

type SetupDisclosureItem = {
  label: string;
  state: string;
  ok: boolean;
  actionLabel?: string;
  onClick?: () => void;
  title?: string;
};

function ProjectSetupDisclosure({ items, clue }: { items: SetupDisclosureItem[]; clue?: string }) {
  const warnings = items.filter((item) => !item.ok).length;
  return (
    <details id="project-setup" className="setup-disclosure section-anchor">
      <summary>
        <span>Project setup</span>
        <small>{warnings ? `${plural(warnings, "setup issue")} needs attention` : clue ? "Provider, daemon, source, coverage, and clue" : "Provider, daemon, source, and coverage details"}</small>
      </summary>
      <div className="setup-detail-grid">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`setup-detail ${item.ok ? "ok" : "warn"}`}
            onClick={item.onClick}
            title={item.title ?? item.actionLabel ?? `Open ${item.label}`}
          >
            <span className="dot" />
            <span>
              <strong>{item.label}</strong>
              <small>{item.state}</small>
            </span>
            <span className="setup-detail-action">{item.actionLabel ?? "Open"}</span>
          </button>
        ))}
      </div>
      {clue ? (
        <div className="setup-clue">
          <strong>Project clue</strong>
          <p>{clue}</p>
        </div>
      ) : null}
    </details>
  );
}

function Stat({ n, label, good, onClick }: { n: number; label: string; good?: boolean; onClick?: () => void }) {
  const content = (
    <>
      <strong className={good ? "good" : ""}>{n}</strong>
      <span>{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="stat stat-button" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="stat">
      {content}
    </div>
  );
}

function ProjectOverview({
  detail,
  candidates,
  verifyCount,
  verifyLocked,
  onVerifyCandidates,
  onOpenReport,
  onOpenDecisionReport,
  onOpenDecisions,
  onOpenActivity,
}: {
  detail: ProjectDetail;
  candidates: FindingRow[];
  verifyCount: number;
  verifyLocked: boolean;
  onVerifyCandidates: () => void;
  onOpenReport: (finding: FindingRow) => void;
  onOpenDecisionReport: (decision: ConfirmDecision) => void;
  onOpenDecisions: () => void;
  onOpenActivity: () => void;
}) {
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const current = currentRuns.find((run) => run.status === "running") ?? currentRuns[0];
  const runningRun = currentRuns.find((run) => run.status === "running");
  const runningVerify = isVerifyRun(runningRun) ? runningRun : undefined;
  const runningVerifyProgress = verifyRunProgress(runningVerify);
  const rawPendingVerify = rawPendingVerifyCount(detail.allFindings);
  const verifyRechecksConfirmed = verifyRunRechecksConfirmed(runningVerify, rawPendingVerify, activeFindings(detail.allFindings).length);
  const pendingConfirm = verifyRechecksConfirmed ? 0 : pendingConfirmFindings(detail.allFindings, needsRealTargetConfirmation(detail), detail.confirmDecisions).length;
  const sourceConfirmed = detail.statusCounts["confirmed-source"] ?? 0;
  const suspectedLeads = detail.statusCounts.suspected ?? 0;
  const needsEvidence = detail.statusCounts["needs-evidence"] ?? 0;
  const unverifiedLeads = rawPendingVerify || sourceConfirmed + suspectedLeads;
  const decisions = detail.confirmDecisions.length;
  const reproduced = confirmedDecisions(detail.confirmDecisions).length;
  const progress = detail.progress;
  const scopeValue = progress.total > 0 ? `${progress.audited}/${progress.total} scopes audited` : "No scope map yet";
  const scopeDetail = progress.total > 0
    ? `${plural(progress.pending, "pending scope")}${progress.deferred ? ` · ${plural(progress.deferred, "deferred scope")}` : ""}`
    : "Run the pipeline or map scopes to create the inventory.";
  const runLabel = runningRun ? "Current run" : current ? "Latest run" : "Next run";
  const runValue = current ? runKindLabel(current.kind, current) : "No runs yet";
  const runDetail = current ? overviewRunDetail(current, detail.confirmDecisions) : "Start Run to prepare materials, map/dig, confirm impact, and generate reports.";
  const synthesis = runStages(latestRunWithStage(detail, "synthesis")).synthesis;
  const verifyValue = runningVerifyProgress
    ? `${runningVerifyProgress.done}/${runningVerifyProgress.target} checked`
    : verifyCount ? plural(verifyCount, "candidate") : pendingConfirm ? "Ready for confirm" : needsEvidence ? `${needsEvidence} need evidence` : "No candidates";
  const verifyDetail = runningVerifyProgress
    ? `${plural(runningVerifyProgress.remaining, "finding")} left in the active Verify run`
    : verifyCount
    ? `${plural(verifyCount, "prioritized candidate")} selected from ${plural(unverifiedLeads, "unverified lead")}`
    : pendingConfirm
      ? `Execution-confirmed findings can move to real-target confirmation.${needsEvidence ? ` ${plural(needsEvidence, "lead")} need external evidence.` : ""}`
      : needsEvidence
        ? "Local verification reviewed these leads; external evidence is needed to settle them."
      : "Synthesize and dig outputs appear as candidates here.";
  const synthesisValue = synthesis
    ? `${synthesis.produced ?? 0} synthesized ${synthesis.produced === 1 ? "lead" : "leads"}`
    : progress.audited > 0
      ? "No synthesis output"
      : "Not run yet";
  const synthesisDetail = synthesis
    ? `${plural(synthesis.pool ?? 0, "input finding")} across ${plural(synthesis.scopes ?? 0, "scope")}`
    : progress.audited > 0
      ? "Synthesis has not produced a new candidate."
      : "Runs after dig when findings exist.";
  const proofDetail = pendingConfirm
    ? `${plural(pendingConfirm, "finding")} waiting for Confirm`
    : verifyRechecksConfirmed
      ? "Waiting for Verify to finish"
    : decisions
      ? `${reproduced}/${decisions} confirm decisions reproduced`
      : "Available after an audit-confirmed finding exists";
  const health = detail.latestRunHealth ?? current?.runHealth ?? null;
  const healthValue = runHealthLabel(health?.status);
  const healthDetail = runHealthDetail(health);
  const candidateTitle = runningVerifyProgress ? "Verification in progress" : verifyCount ? "Candidates to verify" : "Prioritized findings";
  const candidateSummary = runningVerifyProgress
    ? `${runningVerifyProgress.done}/${runningVerifyProgress.target} findings checked`
    : verifyCount
    ? `${verifyCount} prioritized ${verifyCount === 1 ? "candidate needs" : "candidates need"} verification`
    : candidates.length
      ? `${plural(candidates.length, "prioritized finding")}`
      : "No finding candidate yet";
  const candidateDetail = runningVerifyProgress
    ? `${plural(runningVerifyProgress.remaining, "finding")} left before Confirm can use the refreshed local results.`
    : verifyCount
    ? "These suspected or source-confirmed findings are the next local verification worklist."
    : "Highest-ranked findings from dig and synthesis are shown here for triage; final submission units are decisions.";
  const candidateCounter = runningVerifyProgress ? `${runningVerifyProgress.done}/${runningVerifyProgress.target}` : candidates.length;
  const candidateEmpty = verifyCount
    ? "Unverified candidates appear here after dig or synthesis."
    : "Prioritized findings appear here after dig audits mapped scopes.";
  return (
    <>
      {runningRun ? <ActivitySnapshot run={runningRun} onOpen={onOpenActivity} /> : null}
      <ProjectOverviewDecisions decisions={detail.confirmDecisions} findings={detail.allFindings ?? []} onOpenDecisionReport={onOpenDecisionReport} onOpenDecisions={onOpenDecisions} />
      <div id="project-top-candidates" className="section-anchor">
        <Card title={<span>{candidateTitle} <Counter>{candidateCounter}</Counter></span>}>
          <div className="candidate-head">
            <div>
              <strong>{candidateSummary}</strong>
              <small>{candidateDetail}</small>
            </div>
            <Button size="sm" icon="search" disabled={verifyLocked} title={verifyButtonTitle(verifyCount)} aria-label={verifyButtonTitle(verifyCount)} onClick={onVerifyCandidates}>
              {verifyButtonLabel(verifyCount)}
            </Button>
          </div>
          <FindingList findings={candidates} compact empty={candidateEmpty} onOpenReport={onOpenReport} />
        </Card>
      </div>
      <div id="project-audit-status" className="section-anchor">
        <Card title="Audit status">
          <div className="queue-grid">
            <QueueItem label={runLabel} value={runValue} detail={runDetail} />
            <QueueItem label="Scope coverage" value={scopeValue} detail={scopeDetail} />
            <QueueItem label="Synthesize" value={synthesisValue} detail={synthesisDetail} />
            <QueueItem label="Candidate verification" value={verifyValue} detail={verifyDetail} />
            <QueueItem label="Real-target proof" value={plural(reproduced, "real-target reproduction")} detail={proofDetail} />
            <QueueItem label="Run health" value={healthValue} detail={healthDetail} />
          </div>
        </Card>
      </div>
    </>
  );
}

function runHealthLabel(status: string | null | undefined): string {
  if (!status) return "No health signal";
  return status.split("-").map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(" ");
}

function runHealthDetail(health: ProjectDetail["latestRunHealth"] | RunRow["runHealth"] | null | undefined): string {
  if (!health?.status) return "Run health appears after an audit writes run_health.json.";
  const reasons = health.reasons?.filter(Boolean) ?? [];
  if (reasons.length > 0) return compactText(reasons.join(" "), 150);
  const signals = health.signals ?? {};
  const steps = typeof signals.toolSteps === "number" ? `${signals.toolSteps} tool steps` : "";
  const commands = typeof signals.commandRuns === "number" ? `${signals.commandRuns} command runs` : "";
  return [steps, commands].filter(Boolean).join(" · ") || "No framework health blocker detected.";
}

type BacklogGroupId = "agent-runnable" | "agent-resource" | "agent-review";

const BACKLOG_GROUPS: Array<{ id: BacklogGroupId; label: string; detail: string; empty: string }> = [
  {
    id: "agent-runnable",
    label: "Coverage work",
    detail: "Coverage gaps and follow-up scopes that can be handled with Continue, Expand map, or scope prioritization.",
    empty: "No coverage backlog items.",
  },
  {
    id: "agent-resource",
    label: "Setup work",
    detail: "Toolchain, sandbox, dependency, credential, or source material requests the agent should resolve or narrow to an explicit ask.",
    empty: "No setup backlog items.",
  },
  {
    id: "agent-review",
    label: "Routing work",
    detail: "Backlog rows the agent should inspect and route to the right safe workflow action.",
    empty: "No routing backlog items.",
  },
];

function NextActionsView({
  detail,
  onLaunch,
  onPatchScope,
  onPatchBacklog,
}: {
  detail: ProjectDetail;
  onLaunch: (action: LaunchAction) => void;
  onPatchScope: (scopeId: string, body: unknown) => Promise<void> | void;
  onPatchBacklog: (id: number, status: string) => Promise<void> | void;
}) {
  const items = detail.discoveryBacklog ?? [];
  const groupCounts = backlogActionGroupCounts(items);
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const runningRun = currentRuns.find((run) => run.status === "running");
  const openItems = backlogOpenItems(items);
  const canRunAgentQueue = openItems.length > 0 && !runningRun;
  return (
    <div id="project-next-actions" className="section-anchor">
      <Card title="Next actions">
        <div className="next-actions-head">
          <div>
            <strong>{openItems.length ? `${plural(openItems.length, "item")} assigned to the agent` : "No open next actions"}</strong>
            <small>The agent owns technical follow-up. It should ask the operator only for explicit credentials, authorization, or unavailable external resources.</small>
          </div>
          <Button
            size="sm"
            variant="primary"
            icon="play"
            disabled={!canRunAgentQueue}
            title={runningRun ? "A run is already active for this project." : openItems.length ? "Continue the project pipeline against open next actions." : "No open next actions."}
            onClick={() => onLaunch("run")}
          >
            Run agent queue
          </Button>
        </div>
        <div className="queue-grid next-action-metrics">
          <QueueItem label="Coverage work" value={String(groupCounts["agent-runnable"])} detail="Continue, append map, or prioritize scope." />
          <QueueItem label="Setup work" value={String(groupCounts["agent-resource"])} detail="Resolve toolchain, sandbox, dependency, source, or auth blockers when possible." />
          <QueueItem label="Routing work" value={String(groupCounts["agent-review"])} detail="Inspect ambiguous rows and choose the next safe workflow action." />
        </div>
        <div className="next-action-groups">
          {BACKLOG_GROUPS.map((group) => {
            const rows = backlogGroupItems(items, group.id);
            return (
              <section className="next-action-group" key={group.id} aria-label={group.label}>
                <div className="next-action-group-head">
                  <div>
                    <strong>{group.label}</strong>
                    <small>{group.detail}</small>
                  </div>
                  <Counter>{rows.length}</Counter>
                </div>
                {rows.length ? (
                  <div className="resource-list">
                    {rows.map((item) => (
                      <NextActionRow
                        key={item.id}
                        item={item}
                        running={Boolean(runningRun)}
                        onLaunch={onLaunch}
                        onPatchScope={onPatchScope}
                        onPatchBacklog={onPatchBacklog}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyInline>{group.empty}</EmptyInline>
                )}
              </section>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function NextActionRow({
  item,
  running,
  onLaunch,
  onPatchScope,
  onPatchBacklog,
}: {
  item: DiscoveryBacklogRow;
  running: boolean;
  onLaunch: (action: LaunchAction) => void;
  onPatchScope: (scopeId: string, body: unknown) => Promise<void> | void;
  onPatchBacklog: (id: number, status: string) => Promise<void> | void;
}) {
  const group = backlogGroupId(item);
  const recommended = backlogRecommendedAction(item);
  const scopeId = backlogScopeId(item);
  const primaryLabel = item.primary_action_label || backlogPrimaryActionLabel(item);
  return (
    <div className={`resource-card backlog-card next-action-card ${group}`}>
      <span className={`label s-${item.kind}`}>{backlogKindLabel(item.kind)}</span>
      <div className="grow">
        <div className="next-action-title">
          <strong>{item.title || "Untitled backlog item"}</strong>
          <span className={`label backlog-owner ${group}`}>{backlogGroupShortLabel(group)}</span>
        </div>
        <small>{backlogSummaryDetail(item)}</small>
        {item.action_reason ? <small className="next-action-reason">{item.action_reason}</small> : null}
      </div>
      <span className="resource-actions">
        {group === "agent-runnable" && recommended === "prioritize-scope" && scopeId ? (
          <Button size="sm" disabled={running} onClick={() => void Promise.resolve(onPatchScope(scopeId, { prioritize: true }))}>Prioritize</Button>
        ) : null}
        {group === "agent-runnable" && recommended === "expand-map" ? (
          <Button size="sm" disabled={running} onClick={() => onLaunch("map-expand")}>{primaryLabel}</Button>
        ) : null}
        {group === "agent-runnable" && recommended !== "expand-map" ? (
          <Button size="sm" icon="play" disabled={running} onClick={() => onLaunch("run")}>{recommended === "prioritize-scope" && scopeId ? "Continue" : primaryLabel}</Button>
        ) : null}
        {group === "agent-resource" || group === "agent-review" ? <Button size="sm" icon="play" disabled={running} onClick={() => onLaunch("run")}>{primaryLabel}</Button> : null}
        {item.status === "open" ? <Button size="sm" onClick={() => void Promise.resolve(onPatchBacklog(item.id, "resolved"))}>Resolve</Button> : null}
        {item.status === "open" ? <Button size="sm" onClick={() => void Promise.resolve(onPatchBacklog(item.id, "ignored"))}>Ignore</Button> : null}
      </span>
    </div>
  );
}

function backlogOpenItems(items: DiscoveryBacklogRow[]): DiscoveryBacklogRow[] {
  return items.filter((item) => item.status === "open");
}

function backlogGroupItems(items: DiscoveryBacklogRow[], group: BacklogGroupId): DiscoveryBacklogRow[] {
  return backlogOpenItems(items).filter((item) => backlogGroupId(item) === group);
}

function backlogActionGroupCounts(items: DiscoveryBacklogRow[]): Record<BacklogGroupId, number> {
  return {
    "agent-runnable": backlogGroupItems(items, "agent-runnable").length,
    "agent-resource": backlogGroupItems(items, "agent-resource").length,
    "agent-review": backlogGroupItems(items, "agent-review").length,
  };
}

function backlogGroupId(item: DiscoveryBacklogRow): BacklogGroupId {
  if (item.actionability === "agent-runnable" || item.actionability === "agent-resource" || item.actionability === "agent-review") return item.actionability;
  if (item.actionability === "needs-resource") return "agent-resource";
  if (item.actionability === "needs-decision") return "agent-review";
  if (item.kind === "resource-request") return "agent-resource";
  if (item.kind === "coverage-gap" || item.kind === "followup-scope") return "agent-runnable";
  return "agent-review";
}

function backlogGroupShortLabel(group: BacklogGroupId): string {
  if (group === "agent-runnable") return "Coverage";
  if (group === "agent-resource") return "Setup";
  return "Route";
}

function backlogRecommendedAction(item: DiscoveryBacklogRow): string {
  if (item.recommended_action) return item.recommended_action;
  if (item.kind === "coverage-gap") return backlogScopeId(item) ? "prioritize-scope" : "expand-map";
  if (item.kind === "followup-scope") return backlogScopeId(item) ? "prioritize-scope" : "continue";
  if (item.kind === "resource-request") return "resolve-resource";
  return "review-and-route";
}

function backlogPrimaryActionLabel(item: DiscoveryBacklogRow): string {
  const action = backlogRecommendedAction(item);
  if (action === "prioritize-scope") return "Prioritize scope";
  if (action === "expand-map") return "Expand map";
  if (action === "continue") return "Continue";
  if (action === "resolve-resource") return "Fix setup";
  return "Run agent";
}

function backlogScopeId(item: DiscoveryBacklogRow): string {
  if (item.scope_id) return item.scope_id;
  const payload = item.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const value = record.scope_id ?? record.scopeId ?? record.id;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function backlogKindLabel(kind: string): string {
  if (kind === "coverage-gap") return "Coverage";
  if (kind === "resource-request") return "Resource";
  if (kind === "followup-scope") return "Follow-up";
  return kind;
}

function backlogSummaryDetail(item: DiscoveryBacklogRow): string {
  const scopeId = backlogScopeId(item);
  return [item.location, scopeId ? `scope ${scopeId}` : "", item.reason, item.next_action].filter(Boolean).join(" · ") || "No additional detail recorded.";
}

function ProjectOverviewDecisions({
  decisions,
  findings,
  onOpenDecisionReport,
  onOpenDecisions,
}: {
  decisions: ConfirmDecision[];
  findings: FindingRow[];
  onOpenDecisionReport: (decision: ConfirmDecision) => void;
  onOpenDecisions: () => void;
}) {
  if (!decisions.length) return null;
  const reproduced = confirmedDecisions(decisions).length;
  const submissionReadyDecisions = reportableDecisions(decisions, findings);
  const submissionReady = submissionReadyDecisions.length;
  const submitCandidates = submitCandidateCount(submissionReadyDecisions);
  const droppedReproductions = droppedReproductionCount(decisions);
  const missingReports = pendingDecisionReports(decisions, findings).length;
  const meta = decisionCalloutMeta(decisions);
  const preview = overviewDecisionPreview(decisions);
  const remaining = decisions.length - preview.length;
  const headline = submissionReady
    ? plural(submissionReady, "submission-ready bug")
    : droppedReproductions
      ? `${plural(droppedReproductions, "reproduced decision")} dropped`
      : reproduced
        ? `${plural(reproduced, "real-target reproduction")} not submission-ready`
        : "No submission-ready bugs";
  const detailParts = [
    plural(decisions.length, "decision"),
    submissionReady ? plural(submissionReady, "submission-ready bug") : "0 submission-ready",
    reproduced ? plural(reproduced, "real-target reproduction") : "",
    droppedReproductions ? `${plural(droppedReproductions, "reproduced decision")} dropped` : "",
    missingReports ? `${plural(missingReports, "formal report")} missing` : "",
    meta,
  ].filter(Boolean);
  return (
    <div id="project-submission-decisions" className="section-anchor">
      <Card title={<span>Submission decisions <Counter>{decisions.length}</Counter></span>}>
        <div className="candidate-head">
          <div>
            <strong>{headline}</strong>
            <small>{detailParts.join(" · ")}</small>
          </div>
          <Button size="sm" icon="arrowright" title="Open all decisions" aria-label="Open all decisions" onClick={onOpenDecisions}>
            All decisions
          </Button>
        </div>
        <div className="decision-list overview-decision-list">
          {preview.map((decision) => {
            const evidenceConflict = decisionHasUnresolvedEvidenceConflict(decision, findings);
            const metaChips = evidenceConflict
              ? [
                { label: "Needs human review", className: "label s-needs-evidence", title: "Local verification conflicts with the real-target reproduction." },
                ...decisionMetaChips(decision).filter((chip) => chip.title !== "Submit recommendation"),
              ]
              : decisionMetaChips(decision);
            const dropReason = decisionDropReason(decision);
            return (
              <div className={`decision-row overview-decision-row${!evidenceConflict && isSubmitCandidateDecision(decision) ? " submit-candidate" : ""}`} key={decision.id ?? `${decision.run_id}-${decision.bug}`}>
                <div className="decision-main">
                  <span className={`label ${evidenceConflict ? "s-needs-evidence" : decision.reproduced === "yes" ? "s-confirmed-executable" : decision.reproduced === "no" ? "s-refuted" : "s-suspected"}`}>
                    {evidenceConflict ? "Evidence conflict" : decisionLabel(decision)}
                  </span>
                  <strong>{decision.bug}</strong>
                  {metaChips.length ? (
                    <div className="decision-meta-chips" aria-label="Decision submission metadata">
                      {metaChips.map((chip) => (
                        <span key={`${decision.id}-${chip.label}`} className={chip.className} title={chip.title}>{chip.label}</span>
                      ))}
                    </div>
                  ) : null}
                  {dropReason ? <small className="decision-drop-reason">{dropReason}</small> : null}
                </div>
                <div className="decision-actions">
                  {evidenceConflict ? <span className="label s-needs-evidence" title="Resolve the evidence conflict before generating a submission report.">Report held</span> : (
                    <Button size="sm" icon="file" title={decisionReportButtonTitle(decision)} onClick={() => onOpenDecisionReport(decision)}>
                      {decisionReportButtonLabel(decision)}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {remaining > 0 ? (
          <button type="button" className="overview-more-link" onClick={onOpenDecisions}>
            Show {plural(remaining, "more decision")}
          </button>
        ) : null}
      </Card>
    </div>
  );
}

function ProjectDecisions({ detail, onOpenFinding, onOpenDecisionReport }: { detail: ProjectDetail; onOpenFinding: (finding: FindingRow) => void; onOpenDecisionReport: (decision: ConfirmDecision) => void }) {
  return (
    <ConfirmDecisionsCard
      decisions={detail.confirmDecisions}
      findings={detail.allFindings ?? []}
      onOpenFinding={onOpenFinding}
      onOpenDecisionReport={onOpenDecisionReport}
    />
  );
}

function ActivitySnapshot({ run, onOpen }: { run: RunRow; onOpen: () => void }) {
  const inactive = runInactiveLabel(run);
  const lastActivity = run.last_activity_at ? fmtTime(run.last_activity_at) : "";
  const status = inactive
    ? `No activity for ${inactive}`
    : lastActivity
      ? `Last update ${lastActivity}`
      : run.status === "running"
        ? "Waiting for first event"
        : "No activity recorded";
  return (
    <Card>
      <button type="button" className="activity-snapshot" onClick={onOpen}>
        <span className={`activity-snapshot-dot${run.status === "running" && !inactive ? " live" : inactive ? " warn" : ""}`} />
        <span className="activity-snapshot-main">
          <span className="section-title inline">Live activity</span>
          <strong>{runKindLabel(run.kind, run)}</strong>
          <small>Run #{run.id} · {runProgress(run, [])}</small>
        </span>
        <span className="activity-snapshot-side">
          <small>{status}</small>
          <span>Open activity</span>
        </span>
        <Icon name="arrowright" size={14} />
      </button>
    </Card>
  );
}

function ProjectActivity({ detail }: { detail: ProjectDetail }) {
  const currentRuns = currentMaterialRuns(detail.runs, detail.material);
  const run = currentRuns.find((entry) => entry.status === "running") ?? currentRuns[0];
  if (!run) {
    return (
      <Card title="Live activity">
        <EmptyInline>No run activity has been recorded for this project.</EmptyInline>
      </Card>
    );
  }
  const activeScopeIds = detail.activeScopeIds
    ?? detail.scopes?.filter((scope) => scope.status === "auditing").map((scope) => scope.scope_id)
    ?? [];
  return <LiveActivityPanel run={run} activeScopeIds={activeScopeIds} defaultExpanded />;
}

function decisionLabel(decision: ConfirmDecision): string {
  if (decision.reproduced === "yes") return "reproduced";
  if (decision.reproduced === "no") return "not reproduced";
  return decision.reproduced || "undecided";
}

function isSubmitCandidateDecision(decision: ConfirmDecision): boolean {
  return decision.reproduced === "yes" && decision.recommendation === "submit-candidate";
}

function droppedReproductionCount(decisions: ConfirmDecision[]): number {
  return decisions.filter((decision) => decision.reproduced === "yes" && decision.recommendation === "drop").length;
}

function overviewDecisionPreview(decisions: ConfirmDecision[]): ConfirmDecision[] {
  const ordered = sortConfirmDecisionsForSubmission(decisions);
  const submitCandidates = ordered.filter(isSubmitCandidateDecision);
  const reproduced = ordered.filter((decision) => decision.reproduced === "yes" && !isSubmitCandidateDecision(decision));
  const unresolved = ordered.filter((decision) => decision.reproduced !== "yes");
  return [...submitCandidates, ...reproduced, ...unresolved].slice(0, 5);
}

function recommendationLabel(decision: ConfirmDecision): string {
  return decision.recommendation ? decision.recommendation.replace(/-/g, " ") : "no recommendation";
}

function decisionRecommendationLabel(decision: ConfirmDecision): string {
  const label = recommendationLabel(decision);
  return label ? `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}` : "No recommendation";
}

function decisionRecommendationClass(decision: ConfirmDecision): string {
  const recommendation = badgeToken(decision.recommendation ?? "");
  if (recommendation === "submit-candidate") return "decision-recommendation-submit";
  if (recommendation === "drop") return "decision-recommendation-drop";
  if (recommendation === "needs-human") return "decision-recommendation-needs-human";
  return "decision-recommendation-neutral";
}

function decisionMetaLabel(decision: ConfirmDecision): string {
  return [
    decision.evidence_level ? decision.evidence_level.replace(/-/g, " ") : "",
  ].filter(Boolean).join(" · ");
}

function badgeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function badgeLabel(value: string): string {
  return badgeToken(value).split("-").map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : "").filter(Boolean).join(" ");
}

type DecisionChip = { label: string; className: string; title: string };
type DecisionObject = Record<string, unknown>;

function decisionObject(value: unknown): DecisionObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DecisionObject) : undefined;
}

function decisionStructuredObject(decision: ConfirmDecision, objectKey: "engagement_profile" | "adjudication", jsonKey: "engagement_profile_json" | "adjudication_json"): DecisionObject | undefined {
  return decisionObject(decision[objectKey]) ?? decisionObject(parseJson<unknown>(decision[jsonKey], null));
}

function stringField(obj: DecisionObject | undefined, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function recordField(obj: DecisionObject | undefined, keys: string[]): DecisionObject | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = decisionObject(obj[key]);
    if (value) return value;
  }
  return undefined;
}

function recordArrayField(obj: DecisionObject | undefined, keys: string[]): DecisionObject[] {
  if (!obj) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.map(decisionObject).filter((entry): entry is DecisionObject => Boolean(entry));
  }
  return [];
}

function gateStatusKind(value: string): "pass" | "open" | "fail" | "unknown" {
  const token = badgeToken(value);
  if (!token) return "unknown";
  if (["pass", "passed", "yes", "ok", "satisfied", "not-required", "not-applicable", "in-scope", "eligible", "confirmed"].includes(token)) return "pass";
  if (["fail", "failed", "no", "blocked", "out-of-scope", "ineligible", "already-disclosed", "duplicate", "not-reproduced"].includes(token)) return "fail";
  if (["unknown", "unclear", "pending", "needs-human", "not-established", "unverified", "partial", "review"].includes(token)) return "open";
  return "unknown";
}

function gateChip(label: string, status: string, title: string): DecisionChip | null {
  if (!status) return null;
  const kind = gateStatusKind(status);
  const className = kind === "pass"
    ? "label decision-gate decision-gate-pass"
    : kind === "fail"
      ? "label decision-gate decision-gate-fail"
      : kind === "open"
        ? "label decision-gate decision-gate-open"
        : "label decision-gate decision-gate-unknown";
  return { label: `${label} ${kind === "unknown" ? badgeLabel(status) : kind}`, className, title };
}

function gateStatus(adjudication: DecisionObject | undefined, needles: string[], fallbackKeys: string[]): string {
  const gates = recordArrayField(adjudication, ["gates", "required_gates", "requiredGates"]);
  for (const gate of gates) {
    const name = [stringField(gate, ["id", "kind", "name", "gate"]), stringField(gate, ["description", "label"])].join(" ").toLowerCase();
    if (!needles.some((needle) => name.includes(needle))) continue;
    const status = stringField(gate, ["status", "result", "state"]);
    if (status) return status;
  }
  return stringField(adjudication, fallbackKeys);
}

function usdNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const n = Number(value.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function formatUsd(value: unknown): string {
  const n = usdNumber(value);
  if (n === undefined) return typeof value === "string" && value.trim() ? value.trim() : "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}

function payoutChip(adjudication: DecisionObject | undefined): DecisionChip | null {
  const estimate = recordField(adjudication, ["payout_estimate", "payoutEstimate", "expected_payout", "expectedPayout"]);
  if (!estimate) return null;
  const exact = formatUsd(estimate.expected_collectible_usd ?? estimate.expectedCollectibleUsd ?? estimate.collectible_usd ?? estimate.collectibleUsd);
  const min = formatUsd(estimate.eligible_min_usd ?? estimate.eligibleMinUsd ?? estimate.min_usd ?? estimate.minUsd);
  const max = formatUsd(estimate.eligible_max_usd ?? estimate.eligibleMaxUsd ?? estimate.max_usd ?? estimate.maxUsd);
  const status = stringField(estimate, ["status", "confidence", "basis"]);
  const label = exact ? `Payout ${exact}` : min && max ? `Payout ${min}-${max}` : "Payout unknown";
  const open = !exact && !(min && max);
  return {
    label,
    className: open ? "label decision-gate decision-gate-open" : "label decision-payout",
    title: status || "Conservative expected collectible bounty; unknown means the required gates are not proven.",
  };
}

function decisionAdjudicationChips(decision: ConfirmDecision): DecisionChip[] {
  const engagement = decisionStructuredObject(decision, "engagement_profile", "engagement_profile_json");
  const adjudication = decisionStructuredObject(decision, "adjudication", "adjudication_json");
  const policy = stringField(engagement, ["policy_kind", "policyKind", "kind"]) || stringField(adjudication, ["policy_kind", "policyKind"]);
  return [
    policy ? { label: `Policy ${badgeLabel(policy)}`, className: "label decision-policy", title: "Agent-selected engagement policy for this decision." } : null,
    gateChip("Scope", gateStatus(adjudication, ["scope", "venue", "eligib"], ["scope_status", "scopeStatus"]), "Bounty or engagement scope gate."),
    gateChip("Funds", gateStatus(adjudication, ["fund", "impact", "exposure", "live"], ["live_impact_status", "liveImpactStatus", "funds_status", "fundsStatus"]), "Live funded impact or exposure gate."),
    gateChip("Known", gateStatus(adjudication, ["known", "novel", "duplicate", "disclos"], ["known_issue_status", "knownIssueStatus", "novelty_status", "noveltyStatus"]), "Known issue, duplicate, or prior disclosure gate."),
    payoutChip(adjudication),
  ].filter((entry): entry is DecisionChip => Boolean(entry));
}

function adjudicationGate(adjudication: DecisionObject | undefined, needles: string[]): DecisionObject | undefined {
  const gates = recordArrayField(adjudication, ["gates", "required_gates", "requiredGates"]);
  return gates.find((gate) => {
    const name = [stringField(gate, ["id", "kind", "name", "gate"]), stringField(gate, ["description", "label"])].join(" ").toLowerCase();
    return needles.some((needle) => name.includes(needle));
  });
}

function decisionDropReason(decision: ConfirmDecision): string {
  if (decision.recommendation !== "drop") return "";
  const adjudication = decisionStructuredObject(decision, "adjudication", "adjudication_json");
  const gateDefs = [
    { label: "Live impact", needles: ["live", "impact", "fund", "exposure", "deployment"], fallback: ["live_impact_status", "liveImpactStatus", "funds_status", "fundsStatus"] },
    { label: "Payout", needles: ["payout", "reward", "collectible", "bounty"], fallback: ["payout_status", "payoutStatus", "reward_status", "rewardStatus"] },
    { label: "Scope", needles: ["scope", "venue", "eligib"], fallback: ["scope_status", "scopeStatus"] },
    { label: "Known issue", needles: ["known", "novel", "duplicate", "disclos"], fallback: ["known_issue_status", "knownIssueStatus", "novelty_status", "noveltyStatus"] },
  ];
  for (const gateDef of gateDefs) {
    const status = gateStatus(adjudication, gateDef.needles, gateDef.fallback);
    const kind = gateStatusKind(status);
    if (kind !== "fail" && kind !== "open") continue;
    const gate = adjudicationGate(adjudication, gateDef.needles);
    const evidence = stringField(gate, ["evidence", "reason", "basis", "detail"]);
    return `${gateDef.label}: ${evidence || badgeLabel(status)}`;
  }
  if (decision.human_gates?.trim()) return decision.human_gates.trim();
  if (decision.repro_evidence?.trim()) return decision.repro_evidence.trim();
  return "Decision report records the non-submittable reason.";
}

function decisionReportButtonLabel(decision: ConfirmDecision): string {
  if (decision.has_report) return "Submission report";
  return isSubmissionReadyDecision(decision) ? "Draft report" : "Decision report";
}

function decisionReportButtonTitle(decision: ConfirmDecision): string {
  if (decision.has_report) return "Open submission report";
  if (isSubmissionReadyDecision(decision)) return "Open generated submission draft";
  return "Open decision report with reproduction, gates, and drop rationale";
}

function SeverityBadge({ value }: { value?: string | null }) {
  if (!value?.trim()) return null;
  const token = badgeToken(value);
  return <span className={`severity sev-${token}`}>{badgeLabel(value)}</span>;
}

function decisionMetaChips(decision: ConfirmDecision): DecisionChip[] {
  const severity = decision.severity?.trim();
  const confidence = decision.submission_confidence?.trim();
  return [
    decision.recommendation ? { label: decisionRecommendationLabel(decision), className: `label decision-recommendation ${decisionRecommendationClass(decision)}`, title: "Submit recommendation" } : null,
    severity ? { label: badgeLabel(severity), className: `severity sev-${badgeToken(severity)}`, title: "Decision severity" } : null,
    confidence ? { label: `${badgeLabel(confidence)} confidence`, className: `label decision-confidence decision-confidence-${badgeToken(confidence)}`, title: "Submission confidence" } : null,
    ...decisionAdjudicationChips(decision),
  ].filter((entry): entry is { label: string; className: string; title: string } => Boolean(entry));
}

const DECISION_SEVERITY_RANK: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const DECISION_CONFIDENCE_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, unknown: 1 };

function strongestDecisionValue(decisions: ConfirmDecision[], field: "severity" | "submission_confidence", ranks: Record<string, number>): string {
  let best = "";
  let bestRank = 0;
  for (const decision of decisions) {
    const value = decision[field]?.trim().toLowerCase() ?? "";
    const rank = ranks[value] ?? 0;
    if (rank > bestRank) {
      best = value;
      bestRank = rank;
    }
  }
  return best;
}

function decisionCalloutMeta(decisions: ConfirmDecision[]): string {
  const severity = strongestDecisionValue(decisions, "severity", DECISION_SEVERITY_RANK);
  const confidence = strongestDecisionValue(decisions, "submission_confidence", DECISION_CONFIDENCE_RANK);
  return [
    severity ? `max ${severity}` : "",
    confidence ? `confidence ${confidence}` : "",
  ].filter(Boolean).join(" · ");
}

function submitCandidateCount(decisions: ConfirmDecision[]): number {
  return decisions.filter(isSubmitCandidateDecision).length;
}

function decisionFindings(decision: ConfirmDecision, findings: FindingRow[]): FindingRow[] {
  const keys = new Set(confirmDecisionMemberKeys(decision));
  if (!keys.size) return [];
  return findings.filter((finding) => finding.finding_key && keys.has(finding.finding_key.toLowerCase()));
}

function ConfirmDecisionsCard({
  decisions,
  findings,
  onOpenFinding,
  onOpenDecisionReport,
}: {
  decisions: ConfirmDecision[];
  findings: FindingRow[];
  onOpenFinding: (finding: FindingRow) => void;
  onOpenDecisionReport: (decision: ConfirmDecision) => void;
}) {
  if (!decisions.length) {
    return (
      <div id="project-real-target-decisions" className="section-anchor">
        <Card title={<span>Real-target decisions <Counter>0</Counter></span>}>
          <EmptyInline>No real-target decision has been produced yet.</EmptyInline>
        </Card>
      </div>
    );
  }
  const orderedDecisions = sortConfirmDecisionsForSubmission(decisions);
  return (
    <div id="project-real-target-decisions" className="section-anchor">
      <Card title={<span>Real-target decisions <Counter>{decisions.length}</Counter></span>}>
        <div className="decision-list">
          {orderedDecisions.map((decision) => {
            const linkedFindings = decisionFindings(decision, findings);
            const evidenceConflict = decisionHasUnresolvedEvidenceConflict(decision, findings);
            const metaChips = evidenceConflict
              ? [
                { label: "Needs human review", className: "label s-needs-evidence", title: "Local verification conflicts with the real-target reproduction." },
                ...decisionMetaChips(decision).filter((chip) => chip.title !== "Submit recommendation"),
              ]
              : decisionMetaChips(decision);
            const dropReason = decisionDropReason(decision);
            return (
              <div className={`decision-row${!evidenceConflict && decision.recommendation === "submit-candidate" ? " submit-candidate" : ""}`} key={decision.id ?? `${decision.run_id}-${decision.bug}`}>
                <div className="decision-main">
                  <span className={`label ${evidenceConflict ? "s-needs-evidence" : decision.reproduced === "yes" ? "s-confirmed-executable" : decision.reproduced === "no" ? "s-refuted" : "s-suspected"}`}>
                    {evidenceConflict ? "Evidence conflict" : decisionLabel(decision)}
                  </span>
                  <strong>{decision.bug}</strong>
                  <small>{decisionMetaLabel(decision)}</small>
                  {metaChips.length ? (
                    <div className="decision-meta-chips" aria-label="Decision severity and confidence">
                      {metaChips.map((chip) => (
                        <span key={`${decision.id}-${chip.label}`} className={chip.className} title={chip.title}>{chip.label}</span>
                      ))}
                    </div>
                  ) : null}
                  {dropReason ? <small className="decision-drop-reason">{dropReason}</small> : null}
                  {linkedFindings.length ? (
                    <div className="linked-findings" aria-label="Linked findings">
                      {linkedFindings.map((finding) => (
                        <button key={finding.id} type="button" className="table-link" onClick={() => onOpenFinding(finding)}>
                          Finding #{finding.id}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="decision-actions">
                  {evidenceConflict ? <span className="label s-needs-evidence" title="Resolve the evidence conflict before generating a submission report.">Report held</span> : (
                    <Button size="sm" icon="file" title={decisionReportButtonTitle(decision)} onClick={() => onOpenDecisionReport(decision)}>
                      {decisionReportButtonLabel(decision)}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function RealTargetCallout({ decisions, findings, onOpen }: { decisions: ConfirmDecision[]; findings: FindingRow[]; onOpen: () => void }) {
  const reproduced = confirmedDecisions(decisions).length;
  const submissionReady = reportableDecisions(decisions, findings).length;
  const droppedReproductions = droppedReproductionCount(decisions);
  const meta = decisionCalloutMeta(decisions);
  if (!decisions.length) return null;
  const headline = submissionReady
    ? plural(submissionReady, "submission-ready bug")
    : droppedReproductions
      ? `${plural(droppedReproductions, "reproduced decision")} dropped`
      : "No submission-ready bugs";
  const tone = submissionReady ? "ready" : droppedReproductions ? "blocked" : "neutral";
  return (
    <button className={`real-target-callout ${tone}`} type="button" onClick={onOpen}>
      <span className="dot" />
      <span>
        <strong>{headline}</strong>
        <small>{plural(decisions.length, "decision")} recorded{reproduced ? ` · ${plural(reproduced, "real-target reproduction")}` : ""}{droppedReproductions ? ` · ${plural(droppedReproductions, "reproduced decision")} dropped` : ""}{meta ? ` · ${meta}` : ""}. Open decision reports.</small>
      </span>
      <Icon name="arrowright" size={14} />
    </button>
  );
}

function ProjectSetupTab({ detail }: { detail: ProjectDetail }) {
  return (
    <section id="project-setup-tab" className="section-anchor">
      {detail.prepareSummary ? (
        <PrepareMaterialsCard summary={detail.prepareSummary} />
      ) : (
        <Card title="Prepared materials">
          <EmptyInline>Prepared source, corpus, deployment matching, and sandbox details appear here after a prepare run.</EmptyInline>
        </Card>
      )}
    </section>
  );
}

function prepareMatchBadge(match?: string): { label: string; className: string; title: string } {
  const raw = (match ?? "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return { label: "unreported", className: "s-discharged", title: "The prepare manifest did not report source/deployment match status." };
  }
  if (["n/a", "na", "none", "not_applicable", "not-applicable"].includes(normalized)) {
    return { label: "n/a", className: "s-discharged", title: "No deployed target match is required for this source-only component." };
  }
  if (normalized === "matched" || normalized.includes("verified") || normalized.includes("sourcify") || normalized.includes("matched")) {
    return { label: "verified", className: "s-confirmed-source", title: `Verified source/deployment evidence: ${raw}` };
  }
  if (normalized.includes("unverified") || normalized.includes("partial") || normalized.includes("mixed")) {
    return { label: normalized.includes("mixed") ? "mixed" : normalized.includes("partial") ? "partial" : "unverified", className: "s-suspected", title: `Trust boundary: ${raw}` };
  }
  return { label: raw, className: "s-discharged", title: `Reported source/deployment match status: ${raw}` };
}

function PrepareMaterialsCard({ summary }: { summary: PrepareSummary }) {
  const [expanded, setExpanded] = useState(false);
  const components = summary.components ?? [];
  const visibleComponents = expanded ? components : components.slice(0, 6);
  const hiddenComponents = Math.max(0, components.length - visibleComponents.length);
  const { blockingIssues, caveats } = prepareIssueBuckets(summary);
  const hasOnlyBenignFirewallBlockers = (summary.blockingIssues?.length ?? 0) > 0 && blockingIssues.length === 0;
  const realTarget = summary.realTarget;
  const manifestReady = summary.manifestStatus === "present";
  const blocked = blockingIssues.length > 0 || ((summary.blocked || summary.quality === "needs-review" || summary.quality === "invalid") && !hasOnlyBenignFirewallBlockers);
  const quality = summary.quality === "ready" ? "ok" : summary.quality === "preparing" || summary.quality === "missing" ? "pending" : "warn";
  const qualityLabel = hasOnlyBenignFirewallBlockers
    ? "Usable with caveats"
    : summary.quality === "ready"
    ? "Ready for sealed audit"
    : summary.quality === "limited"
      ? "Usable with caveats"
      : summary.quality === "preparing"
        ? "Preparing materials"
        : summary.quality === "missing"
          ? "Prepare output missing"
          : summary.quality === "invalid"
            ? "Prepare output invalid"
            : blocked
              ? "Materials need repair"
              : manifestReady
                ? "Ready for sealed audit"
                : "Preparing materials";
  const workspace = summary.workspace ?? {};
  const filesLabel = workspace.filesTruncated ? `${(workspace.files ?? 0).toLocaleString()}+` : (workspace.files ?? 0).toLocaleString();
  const scope = prepareScopeSummary(summary.scopeDeclaration);
  const firewall = answerFirewallBadge(summary);
  const showFirewall = firewall.label !== "clean" && firewall.label !== "not reported";
  const showRealTargetPanel = Boolean(
    !realTarget?.reported
    || realTarget.requiresConfirmation === true
    || (realTarget.issues?.length ?? 0) > 0,
  );
  const reviewCount = blockingIssues.length + caveats.length;
  return (
    <Card title={<span>Prepared materials <Counter>{summary.componentsTotal ?? 0}</Counter></span>}>
      <div className="prepare-materials">
        <div className="prepare-head">
          <div className={`prepare-quality ${quality}`}>
            <span className="dot" />
            <span>
              <strong>{qualityLabel}</strong>
              <small>
                Run #{summary.runId ?? "-"} · {summary.status ?? "unknown"} · manifest {summary.manifestStatus ?? "unknown"}{summary.manifestState ? ` · ${summary.manifestState}` : ""}
              </small>
            </span>
          </div>
          <div className="prepare-kpis">
            <span><strong>{summary.inScope ?? 0}</strong> in scope</span>
            <span><strong>{summary.matched ?? 0}</strong> matched</span>
            <span><strong>{summary.unverified ?? 0}</strong> unverified</span>
            <span title={workspace.filesTruncated ? `Workspace scan stopped after ${workspace.fileLimit ?? workspace.files ?? 0} files.` : undefined}>
              <strong>{filesLabel}</strong> {workspace.filesTruncated ? "scanned" : "files"}{workspace.filesTruncated ? " · scan limit" : ""}
            </span>
          </div>
        </div>
        <div className="prepare-summary-line">
          <span title={scope.title}>{scope.label || "Prepared source available"}</span>
          {summary.posture ? <span>Posture <strong>{summary.posture}</strong></span> : null}
          <span>Confirmation <strong>{realTargetSummaryLabel(realTarget)}</strong></span>
          {showFirewall ? <span title={firewall.title}>Firewall <strong>{firewall.label}</strong></span> : null}
        </div>
        {showRealTargetPanel ? <PrepareRealTargetPanel realTarget={realTarget} /> : null}
        {components.length ? (
          <div className="prepare-components" aria-label="Prepared components">
            {visibleComponents.map((component, index) => {
              const match = prepareMatchBadge(component.match);
              return (
                <div className="prepare-component" key={`${component.identity ?? "component"}-${index}`}>
                  <span className={`label ${match.className}`} title={match.title}>
                    {match.label}
                  </span>
                  <div>
                    <strong>{component.identity || component.stagedPath || "unknown component"}</strong>
                    <small>
                      {[component.role, component.source, component.revision, component.stagedPath ? tailPath(component.stagedPath) : ""].filter(Boolean).join(" · ")}
                    </small>
                  </div>
                </div>
              );
            })}
            {components.length > 6 ? (
              <button type="button" className="prepare-component prepare-component-more" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Show fewer components" : `Show +${hiddenComponents} more components`}
              </button>
            ) : null}
          </div>
        ) : (
          <EmptyInline>No prepared components have been reported yet.</EmptyInline>
        )}
        {reviewCount ? (
          <details className="prepare-details">
            <summary>
              <span>{blockingIssues.length ? "Review issues" : "Details"}</span>
              <small>{blockingIssues.length ? plural(blockingIssues.length, "issue") : plural(caveats.length, "note")}</small>
            </summary>
            <div className="prepare-lists">
              {blockingIssues.length ? <PrepareList title="Blocking issues" items={blockingIssues} tone="warn" /> : null}
              {caveats.length ? <PrepareList title={summary.auditReady ? "Caveats" : "Notes"} items={caveats} /> : null}
            </div>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

function realTargetSummaryLabel(realTarget?: PrepareSummary["realTarget"]): string {
  if (!realTarget?.reported) return "missing";
  if (realTarget.requiresConfirmation === true) return "real target";
  if (realTarget.requiresConfirmation === false) return "source/artifact";
  return "unspecified";
}

function PrepareRealTargetPanel({ realTarget }: { realTarget?: PrepareSummary["realTarget"] }) {
  if (!realTarget?.reported) {
    return (
      <div className="prepare-real-target warn">
        <div>
          <strong>Real-target confirmation plan missing</strong>
          <small>Prepare must say whether later confirmation uses source-only tests, a released artifact, a service, or a read-only chain fork.</small>
        </div>
      </div>
    );
  }
  const ground = realTarget.groundTruth ?? [];
  const issues = realTarget.issues ?? [];
  const required = realTarget.requiresConfirmation === true;
  const tone = issues.length ? "warn" : required ? "needs-confirm" : "ok";
  const method = realTarget.guidance?.recommendedMethod || realTarget.guidance?.notRequiredReason || realTarget.reason;
  const detail = [realTarget.mode, method].filter(Boolean).join(" · ") || "No method reported";
  const compactDetail = realTargetMethodSummary(realTarget, detail);
  return (
    <div className={`prepare-real-target ${tone}`}>
      <div>
        <strong>{required ? "Real-target confirmation required" : "Source/artifact confirmation"}</strong>
        <small title={detail}>{compactDetail}</small>
      </div>
      {ground.length ? (
        <div className="prepare-ground-truth" aria-label="Real target ground truth">
          {ground.slice(0, 6).map((entry, index) => (
            <span key={`${entry.role ?? "target"}-${entry.address ?? index}`} title={[entry.evidence, entry.stagedComponent].filter(Boolean).join(" · ") || undefined}>
              <strong>{entry.role || entry.kind || "target"}</strong>
              {groundTruthLabel(entry)}
            </span>
          ))}
        </div>
      ) : null}
      {issues.length ? <small className="prepare-real-target-issues">{issues.slice(0, 3).join(" · ")}</small> : null}
    </div>
  );
}

function realTargetLabel(realTarget?: PrepareSummary["realTarget"]): string {
  if (!realTarget?.reported) return "missing";
  if (realTarget.requiresConfirmation === true) return "required";
  if (realTarget.requiresConfirmation === false) return "not required";
  return "unspecified";
}

function groundTruthLabel(entry: NonNullable<NonNullable<PrepareSummary["realTarget"]>["groundTruth"]>[number]): string {
  const chain = entry.kind === "chain" || entry.chainId !== undefined;
  const network = [entry.network, entry.chainId !== undefined ? `#${entry.chainId}` : ""].filter(Boolean).join(" ");
  const target = entry.address ? shortAddress(entry.address) : entry.block || entry.sourceMatch || "";
  return [chain ? network : entry.kind, target].filter(Boolean).join(" · ");
}

function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (/^0x[a-f0-9]{40}$/i.test(trimmed)) return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
  return trimmed.length > 26 ? `${trimmed.slice(0, 16)}…${trimmed.slice(-6)}` : trimmed;
}

function readableScopeDeclaration(value?: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const parts: string[] = [];
    const source = parsed.source;
    if (typeof source === "string" && source.trim()) parts.push(`Source: ${source.trim()}`);
    const basis = parsed.basis;
    if (Array.isArray(basis)) {
      const items = basis.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (items.length) parts.push(`Basis: ${items.slice(0, 2).join(" · ")}`);
    }
    const rule = parsed.in_scope_rule;
    if (typeof rule === "string" && rule.trim()) parts.push(`Scope: ${rule.trim()}`);
    const components = parsed.in_scope_component_ids;
    if (Array.isArray(components)) {
      const names = components.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (names.length) parts.push(`Components: ${names.join(", ")}`);
    }
    return parts.join(" · ") || "Scope declaration reported";
  } catch {
    return value;
  }
}

function PrepareList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  return (
    <div className={`prepare-list ${tone ?? ""}`}>
      <strong>{title}</strong>
      <ul>
        {items.slice(0, 6).map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function tailPath(value: string, parts = 3): string {
  const chunks = value.split("/").filter(Boolean);
  return chunks.length > parts ? `.../${chunks.slice(-parts).join("/")}` : value;
}

function overviewRunDetail(run: RunRow, decisions: ConfirmDecision[]): string {
  const inactive = runInactiveLabel(run);
  if (run.status === "running") return inactive ? `${run.status} · no activity for ${inactive} · ${runProgress(run, decisions)}` : `${run.status} · ${runProgress(run, decisions)}`;
  const pieces = [run.status, fmtTime(run.ended_at ?? run.started_at)];
  if (run.kind === "confirm") {
    const rows = decisions.filter((decision) => decision.run_id === run.id);
    if (rows.length) pieces.push(`${rows.filter((decision) => decision.reproduced === "yes").length}/${rows.length} reproduced`);
  } else if (isVerifyRun(run) && run.run_scopes_target != null) {
    pieces.push(`${run.run_scopes_done ?? 0}/${run.run_scopes_target} candidates checked`);
  } else if (run.run_scopes_target != null) {
    pieces.push(`${run.run_scopes_done ?? 0}/${run.run_scopes_target} scopes in this run`);
  } else if (run.scopes_total != null) {
    pieces.push(`${run.scopes_audited ?? 0}/${run.scopes_total} scopes in this run`);
  } else if (run.findings_total != null) {
    pieces.push(`${run.findings_total} ${run.findings_total === 1 ? "finding" : "findings"}`);
  }
  return pieces.filter(Boolean).join(" · ");
}

function LiveActivityPanel({ run, activeScopeIds, defaultExpanded = false }: { run: RunRow; activeScopeIds?: string[]; defaultExpanded?: boolean }) {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const [activeStreams, setActiveStreams] = useState<string[]>([]);
  const [selectedLane, setSelectedLane] = useState<string | undefined>();
  const [laneSelectionPinned, setLaneSelectionPinned] = useState(false);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const displayedActiveStreams = run.status === "running" && activeScopeIds ? activeScopeIds : activeStreams;
  const hasPipelineActivity = lines.some((line) => !line.streamId);
  const availableLanes = [...displayedActiveStreams, ...(hasPipelineActivity ? [PIPELINE_ACTIVITY_STREAM] : [])];
  const effectiveLane = selectedLane && availableLanes.includes(selectedLane)
    ? selectedLane
    : displayedActiveStreams[0] ?? (hasPipelineActivity ? PIPELINE_ACTIVITY_STREAM : undefined);
  const visibleLines = effectiveLane === PIPELINE_ACTIVITY_STREAM
    ? lines.filter((line) => !line.streamId)
    : effectiveLane
      ? lines.filter((line) => line.streamId === effectiveLane)
      : lines;
  const nonEmptyVisibleLines = visibleLines.filter((line) => Boolean(line.body.trim()));
  const activityScroll = usePinnedScroll(nonEmptyVisibleLines, `${run.id}:${effectiveLane ?? "all"}`);
  useEffect(() => {
    if (!availableLanes.length) return;
    const nextLane = selectedLane && availableLanes.includes(selectedLane)
      ? selectedLane
      : displayedActiveStreams[0] ?? PIPELINE_ACTIVITY_STREAM;
    if (!laneSelectionPinned && displayedActiveStreams.length && selectedLane === PIPELINE_ACTIVITY_STREAM) {
      setSelectedLane(displayedActiveStreams[0]);
    } else if (nextLane !== selectedLane) {
      setSelectedLane(nextLane);
    }
  }, [availableLanes, displayedActiveStreams, laneSelectionPinned, selectedLane]);
  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setActiveStreams([]);
    setSelectedLane(undefined);
    setLaneSelectionPinned(false);
    setFailed(false);
    setConnected(false);
    // The SSE endpoint supplies one deduplicated history replay followed by
    // live-only events. A parallel JSON bootstrap races that replay and used to
    // duplicate the newest tool and reasoning rows.
    const source = new EventSource(`/api/runs/${run.id}/log`);
    source.onopen = () => {
      if (cancelled) return;
      setConnected(true);
      setFailed(false);
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ActivityRecord;
        if (!cancelled) {
          setLines((current) => appendActivityLine(current, event));
          setActiveStreams((current) => updateActiveActivityStreams(current, event));
        }
      } catch {
        // Ignore malformed frames; the status polling still owns run state.
      }
    };
    source.onerror = () => {
      if (cancelled) return;
      setConnected(false);
      setFailed(true);
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [run.id]);
  return (
    <Card>
      <div className="activity-panel" aria-live="polite">
        <div className="activity-head">
          <div>
            <span className="section-title inline">Live activity</span>
            <strong>{runKindLabel(run.kind, run)}</strong>
            <small>Run #{run.id} · {runProgress(run, [])}</small>
          </div>
          <span className={`activity-connection ${connected ? "on" : failed ? "warn" : ""}`}>
            <span className="dot" />
            {connected ? `Live${displayedActiveStreams.length ? ` · ${displayedActiveStreams.length} active` : ""}` : failed ? "Reconnecting" : "Connecting"}
          </span>
        </div>
        {displayedActiveStreams.length ? (
          <div className="activity-lanes" role="tablist" aria-label="Concurrent audit streams">
            {displayedActiveStreams.map((streamId) => {
              const lastStreamLine = [...lines].reverse().find((line) => line.streamId === streamId);
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveLane === streamId}
                  className={effectiveLane === streamId ? "active" : ""}
                  key={streamId}
                  onClick={() => {
                    setSelectedLane(streamId);
                    setLaneSelectionPinned(true);
                  }}
                >
                  <span className="dot" />
                  <span>
                    <strong>{streamId}</strong>
                    <small>{lastStreamLine?.label ?? "Working"}</small>
                  </span>
                </button>
              );
            })}
            {hasPipelineActivity ? (
              <button
                type="button"
                role="tab"
                aria-selected={effectiveLane === PIPELINE_ACTIVITY_STREAM}
                className={effectiveLane === PIPELINE_ACTIVITY_STREAM ? "active" : ""}
                onClick={() => {
                  setSelectedLane(PIPELINE_ACTIVITY_STREAM);
                  setLaneSelectionPinned(true);
                }}
              >
                <span className="pipeline-dot" />
                <span>
                  <strong>Pipeline</strong>
                  <small>Run events</small>
                </span>
              </button>
            ) : null}
          </div>
        ) : null}
        {nonEmptyVisibleLines.length ? (
          <div className="activity-scroll-wrap">
            <div className="activity-timeline" ref={activityScroll.scrollRef} onScroll={activityScroll.onScroll}>
              {nonEmptyVisibleLines.map((line) => (
                <div key={line.id} className={`activity-entry ${line.kind}`}>
                  <span className="activity-dot" />
                  <div className="activity-content">
                    <span className="activity-kicker">
                      <span>{line.label}</span>
                      <span className="activity-meta">
                        {line.streamId ? <span>{line.streamId}</span> : null}
                        {line.meta ? <span>{line.meta}</span> : line.step ? <span>{`Step ${line.step}`}</span> : null}
                        <time dateTime={new Date(line.time).toISOString()}>{formatActivityTime(line.time)}</time>
                      </span>
                    </span>
                    <ActivityBody line={line} defaultExpanded={defaultExpanded} />
                  </div>
                </div>
              ))}
            </div>
            {!activityScroll.isPinned ? <button className="latest-button" type="button" onClick={activityScroll.scrollToBottom}>Latest</button> : null}
          </div>
        ) : (
          <div className="activity-empty">
            <strong>{connected ? effectiveLane && effectiveLane !== PIPELINE_ACTIVITY_STREAM ? `Waiting for ${effectiveLane}` : "Waiting for the first model event" : "Connecting to the run stream"}</strong>
            <span>{connected ? "Thinking, output, and tool calls will appear here as the daemon reports them." : "The panel will attach to the run's live activity feed."}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function QueueItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="queue-item">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ProjectFindings(props: {
  detail: ProjectDetail;
  query: string;
  setQuery: (query: string) => void;
  status: string;
  setStatus: (status: string) => void;
  onOpenReport: (finding: FindingRow) => void;
  onTracking: (finding: FindingRow, status: string) => void;
}) {
  const uuid = props.detail.project.uuid;
  const [rows, setRows] = useState<FindingRow[]>([]);
  const [total, setTotal] = useState(props.detail.findingsTotal ?? 0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [tracking, setTracking] = useState("active");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    setPage(1);
  }, [uuid, props.status, props.query, tracking]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String((safePage - 1) * pageSize),
    });
    if (props.status) params.set("status", props.status);
    if (tracking) params.set("tracking", tracking);
    if (props.query) params.set("q", props.query);
    setLoading(true);
    setError("");
    void api
      .findings(uuid, params)
      .then((res) => {
        if (!alive) return;
        setRows(res.findings);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(String(err instanceof Error ? err.message : err));
        setRows([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [uuid, props.status, props.query, tracking, safePage, pageSize, props.detail.findingsTotal]);

  const empty = props.detail.findingsTotal
    ? "No findings match the current filters."
    : "No findings yet. Findings appear after dig audits mapped scopes and produces a locally checked claim.";
  const requiresConfirmation = needsRealTargetConfirmation(props.detail);
  const allFindings = props.detail.allFindings ?? [];
  const currentRuns = currentMaterialRuns(props.detail.runs, props.detail.material);
  const runningRun = currentRuns.find((run) => run.status === "running");
  const runningVerify = isVerifyRun(runningRun) ? runningRun : undefined;
  const runningVerifyProgress = verifyRunProgress(runningVerify);
  const rawPendingVerify = rawPendingVerifyCount(allFindings);
  const verifyRechecksConfirmed = verifyRunRechecksConfirmed(runningVerify, rawPendingVerify, activeFindings(allFindings).length);
  const journey = [
    {
      label: "Verify candidates",
      count: runningVerifyProgress ? runningVerifyProgress.remaining : pendingVerifyFindings(allFindings).length,
      detail: runningVerifyProgress ? `${runningVerifyProgress.done}/${runningVerifyProgress.target} findings checked in the active Verify run.` : "Candidates that still need local execution proof.",
    },
    {
      label: "Confirm",
      count: verifyRechecksConfirmed ? 0 : pendingConfirmFindings(allFindings, requiresConfirmation, props.detail.confirmDecisions).length,
      detail: verifyRechecksConfirmed ? "Waiting for active Verify to refresh local results." : requiresConfirmation ? "Locally verified findings waiting for real-target reproduction." : "Not required for this source-only target.",
    },
    {
      label: "Report",
      count: requiresConfirmation ? pendingDecisionReports(props.detail.confirmDecisions, allFindings).length : pendingFormalReports(allFindings, requiresConfirmation).length,
      detail: requiresConfirmation ? "Reproduced decisions missing submission reports." : "Source-only confirmed bugs missing formal reports.",
    },
    {
      label: "Track",
      count: allFindings.filter((finding) => finding.has_report && (finding.tracking_status ?? "open") === "open").length,
      detail: "Reported bugs still open for disclosure tracking.",
    },
  ];
  return (
    <div id="project-findings" className="section-anchor">
      <Card title={<span>Findings <Counter>{total}</Counter></span>}>
      <div className="finding-journey" aria-label="Finding workflow summary">
        {journey.map((item) => (
          <div key={item.label} className={item.count > 0 ? "needs-work" : ""}>
            <strong>{item.count}</strong>
            <span>{item.label}</span>
            <small>{item.detail}</small>
          </div>
        ))}
      </div>
      <div className="table-tools">
        <input className="searchbar" value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search findings..." aria-label="Search findings" />
        <select value={props.status} onChange={(event) => props.setStatus(event.target.value)} aria-label="Filter finding status">
          <option value="">All statuses</option>
          <option value="execution-confirmed">Execution confirmed</option>
          {STATUSES.map((status) => <option key={status} value={status}>{findingStatusOptionLabel(status)}</option>)}
        </select>
        <select value={tracking} onChange={(event) => setTracking(event.target.value)} aria-label="Filter finding tracking">
          <option value="active">Active findings</option>
          <option value="">All tracking states</option>
          {TRACKING.map((status) => <option key={status} value={status}>{findingTrackingOptionLabel(status)}</option>)}
        </select>
      </div>
      {error ? <EmptyInline>{error}</EmptyInline> : loading && rows.length === 0 ? <EmptyInline>Loading findings...</EmptyInline> : (
        <FindingTable
          rows={rows}
          total={total}
          page={safePage}
          pageSize={pageSize}
          paginationKey={`${props.status}:${tracking}:${props.query}`}
          empty={empty}
          onPage={setPage}
          onPageSize={setPageSize}
          onOpenReport={props.onOpenReport}
          onTracking={props.onTracking}
        />
      )}
      </Card>
    </div>
  );
}

function ScopesView({ detail, onPatchScope }: { detail: ProjectDetail; onPatchScope: (scopeId: string, body: unknown) => Promise<void> | void }) {
  const uuid = detail.project.uuid;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [scopes, setScopes] = useState<ScopeRow[]>([]);
  const [total, setTotal] = useState(detail.progress.total ?? 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String((safePage - 1) * pageSize),
    });
    setLoading(true);
    setError("");
    void api
      .scopes(uuid, params)
      .then((res) => {
        if (!alive) return;
        setScopes(res.scopes);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(String(err instanceof Error ? err.message : err));
        setScopes([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [uuid, safePage, pageSize, detail.progress.total, reloadKey]);

  const patchScope = (scopeId: string, body: unknown) => {
    void Promise.resolve(onPatchScope(scopeId, body)).finally(() => setReloadKey((key) => key + 1));
  };

  return (
    <Card title={<span>Scopes <Counter>{total}</Counter></span>}>
      {error ? <EmptyInline>{error}</EmptyInline> : loading && scopes.length === 0 ? (
        <EmptyInline>Loading scopes...</EmptyInline>
      ) : scopes.length ? (
        <>
          <div className="scope-list">
            {scopes.map((scope) => (
              <div className="scope-row" key={scope.scope_id}>
                <span className="scope-label-stack">
                  <span className={`label s-${scope.status}`}>{scope.status}</span>
                  {scope.source === "followup" ? <span className="label s-followup">Follow-up</span> : null}
                </span>
                <div>
                  <strong>{scope.title || scope.scope_id}</strong>
                  <small>{scope.location || scope.scope_id}{scope.parent_scope_id ? ` · parent ${scope.parent_scope_id}` : ""}</small>
                </div>
                <span className="score">{scope.score ?? scope.priority ?? ""}</span>
                <div className="row-actions">
                  {scope.status === "pending" || scope.status === "auditing" ? <Button size="sm" onClick={() => patchScope(scope.scope_id, { prioritize: true })}>Top</Button> : null}
                  {scope.status === "pending" || scope.status === "auditing" ? <Button size="sm" onClick={() => patchScope(scope.scope_id, { status: "deferred" })}>Skip</Button> : null}
                  {scope.status === "deferred" ? <Button size="sm" onClick={() => patchScope(scope.scope_id, { status: "pending" })}>Resume</Button> : null}
                </div>
              </div>
            ))}
          </div>
          <PaginationControls
            total={total}
            page={safePage}
            pageSize={pageSize}
            label="scope"
            onPage={setPage}
            onPageSize={setPageSize}
          />
        </>
      ) : total > 0 ? (
        <>
          <EmptyInline>No scopes on this page. Use pagination to return to a populated page.</EmptyInline>
          <PaginationControls
            total={total}
            page={safePage}
            pageSize={pageSize}
            label="scope"
            onPage={setPage}
            onPageSize={setPageSize}
          />
        </>
      ) : (
        <EmptyInline>No scopes mapped yet. Run the pipeline or Map scopes to create the scope inventory before digging.</EmptyInline>
      )}
    </Card>
  );
}

function RunsView({ detail, onStopRun, onOpenLog }: { detail: ProjectDetail; onStopRun: (run: RunRow) => void; onOpenLog: (run: RunRow) => void }) {
  return (
    <Card title={<span>Runs <Counter>{detail.runs.length}</Counter></span>}>
      {detail.runs.length ? (
        <div className="run-list">
          {detail.runs.map((run) => (
            <div key={run.id} className="run-row">
              <StateBadge status={run.status} />
              <div>
                <strong>{runKindLabel(run.kind, run)}</strong>
                <small>{runProgress(run, detail.confirmDecisions)}</small>
                {run.job_error ? <small className="run-error">{run.job_error}</small> : null}
              </div>
              <code>{run.run_dir?.split("/").pop() ?? "-"}</code>
              <span>{fmtTime(run.started_at)}</span>
              <div className="row-actions">
                <Button size="sm" onClick={() => onOpenLog(run)}>{run.status === "error" ? "Error log" : "Log"}</Button>
                {run.status === "running" ? <Button size="sm" variant="danger" icon="x" onClick={() => onStopRun(run)}>Stop</Button> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyInline>No runs yet. Start Run to execute the automatic pipeline.</EmptyInline>
      )}
    </Card>
  );
}

function GlobalFindingsView(props: {
  stats: BugStats;
  projects: ProjectSnapshot[];
  findings: FindingRow[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string;
  projectUuid: string;
  source: "project" | "evaluation" | "all";
  status: string;
  tracking: string;
  setProjectUuid: (projectUuid: string) => void;
  setSource: (source: "project" | "evaluation" | "all") => void;
  setStatus: (status: string) => void;
  setTracking: (tracking: string) => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  onTracking: (finding: FindingRow, status: string) => void;
  onOpenProject: (uuid: string) => void;
  onOpenEvaluation: (uuid: string) => void;
  onOpenReport: (finding: FindingRow) => void;
}) {
  const views = savedBugViews(props.stats)
    .filter((view) => props.source !== "evaluation" || !["submitted", "accepted", "ignored"].includes(view.id))
    .map((view) => props.source === "evaluation" ? { ...view, tracking: undefined } : view);
  const activeView = views.find((view) => (view.status ?? "") === props.status && (view.tracking ?? "") === props.tracking)?.id ?? "custom";
  const selectedProject = props.projects.find((project) => project.uuid === props.projectUuid);
  return (
    <main className="full-view findings-view">
      <Card>
        <div className="page-head">
          <div>
            <h1>{selectedProject ? `Findings for ${selectedProject.name}` : props.source === "evaluation" ? "Evaluation findings" : props.source === "all" ? "Findings across all sources" : "Findings across projects"}</h1>
            <p>{props.source === "evaluation" ? "Execution evidence produced by Evaluation run groups; kept separate from disclosure tracking by default." : "Submission tracking from discovery through real-target confirmation and vendor disclosure."}</p>
          </div>
          <div className="headline-stats">
            {props.source === "evaluation" ? (
              <>
                <Stat n={props.stats.total} label="evidence items" />
                <Stat n={(props.stats.byStatus["confirmed-differential"] ?? 0) + (props.stats.byStatus["confirmed-executable"] ?? 0)} label="audit confirmed" good />
                <Stat n={props.stats.byStatus.suspected ?? 0} label="needs triage" />
                <Stat n={props.stats.byStatus["needs-evidence"] ?? 0} label="needs evidence" />
              </>
            ) : (
              <>
                <Stat n={props.stats.active ?? props.stats.total} label="active" />
                <Stat n={(props.stats.byStatus["confirmed-differential"] ?? 0) + (props.stats.byStatus["confirmed-executable"] ?? 0)} label="audit confirmed" good />
                <Stat n={props.stats.byTracking.submitted ?? 0} label="submitted" />
                <Stat n={props.stats.byTracking.ignored ?? 0} label="ignored" />
              </>
            )}
          </div>
        </div>
        <div className="saved-views">
          {views.map((view) => (
            <button
              key={view.id}
              className={activeView === view.id ? "sel" : ""}
              onClick={() => {
                props.setStatus(view.status ?? "");
                props.setTracking(view.tracking ?? "");
              }}
            >
              {view.label} <span>{view.count}</span>
            </button>
          ))}
        </div>
        <div className="table-tools">
          <select value={props.source} onChange={(event) => props.setSource(event.target.value as "project" | "evaluation" | "all")} aria-label="Filter findings by source">
            <option value="project">Project findings</option>
            <option value="evaluation">Evaluation evidence</option>
            <option value="all">All sources</option>
          </select>
          {props.source !== "evaluation" ? (
            <select value={props.projectUuid} onChange={(event) => props.setProjectUuid(event.target.value)} aria-label="Filter findings by project">
              <option value="">All projects</option>
              {props.projects.map((project) => (
                <option key={project.uuid} value={project.uuid}>{project.name}{project.archived_at ? " (archived)" : ""}</option>
              ))}
            </select>
          ) : null}
          <select value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
            <option value="">All audit statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{findingStatusOptionLabel(status)}</option>)}
          </select>
          {props.source !== "evaluation" ? (
            <select value={props.tracking} onChange={(event) => props.setTracking(event.target.value)}>
              <option value="active">Active findings</option>
              <option value="">All tracking states</option>
              {TRACKING.map((status) => <option key={status} value={status}>{findingTrackingOptionLabel(status)}</option>)}
            </select>
          ) : null}
        </div>
      </Card>
      {props.error ? (
        <EmptyInline>{props.error}</EmptyInline>
      ) : props.loading && props.findings.length === 0 ? (
        <EmptyInline>Loading findings...</EmptyInline>
      ) : props.findings.length ? (
        <Card>
          <FindingTable
            rows={props.findings}
            total={props.total}
            page={props.page}
            pageSize={props.pageSize}
            paginationKey={`${props.source}:${props.projectUuid}:${props.status}:${props.tracking}`}
            global
            onPage={props.setPage}
            onPageSize={props.setPageSize}
            onOpenProject={props.onOpenProject}
            onOpenEvaluation={props.onOpenEvaluation}
            onOpenReport={props.onOpenReport}
            onTracking={props.onTracking}
          />
        </Card>
      ) : (
        <EmptyInline>{props.stats.total > 0 ? "No findings match the current filters." : "No findings yet. Suspected and confirmed issues appear here after a project runs."}</EmptyInline>
      )}
    </main>
  );
}

function FindingList({ findings, compact, empty, onOpenReport }: { findings: FindingRow[]; compact?: boolean; empty?: string; onOpenReport: (finding: FindingRow) => void }) {
  if (!findings.length) return <EmptyInline>{empty ?? "No findings match this view."}</EmptyInline>;
  return (
    <div className={compact ? "candidate-list compact" : "candidate-list"}>
      {findings.map((finding, index) => {
        const origin = findingOriginBadge(finding);
        return (
          <button key={finding.id} className="candidate-row" onClick={() => onOpenReport(finding)}>
            <span className="rank">{index + 1}</span>
            <span className="grow">
              <strong>{finding.title}</strong>
              <small>{finding.location}</small>
              {duplicateOfLabel(finding) ? <small>{duplicateOfLabel(finding)}</small> : null}
            </span>
            <span className="candidate-meta">
              {origin ? <span className="label origin-label" title={origin.title}>{origin.label}</span> : null}
              <StatusBadge status={finding.status} />
              <FindingChecks finding={finding} />
              <SeverityBadge value={finding.severity} />
              <ConfidenceBadge value={finding.confidence} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

type LifecycleRailState = "done" | "running" | "blocked" | "pending";

function FindingLifecycleRail({ finding, onOpen }: { finding: FindingRow; onOpen: () => void }) {
  const attempts = finding.phase_attempts ?? [];
  const verify = latestAttempt(attempts, "verify");
  const confirm = latestAttempt(attempts, "confirm");
  const report = latestAttempt(attempts, "report");
  const evidenceConflict = hasUnresolvedEvidenceConflict(finding);
  const localSettled = finding.status === "confirmed-source" || finding.status === "confirmed-executable" || finding.status === "confirmed-differential" || finding.status === "refuted";
  const disclosureDone = ["submitted", "accepted", "fixed", "rejected", "duplicate"].includes(finding.tracking_status ?? "open");
  const phases: Array<{ label: string; state: LifecycleRailState; detail: string }> = [
    { label: "Found", state: "done", detail: (finding.occurrence_count ?? 1) > 1 ? `${finding.occurrence_count} recorded occurrences` : "Canonical finding recorded" },
    {
      label: "Local",
      state: evidenceConflict ? "blocked" : localSettled ? "done" : attemptState(verify),
      detail: evidenceConflict
        ? finding.refutation_reason ?? "Local verification conflicts with real-target reproduction; human review is required"
        : finding.refutation_status === "blocked"
        ? `Independent review blocked: ${finding.refutation_reason ?? "no verdict"}`
        : verify?.blocker || (localSettled ? finding.status.replaceAll("-", " ") : "Waiting for executable evidence"),
    },
    { label: "Target", state: finding.confirm_status ? "done" : attemptState(confirm), detail: confirm?.blocker || (finding.confirm_status ? `Real target: ${finding.confirm_status}` : "Real-target confirmation pending") },
    { label: "Report", state: finding.has_report ? "done" : evidenceConflict ? "blocked" : attemptState(report), detail: evidenceConflict && !finding.has_report ? "Held until the evidence conflict is resolved" : report?.blocker || (finding.has_report ? "Formal report ready" : "Formal report pending") },
    { label: "Disclose", state: disclosureDone ? "done" : evidenceConflict ? "blocked" : "pending", detail: disclosureDone ? `Tracking: ${finding.tracking_status}` : evidenceConflict ? "Held for human evidence review" : "Not yet submitted" },
  ];
  const focus = phases.find((phase) => phase.state === "running" || phase.state === "blocked") ?? phases.find((phase) => phase.state === "pending") ?? phases[phases.length - 1]!;
  return (
    <button type="button" className="lifecycle-summary-button" onClick={onOpen} aria-label={`Open lifecycle for ${finding.title ?? "finding"}`} title={focus.detail}>
      <span className={`label lifecycle-state ${focus.state}`}>{focus.label} · {focus.state}</span>
      <small className={focus.state === "blocked" ? "lifecycle-focus blocked" : "lifecycle-focus"}>{focus.detail}</small>
    </button>
  );
}

function latestAttempt(attempts: FindingPhaseAttempt[], phase: FindingPhase): FindingPhaseAttempt | undefined {
  return attempts.filter((attempt) => attempt.phase === phase).sort((a, b) => b.attempt_number - a.attempt_number)[0];
}

function attemptState(attempt?: FindingPhaseAttempt): LifecycleRailState {
  if (!attempt) return "pending";
  if (attempt.state === "running") return "running";
  if (attempt.state === "blocked" || attempt.state === "error") return "blocked";
  return "done";
}

function FindingTable({
  rows,
  global,
  empty,
  paginationKey,
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
  onOpenProject,
  onOpenEvaluation,
  onOpenReport,
  onTracking,
}: {
  rows: FindingRow[];
  global?: boolean;
  empty?: string;
  paginationKey?: string;
  total?: number;
  page?: number;
  pageSize?: number;
  onPage?: (page: number) => void;
  onPageSize?: (pageSize: number) => void;
  onOpenProject?: (uuid: string) => void;
  onOpenEvaluation?: (uuid: string) => void;
  onOpenReport: (finding: FindingRow) => void;
  onTracking: (finding: FindingRow, status: string) => void;
}) {
  const controlled = total !== undefined && page !== undefined && pageSize !== undefined && typeof onPage === "function" && typeof onPageSize === "function";
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(DEFAULT_PAGE_SIZE);
  const activeTotal = controlled ? total : rows.length;
  const activePageSize = controlled ? pageSize : localPageSize;
  const pageCount = Math.max(1, Math.ceil(activeTotal / activePageSize));
  const safePage = Math.min(controlled ? page : localPage, pageCount);
  const pageRows = controlled ? rows : rows.slice((safePage - 1) * activePageSize, safePage * activePageSize);

  useEffect(() => {
    if (!controlled) setLocalPage(1);
  }, [paginationKey]);

  useEffect(() => {
    if (!controlled && localPage > pageCount) setLocalPage(pageCount);
  }, [controlled, localPage, pageCount]);

  if (!rows.length) return <EmptyInline>{empty ?? "No findings in this view."}</EmptyInline>;
  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {global ? <th>Source</th> : null}
              <th>Finding</th>
              <th>Evidence</th>
              <th>Workflow</th>
              <th>Tracking</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((finding) => {
              const workflow = findingWorkflow(finding);
              return (
                <tr key={finding.id}>
                  {global ? (
                    <td className="project-cell">
                      {finding.source === "evaluation" ? (
                        <>
                          {finding.evaluation_uuid ? (
                            <button type="button" className="table-link" onClick={() => onOpenEvaluation?.(finding.evaluation_uuid!)}>{finding.evaluation_name ?? "Evaluation"}</button>
                          ) : <span>{finding.evaluation_name ?? "Evaluation"}</span>}
                          <small>Evaluation evidence</small>
                        </>
                      ) : finding.project_uuid ? (
                        <button type="button" className="table-link" onClick={() => onOpenProject?.(finding.project_uuid!)}>{finding.project_name}</button>
                      ) : finding.project_name}
                    </td>
                  ) : null}
                  <td className="finding-cell">
                    <strong>{finding.title || "Untitled finding"}</strong>
                    <small>{finding.location || "No location"}{finding.scope_id ? ` · ${finding.scope_id}` : ""}</small>
                    {(finding.occurrence_count ?? 1) > 1 ? <small className="occurrence-note">Seen in {plural(finding.occurrence_count ?? 1, "run")}</small> : null}
                    {duplicateOfLabel(finding) ? <small>{duplicateOfLabel(finding)}</small> : null}
                  </td>
                  <td className="evidence-cell">
                    <StatusBadge status={finding.status} />
                    <FindingChecks finding={finding} />
                    <span className="finding-evidence-meta">
                      <SeverityBadge value={finding.severity} />
                      <ConfidenceBadge value={finding.confidence} />
                    </span>
                  </td>
                  <td className="workflow-cell">
                    {finding.source === "evaluation" ? (
                      <><span className={`label ${workflow.className}`}>{workflow.label}</span><small>{workflow.detail}</small></>
                    ) : (
                      <FindingLifecycleRail finding={finding} onOpen={() => onOpenReport(finding)} />
                    )}
                  </td>
                  <td className="tracking-cell">
                    {finding.source === "evaluation" ? (
                      <span className="label" title="Evaluation evidence is scored in its run group, not tracked as a disclosure candidate.">Evaluation only</span>
                    ) : (
                      <select value={finding.tracking_status ?? "open"} onChange={(event) => onTracking(finding, event.target.value)} aria-label={`Tracking for ${finding.title ?? "finding"}`}>
                        {TRACKING.map((status) => <option key={status} value={status}>{findingTrackingOptionLabel(status)}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="row-action-cell"><Button size="sm" icon="file" onClick={() => onOpenReport(finding)}>{finding.source === "evaluation" ? "Evidence" : finding.has_report ? "Open" : "Report"}</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <PaginationControls
        total={activeTotal}
        page={safePage}
        pageSize={activePageSize}
        label="finding"
        onPage={controlled ? onPage : setLocalPage}
        onPageSize={controlled ? onPageSize : setLocalPageSize}
      />
    </>
  );
}

function StorageWarningBanner() {
  const [disk, setDisk] = useState<DiskStorageStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api.storageDisk();
        if (!cancelled) setDisk(result.disk);
      } catch {
        // Storage visibility is helpful but must not make the audit dashboard unusable.
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);
  if (!disk || disk.pressure === "healthy") return null;
  return (
    <button className={`storage-warning ${disk.pressure}`} onClick={() => go("/settings/storage")}>
      <strong>{disk.pressure === "critical" ? "Storage critically low" : "Storage running low"}</strong>
      <span>{storageSize(disk.freeBytes)} free · Review project usage</span>
    </button>
  );
}

function StoragePane() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [disk, setDisk] = useState<DiskStorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ProjectStorageCleanupResult | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await api.storage();
      setOverview(result);
      setDisk(result.disk);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void api.storageDisk().then((result) => setDisk(result.disk)).catch(() => undefined);
    void load();
  }, []);

  async function preview(project: ProjectStorageUsage) {
    setError("");
    try {
      setPending(await api.cleanupProjectStorage(project.projectUuid, false));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function applyCleanup() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await api.cleanupProjectStorage(pending.projectUuid, true);
      setPending(null);
      await load();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <div className="pane-head">
          <div>
            <h1>Storage</h1>
            <p>See which local projects consume disk and remove completed project files without deleting database history.</p>
          </div>
          <div className="pane-actions">
            <Button icon="sync" onClick={() => void load()} disabled={loading}>{loading ? "Scanning..." : "Refresh"}</Button>
          </div>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        {disk ? (
          <div className={`storage-pressure-card ${disk.pressure}`}>
            <div>
              <strong>{storageSize(disk.freeBytes)} free</strong>
              <span>{disk.usedPercent}% of {storageSize(disk.totalBytes)} used</span>
            </div>
            <div className="storage-meter" aria-label={`${disk.usedPercent}% disk used`}>
              <span style={{ width: `${Math.min(100, disk.usedPercent)}%` }} />
            </div>
          </div>
        ) : null}
        {loading && !overview ? <EmptyInline>Scanning run, history, and workspace directories. Large audit homes can take a few minutes.</EmptyInline> : null}
        {overview ? (
          <>
            <div className="storage-totals">
              <span><strong>{storageSize(overview.outputBytes)}</strong><small>Flounder output</small></span>
              <span><strong>{storageSize(overview.managedProjectBytes)}</strong><small>Project-owned</small></span>
              <span><strong>{storageSize(overview.unattributedBytes)}</strong><small>Shared / unattributed</small></span>
            </div>
            <div className="resource-list storage-project-list">
              {overview.projects.map((project) => (
                <div className="resource-card storage-project-card" key={project.projectUuid}>
                  <span className="grow">
                    <strong>{project.projectName}</strong>
                    <small>
                      Runs {storageSize(project.runBytes)} · History {storageSize(project.historyBytes)} · Workspace {storageSize(project.workspaceBytes)}
                    </small>
                    <small>
                      {project.artifactDirectories} directories
                      {project.orphanRunDirectories ? ` · ${project.orphanRunDirectories} orphaned runs found` : ""}
                      {project.missingRunDirectories ? ` · ${project.missingRunDirectories} database paths already removed` : ""}
                    </small>
                  </span>
                  <span className="storage-project-size">
                    <strong>{storageSize(project.totalBytes)}</strong>
                    <small>{project.active ? "Active - protected" : project.metadataOnly ? "Metadata only" : "Reclaimable"}</small>
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    disabled={project.active || project.reclaimableBytes <= 0}
                    onClick={() => void preview(project)}
                  >Keep metadata only</Button>
                </div>
              ))}
            </div>
            <p className="storage-footnote">The database is never deleted by storage cleanup. Remote-daemon files are shown only when their paths are mounted on this control-plane machine.</p>
          </>
        ) : null}
      </Card>
      {pending ? (
        <Modal
          title="Keep database records only?"
          onClose={() => { if (!busy) setPending(null); }}
          footer={(
            <>
              <Button onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
              <Button variant="danger" icon="trash" onClick={() => void applyCleanup()} disabled={busy}>
                {busy ? "Removing files..." : `Release ${storageSize(pending.reclaimableBytes)}`}
              </Button>
            </>
          )}
        >
          <div className="confirm-copy">
            <strong>{pending.projectName} has {pending.candidateDirectories} local directories using {storageSize(pending.reclaimableBytes)}.</strong>
            <p>This removes run artifacts, build history, and the configured project workspace. Project, run, scope, finding, and decision records remain in Flounder's database.</p>
            <p>Artifact files and local reproduction workspaces will no longer open. A future audit must stage or acquire the source again.</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function storageSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function SettingsView({
  pane,
  providers,
  daemons,
  archivedProjects,
  archivedTotal,
  archivedLoading,
  onRefresh,
  onUnarchive,
  onDeleteRequest,
  onLoadMoreArchived,
}: {
  pane: SettingsPane;
  providers: ProviderProfile[];
  daemons: DaemonRow[];
  archivedProjects: ProjectSnapshot[];
  archivedTotal: number;
  archivedLoading: boolean;
  onRefresh: () => Promise<void>;
  onUnarchive: (project: ProjectSnapshot) => void;
  onDeleteRequest: (project: ProjectSnapshot) => void;
  onLoadMoreArchived: () => void;
}) {
  return (
    <main className="settings-view">
      <aside className="settings-rail">
        <h1>Settings</h1>
        <button className={pane === "providers" ? "sel" : ""} onClick={() => go("/settings")}>Providers</button>
        <button className={pane === "daemons" ? "sel" : ""} onClick={() => go("/settings/daemons")}>Daemons</button>
        <button className={pane === "storage" ? "sel" : ""} onClick={() => go("/settings/storage")}>Storage</button>
        <button className={pane === "archived" ? "sel" : ""} onClick={() => go("/settings/archived")}>Archived Projects</button>
      </aside>
      <section className="settings-content">
        {pane === "providers" ? <ProvidersPane providers={providers} onRefresh={onRefresh} /> : null}
        {pane === "daemons" ? <DaemonsPane daemons={daemons} onRefresh={onRefresh} /> : null}
        {pane === "storage" ? <StoragePane /> : null}
        {pane === "archived" ? (
          <ArchivedProjectsPane
            projects={archivedProjects}
            total={archivedTotal}
            loading={archivedLoading}
            onUnarchive={onUnarchive}
            onDeleteRequest={onDeleteRequest}
            onLoadMore={onLoadMoreArchived}
          />
        ) : null}
      </section>
    </main>
  );
}

function ArchivedProjectsPane({
  projects,
  total,
  loading,
  onUnarchive,
  onDeleteRequest,
  onLoadMore,
}: {
  projects: ProjectSnapshot[];
  total: number;
  loading: boolean;
  onUnarchive: (project: ProjectSnapshot) => void;
  onDeleteRequest: (project: ProjectSnapshot) => void;
  onLoadMore: () => void;
}) {
  const visibleTotal = Math.max(total, projects.length);
  return (
    <Card>
      <div className="pane-head">
        <div>
          <h1>Archived projects</h1>
          <p>Archived projects are hidden from the project rail but keep their runs, scopes, findings, and reports.</p>
        </div>
        <div className="pane-actions">
          <Counter>{visibleTotal > projects.length ? `${projects.length}/${visibleTotal}` : visibleTotal}</Counter>
        </div>
      </div>
      {projects.length ? (
        <div className="resource-list">
          {projects.map((project) => (
            <div key={project.uuid} className="resource-card archived-project-card">
              <span className="avatar">{project.name.slice(0, 2).toUpperCase()}</span>
              <span className="grow">
                <strong>{project.name}</strong>
                <small>
                  {project.archived_at ? `Archived ${fmtTime(project.archived_at)}` : "Archived"} · {project.created_at ? `Created ${fmtTime(project.created_at)}` : "Created time unavailable"}
                </small>
              </span>
              <span className="resource-actions">
                <Button size="sm" icon="sync" onClick={() => onUnarchive(project)}>Unarchive</Button>
                <Button size="sm" variant="danger" icon="trash" onClick={() => onDeleteRequest(project)}>Delete</Button>
              </span>
            </div>
          ))}
          {projects.length < visibleTotal ? (
            <div className="resource-list-more">
              <Button size="sm" icon="sync" onClick={onLoadMore} disabled={loading}>
                {loading ? "Loading..." : `Load more (${visibleTotal - projects.length})`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyInline>No archived projects.</EmptyInline>
      )}
    </Card>
  );
}

function ProvidersPane({ providers, onRefresh }: { providers: ProviderProfile[]; onRefresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function deleteProvider(provider: ProviderProfile) {
    try {
      await api.deleteProvider(provider.id);
      setPendingDelete(null);
      await onRefresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }
  return (
    <Card>
      <div className="pane-head">
        <div>
          <h1>Provider profiles</h1>
          <p>A profile selects the model vendor. Credentials stay on each daemon; projects choose phase-level models from this base.</p>
        </div>
        <div className="pane-actions">
          <Counter>{providers.length}</Counter>
          <Button variant="primary" icon="package" onClick={() => { setCreating(true); setEditing(null); setError(""); }}>New Provider</Button>
        </div>
      </div>
      <details className="info-panel executor-setup">
        <summary>
          <strong>Authentication lives on each daemon.</strong>
          <small>Provider login and check commands</small>
        </summary>
        <span>Run <code>flounder daemon provider login &lt;provider&gt;</code> on every executor machine, or start <code>flounder daemon start</code> with that provider's required environment variables. The server stores provider/model choices only, never API keys.</span>
        <code>flounder daemon provider check openai-codex</code>
      </details>
      {error ? <div className="inline-error">{error}</div> : null}
      {creating || editing ? (
        <ProviderForm
          provider={editing}
          onCancel={() => { setCreating(false); setEditing(null); setError(""); }}
          onSaved={async () => { setCreating(false); setEditing(null); setError(""); await onRefresh(); }}
          onError={setError}
        />
      ) : null}
      <div className="resource-list">
        {providers.map((provider) => (
          <div key={provider.id} className="resource-card">
            <span className="avatar">{provider.provider.slice(0, 2).toUpperCase()}</span>
            <span className="grow">
              <strong>{provider.name}</strong>
              <small>{provider.provider}{provider.model ? ` · ${provider.model}` : ""}{provider.thinking ? ` · ${provider.thinking}` : ""}</small>
              <small className="resource-command">daemon auth: flounder daemon provider check {provider.provider}</small>
            </span>
            {pendingDelete === provider.id ? (
              <span className="row-actions">
                <Button size="sm" variant="danger" onClick={() => void deleteProvider(provider)}>Confirm delete</Button>
                <Button size="sm" onClick={() => setPendingDelete(null)}>Cancel</Button>
              </span>
            ) : (
              <span className="row-actions">
                <IconButton icon="pencil" title={`Edit ${provider.name}`} aria-label={`Edit ${provider.name}`} onClick={() => { setEditing(provider); setCreating(false); setError(""); }} />
                <IconButton className="danger" icon="trash" title={`Delete ${provider.name}`} aria-label={`Delete ${provider.name}`} onClick={() => setPendingDelete(provider.id)} />
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function preferredThinkingLevel(levels: readonly string[]): string {
  for (const level of ["xhigh", "high", "medium", "low", "minimal", "off"]) {
    if (levels.includes(level)) return level;
  }
  return levels[0] ?? "off";
}

function ProviderForm({ provider, onCancel, onSaved, onError }: { provider: ProviderProfile | null; onCancel: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [form, setForm] = useState({
    name: provider?.name ?? "",
    provider: provider?.provider ?? "openai-codex",
    model: provider?.model ?? "",
    thinking: provider?.thinking ?? "xhigh",
  });
  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const [modelOptions, setModelOptions] = useState<PiModel[]>([]);
  const [providerLoadError, setProviderLoadError] = useState("");
  useEffect(() => {
    void api
      .piProviders()
      .then((res) => {
        setProviderOptions(res.providers);
        setProviderLoadError("");
      })
      .catch((error: unknown) => setProviderLoadError(String(error instanceof Error ? error.message : error)));
  }, []);
  useEffect(() => {
    let cancelled = false;
    setModelOptions([]);
    if (!form.provider.trim()) return;
    void api
      .piModels(form.provider.trim())
      .then((res) => {
        if (!cancelled) setModelOptions(res.models);
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.provider]);
  const selectedModel = modelOptions.find((model) => model.id === form.model.trim());
  const knownModelLevels = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : null;
  const allowProviderDefaultThinking = form.model.trim().length === 0 || !knownModelLevels;
  const thinkingChoices = knownModelLevels ?? THINKING_LEVELS;
  useEffect(() => {
    if (!knownModelLevels || knownModelLevels.includes(form.thinking)) return;
    setForm((current) => {
      const currentModel = current.model.trim();
      const stillSelected = modelOptions.find((model) => model.id === currentModel);
      const levels = stillSelected?.thinkingLevels?.length ? stillSelected.thinkingLevels : null;
      if (!levels || levels.includes(current.thinking)) return current;
      return { ...current, thinking: preferredThinkingLevel(levels) };
    });
  }, [form.model, form.thinking, knownModelLevels, modelOptions]);
  const providerChoices = [...new Set([form.provider, ...providerOptions].filter(Boolean))].sort();
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api.saveProvider(provider?.id ?? null, {
        name: form.name.trim(),
        provider: form.provider.trim(),
        model: form.model.trim() || undefined,
        thinking: form.thinking || undefined,
      });
      await onSaved();
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <form className="inline-editor" onSubmit={(event) => void submit(event)}>
      <label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={`openai-codex · ${DEFAULT_OPENAI_CODEX_MODEL} · xhigh`} /></label>
      <label>Provider<select required value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value, model: "" })}>{providerChoices.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>Model<input list="provider-model-options" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="provider default" /><datalist id="provider-model-options">{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</datalist></label>
      <label>Thinking<select value={form.thinking} onChange={(event) => setForm({ ...form, thinking: event.target.value })}>
        {allowProviderDefaultThinking ? <option value="">provider default</option> : null}
        {thinkingChoices.map((level) => <option key={level} value={level}>{level}</option>)}
      </select></label>
      {providerLoadError ? <div className="inline-error compact">{providerLoadError}</div> : null}
      <div className="inline-editor-actions">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit">{provider ? "Save profile" : "Create profile"}</Button>
      </div>
    </form>
  );
}

function DaemonsPane({ daemons, onRefresh }: { daemons: DaemonRow[]; onRefresh: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (created) setSetupOpen(true);
  }, [created]);
  const groups = {
    online: daemons.filter((d) => daemonHealth(d) === "online"),
    recent: daemons.filter((d) => daemonHealth(d) === "recent"),
    stale: daemons.filter((d) => daemonHealth(d) === "stale"),
  };
  async function revokeDaemon(daemon: DaemonRow) {
    try {
      await api.deleteDaemon(daemon.id);
      setPendingDelete(null);
      await onRefresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }
  const daemonCommand = created ? `flounder daemon start --server ${window.location.origin} --token ${created.token}` : "";
  return (
    <Card>
      <div className="pane-head">
        <div>
          <h1>Daemons</h1>
          <p>Execution-plane clients claim queued jobs. Online daemons are the only resources that can start work immediately.</p>
        </div>
        <Button variant="primary" icon="package" onClick={() => { setCreating(true); setError(""); }}>New Daemon</Button>
      </div>
      <details className="info-panel executor-setup" open={setupOpen} onToggle={(event) => setSetupOpen(event.currentTarget.open)}>
        <summary>
          <strong>Setup local executor</strong>
          <small>{created ? "Token minted. Run the command below on the daemon machine." : "Connection command and provider auth checks"}</small>
        </summary>
        <span>Click <strong>New Daemon</strong> to mint a token, then run the printed command in another terminal. Before starting work, authenticate the selected providers on that daemon machine with <code>flounder daemon provider login &lt;provider&gt;</code> or provider-specific environment variables.</span>
        <code>{created ? daemonCommand : `flounder daemon start --server ${window.location.origin} --token <token>`}</code>
        <code>flounder daemon provider check openai-codex</code>
        <span>Project paths resolve under the daemon workspace. The default is ~/.flounder/workspace; pass --workspace to use another root.</span>
      </details>
      {error ? <div className="inline-error">{error}</div> : null}
      {creating ? (
        <DaemonCreateForm
          onCancel={() => setCreating(false)}
          onCreated={async (daemon) => {
            setCreated(daemon);
            setCreating(false);
            await onRefresh();
          }}
          onError={setError}
        />
      ) : null}
      {created ? (
        <div className="token-panel">
          <div>
            <strong>{created.name} token</strong>
            <small>Shown once. Run this command in another terminal to connect an executor to this UI server.</small>
          </div>
          <code>{daemonCommand}</code>
          <span className="token-actions">
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(daemonCommand)}>Copy command</Button>
            <Button size="sm" onClick={() => setCreated(null)}>Dismiss</Button>
          </span>
        </div>
      ) : null}
      <DaemonGroup title="Online" daemons={groups.online} empty="No daemon is connected right now. Runs can be queued, but nothing will execute until a daemon connects." pendingDelete={pendingDelete} onPendingDelete={setPendingDelete} onDelete={(daemon) => void revokeDaemon(daemon)} />
      <DaemonGroup title="Recently seen" daemons={groups.recent} collapsed pendingDelete={pendingDelete} onPendingDelete={setPendingDelete} onDelete={(daemon) => void revokeDaemon(daemon)} />
      <DaemonGroup title="Stale history" daemons={groups.stale} collapsed pendingDelete={pendingDelete} onPendingDelete={setPendingDelete} onDelete={(daemon) => void revokeDaemon(daemon)} />
    </Card>
  );
}

function DaemonCreateForm({ onCancel, onCreated, onError }: { onCancel: () => void; onCreated: (daemon: { name: string; token: string }) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState("worker-local");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const daemon = await api.createDaemon(name.trim());
      await onCreated({ name: daemon.name, token: daemon.token });
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <form className="inline-editor daemon-create" onSubmit={(event) => void submit(event)}>
      <label>Daemon name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="inline-editor-actions">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit">Mint token</Button>
      </div>
    </form>
  );
}

function DaemonGroup({
  title,
  daemons,
  empty,
  collapsed,
  pendingDelete,
  onPendingDelete,
  onDelete,
}: {
  title: string;
  daemons: DaemonRow[];
  empty?: string;
  collapsed?: boolean;
  pendingDelete: number | null;
  onPendingDelete: (id: number | null) => void;
  onDelete: (daemon: DaemonRow) => void;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="daemon-group">
      <button className="group-head" onClick={() => setOpen(!open)}>
        <span className={`twisty${open ? " open" : ""}`}><Icon name="arrowright" size={13} /></span>
        <strong>{title}</strong>
        <Counter>{daemons.length}</Counter>
      </button>
      {open ? (
        daemons.length ? (
          <div className="resource-list">
            {daemons.map((daemon) => (
              <div key={daemon.id} className={`resource-card daemon ${daemonHealth(daemon)}`}>
                <span className="dot" />
                <span className="grow">
                  <strong>{daemon.name ?? `daemon-${daemon.id}`}</strong>
                  <small>{daemon.workspace ?? "workspace unknown"}</small>
                  <small className="resource-command">{daemonAuthSummary(daemon)}</small>
                </span>
                <span className="resource-meta">{relativeAge(daemon)}</span>
                {pendingDelete === daemon.id ? (
                  <span className="row-actions">
                    <Button size="sm" variant="danger" onClick={() => onDelete(daemon)}>Confirm revoke</Button>
                    <Button size="sm" onClick={() => onPendingDelete(null)}>Cancel</Button>
                  </span>
                ) : (
                  <span className="row-actions">
                    <IconButton className="danger" icon="trash" title={`Revoke ${daemon.name ?? `daemon-${daemon.id}`}`} aria-label={`Revoke ${daemon.name ?? `daemon-${daemon.id}`}`} onClick={() => onPendingDelete(daemon.id)} />
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyInline>{empty ?? "None."}</EmptyInline>
        )
      ) : null}
    </section>
  );
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-head">{title}</div>
      {children}
    </section>
  );
}

function Field({ label, help, children, span }: { label: string; help?: string; children: ReactNode; span?: boolean }) {
  return (
    <label className={`field${span ? " span-2" : ""}`}>
      <span>{label}</span>
      {children}
      {help ? <small>{help}</small> : null}
    </label>
  );
}

type BudgetForm = { mapSamples: string; digSamples: string; digMaxSamples: string; adaptiveDig: boolean; eagerPrepare: boolean; mapSteps: string; digSteps: string; digConcurrency: string; verifyConcurrency: string };
type EngagementKindForm = "" | "bug-bounty" | "bug-bounty-contest";
type EngagementForm = {
  engagementKind: EngagementKindForm;
  contestBatchScopes: string;
  contestDigConcurrency: string;
  contestStopAfterHours: string;
  contestSkipConfirm: boolean;
  contestAppendMap: boolean;
};
type PhaseProviderForm = Record<ProviderPhase, string>;

function applyBudgetFields(config: ProjectConfig, form: BudgetForm): ProjectConfig {
  const next = { ...config };
  setOptionalNumber(next, "mapSamples", form.mapSamples);
  setOptionalNumber(next, "digSamples", form.digSamples);
  setOptionalNumber(next, "digMaxSamples", form.digMaxSamples);
  next.adaptiveDig = form.adaptiveDig;
  next.eagerPrepare = form.eagerPrepare;
  setOptionalNumber(next, "mapSteps", form.mapSteps);
  setOptionalNumber(next, "digSteps", form.digSteps);
  setOptionalNumber(next, "digConcurrency", form.digConcurrency);
  setOptionalNumber(next, "verifyConcurrency", form.verifyConcurrency);
  return next;
}

function setOptionalNumber(config: ProjectConfig, key: keyof Pick<ProjectConfig, "mapSamples" | "digSamples" | "digMaxSamples" | "mapSteps" | "digSteps" | "digConcurrency" | "verifyConcurrency">, value: string): void {
  const parsed = numberOrUndefined(value);
  if (parsed === undefined) delete config[key];
  else config[key] = parsed;
}

function engagementKindFromConfig(cfg: ProjectConfig): EngagementKindForm {
  if (contestStrategy(cfg).enabled) return "bug-bounty-contest";
  return isBugBountyConfig(cfg) ? "bug-bounty" : "";
}

function applyEngagementFields(config: ProjectConfig, form: EngagementForm): ProjectConfig {
  const next = { ...config };
  if (!form.engagementKind) {
    delete next.engagement;
    return next;
  }
  if (form.engagementKind === "bug-bounty") {
    next.engagement = { kind: "bug-bounty" };
    return next;
  }
  const batchScopes = numberOrUndefined(form.contestBatchScopes) ?? 10;
  const digConcurrency = numberOrUndefined(form.contestDigConcurrency) ?? 5;
  const stopAfterHours = numberOrUndefined(form.contestStopAfterHours);
  next.scopeCoverageMode = "custom";
  next.maxScopes = batchScopes;
  next.digConcurrency = digConcurrency;
  next.engagement = {
    kind: "bug-bounty-contest",
    strategy: {
      batchScopes,
      digConcurrency,
      appendMapWhenExhausted: form.contestAppendMap,
      skipRealTargetConfirm: form.contestSkipConfirm,
      ...(stopAfterHours !== undefined ? { stopAfterHours } : {}),
    },
  };
  return next;
}

function phaseProviderConfig(form: PhaseProviderForm): ProjectConfig["phaseProviders"] | undefined {
  const out: NonNullable<ProjectConfig["phaseProviders"]> = {};
  for (const phase of PROVIDER_PHASES) {
    const id = numberOrUndefined(form[phase]);
    if (id !== undefined) out[phase] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

function selectedProfilesForForm(defaultProviderId: string, phaseProviders: PhaseProviderForm, providers: ProviderProfile[]): ProviderProfile[] {
  const ids = new Set<number>();
  const defaultId = numberOrUndefined(defaultProviderId);
  if (defaultId !== undefined) ids.add(defaultId);
  for (const phase of PROVIDER_PHASES) {
    const id = numberOrUndefined(phaseProviders[phase]);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].flatMap((id) => {
    const profile = providers.find((entry) => entry.id === id);
    return profile ? [profile] : [];
  });
}

function suggestProjectName(input: string): string {
  const source = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/g, "");
  return slug || "new-project";
}

function FormProviderAuthNote({ daemon, profiles }: { daemon?: DaemonRow; profiles: ProviderProfile[] }) {
  const byProvider = new Map<string, ProviderProfile>();
  for (const profile of profiles) byProvider.set(profile.provider, profile);
  const required = [...byProvider.values()];
  if (!daemon) {
    return (
      <div className="inline-note warn">
        <strong>Select an execution daemon.</strong>
        <span>Project paths and provider credentials are daemon-local, so every project needs an executor before it can run.</span>
      </div>
    );
  }
  if (!required.length) {
    return (
      <div className="inline-note warn">
        <strong>Select a provider profile.</strong>
        <span>The project needs a default provider; phase overrides are optional.</span>
      </div>
    );
  }
  const statuses = required.map((profile) => ({ profile, status: daemonHasProvider(daemon, profile.provider) }));
  const missing = statuses.filter((entry) => entry.status === false);
  if (missing.length) {
    return (
      <div className="inline-note warn">
        <strong>{daemon.name ?? `daemon-${daemon.id}`} is missing provider auth.</strong>
        <span>Configure {missing.map((entry) => entry.profile.provider).join(", ")} on that daemon before launching this project.</span>
        <code>flounder daemon provider login {missing[0].profile.provider}</code>
      </div>
    );
  }
  if (statuses.some((entry) => entry.status === null)) {
    return (
      <div className="inline-note">
        <strong>Provider auth has not been reported by this daemon.</strong>
        <span>Start or restart the daemon so the server can check whether it can run the selected provider profiles.</span>
        <code>flounder daemon provider check {required[0].provider}</code>
      </div>
    );
  }
  return (
    <div className="inline-note ok">
      <strong>Daemon provider auth matches this project.</strong>
      <span>{daemon.name ?? `daemon-${daemon.id}`} reports {required.map((profile) => profile.provider).join(", ")} ready for the default and phase providers.</span>
    </div>
  );
}

function PhaseProviderOverrides({ providers, defaultProviderId, values, onChange }: { providers: ProviderProfile[]; defaultProviderId: string; values: PhaseProviderForm; onChange: (values: PhaseProviderForm) => void }) {
  const defaultName = providers.find((provider) => String(provider.id) === defaultProviderId)?.name ?? "none";
  return (
    <div className="phase-provider-grid">
      {PROVIDER_PHASES.map((phase) => (
        <Field key={phase} label={phaseLabel(phase)} help={values[phase] ? "Overrides the project default for this phase." : "Uses the default provider profile."}>
          <select value={values[phase]} onChange={(event) => onChange({ ...values, [phase]: event.target.value })}>
            <option value="">Use default ({defaultName})</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{providerProfileLabel(provider)}</option>)}
          </select>
        </Field>
      ))}
    </div>
  );
}

function NewProjectModal({ providers, daemons, onClose, onCreated, onError }: { providers: ProviderProfile[]; daemons: DaemonRow[]; onClose: () => void; onCreated: (uuid: string, runAfterCreate: boolean) => Promise<void>; onError: (message: string) => void }) {
  const [advanced, setAdvanced] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const firstDaemon = daemons.find((daemon) => daemonHealth(daemon) === "online") ?? daemons[0];
  const [form, setForm] = useState({ intent: "", name: "", runAfterCreate: true, daemonId: firstDaemon?.id ? String(firstDaemon.id) : "", providerId: defaultProjectProviderId(providers), dir: "", sourcePaths: ".", buildRoot: ".", corpusPaths: "docs/specs", coverageMode: "standard" as CoverageMode, maxScopes: "30", mapSamples: "2", digSamples: "1", digMaxSamples: "3", adaptiveDig: true, eagerPrepare: true, mapSteps: "", digSteps: "", digConcurrency: "1", verifyConcurrency: "2", engagementKind: "" as EngagementKindForm, contestBatchScopes: "10", contestDigConcurrency: "5", contestStopAfterHours: "48", contestSkipConfirm: true, contestAppendMap: true });
  const [phaseProviders, setPhaseProviders] = useState<PhaseProviderForm>({ prepare: "", map: "", dig: "", confirm: "" });
  const providerMissing = providers.length === 0;
  const daemonMissing = daemons.length === 0;
  const selectedDaemon = daemons.find((daemon) => String(daemon.id) === form.daemonId);
  const selectedProfiles = selectedProfilesForForm(form.providerId, phaseProviders, providers);
  const inferredName = suggestProjectName(form.intent);
  const finalName = form.name.trim() || inferredName;
  const hasIdentity = Boolean(form.name.trim() || form.intent.trim());
  const canSubmit = !providerMissing && !daemonMissing && Boolean(form.daemonId) && Boolean(form.providerId) && hasIdentity;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (providerMissing) {
      onError("Create a provider profile before creating a project.");
      return;
    }
    if (daemonMissing) {
      onError("Create and connect a daemon before creating a project.");
      return;
    }
    if (!form.daemonId) {
      onError("Select the daemon that should run this project.");
      return;
    }
    if (!form.providerId) {
      onError("Select the default provider profile for this project.");
      return;
    }
    if (!hasIdentity) {
      onError("Describe what this project should audit, or enter a project name.");
      return;
    }
    const cfg = applyEngagementFields(applyBudgetFields(coverageConfig(form.coverageMode, form.maxScopes), form), form);
    const intent = form.intent.trim();
    if (intent) {
      cfg.projectIntent = intent;
      cfg.prepareClue = intent;
    }
    const phaseCfg = phaseProviderConfig(phaseProviders);
    if (phaseCfg) cfg.phaseProviders = phaseCfg;
    const payload: ProjectPayload = {
      name: finalName,
      providerId: form.providerId ? Number(form.providerId) : undefined,
      daemonId: form.daemonId ? Number(form.daemonId) : undefined,
      dir: form.dir.trim() || undefined,
      sourcePaths: splitPaths(form.sourcePaths),
      buildRoot: form.buildRoot.trim() || undefined,
      corpusPaths: splitPaths(form.corpusPaths),
      config: cfg,
    };
    try {
      const created = await api.createProject(payload);
      await onCreated(created.uuid, form.runAfterCreate);
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <Modal project title="Create project" onClose={onClose} footer={<><label className="modal-footer-check"><input type="checkbox" checked={form.runAfterCreate} onChange={(event) => setForm({ ...form, runAfterCreate: event.target.checked })} />Run after create</label><span className="modal-footer-actions"><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-project-form" disabled={!canSubmit}>Create project</Button></span></>}>
      <form id="new-project-form" className="project-form" onSubmit={(event) => void submit(event)}>
        {providerMissing || daemonMissing ? (
          <div className="inline-note">
            {providerMissing ? "Create a provider profile in Settings first. " : null}
            {daemonMissing ? "Create and connect a daemon in Settings first. " : null}
            Credentials stay on the selected daemon; the server stores only routing and model choices.
          </div>
        ) : null}
        <section className="project-intent-composer">
          <div className="composer-copy">
            <span>What should Flounder do?</span>
            <small>Paste a target clue, repo, address, tx, contest link, or a short audit instruction.</small>
          </div>
          <textarea
            value={form.intent}
            onChange={(event) => setForm({ ...form, intent: event.target.value })}
            placeholder="Audit the deployed rollup contracts behind 0x... and prepare source/docs before sealed map + dig."
            rows={4}
            autoFocus
          />
          <div className="composer-foot">
            <span>{form.name.trim() ? `Project: ${form.name.trim()}` : `Project: ${inferredName}`}</span>
            <Icon name="arrowright" size={15} />
          </div>
        </section>
        <FormSection title="Basics">
          <div className="form-grid two">
            <Field label="Project name" help="Leave blank to use the generated name from the task." span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={inferredName} /></Field>
            <Field label="Execution daemon" help={daemonMissing ? "Go to Settings -> Daemons to create one." : "Jobs for this project are claimed only by this daemon."}><select required disabled={daemonMissing} value={form.daemonId} onChange={(event) => setForm({ ...form, daemonId: event.target.value })}><option value="" disabled>Select daemon</option>{daemons.map((d) => <option key={d.id} value={d.id}>{d.name ?? `daemon-${d.id}`} · {relativeAge(d)}</option>)}</select></Field>
            <Field label="Default provider" help={providerMissing ? "Go to Settings -> Providers to create one." : "Used by every phase unless overridden below."}><select required disabled={providerMissing} value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })}><option value="" disabled>Select provider</option>{providers.map((p) => <option key={p.id} value={p.id}>{providerProfileLabel(p)}</option>)}</select></Field>
            <Field label="Project directory" help="Resolved under the daemon workspace. Empty uses the project UUID."><input value={form.dir} onChange={(event) => setForm({ ...form, dir: event.target.value })} placeholder="defaults to project UUID" /></Field>
          </div>
        </FormSection>
        <FormSection title="Engagement">
          <div className="contest-profile-grid">
            <Field label="Engagement type" help="Normal bounties keep real-target confirmation; contests optimize for short source-confirmed report rounds.">
              <select value={form.engagementKind} onChange={(event) => {
                const engagementKind = event.target.value as EngagementKindForm;
                const contest = engagementKind === "bug-bounty-contest";
                setForm({ ...form, engagementKind, contestSkipConfirm: contest ? true : false, coverageMode: contest ? "custom" : form.coverageMode, maxScopes: contest ? form.contestBatchScopes : form.maxScopes, digConcurrency: contest ? form.contestDigConcurrency : form.digConcurrency });
              }}>
                <option value="">Standard audit</option>
                <option value="bug-bounty">Bug bounty</option>
                <option value="bug-bounty-contest">Bug bounty contest</option>
              </select>
            </Field>
          </div>
          {form.engagementKind === "bug-bounty" ? <p className="section-help">Normal bug bounty projects preserve the real-target confirmation stage before submission reports.</p> : null}
          {form.engagementKind === "bug-bounty-contest" ? (
            <div className="contest-profile-grid">
              <Field label="Round scopes" help="Each settled Run opens this many scopes before report packaging."><input type="number" min="1" value={form.contestBatchScopes} onChange={(event) => setForm({ ...form, contestBatchScopes: event.target.value, maxScopes: event.target.value })} /></Field>
              <Field label="Dig concurrency" help="Parallel scopes for contest throughput."><input type="number" min="1" value={form.contestDigConcurrency} onChange={(event) => setForm({ ...form, contestDigConcurrency: event.target.value, digConcurrency: event.target.value })} /></Field>
              <Field label="Stop review" help="Hours after contest start to review marginal yield."><input type="number" min="1" value={form.contestStopAfterHours} onChange={(event) => setForm({ ...form, contestStopAfterHours: event.target.value })} /></Field>
              <div className="contest-checks">
                <label className="check-row"><input type="checkbox" checked={form.contestSkipConfirm} onChange={(event) => setForm({ ...form, contestSkipConfirm: event.target.checked })} /><span>Skip real-target confirm</span></label>
                <label className="check-row"><input type="checkbox" checked={form.contestAppendMap} onChange={(event) => setForm({ ...form, contestAppendMap: event.target.checked })} /><span>Expand map after inventory is exhausted</span></label>
              </div>
            </div>
          ) : null}
        </FormSection>
        <button type="button" className="advanced-toggle" onClick={() => setPhaseOpen(!phaseOpen)}>{phaseOpen ? "Hide phase provider overrides" : "Customize phase providers"}</button>
        {phaseOpen ? (
          <FormSection title="Phase provider overrides">
            <p className="section-help">Use a different provider profile when a phase needs a different model or reasoning level. The selected daemon must authenticate every provider used here.</p>
            <PhaseProviderOverrides providers={providers} defaultProviderId={form.providerId} values={phaseProviders} onChange={setPhaseProviders} />
          </FormSection>
        ) : null}
        <FormProviderAuthNote daemon={selectedDaemon} profiles={selectedProfiles} />
        <FormSection title="Source materials">
          <div className="form-grid two">
            <Field label="Source paths" help="Code paths the model reads and audits." span><input value={form.sourcePaths} onChange={(event) => setForm({ ...form, sourcePaths: event.target.value })} placeholder="." /></Field>
            <Field label="Build root" help="Buildable workspace root copied into the sandbox."><input value={form.buildRoot} onChange={(event) => setForm({ ...form, buildRoot: event.target.value })} placeholder="." /></Field>
            <Field label="Corpus paths" help="Project docs/specs used as design intent, not findings."><input value={form.corpusPaths} onChange={(event) => setForm({ ...form, corpusPaths: event.target.value })} placeholder="docs/specs" /></Field>
          </div>
        </FormSection>
        <FormSection title="Coverage">
          <div className="form-grid two">
            <Field label="Mode"><select value={form.coverageMode} onChange={(event) => setForm({ ...form, coverageMode: event.target.value as CoverageMode })}>{COVERAGE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></Field>
            <Field label="Target" help="Standard and Focused stop at a project-level audited-scope target. Custom is a one-run cap.">
              {form.coverageMode === "custom" ? <input value={form.maxScopes} onChange={(event) => setForm({ ...form, maxScopes: event.target.value })} /> : <span className="readonly-field">{coverageCapText(form.coverageMode, form.maxScopes)}</span>}
            </Field>
          </div>
        </FormSection>
        <button type="button" className="advanced-toggle" onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide budget controls" : "Show budget controls"}</button>
        {advanced ? (
          <FormSection title="Budget controls">
            <div className="form-grid two">
              <Field label="Map turn cap" help="Maximum model turns for scope enumeration; empty means unbounded."><input value={form.mapSteps} onChange={(event) => setForm({ ...form, mapSteps: event.target.value })} placeholder="unbounded" /></Field>
              <Field label="Map samples" help="Independent inventories are unioned; singleton scopes are retained."><input type="number" min="1" value={form.mapSamples} onChange={(event) => setForm({ ...form, mapSamples: event.target.value })} /></Field>
              <Field label="Dig turn cap" help="Maximum model turns per scope; empty means unbounded."><input value={form.digSteps} onChange={(event) => setForm({ ...form, digSteps: event.target.value })} placeholder="unbounded" /></Field>
              <Field label="Minimum dig samples" help="Independent dig passes every selected scope receives."><input type="number" min="1" value={form.digSamples} onChange={(event) => setForm({ ...form, digSamples: event.target.value })} /></Field>
              <Field label="Adaptive ceiling" help="Maximum samples only when the scope outcome remains incomplete or uncertain."><input type="number" min="1" value={form.digMaxSamples} onChange={(event) => setForm({ ...form, digMaxSamples: event.target.value })} /></Field>
              <Field label="Dig concurrency" help="How many scopes run in parallel. 1 keeps digs sequential."><input value={form.digConcurrency} onChange={(event) => setForm({ ...form, digConcurrency: event.target.value })} /></Field>
              <Field label="Verify concurrency" help="Independent findings verified in parallel; each keeps its own isolated workspace."><input value={form.verifyConcurrency} onChange={(event) => setForm({ ...form, verifyConcurrency: event.target.value })} /></Field>
              <label className="check-row"><input type="checkbox" checked={form.adaptiveDig} onChange={(event) => setForm({ ...form, adaptiveDig: event.target.checked })} /><span>Adaptive dig sampling</span></label>
              <label className="check-row"><input type="checkbox" checked={form.eagerPrepare} onChange={(event) => setForm({ ...form, eagerPrepare: event.target.checked })} /><span>Warm build before Dig</span></label>
            </div>
          </FormSection>
        ) : null}
      </form>
    </Modal>
  );
}

function EditProjectModal({ detail, providers, daemons, onClose, onSaved, onError }: { detail: ProjectDetail; providers: ProviderProfile[]; daemons: DaemonRow[]; onClose: () => void; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const cfg = projectConfig(detail);
  const initialCoverageMode = coverageModeFromConfig(cfg.cfg);
  const initialContest = contestStrategy(cfg.cfg);
  const initialEngagementKind = engagementKindFromConfig(cfg.cfg);
  const [form, setForm] = useState({
    intent: cfg.cfg.prepareClue ?? cfg.cfg.projectIntent ?? "",
    daemonId: detail.project.daemon_id ? String(detail.project.daemon_id) : "",
    providerId: detail.project.provider_id ? String(detail.project.provider_id) : "",
    dir: detail.project.dir ?? "",
    sourcePaths: cfg.sourcePaths.join(" "),
    buildRoot: cfg.buildRoot,
    corpusPaths: cfg.corpusPaths.join(" "),
    coverageMode: initialCoverageMode,
    maxScopes: String(cfg.cfg.maxScopes ?? (initialCoverageMode === "focused" ? 10 : 30)),
    mapSamples: String(cfg.cfg.mapSamples ?? 1),
    digSamples: String(cfg.cfg.digSamples ?? 1),
    digMaxSamples: String(cfg.cfg.digMaxSamples ?? cfg.cfg.digSamples ?? 1),
    adaptiveDig: cfg.cfg.adaptiveDig !== false,
    eagerPrepare: cfg.cfg.eagerPrepare === true,
    mapSteps: cfg.cfg.mapSteps != null ? String(cfg.cfg.mapSteps) : "",
    digSteps: cfg.cfg.digSteps != null ? String(cfg.cfg.digSteps) : "",
    digConcurrency: String(cfg.cfg.digConcurrency ?? 1),
    verifyConcurrency: String(cfg.cfg.verifyConcurrency ?? 2),
    engagementKind: initialEngagementKind,
    contestBatchScopes: String(initialContest.batchScopes),
    contestDigConcurrency: String(initialContest.digConcurrency),
    contestStopAfterHours: initialContest.stopAfterHours != null ? String(initialContest.stopAfterHours) : "48",
    contestSkipConfirm: initialContest.skipRealTargetConfirm,
    contestAppendMap: initialContest.appendMapWhenExhausted,
  });
  const [phaseProviders, setPhaseProviders] = useState<PhaseProviderForm>({
    prepare: cfg.cfg.phaseProviders?.prepare ? String(cfg.cfg.phaseProviders.prepare) : "",
    map: cfg.cfg.phaseProviders?.map ? String(cfg.cfg.phaseProviders.map) : "",
    dig: cfg.cfg.phaseProviders?.dig ? String(cfg.cfg.phaseProviders.dig) : "",
    confirm: cfg.cfg.phaseProviders?.confirm ? String(cfg.cfg.phaseProviders.confirm) : "",
  });
  const selectedDaemon = daemons.find((daemon) => String(daemon.id) === form.daemonId);
  const selectedProfiles = selectedProfilesForForm(form.providerId, phaseProviders, providers);
  const canSave = Boolean(form.daemonId && form.providerId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.daemonId) {
      onError("Select the daemon that should run this project.");
      return;
    }
    if (!form.providerId) {
      onError("Select the default provider profile for this project.");
      return;
    }
    try {
      const nextConfig = applyEngagementFields(applyBudgetFields({ ...cfg.cfg, ...coverageConfig(form.coverageMode, form.maxScopes) }, form), form);
      const intent = form.intent.trim();
      if (intent) {
        nextConfig.projectIntent = intent;
        nextConfig.prepareClue = intent;
      } else {
        delete nextConfig.projectIntent;
        delete nextConfig.prepareClue;
      }
      if (form.coverageMode !== "custom") delete nextConfig.maxScopes;
      const phaseCfg = phaseProviderConfig(phaseProviders);
      if (phaseCfg) nextConfig.phaseProviders = phaseCfg;
      else delete nextConfig.phaseProviders;
      await api.updateProject(detail.project.uuid, { daemonId: form.daemonId ? Number(form.daemonId) : undefined, providerId: form.providerId ? Number(form.providerId) : undefined, dir: form.dir, sourcePaths: splitPaths(form.sourcePaths), buildRoot: form.buildRoot, corpusPaths: splitPaths(form.corpusPaths), config: nextConfig });
      await onSaved();
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <Modal project title="Edit project config" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="edit-project-form" disabled={!canSave}>Save config</Button></>}>
      <form id="edit-project-form" className="project-form" onSubmit={(event) => void submit(event)}>
        <section className="project-intent-composer compact">
          <div className="composer-copy">
            <span>Project task and prepare clue</span>
            <small>Used as the default clue when Prepare starts without an explicit clue.</small>
          </div>
          <textarea
            value={form.intent}
            onChange={(event) => setForm({ ...form, intent: event.target.value })}
            placeholder="Audit the deployed protocol, acquire official source/docs, then map and dig."
            rows={3}
          />
        </section>
        <FormSection title="Basics">
          <div className="form-grid two">
            <Field label="Execution daemon" help="Jobs for this project are claimed only by this daemon."><select required value={form.daemonId} onChange={(event) => setForm({ ...form, daemonId: event.target.value })}><option value="" disabled>Select daemon</option>{daemons.map((d) => <option key={d.id} value={d.id}>{d.name ?? `daemon-${d.id}`} · {relativeAge(d)}</option>)}</select></Field>
            <Field label="Default provider" help="Used by every phase unless overridden below."><select required value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })}><option value="" disabled>Select provider</option>{providers.map((p) => <option key={p.id} value={p.id}>{providerProfileLabel(p)}</option>)}</select></Field>
            <Field label="Project directory" help="Resolved under the daemon workspace."><input value={form.dir} onChange={(event) => setForm({ ...form, dir: event.target.value })} /></Field>
          </div>
        </FormSection>
        <FormSection title="Engagement">
          <div className="contest-profile-grid">
            <Field label="Engagement type" help="Normal bounties keep real-target confirmation; contests optimize for short source-confirmed report rounds.">
              <select value={form.engagementKind} onChange={(event) => {
                const engagementKind = event.target.value as EngagementKindForm;
                const contest = engagementKind === "bug-bounty-contest";
                setForm({ ...form, engagementKind, contestSkipConfirm: contest ? true : false, coverageMode: contest ? "custom" : form.coverageMode, maxScopes: contest ? form.contestBatchScopes : form.maxScopes, digConcurrency: contest ? form.contestDigConcurrency : form.digConcurrency });
              }}>
                <option value="">Standard audit</option>
                <option value="bug-bounty">Bug bounty</option>
                <option value="bug-bounty-contest">Bug bounty contest</option>
              </select>
            </Field>
          </div>
          {form.engagementKind === "bug-bounty" ? <p className="section-help">Normal bug bounty projects preserve the real-target confirmation stage before submission reports.</p> : null}
          {form.engagementKind === "bug-bounty-contest" ? (
            <div className="contest-profile-grid">
              <Field label="Round scopes" help="Each settled Run opens this many scopes before report packaging."><input type="number" min="1" value={form.contestBatchScopes} onChange={(event) => setForm({ ...form, contestBatchScopes: event.target.value, maxScopes: event.target.value })} /></Field>
              <Field label="Dig concurrency" help="Parallel scopes for contest throughput."><input type="number" min="1" value={form.contestDigConcurrency} onChange={(event) => setForm({ ...form, contestDigConcurrency: event.target.value, digConcurrency: event.target.value })} /></Field>
              <Field label="Stop review" help="Hours after contest start to review marginal yield."><input type="number" min="1" value={form.contestStopAfterHours} onChange={(event) => setForm({ ...form, contestStopAfterHours: event.target.value })} /></Field>
              <div className="contest-checks">
                <label className="check-row"><input type="checkbox" checked={form.contestSkipConfirm} onChange={(event) => setForm({ ...form, contestSkipConfirm: event.target.checked })} /><span>Skip real-target confirm</span></label>
                <label className="check-row"><input type="checkbox" checked={form.contestAppendMap} onChange={(event) => setForm({ ...form, contestAppendMap: event.target.checked })} /><span>Expand map after inventory is exhausted</span></label>
              </div>
            </div>
          ) : null}
        </FormSection>
        <FormSection title="Phase provider overrides">
          <p className="section-help">Leave a phase on the default provider unless it needs a different model profile. The selected daemon must authenticate every provider used here.</p>
          <PhaseProviderOverrides providers={providers} defaultProviderId={form.providerId} values={phaseProviders} onChange={setPhaseProviders} />
        </FormSection>
        <FormProviderAuthNote daemon={selectedDaemon} profiles={selectedProfiles} />
        <FormSection title="Source materials">
          <div className="form-grid two">
            <Field label="Source paths" help="Code paths the model reads and audits." span><input value={form.sourcePaths} onChange={(event) => setForm({ ...form, sourcePaths: event.target.value })} /></Field>
            <Field label="Build root" help="Buildable workspace root copied into the sandbox."><input value={form.buildRoot} onChange={(event) => setForm({ ...form, buildRoot: event.target.value })} /></Field>
            <Field label="Corpus paths" help="Project docs/specs used as design intent, not findings."><input value={form.corpusPaths} onChange={(event) => setForm({ ...form, corpusPaths: event.target.value })} /></Field>
          </div>
        </FormSection>
        <FormSection title="Coverage">
          <div className="form-grid two">
            <Field label="Mode"><select value={form.coverageMode} onChange={(event) => setForm({ ...form, coverageMode: event.target.value as CoverageMode })}>{COVERAGE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></Field>
            <Field label="Target" help="Standard and Focused stop at a project-level audited-scope target. Custom is a one-run cap.">
              {form.coverageMode === "custom" ? <input value={form.maxScopes} onChange={(event) => setForm({ ...form, maxScopes: event.target.value })} /> : <span className="readonly-field">{coverageCapText(form.coverageMode, form.maxScopes)}</span>}
            </Field>
          </div>
        </FormSection>
        <FormSection title="Budget controls">
          <div className="form-grid two">
            <Field label="Map turn cap" help="Maximum model turns for scope enumeration; empty means unbounded."><input value={form.mapSteps} onChange={(event) => setForm({ ...form, mapSteps: event.target.value })} placeholder="unbounded" /></Field>
            <Field label="Map samples" help="Independent inventories are unioned; singleton scopes are retained."><input type="number" min="1" value={form.mapSamples} onChange={(event) => setForm({ ...form, mapSamples: event.target.value })} /></Field>
            <Field label="Dig turn cap" help="Maximum model turns per scope; empty means unbounded."><input value={form.digSteps} onChange={(event) => setForm({ ...form, digSteps: event.target.value })} placeholder="unbounded" /></Field>
            <Field label="Minimum dig samples" help="Independent dig passes every selected scope receives."><input type="number" min="1" value={form.digSamples} onChange={(event) => setForm({ ...form, digSamples: event.target.value })} /></Field>
            <Field label="Adaptive ceiling" help="Maximum samples only when the scope outcome remains incomplete or uncertain."><input type="number" min="1" value={form.digMaxSamples} onChange={(event) => setForm({ ...form, digMaxSamples: event.target.value })} /></Field>
            <Field label="Dig concurrency" help="How many scopes run in parallel. 1 keeps digs sequential."><input value={form.digConcurrency} onChange={(event) => setForm({ ...form, digConcurrency: event.target.value })} /></Field>
            <Field label="Verify concurrency" help="Independent findings verified in parallel; each keeps its own isolated workspace."><input value={form.verifyConcurrency} onChange={(event) => setForm({ ...form, verifyConcurrency: event.target.value })} /></Field>
            <label className="check-row"><input type="checkbox" checked={form.adaptiveDig} onChange={(event) => setForm({ ...form, adaptiveDig: event.target.checked })} /><span>Adaptive dig sampling</span></label>
            <label className="check-row"><input type="checkbox" checked={form.eagerPrepare} onChange={(event) => setForm({ ...form, eagerPrepare: event.target.checked })} /><span>Warm build before Dig</span></label>
          </div>
        </FormSection>
      </form>
    </Modal>
  );
}

function RunModal({ detail, busy, onClose, onLaunch, onUpdateRunTarget, onError }: { detail: ProjectDetail; busy: boolean; onClose: () => void; onLaunch: (action: LaunchAction) => void; onUpdateRunTarget: (run: RunRow, body: RunUpdatePayload) => void; onError: (message: string) => void }) {
  const running = currentMaterialRuns(detail.runs, detail.material).find((run) => run.status === "running");
  const pendingScopes = detail.progress.pending ?? 0;
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  const confirmable = pendingConfirmFindings(detail.allFindings, requiresConfirmation, detail.confirmDecisions).length;
  const verifiable = pendingVerifyFindings(detail.allFindings).length;
  const reportable = requiresConfirmation ? reportableDecisions(detail.confirmDecisions, detail.allFindings).length : reportableFindings(detail.allFindings, requiresConfirmation).length;
  const missingReports = requiresConfirmation ? pendingDecisionReports(detail.confirmDecisions, detail.allFindings).length : pendingFormalReports(detail.allFindings, requiresConfirmation).length;
  const hasPipelineRun = detail.runs.some((run) => run.kind === "run");
  const pipelineActionDetail = pipelineRunActionDetail(detail, hasPipelineRun);
  const currentRoundWorkPending = verifiable > 0 || confirmable > 0 || missingReports > 0;
  const currentRoundComplete = hasPipelineRun && !currentRoundWorkPending && pipelineCoverageRoundComplete(detail);
  const locked = busy || Boolean(running);
  const cfg = projectConfig(detail).cfg;
  const contestProfile = contestStrategy(cfg);
  const projectCoverageMode = coverageModeFromConfig(cfg);
  const contestCanContinue = contestProfile.enabled && (pendingScopes > 0 || (detail.progress.total ?? 0) === 0 || contestProfile.appendMapWhenExhausted);
  const [runCoverageMode, setRunCoverageMode] = useState<CoverageMode>(projectCoverageMode);
  const [runTargetDraft, setRunTargetDraft] = useState("");
  useEffect(() => {
    if (!running) return;
    setRunCoverageMode(projectCoverageMode);
    setRunTargetDraft(String(running.run_scopes_target ?? 30));
  }, [projectCoverageMode, running?.id, running?.run_scopes_target]);
  const submitRunTarget = (event: FormEvent) => {
    event.preventDefault();
    if (!running) return;
    if (runCoverageMode !== "custom") {
      onUpdateRunTarget(running, { scopeCoverageMode: runCoverageMode });
      return;
    }
    const target = Number(runTargetDraft);
    if (!Number.isFinite(target) || target < 1) {
      onError("Enter a positive batch target for the active run.");
      return;
    }
    onUpdateRunTarget(running, { runScopesTarget: Math.floor(target) });
  };
  const prepareQuality = detail.prepareSummary?.quality;
  const prepareActionLabel = prepareQuality === "ready"
    ? "Refresh materials"
    : prepareQuality === "limited"
      ? "Improve materials"
      : prepareQuality === "needs-review" || prepareQuality === "invalid"
        ? "Repair materials"
        : "Prepare materials";
  const prepareActionDetail = prepareQuality === "limited"
    ? "Optionally re-run Prepare to close provenance, deployment-match, or real-target caveats. The current materials can still drive Map/Dig."
    : "Acquire official source/docs, pin provenance, and record material or real-target gaps before sealed auditing.";
  const options: Array<{ verb: LaunchAction; label: string; detail: string; disabled?: boolean }> = [
    { verb: "run", label: hasPipelineRun ? "Continue" : "Run", detail: pipelineActionDetail, disabled: locked || (currentRoundComplete && !contestCanContinue) },
    ...(hasPipelineRun ? [{
      verb: "run-next-coverage" as const,
      label: "Start next scope round",
      detail: currentRoundWorkPending
        ? "Disabled until this round's verify, confirm, and report work is settled."
        : pendingScopes
          ? `Explicitly open another pipeline batch from ${plural(pendingScopes, "pending mapped scope")}.`
          : "Disabled until Map scopes creates pending scope inventory.",
      disabled: locked || currentRoundWorkPending || pendingScopes === 0,
    }] : []),
    {
      verb: "prepare",
      label: prepareActionLabel,
      detail: prepareActionDetail,
      disabled: locked,
    },
    { verb: "map-expand", label: "Expand map", detail: detail.progress.total ? `Run MAP with the current ${plural(detail.progress.total, "scope")} visible, append only novel scopes, and preserve audited/deferred status.` : "Disabled until an initial scope inventory exists.", disabled: locked || !detail.progress.total },
    { verb: "map", label: "Remap from scratch", detail: "Rebuild the scope inventory from scratch without digging. This replaces the current scope view; use Expand map to append coverage.", disabled: locked },
    { verb: "audit", label: "Dig pending scopes", detail: pendingScopes ? `Explicitly deep-audit pending mapped scopes without starting another full pipeline round.` : "Disabled until Map scopes creates pending scope inventory.", disabled: locked || pendingScopes === 0 },
    { verb: "verify", label: verifyButtonLabel(verifiable), detail: verifiable ? `Settle ${plural(verifiable, "unresolved candidate")} by local execution.` : "Disabled until dig or synthesis leaves an unresolved candidate.", disabled: locked || verifiable === 0 },
    { verb: "confirm", label: "Confirm", detail: requiresConfirmation ? (confirmable ? `Reproduce ${plural(confirmable, "execution-confirmed finding")} against the real target.` : "Disabled until local execution confirms a finding.") : "Not required for this source-only target.", disabled: locked || confirmable === 0 },
    { verb: "report", label: missingReports ? `Generate reports (${missingReports})` : "Regenerate reports", detail: reportable ? `Write formal Markdown reports for ${plural(reportable, requiresConfirmation ? "real-target decision" : "locally confirmed finding")}.` : requiresConfirmation ? "Disabled until confirm reproduces at least one decision." : "Disabled until local execution confirms at least one finding.", disabled: locked || reportable === 0 },
  ];
  return (
    <Modal title={`${running ? "Run settings" : "Run controls"} - ${detail.project.name}`} onClose={onClose}>
      {running ? (
        <div className="info-panel active-run-settings compact">
          <div>
            <strong>{runKindLabel(running.kind, running)} is running</strong>
            <span>{runProgress(running, detail.confirmDecisions)}</span>
          </div>
          {(running.kind === "run" || running.kind === "audit") && running.run_scopes_target != null ? (
            <form className="run-target-control" onSubmit={submitRunTarget}>
              <label>
                <span>Coverage</span>
                <select value={runCoverageMode} onChange={(event) => setRunCoverageMode(event.target.value as CoverageMode)}>
                  {COVERAGE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                </select>
              </label>
              {runCoverageMode === "custom" ? (
                <label>
                  <span>Batch target</span>
                  <input type="number" min="1" value={runTargetDraft} onChange={(event) => setRunTargetDraft(event.target.value)} />
                </label>
              ) : null}
              <Button size="sm" icon="sync">Update</Button>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="run-options">
          {options.map((option) => (
            <button
              key={option.verb}
              disabled={option.disabled}
              title={option.detail}
              aria-label={`${option.label}. ${option.detail}`}
              onClick={() => onLaunch(option.verb)}
            >
              <strong>{option.label}</strong>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function LaunchConfirmModal({ action, detail, busy, onCancel, onConfirm }: { action: LaunchAction; detail: ProjectDetail; busy: boolean; onCancel: () => void; onConfirm: (findings: FindingRow[]) => void }) {
  const isConfirm = action === "confirm";
  const isReport = action === "report";
  const requiresConfirmation = needsRealTargetConfirmation(detail);
  const targets = isReport
    ? (requiresConfirmation ? reportDecisionFindings(detail, false) : reportableFindings(detail.allFindings, requiresConfirmation))
    : isConfirm ? pendingConfirmFindings(detail.allFindings, requiresConfirmation, detail.confirmDecisions) : pendingVerifyFindings(detail.allFindings);
  const defaultReportTargets = requiresConfirmation ? reportDecisionFindings(detail, true) : pendingFormalReports(detail.allFindings, requiresConfirmation);
  const defaultTargets = isReport ? (defaultReportTargets.length ? defaultReportTargets : targets) : targets;
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set(defaultTargets.map((finding) => finding.id)));
  const selectedTargets = targets.filter((finding) => selectedIds.has(finding.id));
  const selectedDecisionReports = isReport && requiresConfirmation ? selectedReportDecisions(detail, selectedIds) : [];
  const count = isReport && requiresConfirmation ? selectedDecisionReports.length : selectedTargets.length;
  const selectedMissingReports = isReport ? (requiresConfirmation ? selectedDecisionReports.filter((decision) => !decision.has_report).length : selectedTargets.filter((finding) => !finding.has_report).length) : 0;
  const selectedExistingReports = isReport ? (requiresConfirmation ? selectedDecisionReports.filter((decision) => decision.has_report).length : selectedTargets.filter((finding) => finding.has_report).length) : 0;
  const existingReportTargets = isReport ? (requiresConfirmation ? reportableDecisions(detail.confirmDecisions, detail.allFindings).filter((decision) => decision.has_report).length : targets.filter((finding) => finding.has_report).length) : 0;
  const allSelected = targets.length > 0 && selectedIds.size === targets.length;
  function toggleFinding(id: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(targets.map((finding) => finding.id)));
  }
  const title = isReport
    ? defaultReportTargets.length
      ? existingReportTargets
        ? "Generate or regenerate reports?"
        : "Generate formal reports?"
      : "Regenerate reports?"
    : isConfirm
      ? "Start real-target confirmation?"
      : "Verify unresolved candidates?";
  const buttonIcon: IconName = isReport ? "file" : isConfirm ? "shieldcheck" : "search";
  const buttonLabel = isReport
    ? selectedExistingReports > 0 && selectedMissingReports === 0
      ? "Regenerate reports"
      : selectedExistingReports > 0
        ? "Generate / regenerate"
        : "Generate reports"
    : isConfirm
      ? "Confirm"
      : "Verify candidates";
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={buttonIcon} onClick={() => onConfirm(selectedTargets)} disabled={busy || count === 0}>
            {buttonLabel}
          </Button>
        </>
      )}
    >
      <div className="confirm-copy">
        <strong>
          {isReport
            ? selectedExistingReports > 0 && selectedMissingReports > 0
              ? `${plural(selectedMissingReports, "new report")} will be generated and ${plural(selectedExistingReports, "existing report")} will be regenerated.`
              : selectedExistingReports > 0
                ? `${plural(selectedExistingReports, "existing report")} will be regenerated.`
                : `${plural(count, requiresConfirmation ? "real-target decision" : "locally confirmed finding")} will be packaged into formal reports.`
            : isConfirm
              ? `${plural(count, "finding")} will be checked against the real target.`
              : `${plural(count, "unresolved candidate")} will be settled by local execution.`}
        </strong>
        <p>
          {isReport
            ? requiresConfirmation
              ? "The daemon writes one submission-ready Markdown report per selected real-target decision. It may inspect source and existing evidence for accuracy, but it must not invent missing details."
              : "The daemon writes one submission-ready Markdown report per selected source-only bug using the local execution evidence. It may inspect source and existing evidence for accuracy, but it must not invent missing details."
            : isConfirm
              ? "This may use network reads and local forks to reproduce already audit-confirmed findings. Flounder still keeps the white-hat boundary: no broadcast and no live-system writes."
              : "Dig already tries to prove findings as they are discovered. This separate pass handles only unresolved or synthesized candidates, writes normal run artifacts, and never contacts a real target."}
        </p>
        <label className="check-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          <span>{allSelected ? "Clear all" : "Select all"}</span>
        </label>
        <div className="confirm-targets" aria-label={isReport && requiresConfirmation ? "Linked findings for decision reports" : isReport ? "Findings to report" : isConfirm ? "Findings to confirm" : "Findings to verify"}>
          {targets.map((finding) => {
            const targetReportState = isReport
              ? requiresConfirmation
                ? (selectedReportDecisions(detail, new Set([finding.id])).some((decision) => decision.has_report) ? "decision report exists" : "needs decision report")
                : (finding.has_report ? "report exists" : "needs report")
              : "";
            return (
              <label className="confirm-target" key={finding.id}>
                <input type="checkbox" checked={selectedIds.has(finding.id)} onChange={() => toggleFinding(finding.id)} />
                <span className="target-index">#{finding.id}</span>
                <span>
                  <strong>{finding.title ?? "Untitled finding"}</strong>
                  <small>{finding.location || "No location"} · {finding.status}{isReport ? ` · ${targetReportState}` : ""}</small>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

function StopRunConfirmModal({ run, busy, onCancel, onConfirm }: { run: RunRow; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const label = runKindLabel(run.kind, run);
  return (
    <Modal
      title="Stop run?"
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon="x" onClick={onConfirm} disabled={busy}>Stop run</Button>
        </>
      )}
    >
      <div className="confirm-copy">
        <strong>{label} run #{run.id} is active.</strong>
        <p>Progress already recorded will be kept, but the active daemon job will be interrupted. New audit work can be launched after the stop request completes.</p>
      </div>
    </Modal>
  );
}

function DeleteProjectConfirmModal({ project, busy, onCancel, onConfirm }: { project: ProjectSnapshot; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="Delete project?"
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon="trash" onClick={onConfirm} disabled={busy}>Delete project</Button>
        </>
      )}
    >
      <div className="confirm-copy">
        <strong>{project.name} will be permanently deleted.</strong>
        <p>This removes the project row and its runs, scopes, findings, and confirm decisions from Flounder. On-disk run artifacts are left untouched.</p>
      </div>
    </Modal>
  );
}

function RunLogModal({ run, onClose }: { run: RunRow; onClose: () => void }) {
  const [events, setEvents] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let firstLoad = true;
    const load = async () => {
      if (firstLoad) {
        setLoading(true);
        setError("");
      }
      try {
        const res = await api.runLog(run.id, 120);
        if (!cancelled) setEvents(res.events ?? []);
      } catch (err: unknown) {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      } finally {
        if (!cancelled && firstLoad) setLoading(false);
        firstLoad = false;
      }
    };
    void load();
    const interval = run.status === "running" ? window.setInterval(() => void load(), 4_000) : undefined;
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [run.id, run.status]);
  const lines = useMemo(() => events.reduce((current, event) => appendActivityLine(current, event), [] as ActivityLine[]), [events]);
  const lastLine = lines[lines.length - 1];
  const inactive = runInactiveLabel(run);
  const logScroll = usePinnedScroll(lines, run.id);
  return (
    <Modal title={`Run log - #${run.id}`} wide onClose={onClose}>
      <div className="run-log-head">
        <StateBadge status={run.status} />
        <strong>{runKindLabel(run.kind, run)}</strong>
        <span>{runProgress(run, [])}</span>
        {inactive ? <span className="warn-text">No activity for {inactive}</span> : lastLine ? <span>Last activity {formatActivityTime(lastLine.time)}</span> : null}
      </div>
      {run.job_error ? <div className="inline-error">{run.job_error}</div> : null}
      {error ? <div className="inline-error">{error}</div> : null}
      {loading ? <EmptyInline>Loading run log...</EmptyInline> : null}
      {!loading && !lines.length && !error ? <EmptyInline>No activity has been recorded for this run.</EmptyInline> : null}
      {lines.length ? (
        <div className="activity-scroll-wrap">
          <div className="run-log-list" ref={logScroll.scrollRef} onScroll={logScroll.onScroll}>
            {lines.map((line) => (
              <div className={`run-log-entry ${line.label.toLowerCase().includes("error") ? "error" : ""}`} key={line.id}>
                <span className="run-log-time">{formatActivityTime(line.time)}</span>
                <span className="run-log-kind">{[line.label, line.streamId, line.meta ?? (line.step ? `step ${line.step}` : undefined)].filter(Boolean).join(" · ")}</span>
                <ActivityBody line={line} pre />
              </div>
            ))}
          </div>
          {!logScroll.isPinned ? <button className="latest-button" type="button" onClick={logScroll.scrollToBottom}>Latest</button> : null}
        </div>
      ) : null}
    </Modal>
  );
}

function ReportModal({ finding, onClose }: { finding: FindingRow; onClose: () => void }) {
  const fallback = useMemo(() => findingReportMarkdown(finding), [finding]);
  const [markdown, setMarkdown] = useState(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lifecycle, setLifecycle] = useState<FindingLifecycle | null>(null);
  const [retrying, setRetrying] = useState<FindingPhase | null>(null);
  const [retryMessage, setRetryMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    setMarkdown(fallback);
    setError("");
    setLoading(true);
    setLifecycle(null);
    setRetryMessage("");
    void api
      .findingReport(finding.id)
      .then((response) => {
        if (!cancelled && response.markdown.trim()) setMarkdown(redactReportMarkdown(response.markdown));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void api.findingLifecycle(finding.id).then((response) => {
      if (!cancelled) setLifecycle(response);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fallback, finding.id]);
  async function retryPhase(phase: FindingPhase) {
    setRetrying(phase);
    setRetryMessage("");
    try {
      await api.retryFindingPhase(finding.id, phase);
      setRetryMessage(`${lifecyclePhaseLabel(phase)} is reopened and will run on the next Continue.`);
    } catch (err) {
      setRetryMessage(String(err instanceof Error ? err.message : err));
    } finally {
      setRetrying(null);
    }
  }
  return (
    <Modal title={finding.source === "evaluation" ? `Evaluation evidence #${finding.id}` : `Finding report #${finding.id}`} wide onClose={onClose}>
      {loading ? <EmptyInline>Loading report...</EmptyInline> : null}
      {!loading && error ? <div className="inline-note">Showing the stored finding summary because the DB report endpoint could not be loaded.</div> : null}
      {finding.source !== "evaluation" ? <LifecycleEvidencePanel finding={finding} lifecycle={lifecycle} retrying={retrying} retryMessage={retryMessage} onRetry={retryPhase} /> : null}
      <MarkdownReport markdown={markdown} fileName={`finding-${finding.id}.md`} />
    </Modal>
  );
}

function LifecycleEvidencePanel({
  finding,
  lifecycle,
  retrying,
  retryMessage,
  onRetry,
}: {
  finding: FindingRow;
  lifecycle: FindingLifecycle | null;
  retrying: FindingPhase | null;
  retryMessage: string;
  onRetry: (phase: FindingPhase) => void;
}) {
  const evidenceConflict = hasUnresolvedEvidenceConflict(finding);
  const findingAttempts = lifecycle?.attempts ?? finding.phase_attempts ?? [];
  const decisionAttempts = lifecycle?.decisions.flatMap((decision) => decision.attempts ?? []) ?? [];
  const attempts = [...findingAttempts, ...decisionAttempts];
  const phaseRows: Array<{ phase: FindingPhase; label: string; attempt?: FindingPhaseAttempt }> = [
    { phase: "verify", label: "Local evidence", attempt: latestAttempt(attempts, "verify") },
    { phase: "confirm", label: "Real target", attempt: latestAttempt(attempts, "confirm") },
    { phase: "report", label: "Formal report", attempt: latestAttempt(attempts, "report") },
  ];
  return (
    <section className="lifecycle-panel" aria-label="Finding lifecycle evidence">
      <div className="lifecycle-panel-head">
        <div>
          <strong>Evidence lifecycle</strong>
          <small>{lifecycle ? `${plural(lifecycle.occurrences.length, "occurrence")} · canonical ${finding.canonical_key ?? finding.finding_key ?? `#${finding.id}`}` : "Loading attempt history..."}</small>
        </div>
        {finding.refutation_status ? <span className={`label refutation-${finding.refutation_status}`}>Independent review: {finding.refutation_status}</span> : null}
      </div>
      <div className="lifecycle-attempt-grid">
        {phaseRows.map(({ phase, label, attempt }) => {
          const conflictRetry = evidenceConflict && (phase === "verify" || phase === "confirm");
          const blockedRetry = Boolean(attempt && (attempt.state === "blocked" || attempt.state === "error"));
          const retryLabel = conflictRetry ? (phase === "verify" ? "Retry Verify" : "Retry Confirm") : `Retry ${lifecyclePhaseLabel(phase)}`;
          return (
          <div className="lifecycle-attempt" key={phase}>
            <span className={`lifecycle-dot ${attemptState(attempt)}`} />
            <div>
              <strong>{label}</strong>
              <small>{attempt ? `Attempt ${attempt.attempt_number} · ${attempt.outcome ?? attempt.state}${attempt.updated_at ? ` · ${fmtTime(attempt.updated_at)}` : ""}` : "Not attempted"}</small>
              {attempt?.blocker ? <p>{attempt.blocker}</p> : null}
            </div>
            {conflictRetry || blockedRetry ? (
              <Button size="sm" icon="sync" disabled={retrying !== null} onClick={() => onRetry(phase)}>{retrying === phase ? "Reopening..." : retryLabel}</Button>
            ) : null}
          </div>
          );
        })}
      </div>
      {evidenceConflict ? <div className="inline-note">Retry Verify to seek an agreeing local result, or retry Confirm to re-check the real target. Reporting stays held until the evidence agrees.</div> : null}
      {retryMessage ? <div className="inline-note">{retryMessage}</div> : null}
      {finding.refutation_reason ? <details className="lifecycle-refutation"><summary>Independent review detail</summary><p>{finding.refutation_reason}</p></details> : null}
    </section>
  );
}

function lifecyclePhaseLabel(phase: FindingPhase): string {
  if (phase === "verify") return "Verify";
  if (phase === "confirm") return "Confirm";
  return "Report";
}

function DecisionReportModal({ decision, onClose }: { decision: ConfirmDecision; onClose: () => void }) {
  const fallback = useMemo(() => decisionReportMarkdown(decision), [decision]);
  const [markdown, setMarkdown] = useState(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setMarkdown(fallback);
    setError("");
    setLoading(true);
    void api
      .decisionReport(Number(decision.id))
      .then((response) => {
        if (!cancelled && response.markdown.trim()) setMarkdown(redactReportMarkdown(response.markdown));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decision.id, fallback]);
  return (
    <Modal title={`${decision.has_report ? "Submission report" : "Decision report"} #${decision.id ?? ""}`} wide onClose={onClose}>
      {loading ? <EmptyInline>Loading report...</EmptyInline> : null}
      {!loading && error ? <div className="inline-note">Showing a generated decision summary because the DB report endpoint could not be loaded.</div> : null}
      <MarkdownReport markdown={markdown} fileName={`decision-${decision.id ?? "report"}.md`} />
    </Modal>
  );
}

function ArtifactModal({ artifact, onClose }: { artifact: ArtifactPreview; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setBody("");
    setError("");
    setLoading(true);
    void api
      .artifact(artifact.runId, artifact.name)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const text = await response.text();
        if (!cancelled) setBody(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.runId, artifact.name]);
  const markdown = redactReportMarkdown(body);
  return (
    <Modal title={artifact.title} wide onClose={onClose}>
      <article className="artifact-preview">
        <p className="artifact-name"><strong>Artifact:</strong> <code>{artifact.name}</code></p>
        {loading ? <EmptyInline>Loading artifact...</EmptyInline> : null}
        {error ? <div className="inline-error">{error}</div> : null}
        {!loading && !error ? <MarkdownReport markdown={markdown || "Artifact is empty."} fileName={`${slugify(artifact.title)}.md`} /> : null}
      </article>
    </Modal>
  );
}

function findingReportMarkdown(finding: FindingRow): string {
  const lines = [
    `# ${finding.title ?? "Finding report"}`,
    "",
    `- Status: ${finding.status}`,
    finding.confirm_status ? `- Real-target status: ${finding.confirm_status}` : "",
    finding.location ? `- Location: \`${finding.location}\`` : "",
    finding.severity ? `- Severity: ${finding.severity}` : "",
    finding.confidence != null ? `- Confidence: ${Math.round(finding.confidence * 100)}%` : "",
    duplicateOfLabel(finding) ? `- Duplicate: ${duplicateOfLabel(finding)}` : "",
    "",
  ].filter(Boolean);
  if (finding.description) lines.push("## Description", "", finding.description, "");
  if (finding.evidence) lines.push("## Evidence", "", "```", finding.evidence, "```", "");
  if (finding.exploit_sketch) lines.push("## Exploit", "", finding.exploit_sketch, "");
  if (finding.fix) lines.push("## Fix", "", finding.fix, "");
  return lines.join("\n").trim();
}

function decisionReportMarkdown(decision: ConfirmDecision): string {
  const engagement = decisionStructuredObject(decision, "engagement_profile", "engagement_profile_json");
  const adjudication = decisionStructuredObject(decision, "adjudication", "adjudication_json");
  const lines = [
    `# ${decision.bug || "Submission report"}`,
    "",
    "- Submission unit: real-target decision",
    decision.reproduced ? `- Reproduced: ${decision.reproduced}` : "",
    decision.recommendation ? `- Recommendation: ${recommendationLabel(decision)}` : "",
    decision.severity ? `- Severity: ${decision.severity}` : "",
    decision.evidence_level ? `- Evidence level: ${decision.evidence_level}` : "",
    decision.submission_confidence ? `- Submission confidence: ${decision.submission_confidence}` : "",
    decision.repro_command_id ? `- Command evidence: \`${decision.repro_command_id}\`` : "",
    "",
  ].filter(Boolean);
  if (decision.repro_evidence) lines.push("## Reproduction Evidence", "", decision.repro_evidence, "");
  if (decision.distinct_fix) lines.push("## Distinct Fix", "", decision.distinct_fix, "");
  if (engagement || adjudication) {
    lines.push("## Engagement and Eligibility", "");
    if (engagement) lines.push(`- Engagement profile: ${jsonInline(engagement)}`);
    if (adjudication) lines.push(`- Eligibility / payout adjudication: ${jsonInline(adjudication)}`);
    lines.push("");
  }
  if (decision.corroboration || decision.novelty || decision.human_gates) {
    lines.push("## Novelty and Disclosure Notes", "");
    if (decision.corroboration) lines.push(`- Corroboration: ${decision.corroboration}`);
    if (decision.novelty) lines.push(`- Novelty: ${decision.novelty}`);
    if (decision.human_gates) lines.push(`- Human gates: ${decision.human_gates}`);
  }
  return lines.join("\n").trim();
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactReportMarkdown(markdown: string): string {
  return markdown
    .replace(/\/Users\/[^/\s`]+\/\.flounder/g, "~/.flounder")
    .replace(/\/Users\/[^/\s`]+\/[^\s`]*full-stack-auditor/g, "<flounder-repo>");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "report";
}

function downloadText(fileName: string, body: string, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fallbackCopyText(body: string) {
  const textarea = document.createElement("textarea");
  textarea.value = body;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function MarkdownReport({ markdown, fileName }: { markdown: string; fileName: string }) {
  const [copyLabel, setCopyLabel] = useState("Copy Markdown");
  const reportTitle = markdown.match(/^#\s+(.+)$/m)?.[1] ?? fileName.replace(/\.md$/i, "");
  const bodyMarkdown = markdown.replace(/^#\s+.+\n+/, "");
  async function copy() {
    setCopyLabel("Copied");
    window.setTimeout(() => setCopyLabel("Copy Markdown"), 1600);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(markdown);
      else fallbackCopyText(markdown);
    } catch {
      fallbackCopyText(markdown);
    }
  }
  return (
    <section className="markdown-report">
      <div className="report-document-head">
        <h1>{reportTitle}</h1>
        <div className="report-actions">
          <IconButton icon="copy" title="Copy Markdown" aria-label="Copy Markdown" onClick={() => void copy()} />
          {copyLabel === "Copied" ? <span className="copied-note">Copied</span> : null}
          <IconButton icon="download" title="Download Markdown" aria-label="Download Markdown" onClick={() => downloadText(fileName, markdown)} />
          <IconButton icon="printer" title="Export PDF" aria-label="Export PDF" onClick={() => window.print()} />
        </div>
      </div>
      <article className="report-preview markdown-body">
        {renderMarkdown(bodyMarkdown)}
      </article>
    </section>
  );
}

function renderMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      i += lines[i]?.startsWith("```") ? 1 : 0;
      nodes.push(<pre key={`code-${i}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      nodes.push(renderMarkdownHeading(level, heading[2], `h-${i}`));
      i += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(<li key={`li-${i}`}>{renderInlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>);
        i += 1;
      }
      nodes.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(<li key={`oli-${i}`}>{renderInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>);
        i += 1;
      }
      nodes.push(<ol key={`ol-${i}`}>{items}</ol>);
      continue;
    }
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    nodes.push(<p key={`p-${i}`}>{renderInlineMarkdown(paragraph.join(" "))}</p>);
  }
  return nodes;
}

function renderMarkdownHeading(level: number, text: string, key: string): ReactNode {
  if (level === 1) return <h1 key={key}>{renderInlineMarkdown(text)}</h1>;
  if (level === 2) return <h2 key={key}>{renderInlineMarkdown(text)}</h2>;
  return <h3 key={key}>{renderInlineMarkdown(text)}</h3>;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return <span key={index}>{part}</span>;
  });
}

function CommandPalette({ projects, currentProjectUuid, onClose, onNewProject, onLaunch }: { projects: ProjectSnapshot[]; currentProjectUuid?: string; onClose: () => void; onNewProject: () => void; onLaunch: () => void }) {
  const [query, setQuery] = useState("");
  const { dialogRef, onDialogKeyDown } = useDialogFocus(onClose);
  const commands = useMemo(() => {
    const projectCommands = projects.map((project) => ({ id: `p-${project.uuid}`, label: project.name, meta: "project", run: () => go(projectPathFor(project)) }));
    const current = currentProjectUuid ? projects.find((project) => project.uuid === currentProjectUuid) : undefined;
    const currentRunning = Boolean(current && ((current.activeRuns ?? 0) > 0 || current.latestRun?.status === "running"));
    const base = [
      { id: "new", label: "New project", meta: "create", run: onNewProject },
      { id: "findings", label: "Go to Findings", meta: "view", run: () => go("/findings") },
      { id: "evaluations", label: "Go to Evaluations", meta: "view", run: () => go("/evaluations") },
      { id: "projects", label: "Go to Projects", meta: "view", run: () => go("/") },
      { id: "settings", label: "Settings", meta: "view", run: () => go("/settings") },
      { id: "providers", label: "Provider profiles", meta: "settings", run: () => go("/settings") },
      { id: "daemons", label: "Daemons", meta: "settings", run: () => go("/settings/daemons") },
      ...(current && !currentRunning ? [{ id: "run", label: `${current.runCount ? "Continue" : "Run"} - ${current.name}`, meta: "run", run: onLaunch }] : []),
    ];
    return [...projectCommands, ...base].filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));
  }, [projects, query, currentProjectUuid, onNewProject, onLaunch]);
  return (
    <div className="modal-back command-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown} className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu">
        <div className="command-input-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Jump to a project or run a command..." autoFocus />
          <IconButton icon="x" title="Close" aria-label="Close command menu" onClick={onClose} />
        </div>
        <div className="command-list" role="listbox" aria-label="Commands">
          {commands.map((command) => (
            <button key={command.id} role="option" onClick={() => { command.run(); onClose(); }}>
              <span>{command.label}</span>
              <small>{command.meta}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const duration = toast.tone === "success" ? 3000 : toast.tone === "warning" ? 5000 : 8000;
    const timeout = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(timeout);
  }, [toast.message, toast.tone, onClose]);
  return (
    <div className={`toast ${toast.tone}`} role="status">
      <span>{toast.message}</span>
      <button onClick={onClose} aria-label="Dismiss notification"><Icon name="x" size={14} /></button>
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <h1>{title}</h1>
      <p>{body}</p>
      {action}
    </div>
  );
}

function FirstRunGuide({ providers, daemons, onNewProject }: { providers: ProviderProfile[]; daemons: DaemonRow[]; onNewProject: () => void }) {
  const online = daemons.filter((daemon) => daemonHealth(daemon) === "online").length;
  const hasProvider = providers.length > 0;
  return (
    <div className="empty-state setup-empty">
      <h1>Prepare your first audit</h1>
      <p>Flounder needs a model profile and a local daemon before a project can run. The server stores project state; the daemon holds provider credentials and executes queued work.</p>
      <div className="onboarding-steps" aria-label="First audit setup">
        <SetupStep index={1} title="Choose a model profile" ok={hasProvider} detail={hasProvider ? plural(providers.length, "provider profile") : "Create one profile for the model vendor and reasoning level."} />
        <SetupStep index={2} title="Connect a local daemon" ok={online > 0} detail={online > 0 ? plural(online, "daemon online", "daemons online") : "Mint a daemon token, then run the command in a local terminal."} />
        <SetupStep index={3} title="Create a project" ok={false} detail="Point the daemon workspace at source, build root, and optional docs/specs." muted />
      </div>
      <div className="onboarding-actions">
        <Button variant={!hasProvider ? "primary" : undefined} icon="package" onClick={() => go("/settings")}>{hasProvider ? "View Providers" : "Set up Provider"}</Button>
        <Button variant={hasProvider && online === 0 ? "primary" : undefined} icon="package" onClick={() => go("/settings/daemons")}>{online > 0 ? "View Daemons" : "Set up Daemon"}</Button>
        <Button variant={hasProvider && online > 0 ? "primary" : undefined} icon="package" disabled={!hasProvider} title={hasProvider ? "Create project" : "Create a provider profile first"} onClick={onNewProject}>New project</Button>
      </div>
    </div>
  );
}

function SetupStep({ index, title, detail, ok, muted }: { index: number; title: string; detail: string; ok: boolean; muted?: boolean }) {
  return (
    <div className={`setup-step ${ok ? "ok" : ""}${muted ? " muted-step" : ""}`}>
      <span className="step-kicker">
        <span className="step-index">{ok ? <Icon name="shieldcheck" size={13} /> : index}</span>
        {ok ? "Ready" : muted ? "Later" : "Next"}
      </span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </div>
  );
}

function EmptyInline({ children }: { children: React.ReactNode }) {
  return <div className="empty-inline">{children}</div>;
}

function splitPaths(value: string): string[] {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function numberOrUndefined(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
