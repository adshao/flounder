import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { loadSource } from "../dist/ingest/source.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { runPipeline } from "../dist/pipeline.js";
import { runSeeders } from "../dist/seeders/index.js";
import { importRunToProjectHistory, readProjectHistoryManifest, resolveProjectHistoryLatestRunDir } from "../dist/trace/history.js";
import { resolveLastRunDir } from "../dist/trace/last-run.js";

const root = path.resolve(".");
const fixtures = path.join(root, "fixtures");
const basicHalo2Fixture = path.join(fixtures, "halo2_missing_constraint.rs");
const scalarMulFixture = path.join(fixtures, "halo2_scalar_mul_binding.rs");

test("checklist seeders enumerate Halo2 missing-constraint audit items", async () => {
  const source = await loadSource([basicHalo2Fixture]);
  const items = runSeeders(source);
  assert.ok(source.every((doc) => !path.isAbsolute(doc.path)));
  assert.ok(source.every((doc) => !doc.path.includes(root)));
  assert.equal(items.filter((item) => item.failureMode === "missing_constraint").length, 2);
  assert.ok(items.every((item) => item.location.includes("halo2_missing_constraint.rs")));
});

test("checklist seeders enumerate scalar-mul advice dataflow questions from source shape", async () => {
  const source = await loadSource([scalarMulFixture]);
  const items = runSeeders(source);
  const bindingItems = items.filter((item) => item.seeder === "halo2_advice_binding");
  assert.equal(bindingItems.length, 1);
  assert.equal(bindingItems[0].failureMode, "missing_constraint");
  assert.match(bindingItems[0].location, /halo2_scalar_mul_binding\.rs:13-14/);
  assert.match(bindingItems[0].why, /scalar\/point dataflow context/);
  assert.match(bindingItems[0].securityProperty, /enforced by the downstream gates/);
});

test("checklist seeders enumerate Solidity name registry resolution questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-ens-seeder-"));
  const file = path.join(dir, "PermissionedRegistry.sol");
  await writeFile(file, `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PermissionedRegistry {
  mapping(uint256 tokenId => address resolver) resolvers;

  function setResolver(uint256 tokenId, address resolver, uint64 expires) external {
    resolvers[tokenId] = resolver;
  }

  function renew(uint256 tokenId, uint64 expiry) external {}
}
`);

  const source = await loadSource([dir]);
  const items = runSeeders(source);
  const ensItems = items.filter((item) => item.seeder === "solidity_name_registry_resolution");
  assert.equal(ensItems.length, 2);
  assert.ok(ensItems.every((item) => item.failureMode === "evm_name_registry_resolution"));
  assert.ok(ensItems.every((item) => item.location.includes("PermissionedRegistry.sol")));
  assert.match(ensItems[0].securityProperty, /resolver/);
  await rm(dir, { recursive: true, force: true });
});

