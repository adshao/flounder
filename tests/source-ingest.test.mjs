import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSource } from "../dist/ingest/source.js";

test("source ingest: paths follow the sandbox build root for external projects", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "flounder-source-root-"));
  const project = path.join(base, "sample-project");
  const scoped = path.join(project, "core", "contracts");
  await mkdir(scoped, { recursive: true });
  await writeFile(path.join(scoped, "Pool.sol"), "contract Pool {}\n");
  try {
    const docs = await loadSource([scoped], { publicRoot: project });
    assert.deepEqual(docs.map((doc) => doc.path), ["core/contracts/Pool.sol"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
