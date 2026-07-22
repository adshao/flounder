import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactHistoricalInspectionWorkspaces } from "../dist/storage/compact.js";

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
