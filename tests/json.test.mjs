import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonArray, extractJsonObject } from "../dist/util/json.js";

test("extractJsonArray tolerates markdown fences and prose", () => {
  const value = extractJsonArray('```json\n[{"id":"a"}]\n```\nextra');
  assert.deepEqual(value, [{ id: "a" }]);
});

test("extractJsonObject returns undefined on invalid output", () => {
  assert.equal(extractJsonObject("not json"), undefined);
});
