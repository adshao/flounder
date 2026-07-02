import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("confirm does not preload the full source tree into memory", async () => {
  const source = await readFile(new URL("../src/agent/confirm.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bloadSource\s*\(/, "confirm must read files on demand from the sandbox workspace");
  assert.match(source, /renderConfirmFileManifest/, "confirm should build a lightweight file manifest from workspace paths");
});
