import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("cli help lists user workflows without advertising maintainer-only experiments", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "--help"], { cwd: root });
  assert.match(stdout, /flounder verify\s+<file> --source <paths\.\.\.>/);
  assert.match(stdout, /flounder report\s+--project <uuid\|name> \[--finding <id>\.\.\.\] \[--all\]/);
  assert.match(stdout, /flounder continue\s+--project <uuid\|name>/);
  assert.match(stdout, /flounder group create\|start\|status\|pause\|cancel\|retry\|report/);
  assert.doesNotMatch(stdout, /\bflounder experiment\b/);
  assert.match(stdout, /Without --finding\/--all,\s+report generates only missing reports/);
  assert.match(stdout, /same as the UI Continue button/);
});

test("cli experiment help documents the governed promotion boundary", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "experiment", "--help"], { cwd: root });
  assert.match(stdout, /maintainer-only governed harness self-improvement/);
  assert.match(stdout, /flounder ui --maintainer/);
  assert.match(stdout, /flounder experiment create --name <name> --baseline <group>/);
  assert.match(stdout, /flounder experiment evaluate <uuid\|name>/);
  assert.match(stdout, /promotion, merge, and deployment policy remain outside the editable loop/);
});

test("cli group help documents durable manifests and safety boundary", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "group", "--help"], { cwd: root });
  assert.match(stdout, /flounder group create --manifest <file>/);
  assert.match(stdout, /flounder group retry <work-item-id>/);
  assert.match(stdout, /target bundles, material policies, and evidence/);
  assert.match(stdout, /cannot enable host execution or bypass/);
});

test("cli continue has command-specific help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "continue", "--help"], { cwd: root });
  assert.match(stdout, /flounder continue --project <uuid\|name>/);
  assert.match(stdout, /verb:"run"/);
  assert.match(stdout, /--coverage <mode>/);
});

test("cli storage compaction is dry-run first and documents its evidence boundary", async () => {
  const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "storage", "--help"], { cwd: root });
  assert.match(stdout, /storage report/);
  assert.match(stdout, /storage clean --project/);
  assert.match(stdout, /metadata-only retention action/);
  assert.match(stdout, /storage compact.*preview reclaimable space/);
  assert.match(stdout, /--apply.*remove terminal-run inspection copies/);
  assert.match(stdout, /never touches running runs, report artifacts, transcripts, findings, or PoC files/);
});
