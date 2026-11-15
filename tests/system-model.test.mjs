import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { runAudit } from "../dist/agent/audit.js";
import { runRefutation } from "../dist/agent/refutation.js";
import { AUDIT_DEEP_SYSTEM, AUDIT_SYSTEM, AUDIT_VERIFY_SYSTEM, AUDIT_SYNTHESIS_SYSTEM, FINDING_BAR, MAP_SYSTEM, SYSTEM_MODEL_USE_RULE } from "../dist/agent/prompts.js";
import { buildSessionPrompt } from "../dist/agent/pi-session.js";
import { RunLogger } from "../dist/trace/logger.js";
import { withFindingBarEvidence } from "../dist/agent/tools.js";
import { SYSTEM_MODEL_WORKSPACE_PATH, clipSystemModel, loadSystemModel, normalizeSystemModel, saveSystemModel, unionSystemModels } from "../dist/agent/system-model.js";

process.env.FLOUNDER_SANDBOX_BACKEND = "host";
process.env.FLOUNDER_ALLOW_HOST_EXECUTION = "1";

const fixtures = path.join(path.resolve("."), "fixtures");
const tempDir = () => mkdtemp(path.join(os.tmpdir(), "flounder-system-model-"));

test("system model: persisted per material fingerprint and never reused across material", async () => {
  const dir = await tempDir();
  try {
    assert.equal(await loadSystemModel(dir, "fp-a"), undefined);
    await saveSystemModel(dir, "  principals: operator, depositor  \n", "fp-a");
    assert.equal(await loadSystemModel(dir, "fp-a"), "principals: operator, depositor");
    assert.equal(await loadSystemModel(dir, "fp-b"), undefined, "a model for other material must not become context for this material");
    assert.equal(await loadSystemModel(dir), "principals: operator, depositor", "an unfingerprinted run reads what is there");
    await saveSystemModel(dir, "   ", "fp-a");
    assert.equal(await loadSystemModel(dir, "fp-a"), "principals: operator, depositor", "an empty model never overwrites a real one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system model: independent map samples are kept side by side, not merged by the framework", () => {
  assert.equal(unionSystemModels([undefined, "  "]), undefined);
  assert.equal(unionSystemModels([undefined, "only"]), "only");
  const both = unionSystemModels(["first", "second"]);
  assert.match(both, /# Independent map sample 1\n\nfirst/);
  assert.match(both, /# Independent map sample 2\n\nsecond/);
  assert.equal(normalizeSystemModel(""), undefined);
  assert.equal(clipSystemModel("x".repeat(50), 10).startsWith("xxxxxxxxxx\n"), true);
  assert.equal(clipSystemModel(undefined, 10), "");
});

test("finding bar: one definition reaches every phase that produces or settles a finding", () => {
  for (const [name, prompt] of Object.entries({ AUDIT_SYSTEM, AUDIT_DEEP_SYSTEM, AUDIT_VERIFY_SYSTEM, AUDIT_SYNTHESIS_SYSTEM })) {
    assert.ok(prompt.includes(FINDING_BAR), `${name} states the finding bar`);
    assert.ok(prompt.includes(SYSTEM_MODEL_USE_RULE), `${name} points at the shared system model`);
  }
  assert.ok(!MAP_SYSTEM.includes(FINDING_BAR), "MAP produces coverage and context, not findings");
  assert.match(MAP_SYSTEM, /system_model\.md/);

  // The session driver (the production path) builds from the same constants.
  const cfg = defaultConfig();
  const base = { cfg, fileManifest: "src/a.sol" };
  for (const [name, prompt] of Object.entries({
    breadth: buildSessionPrompt(base),
    dig: buildSessionPrompt({ ...base, deep: true, deepFocus: "scope S1; code region src/a.sol:1-20" }),
    verify: buildSessionPrompt({ ...base, verify: "claim" }),
    synthesis: buildSessionPrompt({ ...base, synthesize: "seed" }),
  })) {
    assert.ok(prompt.includes(FINDING_BAR), `session ${name} prompt states the finding bar`);
    assert.ok(prompt.includes(SYSTEM_MODEL_WORKSPACE_PATH), `session ${name} prompt names the staged system model`);
    assert.match(prompt, /attacker \(who exploits it/);
  }
  const map = buildSessionPrompt({ ...base, map: true });
  assert.match(map, /write system_model\.md at the workspace root/);
  assert.ok(!map.includes(FINDING_BAR));
});

test("finding bar: prompts stay free of framework-chosen lenses and of the proof/weaponization contradiction", () => {
  const cfg = defaultConfig();
  const all = [
    AUDIT_SYSTEM, AUDIT_DEEP_SYSTEM, AUDIT_VERIFY_SYSTEM, AUDIT_SYNTHESIS_SYSTEM, MAP_SYSTEM,
    buildSessionPrompt({ cfg, fileManifest: "" }),
    buildSessionPrompt({ cfg, fileManifest: "", deep: true }),
    buildSessionPrompt({ cfg, fileManifest: "", map: true }),
  ].join("\n");
  // A proof must exhibit the effect; forbidding "value-extraction exploits" told the
  // model to stop one step short of the evidence the bar requires.
  assert.doesNotMatch(all, /value-extraction/i);
  assert.match(all, /Exhibit the effect only inside local tests, forks, or harnesses/);
  // Reading order, lenses, and component taxonomies are the model's.
  assert.doesNotMatch(all, /three general lenses/i);
  assert.doesNotMatch(all, /ZK circuit|verification key|upgradeable implementation/i);
});

test("finding bar: attacker and effect travel with the evidence text", () => {
  assert.equal(withFindingBarEvidence("line 10 skips the check"), "line 10 skips the check");
  assert.equal(
    withFindingBarEvidence("line 10 skips the check", " any depositor ", "ledger credits twice"),
    "line 10 skips the check\nAttacker and assumed capabilities: any depositor\nUnauthorized effect observed: ledger credits twice",
  );
  assert.equal(withFindingBarEvidence("", undefined, "ledger credits twice"), "Unauthorized effect observed: ledger credits twice");
});

test("refutation: the skeptic receives the shared system model as context", async () => {
  const dir = await tempDir();
  try {
    const logger = new RunLogger(dir, "refute-model", new Date(), { streamEvents: false });
    await logger.init();
    const seen = [];
    const llm = { complete: async (input) => { seen.push(input); return JSON.stringify({ refuted: true, unrealistic: true, reason: "only the trusted operator can reach it" }); } };
    const finding = { id: "f1", title: "t", severity: "high", location: "a.sol:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.5, confirmationStatus: "confirmed-executable" };
    const result = await runRefutation({ findings: [finding], source: [], cfg: defaultConfig(), llm, logger, max: 1, systemModel: "MODEL-MARKER operator is trusted to rotate keys" });
    assert.equal(result.verdicts[0].unrealistic, true);
    assert.match(seen[0].user, /MODEL-MARKER operator is trusted to rotate keys/);
    assert.match(seen[0].system, /EFFECT NOT EXHIBITED/);

    await runRefutation({ findings: [{ ...finding }], source: [], cfg: defaultConfig(), llm, logger, max: 1 });
    assert.match(seen[1].user, /\(none available\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// MAP authors the model once; every later phase reads the same file.
class SystemModelLlmClient {
  constructor() {
    this.digReads = [];
  }

  async complete(input) {
    const action = (thought, tool, args) => JSON.stringify({ thought, tool, args });
    if (input.system.includes("doing the MAP phase")) {
      if (!input.user.includes('"path":"system_model.md"')) {
        return action("Record the shared context.", "write", { path: "system_model.md", content: "MODEL-MARKER the operator is trusted to pause; depositors are untrusted." });
      }
      if (!input.user.includes('"path":"scopes.json"')) {
        return action("Checkpoint scopes.", "write", {
          path: "scopes.json",
          content: JSON.stringify([
            { id: "S1", obligation: "first obligation", region: "region-one-marker", score: 90 },
            { id: "S2", obligation: "second obligation", region: "region-two-marker", score: 80 },
          ]),
        });
      }
      return JSON.stringify({ done: true, summary: "map complete" });
    }
    if (input.system.includes("DEEP, NARROW-SCOPE audit")) {
      const scopeId = input.user.includes("region-two-marker") ? "S2" : "S1";
      if (!input.user.includes(`"path":"${SYSTEM_MODEL_WORKSPACE_PATH}"`)) {
        return action("Read the shared system model first.", "read", { path: SYSTEM_MODEL_WORKSPACE_PATH });
      }
      if (input.user.includes("MODEL-MARKER") && !this.digReads.includes(scopeId)) this.digReads.push(scopeId);
      if (!input.user.includes('"path":"scope_outcome.json"')) {
        return action("Persist coverage.", "write", {
          path: "scope_outcome.json",
          content: JSON.stringify({ scope_id: scopeId, coverage_complete: true, obligations: [{ id: "O1", statement: "checked", status: "discharged", evidence: "checked" }], composition_edges: [], blockers: [] }),
        });
      }
      if (!input.user.includes('"path":"findings.json"')) return action("No finding.", "write", { path: "findings.json", content: "[]" });
      return JSON.stringify({ done: true, summary: "scope complete" });
    }
    return JSON.stringify({ done: true, summary: "no action" });
  }
}

for (const concurrency of [1, 2]) {
  test(`system model: MAP output is persisted and staged for every dig (dig concurrency ${concurrency})`, async () => {
    const dir = await tempDir();
    try {
      const cfg = defaultConfig();
      cfg.targetName = `system-model-e2e-${concurrency}`;
      cfg.sourcePaths = [fixtures];
      cfg.outputDir = path.join(dir, "runs");
      cfg.auditDeep = true;
      cfg.auditMaxScopes = 2;
      cfg.auditDigSamples = 1;
      cfg.auditDigMaxSamples = 1;
      cfg.auditDigConcurrency = concurrency;
      cfg.auditSynthesize = false;
      cfg.auditChallengeDischarges = false;
      cfg.auditRefute = false;
      const llm = new SystemModelLlmClient();

      await runAudit(cfg, { llm });
      assert.deepEqual([...llm.digReads].sort(), ["S1", "S2"], "each dig read the MAP-authored model from its own workspace");

      const historyDir = path.join(cfg.outputDir, "history", cfg.targetName);
      const stored = JSON.parse(await readFile(path.join(historyDir, "system_model.json"), "utf8"));
      assert.match(stored.text, /MODEL-MARKER/);
      assert.equal(stored.materialFingerprint, cfg.materialFingerprint);

      // A later run resumes from the persisted inventory (no MAP) and re-digs a
      // named scope: the model must still be staged from durable state.
      const resumed = new SystemModelLlmClient();
      cfg.auditScopeIds = ["S2"];
      await runAudit(cfg, { llm: resumed });
      assert.deepEqual(resumed.digReads, ["S2"], "a resumed dig reads the persisted model without a new MAP");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
