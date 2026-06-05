import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { loadSource } from "../dist/ingest/source.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { runPipeline } from "../dist/pipeline.js";
import { runSeeders } from "../dist/seeders/index.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");

test("static seeders enumerate Halo2 missing-constraint audit items", async () => {
  const source = await loadSource([fixtures]);
  const items = runSeeders(source);
  assert.ok(source.every((doc) => !path.isAbsolute(doc.path)));
  assert.ok(source.every((doc) => !doc.path.includes(root)));
  assert.equal(items.filter((item) => item.failureMode === "missing_constraint").length, 2);
  assert.ok(items.every((item) => item.location.includes("halo2_missing_constraint.rs")));
});

test("dry-run pipeline writes checklist and summary without model calls", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-dry-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-dry";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.dryRun = true;

  const result = await runPipeline(cfg);
  assert.equal(result.summary.coverage.itemsTotal, 2);
  assert.equal(result.summary.coverage.itemsWithFinding, 0);
  await stat(path.join(result.runDir, "checklist.json"));
  await stat(path.join(result.runDir, "summary.json"));
  await stat(path.join(result.runDir, "source_index.json"));
  await stat(path.join(result.runDir, "checklist_coverage.json"));
});

test("mock pipeline runs enumerate, audit, verify, and report end to end", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-mock-"));
  const cfg = defaultConfig();
  cfg.targetName = "test-mock";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 2 });
  assert.equal(result.summary.coverage.itemsTotal, 3);
  assert.equal(result.summary.coverage.itemsWithFinding, 3);
  assert.equal(result.summary.coverage.bySeverity.high, 3);

  const verification = JSON.parse(await readFile(path.join(result.runDir, "verifications.json"), "utf8"));
  assert.equal(verification.length, 2);

  const coverage = JSON.parse(await readFile(path.join(result.runDir, "run_coverage.json"), "utf8"));
  assert.equal(coverage.checklist.byFailureMode.missing_constraint, 3);
  assert.equal(Object.keys(coverage.checklist.bySourceFile).length, 1);
  assert.deepEqual(Object.keys(coverage.checklist.bySourceFile), ["fixtures/halo2_missing_constraint.rs"]);

  const report = await readFile(path.join(result.runDir, "report_halo2-missing-constraint-1.md"), "utf8");
  assert.match(report, /Security disclosure/);
  assert.match(report, /local, isolated environment only/i);

  for (const artifact of [
    "source_index.json",
    "checklist.json",
    "checklist_coverage.json",
    "run_coverage.json",
    "events.jsonl",
    "report_halo2-missing-constraint-1.md",
  ]) {
    const body = await readFile(path.join(result.runDir, artifact), "utf8");
    assertNoLocalAbsolutePath(body, artifact, [root, out]);
  }
});

function assertNoLocalAbsolutePath(body, label, forbiddenRoots) {
  for (const forbiddenRoot of forbiddenRoots) {
    assert.equal(body.includes(forbiddenRoot), false, `${label} includes a local absolute path`);
  }
}
