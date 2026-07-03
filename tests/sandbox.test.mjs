import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, sandboxExecutionOptions, sandboxNetworkForPurpose } from "../dist/config.js";
import { autoPrefersAppleContainer, checkSandboxReadiness, clearSandboxAvailabilityCache, runSandboxCommand, sandboxToolPath } from "../dist/security/sandbox.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fakeContainerCli(options = {}) {
  const dir = await tempDir("flounder-fake-container-bin-");
  const bin = path.join(dir, "container");
  await writeFile(bin, `#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit ${options.imageInspectExit ?? 0}; fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit ${options.networkInspectExit ?? 0}; fi
if [ "$1" = "network" ] && [ "$2" = "create" ]; then exit ${options.networkCreateExit ?? 0}; fi
if [ "$1" = "run" ]; then
  printf 'ARGS:'
  for arg in "$@"; do printf '[%s]' "$arg"; done
  exit 0
fi
exit 1
`);
  await chmod(bin, 0o755);
  return dir;
}

async function fakeDockerCli() {
  const dir = await tempDir("flounder-fake-docker-bin-");
  const bin = path.join(dir, "docker");
  await writeFile(bin, `#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "run" ]; then
  printf 'DOCKER_ARGS:'
  for arg in "$@"; do printf '[%s]' "$arg"; done
  exit 0
fi
if [ "$1" = "rm" ]; then exit 0; fi
exit 1
`);
  await chmod(bin, 0o755);
  return dir;
}

async function withPlatform(platform, arch, fn) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
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

test("sandbox auto preference is limited to Apple silicon macOS", () => {
  assert.equal(autoPrefersAppleContainer("darwin", "arm64"), true);
  assert.equal(autoPrefersAppleContainer("darwin", "x64"), false);
  assert.equal(autoPrefersAppleContainer("linux", "arm64"), false);
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
  assert.match(readiness.message ?? "", /No sandbox backend is available|OCI sandbox image/);
});

test("sandbox readiness reports missing Apple container image without host fallback", async () => {
  const image = `flounder-test-missing-${Date.now()}-${Math.random().toString(16).slice(2)}:latest`;
  const readiness = await checkSandboxReadiness({ backend: "apple-container", image, allowHostFallback: true, network: "none" });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.backend, "apple-container");
  assert.equal(readiness.allowHostFallback, false);
  assert.equal(readiness.image, image);
  assert.match(readiness.message ?? "", /Apple container sandbox image/);
});

test("sandbox auto prefers Apple container on Apple silicon when the backend is ready", async () => {
  const workspace = await tempDir("flounder-sandbox-auto-apple-");
  const fakeBin = await fakeContainerCli();
  const oldPath = process.env.PATH;
  const image = "flounder-sandbox:auto-apple";
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    clearSandboxAvailabilityCache(image);
    await withPlatform("darwin", "arm64", async () => {
      const readiness = await checkSandboxReadiness({ backend: "auto", image, network: "none" });
      assert.equal(readiness.ok, true);
      assert.equal(readiness.backend, "apple-container");
      assert.equal(readiness.allowHostFallback, false);

      const result = await runSandboxCommand(
        { program: "node", args: ["--test"], timeoutMs: 10_000 },
        workspace,
        8000,
        [],
        undefined,
        { backend: "auto", image, network: "none" },
      );
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^ARGS:/);
      assert.match(result.stdout, /\[--network\]\[flounder-sealed\]\[--no-dns\]/);
      assert.match(result.stdout, /\[flounder-sandbox:auto-apple\]\[node\]\[--test\]/);
    });
  } finally {
    process.env.PATH = oldPath;
    clearSandboxAvailabilityCache(image);
    await rm(workspace, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("sandbox auto falls back to Docker on Apple silicon when Apple sealed networking is unavailable", async () => {
  const workspace = await tempDir("flounder-sandbox-auto-docker-");
  const fakeContainerBin = await fakeContainerCli({ networkInspectExit: 1, networkCreateExit: 1 });
  const fakeDockerBin = await fakeDockerCli();
  const oldPath = process.env.PATH;
  const image = "flounder-sandbox:auto-docker";
  try {
    process.env.PATH = `${fakeContainerBin}${path.delimiter}${fakeDockerBin}${path.delimiter}${oldPath ?? ""}`;
    clearSandboxAvailabilityCache(image);
    await withPlatform("darwin", "arm64", async () => {
      const readiness = await checkSandboxReadiness({ backend: "auto", image, network: "none" });
      assert.equal(readiness.ok, true);
      assert.equal(readiness.backend, "oci");

      const result = await runSandboxCommand(
        { program: "node", args: ["--test"], timeoutMs: 10_000 },
        workspace,
        8000,
        [],
        undefined,
        { backend: "auto", image, network: "none" },
      );
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^DOCKER_ARGS:/);
      assert.match(result.stdout, /\[--network\]\[none\]/);
      assert.match(result.stdout, /\[flounder-sandbox:auto-docker\]\[node\]\[--test\]/);
    });
  } finally {
    process.env.PATH = oldPath;
    clearSandboxAvailabilityCache(image);
    await rm(workspace, { recursive: true, force: true });
    await rm(fakeContainerBin, { recursive: true, force: true });
    await rm(fakeDockerBin, { recursive: true, force: true });
  }
});

test("sandbox Apple container backend maps Flounder isolation options to container run", async () => {
  const workspace = await tempDir("flounder-sandbox-apple-container-");
  const cache = await tempDir("flounder-sandbox-apple-cache-");
  const fakeBin = await fakeContainerCli();
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    await mkdir(path.join(workspace, "sub"), { recursive: true });
    const result = await runSandboxCommand(
      { program: "node", args: ["--test"], cwd: "sub", timeoutMs: 10_000 },
      workspace,
      8000,
      [cache],
      cache,
      { backend: "apple-container", image: "flounder-sandbox:latest", network: "none", memoryMb: 256, cpus: 1.25 },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\[run\]/);
    assert.match(result.stdout, /\[--rm\]/);
    assert.match(result.stdout, /\[--workdir\]\[\/workspace\/sub\]/);
    assert.match(result.stdout, /\[--mount\]\[type=bind,source=<local-path>,target=\/workspace\]/);
    assert.match(result.stdout, /\[--mount\]\[type=bind,source=<local-path>,target=\/cache\]/);
    assert.match(result.stdout, /\[--cap-drop\]\[ALL\]/);
    assert.match(result.stdout, /\[--read-only\]/);
    assert.match(result.stdout, /\[--tmpfs\]\[\/tmp\]/);
    assert.match(result.stdout, /\[--network\]\[flounder-sealed\]\[--no-dns\]/);
    assert.match(result.stdout, /\[--memory\]\[256M\]/);
    assert.match(result.stdout, /\[--cpus\]\[1.25\]/);
    assert.match(result.stdout, /\[--env\]\[HOME=\/workspace\]/);
    assert.match(result.stdout, /\[flounder-sandbox:latest\]\[node\]\[--test\]/);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
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
