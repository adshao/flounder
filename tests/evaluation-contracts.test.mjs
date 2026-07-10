import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  absolutizeRunGroupManifest,
  capabilitySurfaceScopeNote,
  normalizeRunGroupManifest,
} from "../dist/evaluation/contracts.js";
import { buildWorkItemLaunchSpec, renderRunGroupReport, settleWorkItem } from "../dist/evaluation/run-groups.js";

test("harness evolution baseline is a valid repeated positive/control manifest", () => {
  const fixtureUrl = new URL("../fixtures/harness-evolution/baseline.json", import.meta.url);
  const normalized = normalizeRunGroupManifest(JSON.parse(readFileSync(fixtureUrl, "utf8")));
  assert.equal(normalized.items.length, 4);
  assert.equal(normalized.items.filter((item) => item.evidenceContract.expectedOutcome === "detect-positive").length, 2);
  assert.equal(normalized.items.filter((item) => item.evidenceContract.expectedOutcome === "reject-positive").length, 2);
  assert.ok(normalized.items.every((item) => item.materialPolicy.posture === "blind" && !item.targetBundle.scopeNote));
  const absolute = absolutizeRunGroupManifest(normalized, path.dirname(fixtureUrl.pathname));
  assert.ok(absolute.items.every((item) => path.isAbsolute(item.targetBundle.sourcePaths[0])));
});

function manifest(overrides = {}) {
  return {
    version: 1,
    name: "logic-eval",
    kind: "evaluation",
    parallelism: 2,
    items: [
      {
        itemKey: "positive",
        kind: "benchmark-case",
        targetBundle: {
          target: "eval-c1-f1-s1",
          targetClass: "logic",
          sourcePaths: ["fixtures/c1"],
          corpusPaths: ["docs/design.md", "reports/disclosure.md"],
        },
        materialPolicy: {
          posture: "blind",
          materials: [
            { path: "docs/design.md", provenance: "official-docs", operatorLabel: "design-intent", policyDecision: "included", reason: "answer-free design" },
            { path: "reports/disclosure.md", provenance: "public-report", operatorLabel: "disclosure", policyDecision: "excluded", reason: "answer-bearing" },
          ],
        },
        evidenceContract: {
          kind: "benchmark-oracle",
          expectedOutcome: "detect-positive",
          requiresDifferential: true,
          requiresRefutation: true,
          networkPolicy: "sealed",
        },
      },
    ],
    ...overrides,
  };
}

test("evaluation contracts normalize and materialize answer-safe manifests", () => {
  const normalized = normalizeRunGroupManifest(manifest());
  const absolute = absolutizeRunGroupManifest(normalized, "/workspace/eval");
  assert.equal(absolute.items[0].targetBundle.sourcePaths[0], path.normalize("/workspace/eval/fixtures/c1"));
  assert.equal(absolute.items[0].materialPolicy.materials[0].path, path.normalize("/workspace/eval/docs/design.md"));

  const row = {
    uuid: "11111111-1111-4111-8111-111111111111",
    attempts: 0,
    item_key: absolute.items[0].itemKey,
    kind: absolute.items[0].kind,
    target_bundle_json: JSON.stringify(absolute.items[0].targetBundle),
    material_policy_json: JSON.stringify(absolute.items[0].materialPolicy),
    evidence_contract_json: JSON.stringify(absolute.items[0].evidenceContract),
  };
  const spec = buildWorkItemLaunchSpec(row, { config_json: JSON.stringify({ provider: "openai-codex", thinking: "xhigh" }) });
  assert.deepEqual(spec.corpusPaths, [path.normalize("/workspace/eval/docs/design.md")]);
  assert.equal(spec.provider, "openai-codex");
  assert.equal(spec.thinking, "xhigh");
  assert.equal(spec.verb, "run");
  assert.match(spec.historyDir, /^evaluation-state\/11111111-1111-4111-8111-111111111111-[a-f0-9]{12}\/attempt-1$/);
  assert.match(spec.buildCacheDir, /^evaluation-cache\/.+-[a-f0-9]{12}$/);
  const retrySpec = buildWorkItemLaunchSpec({ ...row, attempts: 1 }, { config_json: "{}" });
  assert.match(retrySpec.historyDir, /^evaluation-state\/11111111-1111-4111-8111-111111111111-[a-f0-9]{12}\/attempt-2$/);
  assert.equal(retrySpec.buildCacheDir, spec.buildCacheDir, "attempts share only the dependency cache");
  const otherSpec = buildWorkItemLaunchSpec({ ...row, uuid: "22222222-2222-4222-8222-222222222222" }, { config_json: "{}" });
  assert.notEqual(otherSpec.historyDir, spec.historyDir, "paired baseline and candidate items cannot share scopes, memory, or transcripts");
  const collidingSlugSpec = buildWorkItemLaunchSpec({
    ...row,
    uuid: "33333333-3333-4333-8333-333333333333",
    target_bundle_json: JSON.stringify({ ...absolute.items[0].targetBundle, target: "eval/c1-f1-s1" }),
  }, { config_json: "{}" });
  assert.notEqual(collidingSlugSpec.buildCacheDir, spec.buildCacheDir, "normalized target names retain a digest to prevent cache namespace collisions");
  const otherSourceSpec = buildWorkItemLaunchSpec({
    ...row,
    uuid: "44444444-4444-4444-8444-444444444444",
    target_bundle_json: JSON.stringify({ ...absolute.items[0].targetBundle, sourcePaths: absolute.items[0].targetBundle.sourcePaths.map((sourcePath) => `${sourcePath}-other`) }),
  }, { config_json: "{}" });
  assert.notEqual(otherSourceSpec.buildCacheDir, spec.buildCacheDir, "same-name targets with different source roots cannot share dependency caches");
});

