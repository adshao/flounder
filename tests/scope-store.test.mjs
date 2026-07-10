import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScopeInventory, saveScopeInventory } from "../dist/agent/scope-store.js";
import { scopeWorkspaceKey } from "../dist/agent/audit.js";
import { prepareSandboxWorkspace } from "../dist/security/sandbox.js";

function scope(id, status = "pending") {
  return {
    id,
    obligation: `Audit ${id}`,
    region: `src/${id}.ts`,
    lenses: ["authorization"],
    exposure: "external",
    difficulty: "medium",
    score: 5,
    why: "test inventory",
    status,
  };
}

test("scope store serializes concurrent snapshots and leaves one atomic checkpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-scope-store-"));
  try {
    const first = [scope("S1", "auditing"), scope("S2")];
    const second = [scope("S1", "audited"), scope("S2", "auditing")];
    const final = [scope("S1", "audited"), scope("S2", "audited")];
    await Promise.all([
      saveScopeInventory(dir, first),
      saveScopeInventory(dir, second),
      saveScopeInventory(dir, final),
    ]);
    assert.deepEqual(await loadScopeInventory(dir), final);
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope store distinguishes a missing inventory from a corrupt checkpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-scope-corrupt-"));
  try {
    assert.deepEqual(await loadScopeInventory(path.join(dir, "missing")), []);
    await writeFile(path.join(dir, "scopes.json"), "{not-json\n");
    await assert.rejects(loadScopeInventory(dir), /Could not load scope inventory/);
    await writeFile(path.join(dir, "scopes.json"), JSON.stringify([{ id: "S1" }]));
    await assert.rejects(loadScopeInventory(dir), /entry 0 is incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope store validates and exact-shapes persisted model output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-scope-shape-"));
  try {
    await writeFile(path.join(dir, "scopes.json"), JSON.stringify([{
      id: " S1 ",
      obligation: " Bind the value ",
      region: " src/proof.ts:1 ",
      lenses: [" authorization ", 42, ""],
      exposure: "external",
      difficulty: "medium",
      score: 7,
      status: "owned-by-model",
      source: "untrusted",
      priority: Number.NaN,
      unexpected: "must not survive",
    }]));
    const loaded = await loadScopeInventory(dir);
    assert.deepEqual(loaded, [{
      id: "S1",
      obligation: "Bind the value",
      region: "src/proof.ts:1",
      lenses: ["authorization"],
      exposure: "external",
      difficulty: "medium",
      score: 7,
      why: "",
      status: "pending",
    }]);
    await writeFile(path.join(dir, "scopes.json"), JSON.stringify([{ region: "   ", obligation: "present" }]));
    await assert.rejects(loadScopeInventory(dir), /entry 0 is incomplete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scope workspace keys remain stable for safe ids and unique after normalization", () => {
  assert.equal(scopeWorkspaceKey("S1"), "S1");
  assert.notEqual(scopeWorkspaceKey("a/b"), scopeWorkspaceKey("a_b"));
  assert.notEqual(scopeWorkspaceKey("x".repeat(60) + "a"), scopeWorkspaceKey("x".repeat(60) + "b"));
  assert.match(scopeWorkspaceKey("a/b"), /^a_b-[a-f0-9]{12}$/);
});

test("sandbox rejects a top-level source symlink before copying", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-source-symlink-"));
  try {
    const outside = path.join(dir, "outside");
    const sourceLink = path.join(dir, "source-link");
    await mkdir(outside);
    await writeFile(path.join(outside, "proof.txt"), "outside");
    await symlink(outside, sourceLink, "dir");
    await assert.rejects(
      prepareSandboxWorkspace([`${sourceLink}${path.sep}`], path.join(dir, "run"), "audit/workspace"),
      /source root must not be a symbolic link/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