test("checklist seeders enumerate Wormhole VAA and token bridge questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-wormhole-seeder-"));
  const file = path.join(dir, "Bridge.sol");
  await writeFile(file, `// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IWormhole {
  struct VM {
    bytes32 hash;
    uint32 guardianSetIndex;
    uint16 emitterChainId;
    bytes32 emitterAddress;
    uint64 sequence;
  }
  function parseAndVerifyVM(bytes memory encodedVM) external view returns (VM memory vm, bool valid, string memory reason);
  function getCurrentGuardianSetIndex() external view returns (uint32);
  function governanceChainId() external view returns (uint16);
  function governanceContract() external view returns (bytes32);
  function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel) external payable returns (uint64);
}

contract Bridge {
  IWormhole wormhole;
  mapping(uint16 => bytes32) bridgeContracts;
  mapping(bytes32 => bool) completedTransfers;

  function completeTransfer(bytes memory encodedVM) external {
    (IWormhole.VM memory vm, bool valid,) = wormhole.parseAndVerifyVM(encodedVM);
    require(valid, "invalid VAA");
    require(bridgeContracts[vm.emitterChainId] == vm.emitterAddress, "bad bridge");
    require(!completedTransfers[vm.hash], "consumed");
    completedTransfers[vm.hash] = true;
    emit TransferRedeemed(vm.emitterChainId, vm.emitterAddress, vm.sequence);
  }

  function submitGovernance(bytes memory encodedVM) external {
    (IWormhole.VM memory vm, bool valid,) = wormhole.parseAndVerifyVM(encodedVM);
    require(valid, "invalid governance VAA");
    require(vm.guardianSetIndex == wormhole.getCurrentGuardianSetIndex(), "stale guardian set");
    require(vm.emitterChainId == wormhole.governanceChainId(), "bad chain");
    require(vm.emitterAddress == wormhole.governanceContract(), "bad emitter");
    require(!governanceActionIsConsumed(vm.hash), "consumed");
    consumeGovernanceAction(vm.hash);
  }

  function publish(uint32 nonce, bytes memory payload, uint8 consistencyLevel) external payable {
    wormhole.publishMessage{value: msg.value}(nonce, payload, consistencyLevel);
  }
}
`);

  const source = await loadSource([dir]);
  const items = runSeeders(source);
  assert.ok(items.some((item) => item.seeder === "solidity_wormhole_vaa_verification"));
  assert.ok(items.some((item) => item.seeder === "solidity_wormhole_governance_binding"));
  assert.ok(items.some((item) => item.seeder === "solidity_wormhole_token_bridge_accounting"));
  assert.ok(items.some((item) => item.failureMode === "evm_wormhole_vaa_verification"));
  assert.ok(items.some((item) => item.failureMode === "evm_wormhole_governance_binding"));
  assert.ok(items.some((item) => item.seeder === "solidity_wormhole_token_bridge_accounting" && /AssetMeta/.test(item.why)));
  assert.ok(items.some((item) => item.seeder === "solidity_wormhole_token_bridge_accounting" && /wrapped-token self-attestation/.test(item.why)));
  assert.ok(items.every((item) => !path.isAbsolute(item.location)));
  await rm(dir, { recursive: true, force: true });
});

test("checklist seeders enumerate ZK proof orchestration binding questions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-zk-proof-seeder-"));
  await mkdir(path.join(dir, "crates", "libzkp", "src", "tasks"), { recursive: true });
  await writeFile(path.join(dir, "crates", "libzkp", "src", "tasks", "chunk.rs"), `
pub struct ChunkTask {
    pub block_hashes: Vec<B256>,
}

impl TryFromWithInterpreter<ChunkTask> for ChunkProvingTask {
    fn try_from_with_interpret(value: ChunkTask, interpreter: impl ChunkInterpreter) -> Result<Self> {
        let mut block_witnesses = Vec::new();
        for block_hash in value.block_hashes {
            let witness = interpreter.try_fetch_block_witness(block_hash, block_witnesses.last())?;
            block_witnesses.push(witness);
        }
        Ok(Self { block_witnesses })
    }
}

impl ChunkProvingTask {
    pub fn into_proving_task_with_precheck(self) -> Result<(ProvingTask, ChunkInfo, B256)> {
        let (witness, metadata, pi_hash) = self.precheck()?;
        let serialized_witness = encode_task_to_witness(&witness)?;
        Ok((ProvingTask { serialized_witness, aggregated_proofs: vec![] }, metadata, pi_hash))
    }
}
`);

  const source = await loadSource([dir]);
  const items = runSeeders(source);
  assert.ok(items.some((item) => item.seeder === "zk_proof_statement_binding"));
  assert.ok(items.some((item) => item.seeder === "zk_proof_aggregation_binding"));
  assert.ok(items.some((item) => item.failureMode === "proof_statement_binding"));
  assert.ok(items.every((item) => !path.isAbsolute(item.location)));
  await rm(dir, { recursive: true, force: true });
});

