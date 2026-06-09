import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const configDir = path.join(root, "configs");

test("default hunting config templates are publication-safe and model-backed", async () => {
  const files = (await readdir(configDir)).filter((file) => file.endsWith(".json"));
  assert.ok(files.includes("vulnerability-hunt.default.json"));
  assert.ok(files.includes("zk-constraint-hunt.default.json"));
  assert.ok(files.includes("solidity-contract-hunt.default.json"));
  assert.ok(files.includes("cairo-starknet-hunt.default.json"));

  for (const file of files) {
    const body = await readFile(path.join(configDir, file), "utf8");
    const config = JSON.parse(body);
    assert.equal(body.includes(root), false, `${file} includes a local absolute path`);
    assert.deepEqual(config.sourcePaths, [], `${file} should not publish target-local source paths`);
    assert.deepEqual(config.corpusPaths, [], `${file} should not publish target-local corpus paths`);
    assert.equal(config.localChecklistSeeders, false, `${file} must keep local seeders disabled for live discovery`);
    assert.equal(config.projectLearning, true, `${file} should learn target context before enumeration`);
    assert.equal(config.dynamicLensDiscovery, true, `${file} should discover target-specific lenses`);
    assert.equal(config.portfolioEnumeration, true, `${file} should keep portfolio enumeration enabled`);
    assert.equal(config.scopeMode, "augment", `${file} should treat configured lenses as guidance by default`);
    assert.ok(config.baselineExplorationShare > 0, `${file} should reserve some room for lens-free baseline exploration`);
    assert.equal(config.highImpactVerification, true, `${file} should force high-impact findings through follow-up`);
    assert.ok(config.highImpactMaxFindings >= 24, `${file} should budget high-impact verification beyond normal topK`);
    assert.equal(config.reproductionMode, "off", `${file} should not run or plan PoC by default`);
    assert.ok(config.rounds >= 2, `${file} should leave budget for deepening rounds`);
    assert.ok(config.trials >= 4, `${file} should use multiple audit trials`);
    assert.ok(config.maxAuditItems > config.maxNewItemsPerRound, `${file} should reserve budget across rounds`);
  }
});

test("Cairo Starknet hunting config includes Starknet-specific audit lenses", async () => {
  const body = await readFile(path.join(configDir, "cairo-starknet-hunt.default.json"), "utf8");
  const config = JSON.parse(body);
  const lensIds = new Set(config.lensPacks.map((pack) => pack.id));
  const modes = new Set(config.lensPacks.flatMap((pack) => pack.failureModes ?? []));
  const agents = new Set(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).map((agent) => agent.id));

  assert.ok(lensIds.has("cairo-starknet-entrypoint-authority"));
  assert.ok(lensIds.has("cairo-starknet-l1-l2-bridge-accounting"));
  assert.ok(lensIds.has("cairo-starknet-os-state-transition"));
  assert.ok(lensIds.has("cairo-starknet-syscall-classhash-resource"));
  assert.ok(modes.has("cairo_l1_l2_message_binding"));
  assert.ok(modes.has("cairo_state_transition_integrity"));
  assert.ok(modes.has("cairo_os_output_commitment"));
  assert.ok(modes.has("cairo_syscall_context_binding"));
  assert.ok(modes.has("cairo_class_hash_binding"));
  assert.ok(modes.has("cairo_resource_accounting"));
  assert.ok(agents.has("cairo-l1-l2-message-binding-auditor"));
  assert.ok(agents.has("cairo-state-transition-integrity-auditor"));
  assert.ok(agents.has("cairo-syscall-context-binding-auditor"));
  assert.ok(config.projectContext.focusAreas.some((area) => /Starknet OS/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /StarkGate-style token bridge/i.test(area)));
});

