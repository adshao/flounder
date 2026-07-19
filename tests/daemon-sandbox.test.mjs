import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonVisibleSandboxReadiness, drainPipelineConfirmWork, initializeDaemonProcessEnvironment, resolvePipelineMaterials } from "../dist/server/daemon.js";
import { DEFAULT_SANDBOX_IMAGE } from "../dist/security/sandbox.js";

test("daemon: missing default sandbox image is an auto-recoverable capability", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "auto",
    image: DEFAULT_SANDBOX_IMAGE,
    allowHostFallback: false,
    message: "No sandbox backend is available.",
  });

  assert.equal(visible.ok, true);
  assert.equal(visible.autoBuild, true);
  assert.match(visible.message ?? "", /built automatically/);
});

test("daemon: missing custom sandbox image remains operator-visible", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "auto",
    image: "custom-audit-image:latest",
    allowHostFallback: false,
    message: "No sandbox backend is available.",
  });

  assert.equal(visible.ok, false);
  assert.equal(visible.autoBuild, undefined);
});

test("daemon: missing Apple container image does not trigger Docker auto-build", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "apple-container",
    image: DEFAULT_SANDBOX_IMAGE,
    allowHostFallback: false,
    message: "Apple container sandbox image is not available.",
  });

  assert.equal(visible.ok, false);
  assert.equal(visible.autoBuild, undefined);
  assert.match(visible.message ?? "", /Apple container/);
});

test("daemon: startup restores common container runtime paths", () => {
  const env = { PATH: "/usr/bin:/bin" };
  initializeDaemonProcessEnvironment(env);

  const parts = env.PATH.split(path.delimiter);
  assert.ok(parts.includes("/usr/local/bin"));
  assert.ok(parts.includes("/opt/homebrew/bin"));
});

test("daemon: pipeline resolves project materials before dropping the daemon workspace dir", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "flounder-pipeline-workspace-"));
  const project = path.join(workspace, "contests", "sample-project");
  await mkdir(path.join(project, "core", "contracts"), { recursive: true });
  await mkdir(path.join(project, "docs"), { recursive: true });
  try {
    const materials = resolvePipelineMaterials({
      verb: "run",
      target: "sample-project",
      dir: "contests/sample-project",
      sourcePaths: ["core/contracts"],
      buildRoot: ".",
      corpusPaths: ["README.md", "docs"],
      pipeline: true,
    }, path.join(workspace, "out"), workspace);

    assert.deepEqual(materials.sourcePaths, [path.join(project, "core", "contracts")]);
    assert.equal(materials.buildRoot, project);
    assert.deepEqual(materials.corpusPaths, [path.join(project, "README.md"), path.join(project, "docs")]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("daemon: pipeline confirm drains readiness work until the worklist stops changing", async () => {
  const work = (keys) => ({
    verifyFindings: [],
    inputRunDir: keys.length > 0 ? "/tmp/run-a" : undefined,
    inputRunDirs: keys.length > 0 ? ["/tmp/run-a"] : [],
    confirmKeys: keys,
    reportFindings: [],
  });
  const worklists = [
    work(["finding-a", "finding-b"]),
    work(["finding-b"]),
    work(["finding-b"]),
  ];
  const ran = [];
  let index = 0;

  const runs = await drainPipelineConfirmWork(
    async () => worklists[Math.min(index, worklists.length - 1)],
    async (current) => {
      ran.push(current.confirmKeys);
      index += 1;
    },
  );

  assert.equal(runs, 2);
  assert.deepEqual(ran, [["finding-a", "finding-b"], ["finding-b"]]);
});
