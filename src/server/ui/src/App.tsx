import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  type ActivityRecord,
  type ConfirmDecision,
  type DaemonRow,
  type FindingRow,
  type ProjectDetail,
  type ProjectConfig,
  type ProjectPayload,
  type ProjectSnapshot,
  type PrepareSummary,
  type PiModel,
  type ProviderProfile,
  type RunRow,
  type ScopeRow,
} from "./api";
import { Button, Card, Counter, IconButton, Modal, StateBadge, StatusBadge } from "./components";
import {
  confirmedDecisions,
  fmtTime,
  isVerifyRun,
  pct,
  phaseState,
  projectConfig,
  parseJson,
  PHASE_DESC,
  rankCandidates,
  runProgress,
  runScopeBatchComplete,
  STATUSES,
  THINKING_LEVELS,
  TRACKING,
} from "./domain";
import { Icon, type IconName } from "./icons";

type View = "projects" | "findings" | "settings";
type SettingsPane = "providers" | "daemons";
type ProjectTab = "overview" | "findings" | "scopes" | "runs" | "setup";
type ModalName = "new-project" | "run" | "edit-project" | "report" | "run-log" | "artifact" | null;
type ArtifactPreview = { title: string; runId: number; name: string };
type ProjectPhase = "prepare" | "map" | "dig" | "confirm";
type LaunchAction = "run" | "map" | "audit" | "confirm" | "verify";

interface RouteState {
  view: View;
  projectUuid?: string;
  settingsPane: SettingsPane;
}

interface Toast {
  tone: "info" | "success" | "warning" | "error";
  message: string;
}

interface BugStats {
  total: number;
  byStatus: Record<string, number>;
  byTracking: Record<string, number>;
}

interface LaunchResult {
  jobId?: number;
  verb?: string;
  queued?: boolean;
  daemons?: number;
}

const ONLINE_MS = 90_000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const COVERAGE_MODES = [
  { value: "standard", label: "Standard - 30 scopes per run" },
  { value: "full", label: "Full - finish every pending scope" },
  { value: "half", label: "Half - finish half of pending scopes" },
  { value: "focused", label: "Focused - 10 scopes per run" },
  { value: "custom", label: "Custom cap" },
] as const;
type CoverageMode = (typeof COVERAGE_MODES)[number]["value"];

function initialTheme(): "light" | "dark" {
  const explicit = localStorage.getItem("flounder-theme-explicit") === "1";
  return explicit && localStorage.getItem("flounder-theme") === "dark" ? "dark" : "light";
}

function readRoute(): RouteState {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("p/")) return { view: "projects", projectUuid: decodeURIComponent(hash.slice(2)), settingsPane: "providers" };
  if (hash.startsWith("settings/daemons")) return { view: "settings", settingsPane: "daemons" };
  if (hash.startsWith("settings")) return { view: "settings", settingsPane: "providers" };
  if (hash.startsWith("findings")) return { view: "findings", settingsPane: "providers" };
  return { view: "projects", settingsPane: "providers" };
}

function go(hash: string) {
  window.location.hash = hash;
}

function scrollToProjectSection(id: string): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function projectHash(uuid: string): string {
  return `p/${encodeURIComponent(uuid)}`;
}

function projectHashFor(project: Pick<ProjectSnapshot, "uuid">): string {
  return projectHash(project.uuid);
}

const PROJECT_ACCENTS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2", "#7c3aed", "#475569", "#be123c"];

