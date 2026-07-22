import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactHistoricalInspectionWorkspaces } from "../dist/storage/compact.js";
import { cleanupLocalProjectStorage, inspectLocalProjectStorage } from "../dist/storage/projects.js";

test("historical storage compaction previews and removes only terminal paired source views", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-storage-"));
  const out = path.join(root, "out");
  const terminal = path.join(out, "terminal-run");
  const running = path.join(out, "running-run");
  const outside = path.join(root, "outside-run");
  try {
    for (const runDir of [terminal, running, outside]) {
      await mkdir(path.join(runDir, "audit", "workspace"), { recursive: true });
      await mkdir(path.join(runDir, "audit", "workspace-source-view-cmd1"), { recursive: true });
      await writeFile(path.join(runDir, "audit", "workspace", "source.rs"), "durable source\n");
      await writeFile(path.join(runDir, "audit", "workspace-source-view-cmd1", "source.rs"), "disposable copy\n");
    }
    await writeFile(path.join(terminal, "report.md"), "durable evidence\n");
    await mkdir(path.join(terminal, "audit", "orphan-source-view-cmd2"), { recursive: true });
    await writeFile(path.join(terminal, "audit", "orphan-source-view-cmd2", "keep.txt"), "unpaired lookalike\n");
    const outsideEvidence = path.join(root, "outside-evidence.txt");
    await writeFile(outsideEvidence, "must survive\n");
    await symlink(outsideEvidence, path.join(terminal, "audit", "workspace-source-view-cmd1", "outside-link"));

    const runs = [
      { run_dir: terminal, status: "done" },
      { run_dir: running, status: "running" },
      { run_dir: outside, status: "done" },
    ];
    const preview = await compactHistoricalInspectionWorkspaces({ outputDir: out, runs });
    assert.equal(preview.apply, false);
    assert.equal(preview.candidateDirectories, 1);
    assert.equal(preview.removedDirectories, 0);
    assert.equal(preview.skippedRunningRunDirs, 1);
    assert.equal(preview.skippedUnsafeRunDirs, 1);
    assert.ok(preview.reclaimableBytes > 0);
    assert.ok((await stat(path.join(terminal, "audit", "workspace-source-view-cmd1"))).isDirectory());

    const applied = await compactHistoricalInspectionWorkspaces({ outputDir: out, runs, apply: true });
    assert.equal(applied.candidateDirectories, 1);
    assert.equal(applied.removedDirectories, 1);
    assert.equal(applied.removedBytes, applied.reclaimableBytes);
    await assert.rejects(stat(path.join(terminal, "audit", "workspace-source-view-cmd1")), /ENOENT/);
    assert.equal(await readFile(path.join(terminal, "report.md"), "utf8"), "durable evidence\n");
    assert.equal(await readFile(path.join(terminal, "audit", "workspace", "source.rs"), "utf8"), "durable source\n");
    assert.equal(await readFile(path.join(terminal, "audit", "orphan-source-view-cmd2", "keep.txt"), "utf8"), "unpaired lookalike\n");
    assert.ok((await stat(path.join(running, "audit", "workspace-source-view-cmd1"))).isDirectory());
    assert.ok((await stat(path.join(outside, "audit", "workspace-source-view-cmd1"))).isDirectory());
    assert.equal(await readFile(outsideEvidence, "utf8"), "must survive\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project storage attributes orphan runs and metadata-only cleanup preserves the database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-project-storage-"));
  const out = path.join(root, "out");
  const workspaceRoot = path.join(out, "workspace");
  const runDir = path.join(out, "alpha-20260722T120914020Z");
  const orphanRunDir = path.join(out, "alpha-confirm-20260722T121014020Z");
  const lookalike = path.join(out, "alpha-extra-20260722T121114020Z");
  const historyDir = path.join(out, "history", "alpha");
  const workspaceDir = path.join(workspaceRoot, "project-alpha");
  const database = path.join(out, "flounder.db");
  const project = {
    id: 1,
    uuid: "project-alpha-uuid",
    name: "alpha",
    dir: "project-alpha",
    runs: [{ run_dir: runDir, status: "done" }],
    activeJobs: 0,
  };
  try {
    for (const dir of [runDir, orphanRunDir, lookalike, historyDir, workspaceDir]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "data.bin"), Buffer.alloc(16 * 1024, 1));
    }
    await writeFile(database, "database stays\n");

    const overview = await inspectLocalProjectStorage({ outputDir: out, workspaceDir: workspaceRoot, projects: [project] });
    assert.equal(overview.projects.length, 1);
    assert.equal(overview.projects[0].artifactDirectories, 4);
    assert.equal(overview.projects[0].orphanRunDirectories, 1);
    assert.equal(overview.projects[0].active, false);
    assert.ok(overview.projects[0].reclaimableBytes > 0);
    assert.ok(overview.unattributedBytes > 0);

    const preview = await cleanupLocalProjectStorage({ outputDir: out, workspaceDir: workspaceRoot, project });
    assert.equal(preview.apply, false);
    assert.equal(preview.candidateDirectories, 4);
    assert.equal(preview.removedDirectories, 0);
    assert.equal(await readFile(database, "utf8"), "database stays\n");
    assert.ok((await stat(runDir)).isDirectory());

    const applied = await cleanupLocalProjectStorage({ outputDir: out, workspaceDir: workspaceRoot, project, apply: true });
    assert.equal(applied.databasePreserved, true);
    assert.equal(applied.removedDirectories, 4);
    assert.equal(applied.removedBytes, applied.reclaimableBytes);
    for (const removed of [runDir, orphanRunDir, historyDir, workspaceDir]) await assert.rejects(stat(removed), /ENOENT/);
    assert.ok((await stat(lookalike)).isDirectory());
    assert.equal(await readFile(database, "utf8"), "database stays\n");

    const after = await inspectLocalProjectStorage({ outputDir: out, workspaceDir: workspaceRoot, projects: [project] });
    assert.equal(after.projects[0].metadataOnly, true);
    assert.equal(after.projects[0].totalBytes, 0);
    assert.equal(after.projects[0].missingRunDirectories, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project storage cleanup blocks active work and skips paths outside configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-project-storage-active-"));
  const out = path.join(root, "out");
  const workspace = path.join(out, "workspace");
  const outside = path.join(root, "outside-run");
  try {
    await mkdir(out, { recursive: true });
    await mkdir(outside, { recursive: true });
    const project = {
      id: 2,
      uuid: "active-project-uuid",
      name: "active-project",
      dir: ".",
      runs: [{ run_dir: outside, status: "running" }],
      activeJobs: 1,
    };
    const overview = await inspectLocalProjectStorage({ outputDir: out, workspaceDir: workspace, projects: [project] });
    assert.equal(overview.projects[0].active, true);
    assert.equal(overview.projects[0].reclaimableBytes, 0);
    assert.ok(overview.projects[0].unsafeDirectories >= 2);
    await assert.rejects(cleanupLocalProjectStorage({ outputDir: out, workspaceDir: workspace, project, apply: true }), /queued or running work/);
    assert.ok((await stat(outside)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
