import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { defaultConfig, resolveRole, withRole, normalizeRoleModels } from "../dist/config.js";
import { ProjectMemory } from "../dist/agent/memory.js";
import { buildTools, describeAction, ingestFindingsFromScratch, newSession, dedupeFindings, readScratchScopes, isReportFile, scratchHasFindings, scratchHasFindingsArtifact, commandFileArgsForTest, confirmCommandTargetLinkForTest } from "../dist/agent/tools.js";
import { buildRunHealth, mergeFollowupScopes, readScratchCoverageGaps, readScratchFollowupScopes, readScratchResourceRequests } from "../dist/agent/discovery-artifacts.js";
import { mergeScopeInventory } from "../dist/agent/scope-store.js";
import { runAudit } from "../dist/agent/audit.js";
import { normalizePrepareManifest, prepareValidationBlockingIssues, readPrepareManifest } from "../dist/agent/acquire.js";
import { runAuditLoop, isTransientError } from "../dist/agent/loop.js";
import { MetadataStore } from "../dist/db/store.js";
import { buildConfirmKickoff, buildDeepKickoff, buildMapKickoff, buildVerifyKickoff, AUDIT_CONFIRM_SYSTEM, AUDIT_DEEP_SYSTEM, AUDIT_SYSTEM, AUDIT_VERIFY_SYSTEM, DISCOVERY_BACKLOG_RULES, MAP_GRANULARITY_RULES, MAP_SYSTEM, POC_TRUST_RULE } from "../dist/agent/prompts.js";
import { runDifferentialConfirmation } from "../dist/agent/differential.js";
import { runRefutation } from "../dist/agent/refutation.js";
import { renderReportFileManifest } from "../dist/agent/report.js";
import { stagePackageSource } from "../dist/agent/package-source.js";
import { buildSessionPrompt, createIsolatedResourceLoader, FINDINGS_FINALIZE_PROMPT, isPiSessionProvider, mapCheckpointDirective, mapThinkingLevel, prepareCheckpointDirective, promptWithWallClockAbort, resolveFinalizePromptTimeoutMs, toolSchemas } from "../dist/agent/pi-session.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { RunLogger } from "../dist/trace/logger.js";
import { renderDisclosure } from "../dist/reports/disclosure.js";

process.env.FLOUNDER_SANDBOX_BACKEND = "host";
process.env.FLOUNDER_ALLOW_HOST_EXECUTION = "1";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "flounder-agent-"));
}

async function tempLogger(baseDir) {
  const logger = new RunLogger(baseDir, "agent-test", new Date(), { streamEvents: false });
  await logger.init();
  return logger;
}

function tool(name) {
  return buildTools().find((entry) => entry.name === name);
}

class VerifyIsolationLlmClient {
  async complete(input) {
    const action = (thought, toolName, args) => JSON.stringify({ thought, tool: toolName, args });
    const user = input.user;
    if (user.includes("first marker claim")) {
      if (!user.includes("wrote tests/verify-marker.poc.test.js")) {
        return action("Leave a marker file that must stay scoped to this verify candidate.", "write", {
          path: "tests/verify-marker.poc.test.js",
          content: "marker from first candidate",
        });
      }
      if (!user.includes('"path":"findings.json"')) {
        return action("Record no verdict for this synthetic candidate.", "write", { path: "findings.json", content: "[]" });
      }
      return JSON.stringify({ done: true, summary: "first candidate finished" });
    }
    if (user.includes("second isolation claim")) {
      if (!user.includes('action: read {"path":"tests/verify-marker.poc.test.js"}')) {
        return action("Check whether the prior candidate's marker leaked into this workspace.", "read", { path: "tests/verify-marker.poc.test.js" });
      }
      if (!user.includes('"path":"findings.json"')) {
        return action("Record no verdict after the isolation check.", "write", { path: "findings.json", content: "[]" });
      }
      return JSON.stringify({ done: true, summary: "second candidate finished" });
    }
    return JSON.stringify({ done: true, summary: "unexpected verify seed" });
  }
}

class AppendMapLlmClient {
  async complete(input) {
    const action = (thought, toolName, args) => JSON.stringify({ thought, tool: toolName, args });
    if (input.user.includes("Phase: MAP")) {
      if (!input.user.includes("wrote scopes.json")) {
        const appendMode = input.user.includes("map_existing_scopes.json");
        return action(appendMode ? "Append only scopes absent from the existing inventory." : "Create the initial scope inventory.", "write", {
          path: "scopes.json",
          content: JSON.stringify(appendMode ? [
            {
              id: "S2",
              obligation: "secondary advice region must bind to its source",
              region: "halo2_missing_constraint.rs:5",
              lenses: ["unbound-input"],
              exposure: "high",
              difficulty: "medium",
              score: 80,
              why: "duplicate of the existing S2 should be ignored by the merge.",
            },
            {
              id: "S3",
              obligation: "tertiary advice region must bind to its source",
              region: "halo2_missing_constraint.rs:7",
              lenses: ["unbound-input"],
              exposure: "medium",
              difficulty: "medium",
              score: 70,
              why: "new scope discovered by append-map.",
            },
          ] : [
            {
              id: "S1",
              obligation: "the advice cell must be constrained to its trusted source value",
              region: "halo2_missing_constraint.rs:5",
              lenses: ["unbound-input"],
              exposure: "critical",
              difficulty: "high",
              score: 95,
              why: "initial scope.",
            },
            {
              id: "S2",
              obligation: "secondary advice region must bind to its source",
              region: "halo2_missing_constraint.rs:5",
              lenses: ["unbound-input"],
              exposure: "high",
              difficulty: "medium",
              score: 76,
              why: "initial second scope.",
            },
          ]),
        });
      }
      return JSON.stringify({ done: true, summary: "scopes written" });
    }
    return new MockAuditLlmClient().complete(input);
  }
}

function tarGz(files) {
  const blocks = [];
  for (const [name, contentText] of Object.entries(files)) {
    const content = Buffer.from(contentText);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
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
  assert.equal(mapThinkingLevel("off"), "off");
  assert.equal(mapThinkingLevel("minimal"), "minimal");
  assert.equal(mapThinkingLevel("xhigh"), "xhigh");
});

test("pi forced-finalize prompt has a wall-clock abort", async () => {
  assert.equal(resolveFinalizePromptTimeoutMs({ FLOUNDER_FINALIZE_PROMPT_TIMEOUT_MS: "7" }), 7);

  let aborted = false;
  const stalled = {
    prompt: async () => new Promise(() => {}),
    abort: () => {
      aborted = true;
    },
  };
  const started = Date.now();
  const result = await promptWithWallClockAbort(stalled, "write findings.json", 5);
  assert.equal(result, "timed-out");
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 500, "test helper should not wait for the stalled prompt");

  let completedAbort = false;
  const completed = await promptWithWallClockAbort({
    prompt: async () => undefined,
    abort: () => {
      completedAbort = true;
    },
  }, "write findings.json", 1_000);
  assert.equal(completed, "completed");
  assert.equal(completedAbort, false);
});

test("map checkpoint guard blocks further exploration until scopes.json exists", () => {
  assert.equal(mapCheckpointDirective(true, 11, "read", { path: "src/lib.rs" }, 0), undefined);
  const blocked = mapCheckpointDirective(true, 12, "read", { path: "src/lib.rs" }, 0);
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.eventKind, "audit_map_checkpoint_block");
  assert.match(blocked?.message ?? "", /MAP CHECKPOINT REQUIRED/);
  assert.match(blocked?.message ?? "", /write scopes\.json/i);

  const write = mapCheckpointDirective(true, 12, "write", { path: "scopes.json" }, 0);
  assert.equal(write?.block, undefined);
  assert.equal(write?.eventKind, "audit_map_checkpoint_nudge");

  assert.equal(mapCheckpointDirective(true, 12, "bash", { cmd: "rg public" }, 1), undefined);
  assert.equal(mapCheckpointDirective(false, 12, "read", { path: "src/lib.rs" }, 0), undefined);
});

test("readScratchScopes accepts scope/spec/value/input map schema", () => {
  const session = newSession();
  session.scratchFiles.set("scopes.json", JSON.stringify([
    {
      id: "S-crit",
      scope: "Verifier public input binding",
      region: "src/Verifier.sol:1-90",
      spec: "The proof input must bind the committed root.",
      value: "Invalid proofs could release escrowed funds.",
      inputs: "Proof bytes, public input, committed root.",
      exposure: "critical",
    },
    {
      id: "S-low",
      scope: "Metrics endpoint",
      region: "src/Metrics.ts:1-20",
      spec: "Metrics must not affect state.",
      exposure: "low",
    },
  ]));

  const scopes = readScratchScopes(session);
  assert.equal(scopes.length, 2);
  assert.equal(scopes[0].id, "S-crit");
  assert.equal(scopes[0].obligation, "Spec: The proof input must bind the committed root. Value at risk: Invalid proofs could release escrowed funds. Inputs/trust boundary: Proof bytes, public input, committed root.");
  assert.equal(scopes[0].score, 100);
  assert.equal(scopes[1].score, 20);
});

