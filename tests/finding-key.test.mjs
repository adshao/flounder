import assert from "node:assert/strict";
import test from "node:test";
import { toFindingRow } from "../dist/db/record.js";

// Findings are persisted incrementally (per scope) and then re-persisted with updated statuses
// through differential / refutation / appeal. The display id (f1..fN) is renumbered at finalize, so
// the DB dedup key must be CONTENT-stable or those re-persists would orphan rows. This pins it.
test("toFindingRow: findingKey is content-stable across id renumbering", () => {
  const base = { title: "Missing proofData length check", location: "RollupProcessor.sol:120", severity: "high", confirmationStatus: "confirmed-executable", scopeId: "RP-1" };
  const k1 = toFindingRow({ ...base, id: "f1" }, "/run").findingKey;
  const k5 = toFindingRow({ ...base, id: "f5" }, "/run").findingKey; // same finding, renumbered
  assert.equal(k1, k5, "same content => same key regardless of the f-id");

  const kOtherTitle = toFindingRow({ ...base, id: "f1", title: "Different bug" }, "/run").findingKey;
  const kOtherLoc = toFindingRow({ ...base, id: "f1", location: "Verifier.sol:9" }, "/run").findingKey;
  assert.notEqual(k1, kOtherTitle, "different title => different key");
  assert.notEqual(k1, kOtherLoc, "different location => different key");

  // the rich content rides along so the DB row is self-contained (no run-dir scraping needed)
  const rich = toFindingRow({ ...base, id: "f1", description: "DESC", evidence: "EV", exploitSketch: "EXP", fix: "FIX", confidence: 0.8 }, "/run");
  assert.equal(rich.description, "DESC");
  assert.equal(rich.evidence, "EV");
  assert.equal(rich.exploitSketch, "EXP");
  assert.equal(rich.fix, "FIX");
  assert.equal(rich.confidence, 0.8);

  // status flows through; a report path is only emitted for a confirmed finding that has an id yet
  assert.equal(toFindingRow({ ...base, id: "f1" }, "/run").status, "confirmed-executable");
  assert.ok(toFindingRow({ ...base, id: "f1" }, "/run").reportPath, "confirmed + id => report path");
  assert.equal(toFindingRow({ ...base, id: undefined }, "/run").reportPath, undefined, "no id yet => no report path (avoids report_fundefined.md)");
  assert.equal(toFindingRow({ ...base, id: "f1", confirmationStatus: "suspected" }, "/run").reportPath, undefined, "suspected => no report path");
});