test("evaluation contracts reject blind answer leakage and host execution", () => {
  const leaking = manifest();
  leaking.items[0].materialPolicy.materials[1].policyDecision = "included";
  assert.throws(() => normalizeRunGroupManifest(leaking), /Blind material policy cannot include disclosure/);

  const host = manifest();
  host.items[0].targetBundle.sandboxBackend = "host";
  assert.throws(() => normalizeRunGroupManifest(host), /cannot enable host execution/);

  const unscored = manifest();
  delete unscored.items[0].evidenceContract.expectedOutcome;
  assert.throws(() => normalizeRunGroupManifest(unscored), /explicit evidence expectedOutcome/);

  const ungoverned = manifest();
  delete ungoverned.items[0].materialPolicy;
  assert.throws(() => normalizeRunGroupManifest(ungoverned), /materialPolicy is required/);

  const injected = manifest();
  injected.items[0].targetBundle.scopeNote = "Inspect the known mechanism.";
  assert.throws(() => normalizeRunGroupManifest(injected), /cannot inject a free-form scopeNote/);

  const warning = normalizeRunGroupManifest(manifest()).items[0];
  warning.materialPolicy.materials[0].policyDecision = "warning";
  assert.throws(() => buildWorkItemLaunchSpec({
    item_key: warning.itemKey,
    kind: warning.kind,
    target_bundle_json: JSON.stringify(warning.targetBundle),
    material_policy_json: JSON.stringify(warning.materialPolicy),
    evidence_contract_json: JSON.stringify(warning.evidenceContract),
  }, { config_json: "{}" }), /warnings require an explicit operator/);
});

test("capability-surface targets require explicit neutral authority context", () => {
  const missing = manifest();
  missing.items[0].targetBundle.targetClass = "capability-surface";
  assert.throws(() => normalizeRunGroupManifest(missing), /needs capabilitySurface metadata/);

  const valid = manifest();
  valid.items[0].targetBundle.targetClass = "capability-surface";
  valid.items[0].targetBundle.capabilitySurface = {
    entrypoints: ["process pull request"],
    inputs: ["untrusted PR body"],
    effects: ["write repository files"],
    authorities: ["repository write token"],
    boundaries: ["PR content must not select shell commands"],
    localFixtures: ["fixtures/pr.json"],
  };
  const normalized = normalizeRunGroupManifest(valid);
  const note = capabilitySurfaceScopeNote(normalized.items[0].targetBundle.capabilitySurface);
  assert.match(note, /planning context only/i);
  assert.match(note, /repository write token/);
  assert.match(note, /normal local execution gate/);
});

test("work-item settlement separates blocked execution, positives, and safe controls", () => {
  const positiveItem = {
    kind: "benchmark-case",
    evidence_contract_json: JSON.stringify({ kind: "benchmark-oracle", expectedOutcome: "detect-positive", requiresDifferential: true, networkPolicy: "sealed" }),
  };
  const positive = settleWorkItem({
    item: positiveItem,
    jobStatus: "done",
    run: { id: 7, status: "done", health_status: "healthy", stages_json: JSON.stringify({ refutation: { candidates: 1, verdicts: 1, errors: 0 } }) },
    findings: [{ status: "confirmed-differential" }],
  });
  assert.equal(positive.state, "finished");
  assert.equal(positive.outcome, "findings_reported");
  assert.equal(positive.result.accepted, true);

  const controlItem = {
    kind: "benchmark-case",
    evidence_contract_json: JSON.stringify({ kind: "benchmark-oracle", expectedOutcome: "reject-positive", networkPolicy: "sealed" }),
  };
  const control = settleWorkItem({ item: controlItem, jobStatus: "done", run: { id: 8, status: "done", health_status: "healthy" }, findings: [] });
  assert.equal(control.outcome, "no_findings");
  assert.equal(control.result.accepted, true);

  const blocked = settleWorkItem({ item: positiveItem, jobStatus: "error", jobError: "build failed", findings: [] });
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.result.accepted, false);

  const incompleteRefutation = settleWorkItem({
    item: positiveItem,
    jobStatus: "done",
    run: { id: 9, status: "done", health_status: "healthy" },
    findings: [{ status: "confirmed-differential" }],
  });
  assert.equal(incompleteRefutation.outcome, "blocked");
  assert.equal(incompleteRefutation.result.reason, "refutation-incomplete");

  const shallowControl = settleWorkItem({
    item: controlItem,
    jobStatus: "done",
    run: { id: 10, status: "done", health_status: "shallow" },
    findings: [],
  });
  assert.equal(shallowControl.outcome, "blocked");
  assert.equal(shallowControl.result.reason, "run-health-unscored");

  const report = renderRunGroupReport({ name: "g", state: "finished", kind: "evaluation" }, [
    { item_key: "miss", kind: "benchmark-case", state: "finished", outcome: "no_findings", result_json: JSON.stringify({ accepted: false }) },
    { item_key: "infra", kind: "benchmark-case", state: "failed", outcome: "blocked", result_json: JSON.stringify({ accepted: false }) },
  ]);
  assert.equal(report.summary.scoredItems, 1);
  assert.equal(report.summary.passRate, 0);
});
