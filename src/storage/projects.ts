import "../db/sqlite-quiet.js";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { projectHistoryKey } from "../trace/history.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const execFileAsync = promisify(execFile);

export type StoragePressure = "healthy" | "warning" | "critical";

export interface StorageRunRecord {
  run_dir?: unknown;
  status?: unknown;
}

export interface StorageProjectRecord {
  id: number;
  uuid: string;
  name: string;
  dir?: unknown;
  runs: StorageRunRecord[];
  activeJobs?: number;
}

export interface DiskStorageStatus {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  pressure: StoragePressure;
}

export interface ProjectStorageUsage {
  projectId: number;
  projectUuid: string;
  projectName: string;
  totalBytes: number;
  runBytes: number;
  historyBytes: number;
  workspaceBytes: number;
  reclaimableBytes: number;
  runCount: number;
  artifactDirectories: number;
  orphanRunDirectories: number;
  missingRunDirectories: number;
  unsafeDirectories: number;
  active: boolean;
  metadataOnly: boolean;
}

export interface StorageOverview {
  disk: DiskStorageStatus;
  outputBytes: number;
  managedProjectBytes: number;
  unattributedBytes: number;
  inaccessibleEntries: number;
  scannedAt: string;
  scanDurationMs: number;
  projects: ProjectStorageUsage[];
}

export interface ProjectStorageCleanupResult {
  apply: boolean;
  projectUuid: string;
  projectName: string;
  candidateDirectories: number;
  reclaimableBytes: number;
  removedDirectories: number;
  removedBytes: number;
  databasePreserved: true;
}

type CandidateKind = "run" | "history" | "workspace";

interface StorageCandidate {
  kind: CandidateKind;
  absolutePath: string;
  bytes: number;
  orphanRun: boolean;
  insideOutput: boolean;
}

interface ProjectStoragePlan {
  usage: ProjectStorageUsage;
  candidates: StorageCandidate[];
}

/** Read storage ownership from the existing schema without migrations or any DB write. */
export function readStorageProjectRecords(outputDir: string): StorageProjectRecord[] {
  const db = new DatabaseSync(path.join(path.resolve(outputDir), "flounder.db"), { readOnly: true, timeout: 5000 });
  try {
    const projects = db.prepare("SELECT id, uuid, name, dir FROM project ORDER BY id").all() as Array<Record<string, unknown>>;
    const runs = db.prepare("SELECT project_id, run_dir, status FROM run ORDER BY id").all() as Array<Record<string, unknown>>;
    const activeJobs = db.prepare("SELECT project, COUNT(*) AS count FROM job WHERE status IN ('queued','dispatched','running') GROUP BY project").all() as Array<Record<string, unknown>>;
    const jobsByName = new Map(activeJobs.map((row) => [String(row.project ?? ""), Number(row.count ?? 0)]));
    return projects.map((project) => ({
      id: Number(project.id),
      uuid: String(project.uuid ?? ""),
      name: String(project.name ?? ""),
      dir: project.dir,
      runs: runs.filter((run) => Number(run.project_id) === Number(project.id)),
      activeJobs: jobsByName.get(String(project.name ?? "")) ?? 0,
    }));
  } finally {
    db.close();
  }
}

/** Cheap disk-pressure check used by the dashboard on every load. */
export async function localDiskStorageStatus(target: string): Promise<DiskStorageStatus> {
  const info = await statfs(path.resolve(target), { bigint: true });
  const totalBytes = bigintToSafeNumber(info.blocks * info.bsize);
  const freeBytes = bigintToSafeNumber(info.bavail * info.bsize);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10_000) / 100 : 0;
  const freePercent = totalBytes > 0 ? freeBytes / totalBytes : 1;
  const pressure: StoragePressure = freeBytes < 20 * 1024 ** 3 || freePercent < 0.05
    ? "critical"
    : freeBytes < 100 * 1024 ** 3 || freePercent < 0.15
      ? "warning"
      : "healthy";
  return { totalBytes, freeBytes, usedBytes, usedPercent, pressure };
}

/**
 * Attribute local Flounder storage to database projects without following symlinks.
 *
 * Run rows are the primary source of ownership. A strict timestamped-name fallback
 * also catches orphaned run directories whose database row was removed or never
 * finalized. History and configured daemon workspace directories are included.
 */
