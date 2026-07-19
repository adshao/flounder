import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, sandboxExecutionOptions, sandboxNetworkForPurpose } from "../dist/config.js";
import { autoPrefersAppleContainer, checkSandboxReadiness, clearSandboxAvailabilityCache, compactSandboxWorkspace, runSandboxCommand, sandboxToolPath } from "../dist/security/sandbox.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("completed sandbox workspaces discard rebuildable output but retain source and scratch evidence", async () => {
  const workspace = await tempDir("flounder-sandbox-compact-");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "out"), { recursive: true });
    await mkdir(path.join(workspace, "target", "debug"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(workspace, "notes"), { recursive: true });
    await writeFile(path.join(workspace, "src", "lib.rs"), "pub fn audited() {}\n");
    await writeFile(path.join(workspace, "out", "checked-in.json"), "{}\n");
    await writeFile(path.join(workspace, "target", "debug", "large-binary"), "rebuildable\n");
    await writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(path.join(workspace, "notes", "trace.txt"), "keep non-build output\n");
    await writeFile(path.join(workspace, "target", "poc.rs"), "#[test] fn poc() {}\n");

    const result = await compactSandboxWorkspace(
      workspace,
      new Set(["src/lib.rs", "out/checked-in.json"]),
      new Map([["target/poc.rs", "#[test] fn poc() {}\n"]]),
    );

    assert.equal(result.removedDirectories, 2);
    assert.equal(result.restoredScratchFiles, 1);
    assert.equal(await readFile(path.join(workspace, "src", "lib.rs"), "utf8"), "pub fn audited() {}\n");
    assert.equal(await readFile(path.join(workspace, "out", "checked-in.json"), "utf8"), "{}\n");
    assert.equal(await readFile(path.join(workspace, "target", "poc.rs"), "utf8"), "#[test] fn poc() {}\n");
    assert.equal(await readFile(path.join(workspace, "notes", "trace.txt"), "utf8"), "keep non-build output\n");
    await assert.rejects(readFile(path.join(workspace, "target", "debug", "large-binary")), /ENOENT/);
    await assert.rejects(readFile(path.join(workspace, "node_modules", "pkg", "index.js")), /ENOENT/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function truncatedElf64() {
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(4096n, 40);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(64, 58);
  elf.writeUInt16LE(1, 60);
  return elf;
}

function truncatedElfIdent() {
  return Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]);
}

function completeElf64() {
  const elf = Buffer.alloc(124);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  elf.writeBigUInt64LE(120n, 72);
  elf.writeBigUInt64LE(4n, 96);
  elf.writeUInt32LE(0xdecafbad, 120);
  return elf;
}

function completeMachO64() {
  const macho = Buffer.alloc(120);
  macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(1, 16); // ncmds
  macho.writeUInt32LE(72, 20); // sizeofcmds
  macho.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
  macho.writeUInt32LE(72, 36);
  macho.writeBigUInt64LE(104n, 72); // fileoff
  macho.writeBigUInt64LE(16n, 80); // filesize
  return macho;
}

function truncatedMachO64() {
  return completeMachO64().subarray(0, 64);
}

