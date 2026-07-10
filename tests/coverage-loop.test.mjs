import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unionMapSamples } from "../dist/agent/audit.js";
import { buildRunHealth } from "../dist/agent/discovery-artifacts.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { loadScopeInventory, saveScopeInventory } from "../dist/agent/scope-store.js";
import {
  appendScopeOutcomes,
  incompleteScopeOutcome,
  loadScopeOutcomes,
  nextScopeOutcomeSample,
  readScratchScopeOutcome,
  scopeOutcomeNeedsAnotherSample,
} from "../dist/agent/scope-outcomes.js";
import { newSession } from "../dist/agent/tools.js";

const scope = (id, region, obligation, score = 1) => ({ id, region, obligation, score, status: "pending" });

test("scope inventory is reused only for the exact prepared-material fingerprint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-scope-version-"));
  await saveScopeInventory(dir, [
    { ...scope("S1", "src/a.ts", "caller is authorized", 8), materialFingerprint: "material-a" },
  ]);
  assert.equal((await loadScopeInventory(dir, "material-a")).length, 1);
  assert.deepEqual(await loadScopeInventory(dir, "material-b"), []);
  assert.deepEqual(await loadScopeInventory(dir, ""), await loadScopeInventory(dir));
});

test("project memory recalls exact-material notes plus explicitly portable learning", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-memory-version-"));
  const memory = new ProjectMemory(path.join(dir, "memory.jsonl"));
  const exact = await memory.remember({ note: "binding trace ended at the signed payload", kind: "insight", materialFingerprint: "material-a" });
  const duplicate = await memory.remember({ note: "binding trace ended at the signed payload", kind: "insight", materialFingerprint: "material-a" });
  await memory.remember({ note: "obsolete function-specific observation", kind: "dead-end", materialFingerprint: "material-b" });
  await memory.remember({ note: "generalize attacker capability before constructing a PoC", kind: "insight", materialFingerprint: "material-b", portable: true });
  assert.equal(duplicate.id, exact.id, "exact duplicate notes must not grow memory unboundedly");
  const recalled = await memory.recall("binding attacker payload PoC", 10, { materialFingerprint: "material-a", includePortable: true });
  assert.deepEqual(recalled.map((note) => note.note).sort(), [
    "binding trace ended at the signed payload",
    "generalize attacker capability before constructing a PoC",
  ]);
  assert.equal((await memory.all()).length, 3);
});

test("concurrent memory writers serialize duplicate detection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-memory-concurrent-"));
  const memory = new ProjectMemory(path.join(dir, "memory.jsonl"));
  const records = await Promise.all(Array.from({ length: 8 }, () => memory.remember({
    note: "same generalized lesson",
    kind: "insight",
    materialFingerprint: "material-a",
  })));
  assert.equal(new Set(records.map((record) => record.id)).size, 1);
  assert.equal((await memory.all()).length, 1);
});

test("scope outcome separates coverage evidence from findings and fails closed on blockers", () => {
  const session = newSession();
  session.scratchFiles.set("dig-S1/scope_outcome.json", JSON.stringify({
    scope_id: "S1",
    coverage_complete: true,
    obligations: [
      { id: "O1", statement: "admin input is bound to the signed request", status: "discharged", location: "src/a.ts:20", evidence: "checked signature payload fields" },
      { id: "O2", statement: "downstream sink preserves the same principal", status: "uncertain", location: "src/b.ts:9" },
    ],
    composition_edges: [{ id: "E1", kind: "binding", description: "request principal to storage owner", status: "unresolved", from: "request", to: "storage" }],
    blockers: [],
  }));
  const parsed = readScratchScopeOutcome(session, { scopeId: "S1", sample: 1, materialFingerprint: "material-a" });
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.outcome.coverageComplete, true);
  assert.equal(parsed.outcome.obligations[1].status, "uncertain");
  assert.equal(scopeOutcomeNeedsAnotherSample([parsed.outcome]), true);

  session.scratchFiles.set("scope_outcome.json", JSON.stringify({
    scope_id: "S1",
    coverage_complete: true,
    obligations: [{ statement: "build-dependent invariant", status: "blocked" }],
    blockers: ["dependency registry unavailable"],
  }));
  const blocked = readScratchScopeOutcome(session, { scopeId: "S1", sample: 2 });
  assert.equal(blocked.outcome.coverageComplete, false);
  assert.match(blocked.errors.join(" "), /cannot be true while blockers remain/);
  assert.equal(scopeOutcomeNeedsAnotherSample([blocked.outcome]), false, "sampling cannot repair an external resource blocker");
});

