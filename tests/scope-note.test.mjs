import assert from "node:assert/strict";
import test from "node:test";
import { deriveScopeNote, isInScope } from "../dist/scope-note.js";

// A prepare manifest shaped like a real Aztec-style acquisition: deployed first-party contracts
// in scope, a vendored library out of scope, an off-chain circuit as a trust boundary.
const aztecManifest = {
  scope_declaration: "audited addresses 0x7379…/0x48cb… per the project's Immunefi asset list",
  components: [
    { role: "target", identity: "RollupProcessor (0x7379…)", platform: "ethereum", staged_path: "contracts/RollupProcessor.sol", in_scope: true, match: "matched" },
    { role: "verifier", identity: "TurboVerifier (0x48cb…)", platform: "ethereum", staged_path: "contracts/verifier/TurboVerifier.sol", in_scope: true, match: "matched" },
    { role: "dependency", identity: "OpenZeppelin ERC20", platform: "none", staged_path: "lib/openzeppelin", in_scope: false },
    { role: "verifier", identity: "Plonk circuit", platform: "none", staged_path: "circuits/", in_scope: false, match: "n/a" },
  ],
};

test("deriveScopeNote: in-scope target is focused; deps are named as trust boundaries", () => {
  const note = deriveScopeNote(aztecManifest);
  assert.ok(note, "a manifest with in-scope components yields a note");
  // the two deployment-matched contracts are the PRIMARY TARGET, with their staged paths
  const primary = note.slice(note.indexOf("PRIMARY AUDIT TARGET"), note.indexOf("DEPENDENCIES"));
  assert.match(primary, /RollupProcessor \(0x7379…\) — contracts\/RollupProcessor\.sol/);
  assert.match(primary, /TurboVerifier \(0x48cb…\) — contracts\/verifier\/TurboVerifier\.sol/);
  assert.doesNotMatch(primary, /OpenZeppelin|Plonk/); // deps are not in the primary section
  // the library + off-chain circuit are named as boundaries, not the target
  const boundaries = note.slice(note.indexOf("DEPENDENCIES"));
  assert.match(boundaries, /OpenZeppelin ERC20 — lib\/openzeppelin/);
  assert.match(boundaries, /Plonk circuit — circuits\//);
  // the factual basis is carried, and the note is framed as NOT a bug hint
  assert.match(note, /Immunefi asset list/);
  assert.match(note, /NOT a hint about any specific bug/);
});

test("deriveScopeNote: falls back to role/platform when `in_scope` is absent (older manifests)", () => {
  // No explicit in_scope — classification must still work from the facts prepare already records.
  const legacy = {
    components: [
      { role: "target", identity: "Vault", platform: "ethereum", staged_path: "src/Vault.sol" },
      { role: "dependency", identity: "solmate", platform: "none", staged_path: "lib/solmate" },
      { role: "other", identity: "OnchainOracle", platform: "ethereum", staged_path: "src/Oracle.sol" }, // deployed → in scope
      { role: "other", identity: "OffchainKeeper", platform: "none", staged_path: "bots/" }, // not deployed → boundary
    ],
  };
  assert.equal(isInScope(legacy.components[0]), true); // role target
  assert.equal(isInScope(legacy.components[1]), false); // role dependency
  assert.equal(isInScope(legacy.components[2]), true); // deployed other
  assert.equal(isInScope(legacy.components[3]), false); // off-deployment other
  const note = deriveScopeNote(legacy);
  assert.match(note, /Vault — src\/Vault\.sol/);
  assert.match(note, /OnchainOracle — src\/Oracle\.sol/);
  assert.match(note.slice(note.indexOf("DEPENDENCIES")), /solmate/);
});

test("deriveScopeNote: labels current prepare components without placeholder question marks", () => {
  const current = {
    components: [
      { id: "rollup", name: "Rollup", path: "source/l1-contracts/src/Rollup.sol", in_scope: true },
      { path: "source/aztec-packages", in_scope: true },
      { identity: "?", role: "?", staged_path: "docs/specs", in_scope: false },
      { in_scope: true },
    ],
  };
  const note = deriveScopeNote(current);
  assert.match(note, /Rollup — source\/l1-contracts\/src\/Rollup\.sol/);
  assert.match(note, /- source\/aztec-packages/);
  assert.match(note, /- docs\/specs/);
  assert.doesNotMatch(note, /- \?/);
});

test("deriveScopeNote: explicit in_scope overrides the role/platform heuristic", () => {
  // A deployed component the project explicitly excludes from scope must come out as a boundary.
  const c = { role: "target", identity: "OutOfScopeButDeployed", platform: "ethereum", in_scope: false };
  assert.equal(isInScope(c), false);
});

test("deriveScopeNote: no in-scope component → undefined (never fabricate a focus)", () => {
  // All dependencies: returning undefined means map keeps its prior 'treat all source as in scope'
  // behavior rather than us inventing a target — the anti-overfitting guard.
  const depsOnly = { components: [{ role: "dependency", identity: "lodash", platform: "none" }] };
  assert.equal(deriveScopeNote(depsOnly), undefined);
  assert.equal(deriveScopeNote({ components: [] }), undefined);
  assert.equal(deriveScopeNote(null), undefined);
  assert.equal(deriveScopeNote("not an object"), undefined);
});