test("source loader includes cross-language code and manifests while skipping run artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-loader-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "infra"), { recursive: true });
  await mkdir(path.join(dir, "runs", "old-run"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "latest" } }));
  await writeFile(path.join(dir, "Dockerfile"), "FROM scratch\n");
  await writeFile(path.join(dir, "src", "Service.java"), "class Service { void handler() {} }\n");
  await writeFile(path.join(dir, "src", "schema.graphql"), "type Query { user(id: ID!): User }\n");
  await writeFile(path.join(dir, "infra", "main.tf"), "resource \"example\" \"target\" {}\n");
  await writeFile(path.join(dir, "runs", "old-run", "leaked.ts"), "export const stale = true;\n");

  const source = await loadSource([dir]);
  const loaded = source.map((doc) => doc.path);
  assert.ok(loaded.some((entry) => entry.endsWith("package.json")));
  assert.ok(loaded.some((entry) => entry.endsWith("Dockerfile")));
  assert.ok(loaded.some((entry) => entry.endsWith("Service.java")));
  assert.ok(loaded.some((entry) => entry.endsWith("schema.graphql")));
  assert.ok(loaded.some((entry) => entry.endsWith("main.tf")));
  assert.equal(loaded.some((entry) => entry.includes("leaked.ts")), false);
  assert.ok(loaded.every((entry) => !path.isAbsolute(entry)));
  assert.ok(loaded.every((entry) => !entry.includes(dir)));
});

test("source loader keeps external source-root context for duplicate basenames", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fsa-loader-roots-"));
  const bridge = path.join(dir, "bridge");
  const strk = path.join(dir, "strk");
  await mkdir(path.join(bridge, "src"), { recursive: true });
  await mkdir(path.join(strk, "src"), { recursive: true });
  await writeFile(path.join(bridge, "src", "lib.cairo"), "#[starknet::contract]\nmod Bridge {}\n");
  await writeFile(path.join(strk, "src", "lib.cairo"), "#[starknet::contract]\nmod Strk {}\n");

  const source = await loadSource([bridge, strk]);
  const loaded = source.map((doc) => doc.path).sort();
  assert.deepEqual(loaded, ["external/bridge/src/lib.cairo", "external/strk/src/lib.cairo"]);
  assert.ok(loaded.every((entry) => !path.isAbsolute(entry)));
  assert.ok(loaded.every((entry) => !entry.includes(dir)));
  await rm(dir, { recursive: true, force: true });
});

test("dry-run pipeline writes checklist and summary without model calls", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-dry-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-dry";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.dryRun = true;
  cfg.localChecklistSeeders = true;

  const result = await runPipeline(cfg);
  assert.equal(result.summary.coverage.itemsTotal, 5);
  assert.equal(result.summary.coverage.itemsWithFinding, 0);
  assert.equal(result.summary.coverage.bySeverity.high, 0);
  assert.deepEqual(result.summary.findings, []);
  await stat(path.join(result.runDir, "checklist.json"));
  await stat(path.join(result.runDir, "audit_results.json"));
  await stat(path.join(result.runDir, "lens_packs.json"));
  await stat(path.join(result.runDir, "summary.json"));
  await stat(path.join(result.runDir, "source_index.json"));
  await stat(path.join(result.runDir, "proof_obligations.json"));
  await stat(path.join(result.runDir, "checklist_coverage.json"));
  assert.deepEqual(await readdir(path.join(result.runDir, "calls")), []);
});

