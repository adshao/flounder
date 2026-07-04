import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCairoSandboxSpec } from "../scripts/cairo-sandbox-image.mjs";

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("Cairo sandbox target builder reads Starknet Staking .tool-versions", async () => {
  const dir = await tempDir("flounder-cairo-image-staking-");
  try {
    await writeFile(path.join(dir, ".tool-versions"), "scarb 2.12.0\nstarknet-foundry 0.49.0\n");
    const spec = buildCairoSandboxSpec({ target: dir, root: process.cwd() });

    assert.equal(spec.image, "flounder-sandbox:cairo-scarb-2.12.0-snfoundry-0.49.0");
    assert.equal(spec.versions.scarb, "2.12.0");
    assert.equal(spec.versions["starknet-foundry"], "0.49.0");
    assert.match(spec.args.join(" "), /SCARB_VERSION=2\.12\.0/);
    assert.match(spec.args.join(" "), /STARKNET_FOUNDRY_VERSION=0\.49\.0/);
    assert.match(spec.args.join(" "), /6661acb0774dc1e81de2abd08fabb2d73f27bddbce10ff6f739cbcdb8795ae79/);
    assert.match(spec.args.join(" "), /f083666f7bdb626743dc2973d7caabea92c94814043b112cc5907b7833b53909/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cairo sandbox target builder reads StarkGate .tool-versions", async () => {
  const dir = await tempDir("flounder-cairo-image-starkgate-");
  try {
    await writeFile(path.join(dir, ".tool-versions"), "scarb 2.15.1\nstarknet-foundry 0.55.0\n");
    const spec = buildCairoSandboxSpec({ target: dir, runtime: "container", root: process.cwd() });

    assert.equal(spec.runtime, "container");
    assert.equal(spec.program, "container");
    assert.equal(spec.image, "flounder-sandbox:cairo-scarb-2.15.1-snfoundry-0.55.0");
    assert.match(spec.args.join(" "), /SCARB_VERSION=2\.15\.1/);
    assert.match(spec.args.join(" "), /STARKNET_FOUNDRY_VERSION=0\.55\.0/);
    assert.match(spec.args.join(" "), /a12542f28c5427a85b122784341926e1371454669d5881a315b5cab209006608/);
    assert.match(spec.args.join(" "), /306b61ff2842abf8a9da0101a37379faa15ad63fa1b6dc4bd4b0635b24036b9e/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cairo sandbox target builder fails closed on unreviewed Starknet Foundry checksums", async () => {
  const dir = await tempDir("flounder-cairo-image-unknown-");
  try {
    await writeFile(path.join(dir, ".tool-versions"), "scarb 2.16.0\nstarknet-foundry 0.56.0\n");
    assert.throws(
      () => buildCairoSandboxSpec({ target: dir, root: process.cwd() }),
      /not in the reviewed checksum table/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