test("discovery backlog artifacts parse and merge without becoming findings", () => {
  const session = newSession();
  session.scratchFiles.set("coverage_gaps.json", JSON.stringify({
    coverage_gaps: [
      {
        id: "G1",
        scope_id: "S1",
        region: "src/Vault.sol:10-80",
        obligation: "Withdrawal authorization must bind signer to recipient.",
        reason: "The dig found the sink but did not audit the signature domain separator.",
        next_action: "Deep-audit the signature construction and caller path.",
      },
    ],
  }));
  session.scratchFiles.set("dig-S1/resource_requests.json", JSON.stringify([
    {
      id: "R1",
      kind: "sandbox-image",
      scope_id: "S1",
      needed: "Foundry image with solc 0.7.6",
      reason: "The native tests cannot compile in the baseline sandbox.",
      unblock: "Run the PoC against the project test suite.",
      priority: "high",
    },
  ]));
  session.scratchFiles.set("dig-S1/followup_scopes.json", JSON.stringify({
    followup_scopes: [
      {
        parent_scope_id: "S1",
        obligation: "Domain separator construction must bind chain and verifying contract.",
        region: "src/Permit.sol:40-95",
        lenses: ["spec", "unbound-input"],
        exposure: "high",
        difficulty: "medium",
        score: 8,
        why: "An adjacent authorization precondition gates the withdrawal sink.",
      },
    ],
  }));

  const gaps = readScratchCoverageGaps(session);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].scopeId, "S1");
  assert.match(gaps[0].nextAction, /Deep-audit/);

  const resources = readScratchResourceRequests(session);
  assert.equal(resources.length, 1);
  assert.equal(resources[0].kind, "sandbox-image");
  assert.equal(resources[0].priority, "high");

  const followups = readScratchFollowupScopes(session);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].parentScopeId, "S1");
  assert.equal(followups[0].source, "followup");

  const merged = mergeFollowupScopes([
    {
      id: "S1",
      obligation: "Withdrawal sink must enforce authorization.",
      region: "src/Vault.sol:10-80",
      lenses: ["value-flow"],
      exposure: "critical",
      difficulty: "high",
      score: 10,
      why: "Funds leave the system.",
      status: "audited",
    },
  ], followups);
  assert.equal(merged.added, 1);
  assert.equal(merged.scopes.length, 2);
  assert.equal(merged.scopes[1].status, "pending");

  assert.equal(isReportFile("coverage_gaps.json"), true);
  assert.equal(isReportFile("resource_requests.json"), true);
  assert.equal(isReportFile("followup_scopes.json"), true);
});

test("run health distinguishes blocked, shallow, and coverage-incomplete runs", () => {
  const base = {
    stoppedReason: "finished",
    steps: [{ tool: "read" }, { tool: "bash" }, { tool: "write" }, { tool: "read" }],
    commandRuns: [],
    scopes: [],
    confirmed: [],
    hypotheses: [],
    coverageGaps: [],
    resourceRequests: [],
    followupScopes: [],
    mode: "breadth",
  };

  assert.equal(buildRunHealth(base).status, "healthy");
  assert.equal(buildRunHealth({ ...base, steps: [{ tool: "read" }], mode: "map" }).status, "shallow");
  assert.equal(buildRunHealth({
    ...base,
    resourceRequests: [{ id: "R1", status: "open", kind: "environment", needed: "FreeBSD VM", reason: "PoC needs platform-specific socket behavior" }],
  }).status, "needs-resource");
  assert.equal(buildRunHealth({
    ...base,
    coverageGaps: [{ id: "G1", status: "open", obligation: "Parser length must bind payload bytes", reason: "Budget ended before parser sink was audited" }],
  }).status, "needs-coverage");
  assert.equal(buildRunHealth({ ...base, stoppedReason: "error" }).status, "infra-failed");
  assert.equal(buildRunHealth({ ...base, infraErrors: 1 }).status, "infra-failed");
});

test("scope inventory merge appends novel scopes while preserving existing status", () => {
  const existing = [
    { id: "S1", obligation: "bind source", region: "src/A.sol:10", lenses: [], exposure: "high", difficulty: "low", score: 90, why: "old", status: "audited", digSeconds: 12 },
  ];
  const merged = mergeScopeInventory(existing, [
    { id: "S1", obligation: "bind source", region: "src/A.sol:10", lenses: [], exposure: "high", difficulty: "low", score: 100, why: "duplicate" },
    { id: "S1", obligation: "check recipient", region: "src/B.sol:20", lenses: [], exposure: "medium", difficulty: "low", score: 70, why: "new" },
  ]);
  assert.equal(merged.added, 1);
  assert.equal(merged.skippedDuplicate, 1);
  assert.equal(merged.scopes[0].status, "audited");
  assert.equal(merged.scopes[0].digSeconds, 12);
  assert.equal(merged.scopes[1].status, "pending");
  assert.notEqual(merged.scopes[1].id, "S1", "new scope id is made unique");
});

test("prepare checkpoint guard blocks optional work after source is staged but manifest components are empty", () => {
  const state = { hasManifest: true, componentCount: 0, hasStagedSource: true };
  const blocked = prepareCheckpointDirective("Clue: official source", 18, state, "bash", { cmd: "find sources -type f" });
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.eventKind, "audit_prepare_manifest_refresh_block");
  assert.match(blocked?.message ?? "", /Source files are already staged/);
  assert.match(blocked?.message ?? "", /components: \[\]/);

  const write = prepareCheckpointDirective("Clue: official source", 18, state, "write", { path: "prepare_manifest.json" });
  assert.equal(write?.block, undefined);
  assert.equal(write?.eventKind, "audit_prepare_manifest_refresh_nudge");

  assert.equal(prepareCheckpointDirective("Clue: official source", 18, { hasManifest: true, componentCount: 1, hasStagedSource: true }, "bash", { cmd: "find sources -type f" }), undefined);
  assert.equal(prepareCheckpointDirective("Clue: official source", 18, { hasManifest: true, componentCount: 0, hasStagedSource: false }, "bash", { cmd: "python3 stage_crates.py" }), undefined);
});