export async function inspectLocalProjectStorage(input: {
  outputDir: string;
  workspaceDir: string;
  projects: StorageProjectRecord[];
}): Promise<StorageOverview> {
  const started = Date.now();
  const outputRoot = path.resolve(input.outputDir);
  const workspaceRoot = path.resolve(input.workspaceDir);
  const sizer = new AllocatedTreeSizer();
  const outputEntries = await safeDirectoryEntries(outputRoot);
  const partitions = await storagePartitions(outputRoot, workspaceRoot, outputEntries);
  await sizer.prefetch(partitions.prefetchPaths);
  const claimed = new Set<string>();
  const plans: ProjectStoragePlan[] = [];

  // Longest names first makes ownership deterministic for targets whose names share a prefix.
  const projects = [...input.projects].sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  for (const project of projects) {
    plans.push(await inspectOneProject({ project, outputRoot, workspaceRoot, outputEntries, claimed, sizer }));
  }

  let outputBytes = 0;
  for (const partition of partitions.outputPaths) outputBytes += await sizer.size(partition);
  const managedInsideOutput = plans.reduce(
    (sum, plan) => sum + plan.candidates.filter((candidate) => candidate.insideOutput).reduce((inner, candidate) => inner + candidate.bytes, 0),
    0,
  );
  const managedProjectBytes = plans.reduce((sum, plan) => sum + plan.usage.totalBytes, 0);
  const disk = await localDiskStorageStatus(outputRoot);
  return {
    disk,
    outputBytes,
    managedProjectBytes,
    unattributedBytes: Math.max(0, outputBytes - managedInsideOutput),
    inaccessibleEntries: sizer.inaccessibleEntries,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - started,
    projects: plans.map((plan) => plan.usage).sort((a, b) => b.totalBytes - a.totalBytes || a.projectName.localeCompare(b.projectName)),
  };
}

/** Preview by default; apply removes only project-owned disk directories and never opens the DB. */
export async function cleanupLocalProjectStorage(input: {
  outputDir: string;
  workspaceDir: string;
  project: StorageProjectRecord;
  apply?: boolean;
}): Promise<ProjectStorageCleanupResult> {
  const outputRoot = path.resolve(input.outputDir);
  const workspaceRoot = path.resolve(input.workspaceDir);
  const sizer = new AllocatedTreeSizer();
  const outputEntries = await safeDirectoryEntries(outputRoot);
  await sizer.prefetch(projectPrefetchPaths(input.project, outputRoot, workspaceRoot, outputEntries));
  const plan = await inspectOneProject({
    project: input.project,
    outputRoot,
    workspaceRoot,
    outputEntries,
    claimed: new Set<string>(),
    sizer,
  });
  if (plan.usage.active) throw new Error(`project ${input.project.name} has queued or running work; storage cleanup is blocked`);

  let removedDirectories = 0;
  let removedBytes = 0;
  if (input.apply === true) {
    for (const candidate of plan.candidates) {
      const allowedRoot = candidate.kind === "workspace" ? workspaceRoot : outputRoot;
      if (!isStrictDescendant(allowedRoot, candidate.absolutePath)) continue;
      const info = await safeLstat(candidate.absolutePath);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      await rm(candidate.absolutePath, { recursive: true, force: true });
      removedDirectories += 1;
      removedBytes += candidate.bytes;
    }
  }
  return {
    apply: input.apply === true,
    projectUuid: input.project.uuid,
    projectName: input.project.name,
    candidateDirectories: plan.candidates.length,
    reclaimableBytes: plan.usage.reclaimableBytes,
    removedDirectories,
    removedBytes,
    databasePreserved: true,
  };
}

