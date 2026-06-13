import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, resolveRole, withRole, normalizeRoleModels } from "../dist/config.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { buildTools, ingestFindingsFromScratch, newSession, dedupeFindings } from "../dist/agent/tools.js";
import { runHunt } from "../dist/agent/hunt.js";
import { runHuntLoop, isTransientError } from "../dist/agent/loop.js";
import { buildDeepKickoff, HUNT_DEEP_SYSTEM } from "../dist/agent/prompts.js";
import { runDifferentialConfirmation } from "../dist/agent/differential.js";
import { runRefutation } from "../dist/agent/refutation.js";
import { isPiSessionProvider, mapThinkingLevel } from "../dist/agent/pi-session.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { RunLogger } from "../dist/trace/logger.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "fsa-agent-"));
}

async function tempLogger(baseDir) {
  const logger = new RunLogger(baseDir, "agent-test", new Date(), { streamEvents: false });
  await logger.init();
  return logger;
}

function tool(name) {
  return buildTools().find((entry) => entry.name === name);
}

test("driver routing: real pi providers use the continuous session, mock/CLI fallbacks use the loop", () => {
  assert.equal(isPiSessionProvider("openai-codex"), true);
  assert.equal(isPiSessionProvider("claude-code"), false);
  assert.equal(isPiSessionProvider("codex-cli"), false);
  assert.equal(isPiSessionProvider("mock"), false);
  assert.equal(isPiSessionProvider("not-a-real-provider"), false);
});

test("pi session preserves the configured xhigh thinking level", () => {
  assert.equal(defaultConfig().thinkingLevel, "xhigh");
  assert.equal(mapThinkingLevel("minimal"), "minimal");
  assert.equal(mapThinkingLevel("xhigh"), "xhigh");
});

