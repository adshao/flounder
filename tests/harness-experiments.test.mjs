import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHarnessCandidateProposal,
  harnessEvidenceItemFromRow,
  mineHarnessWeaknesses,
  minePreservedBehaviors,
  normalizeHarnessExperimentInput,
  normalizeHarnessProposal,
  renderHarnessCandidateBrief,
  scoreHarnessExperiment,
} from "../dist/evaluation/harness-experiments.js";

function evidence(itemKey, expectedOutcome, accepted, overrides = {}) {
  return {
    itemKey,
    state: "finished",
    outcome: accepted ? "confirmed" : expectedOutcome === "detect-positive" ? "no_findings" : "findings_reported",
    expectedOutcome,
    evidenceGate: "benchmark-oracle",
    contractFingerprint: "paired-contract",
    accepted,
    reason: accepted ? null : expectedOutcome === "detect-positive" ? "required independent refutation evidence is missing" : "control produced a confirmed finding",
    attempts: 1,
    durationSeconds: 10,
    caseId: itemKey,
    caseFamily: itemKey.endsWith("2") ? "family-b" : "family-a",
    targetStack: "javascript",
    holdout: itemKey.endsWith("2"),
    failurePhase: accepted === false ? "discovery" : null,
    phaseFunnel: accepted === false ? { failurePhase: "discovery" } : null,
    ...overrides,
  };
}

test("harness experiment contracts bound every proposed edit outside the trusted evaluator", () => {
  const input = normalizeHarnessExperimentInput({
    name: "recall experiment",
    baselineRunGroupUuid: "baseline",
    editableFiles: ["src/agent/prompts.ts", "prompts/audit.md"],
  });
  assert.equal(input.promotionPolicy.minimumSamplesPerClass, 2);
  assert.equal(input.promotionPolicy.minimumDistinctCases, 2);
  assert.equal(input.promotionPolicy.minimumDistinctFamilies, 2);
  assert.equal(input.promotionPolicy.minimumHoldoutCases, 1);
  assert.throws(() => normalizeHarnessExperimentInput({
    name: "unsafe",
    baselineRunGroupUuid: "baseline",
    editableFiles: ["src/security/policy.ts"],
  }), /outside the bounded harness-edit surface/);
  assert.throws(() => normalizeHarnessExperimentInput({
    name: "unsafe",
    baselineRunGroupUuid: "baseline",
    editableFiles: ["tests/fixtures/answer.json"],
  }), /outside the bounded harness-edit surface/);

  const patterns = mineHarnessWeaknesses([evidence("p1", "detect-positive", false)]);
  assert.throws(() => normalizeHarnessProposal({
    title: "weaken the judge",
    hypothesis: "change the answer",
    failurePatternIds: [patterns[0].id],
    editableFiles: ["src/agent/prompts.ts"],
    changes: [{ path: "src/evaluation/contracts.ts", summary: "accept it" }],
    preserve: [],
  }, input.editableFiles, patterns), /outside the bounded harness-edit surface|protected or undeclared/);
  assert.throws(() => normalizeHarnessProposal({
    title: "unbound change",
    hypothesis: "claim an unrelated improvement",
    failurePatternIds: [],
    editableFiles: ["src/agent/prompts.ts"],
    changes: [{ path: "src/agent/prompts.ts", summary: "change it" }],
    preserve: [],
  }, input.editableFiles, patterns), /at least one verifier-grounded failure pattern/);
  assert.throws(() => normalizeHarnessProposal({
    title: "mismatched surface",
    hypothesis: "declare one file and change another",
    failurePatternIds: [patterns[0].id],
    editableFiles: ["prompts/audit.md"],
    changes: [{ path: "src/agent/prompts.ts", summary: "hidden change" }],
    preserve: [],
  }, input.editableFiles, patterns), /outside its declared editable files/);
});

