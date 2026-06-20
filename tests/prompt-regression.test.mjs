import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultConfig } from "../dist/config.js";
import {
  AUDIT_DEEP_SYSTEM,
  AUDIT_SYNTHESIS_SYSTEM,
  AUDIT_SYSTEM,
  AUDIT_VERIFY_SYSTEM,
  MAP_SYSTEM,
  POC_TRUST_RULE,
} from "../dist/agent/prompts.js";
import { buildSessionPrompt } from "../dist/agent/pi-session.js";

const root = path.resolve(".");
const registryPath = path.join(root, "fixtures/prompt-regression/known-bugs.json");
const execFileAsync = promisify(execFile);

async function loadRegistry() {
  return JSON.parse(await readFile(registryPath, "utf8"));
}

function promptRegressionPaths(entry) {
  return [
    ...(entry.requiredFixtures ?? []),
    ...(entry.positiveFixtures ?? []),
    ...((entry.negativeFixtures ?? []).map((fixture) => fixture.path)),
    ...((entry.controlFixtures ?? []).map((fixture) => fixture.path)),
    ...((entry.expectedArtifacts?.pass ?? [])),
    ...((entry.expectedArtifacts?.fail ?? [])),
  ];
}

function defaultPromptCorpus() {
  const cfg = defaultConfig();
  return [
    AUDIT_SYSTEM,
    AUDIT_DEEP_SYSTEM,
    MAP_SYSTEM,
    AUDIT_VERIFY_SYSTEM,
    AUDIT_SYNTHESIS_SYSTEM,
    POC_TRUST_RULE,
    buildSessionPrompt({ cfg, fileManifest: "example.rs" }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", deep: true }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", map: true }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", verify: "suspected finding" }),
    buildSessionPrompt({ cfg, fileManifest: "example.rs", synthesize: "prior per-scope findings" }),
  ].join("\n");
}

test("known-bug prompt regression registry has replay fixtures for all local evidence cases", async () => {
  const registry = await loadRegistry();
  assert.equal(registry.version, 2);
  assert.deepEqual(
    registry.cases.map((entry) => entry.id),
    [
      "zcash-orchard-halo2-missing-constraint",
      "aztec-2026-06-14-unbound-settlement-count",
      "aztec-2026-06-17-recursive-verifier-boundary",
    ],
  );

  assert.ok(registry.sharedControlFixtures.length >= 1, "registry needs shared control fixtures");
  for (const fixture of registry.sharedControlFixtures) {
    assert.match(fixture.path, /^fixtures\/prompt-regression\//);
    await access(path.join(root, fixture.path));
  }

  for (const entry of registry.cases) {
    assert.ok(entry.caseVersion >= 1, `${entry.id} needs a case version`);
    assert.ok(entry.bugClass.length > 20, `${entry.id} needs a bug class`);
    assert.ok(entry.localEvidenceSummary.length > 40, `${entry.id} needs a local evidence summary`);
    assert.ok(entry.positiveFixtures.length >= 1, `${entry.id} needs positive fixtures`);
    assert.ok(entry.negativeFixtures.length >= 1, `${entry.id} needs negative fixtures`);
    assert.ok(entry.expectedArtifacts.pass.length >= 1, `${entry.id} needs expected pass artifacts`);
    assert.ok(entry.expectedArtifacts.fail.length >= 1, `${entry.id} needs expected fail artifacts`);
    assert.ok(entry.mustDetect.length >= 3, `${entry.id} needs must-detect criteria`);
    assert.ok(entry.mustNotAssume.length >= 3, `${entry.id} needs must-not-assume criteria`);
    assert.ok(entry.expectedLiveEvalSignals.length >= 4, `${entry.id} needs live-eval signals`);
    assert.ok(entry.artifactSignalGroups.length >= 3, `${entry.id} needs scoreable artifact signal groups`);
    assert.ok(entry.forbiddenArtifactSignals.length >= 3, `${entry.id} needs forbidden artifact signals`);
    assert.ok(entry.doNotInjectIntoPrompt.length >= 3, `${entry.id} needs answer-leak sentinels`);
    for (const fixture of promptRegressionPaths(entry)) {
      assert.equal(fixture.startsWith("runs/"), false, `${fixture} must not point at raw run output`);
      assert.equal(fixture.startsWith("files/audit-reports/"), false, `${fixture} must be distilled before tracking`);
      await access(path.join(root, fixture));
      const content = await readFile(path.join(root, fixture), "utf8");
      assert.ok(content.length > 100, `${fixture} should be a meaningful replay fixture`);
    }
  }
});

test("prompt regression expected artifacts exercise scorer pass and fail paths", async () => {
  const registry = await loadRegistry();

  for (const entry of registry.cases) {
    for (const artifact of entry.expectedArtifacts.pass) {
      const { stdout } = await execFileAsync(
        "node",
        ["scripts/score-prompt-regression.mjs", entry.id, artifact],
        { cwd: root },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.passed, true, `${artifact} should pass scorer`);
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.forbiddenMatches, []);
    }

    for (const artifact of entry.expectedArtifacts.fail) {
      await assert.rejects(
        execFileAsync("node", ["scripts/score-prompt-regression.mjs", entry.id, artifact], { cwd: root }),
        (error) => {
          assert.equal(error.code, 1, `${artifact} should fail scorer with code 1`);
          const result = JSON.parse(error.stdout);
          assert.equal(result.passed, false, `${artifact} should fail scorer`);
          assert.ok(
            result.missing.length > 0 || result.forbiddenMatches.length > 0,
            `${artifact} should fail through missing required signals or forbidden signals`,
          );
          return true;
        },
      );
    }
  }
});