test("prompt contract keeps attacker-faithful PoC rule on legacy and pi-session paths", () => {
  assert.ok(POC_TRUST_RULE.includes("Build the PoC the way the ATTACKER would"));
  assert.ok(POC_TRUST_RULE.includes("you may create local tests/harnesses"), "rule should allow constructing real local attack scenarios");

  for (const prompt of [AUDIT_SYSTEM, AUDIT_DEEP_SYSTEM, AUDIT_VERIFY_SYSTEM]) {
    assert.ok(prompt.includes(POC_TRUST_RULE), "legacy loop prompt is missing the shared PoC trust rule");
  }
  assert.ok(AUDIT_SYSTEM.includes("findings.json is not an audit notebook"), "legacy prompt should keep audit notes out of findings");
  assert.ok(AUDIT_DEEP_SYSTEM.includes("Discharged-with-line obligations are useful reasoning, but they are not findings"), "legacy deep prompt should not emit safe obligations as findings");
  assert.ok(DISCOVERY_BACKLOG_RULES.includes("followup_scopes.json"), "discovery backlog prompt should expose follow-up scope artifacts");
  assert.ok(DISCOVERY_BACKLOG_RULES.includes("score is an integer 0-100"), "follow-up scope scores should use the same 100-point ordering scale as map scopes");

  const sessionPrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs" });
  assert.ok(sessionPrompt.includes(POC_TRUST_RULE), "real pi session prompt is missing the shared PoC trust rule");
  assert.ok(sessionPrompt.includes('purpose="build"'), "real pi session prompt should expose build-purpose commands");
  assert.ok(sessionPrompt.includes("jq . file or jq length file"), "real pi session prompt should recommend JSON inspection tools available in the sandbox image");
  assert.ok(!sessionPrompt.includes("python -m json.tool"), "real pi session prompt should not suggest a missing python binary for JSON validation");
  const bashDescription = buildTools().find((tool) => tool.name === "bash")?.description ?? "";
  assert.ok(bashDescription.includes("jq . file or jq length file"), "bash tool description should recommend sandbox-available JSON inspection");
  assert.ok(!bashDescription.includes("python -m json.tool"), "bash tool description should not suggest a missing python binary for JSON validation");
  assert.ok(sessionPrompt.includes("findings.json is not a work log"), "findings should not be used as an audit notebook");
  assert.ok(sessionPrompt.includes("Do NOT write safe/no-issue notes"), "session prompt should keep no-issue ledgers out of findings");
  assert.ok(JSON.stringify(toolSchemas.bash).includes('"build"'), "pi custom tool schema should allow purpose=build");
  assert.ok(FINDINGS_FINALIZE_PROMPT.includes("already-passing purpose=confirm command_id"), "finalize should preserve already-executed confirmations");
  assert.ok(FINDINGS_FINALIZE_PROMPT.includes("If you found no actionable bug, write [] exactly"), "finalize should avoid fabricating info-only findings");

  const mapPrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", map: true });
  assert.ok(!mapPrompt.includes("Record candidates by writing findings.json"), "map prompt should not inherit findings-report instructions");
  const appendMapPrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", map: true, mapExistingScopesPath: "map_existing_scopes.json", mapExistingScopesCount: 2 });
  assert.match(appendMapPrompt, /APPEND-MAP MODE/);
  assert.match(appendMapPrompt, /map_existing_scopes\.json/);
  assert.match(appendMapPrompt, /ONLY newly discovered/i);
  for (const prompt of [
    MAP_SYSTEM,
    mapPrompt,
    buildMapKickoff({ target: "t", tools: [], fileManifest: "x.rs", maxSteps: Number.POSITIVE_INFINITY }),
  ]) {
    assert.ok(prompt.includes(MAP_GRANULARITY_RULES), "map prompt should carry the shared granularity rules");
    assert.ok(prompt.includes("dig batch cap"), "map prompt should state that dig caps do not limit map inventory");
    assert.ok(prompt.includes("10 inspect commands"), "map prompt should force an early scope checkpoint before broad exploration drifts too long");
    assert.ok(prompt.includes("not completion") || prompt.includes("final completeness pass"), "map prompt should treat early scopes.json writes as checkpoints");
    assert.ok(prompt.includes("expansion pass") || prompt.includes("final completeness pass"), "map prompt should require a final expansion pass before done");
    assert.ok(prompt.includes("complete binding chain"), "map prompt should require value-binding scopes to cover producer, enforcement, and consumer lines");
    assert.ok(prompt.includes("0-100"), "map prompt should use a 100-point scope score scale");
  }

  const deepPrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", deep: true });
  assert.ok(!deepPrompt.includes("Record every obligation and its status to findings.json"), "deep prompt should not put discharged obligations into findings");
  assert.ok(deepPrompt.includes("discharged obligations are not findings"), "deep prompt should keep safe obligation notes out of findings");
  for (const prompt of [
    mapPrompt,
    deepPrompt,
    buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", verify: "claim" }),
  ]) {
    assert.ok(prompt.includes("Target evidence boundary"), "audit prompts should define the target evidence boundary");
    assert.ok(prompt.includes("no ~/.agents skills"), "audit prompts should block host agent skills as evidence");
    assert.ok(prompt.includes("~/.codex memories"), "audit prompts should block host Codex memories as evidence");
    assert.ok(prompt.includes("outside this audit workspace"), "audit prompts should block outside-workspace paths");
  }

  const verifyPrompts = [
    AUDIT_VERIFY_SYSTEM,
    buildVerifyKickoff({ target: "t", tools: [], fileManifest: "x.rs", maxSteps: Number.POSITIVE_INFINITY, verify: "claim" }),
    buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", verify: "claim" }),
  ];
  for (const prompt of verifyPrompts) {
    assert.ok(prompt.includes("native build root") || prompt.includes("native workspace"), "verify should prefer native target workspaces over standalone harnesses");
    assert.ok(prompt.includes("standalone PoC package"), "verify should constrain standalone PoC package use");
    assert.ok(prompt.includes("purpose=build"), "verify should own dependency fetch/compile setup instead of requiring prepare to pre-warm everything");
    assert.ok(prompt.includes("missing-registry-package"), "verify should avoid repeating missing registry-package failures");
    assert.ok(prompt.includes("DNS failure"), "verify should avoid repeating network setup failures");
    assert.ok(prompt.includes("setup blocker"), "verify should distinguish environment setup failures from false-positive refutations");
    assert.ok(prompt.includes("emit done immediately"), "verify should stop after the selected claim has a verdict");
    assert.ok(
      prompt.includes("broader coverage") || prompt.includes("broader audit coverage") || prompt.includes("related bugs"),
      "verify should not drift into open-ended audit coverage",
    );
  }

  const preparePrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "(empty)", prepare: "Clue: official source" });
  assert.ok(preparePrompt.includes("Write prepare_manifest.json EARLY"), "prepare should persist a usable manifest before chasing long-tail dependencies");
  assert.ok(preparePrompt.includes("early checkpoint"), "prepare should checkpoint a partial manifest before long-tail acquisition");
  assert.ok(preparePrompt.includes("ordinary package-manager dependency"), "prepare should not chase every package dependency when manifests can resolve them");
  assert.ok(preparePrompt.includes("stop only after the manifest has nonempty component rows"), "prepare should not stop with staged files but empty components");
  assert.ok(preparePrompt.includes("Official docs/specs are best-effort"), "prepare should not block automation on missing docs/specs");
  assert.ok(preparePrompt.includes("Missing docs/specs are best-effort caveats"), "pi prepare should treat missing docs/specs as caveats");
  assert.ok(preparePrompt.includes("Source-ready is enough"), "prepare should stop after source/provenance is concrete instead of chasing optional material");
  assert.ok(preparePrompt.includes("stage_package_source"), "prepare should prefer product package staging over ad hoc download scripts");
  assert.ok(JSON.stringify(toolSchemas.stage_package_source).includes("crates.io"), "pi custom tool schema should expose package source staging");
  assert.equal(buildTools().some((entry) => entry.name === "stage_package_source"), false, "ordinary audit tools should not expose prepare-only package staging");
  assert.equal(buildTools({ prepare: true }).some((entry) => entry.name === "stage_package_source"), true, "prepare tool surface should include package source staging");
  assert.ok(preparePrompt.includes("Historical-release neutrality"), "prepare should not walk releases backward to find a vulnerable version");
  assert.ok(preparePrompt.includes("do not use labels such as \"vulnerable\""), "prepare should keep historical version selection neutral");
  assert.ok(!preparePrompt.includes("workspace contains the authorized target code, official answer-free docs/specs"), "prepare should not require docs/specs before source-ready completion");
  assert.ok(preparePrompt.includes("source-only not_required_reason"), "prepare needs explicit source-only stop criteria");
  assert.ok(preparePrompt.includes("A nonempty workspace with an empty components array is not a usable prepare output"), "prepare should reject empty component manifests");
  assert.ok(preparePrompt.includes("Do NOT audit yet"), "prepare should not spend the acquisition phase hunting bugs");
  assert.ok(preparePrompt.includes("leave all bug discovery to map/dig"), "prepare should preserve the blind audit boundary");
  assert.ok(preparePrompt.includes("real_target"), "prepare should require a real-target confirmation plan");
  assert.ok(preparePrompt.includes("host/outer-agent instructions"), "prepare should not use host agent instructions as target evidence");
  assert.ok(preparePrompt.includes("~/.agents skills"), "pi prepare should explicitly avoid outer Codex skill files");
  assert.ok(preparePrompt.includes("machine-local notes outside this prepare workspace"), "pi prepare should stay inside the prepared target evidence boundary");
  assert.ok(preparePrompt.includes("requires_confirmation"), "prepare should explicitly decide whether real-target confirmation is required");
  assert.ok(preparePrompt.includes("real_target.requires_confirmation=true"), "prepare should identify real-target confirmation mode");
  assert.ok(preparePrompt.includes("ground_truth must list"), "prepare should not leave real-target confirmation unresolved");
  assert.ok(preparePrompt.includes("chain_id"), "prepare should capture chain identifiers for deployed targets");
  assert.ok(preparePrompt.includes("source-only"), "prepare should support source-only audits without forcing chain confirmation");

  const reportPrompt = buildSessionPrompt({ cfg: defaultConfig(), fileManifest: "x.rs", report: "[]" });
  assert.ok(reportPrompt.includes("No-fabrication rule"), "report mode should prohibit unsupported report details");
  assert.ok(reportPrompt.includes("checking any source/evidence needed for accuracy"), "report mode should verify code/evidence before writing");
  assert.ok(reportPrompt.includes("## Evidence Basis"), "formal reports should expose the evidence base");
  assert.ok(reportPrompt.includes("source, corpus, PoC files, or artifacts"), "report mode should inspect missing details instead of guessing");
  assert.ok(reportPrompt.includes("If a detail is not established"), "report mode should surface evidence gaps instead of inventing details");
  assert.ok(reportPrompt.includes('Do NOT include a "Linked Findings" section'), "formal reports should not expose internal linked finding sections");
  assert.ok(reportPrompt.includes("Finding # labels"), "formal reports should not expose internal finding ids");

  assert.ok(AUDIT_CONFIRM_SYSTEM.includes("Do NOT write report_*.md files in CONFIRM mode"), "confirm should not generate formal reports");
  assert.ok(!AUDIT_CONFIRM_SYSTEM.includes("Formal submission reports"), "formal reports belong to the Report phase, not Confirm");
  assert.ok(!AUDIT_CONFIRM_SYSTEM.includes("## Evidence Basis"), "confirm should not embed the formal report template");
  const confirmKickoff = buildConfirmKickoff({ target: "t", tools: [], fileManifest: "x.rs", maxSteps: Number.POSITIVE_INFINITY, confirm: "[]" });
  assert.ok(confirmKickoff.includes("write only the decision sheet"), "confirm kickoff should frame Confirm as decision-only");
  assert.ok(confirmKickoff.includes("Do not write report_*.md"), "confirm kickoff should reserve formal reports for Report");
});

test("pi session resource loader isolates audits from host agent context", () => {
  const loader = createIsolatedResourceLoader("Mode-specific rules.");
  assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
  assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
  assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.equal(loader.getExtensions().extensions.length, 0);
  const prompt = loader.getSystemPrompt();
  assert.ok(prompt.includes("Flounder's isolated audit worker"));
  assert.ok(prompt.includes("Mode-specific rules."));
  assert.ok(prompt.includes("Do not load, apply, or ask for host agent instructions"));
  assert.ok(prompt.includes("SKILL.md"));
  assert.ok(prompt.includes("~/.codex"));
});

test("empty findings.json is a completed artifact, not a forced-finalize miss", () => {
  const clean = newSession();
  clean.scratchFiles.set("findings.json", "[]");
  assert.equal(scratchHasFindingsArtifact(clean), true);
  assert.equal(scratchHasFindings(clean), false);

  const wrapped = newSession();
  wrapped.scratchFiles.set("findings.json", "{\"findings\":[]}");
  assert.equal(scratchHasFindingsArtifact(wrapped), true);
  assert.equal(scratchHasFindings(wrapped), false);

  const missing = newSession();
  assert.equal(scratchHasFindingsArtifact(missing), false);

  const invalid = newSession();
  invalid.scratchFiles.set("findings.json", "{");
  assert.equal(scratchHasFindingsArtifact(invalid), false);
});

