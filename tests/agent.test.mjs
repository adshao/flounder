import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { buildTools, newSession } from "../dist/agent/tools.js";
import { runHunt } from "../dist/agent/hunt.js";
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

    // No lexical overlap -> no scored recall (the agent must query with relevant terms).
    assert.equal((await memory.recall("totally unrelated xyzzy")).length, 0);

    // A fresh memory file is empty, not an error.
    assert.deepEqual(await new ProjectMemory(path.join(dir, "missing.jsonl")).all(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report_finding only reaches confirmed-executable when it cites a passing test run", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const session = newSession();
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session };
    const report = tool("report_finding");

    // No test cited -> suspected.
    await report.run({ title: "A", location: "a.rs:1" }, ctx);
    assert.equal(session.findings.at(-1).confirmationStatus, "suspected");

    // Cites a test that does not exist -> suspected.
    await report.run({ title: "B", location: "a.rs:2", test_run_id: "t9" }, ctx);
    assert.equal(session.findings.at(-1).confirmationStatus, "suspected");

    // A passing test run exists and is cited -> confirmed-executable.
    session.testRuns.push({ id: "t1", passed: true, command: "node --test x", matched: ["ok"], missing: [], exitCode: 0, expectedExitCode: 0, timedOut: false, workspace: "w" });
    await report.run({ title: "C", location: "a.rs:3", test_run_id: "t1" }, ctx);
    assert.equal(session.findings.at(-1).confirmationStatus, "confirmed-executable");

    // A failing test run cited -> stays suspected (the gate is the framework's, not the model's).
    session.testRuns.push({ id: "t2", passed: false, command: "node --test y", matched: [], missing: ["ok"], exitCode: 1, expectedExitCode: 0, timedOut: false, workspace: "w" });
    await report.run({ title: "D", location: "a.rs:4", test_run_id: "t2" }, ctx);
    assert.equal(session.findings.at(-1).confirmationStatus, "suspected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run_test refuses non-test runners and live-network commands without touching the workspace", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };
    const runTest = tool("run_test");

    const destructive = await runTest.run({ files: [], command: { program: "rm", args: ["-rf", "."] } }, ctx);
    assert.match(destructive.observation, /blocked/i);

    const liveNetwork = await runTest.run(
      { files: [], command: { program: "forge", args: ["test", "--fork-url", "https://mainnet.example/rpc"] }, success_patterns: ["x"] },
      ctx,
    );
    assert.match(liveNetwork.observation, /blocked/i);

    assert.equal(ctx.session.testRuns.length, 0, "blocked commands must not record a test run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_file and search operate over loaded source without disk access", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const source = [{ path: "circuit.rs", kind: "source", content: "fn assign() {\n  region.assign_advice(x);\n}\n" }];
    const ctx = { cfg, source, corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const read = await tool("read_file").run({ path: "circuit.rs", start: 1, end: 2 }, ctx);
    assert.match(read.observation, /assign_advice/);
    assert.match(read.observation, /circuit\.rs lines 1-2 of 4/);

    const search = await tool("search").run({ query: "assign_advice" }, ctx);
    assert.match(search.observation, /circuit\.rs:2/);

    const missing = await tool("read_file").run({ path: "nope.rs" }, ctx);
    assert.match(missing.observation, /no loaded file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hunt produces an execution-confirmed finding and banks cross-run memory", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "agent-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.huntMaxSteps = 8;

    const { runDir, summary } = await runHunt(cfg, { llm: new MockAuditLlmClient() });

    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0];
    assert.equal(finding.confirmationStatus, "confirmed-executable");
    assert.equal(finding.failureMode, "autonomous", "hunt findings are not forced into a fixed taxonomy");
    assert.equal(summary.coverage.verifiedFindings, 1);

    const transcript = JSON.parse(await readFile(path.join(runDir, "hunt_transcript.json"), "utf8"));
    assert.equal(transcript.stoppedReason, "finished");
    assert.ok(transcript.steps.some((step) => step.tool === "run_test"));

    const testRuns = JSON.parse(await readFile(path.join(runDir, "hunt_test_runs.json"), "utf8"));
    assert.equal(testRuns.length, 1);
    assert.equal(testRuns[0].passed, true);

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
