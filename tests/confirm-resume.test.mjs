import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCompleteConfirmDecisionCoverage, assertConfirmCompletion, enforceBountySubmitReadiness, enforceConfirmExecutionProvenance, loadSettledFromPriorConfirm, parseConfirmDecisionRows } from "../dist/agent/confirm.js";
import { publicPath } from "../dist/util/paths.js";

function validTechnicalClaimGates() {
  return [
    { id: "attacker_reachability", status: "pass", evidence: "The attacker reaches all preconditions with untrusted permissions." },
    { id: "end_to_end_effect", status: "pass", evidence: "The passing confirmation command observes the claimed unauthorized effect." },
    { id: "impact_bounds", status: "pass", evidence: "Recovery, revocation, timing, and reversibility controls were included in the impact statement." },
  ];
}

// `flounder confirm` auto-resumes a prior interrupted confirm of the same input run: it finds
// the latest prior confirm dir (matched by frozen provenance) and carries only rows that
// are final for the pipeline forward. Reproduced rows with open submission gates must be
// retried, not treated as settled.

async function mkConfirmRun(outDir, name, inputRunDir, rows) {
  const dir = path.join(outDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "confirm_provenance.json"), JSON.stringify({ inputRunDir: publicPath(inputRunDir), frozenFiles: [] }));
  if (rows) await writeFile(path.join(dir, "confirm_decision.json"), JSON.stringify(rows));
  return dir;
}

async function mkAggregateConfirmRun(outDir, name, inputRunDirs, rows) {
  const dir = path.join(outDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "confirm_provenance.json"), JSON.stringify({ inputRunDir: publicPath(inputRunDirs[0]), runDirs: inputRunDirs.map((entry) => publicPath(entry)), frozenFiles: [] }));
  if (rows) await writeFile(path.join(dir, "confirm_decision.json"), JSON.stringify(rows));
  return dir;
}

test("confirm resume: loads SETTLED rows from the latest prior confirm of the same input", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-"));
  const inputX = "/some/input-run-X";
  const inputY = "/some/input-run-Y";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [
    { bug: "Bug A", reproduced: "yes", recommendation: "submit-candidate", humanGates: "", evidenceLevel: "source-only-local-confirmed", reproCommandId: "cmd-a-old", engagementProfile: { policy_kind: "source_review", evidence_requirement: "source_only" }, adjudication: { gates: validTechnicalClaimGates() } },
    { bug: "Bug B", reproduced: "could-not-set-up" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260102T000000Z", inputX, [
    { bug: "Bug A", reproduced: "yes", recommendation: "submit-candidate", humanGates: "", evidenceLevel: "source-only-local-confirmed", reproCommandId: "cmd-a", engagementProfile: { policy_kind: "source_review", evidence_requirement: "source_only" }, adjudication: { gates: validTechnicalClaimGates() } },
    { bug: "Bug B", reproduced: "no" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260103T000000Z", inputY, [{ bug: "Bug Z", reproduced: "yes" }]); // different input → ignored

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-20260104T000000Z"));
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Bug A", "Bug B"]); // both settled, from the LATEST matching run
  assert.equal(settled.every((r) => r.reproduced === "yes" || r.reproduced === "no"), true);
});

test("confirm resume: technically incomplete reproduced rows remain retry work", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-gates-"));
  const inputX = "/some/input-run-X";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [
    {
      bug: "Gate blocked bug",
      reproduced: "yes",
      recommendation: "needs-human",
      humanGates: "Live funded exposure and payout tier remain unknown.",
      adjudication: { live_impact_status: "unknown" },
    },
    { bug: "Not reproduced bug", reproduced: "no", recommendation: "drop" },
    { bug: "Dropped bug", reproduced: "yes", recommendation: "drop", humanGates: "Deprecated deployment." },
  ]);

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-cur"));
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Dropped bug", "Not reproduced bug"]);
});

test("confirm resume: policy-only human gates do not rerun settled exploit evidence", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-policy-gates-"));
  const inputX = "/some/input-run-X";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [{
    bug: "Technically settled bug",
    reproduced: "yes",
    recommendation: "needs-human",
    evidenceLevel: "local-fork-reproduced",
    reproCommandId: "cmd-settled",
    humanGates: "Live exposure and payout adjudication remain pending.",
    engagementProfile: {
      policy_kind: "bug_bounty",
      policy_sources: ["https://example.test/bounty/policy"],
      evidence_requirement: "real_target",
      required_gates: ["scope", "live_impact", "known_issue", "payout"],
    },
    adjudication: {
      gates: [
        { id: "scope", status: "pass", evidence: "The official list includes the target." },
        { id: "live_impact", status: "unknown", evidence: "Live exposure is still under review." },
        ...validTechnicalClaimGates(),
      ],
      scope_status: "pass",
      live_impact_status: "unknown",
      known_issue_status: "novel",
      payout_estimate: { status: "unknown" },
    },
  }]);

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-cur"));
  assert.deepEqual(settled.map((row) => row.bug), ["Technically settled bug"]);
});