test("invalid composition status cannot be normalized into observed evidence", () => {
  const session = newSession();
  session.scratchFiles.set("scope_outcome.json", JSON.stringify({
    scope_id: "S1",
    coverage_complete: true,
    obligations: [{ statement: "principal is bound", status: "discharged" }],
    composition_edges: [{ kind: "binding", description: "principal to sink", status: "probably" }],
    blockers: [],
  }));
  const parsed = readScratchScopeOutcome(session, { scopeId: "S1", sample: 1 });
  assert.equal(parsed.outcome.coverageComplete, false);
  assert.equal(parsed.outcome.compositionEdges.length, 0);
  assert.match(parsed.errors.join(" "), /status must be observed or unresolved/);
});

test("corrupt persisted scope outcomes fail visibly instead of entering synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-outcomes-corrupt-"));
  await writeFile(path.join(dir, "scope_outcomes.json"), JSON.stringify([{ scopeId: "S1", sample: 1, coverageComplete: true }]), "utf8");
  await assert.rejects(() => loadScopeOutcomes(dir), /Invalid scope outcomes entry 0/);
});

test("concurrent scope outcome checkpoints merge atomically without dropping samples", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-outcomes-"));
  await Promise.all([
    appendScopeOutcomes(dir, [incompleteScopeOutcome("S1", 1, "first", "material-a")]),
    appendScopeOutcomes(dir, [incompleteScopeOutcome("S2", 1, "second", "material-a")]),
    appendScopeOutcomes(dir, [incompleteScopeOutcome("S1", 2, "third", "material-a")]),
  ]);
  const outcomes = await loadScopeOutcomes(dir, "material-a");
  assert.deepEqual(outcomes.map((outcome) => `${outcome.scopeId}:${outcome.sample}`), ["S1:1", "S1:2", "S2:1"]);
  assert.doesNotMatch(await readFile(path.join(dir, "scope_outcomes.json"), "utf8"), /\.tmp/);
});

test("latest resolved scope sample clears an earlier incomplete sample", () => {
  const first = incompleteScopeOutcome("S1", 1, "model stopped early", "material-a");
  const resolved = {
    scopeId: "S1",
    sample: 2,
    materialFingerprint: "material-a",
    coverageComplete: true,
    obligations: [{ id: "O1", statement: "principal is bound", status: "discharged", evidence: "checked line 10" }],
    compositionEdges: [],
    blockers: [],
  };
  const health = buildRunHealth({
    stoppedReason: "finished",
    steps: [{ tool: "read" }, { tool: "read" }, { tool: "write" }, { tool: "write" }],
    commandRuns: [],
    scopes: [{ ...scope("S1", "src/a.ts", "principal is bound"), status: "audited" }],
    confirmed: [],
    hypotheses: [],
    coverageGaps: [],
    resourceRequests: [],
    followupScopes: [],
    scopeOutcomes: [first, resolved],
    mode: "map-dig",
  });
  assert.equal(health.signals.scopeOutcomes, 1);
  assert.equal(health.signals.scopeOutcomesIncomplete, 0);
});

test("scope outcome sample numbers continue monotonically across resumed runs", () => {
  const prior = [
    incompleteScopeOutcome("S1", 1, "first", "material-a"),
    incompleteScopeOutcome("S1", 3, "third", "material-a"),
    incompleteScopeOutcome("S2", 8, "other scope", "material-a"),
  ];
  assert.equal(nextScopeOutcomeSample(prior, "S1"), 4);
  assert.equal(nextScopeOutcomeSample(prior, "S2"), 9);
  assert.equal(nextScopeOutcomeSample(prior, "S3"), 1);
});

test("map ensemble unions complementary scopes and records agreement without dropping singletons", () => {
  const union = unionMapSamples([
    [scope("S1", "src/a.ts", "caller is authorized", 7), scope("S2", "src/b.ts", "amount is conserved", 4)],
    [scope("S9", "src/a.ts", "caller is authorized", 9), scope("S2", "src/c.ts", "upgrade target is bound", 8)],
  ]);
  assert.equal(union.length, 3);
  const agreed = union.find((item) => item.region === "src/a.ts");
  assert.deepEqual(agreed.mapSamples, [1, 2]);
  assert.equal(agreed.mapAgreement, 2);
  assert.equal(agreed.score, 9);
  assert.ok(union.some((item) => item.region === "src/b.ts" && item.mapAgreement === 1));
  assert.ok(union.some((item) => item.region === "src/c.ts" && item.mapAgreement === 1));
});
