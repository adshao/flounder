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
  const dbPath = path.join(dir, "t.db");
  const store = new MetadataStore(dbPath);
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

  // a confirm settles A=reproduced, B=not. Models sometimes include the title next to the
  // content key, so the store accepts both exact keys and "key title" members.
  store.upsertConfirmDecisions(pid, runId, [
    { bug: "Bug A", reproduced: "yes", members: [`${keyA} Bug A`] },
    { bug: "Bug B", reproduced: "no", members: [`[${keyB}] Bug B`] },
  ]);

  const byKey = Object.fromEntries(store.listFindings(pid).map((f) => [f.finding_key, f.confirm_status]));
  assert.equal(byKey[keyA], "reproduced");
  assert.equal(byKey[keyB], "not-reproduced");

  pending = store.pendingConfirmable(pid);
  assert.equal(pending.length, 0, "resume: both decided, nothing left pending");

  store.db.prepare("UPDATE finding SET confirm_status = NULL").run();
  store.close();

  const reopened = new MetadataStore(dbPath);
  const repaired = Object.fromEntries(reopened.listFindings(pid).map((f) => [f.finding_key, f.confirm_status]));
  assert.equal(repaired[keyA], "reproduced", "opening an older DB backfills exact or noisy confirm members");
  assert.equal(repaired[keyB], "not-reproduced");
  reopened.close();
});

test("getConfirmable is project-scoped and only returns pending audit-confirmed findings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fl-confirm-one-"));
  const store = new MetadataStore(path.join(dir, "t.db"));
  const pid = store.upsertProject({ name: "p" });
  const otherPid = store.upsertProject({ name: "other" });
  const runId = store.startRun({ projectId: pid, kind: "run", runDir: "/runs/p-1" });
  const otherRunId = store.startRun({ projectId: otherPid, kind: "run", runDir: "/runs/o-1" });

  const confirmedKey = findingContentKey("S1", "x:1", "confirmed");
  const suspectedKey = findingContentKey("S2", "x:2", "suspected");
  const settledKey = findingContentKey("S3", "x:3", "settled");
  store.upsertFindings(pid, runId, [
    { findingKey: confirmedKey, title: "confirmed", location: "x:1", status: "confirmed-executable", scopeId: "S1" },
    { findingKey: suspectedKey, title: "suspected", location: "x:2", status: "suspected", scopeId: "S2" },
    { findingKey: settledKey, title: "settled", location: "x:3", status: "confirmed-differential", scopeId: "S3" },
  ]);
  store.upsertFindings(otherPid, otherRunId, [{ findingKey: "other", title: "other", location: "o:1", status: "confirmed-executable" }]);
  store.setFindingConfirmStatus(pid, settledKey, "reproduced");

  const rows = Object.fromEntries(store.listFindings(pid).map((f) => [f.finding_key, f.id]));
  const other = store.listFindings(otherPid)[0];

  assert.equal(store.getConfirmable(pid, Number(rows[confirmedKey]))?.finding_key, confirmedKey);
  assert.equal(store.getConfirmable(pid, Number(rows[suspectedKey])), undefined);
  assert.equal(store.getConfirmable(pid, Number(rows[settledKey])), undefined);
  assert.equal(store.getConfirmable(pid, Number(other.id)), undefined, "finding ids are scoped to the project");
  store.close();
});
