import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { selectDbUpgradeTag } from "./select-db-upgrade-tag.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedTag = process.env.FLOUNDER_DB_UPGRADE_FROM || process.argv[2];

const tag = await selectDbUpgradeTag({ cwd: root, requestedTag });
const temp = await mkdtemp(path.join(os.tmpdir(), "flounder-db-upgrade-"));

try {
  const archive = path.join(temp, "release.tar");
  const release = path.join(temp, "release");
  await mkdir(release);
  await execFileAsync("git", ["archive", "--format=tar", `--output=${archive}`, tag], { cwd: root, maxBuffer: 50 * 1024 * 1024 });
  await execFileAsync("tar", ["-xf", archive, "-C", release], { cwd: root });
  await symlink(path.join(root, "node_modules"), path.join(release, "node_modules"), "dir");
  await execFileAsync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(release, "tsconfig.json")], {
    cwd: release,
    maxBuffer: 20 * 1024 * 1024,
  });

  const oldModule = await import(`${pathToFileURL(path.join(release, "dist", "db", "store.js")).href}?tag=${encodeURIComponent(tag)}`);
  const dbPath = path.join(temp, "upgrade.db");
  const oldStore = new oldModule.MetadataStore(dbPath);
  const projectId = oldStore.upsertProject({ name: "upgrade-contract", sourcePaths: ["src"], buildRoot: "." });
  const runId = oldStore.startRun({ projectId, kind: "run", runDir: "runs/release-baseline" });
  oldStore.upsertScopes(projectId, [{ scopeId: "S1", title: "Release scope", location: "src/index.ts", score: 9, status: "audited" }]);
  oldStore.upsertFindings(projectId, runId, [{ findingKey: "krelease", title: "Release finding", location: "src/index.ts:1", severity: "high", status: "suspected" }]);
  const daemon = oldStore.createDaemonToken("release-daemon");
  const jobId = oldStore.enqueueJob("upgrade-contract", { verb: "run", target: "upgrade-contract", sourcePaths: ["src"] }, daemon.id);
  oldStore.finishRun(runId, "done");
  oldStore.close();

  const currentModule = await import(pathToFileURL(path.join(root, "dist", "db", "store.js")).href);
  const currentStore = new currentModule.MetadataStore(dbPath);
  const project = currentStore.getProject("upgrade-contract");
  assert.ok(project, "project survives the release upgrade");
  assert.equal(currentStore.listRuns(Number(project.id)).some((run) => Number(run.id) === runId && run.status === "done"), true);
  assert.equal(currentStore.listScopes(Number(project.id)).some((scope) => scope.scope_id === "S1" && scope.status === "audited"), true);
  assert.equal(currentStore.listFindings(Number(project.id)).some((finding) => finding.finding_key === "krelease" && finding.status === "suspected"), true);
  assert.equal(Number(currentStore.getJob(jobId)?.daemon_id), daemon.id);
  currentStore.close();

  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  assert.equal(raw.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.ok(Number(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value) > 0);
  raw.close();
  console.log(`Database upgrade contract passed (${tag} -> current).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