test("failure mining clusters verifier causes and preserves passing controls", () => {
  const items = [
    evidence("p1", "detect-positive", false),
    evidence("p2", "detect-positive", false, { holdout: false }),
    evidence("c1", "reject-positive", true),
    evidence("blocked", "detect-positive", null, {
      state: "failed",
      outcome: "blocked",
      reason: `build failed under ${["", "private", "tmp", "target-123456"].join("/")}`,
    }),
  ];
  const patterns = mineHarnessWeaknesses(items);
  assert.equal(patterns[0].kind, "positive-miss");
  assert.equal(patterns[0].occurrences, 2);
  assert.equal(patterns.find((pattern) => pattern.kind === "execution-blocked").mechanism, "target preparation");
  assert.doesNotMatch(patterns.find((pattern) => pattern.kind === "execution-blocked").verifierCause, /private\/tmp/);
  const preserved = minePreservedBehaviors(items);
  assert.deepEqual(preserved.map((entry) => entry.workItemKey), ["c1"]);

  const proposal = buildHarnessCandidateProposal(patterns, preserved, ["src/agent/prompts.ts"]);
  assert.ok(proposal);
  assert.deepEqual(proposal.editableFiles, ["src/agent/prompts.ts"]);
  const normalized = normalizeHarnessProposal(proposal, ["src/agent/prompts.ts"], patterns);
  assert.equal(normalized.changes.length, 1);
  const brief = renderHarnessCandidateBrief({
    experimentName: "recall",
    baselineGroup: { uuid: "b", name: "baseline", state: "finished", items },
    proposal: normalized,
    patterns,
    policy: normalizeHarnessExperimentInput({ name: "x", baselineRunGroupUuid: "b", editableFiles: ["src/agent/prompts.ts"] }).promotionPolicy,
  });
  assert.match(brief, /Protected boundary/);
  assert.match(brief, /never merge or deploy automatically/);
});

