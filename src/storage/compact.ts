import "../db/sqlite-quiet.js";
import { createRequire } from "node:module";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface StoredRunForCompaction {
  run_dir?: unknown;
  status?: unknown;
}

export interface InspectionWorkspaceCompactionResult {
  apply: boolean;
  terminalRunDirs: number;
  candidateDirectories: number;
  reclaimableBytes: number;
  removedDirectories: number;
  removedBytes: number;
  skippedRunningRunDirs: number;
  skippedUnsafeRunDirs: number;
  missingRunDirs: number;
}

const INSPECTION_PHASE_DIRECTORIES = ["audit", "confirm", "report", "reproduction"] as const;
const SOURCE_VIEW_SUFFIX = /-source-view-cmd[1-9]\d*$/;

/** Read the compaction worklist without migrations, journal changes, or other DB writes. */
export function readStoredRunsForCompaction(outputDir: string): StoredRunForCompaction[] {
  const db = new DatabaseSync(path.join(outputDir, "flounder.db"), { readOnly: true, timeout: 5000 });
  try {
    return db.prepare("SELECT run_dir, status FROM run WHERE run_dir IS NOT NULL AND run_dir <> ''").all() as StoredRunForCompaction[];
  } finally {
    db.close();
  }
}

/**
 * Find or remove historical per-command source views for terminal runs.
 *
 * These directories are read-only copies created solely to enforce a narrow
 * source boundary for one inspection command. The command result is persisted
 * elsewhere, so the copy is rebuildable and is not audit evidence. Running runs,
 * paths outside the configured output root, symlinks, and unpaired lookalikes are
 * never touched. Dry-run is the default at the CLI layer.
 */
export async function compactHistoricalInspectionWorkspaces(input: {
  outputDir: string;
  runs: StoredRunForCompaction[];
  apply?: boolean;
}): Promise<InspectionWorkspaceCompactionResult> {
  const outputRoot = path.resolve(input.outputDir);
  const statusesByDir = new Map<string, Set<string>>();
  let skippedUnsafeRunDirs = 0;

  for (const run of input.runs) {
    if (typeof run.run_dir !== "string" || run.run_dir.trim() === "") continue;
    const runDir = path.resolve(run.run_dir);
    if (!isStrictDescendant(outputRoot, runDir)) {
      skippedUnsafeRunDirs += 1;
      continue;
    }
    const statuses = statusesByDir.get(runDir) ?? new Set<string>();
    statuses.add(String(run.status ?? ""));
    statusesByDir.set(runDir, statuses);
  }

  const result: InspectionWorkspaceCompactionResult = {
    apply: input.apply === true,
    terminalRunDirs: 0,
    candidateDirectories: 0,
    reclaimableBytes: 0,
    removedDirectories: 0,
    removedBytes: 0,
    skippedRunningRunDirs: 0,
    skippedUnsafeRunDirs,
    missingRunDirs: 0,
  };

  for (const [runDir, statuses] of statusesByDir) {
    if (statuses.has("running")) {
      result.skippedRunningRunDirs += 1;
      continue;
    }
    const runInfo = await safeLstat(runDir);
    if (!runInfo) {
      result.missingRunDirs += 1;
      continue;
    }
    if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) {
      result.skippedUnsafeRunDirs += 1;
      continue;
    }
    result.terminalRunDirs += 1;

    for (const phase of INSPECTION_PHASE_DIRECTORIES) {
      const phaseDir = path.join(runDir, phase);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(phaseDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !SOURCE_VIEW_SUFFIX.test(entry.name)) continue;
        const baseName = entry.name.replace(SOURCE_VIEW_SUFFIX, "");
        const baseInfo = await safeLstat(path.join(phaseDir, baseName));
        if (!baseInfo?.isDirectory() || baseInfo.isSymbolicLink()) continue;

        const candidate = path.join(phaseDir, entry.name);
        const bytes = await treeSizeWithoutFollowingSymlinks(candidate);
        result.candidateDirectories += 1;
        result.reclaimableBytes += bytes;
        if (input.apply === true) {
          await rm(candidate, { recursive: true, force: true });
          result.removedDirectories += 1;
          result.removedBytes += bytes;
        }
      }
    }
  }
  return result;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function safeLstat(target: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function treeSizeWithoutFollowingSymlinks(target: string): Promise<number> {
  const info = await safeLstat(target);
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  let total = info.size;
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) total += await treeSizeWithoutFollowingSymlinks(path.join(target, entry.name));
  return total;
}