test("stage_package_source stages a crates.io package with checksum-verified provenance", async () => {
  const dir = await tempDir();
  try {
    const archive = tarGz({
      "demo-1.0.0/Cargo.toml": "[package]\nname = \"demo\"\nversion = \"1.0.0\"\n",
      "demo-1.0.0/src/lib.rs": "pub fn demo() -> bool { true }\n",
    });
    const checksum = createHash("sha256").update(archive).digest("hex");
    const fakeFetch = async (url) => {
      if (url.endsWith("/api/v1/crates/demo/1.0.0")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: { checksum, dl_path: "/api/v1/crates/demo/1.0.0/download" } }),
          arrayBuffer: async () => asArrayBuffer(Buffer.alloc(0)),
        };
      }
      if (url.endsWith("/api/v1/crates/demo/1.0.0/download")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => asArrayBuffer(archive),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await stagePackageSource({
      workspaceAbsolute: dir,
      registry: "crates.io",
      packageName: "demo",
      version: "1.0.0",
      fetchImpl: fakeFetch,
    });

    assert.equal(result.stagedPath, "sources/crates/demo-1.0.0");
    assert.equal(result.sha256, checksum);
    assert.equal(result.componentTemplate.identity, "demo@1.0.0");
    assert.equal(result.componentTemplate.staged_path, "sources/crates/demo-1.0.0");
    assert.match(await readFile(path.join(dir, "sources/crates/demo-1.0.0/src/lib.rs"), "utf8"), /pub fn demo/);
    const provenance = JSON.parse(await readFile(path.join(dir, "metadata/crates.io/demo-1.0.0.json"), "utf8"));
    assert.equal(provenance.checksum, checksum);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prepare manifest normalization turns ended in-progress manifests into terminal states", () => {
  const clean = normalizePrepareManifest(
    {
      clue: "official source",
      real_target: {
        requires_confirmation: false,
        mode: "source-only",
        reason: "Official source audit; no deployed target is in scope.",
        ground_truth: [],
        confirm_guidance: { required: false, allowed_network_actions: "none", recommended_method: "local source tests", not_required_reason: "Source-only target." },
      },
      components: [{ identity: "repo", platform: "none", revision: "abc", match: "n/a" }],
    },
    { components: 1, matched: 0, unverified: 0, sourcePinned: 1, issues: [] },
  );
  assert.equal(clean.status, "complete");

  const partial = normalizePrepareManifest(
    { status: "in_progress", gaps: [{ id: "deployment", status: "open" }], components: [] },
    { components: 0, matched: 0, unverified: 0, sourcePinned: 0, issues: ["manifest lists no components"] },
  );
  assert.equal(partial.status, "partial");
  assert.match(partial.status_reason, /unresolved gaps|validation issues/);

  const existing = normalizePrepareManifest(
    { status: "verified", gaps: [{ id: "old", status: "open" }] },
    { components: 0, matched: 0, unverified: 0, sourcePinned: 0, issues: ["ignored"] },
  );
  assert.equal(existing.status, "partial");

  const placeholder = normalizePrepareManifest(
    {
      status: "done",
      components: [
        {
          identity: "official source",
          platform: "GitHub",
          revision: "pending resolution",
          staged_path: "pending",
          match: "n/a-source-only-pending",
        },
      ],
    },
    { components: 1, matched: 0, unverified: 0, sourcePinned: 0, issues: [] },
  );
  assert.equal(placeholder.status, "partial");
  assert.match(placeholder.status_reason, /placeholders/);
});

test("prepare validation treats missing source components as a hard blocker", () => {
  const noComponents = prepareValidationBlockingIssues({
    components: 0,
    matched: 0,
    unverified: 0,
    sourcePinned: 0,
    issues: ["manifest lists no components", "missing docs/specs are best-effort"],
  });
  assert.deepEqual(noComponents, ["manifest lists no components"]);

  const sourceReadyWithCaveat = prepareValidationBlockingIssues({
    components: 1,
    matched: 0,
    unverified: 0,
    sourcePinned: 1,
    issues: ["official docs unavailable"],
  });
  assert.deepEqual(sourceReadyWithCaveat, []);
});

