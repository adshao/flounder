import assert from "node:assert/strict";
import test from "node:test";
import { consolidateByFixEquivalence, unionFindClusters } from "../dist/agent/consolidate.js";

// The fix-equivalence relation feeds unionFindClusters; the I/O part (cross-applying a
// fix and re-running a PoC) is the differential primitive, tested separately. Here we
// pin the clustering: symmetry is assumed, transitivity must hold, order is preserved.

const pairEquivalent = (pairs) => {
  const set = new Set(pairs.map(([a, b]) => (a < b ? `${a}::${b}` : `${b}::${a}`)));
  return (a, b) => set.has(a < b ? `${a}::${b}` : `${b}::${a}`);
};

test("unionFindClusters: no equivalences yields one singleton per item", () => {
  const clusters = unionFindClusters(["a", "b", "c"], () => false);
  assert.deepEqual(clusters, [["a"], ["b"], ["c"]]);
});

test("unionFindClusters: a single equivalent pair merges just those two", () => {
  const clusters = unionFindClusters(["a", "b", "c"], pairEquivalent([["a", "b"]]));
  assert.deepEqual(clusters, [["a", "b"], ["c"]]);
});

test("unionFindClusters: equivalence is transitively closed (a~b, b~c => one cluster)", () => {
  const clusters = unionFindClusters(["a", "b", "c"], pairEquivalent([["a", "b"], ["b", "c"]]));
  assert.deepEqual(clusters, [["a", "b", "c"]]);
});

test("unionFindClusters: independent pairs form separate clusters, first-appearance order preserved", () => {
  const clusters = unionFindClusters(["a", "b", "c", "d"], pairEquivalent([["a", "c"], ["b", "d"]]));
  assert.deepEqual(clusters, [["a", "c"], ["b", "d"]]);
});

test("fix equivalence is unbounded by default and skips only under an explicit item cap", async () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ id: String(index) }));
  const events = [];
  const logger = { event: async (kind, detail) => events.push({ kind, detail }) };
  const shared = {
    items,
    workspace: {},
    baselineFiles: new Set(),
    cfg: {},
    logger,
  };

  const unbounded = await consolidateByFixEquivalence(shared);
  assert.equal(unbounded.skipped, undefined);
  assert.deepEqual(unbounded.clusters, items.map((item) => [item.id]));
  assert.equal(events.at(-1).kind, "audit_confirm_equiv");

  const bounded = await consolidateByFixEquivalence({ ...shared, maxItems: 8 });
  assert.equal(bounded.skipped, true);
  assert.deepEqual(bounded.clusters, items.map((item) => [item.id]));
  assert.equal(events.at(-1).kind, "audit_confirm_equiv_skipped");
});