test("confirm resume: no prior confirm → empty (fresh start)", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-none-"));
  assert.deepEqual(await loadSettledFromPriorConfirm(out, "tgt", "/some/input", path.join(out, "tgt-confirm-X")), []);
});

test("confirm resume: skips a latest run with no decision sheet (killed before first checkpoint), falls back to an older one", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-fallback-"));
  const inputX = "/some/input-run-X";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [{ bug: "Bug A", reproduced: "yes", recommendation: "drop" }]);
  await mkConfirmRun(out, "tgt-confirm-20260102T000000Z", inputX, null); // no decision yet
  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-cur"));
  assert.deepEqual(settled.map((r) => r.bug), ["Bug A"]);
});

test("confirm resume: aggregate input carries settled rows from prior subset confirms", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-resume-aggregate-"));
  const inputA = "/some/input-run-A";
  const inputB = "/some/input-run-B";
  const inputC = "/some/input-run-C";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputA, [{ bug: "Bug A", reproduced: "yes", recommendation: "drop", members: ["ka"] }]);
  await mkAggregateConfirmRun(out, "tgt-confirm-20260102T000000Z", [inputA, inputB], [
    { bug: "Bug A newer", reproduced: "no", members: ["ka"] },
    { bug: "Bug B", reproduced: "yes", recommendation: "submit-candidate", humanGates: "", evidenceLevel: "source-only-local-confirmed", reproCommandId: "cmd-b", engagementProfile: { policy_kind: "source_review", evidence_requirement: "source_only" }, adjudication: { gates: validTechnicalClaimGates() }, members: ["kb"] },
  ]);
  await mkAggregateConfirmRun(out, "tgt-confirm-20260103T000000Z", [inputA, inputC], [{ bug: "Bug C", reproduced: "yes", recommendation: "drop", members: ["kc"] }]);

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputA, path.join(out, "tgt-confirm-cur"), [inputA, inputB]);
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Bug A newer", "Bug B"]);
});

test("confirm completion rejects a decision sheet that omits selected finding ids", () => {
  const findings = [
    { id: "finding-a" },
    { id: "finding-b" },
    { id: "finding-c" },
  ];

  assert.doesNotThrow(() => assertCompleteConfirmDecisionCoverage(findings, [
    { members: ["finding-a", "finding-b"] },
    { members: ["finding-c"] },
  ]));

  assert.throws(
    () => assertCompleteConfirmDecisionCoverage(findings, [
      { members: ["finding-a", "finding-b"] },
    ]),
    /decision sheet omitted 1 selected finding id.*finding-c/,
  );
});

test("confirm decision parser preserves linked ids from a structured model checkpoint without promoting unsupported claims", () => {
  const rows = parseConfirmDecisionRows({ decisions: [
    { member_id: "finding-a", title: "Issue A", execution_verdict: "not_reproduced_against_live_artifacts", final_bounty_decision: "exclude" },
    { member_id: "finding-b", title: "Issue B", execution_verdict: "reproduced", command_run_id: "cmd7", execution_evidence: { observation: "local fork changed state" }, final_bounty_decision: "exclude_documented_risk" },
    { member_id: "finding-c", title: "Issue C", execution_verdict: "claimed", final_bounty_decision: "submit" },
  ] });
  assert.doesNotThrow(() => assertCompleteConfirmDecisionCoverage(
    [{ id: "finding-a" }, { id: "finding-b" }, { id: "finding-c" }], rows,
  ));
  assert.deepEqual(rows.map((row) => [row.members, row.reproduced, row.recommendation]), [
    [["finding-a"], "no", "drop"],
    [["finding-b"], "yes", "drop"],
    [["finding-c"], "unknown", "unknown"],
  ]);
  assert.equal(rows[1].reproCommandId, "cmd7");
  assert.match(rows[1].reproEvidence, /local fork changed state/);
  assert.equal(enforceConfirmExecutionProvenance([rows[1]], [])[0].recommendation, "needs-human");
});

