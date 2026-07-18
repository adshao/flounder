import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { prepareResourceRequests, prepareWorkspaceToolchain } from "../dist/agent/prepare.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFakeTool(dir, name, logPath, versionOutput = undefined) {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + " cwd=" + process.cwd() + "\\n");
if (process.argv.includes("--version") && ${JSON.stringify(Boolean(versionOutput))}) {
  console.log(${JSON.stringify(versionOutput ?? "")});
}
`);
  await chmod(bin, 0o755);
}

async function writeFailingFakeTool(dir, name, logPath, stderrText) {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + " cwd=" + process.cwd() + "\\n");
console.error(${JSON.stringify(stderrText)});
process.exit(1);
`);
  await chmod(bin, 0o755);
}

function logger() {
  const events = [];
  const artifacts = [];
  return {
    events,
    artifacts,
    async event(kind, payload) {
      events.push({ kind, payload });
    },
    async artifact(name, payload) {
      artifacts.push({ name, payload });
    },
  };
}

test("prepareWorkspaceToolchain warms Cairo Scarb and TON Blueprint projects", async () => {
  const workspace = await tempDir("flounder-prepare-workspace-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(workspace, "Scarb.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(workspace, ".tool-versions"), "scarb 2.12.0\nstarknet-foundry 0.49.0\n");
    await mkdir(path.join(workspace, "ton"), { recursive: true });
    await writeFile(path.join(workspace, "ton", "blueprint.config.ts"), "export const config = {};\n");
    await writeFakeTool(binDir, "scarb", logPath, "scarb 2.12.0");
    await writeFakeTool(binDir, "snforge", logPath, "snforge 0.49.0");
    await writeFakeTool(binDir, "sncast", logPath, "sncast 0.49.0");
    await writeFakeTool(binDir, "blueprint", logPath);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const log = logger();

    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: log,
      cacheDir,
    });

    assert.equal(report.ran, true);
    assert.deepEqual(report.detected, ["scarb", "blueprint"]);
    assert.deepEqual(report.pinnedToolVersions, [
      { tool: "scarb", version: "2.12.0", dir: "." },
      { tool: "starknet-foundry", version: "0.49.0", dir: "." },
    ]);
    assert.deepEqual(report.toolVersionChecks.map((result) => [result.tool, result.expected, result.ok]), [
      ["scarb", "2.12.0", true],
      ["snforge", "0.49.0", true],
      ["sncast", "0.49.0", true],
    ]);
    assert.deepEqual(report.results.map((result) => [result.toolchain, result.command, result.cwd, result.ok]), [
      ["scarb", "scarb fetch", ".", true],
      ["scarb", "scarb build", ".", true],
      ["blueprint", "blueprint build --all", "ton", true],
    ]);
    assert.match(await readFile(logPath, "utf8"), /scarb fetch cwd=.*flounder-prepare-workspace-/);
    assert.match(await readFile(logPath, "utf8"), /scarb build cwd=.*flounder-prepare-workspace-/);
    assert.match(await readFile(logPath, "utf8"), /blueprint build --all cwd=.*flounder-prepare-workspace-.*\/ton/);
    assert.equal(log.events[0]?.kind, "audit_prepare_tool_versions");
    assert.equal(log.events[1]?.kind, "audit_prepare_tool_version_checks");
    assert.equal(log.artifacts[0]?.name, "audit_prepare.json");
    assert.deepEqual(log.artifacts[0]?.payload.pinnedToolVersions, report.pinnedToolVersions);
    assert.deepEqual(log.artifacts[0]?.payload.toolVersionChecks, report.toolVersionChecks);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareWorkspaceToolchain reports pinned tool version mismatch before warm-up", async () => {
  const workspace = await tempDir("flounder-prepare-workspace-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(workspace, "Scarb.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(workspace, ".tool-versions"), "scarb 2.12.0\n");
    await writeFakeTool(binDir, "scarb", logPath, "scarb 2.19.0");
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const log = logger();

    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: log,
      cacheDir,
    });

    assert.equal(report.ran, false);
    assert.deepEqual(report.detected, ["scarb"]);
    assert.deepEqual(report.toolVersionChecks.map((result) => [result.tool, result.expected, result.actual, result.ok]), [
      ["scarb", "2.12.0", "scarb 2.19.0", false],
    ]);
    assert.equal(report.results.length, 0);
    assert.doesNotMatch(await readFile(logPath, "utf8"), /scarb fetch/);
    assert.equal(log.events.at(-1)?.kind, "audit_prepare_tool_version_mismatch");
    assert.equal(log.artifacts[0]?.name, "audit_prepare.json");
    assert.deepEqual(log.artifacts[0]?.payload.toolVersionChecks, report.toolVersionChecks);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareWorkspaceToolchain enforces exact rust-toolchain.toml pins before Cargo warm-up", async () => {
  const workspace = await tempDir("flounder-prepare-rust-pin-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(workspace, "Cargo.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(workspace, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.86.0\"\nprofile = \"minimal\"\n");
    await writeFakeTool(binDir, "rustc", logPath, "rustc 1.75.0");
    await writeFakeTool(binDir, "cargo", logPath, "cargo 1.75.0");
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: logger(),
      cacheDir,
    });

    assert.equal(report.ran, false);
    assert.deepEqual(report.pinnedToolVersions, [{ tool: "rust", version: "1.86.0", dir: "." }]);
    assert.deepEqual(report.toolVersionChecks.map((result) => [result.tool, result.expected, result.actual, result.ok]), [
      ["rustc", "1.86.0", "rustc 1.75.0", false],
      ["cargo", "1.86.0", "cargo 1.75.0", false],
    ]);
    assert.equal(report.results.length, 0);
    assert.doesNotMatch(await readFile(logPath, "utf8"), /cargo fetch/);
    const requests = prepareResourceRequests(report);
    assert.deepEqual(requests.map((request) => request.needed), [
      "Sandbox image with rustc 1.86.0",
      "Sandbox image with cargo 1.86.0",
    ]);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareWorkspaceToolchain limits eager warm-up to the selected scope build tree", async () => {
  const workspace = await tempDir("flounder-prepare-focused-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await mkdir(path.join(workspace, "solidity", "contracts"), { recursive: true });
    await writeFile(path.join(workspace, "solidity", "foundry.toml"), "[profile.default]\nsrc = \"contracts\"\n");
    await writeFile(path.join(workspace, "solidity", "contracts", "Target.sol"), "contract Target {}\n");
    await mkdir(path.join(workspace, "another-solidity-root"), { recursive: true });
    await writeFile(path.join(workspace, "another-solidity-root", "foundry.toml"), "[profile.default]\nsrc = \"src\"\n");
    await mkdir(path.join(workspace, "vendor", "cairo"), { recursive: true });
    await writeFile(path.join(workspace, "vendor", "cairo", "Scarb.toml"), "[package]\nname = \"unrelated\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(workspace, "vendor", "cairo", ".tool-versions"), "scarb 2.12.0\n");
    await writeFakeTool(binDir, "forge", logPath);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const log = logger();

    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: log,
      cacheDir,
      focusPaths: ["solidity/contracts/Target.sol:1-20"],
    });

    assert.equal(report.ran, true);
    assert.deepEqual(report.detected, ["forge"]);
    assert.deepEqual(report.pinnedToolVersions, []);
    assert.deepEqual(report.toolVersionChecks, []);
    assert.deepEqual(report.results.map((result) => [result.toolchain, result.command, result.cwd, result.ok]), [
      ["forge", "forge build", "solidity", true],
    ]);
    assert.doesNotMatch(await readFile(logPath, "utf8"), /scarb/);
    assert.equal(log.events.some((event) => event.kind === "audit_prepare_tool_version_mismatch"), false);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareWorkspaceToolchain installs dependencies for every outermost package root", async () => {
  const workspace = await tempDir("flounder-prepare-multi-package-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    for (const project of ["aqua", "swap-vm"]) {
      const projectDir = path.join(workspace, "sources", project);
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "package.json"), `{\"name\":\"${project}\"}\n`);
      await writeFile(path.join(projectDir, "yarn.lock"), "# yarn lockfile v1\n");
      await writeFile(path.join(projectDir, "foundry.toml"), "[profile.default]\nsrc = \"src\"\n");
    }
    await writeFakeTool(binDir, "yarn", logPath);
    await writeFakeTool(binDir, "forge", logPath);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];

    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: logger(),
      cacheDir,
    });

    assert.deepEqual(report.results.map((result) => [result.toolchain, result.command, result.cwd, result.ok]), [
      ["yarn", "yarn install --frozen-lockfile", "sources/aqua", true],
      ["yarn", "yarn install --frozen-lockfile", "sources/swap-vm", true],
      ["forge", "forge build", "sources/aqua", true],
      ["forge", "forge build", "sources/swap-vm", true],
    ]);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareWorkspaceToolchain does not report installer progress as an actual tool version", async () => {
  const workspace = await tempDir("flounder-prepare-version-progress-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(workspace, "Scarb.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(workspace, ".tool-versions"), "scarb 2.12.0\n");
    await writeFailingFakeTool(binDir, "scarb", logPath, "[0/6] [0s]\nfailed to install pinned tool");
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: logger(),
      cacheDir,
    });

    assert.equal(report.ran, false);
    assert.equal(report.toolVersionChecks[0]?.actual, undefined);
    assert.equal(report.toolVersionChecks[0]?.reason, "version command exited 1");
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("prepareResourceRequests captures failed Foundry warm-up as product-owned resource blocker", async () => {
  const workspace = await tempDir("flounder-prepare-workspace-");
  const binDir = await tempDir("flounder-prepare-bin-");
  const cacheDir = await tempDir("flounder-prepare-cache-");
  const logPath = path.join(workspace, "tools.log");
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(workspace, "foundry.toml"), "[profile.default]\nsrc = \"src\"\n");
    await writeFailingFakeTool(binDir, "forge", logPath, "Error: Broken pipe (os error 32)");
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    cfg.reproductionMaxLogBytes = 4000;
    cfg.sourcePaths = [workspace];
    const log = logger();

    const report = await prepareWorkspaceToolchain({
      workspace: { absolute: workspace, relative: "workspace" },
      cfg,
      logger: log,
      cacheDir,
    });
    const requests = prepareResourceRequests(report, {
      program: "forge",
      args: ["test", "test/PoC.t.sol"],
      expectedExitCode: 0,
    });

    assert.equal(report.ran, true);
    assert.deepEqual(report.results.map((result) => [result.toolchain, result.command, result.ok]), [
      ["forge", "forge build", false],
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, "framework-prepare");
    assert.equal(requests[0].kind, "sandbox-image");
    assert.match(requests[0].reason, /forge build/);
    assert.match(requests[0].reason, /Broken pipe/);
    assert.equal(requests[0].retryCommand, "forge test test/PoC.t.sol");
    assert.doesNotMatch(JSON.stringify(requests), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});
