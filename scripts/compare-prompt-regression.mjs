#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const [baselinePath, candidatePath] = process.argv.slice(2);

if (!baselinePath || !candidatePath) {
  console.error("usage: node scripts/compare-prompt-regression.mjs <baseline-summary.json> <candidate-summary.json>");
  process.exit(2);
}

async function loadSummary(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const summary = JSON.parse(await readFile(absolute, "utf8"));
  if (!Array.isArray(summary.results)) throw new Error(`${filePath} is not a prompt regression summary`);
  return { path: filePath, summary };
}

function resultKey(result) {
  return [result.caseId, result.fixtureSet ?? "positive", result.fixtureId ?? "positive"].join("::");
}

function groupResults(results) {
  const groups = new Map();
  for (const result of results) {
    const key = resultKey(result);
    const group =
      groups.get(key) ??
      {
        key,
        caseId: result.caseId,
        label: result.label,
        fixtureSet: result.fixtureSet ?? "positive",
        fixtureId: result.fixtureId ?? "positive",
        expectedOutcome: result.expectedOutcome ?? (result.fixtureSet === "positive" ? "detect-positive" : "reject-positive"),
        totalRuns: 0,
        passedRuns: 0,
        positiveScoreRuns: 0,
        forbiddenMatches: [],
        missingGroups: [],
      };
    group.totalRuns += 1;
    if (result.score?.passed) group.passedRuns += 1;
    if (result.score?.positiveScore) group.positiveScoreRuns += 1;
    for (const match of result.score?.forbiddenMatches ?? []) group.forbiddenMatches.push(match);
    for (const scoreGroup of result.score?.groups ?? []) {
      if (!scoreGroup.passed) group.missingGroups.push(scoreGroup.name);
    }
    groups.set(key, group);
  }
  return groups;
}

function rate(passed, total) {
  return total === 0 ? null : passed / total;
}

function uniq(values) {
  return [...new Set(values)].sort();
}

const baseline = await loadSummary(baselinePath);
const candidate = await loadSummary(candidatePath);
const baselineGroups = groupResults(baseline.summary.results);
const candidateGroups = groupResults(candidate.summary.results);
const keys = [...new Set([...baselineGroups.keys(), ...candidateGroups.keys()])].sort();

const comparisons = keys.map((key) => {
  const base = baselineGroups.get(key);
  const cand = candidateGroups.get(key);
  const template = cand ?? base;
  const baselinePassRate = base ? rate(base.passedRuns, base.totalRuns) : null;
  const candidatePassRate = cand ? rate(cand.passedRuns, cand.totalRuns) : null;
  const delta =
    baselinePassRate === null || candidatePassRate === null ? null : Number((candidatePassRate - baselinePassRate).toFixed(4));
  return {
    key,
    caseId: template.caseId,
    label: template.label,
    fixtureSet: template.fixtureSet,
    fixtureId: template.fixtureId,
    expectedOutcome: template.expectedOutcome,
    baseline: base
      ? {
          totalRuns: base.totalRuns,
          passedRuns: base.passedRuns,
          passRate: baselinePassRate,
          positiveScoreRuns: base.positiveScoreRuns,
          forbiddenMatches: uniq(base.forbiddenMatches),
          missingGroups: uniq(base.missingGroups),
        }
      : null,
    candidate: cand
      ? {
          totalRuns: cand.totalRuns,
          passedRuns: cand.passedRuns,
          passRate: candidatePassRate,
          positiveScoreRuns: cand.positiveScoreRuns,
          forbiddenMatches: uniq(cand.forbiddenMatches),
          missingGroups: uniq(cand.missingGroups),
        }
      : null,
    deltaPassRate: delta,
    regression: delta !== null && delta < 0,
  };
});

const regressions = comparisons.filter((item) => item.regression);
const output = {
  baseline: {
    path: baseline.path,
    variant: baseline.summary.variant,
    totalRuns: baseline.summary.totalRuns,
    passedRuns: baseline.summary.passedRuns,
  },
  candidate: {
    path: candidate.path,
    variant: candidate.summary.variant,
    totalRuns: candidate.summary.totalRuns,
    passedRuns: candidate.summary.passedRuns,
  },
  pass: regressions.length === 0,
  regressions,
  comparisons,
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
process.exitCode = output.pass ? 0 : 1;