test("confirm resume recovers linked rows from the raw checkpoint when a failed artifact lost their ids", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-raw-checkpoint-"));
  const input = "/some/input-run";
  const dir = await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", input, [
    { bug: "Issue A", members: [], reproduced: "unknown" },
    { bug: "Issue B", members: [], reproduced: "unknown" },
    { bug: "Issue C", members: [], reproduced: "unknown" },
  ]);
  const workspace = path.join(dir, "confirm", "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "confirm_decision.json"), JSON.stringify({ decisions: [
    { member_id: "finding-a", title: "Issue A", execution_verdict: "not_reproduced_against_live_artifacts", final_bounty_decision: "exclude" },
    { member_id: "finding-b", title: "Issue B", execution_verdict: "reproduced", command_run_id: "cmd7", final_bounty_decision: "exclude_documented_risk" },
    { member_id: "finding-c", title: "Issue C", execution_verdict: "reproduced", command_run_id: "cmd8", final_bounty_decision: "exclude_documented_risk" },
  ] }));
  await writeFile(path.join(dir, "events.jsonl"), [
    JSON.stringify({ kind: "audit_command_run", runId: "cmd7", purpose: "confirm", passed: true }),
    JSON.stringify({ kind: "audit_command_run", runId: "cmd8", purpose: "confirm", passed: false }),
  ].join("\n"));

  const settled = await loadSettledFromPriorConfirm(out, "tgt", input, path.join(out, "tgt-confirm-current"));
  assert.deepEqual(settled.map((row) => row.members[0]).sort(), ["finding-a", "finding-b", "finding-c"]);
  assert.deepEqual(settled.map((row) => row.recommendation), ["drop", "drop", "drop"]);
  assert.equal(settled.find((row) => row.members[0] === "finding-b").reproduced, "yes");
  assert.equal(settled.find((row) => row.members[0] === "finding-c").reproduced, "unknown");
});

test("confirm completion preserves the provider session error ahead of decision coverage", () => {
  assert.throws(
    () => assertConfirmCompletion(
      {
        stoppedReason: "error",
        steps: [{ tool: "(session-error)", observation: "Codex error: request was flagged by the provider" }],
      },
      [{ id: "finding-a" }],
      [],
    ),
    (error) => {
      assert.match(error.message, /model session failed.*flagged by the provider/);
      assert.doesNotMatch(error.message, /decision sheet omitted/);
      return true;
    },
  );
});

test("confirm execution evidence must bind to a recorded passing target-linked command", () => {
  const base = {
    bug: "Command provenance",
    reproduced: "yes",
    recommendation: "submit-candidate",
    evidenceLevel: "source-only-local-confirmed",
    reproCommandId: "cmd-good",
    humanGates: "",
  };
  const passing = {
    id: "cmd-good",
    purpose: "confirm",
    passed: true,
    targetLinked: true,
    timedOut: false,
    exitCode: 0,
    expectedExitCode: 0,
    missing: [],
    matched: ["EXPLOIT_REPRODUCED"],
  };

  assert.equal(enforceConfirmExecutionProvenance([base], [passing])[0].recommendation, "submit-candidate");

  const [invented] = enforceConfirmExecutionProvenance([{ ...base, reproCommandId: "cmd-invented" }], [passing]);
  assert.equal(invented.recommendation, "needs-human");
  assert.equal(invented.evidenceLevel, undefined);
  assert.equal(invented.reproCommandId, undefined);
  assert.match(invented.humanGates, /could not bind.*purpose=confirm/i);

  const [carried] = enforceConfirmExecutionProvenance([base], [], [{ bug: base.bug }]);
  assert.equal(carried.recommendation, "submit-candidate", "a previously settled row keeps its already-validated provenance on resume");
});