test("promotion gate requires paired repeated positives and controls with no regression", () => {
  const baselineItems = [
    evidence("p1", "detect-positive", false),
    evidence("p2", "detect-positive", true),
    evidence("c1", "reject-positive", true),
    evidence("c2", "reject-positive", true),
  ];
  const candidateItems = baselineItems.map((item) => item.itemKey === "p1" ? evidence("p1", "detect-positive", true) : { ...item });
  const policy = normalizeHarnessExperimentInput({ name: "x", baselineRunGroupUuid: "b", editableFiles: ["src/agent/prompts.ts"] }).promotionPolicy;
  const scorecard = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems },
    { uuid: "c", name: "candidate", state: "finished", items: candidateItems },
    policy,
  );
  assert.equal(scorecard.decision, "promote");
  assert.deepEqual(scorecard.improvedItemKeys, ["p1"]);
  assert.deepEqual(scorecard.regressedItemKeys, []);
  assert.equal(scorecard.candidate.holdouts, 2);
  assert.equal(scorecard.candidate.holdoutsPassed, 2);

  const regression = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems },
    { uuid: "c", name: "candidate", state: "finished", items: candidateItems.map((item) => item.itemKey === "c1" ? evidence("c1", "reject-positive", false) : item) },
    policy,
  );
  assert.equal(regression.decision, "reject");
  assert.deepEqual(regression.regressedItemKeys, ["c1"]);

  const insufficient = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems.slice(0, 2) },
    { uuid: "c", name: "candidate", state: "finished", items: candidateItems.slice(0, 2) },
    policy,
  );
  assert.equal(insufficient.decision, "needs-more-samples");

  const repeatedFamily = candidateItems.map((item) => ({ ...item, caseFamily: "one-family" }));
  const insufficientDiversity = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems.map((item) => ({ ...item, caseFamily: "one-family" })) },
    { uuid: "c", name: "candidate", state: "finished", items: repeatedFamily },
    policy,
  );
  assert.equal(insufficientDiversity.decision, "needs-more-samples");

  const controlsDoNotFakePositiveDiversity = candidateItems.map((item) => ({
    ...item,
    caseFamily: item.expectedOutcome === "detect-positive" ? "one-positive-family" : `control-${item.itemKey}`,
  }));
  const positiveFamilyGate = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems.map((item) => ({ ...item, caseFamily: item.expectedOutcome === "detect-positive" ? "one-positive-family" : `control-${item.itemKey}` })) },
    { uuid: "c", name: "candidate", state: "finished", items: controlsDoNotFakePositiveDiversity },
    policy,
  );
  assert.equal(positiveFamilyGate.decision, "needs-more-samples");

  const twoSamplesOneHoldout = candidateItems.map((item) => item.holdout ? { ...item, caseId: "same-hidden-case" } : item);
  const holdoutPolicy = normalizeHarnessExperimentInput({
    name: "holdout-diversity",
    baselineRunGroupUuid: "b",
    editableFiles: ["src/agent/prompts.ts"],
    promotionPolicy: { minimumHoldoutCases: 2 },
  }).promotionPolicy;
  const holdoutDiversity = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: baselineItems.map((item) => item.holdout ? { ...item, caseId: "same-hidden-case" } : item) },
    { uuid: "c", name: "candidate", state: "finished", items: twoSamplesOneHoldout },
    holdoutPolicy,
  );
  assert.equal(holdoutDiversity.decision, "needs-more-samples");

  const repeatedImprovementPolicy = normalizeHarnessExperimentInput({
    name: "improvement-diversity",
    baselineRunGroupUuid: "b",
    editableFiles: ["src/agent/prompts.ts"],
    promotionPolicy: { minimumImprovedCases: 2 },
  }).promotionPolicy;
  const repeatedImprovementBaseline = [
    evidence("p1-a", "detect-positive", false, { caseId: "p1", caseFamily: "family-a", holdout: false }),
    evidence("p1-b", "detect-positive", false, { caseId: "p1", caseFamily: "family-a", holdout: false }),
    evidence("p2", "detect-positive", true, { caseId: "p2", caseFamily: "family-b", holdout: true }),
    evidence("c1", "reject-positive", true, { holdout: false }),
    evidence("c2", "reject-positive", true, { holdout: false }),
  ];
  const repeatedImprovementCandidate = repeatedImprovementBaseline.map((item) => item.caseId === "p1" ? { ...item, accepted: true, outcome: "confirmed", reason: null } : item);
  const repeatedImprovement = scoreHarnessExperiment(
    { uuid: "b", name: "baseline", state: "finished", items: repeatedImprovementBaseline },
    { uuid: "c", name: "candidate", state: "finished", items: repeatedImprovementCandidate },
    repeatedImprovementPolicy,
  );
  assert.equal(repeatedImprovement.improvedItemKeys.length, 2);
  assert.equal(repeatedImprovement.decision, "reject");
  assert.match(repeatedImprovement.reasons.join(" "), /improved 1 distinct cases/);
});

test("stored work-item evidence is normalized without trusting raw JSON", () => {
  const item = harnessEvidenceItemFromRow({
    item_key: "p1",
    state: "finished",
    outcome: "confirmed",
    attempts: 2,
    evidence_contract_json: JSON.stringify({ kind: "benchmark-oracle", expectedOutcome: "detect-positive" }),
    result_json: JSON.stringify({ accepted: true }),
    started_at: "2026-07-10T12:00:00.000Z",
    ended_at: "2026-07-10T12:00:12.000Z",
  });
  assert.deepEqual(item, {
    itemKey: "p1",
    state: "finished",
    outcome: "confirmed",
    expectedOutcome: "detect-positive",
    evidenceGate: "benchmark-oracle",
    contractFingerprint: item.contractFingerprint,
    accepted: true,
    reason: null,
    attempts: 2,
    durationSeconds: 12,
    caseId: null,
    caseFamily: null,
    targetStack: null,
    holdout: false,
    failurePhase: null,
    phaseFunnel: null,
  });
  assert.match(item.contractFingerprint, /^[a-f0-9]{64}$/);
});
