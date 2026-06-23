#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "../dist/agent/audit.js";
import { defaultConfig } from "../dist/config.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";

const currentFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(currentFile);
const root = path.resolve(__dirname, "..");
const registryPath = path.join(root, "fixtures/prompt-regression/known-bugs.json");

const USAGE = `
Usage:
  node scripts/prompt-regression-eval.mjs --dry-run [--case <id>] [--samples N]
  node scripts/prompt-regression-eval.mjs --live --variant current [--case <id>] [--samples N]

Options:
  --case <id>          Run only one known-bug case. May be repeated.
  --fixture-set <set>  positive | negative | control | all. Default: positive.
  --samples <n>        Independent samples per case. Default: 1.
  --variant <name>     Label for A/B comparison output. Default: current.
  --mode <mode>        breadth | deep | map-dig. Default: deep. map-dig runs synthesis by default.
  --no-synthesize      Disable the post-dig synthesis phase for isolated dig testing. Requires --mode map-dig.
  --provider <name>    Live provider. Default: openai-codex.
  --model <name>       Live model. Default: config default.
  --thinking <level>   minimal | low | medium | high | xhigh. Default: xhigh.
  --max-steps <n>      Breadth/deep step cap. Default: 30.
  --map-steps <n>      Map step cap for map-dig. Default: 30.
  --dig-steps <n>      Dig step cap for map-dig. Default: 35.
  --max-scopes <n>     Scope cap for map-dig. Default: 3.
  --out <dir>          Output directory. Default: runs/prompt-regression.
  --mock-llm           Use deterministic mock LLM for harness plumbing only.
  --live               Allow real provider calls. Required unless --dry-run or --mock-llm is set.
  --dry-run            Print the run plan as JSON and do not call any model.
`.trim();

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function readFlag(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readFlags(name) {
  const args = process.argv.slice(2);
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
    i += 1;
  }
  return values;
}

function readIntFlag(name, fallback) {
  const value = readFlag(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function resolveSynthesize(mode) {
  const forceSynthesize = hasFlag("--synthesize");
  const noSynthesize = hasFlag("--no-synthesize");
  if (forceSynthesize && noSynthesize) throw new Error("--synthesize and --no-synthesize cannot be combined");
  if ((forceSynthesize || noSynthesize) && mode !== "map-dig") {
    throw new Error(`${forceSynthesize ? "--synthesize" : "--no-synthesize"} requires --mode map-dig`);
  }
  return mode === "map-dig" && !noSynthesize;
}

function validateMode(value) {
  if (value === "breadth" || value === "deep" || value === "map-dig") return value;
  throw new Error(`unsupported --mode ${value}`);
}

function validateFixtureSet(value) {
  if (value === "positive" || value === "negative" || value === "control" || value === "all") return value;
  throw new Error(`unsupported --fixture-set ${value}`);
}

function validateThinking(value) {
  if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) return value;
  throw new Error(`unsupported --thinking ${value}`);
}

function validateLabel(name, value) {
  if (/^[A-Za-z0-9._-]{1,80}$/.test(value)) return value;
  throw new Error(`${name} must contain only letters, numbers, dot, underscore, or dash`);
}

async function loadRegistry() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  if (![1, 2].includes(registry.version) || !Array.isArray(registry.cases)) {
    throw new Error("unsupported prompt regression registry");
  }
  return registry;
}

function selectCases(registry, requestedIds) {
  if (requestedIds.length === 0) return registry.cases;
  const byId = new Map(registry.cases.map((entry) => [entry.id, entry]));
  return requestedIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`unknown prompt regression case: ${id}`);
    return entry;
  });
}

function fixturePathOf(fixture) {
  return typeof fixture === "string" ? fixture : fixture.path;
}

function fixtureRationaleOf(fixture) {
  return typeof fixture === "string" ? undefined : fixture.rationale ?? fixture.purpose;
}