async function inspectOneProject(input: {
  project: StorageProjectRecord;
  outputRoot: string;
  workspaceRoot: string;
  outputEntries: import("node:fs").Dirent[];
  claimed: Set<string>;
  sizer: AllocatedTreeSizer;
}): Promise<ProjectStoragePlan> {
  const { project, outputRoot, workspaceRoot, outputEntries, claimed, sizer } = input;
  const candidates: StorageCandidate[] = [];
  const storedRunDirs = new Set<string>();
  const runName = runDirectoryPattern(project.name);
  let missingRunDirectories = 0;
  let unsafeDirectories = 0;

  for (const run of project.runs) {
    if (typeof run.run_dir !== "string" || run.run_dir.trim() === "") continue;
    const runDir = path.resolve(run.run_dir);
    storedRunDirs.add(runDir);
    if (!isDirectChild(outputRoot, runDir) || !runName.test(path.basename(runDir))) {
      unsafeDirectories += 1;
      continue;
    }
    const added = await addCandidate(candidates, claimed, sizer, outputRoot, outputRoot, "run", runDir, false);
    if (added === "missing") missingRunDirectories += 1;
    if (added === "unsafe") unsafeDirectories += 1;
  }

  for (const entry of outputEntries) {
    if (!entry.isDirectory() || !runName.test(entry.name)) continue;
    const runDir = path.join(outputRoot, entry.name);
    if (storedRunDirs.has(runDir)) continue;
    const added = await addCandidate(candidates, claimed, sizer, outputRoot, outputRoot, "run", runDir, true);
    if (added === "unsafe") unsafeDirectories += 1;
  }

  const historyDir = path.join(outputRoot, "history", projectHistoryKey(project.name));
  const historyAdded = await addCandidate(candidates, claimed, sizer, outputRoot, outputRoot, "history", historyDir, false);
  if (historyAdded === "unsafe") unsafeDirectories += 1;

  if (typeof project.dir === "string" && project.dir.trim() !== "") {
    const workspaceDir = path.resolve(workspaceRoot, project.dir);
    const workspaceAdded = isDirectChild(workspaceRoot, workspaceDir)
      ? await addCandidate(candidates, claimed, sizer, workspaceRoot, outputRoot, "workspace", workspaceDir, false)
      : "unsafe";
    if (workspaceAdded === "unsafe") unsafeDirectories += 1;
  }

  const runBytes = bytesFor(candidates, "run");
  const historyBytes = bytesFor(candidates, "history");
  const workspaceBytes = bytesFor(candidates, "workspace");
  const totalBytes = runBytes + historyBytes + workspaceBytes;
  const active = Number(project.activeJobs ?? 0) > 0 || project.runs.some((run) => run.status === "running");
  return {
    candidates,
    usage: {
      projectId: project.id,
      projectUuid: project.uuid,
      projectName: project.name,
      totalBytes,
      runBytes,
      historyBytes,
      workspaceBytes,
      reclaimableBytes: active ? 0 : totalBytes,
      runCount: project.runs.length,
      artifactDirectories: candidates.length,
      orphanRunDirectories: candidates.filter((candidate) => candidate.kind === "run" && candidate.orphanRun).length,
      missingRunDirectories,
      unsafeDirectories,
      active,
      metadataOnly: project.runs.length > 0 && totalBytes === 0,
    },
  };
}

async function addCandidate(
  candidates: StorageCandidate[],
  claimed: Set<string>,
  sizer: AllocatedTreeSizer,
  allowedRoot: string,
  outputRoot: string,
  kind: CandidateKind,
  candidatePath: string,
  orphanRun: boolean,
): Promise<"added" | "missing" | "unsafe" | "claimed"> {
  const absolutePath = path.resolve(candidatePath);
  if (!isStrictDescendant(allowedRoot, absolutePath)) return "unsafe";
  if (claimed.has(absolutePath)) return "claimed";
  const info = await safeLstat(absolutePath);
  if (!info) return "missing";
  if (!info.isDirectory() || info.isSymbolicLink()) return "unsafe";
  claimed.add(absolutePath);
  candidates.push({
    kind,
    absolutePath,
    bytes: await sizer.size(absolutePath),
    orphanRun,
    insideOutput: isStrictDescendant(outputRoot, absolutePath),
  });
  return "added";
}

function bytesFor(candidates: StorageCandidate[], kind: CandidateKind): number {
  return candidates.filter((candidate) => candidate.kind === kind).reduce((sum, candidate) => sum + candidate.bytes, 0);
}

