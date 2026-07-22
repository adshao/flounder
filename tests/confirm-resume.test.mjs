import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enforceBountySubmitReadiness, loadSettledFromPriorConfirm } from "../dist/agent/confirm.js";
import { publicPath } from "../dist/util/paths.js";

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
    { bug: "Bug A", reproduced: "yes", recommendation: "submit-candidate", humanGates: "" },
    { bug: "Bug B", reproduced: "could-not-set-up" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260102T000000Z", inputX, [
    { bug: "Bug A", reproduced: "yes", recommendation: "submit-candidate", humanGates: "" },
    { bug: "Bug B", reproduced: "no" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260103T000000Z", inputY, [{ bug: "Bug Z", reproduced: "yes" }]); // different input → ignored

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-20260104T000000Z"));
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Bug A", "Bug B"]); // both settled, from the LATEST matching run
  assert.equal(settled.every((r) => r.reproduced === "yes" || r.reproduced === "no"), true);
});

test("confirm resume: reproduced needs-human rows are not settled and remain retry work", async () => {
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
    { bug: "Bug B", reproduced: "yes", recommendation: "submit-candidate", humanGates: "", members: ["kb"] },
  ]);
  await mkAggregateConfirmRun(out, "tgt-confirm-20260103T000000Z", [inputA, inputC], [{ bug: "Bug C", reproduced: "yes", recommendation: "drop", members: ["kc"] }]);

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputA, path.join(out, "tgt-confirm-cur"), [inputA, inputB]);
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Bug A newer", "Bug B"]);
});

test("confirm bounty submit readiness requires impact inventory and closed gates", () => {
  const base = {
    bug: "Pool drain",
    members: ["kpool"],
    reproduced: "yes",
    recommendation: "submit-candidate",
    humanGates: "",
    engagementProfile: {
      policy_kind: "bug_bounty",
      required_gates: ["scope", "live_impact", "known_issue", "payout"],
    },
    adjudication: {
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
        live_impact_status: "unknown",
      },
    },
  ], { impactInventory: { items: [{ bug: "Pool drain", members: ["kpool"], status: "funded" }] } });
  assert.equal(openLiveGate[0].recommendation, "needs-human");
  assert.match(openLiveGate[0].humanGates, /live_impact gate/);

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
      engagementProfile: {
        policy_kind: "bug_bounty",
        evidence_requirement: "source_only",
        required_gates: ["scope", "known_issue", "payout"],
      },
      adjudication: {
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
  assert.match(missingPolicyProof[0].humanGates, /not permitted by the engagement's evidence requirement/);
});

test("configured bounty engagement cannot be downgraded to source review", () => {
  const rows = enforceBountySubmitReadiness([
    {
      bug: "Configured bounty bug",
      members: ["kconfigured"],
      reproduced: "yes",
      recommendation: "submit-candidate",
      humanGates: "",
      engagementProfile: { policy_kind: "source_review", selected_by: "venue lookup failed" },
      adjudication: {
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