test("default prompts retain the generic capabilities needed by known-bug regressions", async () => {
  const registry = await loadRegistry();
  const corpus = defaultPromptCorpus();

  for (const expectation of registry.promptContract.requiredNeedles) {
    assert.ok(
      corpus.includes(expectation.needle),
      `prompt corpus missing generic capability: ${expectation.capability} (${expectation.needle})`,
    );
  }
});

test("default prompts do not hard-code known-bug answers or local target identifiers", async () => {
  const registry = await loadRegistry();
  const corpus = defaultPromptCorpus();
  const forbidden = new Set(registry.promptContract.forbiddenDefaultPromptNeedles);
  for (const entry of registry.cases) {
    for (const needle of entry.doNotInjectIntoPrompt) forbidden.add(needle);
  }

  for (const needle of forbidden) {
    assert.equal(corpus.includes(needle), false, `default prompt leaked known-bug answer term: ${needle}`);
  }
});

test("prompt regression eval runner expands dry-run plans without model calls", async () => {
  const { stdout } = await execFileAsync(
    "node",
    [
      "scripts/prompt-regression-eval.mjs",
      "--dry-run",
      "--case",
      "aztec-2026-06-17-recursive-verifier-boundary",
      "--samples",
      "2",
      "--variant",
      "candidate",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.variant, "candidate");
  assert.equal(plan.runs.length, 2);
  assert.deepEqual(
    plan.runs.map((run) => run.caseId),
    ["aztec-2026-06-17-recursive-verifier-boundary", "aztec-2026-06-17-recursive-verifier-boundary"],
  );
  assert.ok(plan.runs.every((run) => run.mode === "deep"));
  assert.ok(plan.runs.every((run) => run.sourcePaths.length === 1));
});

test("prompt regression eval runner can plan positive, negative, and control fixtures", async () => {
  const { stdout } = await execFileAsync(
    "node",
    [
      "scripts/prompt-regression-eval.mjs",
      "--dry-run",
      "--case",
      "aztec-2026-06-14-unbound-settlement-count",
      "--fixture-set",
      "all",
      "--variant",
      "candidate",
    ],
    { cwd: root },
  );
  const plan = JSON.parse(stdout);
  assert.deepEqual(
    plan.runs.map((run) => run.fixtureSet).sort(),
    ["control", "negative", "positive"],
  );
  assert.deepEqual(
    plan.runs.map((run) => run.expectedOutcome).sort(),
    ["detect-positive", "reject-positive", "reject-positive"],
  );
});

test("prompt regression compare flags candidate pass-rate regressions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prompt-regression-"));
  try {
    const baselinePath = path.join(dir, "baseline.json");
    const candidatePath = path.join(dir, "candidate.json");
    const baseResult = {
      caseId: "case-a",
      label: "Case A",
      fixtureSet: "negative",
      fixtureId: "safe-control",
      expectedOutcome: "reject-positive",
      score: {
        passed: true,
        positiveScore: false,
        forbiddenMatches: [],
        groups: [{ name: "binding", passed: false }],
      },
    };
    const candidateResult = {
      ...baseResult,
      score: {
        passed: false,
        positiveScore: true,
        forbiddenMatches: [],
        groups: [{ name: "binding", passed: true }],
      },
    };
    await writeFile(
      baselinePath,
      JSON.stringify({ variant: "baseline", totalRuns: 1, passedRuns: 1, results: [baseResult] }),
    );
    await writeFile(
      candidatePath,
      JSON.stringify({ variant: "candidate", totalRuns: 1, passedRuns: 0, results: [candidateResult] }),
    );

    await assert.rejects(
      execFileAsync("node", ["scripts/compare-prompt-regression.mjs", baselinePath, candidatePath], { cwd: root }),
      (error) => {
        assert.equal(error.code, 1);
        const comparison = JSON.parse(error.stdout);
        assert.equal(comparison.pass, false);
        assert.equal(comparison.regressions.length, 1);
        assert.equal(comparison.regressions[0].fixtureSet, "negative");
        assert.equal(comparison.regressions[0].deltaPassRate, -1);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