test("mock pipeline runs enumerate, audit, verify, and report end to end", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-mock-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-mock";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;
  cfg.localChecklistSeeders = true;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 2 });
  assert.equal(result.summary.coverage.itemsTotal, 6);
  assert.equal(result.summary.coverage.itemsWithFinding, 6);
  assert.equal(result.summary.coverage.bySeverity.high, 6);

  const verification = JSON.parse(await readFile(path.join(result.runDir, "verifications.json"), "utf8"));
  assert.equal(verification.length, 6);
  assert.equal(verification[0].verdict, "confirmed");
  assert.equal(result.summary.findings[0].confirmationStatus, "confirmed-source");
  const lensPacks = JSON.parse(await readFile(path.join(result.runDir, "lens_packs.json"), "utf8"));
  assert.equal(lensPacks[0].id, "mock-project-lens");
  const learning = JSON.parse(await readFile(path.join(result.runDir, "project_learning.json"), "utf8"));
  assert.match(learning.scopeSummary, /Mock initialization notes/);

  const coverage = JSON.parse(await readFile(path.join(result.runDir, "run_coverage.json"), "utf8"));
  assert.equal(coverage.checklist.byFailureMode.missing_constraint, 6);
  assert.equal(Object.keys(coverage.checklist.bySourceFile).length, 2);
  assert.deepEqual(Object.keys(coverage.checklist.bySourceFile).sort(), [
    "fixtures/halo2_missing_constraint.rs",
    "fixtures/halo2_scalar_mul_binding.rs",
  ]);
  const contextTrace = JSON.parse(await readFile(path.join(result.runDir, "round_1_context_retrieval.json"), "utf8"));
  assert.equal(contextTrace.length, 6);
  assert.ok(contextTrace.every((trace) => trace.mode === "source-index"));
  assert.ok(contextTrace.every((trace) => trace.slices.every((slice) => !path.isAbsolute(slice.path))));
  const enumTrace = JSON.parse(await readFile(path.join(result.runDir, "round_1_enumeration_context_retrieval.json"), "utf8"));
  assert.equal(enumTrace.mode, "source-index");
  assert.ok(enumTrace.provenanceFacts > 0);
  assert.ok(enumTrace.slices.some((slice) => slice.reason.includes("halo2 provenance")));
  const obligations = JSON.parse(await readFile(path.join(result.runDir, "proof_obligations.json"), "utf8"));
  assert.ok(obligations.some((obligation) => obligation.kind === "provenance"));
  await stat(path.join(result.runDir, "halo2_provenance_graph.json"));

  const firstFindingId = result.summary.findings[0].id;
  const reportName = `report_${firstFindingId}.md`;
  const report = await readFile(path.join(result.runDir, reportName), "utf8");
  assert.match(report, /Security disclosure/);
  assert.match(report, /local, isolated environment only/i);
  assert.match(report, /Confirmation status: confirmed-source/);

  for (const artifact of [
    "source_index.json",
    "proof_obligations.json",
    "halo2_provenance_graph.json",
    "round_1_enumeration_context_retrieval.json",
    "project_learning.json",
    "checklist.json",
    "checklist_coverage.json",
    "run_coverage.json",
    "events.jsonl",
    reportName,
  ]) {
    const body = await readFile(path.join(result.runDir, artifact), "utf8");
    assertNoLocalAbsolutePath(body, artifact, [root, out]);
  }
});

test("project history captures runs and reusable material indexes", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-history-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-history";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.localChecklistSeeders = true;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  const manifest = await readProjectHistoryManifest({ outputDir: out, targetName: cfg.targetName });
  assert.ok(manifest);
  assert.equal(manifest.aggregate.totalRuns, 1);
  assert.equal(manifest.aggregate.findingsTotal, result.summary.findings.length);
  assert.equal(manifest.aggregate.materialsTotal, manifest.materials.length);
  assert.equal(path.isAbsolute(manifest.latestRunDir), false);
  assert.equal(await resolveProjectHistoryLatestRunDir({ outputDir: out, targetName: cfg.targetName }), result.runDir);
  assert.ok(manifest.materials.some((material) => material.kind === "project-learning"));
  assert.ok(manifest.materials.some((material) => material.kind === "model-call"));
  assert.ok(manifest.materials.some((material) => material.kind === "report"));

  const projectDir = path.join(out, "history", "test-history");
  const manifestBody = await readFile(path.join(projectDir, "manifest.json"), "utf8");
  const materialsBody = await readFile(path.join(projectDir, "materials", "index.json"), "utf8");
  assertNoLocalAbsolutePath(manifestBody, "history manifest", [root, out]);
  assertNoLocalAbsolutePath(materialsBody, "materials index", [root, out]);

  const importedHistoryDir = path.join(out, "imported-history-root");
  const imported = await importRunToProjectHistory({
    outputDir: out,
    historyDir: importedHistoryDir,
    targetName: "imported-history",
    runDir: result.runDir,
  });
  const importedLatest = await resolveProjectHistoryLatestRunDir({
    outputDir: out,
    historyDir: importedHistoryDir,
    targetName: "imported-history",
  });
  assert.equal(importedLatest, path.join(importedHistoryDir, "imported-history", "runs", path.basename(result.runDir)));
  assert.equal(imported.latestRunDir, `runs/${path.basename(result.runDir)}`);
  await stat(path.join(importedLatest, "checklist.json"));
  await stat(path.join(importedHistoryDir, "imported-history", "materials", "index.json"));

  const legacyRunDir = path.join(out, "legacy-run");
  await mkdir(legacyRunDir, { recursive: true });
  await writeFile(
    path.join(legacyRunDir, "summary.json"),
    JSON.stringify({ coverage: { itemsTotal: 1, itemsWithFinding: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } }, findings: [] }, null, 2),
  );
  await writeFile(
    path.join(legacyRunDir, "checklist.json"),
    JSON.stringify(
      [
        {
          id: "legacy-entrypoint",
          location: "external/foo.sol (listed entrypoint; source not loaded)",
          securityProperty: "Legacy entrypoint locations should still aggregate by file.",
          failureMode: "missing_constraint",
          why: "Regression fixture for parenthesized location notes.",
        },
      ],
      null,
      2,
    ),
  );
  await writeFile(path.join(legacyRunDir, "audit_results.json"), JSON.stringify([], null, 2));
  await writeFile(path.join(legacyRunDir, "events.jsonl"), `${JSON.stringify({ kind: "run_start", ts: new Date().toISOString() })}\n`);
  const legacy = await importRunToProjectHistory({
    outputDir: out,
    historyDir: importedHistoryDir,
    targetName: "legacy-history",
    runDir: legacyRunDir,
  });
  assert.deepEqual(legacy.runs[0].sourceFiles, ["external/foo.sol"]);
});