test("prepare manifest reader prefers the workspace file over stale scratch content", async () => {
  const dir = await tempDir();
  try {
    const session = newSession();
    session.scratchFiles.set("prepare_manifest.json", JSON.stringify({ components: [], clue: "early checkpoint" }));
    await writeFile(
      path.join(dir, "prepare_manifest.json"),
      JSON.stringify({
        clue: "final manifest",
        components: [
          {
            identity: "orchard",
            revision: "abc123",
            staged_path: "packages/crates/orchard-0.14.0",
            match: "n/a",
          },
        ],
      }),
    );

    const manifest = readPrepareManifest(session, dir);
    assert.equal(manifest.clue, "final manifest");
    assert.equal(manifest.components.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report manifest is compact but keeps finding-relevant path hints", () => {
  const source = Array.from({ length: 500 }, (_, idx) => ({
    path: `source/pkg/file-${idx}.ts`,
    content: `export const x${idx} = ${idx};\n`,
    kind: "source",
  }));
  const manifest = renderReportFileManifest(source, [], [
    {
      findingId: 1,
      findingKey: "k1",
      title: "Bug",
      location: "source/pkg/critical.ts:44",
      evidence: "The reproduced command cited source/pkg/critical.ts:44 and source/pkg/helper.nr:12.",
      decisions: [{ repro_evidence: "cmd1 exercised source/pkg/critical.ts:44" }],
    },
  ]);

  assert.ok(manifest.includes("Loaded workspace source: 500 files"));
  assert.ok(manifest.includes("Report-relevant path hints"));
  assert.ok(manifest.includes("source/pkg/critical.ts:44"));
  assert.ok(manifest.includes("source/pkg/helper.nr:12"));
  assert.ok(manifest.includes("300/500 shown"));
  assert.ok(!manifest.includes("source/pkg/file-499.ts"));
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

test("findings.json honors discharged status fields without allowing asserted confirmation", () => {
  const session = newSession();
  session.scratchFiles.set(
    "findings.json",
    JSON.stringify([
      { title: "balance obligation", location: "x.rs:1", status: "discharged", severity: "info" },
      { title: "proof obligation", location: "x.rs:2", confirmation_status: "discharged-with-line", severity: "info" },
      { title: "asserted confirm", location: "x.rs:3", status: "confirmed-executable", severity: "high" },
    ]),
  );

  const result = ingestFindingsFromScratch(session);
  assert.equal(result.parsed, 3);
  assert.equal(session.findings[0].confirmationStatus, "discharged");
  assert.equal(session.findings[1].confirmationStatus, "discharged");
  assert.equal(session.findings[2].confirmationStatus, "suspected", "confirmed status still requires a passed command_id");
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
      path: "audit_repro.test.mjs",
      content: "import test from 'node:test';\n\ntest('local harness success', () => {});\n",
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test audit_repro.test.mjs", purpose: "confirm", success_patterns: ["local harness success"] }, ctx);
    assert.match(run.observation, /not confirmation-eligible/);
    assert.match(run.observation, /standalone file/);
    assert.equal(ctx.session.commandRuns.length, 1);
    assert.equal(ctx.session.commandRuns[0].passed, false);
    assert.equal(ctx.session.commandRuns[0].targetLinked, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash blocks build when pinned toolchain does not match sandbox image", async () => {
  const dir = await tempDir();
  const oldPath = process.env.PATH;
  try {
    const target = path.join(dir, "target");
    const binDir = path.join(dir, "bin");
    await mkdir(target, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(target, "Scarb.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(target, ".tool-versions"), "scarb 2.12.0\n");
    const fakeScarb = path.join(binDir, "scarb");
    await writeFile(fakeScarb, "#!/usr/bin/env bash\nif [ \"$1\" = \"--version\" ]; then echo 'scarb 2.19.0'; exit 0; fi\necho 'unexpected scarb command' >&2\nexit 0\n");
    await chmod(fakeScarb, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sourcePaths = [target];
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepare = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const run = await tool("bash").run({ cmd: "scarb build", purpose: "build" }, ctx);
    assert.match(run.observation, /sandbox image\/toolchain preflight failed/);
    assert.match(run.observation, /scarb expected 2\.12\.0, actual scarb 2\.19\.0/);
    assert.match(run.observation, /resource_requests\.json/);
    assert.equal(ctx.session.commandRuns.length, 0);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash prepare ignores sibling pinned toolchains outside the focused build command", async () => {
  const dir = await tempDir();
  const oldPath = process.env.PATH;
  try {
    const target = path.join(dir, "target");
    const binDir = path.join(dir, "bin");
    const logPath = path.join(dir, "tool.log");
    await mkdir(target, { recursive: true });
    await mkdir(path.join(target, "cairo"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(target, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n");
    await writeFile(path.join(target, "yarn.lock"), "");
    await writeFile(path.join(target, "cairo", "Scarb.toml"), "[package]\nname = \"audit_target\"\nversion = \"0.1.0\"\n");
    await writeFile(path.join(target, "cairo", ".tool-versions"), "scarb 2.12.0\nstarknet-foundry 0.49.0\n");
    const fakeYarn = path.join(binDir, "yarn");
    await writeFile(fakeYarn, `#!/usr/bin/env bash\necho "yarn $PWD $*" >> ${JSON.stringify(logPath)}\nexit 0\n`);
    await chmod(fakeYarn, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;

    const cfg = defaultConfig();
    cfg.sourcePaths = [target];
    cfg.sandboxBackend = "host";
    cfg.sandboxAllowHostFallback = true;
    cfg.auditPrepare = true;
    cfg.auditPrepareTimeoutMs = 10_000;
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const run = await tool("bash").run({ cmd: "yarn install --frozen-lockfile", purpose: "build" }, ctx);
    assert.doesNotMatch(run.observation, /sandbox image\/toolchain preflight failed/);
    assert.match(await readFile(logPath, "utf8"), /yarn .* install --frozen-lockfile/);
    assert.equal(ctx.session.commandRuns.length, 1);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("confirmed executable commands must link model-written tests to pristine target source", async () => {
  const dir = await tempDir();
  try {
    const target = path.join(dir, "target");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "vulnerable.mjs"), "export function acceptsBadInput(value) { return value === 'bad'; }\n");
    const cfg = defaultConfig();
    cfg.sourcePaths = [target];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    await tool("write").run({
      path: "linked_repro.test.mjs",
      content:
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { acceptsBadInput } from './vulnerable.mjs';\n\ntest('target path executes', () => { assert.equal(acceptsBadInput('bad'), true); console.log('TARGET_PATH_CONFIRMED'); });\n",
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test linked_repro.test.mjs", purpose: "confirm", success_patterns: ["TARGET_PATH_CONFIRMED"] }, ctx);
    assert.match(run.observation, /CONFIRMATION-ELIGIBLE PASS/);
    assert.equal(ctx.session.commandRuns[0].passed, true);
    assert.equal(ctx.session.commandRuns[0].targetLinked, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("confirm target-link parsing ignores Foundry project root flags but keeps explicit files", () => {
  const session = {
    scratchFiles: new Map([["poc/standalone.t.sol", "contract Standalone {}"]]),
    baselineFiles: new Set(["sources/silo-contracts-v3-3.5.0/silo-core/contracts/Silo.sol"]),
  };

  const projectRunnerArgs = commandFileArgsForTest({
    program: "forge",
    args: [
      "test",
      "--root",
      "sources/silo-contracts-v3-3.5.0",
      "--contracts",
      "silo-core/contracts",
      "--match-contract",
      "SiloConfirmCoreRel",
      "--via-ir",
      "-vv",
    ],
  }, session);
  assert.deepEqual(projectRunnerArgs, []);

  const explicitFileArgs = commandFileArgsForTest({
    program: "forge",
    args: ["test", "poc/standalone.t.sol", "--match-contract", "Standalone"],
  }, session);
  assert.deepEqual(explicitFileArgs, ["poc/standalone.t.sol"]);
});

test("confirm target-link parsing resolves Foundry rooted match paths without treating runner flags as files", () => {
  const testPath = "sources/deployed-v2/20220609-stable-pool-v2/test/StablePoolV2LiveForkNonconvergent.t.sol";
  const session = {
    scratchFiles: new Map([[testPath, "import '../sources/contracts/StableMath.sol';\ncontract Repro {}\n"]]),
    baselineFiles: new Set(["sources/deployed-v2/20220609-stable-pool-v2/sources/contracts/StableMath.sol"]),
  };
  const command = {
    program: "forge",
    args: [
      "test",
      "--root",
      "sources/deployed-v2/20220609-stable-pool-v2",
      "--match-path",
      "test/StablePoolV2LiveForkNonconvergent.t.sol",
      "--fork-url",
      "https://ethereum.publicnode.com",
      "--use",
      "0.7.6",
      "--remappings",
      "@balancer-labs/=sources/@balancer-labs/",
      "-vv",
    ],
  };

  assert.deepEqual(commandFileArgsForTest(command, session), [testPath]);
  const targetLink = confirmCommandTargetLinkForTest(command, session);
  assert.equal(targetLink.linked, true);
});

test("confirm target-link parsing resolves cwd-relative Hardhat test files to pristine imports", () => {
  const testPath = "sources/evm-smart-contracts/test/BridgeAdapterSourceBinding.poc.ts";
  const session = {
    scratchFiles: new Map([[
      testPath,
      "import PRISTINE_BRIDGE_SOURCE from '../contracts/bridge/Bridge.sol';\n"
        + "it('reproduces through target source', () => console.log(PRISTINE_BRIDGE_SOURCE));\n",
    ]]),
    baselineFiles: new Set([
      "sources/evm-smart-contracts/contracts/bridge/Bridge.sol",
      "sources/evm-smart-contracts/test/Bridge.ts",
    ]),
  };
  const command = {
    program: "npx",
    args: ["hardhat", "test", "--no-compile", "test/BridgeAdapterSourceBinding.poc.ts"],
    cwd: "sources/evm-smart-contracts",
  };

  assert.deepEqual(commandFileArgsForTest(command, session), [testPath]);
  const targetLink = confirmCommandTargetLinkForTest(command, session);
  assert.equal(targetLink.linked, true);
});

test("confirm target-link parsing follows command-line remappings from scratch tests to pristine source", () => {
  const session = {
    scratchFiles: new Map([[
      "poc/test/StablePoolV2LiveForkNonconvergent.t.sol",
      "import 'stablev2/contracts/StableMath.sol';\ncontract Repro {}\n",
    ]]),
    baselineFiles: new Set(["sources/deployed-v2/20220609-stable-pool-v2/sources/contracts/StableMath.sol"]),
  };
  const command = {
    program: "forge",
    args: [
      "test",
      "poc/test/StablePoolV2LiveForkNonconvergent.t.sol",
      "--remappings",
      "stablev2/=sources/deployed-v2/20220609-stable-pool-v2/sources/",
      "-vv",
    ],
  };

  assert.deepEqual(commandFileArgsForTest(command, session), ["poc/test/StablePoolV2LiveForkNonconvergent.t.sol"]);
  const targetLink = confirmCommandTargetLinkForTest(command, session);
  assert.equal(targetLink.linked, true);
});

test("failed bash command events include an output preview for the UI", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    await tool("write").run({
      path: "failing_repro.test.mjs",
      content: "import test from 'node:test';\n\ntest('visible failure', () => { throw new Error('VISIBLE_FAILURE_REASON'); });\n",
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test failing_repro.test.mjs", purpose: "confirm", success_patterns: ["NEVER_SEEN"] }, ctx);
    assert.match(run.observation, /VISIBLE_FAILURE_REASON/);

    const events = (await readFile(logger.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const commandStart = events.find((event) => event.kind === "audit_command_start");
    assert.equal(commandStart.runId, "cmd1");
    assert.equal(commandStart.purpose, "confirm");
    assert.equal(commandStart.command, "node --test failing_repro.test.mjs");
    const commandEvent = events.find((event) => event.kind === "audit_command_run");
    assert.equal(commandEvent.exitCode, 1);
    assert.match(commandEvent.output, /VISIBLE_FAILURE_REASON/);
    assert.ok(commandEvent.output.length <= 2600, "event output preview should stay bounded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed bash command previews preserve early diagnostics and late context", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    await tool("write").run({
      path: "noisy_compiler_failure.test.mjs",
      content: [
        "import test from 'node:test';",
        "test('noisy compiler output', () => {",
        "  console.log('EARLY_COMPILE_ERROR: unresolved Cairo symbol');",
        "  for (let i = 0; i < 220; i += 1) console.log('warning ' + i + ': workspace manifest profile output');",
        "  console.log('LATE_COMPILER_CONTEXT: Scarb exited with error');",
        "  throw new Error('NOISY_COMPILER_FAIL');",
        "});",
      ].join("\n"),
    }, ctx);
    const run = await tool("bash").run({ cmd: "node --test noisy_compiler_failure.test.mjs", purpose: "confirm", success_patterns: ["NEVER_SEEN"] }, ctx);
    assert.match(run.observation, /EARLY_COMPILE_ERROR/);
    assert.match(run.observation, /LATE_COMPILER_CONTEXT/);

    const events = (await readFile(logger.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const commandEvent = events.find((event) => event.kind === "audit_command_run");
    assert.equal(commandEvent.exitCode, 1);
    assert.match(commandEvent.output, /EARLY_COMPILE_ERROR/);
    assert.match(commandEvent.output, /LATE_COMPILER_CONTEXT/);
    assert.ok(commandEvent.output.length <= 2600, "event output preview should stay bounded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read and activity summaries do not expose or resolve host absolute paths", async () => {
  const dir = await tempDir();
  const hostPath = "/opt/private/flounder/SKILL.md";
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const source = [{ path: hostPath, kind: "source", content: "host-only content\n" }];
    const ctx = { cfg, source, corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const read = await tool("read").run({ path: hostPath, start: 1, end: 1 }, ctx);
    assert.match(read.observation, /safe relative path/);
    assert.doesNotMatch(read.observation, /opt\/private/);
    assert.doesNotMatch(read.observation, /host-only content/);

    const summary = describeAction("read", { path: hostPath, start: 1, end: 1 }, read.observation);
    assert.equal(summary.ok, false);
    assert.equal(summary.detail, "[outside workspace]:1-1");
    assert.doesNotMatch(summary.result, /opt\/private/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prepare/confirm report files may cite public URLs while generated PoC files stay guarded", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.sourcePaths = [fixtures];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const prepare = await tool("write").run({
      path: "prepare_manifest.json",
      content: JSON.stringify({ components: [{ source: "repo@commit", where: "https://example.com/repo" }] }),
    }, ctx);
    assert.match(prepare.observation, /wrote prepare_manifest\.json/);

    const confirm = await tool("write").run({
      path: "confirm_decision.json",
      content: JSON.stringify([{ bug: "x", novelty: "already-disclosed: https://example.com/advisory" }]),
    }, ctx);
    assert.match(confirm.observation, /wrote confirm_decision\.json/);

    const impact = await tool("write").run({
      path: "impact_inventory.json",
      content: JSON.stringify({ items: [{ bug: "x", status: "unknown", blockers: ["needs live balance sizing"] }] }),
    }, ctx);
    assert.match(impact.observation, /wrote impact_inventory\.json/);

    const poc = await tool("write").run({
      path: "exploit.test.mjs",
      content: "fetch('https://mainnet.example/rpc');\n",
    }, ctx);
    assert.match(poc.observation, /blocked/i);
    assert.match(poc.observation, /remote URLs/i);

    cfg.prepareMode = true;
    const helper = await tool("write").run({
      path: "fetch_release_info.py",
      content: "URL = 'https://api.github.com/repos/official/project/releases'\nprint(URL)\n",
    }, ctx);
    assert.match(helper.observation, /wrote fetch_release_info\.py/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sandbox workspace copy and read skip symlinks that point outside the source", async () => {
  const dir = await tempDir();
  try {
    const src = path.join(dir, "src");
    const outside = path.join(dir, "secret.txt");
    await mkdir(src);
    await writeFile(path.join(src, "safe.txt"), "safe");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(src, "leak.txt"));

    const cfg = defaultConfig();
    cfg.sourcePaths = [src];
    const logger = await tempLogger(dir);
    const ctx = { cfg, source: [], corpus: [], memory: new ProjectMemory(path.join(dir, "memory.jsonl")), logger, session: newSession() };

    const safe = await tool("read").run({ path: "safe.txt" }, ctx);
    assert.match(safe.observation, /safe/);
    const leaked = await tool("read").run({ path: "leak.txt" }, ctx);
    assert.match(leaked.observation, /no loaded or sandbox file matches/i);
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

    const events = (await readFile(logger.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const inspectEvent = events.filter((event) => event.kind === "audit_command_run").at(-1);
    assert.equal(inspectEvent.purpose, "inspect");
    assert.equal(inspectEvent.ok, true, "successful inspect commands should render as successful activity");
    assert.equal(inspectEvent.passed, false, "inspect commands are still not confirmation-eligible");
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

    const harnessManifest = await tool("write").run({ path: "verify_poc/Scarb.toml", content: "[package]\nname = \"verify_poc\"\nversion = \"0.1.0\"\n" }, ctx);
    assert.match(harnessManifest.observation, /wrote verify_poc\/Scarb\.toml/);

    const scratchHarnessManifest = await tool("write").run({ path: ".tmp/verify_poc/Scarb.toml", content: "[package]\nname = \"verify_poc\"\nversion = \"0.1.0\"\n" }, ctx);
    assert.match(scratchHarnessManifest.observation, /wrote \.tmp\/verify_poc\/Scarb\.toml/);

    const topLevelManifest = await tool("write").run({ path: "Scarb.toml", content: "[package]\nname = \"production_shim\"\nversion = \"0.1.0\"\n" }, ctx);
    assert.match(topLevelManifest.observation, /blocked/i);
    assert.match(topLevelManifest.observation, /production source files must stay pristine/i);

    session.baselineFiles.add("contracts/contracts/Proxy.sol");
    const newNativeTest = await tool("write").run({ path: "contracts/test/hidden_upgrade_target_hash.spec.ts", content: "// poc\n" }, ctx);
    assert.match(newNativeTest.observation, /wrote contracts\/test\/hidden_upgrade_target_hash\.spec\.ts/);

    const newProductionSource = await tool("write").run({ path: "contracts/contracts/KeysWithPlonkVerifier.sol", content: "contract BuildShim {}\n" }, ctx);
    assert.match(newProductionSource.observation, /blocked/i);
    assert.match(newProductionSource.observation, /production source files must stay pristine/i);

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
    map: { thinking: "off" },
    refute: { provider: "openai-codex", model: "gpt-5.5" },
    bogus: { provider: "x" }, // ignored — not a known role
  });
  assert.deepEqual(resolveRole(cfg, "map"), { provider: "claude-code", model: "claude-opus-4-8", thinking: "off" });
  assert.equal(normalizeRoleModels({ map: { thinking: "not-a-level" } }), undefined);
  // dig bumps thinking to xhigh, keeps inherited provider/model.
  assert.deepEqual(resolveRole(cfg, "dig"), { provider: "claude-code", model: "claude-opus-4-8", thinking: "xhigh" });
  // refute switches provider+model (the claude-code → codex switch the user wants), inherits thinking from default.
  assert.deepEqual(resolveRole(cfg, "refute"), { provider: "openai-codex", model: "gpt-5.5", thinking: "high" });
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
  for (const needle of ["obligation", "DESIGN INTENT", "ABSENCE is the finding", "wrong referent", "looks standard", "complete binding chain"]) {
    assert.ok(AUDIT_DEEP_SYSTEM.includes(needle), `deep system prompt missing: ${needle}`);
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
    const result = await runRefutation({ findings, source, cfg, llm, logger, max: 8 });
    const verdicts = result.verdicts;
    assert.equal(verdicts.length, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(findings[0].refutation.refuted, false);
    assert.equal(findings[1].refutation.refuted, true);
    assert.match(findings[1].refutation.reason, /enforced/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refutation reports model-call errors without manufacturing a verdict", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const source = [{ path: "x.rs", kind: "source", content: "fn check() {}\n" }];
    const findings = [
      { id: "f1", title: "candidate", severity: "high", location: "x.rs:1", description: "", evidence: "", exploitSketch: "", fix: "", confidence: 0.9, confirmationStatus: "confirmed-executable" },
    ];
    const llm = { async complete() { throw new Error("session completion returned no text"); } };
    const result = await runRefutation({ findings, source, cfg, llm, logger, max: 8 });
    assert.equal(result.attempted, 1);
    assert.equal(result.verdicts.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(findings[0].refutation, undefined);
    assert.match(result.errors[0].error, /no text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forced finalize: a run that never writes findings.json still captures hypotheses", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.auditMaxSteps = 3;
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
        if (input.tag === "audit_finalize") {
          return JSON.stringify([
            { title: "Residual suspicion in x.rs", severity: "medium", location: "x.rs:2", description: "looked off", confidence: 0.3 },
          ]);
        }
        return JSON.stringify({ thought: "one more read", tool: "read", args: { path: "x.rs" } });
      },
    };

    const result = await runAuditLoop({ cfg, llm, tools: buildTools(), ctx, logger, maxSteps: 3, fileManifest: "x.rs" });
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

test("legacy loop uses the synthesis prompt instead of falling back to breadth audit", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    const logger = await tempLogger(dir);
    const session = newSession();
    const ctx = {
      cfg,
      source: [{ path: "x.rs", kind: "source", content: "line1\n" }],
      corpus: [],
      memory: new ProjectMemory(path.join(dir, "memory.jsonl")),
      logger,
      session,
    };
    const calls = [];
    const llm = {
      async complete(input) {
        calls.push(input);
        if (input.tag === "audit_finalize") return "[]";
        assert.match(input.system, /SYNTHESIS mode/);
        assert.match(input.user, /sink-driven synthesis/i);
        assert.match(input.user, /PER-SCOPE FINDINGS/);
        return JSON.stringify({ thought: "synthesis complete", done: true, summary: "done" });
      },
    };

    const result = await runAuditLoop({
      cfg,
      llm,
      tools: buildTools(),
      ctx,
      logger,
      maxSteps: 3,
      fileManifest: "x.rs",
      synthesize: "PER-SCOPE FINDINGS\n- suspected link reaches sink",
    });
    assert.equal(result.stoppedReason, "finished");
    assert.ok(calls.some((call) => call.system.includes("SYNTHESIS mode")), "synthesis system prompt should be used");
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

test("disclosure report only labels patch-blocking patterns after differential confirmation", () => {
  const baseFinding = {
    id: "f1",
    title: "Noncanonical field accepted",
    severity: "medium",
    location: "src/verifier.cpp:10",
    description: "description",
    evidence: "evidence",
    exploitSketch: "exploit",
    fix: "fix",
    confidence: 0.9,
    failureMode: "autonomous",
    confirmationStatus: "confirmed-executable",
    commandRunId: "cmd1",
    patchedSuccessPatterns: ["EXPLOIT BLOCKED"],
  };
  const executableOnly = renderDisclosure("target", baseFinding);
  assert.match(executableOnly, /Confirmation command: `cmd1`/);
  assert.doesNotMatch(executableOnly, /Patch-blocking success patterns/);
  assert.doesNotMatch(executableOnly, /EXPLOIT BLOCKED/);

  const differential = renderDisclosure("target", { ...baseFinding, confirmationStatus: "confirmed-differential" });
  assert.match(differential, /Patch-blocking success patterns/);
  assert.match(differential, /EXPLOIT BLOCKED/);
});

test("audit produces an execution-confirmed finding and banks cross-run memory", async () => {
  const dir = await tempDir();
  try {
    const corpusFile = path.join(dir, "spec.md");
    await writeFile(corpusFile, "# Protocol spec\nThe nullifier must be unique per note.\n");
    const cfg = defaultConfig();
    cfg.targetName = "agent-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [corpusFile];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditMaxSteps = 10;

    const { runDir, summary } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    assert.equal(summary.findings.length, 1);
    const finding = summary.findings[0];
    assert.equal(finding.confirmationStatus, "confirmed-executable", "a finding the skeptic could not refute stays confirmed");
    assert.equal(finding.failureMode, "autonomous", "audit findings are not forced into a fixed taxonomy");
    assert.equal(summary.coverage.verifiedFindings, 1);
    assert.equal(summary.coverage.unverifiedFindings, 0);
    assert.equal(summary.coverage.hypotheses, 0, "the mock's single candidate is confirmed, so there are no hypotheses");

    // Only confirmed candidates become findings; hypotheses are a separate artifact.
    const findingsArtifact = JSON.parse(await readFile(path.join(runDir, "audit_findings.json"), "utf8"));
    assert.equal(findingsArtifact.length, 1);
    const hypothesesArtifact = JSON.parse(await readFile(path.join(runDir, "audit_hypotheses.json"), "utf8"));
    assert.equal(hypothesesArtifact.length, 0);

    // The fixture workspace has no toolchain manifest, so the warm-up is a no-op
    // (no audit_prepare.json) and never blocks an offline run.
    let prepareWritten = true;
    try {
      await stat(path.join(runDir, "audit_prepare.json"));
    } catch {
      prepareWritten = false;
    }
    assert.equal(prepareWritten, false, "warm-up must no-op when no manifest is present");

    // Corpus is copied into the workspace so the agent can read/grep it.
    const corpusEntries = await readdir(path.join(runDir, "audit", "workspace", "corpus"));
    assert.ok(corpusEntries.length >= 1, "corpus material must be copied into the workspace");

    const transcript = JSON.parse(await readFile(path.join(runDir, "audit_transcript.json"), "utf8"));
    assert.equal(transcript.stoppedReason, "finished");
    assert.ok(transcript.steps.some((step) => step.tool === "read"));
    assert.ok(transcript.steps.some((step) => step.tool === "write"));
    assert.ok(transcript.steps.some((step) => step.tool === "bash"));
    assert.ok(!transcript.steps.some((step) => step.tool === "dataflow"), "audit default tools must not include strategy aids");

    const commandRuns = JSON.parse(await readFile(path.join(runDir, "audit_command_runs.json"), "utf8"));
    assert.equal(commandRuns.length, 1);
    assert.equal(commandRuns[0].passed, true);

    // Run artifacts must stay free of machine-absolute source paths.
    const report = await readFile(path.join(runDir, "report_f1.md"), "utf8");
    assert.ok(!report.includes(root), "reports must not leak local absolute paths");
    assert.ok(report.includes("Local executable evidence:"), "confirmed reports should show local execution evidence");
    assert.ok(report.includes("Confirmation command:"), "confirmed reports should cite the command id");
    assert.ok(!report.includes("Executable reproduction not generated"), "confirmed reports should not claim the PoC is missing");

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
    cfg.auditDeep = true; // map → dig flow (no pinned focus)
    cfg.auditSynthesize = false; // this test pins the per-scope dig output; the synthesis pass is exercised elsewhere
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 1; // audit only the top scope this run; the rest stay pending

    const { runDir, summary, scopeCoverage } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    // The map phase wrote the full scope inventory; dig audited only the top one.
    const scopes = JSON.parse(await readFile(path.join(runDir, "audit_scopes.json"), "utf8"));
    assert.equal(scopes.length, 2, "map enumerates the complete inventory");
    const s1 = scopes.find((s) => s.id === "S1");
    const s2 = scopes.find((s) => s.id === "S2");
    assert.equal(s1.status, "audited", "the highest-scored scope is audited");
    assert.equal(s2.status, "pending", "scopes beyond the cap stay pending (not dropped)");
    assert.deepEqual(scopeCoverage, { total: 2, audited: 1, pending: 1, deferred: 0 });

    // Dig produced the confirmed finding, tagged by the scope it came from.
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.findings[0].confirmationStatus, "confirmed-executable");
    const findingsArtifact = JSON.parse(await readFile(path.join(runDir, "audit_findings.json"), "utf8"));
    assert.equal(findingsArtifact[0].scopeId, "S1", "dig findings are tagged with the scope they came from");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig: a zero scope target does not audit an extra pending scope", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "mapdig-zero-target-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditDeep = true;
    cfg.auditSynthesize = false;
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 0;

    const runScopes = [];
    const tracker = {
      runDbId: undefined,
      scopes() {},
      runScopes(done, target) {
        runScopes.push({ done, target });
      },
      findings() {},
      stage() {},
      confirmDecisions() {},
      finish() {},
    };

    const { runDir, summary, scopeCoverage } = await runAudit(cfg, {
      llm: new MockAuditLlmClient(),
      makeTracker: () => tracker,
    });

    const scopes = JSON.parse(await readFile(path.join(runDir, "audit_scopes.json"), "utf8"));
    assert.equal(scopes.length, 2, "map still enumerates the inventory");
    assert.equal(scopes.find((s) => s.id === "S1").status, "pending");
    assert.equal(scopes.find((s) => s.id === "S2").status, "pending");
    assert.deepEqual(scopeCoverage, { total: 2, audited: 0, pending: 2, deferred: 0 });
    assert.equal(summary.findings.length, 0);
    assert.deepEqual(runScopes[0], { done: 0, target: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig: a running sequential batch can shrink its scope target at a scope boundary", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "mapdig-adjust-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditDeep = true;
    cfg.auditSynthesize = false;
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 2;
    cfg.auditDigConcurrency = 1;

    let liveTarget = 2;
    const runScopes = [];
    const tracker = {
      runDbId: undefined,
      scopes() {},
      runScopes(done, target) {
        runScopes.push({ done, target });
        if (done === 0 && target === 2) liveTarget = 1;
      },
      findings() {},
      stage() {},
      confirmDecisions() {},
      finish() {},
    };

    const { runDir, scopeCoverage } = await runAudit(cfg, {
      llm: new MockAuditLlmClient(),
      control: { getRunScopesTarget: () => liveTarget },
      makeTracker: () => tracker,
    });

    const scopes = JSON.parse(await readFile(path.join(runDir, "audit_scopes.json"), "utf8"));
    assert.equal(scopes.find((s) => s.id === "S1").status, "audited");
    assert.equal(scopes.find((s) => s.id === "S2").status, "pending", "scope past the adjusted target stays pending");
    assert.deepEqual(scopeCoverage, { total: 2, audited: 1, pending: 1, deferred: 0 });
    assert.ok(runScopes.some((row) => row.done === 0 && row.target === 1), "tracker sees the adjusted target before the next scope starts");
    assert.ok(runScopes.some((row) => row.done === 1 && row.target === 1), "final batch progress reflects the adjusted target");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map → dig: stopping during a scope requeues the in-flight scope", async () => {
  const dir = await tempDir();
  try {
    const cfg = defaultConfig();
    cfg.targetName = "mapdig-stop-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditDeep = true;
    cfg.auditSynthesize = false;
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 1;

    const abort = new AbortController();
    const tracker = {
      runDbId: undefined,
      scopes(scopes) {
        if (scopes.some((scope) => scope.id === "S1" && scope.status === "auditing")) abort.abort();
      },
      runScopes() {},
      findings() {},
      stage() {},
      confirmDecisions() {},
      finish() {},
    };

    await assert.rejects(
      runAudit(cfg, { llm: new MockAuditLlmClient(), signal: abort.signal, makeTracker: () => tracker }),
      /audit aborted/,
    );

    const inventoryPath = path.join(cfg.outputDir, "history", "mapdig-stop-e2e", "scopes.json");
    const scopes = JSON.parse(await readFile(inventoryPath, "utf8"));
    assert.equal(scopes.find((scope) => scope.id === "S1")?.status, "pending", "a stopped in-flight scope must not stay auditing");
    assert.equal(scopes.find((scope) => scope.id === "S2")?.status, "pending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify mode inherits the original finding scope", async () => {
  const dir = await tempDir();
  try {
    const verifyFile = path.join(dir, "to-verify.json");
    await writeFile(verifyFile, JSON.stringify([{ title: "candidate", location: "halo2_missing_constraint.rs:5", severity: "high", description: "lead", scope_id: "SCOPE-7" }]), "utf8");

    const cfg = defaultConfig();
    cfg.targetName = "verify-scope-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditVerify = verifyFile;
    cfg.auditDigSteps = 8;
    cfg.auditSynthesize = false;

    const store = MetadataStore.openForOutput(cfg.outputDir);
    const projectId = store.upsertProject({ name: cfg.targetName, sourcePaths: cfg.sourcePaths, corpusPaths: cfg.corpusPaths, config: {} });
    store.replaceScopes(projectId, [
      { scopeId: "SCOPE-7", title: "existing candidate scope", status: "audited" },
      { scopeId: "SCOPE-8", title: "remaining scope", status: "pending" },
    ]);
    store.close();

    const { runDir } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    const findings = JSON.parse(await readFile(path.join(runDir, "audit_findings.json"), "utf8"));
    assert.equal(findings[0]?.scopeId, "SCOPE-7", "verify verdict should keep the candidate's scope linkage");
    const after = MetadataStore.openForOutput(cfg.outputDir);
    try {
      const existing = after.getProject(cfg.targetName);
      assert.deepEqual(after.scopeProgress(Number(existing.id)), { total: 2, audited: 1, pending: 1, deferred: 0 }, "verify must not clear the mapped scope inventory");
    } finally {
      after.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify mode isolates generated PoC files between candidates", async () => {
  const dir = await tempDir();
  try {
    const verifyFile = path.join(dir, "to-verify.json");
    await writeFile(verifyFile, JSON.stringify([
      { title: "first marker claim", location: "halo2_missing_constraint.rs:5", severity: "high", description: "write an isolated marker" },
      { title: "second isolation claim", location: "halo2_missing_constraint.rs:5", severity: "high", description: "try to read the first marker" },
    ]), "utf8");

    const cfg = defaultConfig();
    cfg.targetName = "verify-isolation-e2e";
    cfg.sourcePaths = [fixtures];
    cfg.corpusPaths = [fixtures];
    cfg.outputDir = path.join(dir, "runs");
    cfg.auditVerify = verifyFile;
    cfg.auditDigSteps = 6;
    cfg.auditRefute = false;
    cfg.auditSynthesize = false;

    const { runDir } = await runAudit(cfg, { llm: new VerifyIsolationLlmClient() });
    const transcript = JSON.parse(await readFile(path.join(runDir, "audit_transcript.json"), "utf8"));
    const markerReads = transcript.steps.filter((step) => step.tool === "read" && step.args?.path === "tests/verify-marker.poc.test.js");
    assert.equal(markerReads.length, 1);
    assert.match(markerReads[0].observation, /no loaded or sandbox file matches "tests\/verify-marker\.poc\.test\.js"/);
    assert.ok((await stat(path.join(runDir, "audit", "verify-1", "tests", "verify-marker.poc.test.js"))).isFile());
    await assert.rejects(stat(path.join(runDir, "audit", "verify-2", "tests", "verify-marker.poc.test.js")), /ENOENT/);
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
    cfg.auditDeep = true;
    cfg.auditSynthesize = false; // pins the per-scope dig output; synthesis is a separate pass
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 2;
    cfg.auditDigConcurrency = 2; // audit both scopes in parallel

    const { runDir, summary } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    // Both enumerated scopes were deep-audited concurrently, each producing its finding.
    assert.equal(summary.findings.length, 2, "both scopes audited in parallel");
    const findings = JSON.parse(await readFile(path.join(runDir, "audit_findings.json"), "utf8"));
    const scopeIds = new Set(findings.map((f) => f.scopeId));
    assert.ok(scopeIds.has("S1") && scopeIds.has("S2"), "findings are tagged with both scopes");
    for (const f of findings) assert.equal(f.confirmationStatus, "confirmed-executable");

    // Each concurrent dig ran in its own isolated workspace (no sharing).
    const digDirs = (await readdir(path.join(runDir, "audit"))).filter((n) => n.startsWith("dig-"));
    assert.ok(digDirs.includes("dig-S1") && digDirs.includes("dig-S2"), "each scope got its own workspace");

    // Findings are re-id'd uniquely across scopes, so each gets its own disclosure
    // report, and a single consolidated report is auto-written.
    const ids = new Set(findings.map((f) => f.id));
    assert.equal(ids.size, 2, "findings have unique ids across scopes");
    const runFiles = await readdir(runDir);
    assert.ok(runFiles.includes("report_f1.md") && runFiles.includes("report_f2.md"), "one disclosure report per finding");
    assert.ok(runFiles.includes("audit_report.md"), "a consolidated results report is auto-written");
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
      auditDeep: true,
      auditMapSteps: 6,
      auditDigSteps: 8,
      auditMaxScopes: 1,
    };

    // Run 1: map enumerates S1+S2, dig audits S1, S2 left pending.
    const run1 = await runAudit({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });
    assert.deepEqual(run1.scopeCoverage, { total: 2, audited: 1, pending: 1, deferred: 0 });
    const events1 = (await readFile(path.join(run1.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events1.some((e) => e.kind === "audit_map_done"), "run 1 enumerates the inventory");

    // Run 2: same target/out → resume. No new map; audits the next pending scope (S2).
    const run2 = await runAudit({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });
    assert.deepEqual(run2.scopeCoverage, { total: 2, audited: 2, pending: 0, deferred: 0 }, "the second run completes coverage");
    const events2 = (await readFile(path.join(run2.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!events2.some((e) => e.kind === "audit_map_done"), "run 2 must not re-run the map phase");
    assert.ok(events2.some((e) => e.kind === "audit_map_resumed"), "run 2 resumes the persisted inventory");
    const run2Findings = JSON.parse(await readFile(path.join(run2.runDir, "audit_findings.json"), "utf8"));
    assert.equal(run2Findings[0]?.scopeId, "S2", "run 2 audits the previously-pending scope (S2)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("map append expands inventory without replacing audited scope state", async () => {
  const dir = await tempDir();
  try {
    const base = {
      targetName: "append-map-e2e",
      sourcePaths: [fixtures],
      corpusPaths: [fixtures],
      outputDir: path.join(dir, "runs"),
      auditDeep: true,
      auditSynthesize: false,
      auditRefute: false,
      auditMapSteps: 6,
      auditDigSteps: 8,
      auditMaxScopes: 1,
    };

    const run1 = await runAudit({ ...defaultConfig(), ...base }, { llm: new AppendMapLlmClient() });
    assert.deepEqual(run1.scopeCoverage, { total: 2, audited: 1, pending: 1, deferred: 0 });

    const append = await runAudit({ ...defaultConfig(), ...base, auditMapOnly: true, auditAppendMap: true }, { llm: new AppendMapLlmClient() });
    assert.deepEqual(append.scopeCoverage, { total: 3, audited: 1, pending: 2, deferred: 0 });
    const scopes = JSON.parse(await readFile(path.join(append.runDir, "audit_scopes.json"), "utf8"));
    assert.equal(scopes.length, 3);
    assert.equal(scopes.find((s) => s.id === "S1")?.status, "audited");
    assert.equal(scopes.find((s) => s.id === "S2")?.status, "pending");
    assert.ok(scopes.some((s) => s.obligation === "tertiary advice region must bind to its source" && s.status === "pending"));
    const events = (await readFile(path.join(append.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.kind === "audit_map_append_done" && e.added === 1 && e.skippedDuplicate === 1));
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
    cfg.auditMaxSteps = 6;

    const { runDir } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    // The sandbox workspace contains the build root's manifest (copied from buildRoot),
    // which is NOT under the narrow sourcePaths subdir — proving buildRoot drove the copy.
    const manifest = path.join(runDir, "audit", "workspace", "Cargo.toml");
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
      auditDeep: true,
      auditMapSteps: 6,
      auditDigSteps: 8,
      auditMaxScopes: 1,
    };

    // Run 1 enumerates S1+S2 and audits S1 (top score); S2 left pending.
    await runAudit({ ...defaultConfig(), ...base }, { llm: new MockAuditLlmClient() });

    // Pick S2 explicitly — skip map, ignore score order, deep-audit exactly S2.
    const picked = await runAudit({ ...defaultConfig(), ...base, auditScopeIds: ["S2"] }, { llm: new MockAuditLlmClient() });
    const events = (await readFile(path.join(picked.runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.kind === "audit_map_done"), "picking must not re-map");
    assert.ok(events.some((e) => e.kind === "audit_scope_picked" && e.ids.includes("S2")), "the named scope is audited");
    const findings = JSON.parse(await readFile(path.join(picked.runDir, "audit_findings.json"), "utf8"));
    assert.equal(findings[0]?.scopeId, "S2", "the finding is tagged with the picked scope");

    // An unknown id is reported, not silently ignored.
    await assert.rejects(
      runAudit({ ...defaultConfig(), ...base, auditScopeIds: ["S99"] }, { llm: new MockAuditLlmClient() }),
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
    cfg.auditDeep = true;
    cfg.auditSynthesize = false; // pins the per-scope dig output; synthesis is a separate pass
    cfg.auditMapSteps = 6;
    cfg.auditDigSteps = 8;
    cfg.auditMaxScopes = 1;
    cfg.auditDigSamples = 2;

    const { runDir, summary } = await runAudit(cfg, { llm: new MockAuditLlmClient() });

    // Two independent dig passes ran; the identical finding is unioned to one.
    const events = (await readFile(path.join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const sampleEvents = events.filter((e) => e.kind === "audit_dig_sample");
    assert.equal(sampleEvents.length, 2, "two dig samples ran for the scope");
    assert.equal(summary.findings.length, 1, "the duplicate finding is unioned to one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit run directories are unique to the millisecond so rapid same-target runs do not collide", () => {
  // Regression for the resumable flow running back-to-back within one second.
  const t = new Date("2026-06-12T01:22:54.123Z");
  const t2 = new Date("2026-06-12T01:22:54.789Z");
  const a = new RunLogger("/tmp/x", "tgt", t).runDir;
  const b = new RunLogger("/tmp/x", "tgt", t2).runDir;
  assert.notEqual(a, b, "two runs in the same second must get distinct directories");
  assert.match(a, /tgt-20260612T012254123Z$/);
});
