#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const [caseId, artifactPath] = process.argv.slice(2);

if (!caseId || !artifactPath) {
  console.error("usage: node scripts/score-prompt-regression.mjs <case-id> <findings-or-report-path>");
  process.exit(2);
}

const registry = JSON.parse(await readFile(path.join(root, "fixtures/prompt-regression/known-bugs.json"), "utf8"));
const entry = registry.cases.find((candidate) => candidate.id === caseId);
if (!entry) {
  console.error(`unknown prompt-regression case: ${caseId}`);
  process.exit(2);
}

const body = await readFile(path.resolve(root, artifactPath), "utf8");
const lowerBody = body.toLowerCase();
const groups = entry.artifactSignalGroups ?? [];
const results = groups.map((group) => {
  const matched = (group.anyOf ?? []).filter((needle) => lowerBody.includes(String(needle).toLowerCase()));
  return {
    name: group.name,
    passed: matched.length > 0,
    matched,
  };
});
const missing = results.filter((result) => !result.passed).map((result) => result.name);
const forbiddenMatches = (entry.forbiddenArtifactSignals ?? []).filter((needle) =>
  lowerBody.includes(String(needle).toLowerCase()),
);
const passed = missing.length === 0 && forbiddenMatches.length === 0;

console.log(JSON.stringify({ caseId, passed, results, missing, forbiddenMatches }, null, 2));
process.exit(passed ? 0 : 1);