test("model-only mode requires checklist items from model enumeration", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-model-only-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-model-only";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 2;
  assert.equal(cfg.localChecklistSeeders, false);

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 1);
  assert.equal(result.summary.coverage.itemsWithFinding, 1);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.equal(checklist.length, 1);
  assert.equal("seeder" in checklist[0], false);
  assert.equal(checklist[0].why, "Mock enumeration item used to test end-to-end model-driven audit flow.");

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_learn_project\.json$/.test(file)));
  assert.ok(calls.some((file) => /_discover_lenses\.json$/.test(file)));
  assert.ok(calls.some((file) => /_enumerate\.json$/.test(file)));
  assert.ok(calls.some((file) => /_audit_/.test(file)));
});

test("multi-round mode deepens with novel follow-up checklist items", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-rounds-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-rounds";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 3);
  assert.equal(result.summary.coverage.itemsWithFinding, 3);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2, 2]);
  assert.deepEqual(checklist.slice(1).map((item) => item.strategy).sort(), ["breadth", "depth"]);
  assert.equal(new Set(checklist.map((item) => `${item.location}|${item.failureMode}|${item.securityProperty}`)).size, 3);

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.strategy, "hybrid");
  assert.equal(deepening.accepted.length, 2);
  assert.deepEqual(deepening.branches.map((branch) => branch.strategy), ["breadth", "depth"]);
  assert.ok(deepening.accepted.some((item) => item.id === "mock-round-2-enforcement-edge"));
  assert.ok(deepening.accepted.some((item) => item.id === "mock-round-2-proof-obligation"));

  const calls = await readdir(path.join(result.runDir, "calls"));
  assert.ok(calls.some((file) => /_deepen_round_2_breadth\.json$/.test(file)));
  assert.ok(calls.some((file) => /_deepen_round_2_depth\.json$/.test(file)));
  await stat(path.join(result.runDir, "round_1_audit_results.json"));
  await stat(path.join(result.runDir, "round_2_audit_results.json"));
});

test("multi-round item cap reserves budget for follow-up exploration", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-budgeted-rounds-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-budgeted-rounds";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.maxAuditItems = 3;
  cfg.maxNewItemsPerRound = 1;
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new BudgetedRoundsLlmClient(), verifyTopK: 0 });
  assert.equal(result.summary.coverage.itemsTotal, 3);

  const checklist = JSON.parse(await readFile(path.join(result.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 1, 2]);
  assert.equal(checklist.at(-1).id, "budget-round-2-follow-up");

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.accepted.length, 1);

  const events = await readFile(path.join(result.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"deepening_done"/);
  assert.doesNotMatch(events, /max_audit_items_reached/);
});

