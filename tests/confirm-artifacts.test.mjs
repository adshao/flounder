import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncConfirmWorkspaceArtifacts } from "../dist/agent/confirm-artifacts.js";

test("Confirm uses decisions and impact inventory produced by sandbox commands", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-artifacts-"));
  const scratch = new Map([["confirm_decision.json", JSON.stringify([{ bug: "old row" }])]]);
  const decisions = { decisions: [{ bug: "first row" }, { bug: "second row" }] };
  const impact = { deployment: "local fork", observed: true };
  await writeFile(path.join(workspace, "confirm_decision.json"), JSON.stringify(decisions));
  await writeFile(path.join(workspace, "impact_inventory.json"), JSON.stringify(impact));

  await syncConfirmWorkspaceArtifacts(workspace, scratch);
  assert.deepEqual(JSON.parse(scratch.get("confirm_decision.json")), decisions);
  assert.deepEqual(JSON.parse(scratch.get("impact_inventory.json")), impact);
});

test("incomplete or linked workspace artifacts cannot replace valid Confirm checkpoints", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-artifacts-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "flounder-confirm-artifacts-outside-"));
  const original = JSON.stringify([{ bug: "retained row" }]);
  const scratch = new Map([["confirm_decision.json", original]]);
  await writeFile(path.join(workspace, "confirm_decision.json"), "[{");
  await writeFile(path.join(outside, "impact_inventory.json"), JSON.stringify({ leaked: true }));
  await symlink(path.join(outside, "impact_inventory.json"), path.join(workspace, "impact_inventory.json"));

  await syncConfirmWorkspaceArtifacts(workspace, scratch);
  assert.equal(scratch.get("confirm_decision.json"), original);
  assert.equal(scratch.has("impact_inventory.json"), false);
});
