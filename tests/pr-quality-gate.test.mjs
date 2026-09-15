import assert from "node:assert/strict";
import test from "node:test";

import { analyzeChangedFiles } from "../scripts/pr-quality-gate.mjs";

test("documentation-only changes are low risk and pass deterministic checks", () => {
  const report = analyzeChangedFiles(["docs/QUALITY_GATES.md", "README.md"]);

  assert.equal(report.risk, "low");
  assert.equal(report.verdict, "manual-review-required");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.manualGates, ["maintainer-semantic-review", "public-surface-review"]);
});

test("source ingestion changes require their focused regression test", () => {
  const report = analyzeChangedFiles(["src/ingest/source.ts"]);

  assert.equal(report.risk, "high");
  assert.equal(report.verdict, "failed");
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.id),
    ["source-ingest-regression-coverage"],
  );
});

test("source ingestion changes pass when the focused regression test changes", () => {
  const report = analyzeChangedFiles(["tests/source-ingest.test.mjs", "src/ingest/source.ts"]);

  assert.equal(report.verdict, "manual-review-required");
  assert.deepEqual(report.blockers, []);
});

test("LLM adapter changes select high-risk and cross-platform review", () => {
  const report = analyzeChangedFiles(["src/llm/client.ts", "tests/llm-client.test.mjs"]);

  assert.equal(report.risk, "high");
  assert.equal(report.verdict, "manual-review-required");
  assert.deepEqual(report.blockers, []);
  assert.ok(report.lenses.includes("llm-output-boundary"));
  assert.ok(report.manualGates.includes("linux-and-windows-verification"));
});

test("LLM adapter changes fail without focused tests", () => {
  const report = analyzeChangedFiles(["src/llm/client.ts"]);

  assert.equal(report.verdict, "failed");
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.id),
    ["llm-regression-coverage"],
  );
});

test("security changes require focused coverage and security review", () => {
  const report = analyzeChangedFiles([
    "src/security/policy.ts",
    "tests/security-policy.test.mjs",
  ]);

  assert.equal(report.risk, "high");
  assert.equal(report.verdict, "manual-review-required");
  assert.deepEqual(report.blockers, []);
  assert.ok(report.manualGates.includes("security-boundary-review"));
});

test("prompt changes cannot pass on unrelated tests", () => {
  const report = analyzeChangedFiles(["src/agent/prompts.ts", "tests/agent.test.mjs"]);

  assert.equal(report.verdict, "failed");
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.id),
    ["prompt-regression-coverage"],
  );
});

test("prompt changes use the dedicated blind regression gate", () => {
  const report = analyzeChangedFiles([
    "src/agent/prompts.ts",
    "tests/prompt-regression.test.mjs",
  ]);

  assert.equal(report.risk, "high");
  assert.equal(report.verdict, "manual-review-required");
  assert.deepEqual(report.blockers, []);
  assert.ok(report.manualGates.includes("prompt-regression-evidence"));
});

test("diff-check failures are non-compensating blockers", () => {
  const report = analyzeChangedFiles(["README.md"], {
    diffCheckPassed: false,
    diffCheckOutput: "README.md:1: trailing whitespace.",
  });

  assert.equal(report.verdict, "failed");
  assert.equal(report.blockers[0].id, "diff-check");
});

test("executable project surfaces always receive supply-chain review", () => {
  const report = analyzeChangedFiles(["scripts/check-package.mjs"]);

  assert.equal(report.risk, "high");
  assert.ok(report.lenses.includes("supply-chain-integrity"));
  assert.ok(report.manualGates.includes("downstream-runtime-threat-review"));
});

test("test code and CODEOWNERS changes are high-risk execution or policy changes", () => {
  for (const path of ["tests/new-feature.test.mjs", ".github/CODEOWNERS"]) {
    const report = analyzeChangedFiles([path]);
    assert.equal(report.risk, "high");
    assert.ok(report.lenses.includes("supply-chain-integrity"));
    assert.ok(report.manualGates.includes("downstream-runtime-threat-review"));
  }
});

test("executable and build files are high risk regardless of directory", () => {
  for (const path of [
    "tools/bootstrap.mjs",
    "maintenance/rotate.py",
    "Makefile",
    ".devcontainer/devcontainer.json",
    "nested/Dockerfile",
  ]) {
    const report = analyzeChangedFiles([path]);
    assert.equal(report.risk, "high", path);
    assert.ok(report.lenses.includes("supply-chain-integrity"), path);
  }
});

test("deleting a focused test cannot satisfy regression coverage", () => {
  const report = analyzeChangedFiles(
    ["src/security/policy.ts", "tests/security-policy.test.mjs"],
    { deletedPaths: ["tests/security-policy.test.mjs"] },
  );

  assert.equal(report.verdict, "failed");
  assert.deepEqual(report.evidence.changedTests, []);
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.id),
    ["security-regression-coverage"],
  );
});