test("breadth strategy uses only breadth deepening budget", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-breadth-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-breadth";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.explorationStrategy = "breadth";
  cfg.localChecklistSeeders = false;

  const result = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 1 });
  assert.equal(result.summary.coverage.itemsTotal, 2);

  const deepening = JSON.parse(await readFile(path.join(result.runDir, "round_2_deepening_items.json"), "utf8"));
  assert.equal(deepening.strategy, "breadth");
  assert.deepEqual(deepening.branches.map((branch) => branch.strategy), ["breadth"]);
  assert.equal(deepening.accepted[0].strategy, "breadth");
});

test("resume mode appends additional rounds to the previous run", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-resume-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 1;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  const pointer = JSON.parse(await readFile(path.join(out, ".fsa-last-run.json"), "utf8"));
  assert.equal(pointer.runDirName, path.basename(first.runDir));
  assert.equal(path.isAbsolute(pointer.runDirName), false);
  assert.equal(pointer.runDirName.includes(path.sep), false);
  assert.equal(await resolveLastRunDir(out), first.runDir);

  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: await resolveLastRunDir(out),
  });
  assert.equal(resumed.runDir, first.runDir);
  assert.equal(resumed.summary.coverage.itemsTotal, 3);

  const checklist = JSON.parse(await readFile(path.join(first.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2, 2]);

  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.additionalRounds, 1);
  assert.equal(resumeState.nextRound, 2);

  const events = await readFile(path.join(first.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"resume_loaded"/);
  await stat(path.join(first.runDir, "round_1_audit_results.json"));
  await stat(path.join(first.runDir, "round_2_audit_results.json"));
});

test("resume mode recovers from partial round artifacts", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-partial-resume-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-partial-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 1;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  await rm(path.join(first.runDir, "audit_results.json"));
  await writeFile(
    path.join(first.runDir, "round_2_deepening_items.json"),
    JSON.stringify(
      {
        round: 2,
        strategy: "depth",
        accepted: [
          {
            id: "pending-round-2",
            location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
            securityProperty: "A pending item generated before interruption must be audited on resume.",
            failureMode: "missing_constraint",
            why: "This pending item simulates a failed run after deepening but before round audit completion.",
            round: 2,
            strategy: "depth",
          },
        ],
      },
      null,
      2,
    ),
  );

  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: first.runDir,
  });

  assert.equal(resumed.runDir, first.runDir);
  assert.equal(resumed.summary.coverage.itemsTotal, 2);
  const checklist = JSON.parse(await readFile(path.join(first.runDir, "checklist.json"), "utf8"));
  assert.deepEqual(checklist.map((item) => item.round), [1, 2]);
  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.pendingRoundItems, 1);
  const events = await readFile(path.join(first.runDir, "events.jsonl"), "utf8");
  assert.match(events, /"kind":"pending_round_loaded"/);
  await stat(path.join(first.runDir, "round_2_audit_results.json"));
});

test("resume mode retries model-error items from the same round", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-model-error-resume-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-model-error-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  const resultsPath = path.join(first.runDir, "audit_results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  const failed = results.find((result) => result.item.round === 2);
  assert.ok(failed);
  failed.nHits = 0;
  failed.hitRate = 0;
  failed.trials = [
    {
      finding: false,
      title: "Model call failed",
      severity: "info",
      confidence: 0,
      description: "Synthetic model error.",
      evidence: "",
      exploitSketch: "",
      fix: "",
      modelError: true,
      raw: "limit reached",
    },
  ];
  await writeFile(resultsPath, JSON.stringify(results, null, 2));

  cfg.rounds = 1;
  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: first.runDir,
  });

  assert.equal(resumed.summary.coverage.itemsTotal, 3);
  assert.equal(resumed.summary.coverage.itemsWithFinding, 3);
  const retryResults = JSON.parse(await readFile(path.join(first.runDir, "round_2_audit_results.json"), "utf8"));
  assert.equal(retryResults.length, 2);
  assert.ok(retryResults.some((result) => result.item.id === failed.item.id));
  assert.ok(retryResults.every((result) => result.trials.every((trial) => trial.modelError === undefined)));
  const resumeState = JSON.parse(await readFile(path.join(first.runDir, "resume_state.json"), "utf8"));
  assert.equal(resumeState.completedRounds, 1);
  assert.equal(resumeState.pendingRoundItems, 2);
});