function projectAccent(uuid: string): string {
  let hash = 0;
  for (let i = 0; i < uuid.length; i += 1) hash = ((hash << 5) - hash + uuid.charCodeAt(i)) | 0;
  return PROJECT_ACCENTS[Math.abs(hash) % PROJECT_ACCENTS.length] ?? PROJECT_ACCENTS[0]!;
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
  return statusCount(project, "confirmed-differential") + statusCount(project, "confirmed-executable");
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

function daemonProviderStatuses(daemon: DaemonRow | undefined): Array<{ provider: string; configured: boolean; required?: boolean }> {
  const caps = daemon?.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return [];
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

function phaseProviderId(config: ProjectConfig, phase: ProjectPhase): number | undefined {
  const id = config.phaseProviders?.[phase];
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

function phaseProvider(detail: ProjectDetail, providers: ProviderProfile[], phase: ProjectPhase): ProviderProfile | undefined {
  const cfg = projectConfig(detail).cfg;
  const id = phaseProviderId(cfg, phase);
  return id ? providers.find((provider) => provider.id === id) : undefined;
}

function requiredProviderProfiles(detail: ProjectDetail, providers: ProviderProfile[]): ProviderProfile[] {
  const ids = new Set<number>();
  if (typeof detail.project.provider_id === "number") ids.add(detail.project.provider_id);
  const cfg = projectConfig(detail).cfg;
  for (const phase of ["prepare", "map", "dig", "confirm"] as const) {
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

function nextAction(finding: FindingRow): string {
  const tracking = finding.tracking_status ?? "open";
  if (tracking === "submitted") return "Watch vendor response";
  if (tracking === "accepted") return "Track fix";
  if (tracking === "fixed") return "Close";
  if (finding.status.startsWith("confirmed") && finding.confirm_status === "reproduced") return "Prepare disclosure";
  if (finding.status.startsWith("confirmed") && finding.confirm_status === "not-reproduced") return "Review reproduction";
  if (finding.status.startsWith("confirmed")) return "Confirm real target";
  if (finding.status === "suspected") return "Triage";
  if (finding.status === "refuted" || finding.status === "discharged") return "Archive";
  return "Review";
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return `confidence ${pct}%`;
}

function coverageModeFromConfig(cfg: { scopeCoverageMode?: string; maxScopes?: number }): CoverageMode {
  if (cfg.scopeCoverageMode && COVERAGE_MODES.some((mode) => mode.value === cfg.scopeCoverageMode)) return cfg.scopeCoverageMode as CoverageMode;
  if (cfg.maxScopes === 10) return "focused";
  if (cfg.maxScopes === 30 || cfg.maxScopes == null) return "standard";
  return "custom";
}

function coverageConfig(mode: CoverageMode, maxScopes: string): ProjectConfig {
  const cfg: ProjectConfig = { scopeCoverageMode: mode };
  if (mode === "custom") cfg.maxScopes = numberOrUndefined(maxScopes);
  return cfg;
}

function coverageLabel(cfg: { scopeCoverageMode?: string; maxScopes?: number }): string {
  const mode = coverageModeFromConfig(cfg);
  if (mode === "focused") return "Focused - 10 scopes";
  if (mode === "standard") return "Standard - 30 scopes";
  if (mode === "half") return "Half of pending";
  if (mode === "full") return "Full pending coverage";
  return `Custom - ${cfg.maxScopes ?? 30} scopes`;
}

function coverageCapText(mode: CoverageMode, maxScopes: string): string {
  if (mode === "focused") return "10";
  if (mode === "standard") return "30";
  if (mode === "half") return "half pending";
  if (mode === "full") return "all pending";
  return maxScopes;
}

function severityScore(finding: FindingRow): number {
  const sev = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[finding.severity ?? ""] ?? 0;
  const status = finding.status.startsWith("confirmed") ? 2 : finding.status === "suspected" ? 1 : 0;
  return status * 100 + sev * 10 + (finding.confidence ?? 0);
}

function topCandidateFindings(rows: FindingRow[] | undefined): FindingRow[] {
  const ranked = rankCandidates(rows);
  if (ranked.length) return ranked.slice(0, 8);
  return [...(rows ?? [])]
    .filter((finding) => finding.status.startsWith("confirmed") || finding.status === "suspected")
    .sort((a, b) => severityScore(b) - severityScore(a))
    .slice(0, 8);
}

function projectBadgeStatus(project: ProjectSnapshot): string | null | undefined {
  const latest = project.latestRun?.status;
  if ((project.activeRuns ?? 0) > 0 || latest === "running") return "running";
  if (latest === "error" || latest === "killed") return latest;
  const total = project.progress?.total ?? 0;
  const pending = project.progress?.pending ?? 0;
  if (total > 0 && pending > 0) return "partial";
  if ((project.verifyPendingFindings ?? 0) > 0 || (project.confirmPendingFindings ?? 0) > 0) return "partial";
  return latest ?? (total > 0 ? "done" : undefined);
}

function phaseLabel(phase: "prepare" | "map" | "dig" | "confirm"): string {
  return {
    prepare: "Prepare",
    map: "Map scopes",
    dig: "Dig",
    confirm: "Confirm",
  }[phase];
}

function phaseIcon(phase: "prepare" | "map" | "dig" | "confirm"): IconName {
  return {
    prepare: "sync",
    map: "search",
    dig: "bug",
    confirm: "shieldcheck",
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

function runKindLabel(kind: string, run?: RunRow): string {
  if (runScopeBatchComplete(run)) return isVerifyRun(run) ? "Finalize verification" : "Finalize audit";
  if (isVerifyRun(run)) return "Verify";
  return {
    prepare: "Prepare target",
    run: "Map + dig audit",
    map: "Map scopes",
    audit: "Dig scopes",
    confirm: "Confirm findings",
  }[kind] ?? kind;
}

function pendingConfirmFindings(rows: FindingRow[] | undefined): FindingRow[] {
  return (rows ?? []).filter((finding) => (finding.status === "confirmed-executable" || finding.status === "confirmed-differential") && !finding.confirm_status);
}

function localVerifiedFindings(rows: FindingRow[] | undefined): FindingRow[] {
  return (rows ?? []).filter((finding) => finding.status === "confirmed-executable" || finding.status === "confirmed-differential");
}

function pendingVerifyFindings(rows: FindingRow[] | undefined): FindingRow[] {
  const unresolved = (rows ?? []).filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source");
  return topCandidateFindings(unresolved);
}

function verifyButtonLabel(count: number): string {
  return count > 0 ? `Verify (${count})` : "Verify";
}

function verifyButtonTitle(count: number): string {
  return count > 0
    ? `Confirm-or-refute ${plural(count, "candidate")} by local execution before real-target confirmation.`
    : "No suspected or source-confirmed candidates are waiting for execution verification.";
}

function confirmButtonTitle(count: number, locallyVerified: number, launchLocked: boolean): string {
  if (launchLocked) return "A run is already active for this project.";
  if (count > 0) return `Reproduce ${plural(count, "finding")} on the real target.`;
  if (locallyVerified > 0) return "All locally confirmed findings already have real-target decisions.";
  return "Confirm becomes available after local verification produces an execution-confirmed finding.";
}

function verifyStatusSummary(rows: FindingRow[] | undefined): string {
  const passed = localVerifiedFindings(rows).length;
  const pending = (rows ?? []).filter((finding) => finding.status === "suspected" || finding.status === "confirmed-source").length;
  const refuted = (rows ?? []).filter((finding) => finding.status === "refuted").length;
  const parts = [];
  if (passed) parts.push(`${passed} passed`);
  if (pending) parts.push(`${pending} pending`);
  if (refuted) parts.push(`${refuted} refuted`);
  return parts.length ? `Local verification: ${parts.join(" · ")}` : "";
}

function findingsSummary(detail: ProjectDetail): string {
  const suspected = detail.statusCounts.suspected ?? 0;
  const source = detail.statusCounts["confirmed-source"] ?? 0;
  const confirmed = (detail.statusCounts["confirmed-differential"] ?? 0) + (detail.statusCounts["confirmed-executable"] ?? 0);
  const pieces = [];
  if (suspected) pieces.push(`${plural(suspected, "suspected lead")}`);
  if (source) pieces.push(`${plural(source, "source-confirmed lead")}`);
  if (confirmed) pieces.push(`${plural(confirmed, "audit-confirmed finding")}`);
  return pieces.length ? pieces.join(" · ") : "No candidate findings yet";
}

interface RunStages {
  synthesis?: { scopes?: number; produced?: number; pool?: number; at?: string };
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
  return detail.runs.find((run) => Boolean(runStages(run)[stage]));
}

interface ActivityLine {
  id: number;
  kind: "thinking" | "text" | "event";
  label: string;
  body: string;
  step?: number;
  meta?: string;
  time: number;
}

const STREAM_MERGE_WINDOW_MS = 15_000;
const STICKY_SCROLL_THRESHOLD_PX = 32;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

function normalizeActivityBody(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trimStart();
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
  for (const key of ["path", "bytes", "produced", "total", "audited", "pending", "deferred", "scopes", "findings", "hypotheses", "confirmedExecutable", "commandRuns", "steps", "stoppedReason", "resumed", "target", "runs", "toolchain", "command", "runId", "purpose", "passed", "exitCode", "timedOut", "matched", "missing", "output", "ok"] as const) {
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

function appendStreamLine(next: ActivityLine[], now: number, kind: ActivityLine["kind"], label: string, delta: string): void {
  const last = next[next.length - 1];
  const recentStreamIndex = [...next]
    .reverse()
    .findIndex((line) => line.kind === kind && line.label === label && now - line.time <= STREAM_MERGE_WINDOW_MS);
  if (last?.kind === kind && last.label === label) {
    next[next.length - 1] = { ...last, body: normalizeActivityBody(`${last.body}${delta}`), time: now };
  } else if (recentStreamIndex >= 0) {
    const index = next.length - 1 - recentStreamIndex;
    const line = next[index];
    next[index] = { ...line, body: normalizeActivityBody(`${line.body}${delta}`), time: now };
  } else {
    next.push({ id: now + next.length, kind, label, body: normalizeActivityBody(delta), time: now });
  }
}

function appendFinalStreamLine(next: ActivityLine[], now: number, kind: ActivityLine["kind"], label: string, body: string): void {
  const normalized = normalizeActivityBody(body);
  const recentStreamIndex = [...next]
    .reverse()
    .findIndex((line) => line.kind === kind && line.label === label && now - line.time <= STREAM_MERGE_WINDOW_MS);
  if (recentStreamIndex < 0) {
    next.push({ id: now + next.length, kind, label, body: normalized, time: now });
    return;
  }
  const index = next.length - 1 - recentStreamIndex;
  const line = next[index];
  const current = normalizeActivityBody(line.body);
  const merged = normalized.startsWith(current) || current.startsWith(normalized)
    ? (normalized.length >= current.length ? normalized : current)
    : `${current}${normalized}`.includes(`${normalized}${normalized}`)
      ? current
      : normalized;
  next[index] = { ...line, body: normalizeActivityBody(merged), time: now };
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
  const next = [...lines];
  const last = next[next.length - 1];
  const eventTs = typeof event.ts === "string" ? new Date(event.ts).getTime() : Date.now();
  const now = Number.isFinite(eventTs) ? eventTs : Date.now();
  if (event.kind === "thinking_delta") {
    const delta = activityDelta(event);
    if (delta) appendStreamLine(next, now, "thinking", "Thinking", delta);
    return next.slice(-60);
  }
  if (event.kind === "text_delta") {
    const delta = activityDelta(event);
    if (delta) appendStreamLine(next, now, "text", "Output", delta);
  } else if (event.kind === "step") {
    const canAnnotateAction =
      last?.kind === "event" &&
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
    const normalizedBody = event.kind === "audit_command_run"
      ? commandRunSummary(body, eventPayload(event))
      : actionFailed
        ? [action?.body ?? body, typeof event.result === "string" ? event.result : undefined].filter(Boolean).join("\n")
        : action?.body ?? summary?.body ?? body;
    if (event.kind === "audit_thinking") {
      appendFinalStreamLine(next, now, "thinking", "Thinking", normalizedBody);
      return next.slice(-60);
    }
    if (event.kind === "audit_text") {
      appendFinalStreamLine(next, now, "text", "Output", normalizedBody);
      return next.slice(-60);
    }
    next.push({
      id: now + next.length,
      kind: event.kind === "audit_thinking" ? "thinking" : "event",
      label: actionFailed ? "Action blocked" : action?.label ?? summary?.label ?? label,
      body: normalizeActivityBody(normalizedBody),
      time: now,
    });
  }
  return next.slice(-60);
}

function ActivityBody({ line, pre = false }: { line: ActivityLine; pre?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const limit = activityPreviewLimit(line.kind);
  const canExpand = line.body.length > limit;
  const visibleBody = canExpand && !expanded ? `${line.body.slice(0, limit).trimEnd()}...` : line.body;

  useEffect(() => {
    if (!canExpand) setExpanded(false);
  }, [canExpand, line.id]);

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
    { id: "all", label: "All", count: stats.total },
    { id: "differential", label: "Differential", status: "confirmed-differential", tracking: "open", count: stats.byStatus["confirmed-differential"] ?? 0 },
    { id: "executable", label: "Executable", status: "confirmed-executable", tracking: "open", count: stats.byStatus["confirmed-executable"] ?? 0 },
    { id: "triage", label: "Needs triage", status: "suspected", tracking: "open", count: stats.byStatus.suspected ?? 0 },
    { id: "submitted", label: "Submitted", tracking: "submitted", count: stats.byTracking.submitted ?? 0 },
    { id: "accepted", label: "Accepted", tracking: "accepted", count: stats.byTracking.accepted ?? 0 },
  ];
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => readRoute());
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [daemons, setDaemons] = useState<DaemonRow[]>([]);
  const [bugs, setBugs] = useState<FindingRow[]>([]);
  const [bugsTotal, setBugsTotal] = useState(0);
  const [bugStats, setBugStats] = useState<BugStats>({ total: 0, byStatus: {}, byTracking: {} });
  const [bugStatus, setBugStatus] = useState("");
  const [bugTracking, setBugTracking] = useState("");
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
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [logRun, setLogRun] = useState<RunRow | null>(null);
  const [stopConfirmRun, setStopConfirmRun] = useState<RunRow | null>(null);
  const [launchConfirmAction, setLaunchConfirmAction] = useState<LaunchAction | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => initialTheme());
  const [, setClockTick] = useState(0);
  const detailRef = useRef<ProjectDetail | null>(null);
  const detailRefreshRef = useRef(0);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

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
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  async function refreshBase() {
    const [projectRes, providerRes, daemonRes] = await Promise.all([api.projects(), api.providers(), api.daemons()]);
    setProjects(projectRes.projects);
    setProviders(providerRes.providers);
    setDaemons(daemonRes.daemons);
  }

  useEffect(() => {
    void refreshBase().catch((error: unknown) => setToast({ tone: "error", message: String(error instanceof Error ? error.message : error) }));
  }, []);

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
  }, [route.view, bugStatus, bugTracking, bugPage, bugPageSize, bugReloadKey]);

  useEffect(() => {
    setBugPage(1);
  }, [bugStatus, bugTracking]);

  const bugPageCount = Math.max(1, Math.ceil(bugsTotal / bugPageSize));
  useEffect(() => {
    if (bugPage > bugPageCount) setBugPage(bugPageCount);
  }, [bugPage, bugPageCount]);

  const selectedProject = route.projectUuid ? projects.find((p) => p.uuid === route.projectUuid) : undefined;
  const onlineDaemons = daemons.filter((daemon) => daemonHealth(daemon) === "online");
  const latestRunning = projects.reduce((n, project) => n + (project.activeRuns ?? (project.latestRun?.status === "running" ? 1 : 0)), 0);
  const visibleRunningRun = detail?.runs.some((run) => run.status === "running") ?? false;

  useEffect(() => {
    if (!latestRunning && !visibleRunningRun) return;
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [latestRunning, visibleRunningRun]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data) as { projects?: ProjectSnapshot[] };
        if (Array.isArray(payload.projects)) {
          setProjects(payload.projects);
          const currentUuid = route.projectUuid;
          const current = currentUuid ? payload.projects.find((project) => project.uuid === currentUuid) : undefined;
          const detailStillRunning = detailRef.current?.runs.some((run) => run.status === "running") ?? false;
          const shouldRefreshDetail = Boolean(current && ((current.activeRuns ?? 0) > 0 || current.latestRun?.status === "running" || detailStillRunning));
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
  }, [route.projectUuid]);

  async function launch(action: LaunchAction) {
    if (!route.projectUuid) return;
    let verifyCandidates: FindingRow[] = [];
    if (detail?.project.uuid === route.projectUuid) {
      const running = detail.runs.find((run) => run.status === "running");
      const selectedDaemon = daemons.find((daemon) => daemon.id === detail.project.daemon_id);
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
      const missingAuth = requiredProviderProfiles(detail, providers).filter((profile) => daemonHasProvider(selectedDaemon, profile.provider) === false);
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
      if (action === "confirm" && pendingConfirmFindings(detail.allFindings).length === 0) {
        setToast({ tone: "warning", message: "There are no audit-confirmed findings waiting for real-target confirmation yet." });
        setModal(null);
        return;
      }
      if (action === "verify") {
        verifyCandidates = pendingVerifyFindings(detail.allFindings);
        if (verifyCandidates.length === 0) {
          setToast({ tone: "warning", message: "There are no suspected or source-confirmed candidates waiting for execution verification." });
          setModal(null);
          return;
        }
      }
      if (action === "audit" && (detail.progress.pending ?? 0) === 0) {
        setToast({ tone: "warning", message: "There are no pending scopes to dig. Run map first or continue audit when new scopes are available." });
        setModal(null);
        return;
      }
    }
    setBusy(true);
    try {
      const verb = action === "verify" ? "audit" : action;
      const result = (await api.launchRun(route.projectUuid, {
        verb,
        ...(action === "verify" ? { verifyFindings: verifyCandidates } : {}),
      })) as LaunchResult;
      const waiting = (result.daemons ?? 0) === 0;
      const label = action === "verify" ? "verify" : verb;
      setToast({
        tone: waiting ? "warning" : "success",
        message: waiting
          ? `${label} queued, but no online daemon is connected. Start a daemon to claim the job.`
          : `${label} queued for ${plural(result.daemons ?? 0, "daemon")}.`,
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
    if (action === "verify" || action === "confirm") {
      setLaunchConfirmAction(action);
      return;
    }
    void launch(action);
  }

  async function updateTracking(finding: FindingRow, status: string) {
    try {
      await api.trackFinding(finding.id, status);
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

  async function updateRunTarget(run: RunRow, target: number) {
    try {
      await api.updateRun(run.id, { runScopesTarget: target });
      setToast({ tone: "success", message: `Run #${run.id} target updated to ${target}.` });
      if (route.projectUuid) setDetail(await api.project(route.projectUuid));
      await refreshBase();
    } catch (error) {
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
      {mobileMenuOpen ? <MobileMenu route={route} running={latestRunning} theme={theme} onClose={() => setMobileMenuOpen(false)} onTheme={() => {
        localStorage.setItem("flounder-theme-explicit", "1");
        setTheme(theme === "dark" ? "light" : "dark");
      }} /> : null}
      <div className={`app-shell view-${route.view}${route.projectUuid ? " has-project" : ""}`}>
        {route.view === "projects" ? (
          <>
            <ProjectSidebar
              projects={projects}
              selected={route.projectUuid}
              onNew={() => setModal("new-project")}
              onSelect={(uuid) => go(projectHash(uuid))}
            />
            <main className="workspace">
              {detail && selectedProject ? (
                <ProjectDetailView
                  project={selectedProject}
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
                  onOpenArtifact={(artifact) => {
                    setArtifactPreview(artifact);
                    setModal("artifact");
                  }}
                  onTracking={updateTracking}
                  onPatchScope={patchScope}
                  onStopRun={setStopConfirmRun}
                  onUpdateRunTarget={(run, target) => void updateRunTarget(run, target)}
                  onOpenRunLog={openRunLog}
                />
              ) : projects.length ? (
                <EmptyState
                  title="Select a project"
                  body="Pick a target from the project list, or create one when you have source, build root, and an execution profile ready."
                  action={<Button variant="primary" icon="package" onClick={() => setModal("new-project")}>New project</Button>}
                />
              ) : (
                <FirstRunGuide providers={providers} daemons={daemons} onNewProject={() => setModal("new-project")} />
              )}
            </main>
          </>
        ) : null}
        {route.view === "findings" ? (
          <GlobalFindingsView
            stats={bugStats}
            findings={bugs}
            total={bugsTotal}
            page={Math.min(bugPage, bugPageCount)}
            pageSize={bugPageSize}
            loading={bugLoading}
            error={bugError}
            status={bugStatus}
            tracking={bugTracking}
            setStatus={setBugStatus}
            setTracking={setBugTracking}
            setPage={setBugPage}
            setPageSize={setBugPageSize}
            onTracking={updateTracking}
            onOpenProject={(uuid) => go(projectHash(uuid))}
            onOpenReport={(finding) => {
              setReportFinding(finding);
              setModal("report");
            }}
          />
        ) : null}
        {route.view === "settings" ? <SettingsView pane={route.settingsPane} providers={providers} daemons={daemons} onRefresh={refreshBase} /> : null}
      </div>
      {cmdOpen ? <CommandPalette projects={projects} currentProjectUuid={route.projectUuid} onClose={() => setCmdOpen(false)} onNewProject={() => setModal("new-project")} onLaunch={() => requestLaunch("run")} /> : null}
      {modal === "new-project" ? (
        <NewProjectModal
          providers={providers}
          daemons={daemons}
          onClose={() => setModal(null)}
          onCreated={async (uuid) => {
            await refreshBase();
            setModal(null);
            go(projectHash(uuid));
          }}
          onError={(message) => setToast({ tone: "error", message })}
        />
      ) : null}
      {modal === "run" && detail ? <RunModal detail={detail} busy={busy} onClose={() => setModal(null)} onLaunch={requestLaunch} onUpdateRunTarget={(run, target) => void updateRunTarget(run, target)} onError={(message) => setToast({ tone: "error", message })} /> : null}
      {modal === "edit-project" && detail ? <EditProjectModal detail={detail} providers={providers} daemons={daemons} onClose={() => setModal(null)} onSaved={async () => { setDetail(await api.project(detail.project.uuid)); setModal(null); }} onError={(message) => setToast({ tone: "error", message })} /> : null}
      {modal === "report" && reportFinding ? <ReportModal finding={reportFinding} onClose={() => setModal(null)} /> : null}
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
      {launchConfirmAction && detail ? (
        <LaunchConfirmModal
          action={launchConfirmAction}
          detail={detail}
          busy={busy}
          onCancel={() => setLaunchConfirmAction(null)}
          onConfirm={() => {
            const action = launchConfirmAction;
            setLaunchConfirmAction(null);
            void launch(action);
          }}
        />
      ) : null}
      {toast ? <ToastView toast={toast} onClose={() => setToast(null)} /> : null}
    </>
  );
}

function ShellHeader({ route, running, theme, onTheme, onCommands, onMenu }: { route: RouteState; running: number; theme: string; onTheme: () => void; onCommands: () => void; onMenu: () => void }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => go("")} aria-label="Go to projects">
        <img className="brand-logo" src={theme === "dark" ? "/flounder-white.png" : "/flounder-black.png"} alt="Flounder" />
      </button>
      <nav className="topnav desktop-nav" aria-label="Primary">
        <button className={route.view === "projects" ? "sel" : ""} onClick={() => go(route.projectUuid ? projectHash(route.projectUuid) : "")}>Projects</button>
        <button className={route.view === "findings" ? "sel" : ""} onClick={() => go("findings")}>Findings</button>
      </nav>
      <div className="topbar-spacer" />
      {running > 0 ? <Counter live>{`${running} running`}</Counter> : null}
      <IconButton icon="search" title="Commands (Cmd-K)" aria-label="Commands" onClick={onCommands} />
      <IconButton className="desktop-tool" icon="gear" title="Settings" aria-label="Settings" selected={route.view === "settings"} onClick={() => go("settings")} />
      <IconButton className="desktop-tool" icon={theme === "dark" ? "sun" : "moon"} title="Toggle theme" aria-label="Toggle theme" onClick={onTheme} />
      <IconButton className="mobile-menu-button" icon="menu" title="Menu" aria-label="Menu" onClick={onMenu} />
    </header>
  );
}

function MobileMenu({ route, running, theme, onClose, onTheme }: { route: RouteState; running: number; theme: string; onClose: () => void; onTheme: () => void }) {
  const navigate = (hash: string) => {
    go(hash);
    onClose();
  };
  return (
    <div className="mobile-menu-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="mobile-menu" role="dialog" aria-modal="true" aria-label="Navigation menu">
        <div className="mobile-menu-head">
          <strong>Menu</strong>
          <IconButton icon="x" title="Close" aria-label="Close menu" onClick={onClose} />
        </div>
        {running > 0 ? <Counter live>{`${running} running`}</Counter> : null}
        <button className={route.view === "projects" ? "sel" : ""} onClick={() => navigate(route.projectUuid ? projectHash(route.projectUuid) : "")}>Projects</button>
        <button className={route.view === "findings" ? "sel" : ""} onClick={() => navigate("findings")}>Findings</button>
        <button className={route.view === "settings" ? "sel" : ""} onClick={() => navigate("settings")}>Settings</button>
        <button onClick={() => { onTheme(); onClose(); }}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
      </section>
    </div>
  );
}

function ProjectSidebar({ projects, selected, onSelect, onNew }: { projects: ProjectSnapshot[]; selected?: string; onSelect: (uuid: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState("");
  const filtered = projects.filter((project) => project.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="project-rail" aria-label="Projects">
      <div className="rail-head">
        <div>
          <h2>Projects</h2>
          <Counter>{projects.length}</Counter>
        </div>
        <Button variant={projects.length ? "primary" : undefined} icon="package" onClick={onNew}>New project</Button>
      </div>
      <input className="searchbar" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter projects..." aria-label="Filter projects" />
      <ul className="project-list" role="list">
        {filtered.map((project) => (
          <li key={project.uuid}>
            <button
              type="button"
              className={`project-row${selected === project.uuid ? " sel" : ""}`}
              style={{ "--project-color": projectAccent(project.uuid) } as React.CSSProperties}
              aria-current={selected === project.uuid ? "page" : undefined}
              aria-label={`Open project ${project.name}`}
              onClick={() => onSelect(project.uuid)}
            >
              <span className="project-row-top">
                <span className="project-dot" aria-hidden="true" />
                <span className="project-name">{shortName(project.name, 31)}</span>
                <StateBadge status={projectBadgeStatus(project)} />
              </span>
              <ProjectProgress project={project} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
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
  onOpenArtifact: (artifact: ArtifactPreview) => void;
  onTracking: (finding: FindingRow, status: string) => void;
  onPatchScope: (scopeId: string, body: unknown) => Promise<void> | void;
  onStopRun: (run: RunRow) => void;
  onUpdateRunTarget: (run: RunRow, target: number) => void;
  onOpenRunLog: (run: RunRow) => void;
}) {
  const { project, detail, providers, daemons, tab, setTab } = props;
  const provider = providers.find((p) => p.id === detail.project.provider_id);
  const selectedDaemon = daemons.find((daemon) => daemon.id === detail.project.daemon_id);
  const config = projectConfig(detail);
  const selectedDaemonOnline = selectedDaemon ? daemonHealth(selectedDaemon) === "online" : false;
  const online = selectedDaemonOnline ? [selectedDaemon] : [];
  const phases = phaseState(detail, detail.progress);
  const topCandidates = topCandidateFindings(detail.allFindings);
  const verifyCandidates = pendingVerifyFindings(detail.allFindings);
  const overviewCandidates = verifyCandidates.length ? verifyCandidates : topCandidates;
  const confirmed = totalConfirmed(project);
  const reproduced = confirmedDecisions(detail.confirmDecisions).length;
  const runningRun = detail.runs.find((run) => run.status === "running");
  const pendingConfirm = pendingConfirmFindings(detail.allFindings).length;
  const pendingVerify = verifyCandidates.length;
  const locallyVerified = localVerifiedFindings(detail.allFindings).length;
  const localVerifySummary = verifyStatusSummary(detail.allFindings);
  const setupAttention = prepareMaterialsAttention(detail.prepareSummary);
  const launchLocked = props.busy || Boolean(runningRun);
  const confirmTitle = confirmButtonTitle(pendingConfirm, locallyVerified, launchLocked);
  const requiredProviders = requiredProviderProfiles(detail, providers);
  const authStatuses = requiredProviders.map((profile) => ({ profile, status: daemonHasProvider(selectedDaemon, profile.provider) }));
  const authUnknown = authStatuses.some((entry) => entry.status === null);
  const authMissing = authStatuses.filter((entry) => entry.status === false);
  const phaseOverrides = (["prepare", "map", "dig", "confirm"] as const)
    .map((phase) => ({ phase, provider: phaseProvider(detail, providers, phase) }))
    .filter((entry) => entry.provider);
  const readyItems = [
    {
      label: "Daemon",
      state: selectedDaemon ? `${selectedDaemon.name ?? `daemon-${selectedDaemon.id}`} · ${relativeAge(selectedDaemon)}` : "No daemon selected",
      ok: selectedDaemonOnline,
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
    },
    { label: "Coverage", state: coverageLabel(config.cfg), ok: true },
    { label: "Source", state: config.sourcePaths.length ? `${plural(config.sourcePaths.length, "path")}` : "No source paths", ok: config.sourcePaths.length > 0 },
  ];
  const prepareInfo = (() => {
    if (runningRun?.kind === "prepare" && online.length === 0) {
      return {
        stat: "Waiting for daemon",
        detail: "Acquire source, match deployment, warm the build sandbox",
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
      detail: "Acquire source, match deployment, warm the build sandbox",
    };
  })();
  const phaseDisplayStatus = (phase: "prepare" | "map" | "dig" | "confirm") => {
    if (phase === "prepare" && phases.prepare.status === "none" && (config.sourcePaths.length || config.buildRoot)) return "ready";
    return phases[phase].status;
  };
  return (
    <div className="project-page">
      <Card>
        <div className="project-hero">
          <div className="hero-main">
            <div className="title-line">
              <h1>{project.name}</h1>
              <StateBadge status={projectBadgeStatus(project)} />
            </div>
            <div className="subtle-line">
              {provider ? providerProfileLabel(provider) : "no provider set"} · {selectedDaemon ? selectedDaemon.name ?? `daemon-${selectedDaemon.id}` : "no daemon selected"} · {detail.project.dir || project.name}
            </div>
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
              disabled={launchLocked}
              title={runningRun ? "A run is already active for this project." : "Map scopes if needed, then dig the next batch."}
              onClick={() => props.onLaunch("run")}
            >
              {runningRun ? "Audit running" : "Continue audit"}
            </Button>
            <Button
              icon="search"
              disabled={launchLocked || pendingVerify === 0}
              title={verifyButtonTitle(pendingVerify)}
              aria-label={verifyButtonTitle(pendingVerify)}
              onClick={() => props.onLaunch("verify")}
            >
              {verifyButtonLabel(pendingVerify)}
            </Button>
            <Button
              icon="shieldcheck"
              disabled={launchLocked || pendingConfirm === 0}
              title={confirmTitle}
              aria-label={confirmTitle}
              onClick={() => props.onLaunch("confirm")}
            >
              {pendingConfirm > 0 ? `Confirm (${pendingConfirm})` : "Confirm"}
            </Button>
            {runningRun ? <Button variant="danger" icon="x" onClick={() => props.onStopRun(runningRun)}>Stop run</Button> : null}
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
          <div className="info-panel run-notice">
            <strong>{online.length ? `${runKindLabel(runningRun.kind, runningRun)} is running.` : `${runKindLabel(runningRun.kind, runningRun)} is waiting for a daemon.`}</strong>
            <span>
              {online.length
                ? "New launches are locked until this run finishes or you stop it."
                : "No daemon is online, so the run may be stalled until an executor reconnects."} Current progress: {runProgress(runningRun, detail.confirmDecisions)}.
            </span>
          </div>
        ) : null}
        <div className="pipeline" aria-label="Audit pipeline">
          {(["prepare", "map", "dig", "confirm"] as const).map((phase) => {
            const displayStatus = phaseDisplayStatus(phase);
            const label = phase === "dig" && isVerifyRun(runningRun) ? "Verify" : phaseLabel(phase);
            return (
              <div key={phase} className={`phase ${displayStatus}`}>
                <span className="phase-head">
                  <span className="phase-title"><span className="phase-marker"><Icon name={phaseIcon(phase)} size={13} /></span>{label}</span>
                  <span className={`phase-state ${displayStatus}`}>{phaseStatusLabel(displayStatus)}</span>
                </span>
                <strong>{phase === "prepare" ? prepareInfo.stat : phases[phase].stat}</strong>
                <small className="phase-detail">
                  <span>{phase === "prepare" ? prepareInfo.detail : PHASE_DESC[phase]}</span>
                  {phases[phase].dur ? <span className="phase-time">{phases[phase].dur}</span> : null}
                </small>
              </div>
            );
          })}
        </div>
        <div className="stats">
          <Stat n={detail.progress.total} label="scopes" onClick={() => setTab("scopes")} />
          <Stat n={detail.findingsTotal} label="findings" onClick={() => { props.setFindingStatus(""); props.setFindingQuery(""); setTab("findings"); }} />
          <Stat n={overviewCandidates.length} label={pendingVerify ? "to verify" : "top candidates"} onClick={() => { props.setFindingStatus(""); props.setFindingQuery(""); setTab("overview"); scrollToProjectSection("project-top-candidates"); }} />
          <Stat n={confirmed} label="confirmed" good onClick={() => { props.setFindingStatus("execution-confirmed"); props.setFindingQuery(""); setTab("findings"); }} />
          <Stat n={reproduced} label="reproduced" onClick={() => setTab("overview")} />
          <Stat n={detail.runsTotal} label="runs" onClick={() => setTab("runs")} />
        </div>
        <ProjectSetupDisclosure items={readyItems} />
      </Card>
      <div className="tabs" role="tablist" aria-label="Project sections">
        {(["overview", "findings", "scopes", "runs", "setup"] as ProjectTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "sel" : ""}
            title={t === "setup" && setupAttention ? setupAttention.label : undefined}
            onClick={() => setTab(t)}
          >
            <span>{t}</span>
            {t === "setup" && setupAttention ? <span className={`tab-alert-dot ${setupAttention.tone}`} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      {tab === "overview" ? <ProjectOverview detail={detail} candidates={overviewCandidates} verifyCount={pendingVerify} verifyLocked={launchLocked || pendingVerify === 0} onVerifyCandidates={() => props.onLaunch("verify")} onOpenReport={props.onOpenReport} onOpenArtifact={props.onOpenArtifact} /> : null}
      {tab === "findings" ? (
        <ProjectFindings
          detail={detail}
          query={props.findingQuery}
          setQuery={props.setFindingQuery}
          status={props.findingStatus}
          setStatus={props.setFindingStatus}
          onOpenReport={props.onOpenReport}
          onTracking={props.onTracking}
        />
      ) : null}
      {tab === "scopes" ? <ScopesView detail={detail} onPatchScope={props.onPatchScope} /> : null}
      {tab === "runs" ? <RunsView detail={detail} onStopRun={props.onStopRun} onOpenLog={props.onOpenRunLog} /> : null}
      {tab === "setup" ? <ProjectSetupTab detail={detail} /> : null}
    </div>
  );
}

function prepareMaterialsAttention(summary?: PrepareSummary | null): { tone: "warn" | "pending"; label: string } | null {
  if (!summary) return null;
  const issues = summary.issues?.length ?? 0;
  const gaps = summary.gaps?.length ?? 0;
  const manifestMissing = summary.manifestStatus && summary.manifestStatus !== "present" ? 1 : 0;
  const manifestState = summary.manifestState?.toLowerCase();
  const manifestPartial = manifestState && !["complete", "ready", "ok"].includes(manifestState) ? 1 : 0;
  const count = issues + gaps + manifestMissing + manifestPartial;
  if (count <= 0) return null;
  return {
    tone: manifestMissing ? "pending" : "warn",
    label: `Prepared materials need review: ${plural(count, "issue")}`,
  };
}

function ProjectSetupDisclosure({ items }: { items: Array<{ label: string; state: string; ok: boolean }> }) {
  const warnings = items.filter((item) => !item.ok).length;
  return (
    <details className="setup-disclosure">
      <summary>
        <span>Project setup</span>
        <small>{warnings ? `${plural(warnings, "setup issue")} needs attention` : "Provider, daemon, source, and coverage details"}</small>
      </summary>
      <div className="setup-detail-grid">
        {items.map((item) => (
          <div key={item.label} className={`setup-detail ${item.ok ? "ok" : "warn"}`}>
            <span className="dot" />
            <span>
              <strong>{item.label}</strong>
              <small>{item.state}</small>
            </span>
          </div>
        ))}
      </div>
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
  onOpenArtifact,
}: {
  detail: ProjectDetail;
  candidates: FindingRow[];
  verifyCount: number;
  verifyLocked: boolean;
  onVerifyCandidates: () => void;
  onOpenReport: (finding: FindingRow) => void;
  onOpenArtifact: (artifact: ArtifactPreview) => void;
}) {
  const current = detail.runs.find((run) => run.status === "running") ?? detail.runs[0];
  const runningRun = detail.runs.find((run) => run.status === "running");
  const pendingConfirm = pendingConfirmFindings(detail.allFindings).length;
  const sourceConfirmed = detail.statusCounts["confirmed-source"] ?? 0;
  const suspectedLeads = detail.statusCounts.suspected ?? 0;
  const unverifiedLeads = sourceConfirmed + suspectedLeads;
  const decisions = detail.confirmDecisions.length;
  const reproduced = confirmedDecisions(detail.confirmDecisions).length;
  const progress = detail.progress;
  const scopeValue = progress.total > 0 ? `${progress.audited}/${progress.total} scopes audited` : "No scope map yet";
  const scopeDetail = progress.total > 0
    ? `${plural(progress.pending, "pending scope")}${progress.deferred ? ` · ${plural(progress.deferred, "deferred scope")}` : ""}`
    : "Run Map scopes or Continue audit to create the inventory.";
  const runLabel = runningRun ? "Current run" : current ? "Latest run" : "Next run";
  const runValue = current ? runKindLabel(current.kind, current) : "No runs yet";
  const runDetail = current ? overviewRunDetail(current, detail.confirmDecisions) : "Start Continue audit to prepare source, map scopes, and dig.";
  const synthesis = runStages(latestRunWithStage(detail, "synthesis")).synthesis;
  const verifyValue = verifyCount ? plural(verifyCount, "candidate") : pendingConfirm ? "Ready for confirm" : "No candidates";
  const verifyDetail = verifyCount
    ? `${plural(verifyCount, "prioritized candidate")} selected from ${plural(unverifiedLeads, "unverified lead")}`
    : pendingConfirm
      ? "Execution-confirmed findings can move to real-target confirmation."
      : "Synthesis and dig outputs appear as candidates here.";
  const synthesisValue = synthesis
    ? `${synthesis.produced ?? 0} composed ${synthesis.produced === 1 ? "lead" : "leads"}`
    : progress.audited > 0
      ? "No synthesis output"
      : "Not run yet";
  const synthesisDetail = synthesis
    ? `${plural(synthesis.pool ?? 0, "input finding")} across ${plural(synthesis.scopes ?? 0, "scope")}`
    : progress.audited > 0
      ? "Cross-scope composition has not produced a new candidate."
      : "Runs after dig when findings exist.";
  const proofDetail = pendingConfirm
    ? `${plural(pendingConfirm, "finding")} waiting for Confirm`
    : decisions
      ? `${reproduced}/${decisions} confirm decisions reproduced`
      : "Available after an audit-confirmed finding exists";
  const candidateTitle = verifyCount ? "Candidates to verify" : "Most suspicious bugs";
  const candidateSummary = verifyCount
    ? `${verifyCount} prioritized ${verifyCount === 1 ? "candidate needs" : "candidates need"} verification`
    : "No candidate waiting for execution verification";
  const candidateDetail = verifyCount
    ? "These suspected or source-confirmed findings are the next local verification worklist."
    : "Highest-ranked dig and synthesis outputs are shown here after local verification.";
  const candidateEmpty = verifyCount
    ? "Unverified candidates appear here after dig or synthesis."
    : "Ranked findings appear here after dig audits mapped scopes.";
  return (
    <>
      {runningRun ? <LiveActivityPanel run={runningRun} /> : null}
      <div id="project-top-candidates" className="section-anchor">
        <Card title={<span>{candidateTitle} <Counter>{candidates.length}</Counter></span>}>
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
      <Card title="Audit status">
        <div className="queue-grid">
          <QueueItem label={runLabel} value={runValue} detail={runDetail} />
          <QueueItem label="Scope coverage" value={scopeValue} detail={scopeDetail} />
          <QueueItem label="Synthesis" value={synthesisValue} detail={synthesisDetail} />
          <QueueItem label="Candidate verification" value={verifyValue} detail={verifyDetail} />
          <QueueItem label="Real-target proof" value={plural(reproduced, "reproduced finding")} detail={proofDetail} />
        </div>
      </Card>
      <ConfirmDecisionsCard decisions={detail.confirmDecisions} onOpenArtifact={onOpenArtifact} />
    </>
  );
}

function decisionLabel(decision: ConfirmDecision): string {
  if (decision.reproduced === "yes") return "reproduced";
  if (decision.reproduced === "no") return "not reproduced";
  return decision.reproduced || "undecided";
}

function recommendationLabel(decision: ConfirmDecision): string {
  return decision.recommendation ? decision.recommendation.replace(/-/g, " ") : "no recommendation";
}

function ConfirmDecisionsCard({ decisions, onOpenArtifact }: { decisions: ConfirmDecision[]; onOpenArtifact: (artifact: ArtifactPreview) => void }) {
  if (!decisions.length) return null;
  return (
    <Card title={<span>Real-target decisions <Counter>{decisions.length}</Counter></span>}>
      <div className="decision-list">
        {decisions.map((decision) => (
          <div className="decision-row" key={decision.id ?? `${decision.run_id}-${decision.bug}`}>
            <div className="decision-main">
              <span className={`label ${decision.reproduced === "yes" ? "s-confirmed-executable" : decision.reproduced === "no" ? "s-refuted" : "s-suspected"}`}>
                {decisionLabel(decision)}
              </span>
              <strong>{decision.bug}</strong>
              <small>{recommendationLabel(decision)}</small>
            </div>
            {decision.run_id ? (
              <Button size="sm" icon="shieldcheck" onClick={() => onOpenArtifact({ title: `Confirm report - #${decision.run_id}`, runId: decision.run_id!, name: "confirm_report.md" })}>
                Report
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ProjectSetupTab({ detail }: { detail: ProjectDetail }) {
  return detail.prepareSummary ? (
    <PrepareMaterialsCard summary={detail.prepareSummary} />
  ) : (
    <Card title="Prepared materials">
      <EmptyInline>Prepared source, corpus, deployment matching, and sandbox details appear here after a prepare run.</EmptyInline>
    </Card>
  );
}

function PrepareMaterialsCard({ summary }: { summary: PrepareSummary }) {
  const components = summary.components ?? [];
  const issues = summary.issues ?? [];
  const gaps = summary.gaps ?? [];
  const manifestReady = summary.manifestStatus === "present";
  const needsReview = issues.length > 0 || gaps.length > 0;
  const quality = needsReview ? "warn" : manifestReady ? "ok" : "pending";
  const workspace = summary.workspace ?? {};
  const filesLabel = workspace.filesTruncated ? `${(workspace.files ?? 0).toLocaleString()}+` : (workspace.files ?? 0).toLocaleString();
  const scopeDeclaration = readableScopeDeclaration(summary.scopeDeclaration);
  return (
    <Card title={<span>Prepared materials <Counter>{summary.componentsTotal ?? 0}</Counter></span>}>
      <div className="prepare-materials">
        <div className="prepare-head">
          <div className={`prepare-quality ${quality}`}>
            <span className="dot" />
            <span>
              <strong>{needsReview ? "Needs review" : manifestReady ? "Ready for sealed audit" : "Preparing materials"}</strong>
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
        {scopeDeclaration ? <p className="prepare-scope">{scopeDeclaration}</p> : null}
        <div className="prepare-meta">
          <span>Answer firewall: <strong>{summary.answerFirewall || "not reported"}</strong></span>
          {summary.posture ? <span>Posture: <strong>{summary.posture}</strong></span> : null}
        </div>
        {components.length ? (
          <div className="prepare-components" aria-label="Prepared components">
            {components.map((component, index) => (
              <div className="prepare-component" key={`${component.identity ?? "component"}-${index}`}>
                <span className={`label ${component.match === "matched" || component.match === "n/a" ? "s-confirmed-source" : component.match === "unverified" ? "s-suspected" : "s-refuted"}`}>
                  {component.match || "unreported"}
                </span>
                <div>
                  <strong>{component.identity || component.stagedPath || "unknown component"}</strong>
                  <small>
                    {[component.role, component.source, component.revision, component.stagedPath ? tailPath(component.stagedPath) : ""].filter(Boolean).join(" · ")}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyInline>No prepared components have been reported yet.</EmptyInline>
        )}
        {issues.length || gaps.length ? (
          <div className="prepare-lists">
            {issues.length ? <PrepareList title="Issues" items={issues} tone="warn" /> : null}
            {gaps.length ? <PrepareList title="Gaps" items={gaps} /> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
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
  if (run.status === "running") return `${run.status} · ${runProgress(run, decisions)}`;
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

function LiveActivityPanel({ run }: { run: RunRow }) {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const activityScroll = usePinnedScroll(lines, run.id);
  useEffect(() => {
    setLines([]);
    setFailed(false);
    setConnected(false);
    const source = new EventSource(`/api/runs/${run.id}/log`);
    source.onopen = () => {
      setConnected(true);
      setFailed(false);
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ActivityRecord;
        setLines((current) => appendActivityLine(current, event));
      } catch {
        // Ignore malformed frames; the status polling still owns run state.
      }
    };
    source.onerror = () => {
      setConnected(false);
      setFailed(true);
    };
    return () => source.close();
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
            {connected ? "Live" : failed ? "Reconnecting" : "Connecting"}
          </span>
        </div>
        {lines.length ? (
          <div className="activity-scroll-wrap">
            <div className="activity-timeline" ref={activityScroll.scrollRef} onScroll={activityScroll.onScroll}>
              {lines.map((line) => (
                <div key={line.id} className={`activity-entry ${line.kind}`}>
                  <span className="activity-dot" />
                  <div className="activity-content">
                    <span className="activity-kicker">
                      <span>{line.label}</span>
                      <span className="activity-meta">
                        {line.meta ? <span>{line.meta}</span> : line.step ? <span>{`Step ${line.step}`}</span> : null}
                        <time dateTime={new Date(line.time).toISOString()}>{formatActivityTime(line.time)}</time>
                      </span>
                    </span>
                    <ActivityBody line={line} />
                  </div>
                </div>
              ))}
            </div>
            {!activityScroll.isPinned ? <button className="latest-button" type="button" onClick={activityScroll.scrollToBottom}>Latest</button> : null}
          </div>
        ) : (
          <div className="activity-empty">
            <strong>{connected ? "Waiting for the first model event" : "Connecting to the run stream"}</strong>
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    setPage(1);
  }, [uuid, props.status, props.query]);

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
  }, [uuid, props.status, props.query, safePage, pageSize, props.detail.findingsTotal]);

  const empty = props.detail.findingsTotal
    ? "No findings match the current filters."
    : "No findings yet. Findings appear after dig audits mapped scopes and produces a locally checked claim.";
  return (
    <Card title={<span>Findings <Counter>{total}</Counter></span>}>
      <div className="table-tools">
        <input className="searchbar" value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="Search findings..." aria-label="Search findings" />
        <select value={props.status} onChange={(event) => props.setStatus(event.target.value)} aria-label="Filter finding status">
          <option value="">All statuses</option>
          <option value="execution-confirmed">Execution confirmed</option>
          {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select>
      </div>
      {error ? <EmptyInline>{error}</EmptyInline> : loading && rows.length === 0 ? <EmptyInline>Loading findings...</EmptyInline> : (
        <FindingTable
          rows={rows}
          total={total}
          page={safePage}
          pageSize={pageSize}
          paginationKey={`${props.status}:${props.query}`}
          empty={empty}
          onPage={setPage}
          onPageSize={setPageSize}
          onOpenReport={props.onOpenReport}
          onTracking={props.onTracking}
        />
      )}
    </Card>
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
                <span className={`label s-${scope.status}`}>{scope.status}</span>
                <div>
                  <strong>{scope.title || scope.scope_id}</strong>
                  <small>{scope.location || scope.scope_id}</small>
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
      ) : (
        <EmptyInline>No scopes mapped yet. Run Map scopes or Continue audit to create the scope inventory before digging.</EmptyInline>
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
        <EmptyInline>No runs yet. Start Continue audit to prepare the target, map scopes, and begin digging.</EmptyInline>
      )}
    </Card>
  );
}

function GlobalFindingsView(props: {
  stats: BugStats;
  findings: FindingRow[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string;
  status: string;
  tracking: string;
  setStatus: (status: string) => void;
  setTracking: (tracking: string) => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  onTracking: (finding: FindingRow, status: string) => void;
  onOpenProject: (uuid: string) => void;
  onOpenReport: (finding: FindingRow) => void;
}) {
  const views = savedBugViews(props.stats);
  const activeView = views.find((view) => (view.status ?? "") === props.status && (view.tracking ?? "") === props.tracking)?.id ?? "custom";
  return (
    <main className="full-view findings-view">
      <Card>
        <div className="page-head">
          <div>
            <h1>Findings across all projects</h1>
            <p>Submission tracking from discovery through real-target confirmation and vendor disclosure.</p>
          </div>
          <div className="headline-stats">
            <Stat n={props.stats.total} label="total" />
            <Stat n={(props.stats.byStatus["confirmed-differential"] ?? 0) + (props.stats.byStatus["confirmed-executable"] ?? 0)} label="audit confirmed" good />
            <Stat n={props.stats.byTracking.submitted ?? 0} label="submitted" />
            <Stat n={props.stats.byTracking.accepted ?? 0} label="accepted" />
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
          <select value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
            <option value="">All audit statuses</option>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <select value={props.tracking} onChange={(event) => props.setTracking(event.target.value)}>
            <option value="">All tracking states</option>
            {TRACKING.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
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
            paginationKey={`${props.status}:${props.tracking}`}
            global
            onPage={props.setPage}
            onPageSize={props.setPageSize}
            onOpenProject={props.onOpenProject}
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
      {findings.map((finding, index) => (
        <button key={finding.id} className="candidate-row" onClick={() => onOpenReport(finding)}>
          <span className="rank">{index + 1}</span>
          <span className="grow">
            <strong>{finding.title}</strong>
            <small>{finding.location}</small>
          </span>
          <span className="candidate-meta">
            <StatusBadge status={finding.status} />
            {finding.severity ? <span className={`severity sev-${finding.severity}`}>{finding.severity}</span> : null}
            {finding.confidence != null ? <span className="confidence">{formatConfidence(finding.confidence)}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
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
              {global ? <th>Project</th> : null}
              <th>Status</th>
              <th>Title</th>
              <th>Location</th>
              <th>Next action</th>
              <th>Tracking</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((finding) => (
              <tr key={finding.id}>
                {global ? (
                  <td className="project-cell">
                    {finding.project_uuid ? (
                      <button type="button" className="table-link" onClick={() => onOpenProject?.(finding.project_uuid!)}>{finding.project_name}</button>
                    ) : finding.project_name}
                  </td>
                ) : null}
                <td><StatusBadge status={finding.status} /></td>
                <td className="title-cell">{finding.title}</td>
                <td><code>{finding.location}</code></td>
                <td>{nextAction(finding)}</td>
                <td>
                  <select value={finding.tracking_status ?? "open"} onChange={(event) => onTracking(finding, event.target.value)} aria-label={`Tracking for ${finding.title ?? "finding"}`}>
                    {TRACKING.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </td>
                <td><Button size="sm" onClick={() => onOpenReport(finding)}>Report</Button></td>
              </tr>
            ))}
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

function SettingsView({ pane, providers, daemons, onRefresh }: { pane: SettingsPane; providers: ProviderProfile[]; daemons: DaemonRow[]; onRefresh: () => Promise<void> }) {
  return (
    <main className="settings-view">
      <aside className="settings-rail">
        <h1>Settings</h1>
        <button className={pane === "providers" ? "sel" : ""} onClick={() => go("settings")}>Providers</button>
        <button className={pane === "daemons" ? "sel" : ""} onClick={() => go("settings/daemons")}>Daemons</button>
      </aside>
      <section className="settings-content">
        {pane === "providers" ? <ProvidersPane providers={providers} onRefresh={onRefresh} /> : <DaemonsPane daemons={daemons} onRefresh={onRefresh} />}
      </section>
    </main>
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
      <div className="info-panel">
        <strong>Authentication lives on each daemon.</strong>
        <span>Run <code>flounder daemon provider login &lt;provider&gt;</code> on every executor machine, or start <code>flounder daemon start</code> with that provider's required environment variables. The server stores provider/model choices only, never API keys.</span>
        <code>flounder daemon provider check openai-codex</code>
      </div>
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
      <label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="openai-codex · gpt-5.5 · xhigh" /></label>
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
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [error, setError] = useState("");
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
      <div className="info-panel">
        <strong>Local executor setup</strong>
        <span>Click <strong>New Daemon</strong> to mint a token, then run the printed command in another terminal. Before starting work, authenticate the selected providers on that daemon machine with <code>flounder daemon provider login &lt;provider&gt;</code> or provider-specific environment variables.</span>
        <code>flounder daemon start --server {window.location.origin} --token &lt;token&gt;</code>
        <code>flounder daemon provider check openai-codex</code>
        <span>Project paths resolve under the daemon workspace. The default is ~/.flounder/workspace; pass --workspace to use another root.</span>
      </div>
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

type BudgetForm = { digSamples: string; mapSteps: string; digSteps: string; digConcurrency: string };
type PhaseProviderForm = Record<ProjectPhase, string>;

function applyBudgetFields(config: ProjectConfig, form: BudgetForm): ProjectConfig {
  const next = { ...config };
  setOptionalNumber(next, "digSamples", form.digSamples);
  setOptionalNumber(next, "mapSteps", form.mapSteps);
  setOptionalNumber(next, "digSteps", form.digSteps);
  setOptionalNumber(next, "digConcurrency", form.digConcurrency);
  return next;
}

function setOptionalNumber(config: ProjectConfig, key: keyof Pick<ProjectConfig, "digSamples" | "mapSteps" | "digSteps" | "digConcurrency">, value: string): void {
  const parsed = numberOrUndefined(value);
  if (parsed === undefined) delete config[key];
  else config[key] = parsed;
}

function phaseProviderConfig(form: PhaseProviderForm): ProjectConfig["phaseProviders"] | undefined {
  const out: NonNullable<ProjectConfig["phaseProviders"]> = {};
  for (const phase of ["prepare", "map", "dig", "confirm"] as const) {
    const id = numberOrUndefined(form[phase]);
    if (id !== undefined) out[phase] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

function selectedProfilesForForm(defaultProviderId: string, phaseProviders: PhaseProviderForm, providers: ProviderProfile[]): ProviderProfile[] {
  const ids = new Set<number>();
  const defaultId = numberOrUndefined(defaultProviderId);
  if (defaultId !== undefined) ids.add(defaultId);
  for (const phase of ["prepare", "map", "dig", "confirm"] as const) {
    const id = numberOrUndefined(phaseProviders[phase]);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].flatMap((id) => {
    const profile = providers.find((entry) => entry.id === id);
    return profile ? [profile] : [];
  });
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
      {(["prepare", "map", "dig", "confirm"] as const).map((phase) => (
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

function NewProjectModal({ providers, daemons, onClose, onCreated, onError }: { providers: ProviderProfile[]; daemons: DaemonRow[]; onClose: () => void; onCreated: (uuid: string) => Promise<void>; onError: (message: string) => void }) {
  const [advanced, setAdvanced] = useState(false);
  const [phaseOpen, setPhaseOpen] = useState(false);
  const firstDaemon = daemons.find((daemon) => daemonHealth(daemon) === "online") ?? daemons[0];
  const [form, setForm] = useState({ name: "", daemonId: firstDaemon?.id ? String(firstDaemon.id) : "", providerId: providers[0]?.id ? String(providers[0].id) : "", dir: "", sourcePaths: ".", buildRoot: ".", corpusPaths: "docs/specs", coverageMode: "standard" as CoverageMode, maxScopes: "30", digSamples: "1", mapSteps: "", digSteps: "", digConcurrency: "1" });
  const [phaseProviders, setPhaseProviders] = useState<PhaseProviderForm>({ prepare: "", map: "", dig: "", confirm: "" });
  const providerMissing = providers.length === 0;
  const daemonMissing = daemons.length === 0;
  const selectedDaemon = daemons.find((daemon) => String(daemon.id) === form.daemonId);
  const selectedProfiles = selectedProfilesForForm(form.providerId, phaseProviders, providers);
  const canSubmit = !providerMissing && !daemonMissing && Boolean(form.daemonId) && Boolean(form.providerId);
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
    const cfg = applyBudgetFields(coverageConfig(form.coverageMode, form.maxScopes), form);
    const phaseCfg = phaseProviderConfig(phaseProviders);
    if (phaseCfg) cfg.phaseProviders = phaseCfg;
    const payload: ProjectPayload = {
      name: form.name.trim(),
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
      await onCreated(created.uuid);
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <Modal project title="Create project" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-project-form" disabled={!canSubmit}>Create project</Button></>}>
      <form id="new-project-form" className="project-form" onSubmit={(event) => void submit(event)}>
        {providerMissing || daemonMissing ? (
          <div className="inline-note">
            {providerMissing ? "Create a provider profile in Settings first. " : null}
            {daemonMissing ? "Create and connect a daemon in Settings first. " : null}
            Credentials stay on the selected daemon; the server stores only routing and model choices.
          </div>
        ) : null}
        <FormSection title="Basics">
          <div className="form-grid two">
            <Field label="Project name" span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="aztec-rollup" autoFocus /></Field>
            <Field label="Execution daemon" help={daemonMissing ? "Go to Settings -> Daemons to create one." : "Jobs for this project are claimed only by this daemon."}><select required disabled={daemonMissing} value={form.daemonId} onChange={(event) => setForm({ ...form, daemonId: event.target.value })}><option value="" disabled>Select daemon</option>{daemons.map((d) => <option key={d.id} value={d.id}>{d.name ?? `daemon-${d.id}`} · {relativeAge(d)}</option>)}</select></Field>
            <Field label="Default provider" help={providerMissing ? "Go to Settings -> Providers to create one." : "Used by every phase unless overridden below."}><select required disabled={providerMissing} value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })}><option value="" disabled>Select provider</option>{providers.map((p) => <option key={p.id} value={p.id}>{providerProfileLabel(p)}</option>)}</select></Field>
            <Field label="Project directory" help="Resolved under the daemon workspace. Empty uses the project name."><input value={form.dir} onChange={(event) => setForm({ ...form, dir: event.target.value })} placeholder="defaults to project name" /></Field>
          </div>
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
            <Field label="Scopes per run" help="How many mapped scopes the next dig batch audits.">
              {form.coverageMode === "custom" ? <input value={form.maxScopes} onChange={(event) => setForm({ ...form, maxScopes: event.target.value })} /> : <span className="readonly-field">{coverageCapText(form.coverageMode, form.maxScopes)}</span>}
            </Field>
          </div>
        </FormSection>
        <button type="button" className="advanced-toggle" onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide budget controls" : "Show budget controls"}</button>
        {advanced ? (
          <FormSection title="Budget controls">
            <div className="form-grid two">
              <Field label="Map turn cap" help="Maximum model turns for scope enumeration; empty means unbounded."><input value={form.mapSteps} onChange={(event) => setForm({ ...form, mapSteps: event.target.value })} placeholder="unbounded" /></Field>
              <Field label="Dig turn cap" help="Maximum model turns per scope; empty means unbounded."><input value={form.digSteps} onChange={(event) => setForm({ ...form, digSteps: event.target.value })} placeholder="unbounded" /></Field>
              <Field label="Dig samples" help="Independent dig passes per selected scope; findings are unioned."><input value={form.digSamples} onChange={(event) => setForm({ ...form, digSamples: event.target.value })} /></Field>
              <Field label="Dig concurrency" help="How many scopes run in parallel. 1 keeps digs sequential."><input value={form.digConcurrency} onChange={(event) => setForm({ ...form, digConcurrency: event.target.value })} /></Field>
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
  const [form, setForm] = useState({
    daemonId: detail.project.daemon_id ? String(detail.project.daemon_id) : "",
    providerId: detail.project.provider_id ? String(detail.project.provider_id) : "",
    dir: detail.project.dir ?? "",
    sourcePaths: cfg.sourcePaths.join(" "),
    buildRoot: cfg.buildRoot,
    corpusPaths: cfg.corpusPaths.join(" "),
    coverageMode: initialCoverageMode,
    maxScopes: String(cfg.cfg.maxScopes ?? (initialCoverageMode === "focused" ? 10 : 30)),
    digSamples: String(cfg.cfg.digSamples ?? 1),
    mapSteps: cfg.cfg.mapSteps != null ? String(cfg.cfg.mapSteps) : "",
    digSteps: cfg.cfg.digSteps != null ? String(cfg.cfg.digSteps) : "",
    digConcurrency: String(cfg.cfg.digConcurrency ?? 1),
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
      const nextConfig = applyBudgetFields({ ...cfg.cfg, ...coverageConfig(form.coverageMode, form.maxScopes) }, form);
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
        <FormSection title="Basics">
          <div className="form-grid two">
            <Field label="Execution daemon" help="Jobs for this project are claimed only by this daemon."><select required value={form.daemonId} onChange={(event) => setForm({ ...form, daemonId: event.target.value })}><option value="" disabled>Select daemon</option>{daemons.map((d) => <option key={d.id} value={d.id}>{d.name ?? `daemon-${d.id}`} · {relativeAge(d)}</option>)}</select></Field>
            <Field label="Default provider" help="Used by every phase unless overridden below."><select required value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })}><option value="" disabled>Select provider</option>{providers.map((p) => <option key={p.id} value={p.id}>{providerProfileLabel(p)}</option>)}</select></Field>
            <Field label="Project directory" help="Resolved under the daemon workspace."><input value={form.dir} onChange={(event) => setForm({ ...form, dir: event.target.value })} /></Field>
          </div>
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
            <Field label="Scopes per run" help="How many mapped scopes the next dig batch audits.">
              {form.coverageMode === "custom" ? <input value={form.maxScopes} onChange={(event) => setForm({ ...form, maxScopes: event.target.value })} /> : <span className="readonly-field">{coverageCapText(form.coverageMode, form.maxScopes)}</span>}
            </Field>
          </div>
        </FormSection>
        <FormSection title="Budget controls">
          <div className="form-grid two">
            <Field label="Map turn cap" help="Maximum model turns for scope enumeration; empty means unbounded."><input value={form.mapSteps} onChange={(event) => setForm({ ...form, mapSteps: event.target.value })} placeholder="unbounded" /></Field>
            <Field label="Dig turn cap" help="Maximum model turns per scope; empty means unbounded."><input value={form.digSteps} onChange={(event) => setForm({ ...form, digSteps: event.target.value })} placeholder="unbounded" /></Field>
            <Field label="Dig samples" help="Independent dig passes per selected scope; findings are unioned."><input value={form.digSamples} onChange={(event) => setForm({ ...form, digSamples: event.target.value })} /></Field>
            <Field label="Dig concurrency" help="How many scopes run in parallel. 1 keeps digs sequential."><input value={form.digConcurrency} onChange={(event) => setForm({ ...form, digConcurrency: event.target.value })} /></Field>
          </div>
        </FormSection>
      </form>
    </Modal>
  );
}

function RunModal({ detail, busy, onClose, onLaunch, onUpdateRunTarget, onError }: { detail: ProjectDetail; busy: boolean; onClose: () => void; onLaunch: (action: LaunchAction) => void; onUpdateRunTarget: (run: RunRow, target: number) => void; onError: (message: string) => void }) {
  const running = detail.runs.find((run) => run.status === "running");
  const pendingScopes = detail.progress.pending ?? 0;
  const confirmable = pendingConfirmFindings(detail.allFindings).length;
  const verifiable = pendingVerifyFindings(detail.allFindings).length;
  const locked = busy || Boolean(running);
  const [runTargetDraft, setRunTargetDraft] = useState("");
  useEffect(() => {
    if (!running) return;
    setRunTargetDraft(String(running.run_scopes_target ?? 30));
  }, [running?.id, running?.run_scopes_target]);
  const submitRunTarget = (event: FormEvent) => {
    event.preventDefault();
    if (!running) return;
    const target = Number(runTargetDraft);
    if (!Number.isFinite(target) || target < 1) {
      onError("Enter a positive batch target for the active run.");
      return;
    }
    onUpdateRunTarget(running, Math.floor(target));
  };
  const options: Array<{ verb: LaunchAction; label: string; detail: string; disabled?: boolean }> = [
    { verb: "run", label: "Continue audit", detail: "Prepare if needed, map scopes if needed, then dig the next batch.", disabled: locked },
    { verb: "map", label: "Map scopes only", detail: "Build or refresh the scope inventory without digging.", disabled: locked },
    { verb: "audit", label: "Dig pending scopes", detail: pendingScopes ? `Deep-audit the next pending batch from ${plural(pendingScopes, "mapped scope")}.` : "Disabled until Map scopes creates pending scope inventory.", disabled: locked || pendingScopes === 0 },
    { verb: "verify", label: verifyButtonLabel(verifiable), detail: verifiable ? `Confirm-or-refute ${plural(verifiable, "candidate")} by local execution.` : "Disabled until synthesis or dig leaves suspected candidates.", disabled: locked || verifiable === 0 },
    { verb: "confirm", label: "Confirm", detail: confirmable ? `Reproduce ${plural(confirmable, "execution-confirmed finding")} against the real target.` : "Disabled until local execution confirms a finding.", disabled: locked || confirmable === 0 },
  ];
  return (
    <Modal title={`${running ? "Run settings" : "Run audit"} - ${detail.project.name}`} onClose={onClose}>
      {running ? (
        <div className="info-panel active-run-settings compact">
          <div>
            <strong>{runKindLabel(running.kind, running)} is running</strong>
            <span>{runProgress(running, detail.confirmDecisions)}</span>
          </div>
          {(running.kind === "run" || running.kind === "audit") && running.run_scopes_target != null ? (
            <form className="run-target-control" onSubmit={submitRunTarget}>
              <label>
                <span>Batch target</span>
                <input type="number" min="1" value={runTargetDraft} onChange={(event) => setRunTargetDraft(event.target.value)} />
              </label>
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

function LaunchConfirmModal({ action, detail, busy, onCancel, onConfirm }: { action: LaunchAction; detail: ProjectDetail; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const verifyCount = pendingVerifyFindings(detail.allFindings).length;
  const confirmCount = pendingConfirmFindings(detail.allFindings).length;
  const isConfirm = action === "confirm";
  const count = isConfirm ? confirmCount : verifyCount;
  return (
    <Modal
      title={isConfirm ? "Start real-target confirmation?" : "Verify candidates?"}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={isConfirm ? "shieldcheck" : "search"} onClick={onConfirm} disabled={busy || count === 0}>
            {isConfirm ? "Confirm" : "Verify"}
          </Button>
        </>
      )}
    >
      <div className="confirm-copy">
        <strong>{isConfirm ? `${plural(count, "finding")} will be checked against the real target.` : `${plural(count, "candidate")} will be checked by local execution.`}</strong>
        <p>
          {isConfirm
            ? "This may use network reads and local forks to reproduce already audit-confirmed findings. Flounder still keeps the white-hat boundary: no broadcast and no live-system writes."
            : "This starts a local confirm-or-refute run for suspected or source-confirmed candidates. It can take time and will write normal run artifacts, but it does not contact real targets."}
        </p>
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
  const logScroll = usePinnedScroll(lines, run.id);
  return (
    <Modal title={`Run log - #${run.id}`} wide onClose={onClose}>
      <div className="run-log-head">
        <StateBadge status={run.status} />
        <strong>{runKindLabel(run.kind, run)}</strong>
        <span>{runProgress(run, [])}</span>
        {lastLine ? <span>Last activity {formatActivityTime(lastLine.time)}</span> : null}
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
                <span className="run-log-kind">{line.meta ? `${line.label} · ${line.meta}` : line.step ? `${line.label} · step ${line.step}` : line.label}</span>
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
  return (
    <Modal title="Finding report" wide onClose={onClose}>
      <article className="report-preview">
        <StatusBadge status={finding.status} />
        <h2>{finding.title}</h2>
        <p><strong>Location:</strong> <code>{finding.location}</code></p>
        {finding.description ? <p>{finding.description}</p> : null}
        {finding.evidence ? <pre>{finding.evidence}</pre> : null}
        {finding.exploit_sketch ? <p><strong>Exploit:</strong> {finding.exploit_sketch}</p> : null}
        {finding.fix ? <p><strong>Fix:</strong> {finding.fix}</p> : null}
      </article>
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
  return (
    <Modal title={artifact.title} wide onClose={onClose}>
      <article className="report-preview artifact-preview">
        <p><strong>Artifact:</strong> <code>{artifact.name}</code></p>
        {loading ? <EmptyInline>Loading artifact...</EmptyInline> : null}
        {error ? <div className="inline-error">{error}</div> : null}
        {!loading && !error ? <pre>{body || "Artifact is empty."}</pre> : null}
      </article>
    </Modal>
  );
}

function CommandPalette({ projects, currentProjectUuid, onClose, onNewProject, onLaunch }: { projects: ProjectSnapshot[]; currentProjectUuid?: string; onClose: () => void; onNewProject: () => void; onLaunch: () => void }) {
  const [query, setQuery] = useState("");
  const commands = useMemo(() => {
    const projectCommands = projects.map((project) => ({ id: `p-${project.uuid}`, label: project.name, meta: "project", run: () => go(projectHashFor(project)) }));
    const current = currentProjectUuid ? projects.find((project) => project.uuid === currentProjectUuid) : undefined;
    const currentRunning = Boolean(current && ((current.activeRuns ?? 0) > 0 || current.latestRun?.status === "running"));
    const base = [
      { id: "new", label: "New project", meta: "create", run: onNewProject },
      { id: "findings", label: "Go to Findings", meta: "view", run: () => go("findings") },
      { id: "projects", label: "Go to Projects", meta: "view", run: () => go("") },
      { id: "settings", label: "Settings", meta: "view", run: () => go("settings") },
      { id: "providers", label: "Provider profiles", meta: "settings", run: () => go("settings") },
      { id: "daemons", label: "Daemons", meta: "settings", run: () => go("settings/daemons") },
      ...(current && !currentRunning ? [{ id: "run", label: `Continue audit - ${current.name}`, meta: "run", run: onLaunch }] : []),
    ];
    return [...projectCommands, ...base].filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));
  }, [projects, query, currentProjectUuid, onNewProject, onLaunch]);
  return (
    <div className="modal-back command-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-menu" role="dialog" aria-modal="true" aria-label="Command menu">
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
        <Button variant={!hasProvider ? "primary" : undefined} icon="package" onClick={() => go("settings")}>{hasProvider ? "View Providers" : "Set up Provider"}</Button>
        <Button variant={hasProvider && online === 0 ? "primary" : undefined} icon="package" onClick={() => go("settings/daemons")}>{online > 0 ? "View Daemons" : "Set up Daemon"}</Button>
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