function runDirectoryPattern(projectName: string): RegExp {
  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:-(?:prepare|confirm|report|reproduction))?-\\d{8}T\\d{9}Z$`);
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isDirectChild(root: string, candidate: string): boolean {
  return path.dirname(path.resolve(candidate)) === path.resolve(root);
}

async function safeDirectoryEntries(target: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function safeLstat(target: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

class AllocatedTreeSizer {
  readonly cache = new Map<string, Promise<number>>();
  inaccessibleEntries = 0;

  async prefetch(paths: string[]): Promise<void> {
    const pending = [...new Set(paths.map((target) => path.resolve(target)))].filter((target) => !this.cache.has(target));
    let cursor = 0;
    let duUnavailable = false;
    const worker = async (): Promise<void> => {
      while (!duUnavailable) {
        const target = pending[cursor++];
        if (!target) return;
        let stdout = "";
        try {
          const result = await execFileAsync("du", ["-sk", target], { maxBuffer: 1024 * 1024 });
          stdout = String(result.stdout);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            duUnavailable = true;
            return;
          }
          // A directory can disappear during a scan; retain any valid row du emitted.
          const partial = (error as { stdout?: unknown }).stdout;
          stdout = partial === undefined ? "" : String(partial);
        }
        const match = /^(\d+)\s+(.+)\n?$/.exec(stdout);
        if (!match) continue;
        const absolute = path.resolve(match[2]!);
        const bytes = Number(match[1]) * 1024;
        if (Number.isFinite(bytes)) this.cache.set(absolute, Promise.resolve(bytes));
      }
    };
    // Independent project/run trees can be measured concurrently. Keep this
    // deliberately small so a storage scan does not starve active audits.
    await Promise.all(Array.from({ length: Math.min(8, pending.length) }, () => worker()));
  }

  size(target: string): Promise<number> {
    const absolute = path.resolve(target);
    const existing = this.cache.get(absolute);
    if (existing) return existing;
    const pending = this.calculate(absolute);
    this.cache.set(absolute, pending);
    return pending;
  }

  private async calculate(target: string): Promise<number> {
    let info: import("node:fs").Stats | undefined;
    try {
      info = await safeLstat(target);
    } catch (error) {
      if (isInaccessible(error)) {
        this.inaccessibleEntries += 1;
        return 0;
      }
      throw error;
    }
    if (!info) return 0;
    const ownBytes = allocatedBytes(info);
    if (!info.isDirectory() || info.isSymbolicLink()) return ownBytes;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (error) {
      if (isInaccessible(error)) {
        this.inaccessibleEntries += 1;
        return ownBytes;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let total = ownBytes;
    for (const entry of entries) total += await this.size(path.join(target, entry.name));
    return total;
  }
}

async function storagePartitions(outputRoot: string, workspaceRoot: string, outputEntries: import("node:fs").Dirent[]): Promise<{ outputPaths: string[]; prefetchPaths: string[] }> {
  const historyRoot = path.join(outputRoot, "history");
  const outputPaths: string[] = [];
  for (const entry of outputEntries) {
    const absolute = path.join(outputRoot, entry.name);
    if (absolute === historyRoot || absolute === workspaceRoot) outputPaths.push(...await safePartitionChildren(absolute));
    else outputPaths.push(absolute);
  }
  const prefetchPaths = [...outputPaths];
  if (!isStrictDescendant(outputRoot, workspaceRoot)) prefetchPaths.push(...await safePartitionChildren(workspaceRoot));
  return { outputPaths, prefetchPaths };
}

function projectPrefetchPaths(project: StorageProjectRecord, outputRoot: string, workspaceRoot: string, outputEntries: import("node:fs").Dirent[]): string[] {
  const runName = runDirectoryPattern(project.name);
  const paths = outputEntries
    .filter((entry) => entry.isDirectory() && runName.test(entry.name))
    .map((entry) => path.join(outputRoot, entry.name));
  for (const run of project.runs) {
    if (typeof run.run_dir !== "string") continue;
    const runDir = path.resolve(run.run_dir);
    if (isDirectChild(outputRoot, runDir) && runName.test(path.basename(runDir))) paths.push(runDir);
  }
  paths.push(path.join(outputRoot, "history", projectHistoryKey(project.name)));
  if (typeof project.dir === "string" && project.dir.trim() !== "") {
    const workspaceDir = path.resolve(workspaceRoot, project.dir);
    if (isDirectChild(workspaceRoot, workspaceDir)) paths.push(workspaceDir);
  }
  return paths;
}

async function safePartitionChildren(target: string): Promise<string[]> {
  const info = await safeLstat(target);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) return [target];
  return (await safeDirectoryEntries(target)).map((entry) => path.join(target, entry.name));
}

function allocatedBytes(info: import("node:fs").Stats): number {
  return typeof info.blocks === "number" ? info.blocks * 512 : info.size;
}

function isInaccessible(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function bigintToSafeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}