async function fakeContainerCli(options = {}) {
  const dir = await tempDir("flounder-fake-container-bin-");
  const bin = path.join(dir, "container");
  const deleteStateFile = path.join(dir, "delete-count");
  await writeFile(bin, `#!/usr/bin/env bash
LOG_FILE=${JSON.stringify(options.logFile ?? "")}
RUN_SLEEP_SECONDS=${JSON.stringify(String(options.runSleepSeconds ?? 0))}
DELETE_FAIL_COUNT=${JSON.stringify(String(options.deleteFailCount ?? 0))}
DELETE_STATE_FILE=${JSON.stringify(deleteStateFile)}
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf '%s' ${JSON.stringify(options.imageInspectStderr ?? "")} >&2; exit ${options.imageInspectExit ?? 0}; fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit ${options.networkInspectExit ?? 0}; fi
if [ "$1" = "network" ] && [ "$2" = "create" ]; then exit ${options.networkCreateExit ?? 0}; fi
if [ "$1" = "delete" ]; then
  if [ -n "$LOG_FILE" ]; then printf 'DELETE:%s\\n' "\${3:-}" >> "$LOG_FILE"; fi
  DELETE_COUNT=0
  if [ -f "$DELETE_STATE_FILE" ]; then read -r DELETE_COUNT < "$DELETE_STATE_FILE"; fi
  DELETE_COUNT=$((DELETE_COUNT + 1))
  printf '%s\\n' "$DELETE_COUNT" > "$DELETE_STATE_FILE"
  if [ "$DELETE_COUNT" -le "$DELETE_FAIL_COUNT" ]; then printf 'transient delete failure\\n' >&2; exit 1; fi
  exit ${options.deleteExit ?? 0}
fi
if [ "$1" = "run" ]; then
  if [ -n "$LOG_FILE" ]; then printf 'RUN\\n' >> "$LOG_FILE"; fi
  printf 'ARGS:'
  for arg in "$@"; do printf '[%s]' "$arg"; done
  if [ "$RUN_SLEEP_SECONDS" != "0" ]; then exec sleep "$RUN_SLEEP_SECONDS"; fi
  exit 0
fi
exit 1
`);
  await chmod(bin, 0o755);
  return dir;
}

async function waitForFileMatch(file, pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await readFile(file, "utf8");
      if (pattern.test(last)) return last;
    } catch {
      // File may not exist until the fake CLI handles the cleanup call.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(last, pattern);
  return last;
}

