import assert from "node:assert/strict";
import test from "node:test";
import { projectRunDefaultsToPipeline } from "../dist/server/app.js";

test("bug bounty project Run continues through Confirm and Report when source is already staged", () => {
  assert.equal(projectRunDefaultsToPipeline({
    requestedPipeline: false,
    hasPreparedWorkspace: false,
    hasSourcePaths: true,
    engagement: { kind: "bug-bounty" },
  }), true);
});

test("plain source-review project Run remains a sealed source audit by default", () => {
  assert.equal(projectRunDefaultsToPipeline({
    requestedPipeline: false,
    hasPreparedWorkspace: false,
    hasSourcePaths: true,
  }), false);
});
