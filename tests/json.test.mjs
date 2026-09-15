import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonArray, extractJsonObject, repairUnbalancedJson } from "../dist/util/json.js";

test("extractJsonArray tolerates markdown fences and prose", () => {
  const value = extractJsonArray('```json\n[{"id":"a"}]\n```\nextra');
  assert.deepEqual(value, [{ id: "a" }]);
});

test("extractJsonObject returns undefined on invalid output", () => {
  assert.equal(extractJsonObject("not json"), undefined);
});

test("repairUnbalancedJson appends only the missing tail closers", () => {
  const objectTail = '{"tool":"read","args":{"path":"External.sol"}';
  assert.equal(repairUnbalancedJson(objectTail), '{"tool":"read","args":{"path":"External.sol"}}');
  assert.deepEqual(extractJsonObject(repairUnbalancedJson(objectTail)), { tool: "read", args: { path: "External.sol" } });

  const arrayTail = '{"a":[1,2]';
  assert.equal(repairUnbalancedJson(arrayTail), '{"a":[1,2]}');
  assert.deepEqual(extractJsonObject(repairUnbalancedJson(arrayTail)), { a: [1, 2] });

  const twoMissing = '{"tool":"read","args":{"targets":[{"path":"a.sol"}]';
  assert.deepEqual(extractJsonObject(repairUnbalancedJson(twoMissing)), { tool: "read", args: { targets: [{ path: "a.sol" }] } });
});

test("repairUnbalancedJson leaves well-formed JSON untouched", () => {
  const valid = '{"tool":"read","args":{"path":"a.sol"}}';
  assert.equal(repairUnbalancedJson(valid), valid);
  // braces inside strings must not be counted as structure
  const bracesInString = '{"thought":"use { and } in the payload"}';
  assert.equal(repairUnbalancedJson(bracesInString), bracesInString);
  // surrounding whitespace is trimmed, nothing else changes
  assert.equal(repairUnbalancedJson(`  ${valid}  `), valid);
});

test("repairUnbalancedJson rejects everything that is not a missing tail closer", () => {
  // extra closer
  assert.equal(repairUnbalancedJson('{"a":1}}'), '{"a":1}}');
  assert.equal(extractJsonObject(repairUnbalancedJson('{"a":1}}')), undefined);
  // string left open
  assert.equal(repairUnbalancedJson('{"a":"abc'), '{"a":"abc');
  assert.equal(repairUnbalancedJson('{"a":"abc}'), '{"a":"abc}');
  assert.equal(extractJsonObject(repairUnbalancedJson('{"a":"abc}')), undefined);
  // text after the object
  assert.equal(repairUnbalancedJson('{"a":1} and more prose'), '{"a":1} and more prose');
  // prose around the object: repair does not touch it, and extractJsonObject's
  // own prose tolerance (scan for the outermost braces) is what recovers it
  assert.equal(repairUnbalancedJson('Sure: {"a":1}'), 'Sure: {"a":1}');
  assert.deepEqual(extractJsonObject(repairUnbalancedJson('Sure: {"a":1}')), { a: 1 });
  // mismatched delimiter: repaired to `{"a":[1,2}}`, which still does not parse
  assert.equal(extractJsonObject(repairUnbalancedJson('{"a":[1,2}')), undefined);
  // not an object at all
  assert.equal(repairUnbalancedJson(""), "");
  assert.equal(repairUnbalancedJson("[1,2]"), "[1,2]");
});
