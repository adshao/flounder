#!/usr/bin/env node
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, runPipeline } from "../dist/index.js";

const out = await mkdtemp(path.join(os.tmpdir(), "fsa-blind-"));
const cfg = defaultConfig();
cfg.targetName = "blind-discovery";
cfg.sourcePaths = ["fixtures/halo2_scalar_mul_binding.rs"];
cfg.outputDir = out;
cfg.dryRun = true;

const result = await runPipeline(cfg);
const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
const bindingItems = checklist.filter((item) => item.seeder === "halo2_advice_binding");

if (bindingItems.length !== 1) {
  throw new Error(`Expected exactly one halo2_advice_binding item, found ${bindingItems.length}`);
}

const body = JSON.stringify(bindingItems[0]);
if (!/missing_constraint/.test(bindingItems[0].failureMode) || !/constrained to that input/.test(bindingItems[0].securityProperty)) {
  throw new Error("Blind discovery item did not preserve the expected generic missing-constraint invariant.");
}
if (!/scalar\/point-binding context/.test(body)) {
  throw new Error("Blind discovery item did not explain the generic code shape it found.");
}

console.log("Blind discovery check passed.");