test("confirm bounty submit readiness requires impact inventory and closed gates", () => {
  const base = {
    bug: "Pool drain",
    members: ["kpool"],
    reproduced: "yes",
    recommendation: "submit-candidate",
    humanGates: "",
    evidenceLevel: "local-fork-reproduced",
    reproCommandId: "cmd-pool",
    engagementProfile: {
      policy_kind: "bug_bounty",
      policy_sources: ["https://example.test/bounty/policy"],
      required_gates: ["scope", "live_impact", "known_issue", "payout"],
    },
    adjudication: {
      gates: [
        { id: "scope", status: "pass", evidence: "The official asset list includes the pool." },
        { id: "live_impact", status: "pass", evidence: "The deployment is live and covered by the impact inventory." },
        ...validTechnicalClaimGates(),
      ],
      scope_status: "pass",
      live_impact_status: "pass",
      known_issue_status: "novel",
      payout_estimate: { status: "estimated", basis: "Program tier plus inventory evidence." },
    },
  };

  const noInventory = enforceBountySubmitReadiness([base]);
  assert.equal(noInventory[0].recommendation, "needs-human");
  assert.match(noInventory[0].humanGates, /impact_inventory\.json/);

  const openLiveGate = enforceBountySubmitReadiness([
    {
      ...base,
      adjudication: {
        ...base.adjudication,
        gates: base.adjudication.gates.map((gate) => gate.id === "live_impact" ? { ...gate, status: "unknown", evidence: "Live impact still needs review." } : gate),
        live_impact_status: "unknown",
      },
    },
  ], { impactInventory: { items: [{ bug: "Pool drain", members: ["kpool"], status: "funded" }] } });
  assert.equal(openLiveGate[0].recommendation, "needs-human");
  assert.match(openLiveGate[0].humanGates, /Required live impact/);

  const ready = enforceBountySubmitReadiness([base], {
    impactInventory: {
      items: [
        {
          bug: "Pool drain",
          members: ["kpool"],
          status: "funded",
          affected_deployments: [{ network: "chain", address: "0x1", is_live: true, is_funded: true, funds_at_risk_usd: "100000" }],
        },
      ],
    },
  });
  assert.equal(ready[0].recommendation, "submit-candidate");
});

test("pre-mainnet bounty can use the program's source-only submission gates", () => {
  const rows = enforceBountySubmitReadiness([
    {
      bug: "Pre-mainnet source bug",
      members: ["ksource"],
      reproduced: "yes",
      recommendation: "submit-candidate",
      humanGates: "",
      evidenceLevel: "source-only-local-confirmed",
      reproCommandId: "cmd-source",
      engagementProfile: {
        policy_kind: "bug_bounty",
        policy_sources: ["https://example.test/bounty/pre-mainnet-policy"],
        evidence_requirement: "source_only",
        required_gates: ["scope", "known_issue", "payout"],
      },
      adjudication: {
        gates: [
          { id: "scope", status: "pass", evidence: "The official source path is listed in scope." },
          ...validTechnicalClaimGates(),
        ],
        scope_status: "pass",
        live_impact_status: "not_required",
        known_issue_status: "novel",
        payout_estimate: {
          status: "estimated",
          eligible_min_usd: 5_000,
          eligible_max_usd: 20_000,
          basis: "The program explicitly pays a base reward before mainnet.",
        },
      },
    },
  ]);

  assert.equal(rows[0].recommendation, "submit-candidate");
  assert.equal(rows[0].humanGates, "");

  const missingPolicyProof = enforceBountySubmitReadiness([
    {
      ...rows[0],
      engagementProfile: {
        policy_kind: "bug_bounty",
        required_gates: ["scope", "known_issue", "payout"],
      },
    },
  ]);
  assert.equal(missingPolicyProof[0].recommendation, "needs-human");
  assert.match(missingPolicyProof[0].humanGates, /official policy source|does not establish whether source executed satisfies its evidence minimum/);
});

test("configured bounty engagement cannot be downgraded to source review", () => {
  const rows = enforceBountySubmitReadiness([
    {
      bug: "Configured bounty bug",
      members: ["kconfigured"],
      reproduced: "yes",
      recommendation: "submit-candidate",
      humanGates: "",
      evidenceLevel: "local-fork-reproduced",
      reproCommandId: "cmd-configured",
      engagementProfile: { policy_kind: "source_review", selected_by: "venue lookup failed" },
      adjudication: {
        gates: [
          { id: "scope", status: "pass", evidence: "The configured venue asset list includes the target." },
          { id: "live_impact", status: "pass", evidence: "The configured venue requires and records live impact." },
          ...validTechnicalClaimGates(),
        ],
        scope_status: "pass",
        live_impact_status: "pass",
        known_issue_status: "pass",
        payout_estimate: { status: "not-applicable" },
      },
    },
  ], {
    configuredEngagement: {
      kind: "bug-bounty",
      venue: "Example venue",
      contestUrl: "https://example.invalid/bug-bounty/acme/information/",
    },
  });

  assert.equal(rows[0].engagementProfile.policy_kind, "bug_bounty");
  assert.equal(rows[0].engagementProfile.platform, "Example venue");
  assert.deepEqual(rows[0].engagementProfile.policy_sources, ["https://example.invalid/bug-bounty/acme/information/"]);
  assert.equal(rows[0].recommendation, "needs-human");
  assert.match(rows[0].humanGates, /configured bug_bounty engagement/);
  assert.match(rows[0].humanGates, /impact_inventory\.json/);
});
