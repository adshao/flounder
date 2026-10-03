import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("../scripts/check-public-surface.mjs", import.meta.url));

test("public-surface scan includes untracked publishable files but excludes ignored local artifacts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flounder-public-scan-"));
  try {
    const credentialName = "token";
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(path.join(root, ".gitignore"), ".audit-targets/\n");
    mkdirSync(path.join(root, ".audit-targets"));
    writeFileSync(path.join(root, ".audit-targets", "private.ts"), `const ${credentialName} = "private-test-value";\n`);
    writeFileSync(path.join(root, "safe.ts"), "export const value = 1;\n");

    const clean = spawnSync(process.execPath, [scanner, "--current-only"], { cwd: root, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stderr);

    writeFileSync(path.join(root, "new.ts"), `const ${credentialName} = "publishable-test-value";\n`);
    const unsafe = spawnSync(process.execPath, [scanner, "--current-only"], { cwd: root, encoding: "utf8" });
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /new\.ts:1 credential assignment/);
    assert.doesNotMatch(unsafe.stderr, /private\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
