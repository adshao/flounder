import assert from "node:assert/strict";
import test from "node:test";
import { normalizePrepareMatchStatus } from "../dist/prepare-match.js";

test("prepare match normalization distinguishes exact verification from similar or partial matches", () => {
  for (const value of ["exact", "Exact Match", "verified_exact", "verified_full_sourcify", "matched"]) {
    assert.equal(normalizePrepareMatchStatus(value), "matched", value);
  }
  for (const value of ["verified_similar", "similar_match", "partial", "unverified", "not_verified", "no_match", "mismatch"]) {
    assert.equal(normalizePrepareMatchStatus(value), "unverified", value);
  }
  assert.equal(normalizePrepareMatchStatus("n/a"), "n/a");
  assert.equal(normalizePrepareMatchStatus("verified"), "verified", "a generic verified label does not establish exact source equivalence");
});
