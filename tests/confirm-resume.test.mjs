import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSettledFromPriorConfirm } from "../dist/agent/confirm.js";
import { publicPath } from "../dist/util/paths.js";

// `fsa confirm` auto-resumes a prior interrupted confirm of the same input run: it finds
// the latest prior confirm dir (matched by frozen provenance) and carries its SETTLED rows
// (reproduced yes/no) forward. This pins that detection.

async function mkConfirmRun(outDir, name, inputRunDir, rows) {
  const dir = path.join(outDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "confirm_provenance.json"), JSON.stringify({ inputRunDir: publicPath(inputRunDir), frozenFiles: [] }));
  if (rows) await writeFile(path.join(dir, "confirm_decision.json"), JSON.stringify(rows));
  return dir;
}

test("confirm resume: loads SETTLED rows from the latest prior confirm of the same input", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-confirm-resume-"));
  const inputX = "/some/input-run-X";
  const inputY = "/some/input-run-Y";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [
    { bug: "Bug A", reproduced: "yes" },
    { bug: "Bug B", reproduced: "could-not-set-up" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260102T000000Z", inputX, [
    { bug: "Bug A", reproduced: "yes" },
    { bug: "Bug B", reproduced: "no" },
  ]);
  await mkConfirmRun(out, "tgt-confirm-20260103T000000Z", inputY, [{ bug: "Bug Z", reproduced: "yes" }]); // different input → ignored

  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-20260104T000000Z"));
  assert.deepEqual(settled.map((r) => r.bug).sort(), ["Bug A", "Bug B"]); // both settled, from the LATEST matching run
  assert.equal(settled.every((r) => r.reproduced === "yes" || r.reproduced === "no"), true);
});

test("confirm resume: no prior confirm → empty (fresh start)", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-confirm-resume-none-"));
  assert.deepEqual(await loadSettledFromPriorConfirm(out, "tgt", "/some/input", path.join(out, "tgt-confirm-X")), []);
});

test("confirm resume: skips a latest run with no decision sheet (killed before first checkpoint), falls back to an older one", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-confirm-resume-fallback-"));
  const inputX = "/some/input-run-X";
  await mkConfirmRun(out, "tgt-confirm-20260101T000000Z", inputX, [{ bug: "Bug A", reproduced: "yes" }]);
  await mkConfirmRun(out, "tgt-confirm-20260102T000000Z", inputX, null); // no decision yet
  const settled = await loadSettledFromPriorConfirm(out, "tgt", inputX, path.join(out, "tgt-confirm-cur"));
  assert.deepEqual(settled.map((r) => r.bug), ["Bug A"]);
});
