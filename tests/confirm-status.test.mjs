import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MetadataStore } from "../dist/db/store.js";
import { findingContentKey } from "../dist/util/finding-key.js";

// Confirm is finding-grained + resumable: pendingConfirmable lists audit-confirmed findings with no
// real-target decision yet; a confirm_decision whose members are finding content keys flips those
// findings' confirm_status; and a later pendingConfirmable skips the decided ones.
test("pendingConfirmable + decision -> confirm_status (finding-grained, resumable)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fl-confirm-"));
  const store = new MetadataStore(path.join(dir, "t.db"));
  const pid = store.upsertProject({ name: "p", sourcePaths: ["/x"], config: {} });
  const runId = store.startRun({ projectId: pid, kind: "run", runDir: "/runs/r1" });

  const keyA = findingContentKey("S1", "Vault.sol:10", "Bug A");
  const keyB = findingContentKey("S2", "Vault.sol:20", "Bug B");
  store.upsertFindings(pid, runId, [
    { findingKey: keyA, title: "Bug A", location: "Vault.sol:10", severity: "high", status: "confirmed-differential", scopeId: "S1" },
    { findingKey: keyB, title: "Bug B", location: "Vault.sol:20", severity: "medium", status: "confirmed-executable", scopeId: "S2" },
    { findingKey: findingContentKey("S3", "x", "C"), title: "C", location: "x", status: "suspected", scopeId: "S3" }, // not confirmable
  ]);

  let pending = store.pendingConfirmable(pid);
  assert.deepEqual(pending.map((p) => p.finding_key).sort(), [keyA, keyB].sort(), "both confirmed findings are pending; suspected is excluded");
  assert.equal(pending[0].run_dir, "/runs/r1", "pending carries the source run dir");

  // a confirm settles A=reproduced, B=not — members are the content keys
  store.upsertConfirmDecisions(pid, runId, [
    { bug: "Bug A", reproduced: "yes", members: [keyA] },
    { bug: "Bug B", reproduced: "no", members: [keyB] },
  ]);

  const byKey = Object.fromEntries(store.listFindings(pid).map((f) => [f.finding_key, f.confirm_status]));
  assert.equal(byKey[keyA], "reproduced");
  assert.equal(byKey[keyB], "not-reproduced");

  pending = store.pendingConfirmable(pid);
  assert.equal(pending.length, 0, "resume: both decided, nothing left pending");
  store.close();
});
