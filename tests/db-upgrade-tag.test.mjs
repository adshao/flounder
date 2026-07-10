import assert from "node:assert/strict";
import test from "node:test";
import { selectDbUpgradeTag } from "../scripts/select-db-upgrade-tag.mjs";

function fakeGit({ head, tags }) {
  return async (_program, args) => {
    if (args[0] === "tag") {
      assert.equal(args.includes("--merged"), true, "release candidates must be limited to ancestors of HEAD");
      assert.equal(args.includes("HEAD"), true);
      return { stdout: `${Object.keys(tags).join("\n")}\n` };
    }
    if (args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (args[0] === "rev-list") return { stdout: `${tags[args[3]]}\n` };
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

test("database upgrade tag selection uses the latest release on an untagged commit", async () => {
  const tag = await selectDbUpgradeTag({
    cwd: "/repo",
    exec: fakeGit({ head: "current", tags: { "v0.2.0": "release-2", "v0.1.2": "release-1" } }),
  });
  assert.equal(tag, "v0.2.0");
});

test("database upgrade tag selection skips tags that point at the release commit under test", async () => {
  const tag = await selectDbUpgradeTag({
    cwd: "/repo",
    exec: fakeGit({ head: "current", tags: { "v0.3.0": "current", "v0.2.0": "release-2", "v0.1.2": "release-1" } }),
  });
  assert.equal(tag, "v0.2.0");
});

test("database upgrade tag selection asks git for merged release tags only", async () => {
  const tag = await selectDbUpgradeTag({
    cwd: "/repo",
    exec: fakeGit({ head: "feature", tags: { "v0.2.0": "ancestor" } }),
  });
  assert.equal(tag, "v0.2.0");
});

test("database upgrade tag selection honors an explicit baseline", async () => {
  assert.equal(await selectDbUpgradeTag({ cwd: "/repo", requestedTag: "v0.1.0", exec: async () => { throw new Error("must not execute git"); } }), "v0.1.0");
});
