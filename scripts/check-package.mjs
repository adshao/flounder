#!/usr/bin/env node
// Validate the exact shipped artifact, not only the source checkout. Lifecycle and model calls stay disabled;
// registry access is limited to installing the packed artifact into a disposable consumer tree.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "flounder-package-"));
const sourceManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const isolatedHome = path.join(temp, "home");
const isolatedCache = path.join(temp, "npm-cache");
await mkdir(isolatedHome);
await mkdir(isolatedCache, { recursive: true });
const childEnvironment = {
  PATH: process.env.PATH ?? process.env.Path ?? "",
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  LANG: "C.UTF-8",
  CI: "true",
  npm_config_cache: isolatedCache,
  NPM_CONFIG_CACHE: isolatedCache,
};
for (const name of ["PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "WINDIR"]) {
  if (process.env[name]) childEnvironment[name] = process.env[name];
}

function requestedInputs() {
  const args = process.argv.slice(2);
  const inputs = { tarball: undefined, installedRoot: undefined };
  assert.equal(args.length % 2, 0, "Usage: check-package.mjs [--tarball <package.tgz>] [--installed-root <directory>]");
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    assert.ok(
      value && (flag === "--tarball" || flag === "--installed-root"),
      "Usage: check-package.mjs [--tarball <package.tgz>] [--installed-root <directory>]",
    );
    if (flag === "--tarball") inputs.tarball = path.resolve(root, value);
    if (flag === "--installed-root") inputs.installedRoot = path.resolve(root, value);
  }
  assert.ok(!inputs.installedRoot || inputs.tarball, "--installed-root requires --tarball");
  return inputs;
}

function npmExecutable() {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "Run this check through npm run check:package:dist");
  return npm;
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const metadata = await lstat(fullPath);
    assert.ok(!metadata.isSymbolicLink(), `symbolic link in package artifact: ${entry.name}`);
    if (metadata.isDirectory()) await assertNoSymlinks(fullPath);
  }
}

async function createTarball() {
  const { stdout } = await exec(
    process.execPath,
    [npmExecutable(), "pack", "--ignore-scripts", "--json", "--pack-destination", temp],
    { cwd: root, env: childEnvironment, maxBuffer: 10 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.version, sourceManifest.version);
  return path.join(temp, packed.filename);
}

async function listTarball(tarball) {
  const { stdout } = await exec("tar", ["-tzf", tarball], {
    env: childEnvironment,
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries = stdout.split("\n").filter(Boolean);
  assert.ok(entries.length > 0, "package artifact is empty");
  const files = new Set();
  for (const entry of entries) {
    assert.ok(entry.startsWith("package/"), `package entry escapes package/: ${entry}`);
    assert.equal(path.posix.normalize(entry), entry, `non-canonical package entry: ${entry}`);
    const relativePath = entry.slice("package/".length);
    if (relativePath && !relativePath.endsWith("/")) files.add(relativePath);
  }
  return files;
}

try {
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (tag) assert.equal(tag, `v${sourceManifest.version}`, "release tag must match package version");

  const inputs = requestedInputs();
  const tarball = inputs.tarball ?? (await createTarball());
  const files = await listTarball(tarball);
  await exec("tar", ["-xzf", tarball, "-C", temp], { env: childEnvironment });
  const extracted = path.join(temp, "package");
  await assertNoSymlinks(extracted);
  const packedManifest = JSON.parse(await readFile(path.join(extracted, "package.json"), "utf8"));
  assert.deepEqual(packedManifest, sourceManifest, "artifact manifest must exactly match source");

  for (const file of files) {
    assert.ok(
      !/(^|\/)(node_modules|runs|files|\.git|\.env|auth\.json)(\/|$)/.test(file),
      `private artifact in package: ${file}`,
    );
    if (!file.startsWith("dist/")) {
      const [packedBytes, sourceBytes] = await Promise.all([
        readFile(path.join(extracted, file)),
        readFile(path.join(root, file)),
      ]);
      assert.ok(packedBytes.equals(sourceBytes), `packaged static file differs from source: ${file}`);
    }
    if (!file.startsWith("dist/") || !file.endsWith(".js")) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(path.join(extracted, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text));
        assert.ok(files.has(target), `${file} imports missing packaged module ${target}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  for (const file of [
    "dist/index.d.ts",
    "dist/pi/extension.d.ts",
    "dist/server/public/index.html",
    "docs/QUALITY_GATES.md",
    "scripts/check-supply-chain.mjs",
    "skills/flounder/SKILL.md",
    "skills/flounder-pr-gate/SKILL.md",
    "npm-shrinkwrap.json",
    "supply-chain-allowlist.json",
    "LICENSE",
    "SECURITY.md",
  ]) {
    assert.ok(files.has(file), `missing public entrypoint or asset: ${file}`);
  }

  // Reproduce a downstream production install. Never expose the source tree's
  // dev dependency graph to the packaged runtime.
  let consumer;
  let installed;
  if (inputs.installedRoot) {
    installed = inputs.installedRoot;
    consumer = path.resolve(installed, "..", "..");
  } else {
    consumer = path.join(temp, "consumer");
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "flounder-package-contract", private: true }, null, 2)}\n`,
      "utf8",
    );
    await exec(
      process.execPath,
      [
        npmExecutable(),
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...(process.env.FLOUNDER_PACKAGE_OFFLINE === "1" ? ["--offline"] : []),
        tarball,
      ],
      {
        cwd: consumer,
        env: childEnvironment,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    installed = path.join(consumer, "node_modules", sourceManifest.name);
  }
  const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.deepEqual(installedManifest, packedManifest, "installed package manifest must match tarball");
  for (const args of [
    ["dist/cli.js", "--help"],
    ["dist/cli.js", "storage", "--help"],
    ["--input-type=module", "-e", "await import('flounders'); await import('flounders/pi/extension');"],
  ]) {
    await exec(process.execPath, args, {
      cwd: installed,
      env: childEnvironment,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  }
  await exec(process.execPath, [path.join(installed, "scripts/mock-audit.mjs")], {
    cwd: consumer,
    env: childEnvironment,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  await exec(
    process.execPath,
    [path.join(installed, "scripts/check-public-surface.mjs"), "--current-only"],
    { cwd: installed, env: childEnvironment, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  console.log(
    `Package contract passed (${packedManifest.version}; ${files.size} files; exact tarball, clean production install, CLI, exports, UI assets, mock audit, public surface).`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
