import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("default sandbox image includes baseline source-inspection tools", async () => {
  const dockerfile = await readFile(new URL("../docker/flounder-sandbox.Dockerfile", import.meta.url), "utf8");
  for (const pkg of ["bash", "cmake", "findutils", "grep", "jq", "git", "ninja-build", "ripgrep", "sed"]) {
    assert.match(dockerfile, new RegExp(`\\b${pkg}\\b`), `sandbox image should install ${pkg}`);
  }
});

test("foundry tools are copied into the non-root sandbox PATH", async () => {
  const dockerfile = await readFile(new URL("../docker/flounder-sandbox.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /install -m 0755 "\$\{FOUNDRY_DIR\}\/bin\/forge" \/usr\/local\/bin\/forge/);
  assert.doesNotMatch(dockerfile, /ln -sf "\$\{FOUNDRY_DIR\}\/bin\/forge" \/usr\/local\/bin\/forge/);
});

test("default sandbox image includes common JavaScript package managers", async () => {
  const dockerfile = await readFile(new URL("../docker/flounder-sandbox.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /npm install -g yarn@1\.22\.22 pnpm@9\.15\.9/);
  assert.match(dockerfile, /yarn --version/);
  assert.match(dockerfile, /pnpm --version/);
});
