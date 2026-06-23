import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MetadataStore } from "../dist/db/store.js";
import { findingContentKey } from "../dist/util/finding-key.js";

// Findings are now self-contained in the DB: the kernel's rich content (description / evidence /
// exploit sketch / fix / confidence) is persisted alongside the metadata, so the UI shows full
// detail and the verify/confirm pipeline feeds on findings without scraping run-dir artifacts.
// The catch: a finding is re-persisted as its status flips (differential / refutation / appeal /
// verify), and a status-only re-persist can carry empty content — which must NOT wipe the stored
// detail. This pins both the round-trip and the keep-on-empty rule.
test("upsertFindings persists rich content + a status-only re-persist keeps it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fl-detail-"));
  const store = new MetadataStore(path.join(dir, "t.db"));
  const pid = store.upsertProject({ name: "p", sourcePaths: ["/x"], config: {} });
  const runId = store.startRun({ projectId: pid, kind: "run", runDir: "/r" });
  const key = findingContentKey("S", "Vault.sol:10", "Reentrancy");

  store.upsertFindings(pid, runId, [{
    findingKey: key, title: "Reentrancy", location: "Vault.sol:10", severity: "high", status: "suspected", scopeId: "S",
    description: "withdraw() calls before zeroing the balance", evidence: "PoC trace: drained 10 ETH", exploitSketch: "1. deposit 2. reenter", fix: "checks-effects-interactions", confidence: 0.7,
  }]);

  let f = store.listFindings(pid)[0];
  assert.equal(f.description, "withdraw() calls before zeroing the balance");
  assert.equal(f.evidence, "PoC trace: drained 10 ETH");
  assert.equal(f.exploit_sketch, "1. deposit 2. reenter", "stored under the snake_case column");
  assert.equal(f.fix, "checks-effects-interactions");
  assert.equal(f.confidence, 0.7);

  // a later re-persist that only flips the status (empty content, confidence omitted) must keep detail
  store.upsertFindings(pid, runId, [{
    findingKey: key, title: "Reentrancy", location: "Vault.sol:10", severity: "high", status: "confirmed-executable", scopeId: "S",
    description: "", evidence: "", exploitSketch: "", fix: "", confidence: undefined,
  }]);
  f = store.listFindings(pid)[0];
  assert.equal(f.status, "confirmed-executable", "status advanced");
  assert.equal(f.description, "withdraw() calls before zeroing the balance", "description kept");
  assert.equal(f.exploit_sketch, "1. deposit 2. reenter", "exploit sketch kept");
  assert.equal(f.confidence, 0.7, "confidence kept when re-persist omits it");

  // but a re-persist WITH new content overwrites (e.g. verify's confirm-or-refute writeup)
  store.upsertFindings(pid, runId, [{
    findingKey: key, title: "Reentrancy", location: "Vault.sol:10", severity: "high", status: "confirmed-differential", scopeId: "S",
    description: "verify: fails-after-fix confirmed", confidence: 0.95,
  }]);
  f = store.listFindings(pid)[0];
  assert.equal(f.description, "verify: fails-after-fix confirmed", "non-empty re-persist overwrites");
  assert.equal(f.confidence, 0.95);
  store.close();
});

// VERIFY maps back: a verdict carrying originId UPDATES the original suspected row in place (across
// runs) — flipping its status + attaching the PoC — instead of inserting a duplicate. The identity
// is carried, so even though the verify session renamed the title, the right row is updated.
test("upsertFindings with originId flips the ORIGINAL finding in place — no duplicate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fl-origin-"));
  const store = new MetadataStore(path.join(dir, "t.db"));
  const pid = store.upsertProject({ name: "p", sourcePaths: ["/x"], config: {} });

  // an audit run finds it as suspected
  const auditRun = store.startRun({ projectId: pid, kind: "audit", runDir: "/runs/audit" });
  const key = findingContentKey("ESC-1", "RollupProcessor.sol:523", "Escape hatch root not bound");
  store.upsertFindings(pid, auditRun, [{ findingKey: key, title: "Escape hatch root not bound", location: "RollupProcessor.sol:523", severity: "critical", status: "suspected", scopeId: "ESC-1", description: "the proof root is not checked against the on-chain root" }]);
  const orig = store.listFindings(pid).find((x) => x.finding_key === key);
  assert.equal(orig.status, "suspected");

  // a later VERIFY run resolves it — note the renamed title + different key, but originId carries identity
  const verifyRun = store.startRun({ projectId: pid, kind: "audit", runDir: "/runs/verify" });
  store.upsertFindings(pid, verifyRun, [{
    findingKey: findingContentKey("ESC-1", "RollupProcessor.sol:523-529,611", "CONFIRMED: Escape hatch root not bound"),
    title: "CONFIRMED: Escape hatch root not bound", location: "RollupProcessor.sol:523-529,611", severity: "critical",
    status: "confirmed-differential", scopeId: "ESC-1", evidence: "PoC fails-after-fix", confidence: 0.93, originId: orig.id,
  }]);

  const all = store.listFindings(pid);
  assert.equal(all.length, 1, "the verdict updated the original — NOT a new duplicate row");
  const flipped = all[0];
  assert.equal(flipped.id, orig.id, "same row id");
  assert.equal(flipped.status, "confirmed-differential", "status flipped by the verdict");
  assert.equal(flipped.title, "Escape hatch root not bound", "original title/identity preserved (not the verify rename)");
  assert.equal(flipped.evidence, "PoC fails-after-fix", "verify PoC attached");
  assert.equal(flipped.description, "the proof root is not checked against the on-chain root", "original description kept");
  assert.equal(flipped.confidence, 0.93);
  const tl = store.findingTimeline(orig.id);
  assert.ok(tl.some((e) => e.to_status === "confirmed-differential"), "the flip is on the status timeline");

  // a stale originId (row deleted) must not lose the verdict — it falls back to a normal insert
  store.upsertFindings(pid, verifyRun, [{ findingKey: "korphan", title: "orphan verdict", location: "X", severity: "low", status: "refuted", scopeId: "Z", originId: 99999 }]);
  assert.equal(store.listFindings(pid).length, 2, "stale-origin verdict still captured as its own row");
  store.close();
});
