#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RISK_ORDER = { low: 0, medium: 1, high: 2 };
const EXECUTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|fish|ps1|py|rb|php|go|rs|sol|wasm)$/i;
const EXECUTABLE_BASENAME = /^(?:Makefile|GNUmakefile|Dockerfile|Justfile|CMakeLists\.txt|Taskfile\.ya?ml)$/i;
const EXECUTABLE_CONFIG = /(?:^|\/)(?:vite|vitest|webpack|rollup|esbuild|tsup|eslint|prettier|babel|jest|playwright|wrangler)\.config\.[cm]?[jt]s$/i;

const CLASSIFICATION_RULES = [
  {
    matches: (path) =>
      EXECUTABLE_EXTENSION.test(path) ||
      EXECUTABLE_BASENAME.test(path.split("/").at(-1) ?? "") ||
      EXECUTABLE_CONFIG.test(path) ||
      /^(?:\.devcontainer|\.husky|bin|cmd|tools)\//.test(path) ||
      /^src\//.test(path) ||
      /^(scripts|skills|tests|docker|\.githooks)\//.test(path) ||
      /^\.github\/(workflows|actions)\//.test(path) ||
      path === ".github/CODEOWNERS" ||
      /^(package(?:-lock)?\.json|npm-shrinkwrap\.json|supply-chain-allowlist\.json|\.npmrc|AGENTS\.md)$/.test(path),
    risk: "high",
    lenses: ["supply-chain-integrity", "downstream-runtime-safety"],
  },
  {
    matches: (path) => /^src\/(agent|security)\//.test(path),
    risk: "high",
    lenses: ["trust-and-execution-boundaries"],
  },
  {
    matches: (path) => /^src\/llm\//.test(path),
    risk: "high",
    lenses: ["llm-output-boundary", "cross-platform"],
  },
  {
    matches: (path) => /^src\/db\//.test(path),
    risk: "high",
    lenses: ["persisted-data-upgrade"],
  },
  {
    matches: (path) =>
      /^prompts\//.test(path) ||
      /(^|\/)prompts?\.[cm]?[jt]s$/.test(path) ||
      /^scripts\/.*prompt.*\.mjs$/.test(path),
    risk: "high",
    lenses: ["prompt-regression-neutrality", "llm-output-boundary"],
  },
  {
    matches: (path) => /^docker\//.test(path),
    risk: "high",
    lenses: ["trust-and-execution-boundaries", "cross-platform"],
  },
  {
    matches: (path) => path === ".github/workflows/release.yml",
    risk: "high",
    lenses: ["public-release-hygiene"],
  },
  {
    matches: (path) =>
      /^src\/(cli|config|ingest|pi|server)\//.test(path) ||
      /^src\/(cli|config|types)\.ts$/.test(path) ||
      /^(configs|skills|scripts)\//.test(path) ||
      /^\.github\//.test(path) ||
      /^(package|tsconfig).*\.json$/.test(path),
    risk: "medium",
    lenses: ["product-and-architecture"],
  },
];

const COVERAGE_RULES = [
  {
    id: "agent-regression-coverage",
    source: (path) => /^src\/agent\//.test(path) && path !== "src/agent/prompts.ts",
    test: (path) =>
      /^tests\/(agent|confirm|consolidate|coverage|finding|material|prepare|refutation|scope|submission)[^/]*\.test\.mjs$/.test(
        path,
      ),
    message: "Agent behavior changes require a focused agent, scope, confirmation, or finding regression test.",
  },
  {
    id: "security-regression-coverage",
    source: (path) => /^src\/security\//.test(path),
    test: (path) =>
      /^tests\/(security-policy|sandbox|daemon-sandbox|sandbox-image)\.test\.mjs$/.test(path),
    message: "Security or sandbox changes require a focused policy or sandbox regression test.",
  },
  {
    id: "llm-regression-coverage",
    source: (path) => /^src\/llm\//.test(path),
    test: (path) =>
      /^tests\/(llm-client|pi-ai|model-resolver|provider-auth|cli-model-default)\.test\.mjs$/.test(path),
    message: "Model adapter changes require a focused LLM, provider, or model-resolution regression test.",
  },
  {
    id: "database-regression-coverage",
    source: (path) => /^src\/db\//.test(path),
    test: (path) =>
      /^tests\/(db-store|storage|db-upgrade-tag)\.test\.mjs$/.test(path) ||
      path === "scripts/check-db-upgrade.mjs",
    message: "Persistence changes require a focused database or upgrade regression test.",
  },
  {
    id: "source-ingest-regression-coverage",
    source: (path) => /^src\/ingest\//.test(path),
    test: (path) => path === "tests/source-ingest.test.mjs",
    message: "Source ingestion changes require the source-ingest regression test to change with them.",
  },
  {
    id: "prompt-regression-coverage",
    source: (path) =>
      /^prompts\//.test(path) ||
      path === "src/agent/prompts.ts" ||
      path === "scripts/prompt-regression-eval.mjs" ||
      path === "scripts/score-prompt-regression.mjs" ||
      path === "scripts/compare-prompt-regression.mjs",
    test: (path) =>
      path === "tests/prompt-regression.test.mjs" ||
      path === "tests/harness-evolution-fixtures.test.mjs",
    message: "Prompt or prompt-evaluation changes require blind regression and safe/control coverage.",
  },
];

function highestRisk(current, candidate) {
  return RISK_ORDER[candidate] > RISK_ORDER[current] ? candidate : current;
}

function sorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function analyzeChangedFiles(
  inputPaths,
  { diffCheckPassed = true, diffCheckOutput = "", deletedPaths = [] } = {},
) {
  const changedFiles = sorted(inputPaths.filter(Boolean));
  const deletedFiles = sorted(deletedPaths.filter(Boolean));
  const deletedSet = new Set(deletedFiles);
  const testFiles = changedFiles.filter(
    (path) => /^tests\/.*\.test\.mjs$/.test(path) && !deletedSet.has(path),
  );
  const behaviorFiles = changedFiles.filter(
    (path) => /^src\/.*\.(ts|tsx)$/.test(path) && !/\.d\.ts$/.test(path),
  );
  const lenses = new Set();
  const blockers = [];
  const manualGates = new Set();
  let risk = "low";

  for (const path of changedFiles) {
    for (const rule of CLASSIFICATION_RULES) {
      if (!rule.matches(path)) continue;
      risk = highestRisk(risk, rule.risk);
      for (const lens of rule.lenses) lenses.add(lens);
    }

    if (/^(src\/types\.ts|src\/config(?:\/|\.ts)|configs\/)/.test(path)) {
      lenses.add("enum-mode-status-completeness");
    }
    if (/^(README\.md|CONTRIBUTING\.md|SECURITY\.md|docs\/|skills\/|package\.json)/.test(path)) {
      lenses.add("public-release-hygiene");
    }
  }

  if (changedFiles.length === 0) {
    blockers.push({
      id: "no-changes",
      message: "The selected base and head do not contain any changed files.",
      paths: [],
    });
  }

  if (!diffCheckPassed) {
    blockers.push({
      id: "diff-check",
      message: diffCheckOutput.trim() || "git diff --check reported whitespace errors.",
      paths: [],
    });
  }

  for (const rule of COVERAGE_RULES) {
    const affectedPaths = changedFiles.filter(rule.source);
    if (
      affectedPaths.length > 0 &&
      !changedFiles.some((path) => !deletedSet.has(path) && rule.test(path))
    ) {
      blockers.push({ id: rule.id, message: rule.message, paths: affectedPaths });
    }
  }

  const coveredBehaviorFiles = new Set(
    COVERAGE_RULES.flatMap((rule) => changedFiles.filter(rule.source)),
  );
  const uncoveredBehaviorFiles = behaviorFiles.filter((path) => !coveredBehaviorFiles.has(path));
  if (uncoveredBehaviorFiles.length > 0 && testFiles.length === 0) {
    blockers.push({
      id: "behavior-regression-coverage",
      message: "Behavior-changing TypeScript requires at least one focused regression test in the pull request.",
      paths: uncoveredBehaviorFiles,
    });
  }

  if (risk === "high") manualGates.add("high-risk-maintainer-review");
  if (changedFiles.length > 0) manualGates.add("maintainer-semantic-review");
  if (lenses.has("prompt-regression-neutrality")) manualGates.add("prompt-regression-evidence");
  if (lenses.has("persisted-data-upgrade")) manualGates.add("released-database-upgrade-review");
  if (lenses.has("cross-platform")) manualGates.add("linux-and-windows-verification");
  if (lenses.has("trust-and-execution-boundaries")) manualGates.add("security-boundary-review");
  if (lenses.has("public-release-hygiene")) manualGates.add("public-surface-review");
  if (lenses.has("supply-chain-integrity")) manualGates.add("supply-chain-provenance-review");
  if (lenses.has("downstream-runtime-safety")) manualGates.add("downstream-runtime-threat-review");

  const normalizedBlockers = blockers
    .map((blocker) => ({ ...blocker, paths: sorted(blocker.paths) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const normalizedManualGates = sorted(manualGates);

  return {
    changedFiles,
    deletedFiles,
    risk,
    lenses: sorted(lenses),
    evidence: {
      diffCheck: diffCheckPassed ? "passed" : "failed",
      changedTests: testFiles,
    },
    blockers: normalizedBlockers,
    manualGates: normalizedManualGates,
    verdict:
      normalizedBlockers.length > 0
        ? "failed"
        : normalizedManualGates.length > 0
          ? "manual-review-required"
          : "passed",
  };
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function resolveRef(ref) {
  const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Cannot resolve Git ref: ${ref}`);
  }
  return result.stdout.trim();
}

function readChangedFiles(baseSha, headSha, diffFilter) {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `--diff-filter=${diffFilter}`,
      `${baseSha}...${headSha}`,
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "Cannot read changed files.");
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function parseArgs(argv) {
  const options = { baseRef: "origin/main", headRef: "HEAD", output: undefined, advisory: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--advisory") {
      options.advisory = true;
      continue;
    }
    if (arg === "--base-ref" || arg === "--head-ref" || arg === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--base-ref") options.baseRef = value;
      if (arg === "--head-ref") options.headRef = value;
      if (arg === "--output") options.output = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function runQualityGate({ baseRef, headRef }) {
  const baseSha = resolveRef(baseRef);
  const headSha = resolveRef(headRef);
  const changedFiles = readChangedFiles(baseSha, headSha, "ACMD");
  const deletedFiles = readChangedFiles(baseSha, headSha, "D");
  const diffCheck = runGit(["diff", "--check", `${baseSha}...${headSha}`]);
  const analysis = analyzeChangedFiles(changedFiles, {
    diffCheckPassed: diffCheck.status === 0,
    diffCheckOutput: `${diffCheck.stdout}${diffCheck.stderr}`,
    deletedPaths: deletedFiles,
  });
  return {
    schemaVersion: 1,
    baseRef,
    headRef,
    baseSha,
    headSha,
    ...analysis,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runQualityGate(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(serialized);
    if (options.output) writeFileSync(resolve(options.output), serialized, "utf8");
    if (!options.advisory && report.verdict === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`PR quality gate error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
