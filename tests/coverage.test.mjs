import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { summarizeChecklist } from "../dist/reports/coverage.js";

test("checklist coverage uses repository-relative public file locations", () => {
  const absolute = path.resolve("fixtures/halo2_missing_constraint.rs");
  const coverage = summarizeChecklist([
    {
      id: "a",
      location: `${absolute}:5`,
      securityProperty: "Property",
      failureMode: "missing_constraint",
      why: "Why",
      seeder: "static",
    },
    {
      id: "b",
      location: "fixtures/halo2_missing_constraint.rs:6",
      securityProperty: "Property",
      failureMode: "missing_constraint",
      why: "Why",
    },
  ]);
  assert.deepEqual(coverage.bySourceFile, { "fixtures/halo2_missing_constraint.rs": 2 });
});