test("Solidity contract hunting config includes EVM-specific audit lenses", async () => {
  const body = await readFile(path.join(configDir, "solidity-contract-hunt.default.json"), "utf8");
  const config = JSON.parse(body);
  const lensIds = new Set(config.lensPacks.map((pack) => pack.id));
  const wormholeLens = config.lensPacks.find((pack) => pack.id === "evm-wormhole-vaa-governance-bridge");
  const modes = new Set(config.lensPacks.flatMap((pack) => pack.failureModes ?? []));
  const agents = new Set(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).map((agent) => agent.failureMode));

  assert.ok(lensIds.has("evm-value-share-accounting"));
  assert.ok(lensIds.has("evm-dao-governance-voting"));
  assert.ok(lensIds.has("evm-upgradeability-storage"));
  assert.ok(lensIds.has("evm-oracle-market-manipulation"));
  assert.ok(lensIds.has("evm-signatures-permits-delegation"));
  assert.ok(lensIds.has("evm-bridge-oft-liquidity-transport"));
  assert.ok(lensIds.has("evm-wormhole-vaa-governance-bridge"));
  assert.ok(lensIds.has("evm-hyperlane-mailbox-ism-transport"));
  assert.ok(lensIds.has("evm-staking-rewarder-accounting"));
  assert.ok(lensIds.has("evm-name-registry-resolution-integrity"));
  assert.ok(lensIds.has("evm-validator-cluster-staking-accounting"));
  assert.ok(lensIds.has("evm-async-request-solver-settlement"));
  assert.ok(lensIds.has("evm-lending-liquidation-solvency"));
  assert.ok(lensIds.has("evm-emode-risk-configuration"));

  assert.ok(modes.has("evm_token_accounting"));
  assert.ok(modes.has("evm_dao_governance_integrity"));
  assert.ok(modes.has("evm_vault_share_accounting"));
  assert.ok(modes.has("evm_upgradeability_storage"));
  assert.ok(modes.has("evm_oracle_manipulation"));
  assert.ok(modes.has("evm_bridge_message_replay"));
  assert.ok(modes.has("evm_bridge_credit_accounting"));
  assert.ok(modes.has("evm_wormhole_vaa_verification"));
  assert.ok(modes.has("evm_wormhole_governance_binding"));
  assert.ok(modes.has("evm_mev_slippage"));
  assert.ok(modes.has("evm_name_registry_resolution"));
  assert.ok(modes.has("evm_validator_cluster_accounting"));
  assert.ok(modes.has("evm_async_request_settlement"));
  assert.ok(modes.has("evm_liquidation_solvency"));
  assert.ok(modes.has("evm_risk_configuration"));

  assert.ok(agents.has("evm_token_accounting"));
  assert.ok(agents.has("evm_upgradeability_storage"));
  assert.ok(agents.has("evm_oracle_manipulation"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-bridge-signed-constraint-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-wormhole-vaa-verification-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-wormhole-governance-binding-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-hyperlane-mailbox-process-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-hyperlane-ism-threshold-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-staking-rewarder-accounting-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-name-registry-resolution-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-validator-cluster-accounting-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-async-request-solver-settlement-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-dao-governance-integrity-auditor"));
  assert.ok(config.lensPacks.flatMap((pack) => pack.auditorAgents ?? []).some((agent) => agent.id === "evm-emode-risk-configuration-auditor"));
  assert.ok(config.projectContext.focusAreas.some((area) => /cross-chain/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /quote-to-execution/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /Wormhole VAA/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /Hyperlane Mailbox/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /validator cluster/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /name registry ownership/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /async deposit\/redeem/i.test(area)));
  assert.ok(config.projectContext.focusAreas.some((area) => /DAO proposal creation/i.test(area)));
  assert.ok(wormholeLens.auditGuidance.some((guidance) => /#1901/.test(guidance)));
  assert.ok(wormholeLens.auditGuidance.some((guidance) => /old-but-unexpired guardian sets/i.test(guidance)));
  assert.ok(wormholeLens.auditGuidance.some((guidance) => /AssetMeta/.test(guidance)));
  assert.ok(wormholeLens.auditGuidance.some((guidance) => /isWrappedAsset/.test(guidance)));
});
