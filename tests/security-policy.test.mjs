import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommandSafety } from "../dist/security/policy.js";

test("command safety policy blocks live-network broadcast-like commands", () => {
  const decision = analyzeCommandSafety("zcash-cli -testnet sendrawtransaction poc");
  assert.equal(decision.blocked, true);
  assert.match(decision.reason, /local-only/i);
  assert.equal(decision.matchedNetwork?.toLowerCase(), "testnet");
  assert.equal(decision.matchedAction?.toLowerCase(), "sendrawtransaction");
});

test("command safety policy allows local-only reproductions", () => {
  assert.equal(analyzeCommandSafety("cargo test local_regtest_poc").blocked, false);
  assert.equal(analyzeCommandSafety("zcash-cli -regtest sendrawtransaction fixture").blocked, false);
});