test("project memory persists notes and recalls by keyword overlap", async () => {
  const dir = await tempDir();
  try {
    const memory = new ProjectMemory(path.join(dir, "memory.jsonl"));
    await memory.remember({ note: "nullifier reuse possible in spend.rs:42", kind: "finding", tags: ["nullifier"] });
    await memory.remember({ note: "oracle freshness check is enforced; not a bug", kind: "dead-end" });

    const hits = await memory.recall("nullifier reuse", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "finding");

    const all = await memory.all();
    assert.equal(all.length, 2);

    // No lexical overlap -> no scored recall.
    assert.equal((await memory.recall("totally unrelated xyzzy")).length, 0);

    // A fresh memory file is empty, not an error.
    assert.deepEqual(await new ProjectMemory(path.join(dir, "missing.jsonl")).all(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findings.json only reaches confirmed-executable when it cites a passing bash command", () => {
  const session = newSession();
  session.commandRuns.push({ id: "cmd1", passed: true, command: "node --test x", matched: ["ok"], missing: [], exitCode: 0, expectedExitCode: 0, timedOut: false, workspace: "w" });
  session.commandRuns.push({ id: "cmd2", passed: false, command: "node --test y", matched: [], missing: ["ok"], exitCode: 1, expectedExitCode: 0, timedOut: false, workspace: "w" });
  session.scratchFiles.set(
    "findings.json",
    JSON.stringify([
      { title: "A", location: "a.rs:1" },
      { title: "B", location: "a.rs:2", command_id: "cmd9" },
      { title: "C", location: "a.rs:3", command_id: "cmd1" },
      { title: "D", location: "a.rs:4", command_id: "cmd2" },
    ]),
  );

  const result = ingestFindingsFromScratch(session);
  assert.equal(result.parsed, 4);
  assert.match(result.errors.join("\n"), /cmd9/);
  assert.match(result.errors.join("\n"), /cmd2/);
  assert.equal(session.findings[0].confirmationStatus, "suspected");
  assert.equal(session.findings[1].confirmationStatus, "suspected");
  assert.equal(session.findings[2].confirmationStatus, "confirmed-executable");
  assert.equal(session.findings[3].confirmationStatus, "suspected");
});

test("bash refuses non-local or non-inspection commands without touching the workspace", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };
    const bash = tool("bash");

    const destructive = await bash.run({ cmd: "rm -rf ." }, ctx);
    assert.match(destructive.observation, /blocked/i);

    const liveNetwork = await bash.run({ cmd: "forge test --fork-url https://mainnet.example/rpc", success_patterns: ["x"] }, ctx);
    assert.match(liveNetwork.observation, /blocked/i);

    assert.equal(ctx.session.commandRuns.length, 0, "blocked commands must not record a command run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read, write, edit, and bash operate on loaded material and the copied workspace", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const source = [{ path: "circuit.rs", kind: "source", content: "fn assign() {\n  region.assign_advice(x);\n}\n" }];
    const ctx = { cfg, source, corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const read = await tool("read").run({ path: "circuit.rs", start: 1, end: 2 }, ctx);
    assert.match(read.observation, /assign_advice/);
    assert.match(read.observation, /circuit\.rs lines 1-2 of 4/);

    await tool("write").run({ path: "scratch.txt", content: "hello old value\n" }, ctx);
    const edited = await tool("edit").run({ path: "scratch.txt", old: "old", new: "new" }, ctx);
    assert.match(edited.observation, /edited scratch\.txt/);
    const scratch = await tool("read").run({ path: "scratch.txt" }, ctx);
    assert.match(scratch.observation, /hello new value/);

    await tool("write").run({
      path: "hunt_repro.test.mjs",
      content: "import test from 'node:test';\n\ntest('local harness success', () => {});\n",
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test hunt_repro.test.mjs", purpose: "confirm", success_patterns: ["local harness success"] }, ctx);
    assert.match(run.observation, /CONFIRMATION-ELIGIBLE PASS/);
    assert.equal(ctx.session.commandRuns.length, 1);
    assert.equal(ctx.session.commandRuns[0].passed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an inspection command cannot forge confirmation by printing a success pattern", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    // The model writes a file that contains the success pattern, then tries to
    // "confirm" by cat-ing it. cat is not a test command, so it must not pass.
    await tool("write").run({ path: "fake_evidence.txt", content: "INVARIANT BROKEN\n" }, ctx);
    const forged = await tool("bash").run({ cmd: "cat fake_evidence.txt", purpose: "confirm", success_patterns: ["INVARIANT BROKEN"] }, ctx);
    assert.match(forged.observation, /not confirmation-eligible/i);
    assert.match(forged.observation, /test\/build runner/i);
    assert.equal(ctx.session.commandRuns.at(-1).passed, false, "inspection commands must never mint confirmation");

    // The same inspection command as purpose=inspect is fine and just shows output.
    const inspect = await tool("bash").run({ cmd: "cat fake_evidence.txt" }, ctx);
    assert.match(inspect.observation, /\(inspect\)/);
    assert.ok(!/not confirmation-eligible/i.test(inspect.observation), "inspect runs must not show a confirmation verdict");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("baseline integrity: the model cannot modify the target source under audit", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const session = newSession();
    session.baselineFiles = new Set(["halo2_missing_constraint.rs", "halo2_scalar_mul_binding.rs"]);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session };

    // Writing over a target-source file is blocked — the model can't tamper with what it audits.
    const overwrite = await tool("write").run({ path: "halo2_missing_constraint.rs", content: "fn neutralized() {}\n" }, ctx);
    assert.match(overwrite.observation, /blocked/i);
    assert.match(overwrite.observation, /target source/i);

    // A new test file is fine.
    const newFile = await tool("write").run({ path: "exploit_test.rs", content: "// poc\n" }, ctx);
    assert.match(newFile.observation, /wrote exploit_test\.rs/);

    // Editing a target-source file is blocked too (even before the old-text check).
    const edit = await tool("edit").run({ path: "halo2_missing_constraint.rs", old: "assign_advice", new: "x" }, ctx);
    assert.match(edit.observation, /blocked/i);
    assert.equal(session.baselineFiles.has("exploit_test.rs"), false, "new files are not part of the protected baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-role model config: role entry overrides default overrides top-level, nothing auto-downgraded", () => {
  const cfg = defaultConfig();
  cfg.provider = "claude-code";
  cfg.auditModel = "claude-opus-4-8";
  cfg.thinkingLevel = "high";
  // No models block → every role inherits the top-level model (map is NOT downgraded).
  assert.deepEqual(resolveRole(cfg, "map"), { provider: "claude-code", model: "claude-opus-4-8", thinking: "high" });
  assert.deepEqual(resolveRole(cfg, "dig"), { provider: "claude-code", model: "claude-opus-4-8", thinking: "high" });

  cfg.models = normalizeRoleModels({
    default: { thinking: "high" },
    dig: { thinking: "xhigh" },
    refute: { provider: "openai-codex", model: "gpt-5.5" },
    bogus: { provider: "x" }, // ignored — not a known role
    map: { thinking: "not-a-level" }, // invalid thinking dropped, entry has no fields → omitted
  });
  // dig bumps thinking to xhigh, keeps inherited provider/model.
  assert.deepEqual(resolveRole(cfg, "dig"), { provider: "claude-code", model: "claude-opus-4-8", thinking: "xhigh" });
  // refute switches provider+model (the claude-code → codex switch the user wants), inherits thinking from default.
  assert.deepEqual(resolveRole(cfg, "refute"), { provider: "openai-codex", model: "gpt-5.5", thinking: "high" });
  // map's only field was an invalid thinking → entry omitted → falls back to default/top-level.
  assert.equal(resolveRole(cfg, "map").thinking, "high");
  assert.equal(cfg.models.bogus, undefined);

  // withRole specializes the config in place for role-agnostic callers.
  const digCfg = withRole(cfg, "dig");
  assert.equal(digCfg.thinkingLevel, "xhigh");
  assert.equal(digCfg.auditModel, "claude-opus-4-8");
});

test("deep mode: obligation-driven prompt enforces design-intent enumeration and pins a focus region", () => {
  // The deep system prompt must carry the method that makes missing-constraint
  // bugs visible: enumerate obligations from design intent, discharge each by the
  // enforcing line, treat a constraint to the wrong referent / an absent constraint
  // as the finding, and never clear on "looks standard".
  for (const needle of ["obligation", "DESIGN INTENT", "ABSENCE is the finding", "wrong referent", "looks standard"]) {
    assert.ok(HUNT_DEEP_SYSTEM.includes(needle), `deep system prompt missing: ${needle}`);
  }
  const tools = [];
  const pinned = buildDeepKickoff({ target: "t", tools, fileManifest: "(files)", maxSteps: 30, deepFocus: "ecc/chip/mul" });
  assert.ok(pinned.includes("Focus region (pinned): ecc/chip/mul"), "pinned focus not surfaced in kickoff");
  const auto = buildDeepKickoff({ target: "t", tools, fileManifest: "(files)", maxSteps: 30 });
  assert.ok(auto.includes("No focus pinned"), "auto-select kickoff should ask the model to rank the critical region");
  assert.ok(auto.includes("corpus/"), "deep kickoff should point the model at design-intent material");
});

test("transient-throttle classification: server rate limits retry, real quota exhaustion does not", () => {
  // The exact message from a provider-side throttle — must be treated as transient.
  assert.equal(isTransientError("claude exited: API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"), true);
  assert.equal(isTransientError("HTTP 429 Too Many Requests"), true);
  assert.equal(isTransientError("Service overloaded, please retry"), true);
  assert.equal(isTransientError("socket hang up"), true);
  // A genuine daily usage-limit exhaustion is NOT transient — retrying is futile.
  assert.equal(isTransientError("You have hit your usage limit for today"), false);
  assert.equal(isTransientError("monthly quota exceeded"), false);
  assert.equal(isTransientError("invalid JSON in tool action"), false);
});

test("independent refutation: a skeptic verdict is attached to each confirmed finding", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const source = [{ path: "x.rs", kind: "source", content: "fn check() { /* ... */ }\n" }];
    const findings = [
      { id: "f1", title: "real", severity: "high", location: "x.rs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable" },
      { id: "f2", title: "bogus", severity: "high", location: "x.rs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable" },
    ];
    // Skeptic refutes f2 (says it's actually safe) but cannot refute f1.
    const llm = {
      async complete(input) {
        if (input.tag === "refute_f2") return JSON.stringify({ refuted: true, reason: "the property IS enforced at line 1" });
        return JSON.stringify({ refuted: false, reason: "could not refute" });
      },
    };
    const verdicts = await runRefutation({ findings, source, cfg, llm, logger, max: 8 });
    assert.equal(verdicts.length, 2);
    assert.equal(findings[0].refutation.refuted, false);
    assert.equal(findings[1].refutation.refuted, true);
    assert.match(findings[1].refutation.reason, /enforced/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forced finalize: a run that never writes findings.json still captures hypotheses", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.huntMaxSteps = 3;
    const logger = await tempLogger(dir);
    const session = newSession();
    const ctx = {
      cfg,
      source: [{ path: "x.rs", kind: "source", content: "line1\nline2\nline3\n" }],
      corpus: [],
      memory: new ProjectMemory(path.join(dir, "memory.jsonl")),
      logger,
      session,
    };
    // A model that investigates forever (always reads) and never writes findings.json,
    // then on the dedicated finalize call returns its residual hypotheses.
    const llm = {
      async complete(input) {
        if (input.tag === "hunt_finalize") {
          return JSON.stringify([
            { title: "Residual suspicion in x.rs", severity: "medium", location: "x.rs:2", description: "looked off", confidence: 0.3 },
          ]);
        }
        return JSON.stringify({ thought: "one more read", tool: "read", args: { path: "x.rs" } });
      },
    };

    const result = await runHuntLoop({ cfg, llm, tools: buildTools(), ctx, logger, maxSteps: 3, fileManifest: "x.rs" });
    assert.equal(result.stoppedReason, "step-budget");
    // The forced finalize wrote findings.json even though the model never did.
    assert.ok(session.scratchFiles.has("findings.json"), "finalize must capture output when the model never writes it");
    const ingest = ingestFindingsFromScratch(session);
    assert.equal(ingest.parsed, 1);
    assert.equal(session.findings[0].confirmationStatus, "suspected");
    assert.match(session.findings[0].title, /Residual suspicion/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("differential confirmation: a real fix blocks the exploit; a no-op fix does not confirm", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    // Target source with the bug (accepts everything), plus the model's exploit test.
    await writeFile(path.join(dir, "vuln.mjs"), "export function check(x) { return true; }\n");
    await writeFile(
      path.join(dir, "exploit.test.mjs"),
      'import { check } from "./vuln.mjs";\nif (check("bad-input")) console.log("EXPLOIT OK"); else console.log("EXPLOIT BLOCKED");\n',
    );
    const workspace = { absolute: dir, relative: "w" };
    const baselineFiles = new Set(["vuln.mjs"]);
    const exploitRun = {
      id: "cmd1",
      passed: true,
      command: "node exploit.test.mjs",
      commandSpec: { program: "node", args: ["exploit.test.mjs"], expectedExitCode: 0, timeoutMs: 30000 },
      successPatterns: ["EXPLOIT OK"],
      matched: ["EXPLOIT OK"],
      missing: [],
      exitCode: 0,
      expectedExitCode: 0,
      timedOut: false,
      workspace: "w",
    };
    const baseFinding = { id: "f1", title: "x", severity: "high", location: "vuln.mjs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable", commandRunId: "cmd1" };

    // A real fix: the exploit is blocked after it -> confirmed-differential.
    const realFix = {
      ...baseFinding,
      fixPatch: { path: "vuln.mjs", old: "return true;", new: 'return x === "good";' },
      patchedSuccessPatterns: ["EXPLOIT BLOCKED"],
    };
    const real = await runDifferentialConfirmation({ workspace, finding: realFix, exploitRun, baselineFiles, cfg, logger });
    assert.equal(real.confirmed, true, real.reason);
    assert.equal(real.exploitStillReproduces, false);
    // Source restored to baseline after the differential.
    assert.equal(await readFile(path.join(dir, "vuln.mjs"), "utf8"), "export function check(x) { return true; }\n");

    // A no-op fix (changes nothing relevant): exploit still reproduces -> not confirmed.
    const noopFix = {
      ...baseFinding,
      fixPatch: { path: "vuln.mjs", old: "export function check", new: "export function check /* noop */" },
      patchedSuccessPatterns: ["EXPLOIT BLOCKED"],
    };
    const noop = await runDifferentialConfirmation({ workspace, finding: noopFix, exploitRun, baselineFiles, cfg, logger });
    assert.equal(noop.confirmed, false);
    assert.equal(noop.exploitStillReproduces, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hunt produces an execution-confirmed finding and banks cross-run memory", async () => {
  const dir = await tempDir();
  try {
    const corpusFile = path.join(dir, "spec.md");
    await writeFile(corpusFile, "# Protocol spec\nThe nullifier must be unique per note.\n");
    const cfg = defaultConfig();
    cfg.targetName = "agent-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [corpusFile];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntMaxSteps = 10;

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0];
    assert.equal(finding.confirmationStatus, "confirmed-executable", "a finding the skeptic could not refute stays confirmed");
    assert.equal(finding.failureMode, "autonomous", "hunt findings are not forced into a fixed taxonomy");
    assert.equal(summary.coverage.verifiedFindings, 1);
    assert.equal(summary.coverage.unverifiedFindings, 0);
    assert.equal(summary.coverage.hypotheses, 0, "the mock's single candidate is confirmed, so there are no hypotheses");

    // Only confirmed candidates become findings; hypotheses are a separate artifact.
    const findingsArtifact = JSON.parse(await readFile(path.join(runDir, "hunt_findings.json"), "utf8"));
    assert.equal(findingsArtifact.length, 1);
    const hypothesesArtifact = JSON.parse(await readFile(path.join(runDir, "hunt_hypotheses.json"), "utf8"));
    assert.equal(hypothesesArtifact.length, 0);

    // The fixture workspace has no toolchain manifest, so the warm-up is a no-op
    // (no hunt_prepare.json) and never blocks an offline run.
    let prepareWritten = true;
    try {
      await stat(path.join(runDir, "hunt_prepare.json"));
    } catch {
      prepareWritten = false;
    }
    assert.equal(prepareWritten, false, "warm-up must no-op when no manifest is present");

    // Corpus is copied into the workspace so the agent can read/grep it.
    const corpusEntries = await readdir(path.join(runDir, "hunt", "workspace", "corpus"));
    assert.ok(corpusEntries.length >= 1, "corpus material must be copied into the workspace");

    const transcript = JSON.parse(await readFile(path.join(runDir, "hunt_transcript.json"), "utf8"));
    assert.equal(transcript.stoppedReason, "finished");
    assert.ok(transcript.steps.some((step) => step.tool === "read"));
    assert.ok(transcript.steps.some((step) => step.tool === "write"));
    assert.ok(transcript.steps.some((step) => step.tool === "bash"));
    assert.ok(!transcript.steps.some((step) => step.tool === "dataflow"), "hunt default tools must not include strategy aids");

    const commandRuns = JSON.parse(await readFile(path.join(runDir, "hunt_command_runs.json"), "utf8"));
    assert.equal(commandRuns.length, 1);
    assert.equal(commandRuns[0].passed, true);

    // Run artifacts must stay free of machine-absolute source paths.
    const report = await readFile(path.join(runDir, "report_f1.md"), "utf8");
    assert.ok(!report.includes(root), "reports must not leak local absolute paths");

    // Memory persisted under project history for the next run.
    const memoryPath = path.join(cfg.outputDir, "history", "agent-e2e", "memory.jsonl");
    assert.ok((await stat(memoryPath)).isFile());
    const notes = (await readFile(memoryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(notes.some((note) => note.kind === "finding"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig: --deep enumerates scopes then deep-audits each, tagging findings by scope", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "mapdig-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntDeep = true; // map → dig flow (no pinned focus)
    cfg.huntMapSteps = 6;
    cfg.huntDigSteps = 8;
    cfg.huntMaxScopes = 1; // audit only the top scope this run; the rest stay pending

    const { runDir, summary, scopeCoverage } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    // The map phase wrote the full scope inventory; dig audited only the top one.
    const scopes = JSON.parse(await readFile(path.join(runDir, "hunt_scopes.json"), "utf8"));
    assert.equal(scopes.length, 2, "map enumerates the complete inventory");
    const s1 = scopes.find((s) => s.id === "S1");
    const s2 = scopes.find((s) => s.id === "S2");
    assert.equal(s1.status, "audited", "the highest-scored scope is audited");
    assert.equal(s2.status, "pending", "scopes beyond the cap stay pending (not dropped)");
    assert.deepEqual(scopeCoverage, { total: 2, audited: 1, pending: 1 });

    // Dig produced the confirmed finding, tagged by the scope it came from.
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.findings[0].confirmationStatus, "confirmed-executable");
    const findingsArtifact = JSON.parse(await readFile(path.join(runDir, "hunt_findings.json"), "utf8"));
    assert.equal(findingsArtifact[0].scopeId, "S1", "dig findings are tagged with the scope they came from");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig --dig-concurrency audits scopes in parallel, isolated per-scope workspaces", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "conc-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntDeep = true;
    cfg.huntMapSteps = 6;
    cfg.huntDigSteps = 8;
    cfg.huntMaxScopes = 2;
    cfg.huntDigConcurrency = 2; // audit both scopes in parallel

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    // Both enumerated scopes were deep-audited concurrently, each producing its finding.
    assert.equal(summary.findings.length, 2, "both scopes audited in parallel");
    const findings = JSON.parse(await readFile(path.join(runDir, "hunt_findings.json"), "utf8"));
    const scopeIds = new Set(findings.map((f) => f.scopeId));
    assert.ok(scopeIds.has("S1") && scopeIds.has("S2"), "findings are tagged with both scopes");
    for (const f of findings) assert.equal(f.confirmationStatus, "confirmed-executable");

    // Each concurrent dig ran in its own isolated workspace (no sharing).
    const digDirs = (await readdir(path.join(runDir, "hunt"))).filter((n) => n.startsWith("dig-"));
    assert.ok(digDirs.includes("dig-S1") && digDirs.includes("dig-S2"), "each scope got its own workspace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig is resumable: a second run skips map and audits the next pending scope", async () => {
  const dir = await tempDir();
  try {
    const base = {
      targetName: "resume-e2e",
      sourcePaths: [fixtures],
      corpusPaths: [fixtures],
      outputDir: path.join(dir, "runs"),
      huntDeep: true,
      huntMapSteps: 6,
      huntDigSteps: 8,
      huntMaxScopes: 1,
    };

    // Run 1: map enumerates S1+S2, dig audits S1, S2 left pending.
    const run1 = await runHunt({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });
    assert.deepEqual(run1.scopeCoverage, { total: 2, audited: 1, pending: 1 });
    const events1 = (await readFile(path.join(run1.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events1.some((e) => e.kind === "hunt_map_done"), "run 1 enumerates the inventory");

    // Run 2: same target/out → resume. No new map; audits the next pending scope (S2).
    const run2 = await runHunt({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });
    assert.deepEqual(run2.scopeCoverage, { total: 2, audited: 2, pending: 0 }, "the second run completes coverage");
    const events2 = (await readFile(path.join(run2.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!events2.some((e) => e.kind === "hunt_map_done"), "run 2 must not re-run the map phase");
    assert.ok(events2.some((e) => e.kind === "hunt_map_resumed"), "run 2 resumes the persisted inventory");
    const run2Findings = JSON.parse(await readFile(path.join(run2.runDir, "hunt_findings.json"), "utf8"));
    assert.equal(run2Findings[0]?.scopeId, "S2", "run 2 audits the previously-pending scope (S2)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildRoot: the sandbox copies the buildable root, while the model reads only the narrow source", async () => {
  const dir = await tempDir();
  try {
    // A buildable project: manifest at the root, audited source in a subdir.
    const buildRoot = path.join(dir, "project");
    await mkdir(path.join(buildRoot, "crate", "src"), { recursive: true });
    await writeFile(path.join(buildRoot, "Cargo.toml"), "[workspace]\nmembers=[\"crate\"]\n");
    await writeFile(path.join(buildRoot, "crate", "src", "lib.rs"), "// audited unit\npub fn f() {}\n");

    const cfg = defaultConfig();
    cfg.targetName = "buildroot-e2e";
    cfg.sourcePaths = [path.join(buildRoot, "crate", "src")]; // narrow audit scope
    cfg.buildRoot = buildRoot; // full buildable workspace
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntMaxSteps = 6;

    const { runDir } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    // The sandbox workspace contains the build root's manifest (copied from buildRoot),
    // which is NOT under the narrow sourcePaths subdir — proving buildRoot drove the copy.
    const manifest = path.join(runDir, "hunt", "workspace", "Cargo.toml");
    assert.ok((await stat(manifest)).isFile(), "the buildable root's manifest must be copied into the sandbox");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig: --scope picks a specific inventory item to deep-audit (human-in-the-loop)", async () => {
  const dir = await tempDir();
  try {
    const base = {
      targetName: "pick-e2e",
      sourcePaths: [fixtures],
      corpusPaths: [fixtures],
      outputDir: path.join(dir, "runs"),
      huntDeep: true,
      huntMapSteps: 6,
      huntDigSteps: 8,
      huntMaxScopes: 1,
    };

    // Run 1 enumerates S1+S2 and audits S1 (top score); S2 left pending.
    await runHunt({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });

    // Pick S2 explicitly — skip map, ignore score order, deep-audit exactly S2.
    const picked = await runHunt({ ...defaultConfig(), ...base, huntScopeIds: ["S2"] }, { llm: new MockAuditLlmClient() });
    const events = (await readFile(path.join(picked.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.kind === "hunt_map_done"), "picking must not re-map");
    assert.ok(events.some((e) => e.kind === "hunt_scope_picked" && e.ids.includes("S2")), "the named scope is audited");
    const findings = JSON.parse(await readFile(path.join(picked.runDir, "hunt_findings.json"), "utf8"));
    assert.equal(findings[0]?.scopeId, "S2", "the finding is tagged with the picked scope");

    // An unknown id is reported, not silently ignored.
    await assert.rejects(
      runHunt({ ...defaultConfig(), ...base, huntScopeIds: ["S99"] }, { llm: new MockAuditLlmClient() }),
      /none of the requested scope ids exist/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dedupeFindings: unions multi-sample findings, keeping the strongest-confirmed instance", () => {
  const mk = (location, title, confirmationStatus, confidence) => ({ location, title, confirmationStatus, confidence });
  const out = dedupeFindings([
    mk("mul/incomplete.rs:309", "Unconstrained base", "suspected", 0.6),
    mk("mul/incomplete.rs:309", "Unconstrained base", "confirmed-executable", 0.7), // same bug, stronger
    mk("note_commit.rs:728", "Canonicity ok", "suspected", 0.4), // different bug
    mk("MUL/INCOMPLETE.RS:309", " Unconstrained base ", "suspected", 0.9), // same key (case/space), weaker status
  ]);
  assert.equal(out.length, 2, "two distinct (location,title) bugs survive");
  const base = out.find((f) => f.location.toLowerCase().includes("incomplete"));
  assert.equal(base.confirmationStatus, "confirmed-executable", "the strongest-confirmed instance is kept");
});

test("map → dig: --dig-samples runs a scope K times and unions findings (recall lever)", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "samples-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntDeep = true;
    cfg.huntMapSteps = 6;
    cfg.huntDigSteps = 8;
    cfg.huntMaxScopes = 1;
    cfg.huntDigSamples = 2;

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    // Two independent dig passes ran; the identical finding is unioned to one.
    const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const sampleEvents = events.filter((e) => e.kind === "hunt_dig_sample");
    assert.equal(sampleEvents.length, 2, "two dig samples ran for the scope");
    assert.equal(summary.findings.length, 1, "the duplicate finding is unioned to one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hunt run directories are unique to the millisecond so rapid same-target runs do not collide", () => {
  // Regression for the resumable flow running back-to-back within one second.
  const t = new Date("2026-06-12T01:22:54.123Z");
  const t2 = new Date("2026-06-12T01:22:54.789Z");
  const a = new RunLogger("/tmp/x", "tgt", t).runDir;
  const b = new RunLogger("/tmp/x", "tgt", t2).runDir;
  assert.notEqual(a, b, "two runs in the same second must get distinct directories");
  assert.match(a, /tgt-20260612T012254123Z$/);
});
