import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, sandboxExecutionOptions, sandboxNetworkForPurpose } from "../dist/config.js";
import { checkSandboxReadiness, runSandboxCommand, sandboxToolPath } from "../dist/security/sandbox.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("sandbox execution options keep sealed runs offline except build warm-up", () => {
  const cfg = defaultConfig();
  cfg.prepareMode = false;
  cfg.confirmMode = false;
  cfg.sandboxPrepareNetwork = "enabled";
  cfg.sandboxConfirmNetwork = "enabled";
  cfg.sandboxBackend = "oci";
  cfg.sandboxImage = "custom-sandbox:latest";
  cfg.sandboxMemoryMb = 512;
  cfg.sandboxCpus = 2;

  assert.equal(sandboxNetworkForPurpose(cfg, "inspect"), "none");
  assert.equal(sandboxNetworkForPurpose(cfg, "confirm"), "none");
  assert.equal(sandboxNetworkForPurpose(cfg, "build"), "enabled");
  assert.deepEqual(sandboxExecutionOptions(cfg, "none"), {
    backend: "oci",
    image: "custom-sandbox:latest",
    allowHostFallback: false,
    network: "none",
    memoryMb: 512,
    cpus: 2,
  });

  cfg.confirmMode = true;
  assert.equal(sandboxNetworkForPurpose(cfg, "inspect"), "enabled");
  assert.equal(sandboxNetworkForPurpose(cfg, "confirm"), "enabled");
});

test("sandbox refuses implicit host fallback when the OCI image is unavailable", async () => {
  const workspace = await tempDir("flounder-sandbox-no-fallback-");
  try {
    const image = `flounder-test-missing-${Date.now()}:latest`;
    const result = await runSandboxCommand(
      { program: process.execPath, args: ["-e", "console.log('host-ran')"], timeoutMs: 10_000 },
      workspace,
      4000,
      [],
      undefined,
      { backend: "auto", image, allowHostFallback: false, network: "none" },
    );

    assert.equal(result.exitCode, 126);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /host-ran/);
    assert.match(result.stderr, /host execution fallback is disabled|OCI sandbox image/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox readiness reports missing OCI image before agent commands run", async () => {
  const image = `flounder-test-missing-${Date.now()}-${Math.random().toString(16).slice(2)}:latest`;
  const readiness = await checkSandboxReadiness({ backend: "auto", image, allowHostFallback: false, network: "none" });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.backend, "auto");
  assert.equal(readiness.image, image);
  assert.match(readiness.message ?? "", /No OCI sandbox is available|OCI sandbox image/);
});

test("sandbox host backend is explicit and still uses isolated HOME and caches", async () => {
  const workspace = await tempDir("flounder-sandbox-host-");
  const cache = await tempDir("flounder-sandbox-cache-");
  try {
    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: ["-e", "console.log(process.env.HOME); console.log(process.env.TMPDIR); console.log(process.env.CARGO_HOME);"],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /<local-path>/);
    assert.doesNotMatch(result.stdout, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stdout, new RegExp(cache.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox timeouts kill processes that ignore SIGTERM", async () => {
  const workspace = await tempDir("flounder-sandbox-timeout-");
  try {
    const started = Date.now();
    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        timeoutMs: 100,
      },
      workspace,
      4000,
      [],
      undefined,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(Date.now() - started < 5000, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox PATH includes common host toolchain directories", () => {
  const toolPath = sandboxToolPath("/usr/bin");
  const parts = toolPath.split(path.delimiter);
  assert.ok(parts.includes("/usr/bin"));
  assert.ok(parts.includes("/opt/homebrew/bin"));
  assert.ok(parts.includes("/usr/local/bin"));
});

test("sandbox host backend requires the allow-host-execution opt-in", async () => {
  const workspace = await tempDir("flounder-sandbox-host-denied-");
  try {
    const result = await runSandboxCommand(
      { program: process.execPath, args: ["-e", "console.log('host-ran')"], timeoutMs: 10_000 },
      workspace,
      4000,
      [],
      undefined,
      { backend: "host", allowHostFallback: false, network: "none" },
    );

    assert.equal(result.exitCode, 126);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /host-ran/);
    assert.match(result.stderr, /requires explicit --allow-host-execution/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