test("resume mode retries parse-error items from the same round", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "fsa-parse-error-resume-"));
  const cfg = defaultConfig();
  cfg.portfolioEnumeration = false;
  cfg.targetName = "test-parse-error-resume";
  cfg.sourcePaths = [fixtures];
  cfg.outputDir = out;
  cfg.trials = 1;
  cfg.rounds = 2;
  cfg.localChecklistSeeders = false;

  const first = await runPipeline(cfg, { llm: new MockAuditLlmClient(), verifyTopK: 0 });
  const resultsPath = path.join(first.runDir, "audit_results.json");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  const failed = results.find((result) => result.item.round === 2);
  assert.ok(failed);
  failed.nHits = 0;
  failed.hitRate = 0;
  failed.trials = [
    {
      finding: false,
      title: "Parse error",
      severity: "info",
      confidence: 0,
      description: "Synthetic parse error.",
      evidence: "",
      exploitSketch: "",
      fix: "",
      parseError: true,
      raw: "not json",
    },
  ];
  await writeFile(resultsPath, JSON.stringify(results, null, 2));

  cfg.rounds = 1;
  const resumed = await runPipeline(cfg, {
    llm: new MockAuditLlmClient(),
    verifyTopK: 0,
    resumeRunDir: first.runDir,
  });

  assert.equal(resumed.summary.coverage.itemsTotal, 3);
  assert.equal(resumed.summary.coverage.itemsNeedingRetry, 0);
  const retryResults = JSON.parse(await readFile(path.join(first.runDir, "round_2_audit_results.json"), "utf8"));
  assert.equal(retryResults.length, 2);
  assert.ok(retryResults.some((result) => result.item.id === failed.item.id));
  assert.ok(retryResults.every((result) => result.trials.every((trial) => trial.parseError === undefined)));
});

class BudgetedRoundsLlmClient {
  async complete(input) {
    if (input.tag === "learn_project") {
      return JSON.stringify({
        scopeSummary: "Budgeted round regression target.",
        securityObjectives: ["Model-produced checklist items must leave room for follow-up exploration."],
        domainConcepts: ["checked assignment"],
        trustBoundaries: ["private witness values"],
        attackerCapabilities: ["choose private inputs"],
        candidateInvariants: ["checked logic must bind values to their declared ingress"],
        implementationMechanics: ["fixtures contain small circuit-like code"],
        uncertainty: [],
        evidenceRefs: ["fixtures"],
      });
    }
    if (input.tag === "discover_lenses") {
      return JSON.stringify([]);
    }
    if (input.tag === "enumerate") {
      return JSON.stringify([
        budgetItem("budget-add-1", "fixtures/halo2_missing_constraint.rs:5"),
        budgetItem("budget-add-2", "fixtures/halo2_missing_constraint.rs:6"),
        budgetItem("budget-mul-1", "fixtures/halo2_scalar_mul_binding.rs:13"),
        budgetItem("budget-mul-2", "fixtures/halo2_scalar_mul_binding.rs:14"),
      ]);
    }
    if (input.tag === "deepen_round_2_breadth") {
      return JSON.stringify([budgetItem("budget-round-2-follow-up", "fixtures/halo2_scalar_mul_binding.rs:13-14")]);
    }
    if (input.tag.startsWith("audit_")) {
      return JSON.stringify({
        finding: false,
        title: "No finding",
        severity: "info",
        confidence: 0.5,
        description: "Budget regression test response.",
        evidence: "No security claim is made by this fixture client.",
        exploitSketch: "",
        fix: "",
      });
    }
    return "";
  }
}

function budgetItem(id, location) {
  return {
    id,
    location,
    securityProperty: `${id} security property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
  };
}

function assertNoLocalAbsolutePath(body, label, forbiddenRoots) {
  for (const forbiddenRoot of forbiddenRoots) {
    assert.equal(body.includes(forbiddenRoot), false, `${label} includes a local absolute path`);
  }
}