function fixtureSlug(fixture) {
  return path
    .basename(fixturePathOf(fixture))
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 80);
}

function selectedFixtureGroups(entry, registry, fixtureSet) {
  const groups = [];
  if (fixtureSet === "positive" || fixtureSet === "all") {
    groups.push({
      fixtureSet: "positive",
      fixtureId: "positive",
      sourcePaths: entry.positiveFixtures ?? entry.requiredFixtures,
    });
  }
  if (fixtureSet === "negative" || fixtureSet === "all") {
    for (const fixture of entry.negativeFixtures ?? []) {
      groups.push({
        fixtureSet: "negative",
        fixtureId: fixtureSlug(fixture),
        sourcePaths: [fixturePathOf(fixture)],
        rationale: fixtureRationaleOf(fixture),
      });
    }
  }
  if (fixtureSet === "control" || fixtureSet === "all") {
    const controls = [...(registry.sharedControlFixtures ?? []), ...(entry.controlFixtures ?? [])];
    const seen = new Set();
    for (const fixture of controls) {
      const fixturePath = fixturePathOf(fixture);
      if (seen.has(fixturePath)) continue;
      seen.add(fixturePath);
      groups.push({
        fixtureSet: "control",
        fixtureId: fixtureSlug(fixture),
        sourcePaths: [fixturePath],
        rationale: fixtureRationaleOf(fixture),
      });
    }
  }
  return groups;
}

function focusFor() {
  return [
    "Audit the supplied source as an authorized blind target.",
    "Derive the relevant security obligations from the code and any supplied design material.",
    "Do not assume a historical incident, target name, address, or proprietary report.",
    "Do not assume a bug exists; discharge obligations when the code binds the value or capability correctly.",
    "A valid result must explain the general bug class and, if possible, confirm it with a local attacker-real PoC.",
  ].join(" ");
}

function neutralSourcePath(runKey, sourceIndex, sourcePath, options) {
  const ext = path.extname(sourcePath) || ".txt";
  return path.join(root, options.out, "_neutral-inputs", runKey, `source_${sourceIndex + 1}${ext}`);
}

export function stripLineComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const marker = line.indexOf("//");
      return marker >= 0 ? line.slice(0, marker).trimEnd() : line;
    })
    .join("\n");
}

async function materializeNeutralSources(sourcePaths, neutralPaths) {
  for (let i = 0; i < sourcePaths.length; i++) {
    const sourcePath = path.join(root, sourcePaths[i]);
    const neutralPath = neutralPaths[i];
    await mkdir(path.dirname(neutralPath), { recursive: true });
    await writeFile(neutralPath, stripLineComments(await readFile(sourcePath, "utf8")));
  }
}

function buildConfig(entry, fixtureGroup, sampleIndex, options, planIds) {
  const cfg = defaultConfig();
  const runKey = `c${planIds.caseIndex + 1}-f${planIds.fixtureIndex + 1}-s${sampleIndex}`;
  cfg.targetName = `prompt-regression-${runKey}`;
  cfg.sourcePaths = fixtureGroup.sourcePaths.map((fixture, idx) => neutralSourcePath(runKey, idx, fixture, options));
  cfg.corpusPaths = [];
  cfg.outputDir = path.resolve(root, options.out);
  cfg.provider = options.provider;
  cfg.thinkingLevel = options.thinking;
  cfg.auditMaxSteps = options.maxSteps;
  cfg.auditMapSteps = options.mapSteps;
  cfg.auditDigSteps = options.digSteps;
  cfg.auditMaxScopes = options.maxScopes;
  cfg.auditPrepare = false;
  cfg.auditRefute = false;
  cfg.auditAppeal = false;
  cfg.auditSynthesize = options.synthesize;
  cfg.auditChallengeDischarges = false;
  cfg.auditScopeNote = focusFor();
  cfg.sandboxBackend = "host";
  cfg.sandboxAllowHostFallback = true;
  cfg.sandboxConfirmNetwork = "none";
  cfg.sandboxPrepareNetwork = "none";
  cfg.dryRun = options.dryRun;
  if (options.model) cfg.auditModel = options.model;

  if (options.mode === "deep") {
    cfg.auditDeep = true;
    cfg.auditDeepFocus = cfg.sourcePaths.map((sourcePath) => path.basename(sourcePath)).join(", ");
  } else if (options.mode === "map-dig") {
    cfg.auditDeep = true;
    cfg.auditDeepFocus = undefined;
  } else {
    cfg.auditDeep = false;
    cfg.auditDeepFocus = undefined;
  }
  return cfg;
}