async function fakeDockerCli(options = {}) {
  const dir = await tempDir("flounder-fake-docker-bin-");
  const bin = path.join(dir, "docker");
  await writeFile(bin, `#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf '%s' ${JSON.stringify(options.imageInspectStderr ?? "")} >&2; exit ${options.imageInspectExit ?? 0}; fi
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

test("network-enabled fetch tools run with clean config and protocol constraints", async () => {
  const workspace = await tempDir("flounder-sandbox-clean-network-config-");
  const bin = path.join(workspace, "bin");
  const previousPath = process.env.PATH;
  await mkdir(bin, { recursive: true });
  const probe = `#!/bin/sh
printf 'CURL_HOME=%s\\n' "$CURL_HOME"
printf 'WGETRC=%s\\n' "$WGETRC"
printf 'GIT_CONFIG_NOSYSTEM=%s\\n' "$GIT_CONFIG_NOSYSTEM"
printf 'GIT_CONFIG_GLOBAL=%s\\n' "$GIT_CONFIG_GLOBAL"
printf 'GIT_CONFIG_SYSTEM=%s\\n' "$GIT_CONFIG_SYSTEM"
printf 'GIT_ALLOW_PROTOCOL=%s\\n' "$GIT_ALLOW_PROTOCOL"
`;
  try {
    for (const tool of ["curl", "wget", "git"]) {
      const executable = path.join(bin, tool);
      await writeFile(executable, probe);
      await chmod(executable, 0o755);
    }
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    const options = { backend: "host", image: "unused", allowHostFallback: true, network: "enabled" };
    const curl = await runSandboxCommand({ program: "curl", args: ["https://example.com"] }, workspace, 4000, [], undefined, options);
    assert.deepEqual(curl.command.args.slice(0, 5), ["--disable", "--proto", "=http,https", "--proto-redir", "=http,https"]);
    assert.match(curl.stdout, /CURL_HOME=\/dev\/null/);

    const wget = await runSandboxCommand({ program: "wget", args: ["https://example.com"] }, workspace, 4000, [], undefined, options);
    assert.equal(wget.command.args[0], "--no-config");
    assert.match(wget.stdout, /WGETRC=\/dev\/null/);

    const git = await runSandboxCommand({ program: "git", args: ["clone", "https://example.com/repo"] }, workspace, 4000, [], undefined, options);
    assert.deepEqual(git.command.args.slice(0, 6), ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "credential.helper="]);
    assert.match(git.stdout, /GIT_CONFIG_NOSYSTEM=1/);
    assert.match(git.stdout, /GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(git.stdout, /GIT_CONFIG_SYSTEM=\/dev\/null/);
    assert.match(git.stdout, /GIT_ALLOW_PROTOCOL=https/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(workspace, { recursive: true, force: true });
  }
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

test("sandbox readiness distinguishes an unreachable Docker daemon from a missing image", async () => {
  const fakeBin = await fakeDockerCli({
    imageInspectExit: 1,
    imageInspectStderr: "Cannot connect to the Docker daemon at unix:///tmp/docker.sock. Is the docker daemon running?",
  });
  const oldPath = process.env.PATH;
  const image = "flounder-sandbox:diagnostic";
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    clearSandboxAvailabilityCache(image);
    const readiness = await checkSandboxReadiness({ backend: "oci", image, allowHostFallback: false, network: "none" });

    assert.equal(readiness.ok, false);
    assert.match(readiness.message ?? "", /Docker is not reachable/);
    assert.match(readiness.message ?? "", /Cannot connect to the Docker daemon/);
  } finally {
    process.env.PATH = oldPath;
    clearSandboxAvailabilityCache(image);
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("sandbox capped logs preserve early diagnostics and late context", async () => {
  const workspace = await tempDir("flounder-sandbox-log-cap-");
  try {
    const script = [
      "console.log('EARLY_SANDBOX_ERROR: missing package');",
      "for (let i = 0; i < 400; i += 1) console.log('warning ' + i + ': noisy compiler profile output');",
      "console.log('LATE_SANDBOX_CONTEXT: build failed after compilation');",
    ].join("\n");
    const result = await runSandboxCommand(
      { program: process.execPath, args: ["-e", script], timeoutMs: 10_000 },
      workspace,
      1200,
      [],
      undefined,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /EARLY_SANDBOX_ERROR/);
    assert.match(result.stdout, /LATE_SANDBOX_CONTEXT/);
    assert.match(result.stdout, /preserving head and tail/);
    assert.ok(result.stdout.length <= 1250, "log cap should remain bounded");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox readiness reports missing Apple container image without host fallback", async () => {
  const fakeBin = await fakeContainerCli({ imageInspectExit: 1 });
  const oldPath = process.env.PATH;
  const image = `flounder-test-missing-${Date.now()}-${Math.random().toString(16).slice(2)}:latest`;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    clearSandboxAvailabilityCache(image);
    const readiness = await checkSandboxReadiness({ backend: "apple-container", image, allowHostFallback: true, network: "none" });

    assert.equal(readiness.ok, false);
    assert.equal(readiness.backend, "apple-container");
    assert.equal(readiness.allowHostFallback, false);
    assert.equal(readiness.image, image);
    assert.match(readiness.message ?? "", /Apple container sandbox image/);
  } finally {
    process.env.PATH = oldPath;
    clearSandboxAvailabilityCache(image);
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("sandbox readiness reports Apple container host permission denial distinctly", async () => {
  const fakeBin = await fakeContainerCli({ imageInspectExit: 1, imageInspectStderr: "Error: The operation couldn’t be completed. Operation not permitted" });
  const oldPath = process.env.PATH;
  const image = "flounder-sandbox:permission-denied";
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    clearSandboxAvailabilityCache(image);
    const readiness = await checkSandboxReadiness({ backend: "apple-container", image, allowHostFallback: true, network: "none" });

    assert.equal(readiness.ok, false);
    assert.equal(readiness.backend, "apple-container");
    assert.equal(readiness.allowHostFallback, false);
    assert.equal(readiness.image, image);
    assert.match(readiness.message ?? "", /not permitted to access the container system API/);
    assert.doesNotMatch(readiness.message ?? "", /sandbox image .* is not available/);
  } finally {
    process.env.PATH = oldPath;
    clearSandboxAvailabilityCache(image);
    await rm(fakeBin, { recursive: true, force: true });
  }
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
    assert.match(result.stdout, /\[--env\]\[SCARB_CACHE=\/cache\/scarb-cache\]/);
    assert.match(result.stdout, /\[--env\]\[YARN_GLOBAL_FOLDER=\/cache\/yarn-berry\]/);
    assert.match(result.stdout, /\[flounder-sandbox:latest\]\[node\]\[--test\]/);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("sandbox Apple container backend pins DNS only for network-enabled runs", async () => {
  const workspace = await tempDir("flounder-sandbox-apple-container-dns-");
  const fakeBin = await fakeContainerCli();
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    const result = await runSandboxCommand(
      { program: "scarb", args: ["build"], timeoutMs: 10_000 },
      workspace,
      8000,
      [],
      undefined,
      { backend: "apple-container", image: "flounder-sandbox:cairo", network: "enabled" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\[--dns\]\[1\.1\.1\.1\]/);
    assert.match(result.stdout, /\[--dns\]\[8\.8\.8\.8\]/);
    assert.doesNotMatch(result.stdout, /\[--no-dns\]/);
    assert.doesNotMatch(result.stdout, /\[--network\]\[flounder-sealed\]/);
    assert.match(result.stdout, /\[flounder-sandbox:cairo\]\[scarb\]\[build\]/);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("sandbox Apple container backend force-deletes timed-out containers", async () => {
  const workspace = await tempDir("flounder-sandbox-apple-timeout-");
  const logDir = await tempDir("flounder-sandbox-apple-timeout-log-");
  const logFile = path.join(logDir, "container.log");
  const fakeBin = await fakeContainerCli({ logFile, runSleepSeconds: 5, deleteFailCount: 1 });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
    const result = await runSandboxCommand(
      { program: "node", args: ["--test"], timeoutMs: 100 },
      workspace,
      8000,
      [],
      undefined,
      { backend: "apple-container", image: "flounder-sandbox:timeout", network: "enabled" },
    );

    assert.equal(result.timedOut, true);
    const cleanupLog = await waitForFileMatch(logFile, /DELETE:flounder-[^\n]+\nDELETE:flounder-/);
    assert.equal(cleanupLog.match(/DELETE:flounder-/g)?.length, 2);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
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
        args: ["-e", "console.log(process.env.HOME); console.log(process.env.TMPDIR); console.log(process.env.CARGO_HOME); console.log(process.env.SCARB_CACHE);"],
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

test("sandbox reuses Foundry solc cache across isolated HOME directories", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-home-");
  const cache = await tempDir("flounder-sandbox-svm-cache-");
  try {
    const complete = completeElf64();
    const encoded = complete.toString("base64");
    await mkdir(path.join(cache, "foundry-svm", "0.8.35"), { recursive: true });
    await writeFile(path.join(cache, "foundry-svm", "0.8.35", "solc-0.8.35"), complete);

    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const cached = path.join(process.env.HOME, '.svm', '0.8.35', 'solc-0.8.35');",
            "console.log('cached=' + fs.existsSync(cached));",
            "const installedDir = path.join(process.env.HOME, '.svm', '0.8.33');",
            "fs.mkdirSync(installedDir, { recursive: true });",
            `fs.writeFileSync(path.join(installedDir, 'solc-0.8.33'), Buffer.from(${JSON.stringify(encoded)}, 'base64'));`,
          ].join(" "),
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /cached=true/);
    assert.deepEqual(await readFile(path.join(cache, "foundry-svm", "0.8.33", "solc-0.8.33")), complete);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox does not restore truncated Foundry compiler caches", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-truncated-home-");
  const cache = await tempDir("flounder-sandbox-svm-truncated-cache-");
  const compiler = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  try {
    await mkdir(path.dirname(compiler), { recursive: true });
    await writeFile(compiler, truncatedElf64());

    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const path = require('node:path'); console.log('cached=' + fs.existsSync(path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3')));",
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /cached=false/);
    assert.deepEqual(await readFile(compiler), truncatedElf64());
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox rejects a compiler download interrupted inside the ELF identifier", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-ident-home-");
  const cache = await tempDir("flounder-sandbox-svm-ident-cache-");
  const compiler = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  try {
    await mkdir(path.dirname(compiler), { recursive: true });
    await writeFile(compiler, truncatedElfIdent());

    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const path = require('node:path'); console.log('cached=' + fs.existsSync(path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3')));",
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /cached=false/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox rejects a compiler download interrupted before executable magic is complete", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-pre-magic-home-");
  const cache = await tempDir("flounder-sandbox-svm-pre-magic-cache-");
  const compiler = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  try {
    await mkdir(path.dirname(compiler), { recursive: true });
    await writeFile(compiler, Buffer.from([0x7f, 0x45]));

    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const path = require('node:path'); console.log('cached=' + fs.existsSync(path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3')));",
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /cached=false/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox validates Mach-O compiler structure and rejects unknown cache payloads", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-macho-home-");
  const cache = await tempDir("flounder-sandbox-svm-macho-cache-");
  const complete = path.join(cache, "foundry-svm", "1.2.1", "solc-1.2.1");
  const truncated = path.join(cache, "foundry-svm", "1.2.2", "solc-1.2.2");
  const unknown = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  try {
    await mkdir(path.dirname(complete), { recursive: true });
    await mkdir(path.dirname(truncated), { recursive: true });
    await mkdir(path.dirname(unknown), { recursive: true });
    await writeFile(complete, completeMachO64());
    await writeFile(truncated, truncatedMachO64());
    await writeFile(unknown, "not-a-native-compiler");

    const result = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs'); const path = require('node:path');",
            "const root = path.join(process.env.HOME, '.svm');",
            "console.log('complete=' + fs.existsSync(path.join(root, '1.2.1', 'solc-1.2.1')));",
            "console.log('truncated=' + fs.existsSync(path.join(root, '1.2.2', 'solc-1.2.2')));",
            "console.log('unknown=' + fs.existsSync(path.join(root, '1.2.3', 'solc-1.2.3')));",
          ].join(" "),
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /complete=true/);
    assert.match(result.stdout, /truncated=false/);
    assert.match(result.stdout, /unknown=false/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox neither persists nor reuses a truncated compiler from a failed command", async () => {
  const workspace = await tempDir("flounder-sandbox-svm-failed-home-");
  const cache = await tempDir("flounder-sandbox-svm-failed-cache-");
  const encoded = truncatedElf64().toString("base64");
  const cachedCompiler = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  try {
    const failed = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const dir = path.join(process.env.HOME, '.svm', '1.2.3');",
            "fs.mkdirSync(dir, { recursive: true });",
            `fs.writeFileSync(path.join(dir, 'solc-1.2.3'), Buffer.from(${JSON.stringify(encoded)}, 'base64'));`,
            "process.exit(7);",
          ].join(" "),
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(failed.exitCode, 7);
    await assert.rejects(() => readFile(cachedCompiler), (error) => error?.code === "ENOENT");

    const retried = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const path = require('node:path'); console.log('cached=' + fs.existsSync(path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3')));",
        ],
        timeoutMs: 10_000,
      },
      workspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(retried.exitCode, 0);
    assert.match(retried.stdout, /cached=false/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("sandbox heals a truncated compiler cache with a complete artifact even when the build fails", async () => {
  const firstWorkspace = await tempDir("flounder-sandbox-svm-heal-first-");
  const secondWorkspace = await tempDir("flounder-sandbox-svm-heal-second-");
  const cache = await tempDir("flounder-sandbox-svm-heal-cache-");
  const compiler = path.join(cache, "foundry-svm", "1.2.3", "solc-1.2.3");
  const replacement = completeElf64();
  const encoded = replacement.toString("base64");
  try {
    await mkdir(path.dirname(compiler), { recursive: true });
    await writeFile(compiler, truncatedElf64());

    const repaired = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const compiler = path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3');",
            "console.log('cached=' + fs.existsSync(compiler));",
            "fs.mkdirSync(path.dirname(compiler), { recursive: true });",
            `fs.writeFileSync(compiler, Buffer.from(${JSON.stringify(encoded)}, 'base64'));`,
            "process.exit(9);",
          ].join(" "),
        ],
        timeoutMs: 10_000,
      },
      firstWorkspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(repaired.exitCode, 9);
    assert.match(repaired.stdout, /cached=false/);
    assert.deepEqual(await readFile(compiler), replacement);

    const restored = await runSandboxCommand(
      {
        program: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const path = require('node:path'); const compiler = path.join(process.env.HOME, '.svm', '1.2.3', 'solc-1.2.3'); console.log('bytes=' + fs.readFileSync(compiler).length);",
        ],
        timeoutMs: 10_000,
      },
      secondWorkspace,
      4000,
      [cache],
      cache,
      { backend: "host", allowHostFallback: true, network: "none" },
    );

    assert.equal(restored.exitCode, 0);
    assert.match(restored.stdout, /bytes=124/);
  } finally {
    await rm(firstWorkspace, { recursive: true, force: true });
    await rm(secondWorkspace, { recursive: true, force: true });
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
