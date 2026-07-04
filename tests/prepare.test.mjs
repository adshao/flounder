import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { prepareWorkspaceToolchain } from "../dist/agent/prepare.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFakeTool(dir, name, logPath) {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + " cwd=" + process.cwd() + "\\n");
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
    await writeFakeTool(binDir, "scarb", logPath);
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
    assert.deepEqual(report.results.map((result) => [result.toolchain, result.command, result.cwd, result.ok]), [
      ["scarb", "scarb build", ".", true],
      ["blueprint", "blueprint build --all", "ton", true],
    ]);
    assert.match(await readFile(logPath, "utf8"), /scarb build cwd=.*flounder-prepare-workspace-/);
    assert.match(await readFile(logPath, "utf8"), /blueprint build --all cwd=.*flounder-prepare-workspace-.*\/ton/);
    assert.equal(log.events[0]?.kind, "audit_prepare_tool_versions");
    assert.equal(log.artifacts[0]?.name, "audit_prepare.json");
    assert.deepEqual(log.artifacts[0]?.payload.pinnedToolVersions, report.pinnedToolVersions);
  } finally {
    process.env.PATH = oldPath;
    await rm(workspace, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});