function renderPlanEntry(entry, fixtureGroup, sampleIndex, cfg, options) {
  return {
    caseId: entry.id,
    label: entry.label,
    fixtureSet: fixtureGroup.fixtureSet,
    fixtureId: fixtureGroup.fixtureId,
    expectedOutcome: fixtureGroup.fixtureSet === "positive" ? "detect-positive" : "reject-positive",
    ...(fixtureGroup.rationale ? { rationale: fixtureGroup.rationale } : {}),
    sample: sampleIndex,
    variant: options.variant,
    mode: options.mode,
    provider: cfg.provider,
    model: cfg.auditModel,
    thinking: cfg.thinkingLevel,
    synthesize: cfg.auditSynthesize === true,
    targetName: cfg.targetName,
    sourcePaths: cfg.sourcePaths.map((sourcePath) => path.relative(root, sourcePath)),
    originalSourcePaths: fixtureGroup.sourcePaths,
    outputDir: path.relative(root, cfg.outputDir),
    maxSteps: cfg.auditMaxSteps,
    mapSteps: cfg.auditMapSteps,
    digSteps: cfg.auditDigSteps,
    maxScopes: cfg.auditMaxScopes,
  };
}

export function confirmedFindingCount(text) {
  const match = text.match(/Confirmed findings:\s*(\d+)/i);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

export function scoreArtifact(entry, text, fixtureSet) {
  const lowerText = text.toLowerCase();
  const groups = entry.artifactSignalGroups.map((group) => {
    const matched = group.anyOf.filter((needle) => lowerText.includes(String(needle).toLowerCase()));
    return {
      name: group.name,
      passed: matched.length > 0,
      matched,
      anyOf: group.anyOf,
    };
  });
  const required = groups.length;
  const passed = groups.filter((group) => group.passed).length;
  const forbiddenMatches = (entry.forbiddenArtifactSignals ?? []).filter((needle) =>
    lowerText.includes(String(needle).toLowerCase()),
  );
  const positiveScore = passed === required && forbiddenMatches.length === 0;
  const confirmedFindings = confirmedFindingCount(text);
  const hasConfirmedFindings = typeof confirmedFindings === "number" && confirmedFindings > 0;
  const expectedOutcome = fixtureSet === "positive" ? "detect-positive" : "reject-positive";
  return {
    caseId: entry.id,
    label: entry.label,
    fixtureSet,
    expectedOutcome,
    passed: fixtureSet === "positive" ? positiveScore : !positiveScore && !hasConfirmedFindings,
    positiveScore,
    confirmedFindings,
    passedGroups: passed,
    requiredGroups: required,
    forbiddenMatches,
    groups,
  };
}

async function readRunArtifact(runDir) {
  const candidates = ["audit_report.md", "audit_hypotheses.json", "audit_findings.json", "summary.json"];
  for (const name of candidates) {
    try {
      const content = await readFile(path.join(runDir, name), "utf8");
      return { name, content };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`no scoreable artifact found in ${runDir}`);
}

function printHelpAndExit() {
  console.log(USAGE);
  process.exit(0);
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) printHelpAndExit();
  const mode = validateMode(readFlag("--mode") ?? "deep");

  const options = {
    dryRun: hasFlag("--dry-run"),
    live: hasFlag("--live"),
    mockLlm: hasFlag("--mock-llm"),
    variant: validateLabel("--variant", readFlag("--variant") ?? "current"),
    mode,
    synthesize: resolveSynthesize(mode),
    fixtureSet: validateFixtureSet(readFlag("--fixture-set") ?? "positive"),
    provider: readFlag("--provider") ?? "openai-codex",
    model: readFlag("--model"),
    thinking: validateThinking(readFlag("--thinking") ?? "xhigh"),
    samples: readIntFlag("--samples", 1),
    maxSteps: readIntFlag("--max-steps", 30),
    mapSteps: readIntFlag("--map-steps", 30),
    digSteps: readIntFlag("--dig-steps", 35),
    maxScopes: readIntFlag("--max-scopes", 3),
    out: readFlag("--out") ?? "runs/prompt-regression",
  };

  if (!options.dryRun && !options.live && !options.mockLlm) {
    throw new Error("refusing to call a model without --live or --mock-llm; use --dry-run to inspect the plan");
  }
  const registry = await loadRegistry();
  const cases = selectCases(registry, readFlags("--case"));
  const plan = [];
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    const entry = cases[caseIndex];
    const fixtureGroups = selectedFixtureGroups(entry, registry, options.fixtureSet);
    for (let fixtureIndex = 0; fixtureIndex < fixtureGroups.length; fixtureIndex++) {
      const fixtureGroup = fixtureGroups[fixtureIndex];
      for (let sample = 1; sample <= options.samples; sample++) {
        const cfg = buildConfig(entry, fixtureGroup, sample, options, { caseIndex, fixtureIndex });
        plan.push({ entry, fixtureGroup, sample, cfg, publicPlan: renderPlanEntry(entry, fixtureGroup, sample, cfg, options) });
      }
    }
  }

  if (options.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          dryRun: true,
          registryVersion: registry.version,
          variant: options.variant,
          runs: plan.map((item) => item.publicPlan),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  await mkdir(path.resolve(root, options.out), { recursive: true });
  const results = [];
  for (const item of plan) {
    await materializeNeutralSources(item.fixtureGroup.sourcePaths, item.cfg.sourcePaths);
    const llm = options.mockLlm ? new MockAuditLlmClient() : undefined;
    const startedAt = new Date().toISOString();
    const run = await runAudit(item.cfg, { kind: "run", ...(llm ? { llm } : {}) });
    const artifact = await readRunArtifact(run.runDir);
    const score = scoreArtifact(item.entry, artifact.content, item.fixtureGroup.fixtureSet);
    const result = {
      ...item.publicPlan,
      startedAt,
      finishedAt: new Date().toISOString(),
      runDir: path.relative(root, run.runDir),
      scoreArtifact: artifact.name,
      score,
    };
    results.push(result);
    await writeFile(path.join(run.runDir, "prompt_regression_score.json"), JSON.stringify(result, null, 2) + "\n");
    const status = score.passed ? "PASS" : "FAIL";
    console.log(`${status} ${item.entry.id} fixtureSet=${item.fixtureGroup.fixtureSet} fixtureId=${item.fixtureGroup.fixtureId} sample=${item.sample} artifact=${path.relative(root, run.runDir)}/${artifact.name}`);
  }

  const summary = {
    registryVersion: registry.version,
    variant: options.variant,
    mode: options.mode,
    synthesize: options.synthesize,
    fixtureSet: options.fixtureSet,
    provider: options.provider,
    model: options.model ?? "(config default)",
    thinking: options.thinking,
    pass: results.every((result) => result.score.passed),
    passedRuns: results.filter((result) => result.score.passed).length,
    totalRuns: results.length,
    results,
  };
  const summaryPath = path.join(path.resolve(root, options.out), `prompt_regression_summary_${options.variant}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`summary=${path.relative(root, summaryPath)}`);

  if (!summary.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
