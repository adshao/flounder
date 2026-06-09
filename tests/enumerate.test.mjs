import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { enumerateAuditItems } from "../dist/enumerate.js";
import { SourceIndex } from "../dist/index/source-index.js";
import { extractCairoStarknetProvenance } from "../dist/provenance/cairo.js";
import { extractHalo2Provenance } from "../dist/provenance/halo2.js";
import { extractSolidityProvenance } from "../dist/provenance/solidity.js";

test("initial enumeration reserves item budget for later rounds and keeps source diversity", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "budget-test";
  cfg.maxAuditItems = 7;
  cfg.rounds = 2;
  cfg.maxNewItemsPerRound = 3;

  const artifacts = new Map();
  const events = [];
  const logger = {
    async artifact(name, value) {
      artifacts.set(name, value);
      return name;
    },
    async event(kind, data) {
      events.push({ kind, data });
    },
  };
  const llm = {
    async complete(input) {
      assert.equal(input.tag, "enumerate");
      return JSON.stringify([
        raw("add-1", "chip/add.rs:10"),
        raw("add-2", "chip/add.rs:20"),
        raw("add-3", "chip/add.rs:30"),
        raw("add-incomplete", "chip/add_incomplete.rs:10"),
        raw("mul-complete", "chip/mul/complete.rs:10"),
        raw("mul-incomplete", "chip/mul/incomplete.rs:10"),
      ]);
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source: [
      { path: "chip/add.rs", content: "fn add() {}", kind: "source" },
      { path: "chip/add_incomplete.rs", content: "fn add_incomplete() {}", kind: "source" },
      { path: "chip/mul/complete.rs", content: "fn mul_complete() {}", kind: "source" },
      { path: "chip/mul/incomplete.rs", content: "fn mul_incomplete() {}", kind: "source" },
    ],
    llm,
    logger,
    round: 1,
  });

  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((entry) => entry.id),
    ["add-1", "add-incomplete", "mul-complete", "mul-incomplete"],
  );
  assert.deepEqual(artifacts.get("checklist.json").map((entry) => entry.id), items.map((entry) => entry.id));

  const limited = events.find((event) => event.kind === "enumeration_limited");
  assert.ok(limited);
  assert.equal(limited.data.maxAuditItems, 7);
  assert.equal(limited.data.roundOneBudget, 4);
  assert.equal(limited.data.reservedForLaterRounds, 3);
  assert.equal(limited.data.before, 6);
  assert.equal(limited.data.after, 4);
});

test("enumeration context prioritizes provenance-backed source slices before source overview", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "provenance-context-test";
  cfg.contextCharBudget = 14_000;
  cfg.portfolioEnumeration = false;

  const source = [
    {
      path: "chip/mul/incomplete.rs",
      kind: "source",
      content: [
        ...Array.from({ length: 180 }, (_, idx) => `// filler ${idx + 1}`),
        "fn assign_loop(region: &mut Region, row: usize, offset: usize, x_p: Value) {",
        "    // point scalar multiplication witness advice",
        '    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;',
        "}",
      ].join("\n"),
    },
  ];
  const graph = extractHalo2Provenance(source);
  const artifacts = new Map();
  const logger = {
    async artifact(name, value) {
      artifacts.set(name, value);
      return name;
    },
    async event() {},
  };
  const llm = {
    async complete(input) {
      assert.equal(input.tag, "enumerate");
      assert.match(input.user, /Machine-extracted provenance facts/);
      assert.match(input.user, /chip\/mul\/incomplete\.rs lines 138-253 \(halo2 provenance advice_assignment\)/);
      assert.match(input.user, /region\.assign_advice/);
      return JSON.stringify([raw("late-provenance-item", "chip/mul/incomplete.rs:183")]);
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source,
    sourceIndex: new SourceIndex(source),
    provenanceGraphs: [graph],
    llm,
    logger,
    round: 1,
  });

  assert.equal(items.length, 1);
  const trace = artifacts.get("round_1_enumeration_context_retrieval.json");
  assert.ok(trace);
  assert.ok(trace.slices.some((slice) => slice.reason === "halo2 provenance advice_assignment" && slice.included));
  assert.equal(artifacts.get("checklist.json")[0].id, "late-provenance-item");
});

test("portfolio enumeration keeps focused provenance items under tight budget", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "portfolio-test";
  cfg.contextCharBudget = 14_000;
  cfg.maxAuditItems = 1;
  cfg.portfolioMaxItems = 4;

  const source = [
    {
      path: "chip/mul/incomplete.rs",
      kind: "source",
      content: [
        "fn assign_loop(region: &mut Region, row: usize, offset: usize, x_p: Value) {",
        "    // point scalar multiplication witness advice",
        '    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;',
        "    meta.create_gate(\"mul gate\", |meta| vec![meta.query_selector(config.q_mul)]);",
        "}",
      ].join("\n"),
    },
  ];
  const graph = extractHalo2Provenance(source);
  const events = [];
  const logger = {
    async artifact() {
      return "artifact";
    },
    async event(kind, data) {
      events.push({ kind, data });
    },
  };
  const calls = [];
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      if (input.tag === "enumerate") {
        return JSON.stringify([raw("broad-item", "chip/add.rs:10")]);
      }
      if (input.tag === "enumerate_halo2_portfolio") {
        assert.match(input.user, /Portfolio: assignment\/dataflow evidence/);
        assert.doesNotMatch(input.user, answerPhrase("source", "binding", "[- ]"));
        assert.doesNotMatch(input.user, answerPhrase("intended", "source"));
        assert.doesNotMatch(input.user, answerPhrase("row", "constancy"));
        return JSON.stringify([raw("portfolio-item", "chip/mul/incomplete.rs:3")]);
      }
      return "[]";
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source,
    sourceIndex: new SourceIndex(source),
    proofObligations: graph.obligations,
    provenanceGraphs: [graph],
    llm,
    logger,
    round: 1,
  });

  assert.deepEqual(calls, ["enumerate", "enumerate_halo2_portfolio"]);
  assert.deepEqual(items.map((item) => item.id), ["portfolio-item"]);
  assert.ok(events.some((event) => event.kind === "portfolio_enumeration_done" && event.data.items === 1));
});

test("augment scope reserves room for lens-free baseline enumeration", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "augment-baseline-test";
  cfg.scopeMode = "augment";
  cfg.portfolioEnumeration = false;
  cfg.maxAuditItems = 4;
  cfg.rounds = 1;
  cfg.baselineExplorationShare = 0.25;
  cfg.lensPacks = [
    {
      id: "tenant-lens",
      displayName: "Tenant Lens",
      failureModes: ["access_control"],
      enumerationGuidance: ["Focus on tenant ownership checks."],
      auditGuidance: ["Confirm object ownership enforcement."],
    },
  ];

  const calls = [];
  const logger = {
    async artifact() {
      return "artifact";
    },
    async event() {},
  };
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      if (input.tag === "enumerate") {
        assert.match(input.user, /Scope mode:\s+augment/i);
        return JSON.stringify([
          raw("lens-1", "src/routes.ts:10"),
          raw("lens-2", "src/routes.ts:20"),
          raw("lens-3", "src/routes.ts:30"),
          raw("lens-4", "src/routes.ts:40"),
        ]);
      }
      if (input.tag === "enumerate_baseline") {
        assert.match(input.user, /augment-mode safety net/i);
        return JSON.stringify([raw("baseline-authz", "src/jobs.ts:50")]);
      }
      return "[]";
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source: [{ path: "src/jobs.ts", content: "export function runJob() {}", kind: "source" }],
    llm,
    logger,
    round: 1,
  });

  assert.deepEqual(calls, ["enumerate", "enumerate_baseline"]);
  assert.equal(items.length, 4);
  assert.equal(items[0].id, "baseline-authz");
  assert.equal(items[0].enumerationSource, "baseline");
  assert.equal(items.filter((item) => item.enumerationSource === "model").length, 3);
});

test("restrict scope disables lens-free baseline enumeration", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "restrict-baseline-test";
  cfg.scopeMode = "restrict";
  cfg.portfolioEnumeration = false;
  cfg.maxAuditItems = 4;
  cfg.lensPacks = [
    {
      id: "explicit-lens",
      displayName: "Explicit Lens",
      failureModes: ["access_control"],
      enumerationGuidance: ["Stay within this lens."],
      auditGuidance: ["Only audit this scope."],
    },
  ];

  const calls = [];
  const logger = {
    async artifact() {
      return "artifact";
    },
    async event() {},
  };
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      assert.equal(input.tag, "enumerate");
      assert.match(input.user, /Scope mode:\s+restrict/i);
      return JSON.stringify([raw("restricted-item", "src/routes.ts:10")]);
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source: [{ path: "src/routes.ts", content: "export function route() {}", kind: "source" }],
    llm,
    logger,
    round: 1,
  });

  assert.deepEqual(calls, ["enumerate"]);
  assert.deepEqual(items.map((item) => item.id), ["restricted-item"]);
});

test("Solidity provenance uses EVM-specific portfolio enumeration", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "solidity-portfolio-test";
  cfg.contextCharBudget = 14_000;
  cfg.maxAuditItems = 1;
  cfg.portfolioMaxItems = 4;

  const source = [
    {
      path: "contracts/Vault.sol",
      kind: "source",
      content: [
        "contract Vault {",
        "    mapping(address => uint256) public balanceOf;",
        "    function withdraw(uint256 amount) external {",
        "        require(balanceOf[msg.sender] >= amount, \"balance\");",
        "        balanceOf[msg.sender] -= amount;",
        "        (bool ok,) = msg.sender.call{value: amount}(\"\");",
        "        require(ok, \"send\");",
        "    }",
        "}",
      ].join("\n"),
    },
  ];
  const graph = extractSolidityProvenance(source);
  const calls = [];
  const logger = {
    async artifact() {
      return "artifact";
    },
    async event() {},
  };
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      if (input.tag === "enumerate") {
        return JSON.stringify([raw("broad-solidity", "contracts/Vault.sol:3")]);
      }
      if (input.tag === "enumerate_solidity_portfolio") {
        assert.match(input.user, /solidity\/evm provenance evidence/i);
        assert.match(input.user, /external calls/i);
        assert.match(input.user, /delegatecall/i);
        assert.doesNotMatch(input.user, /assigned cells\/gates/i);
        return JSON.stringify([raw("evm-portfolio-item", "contracts/Vault.sol:6")]);
      }
      return "[]";
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source,
    sourceIndex: new SourceIndex(source),
    proofObligations: graph.obligations,
    provenanceGraphs: [graph],
    llm,
    logger,
    round: 1,
  });

  assert.deepEqual(calls, ["enumerate", "enumerate_solidity_portfolio"]);
  assert.deepEqual(items.map((item) => item.id), ["evm-portfolio-item"]);
  assert.equal(items[0].enumerationSource, "portfolio");
});

test("Cairo provenance uses Starknet-specific portfolio enumeration", async () => {
  const cfg = defaultConfig();
  cfg.targetName = "cairo-portfolio-test";
  cfg.contextCharBudget = 14_000;
  cfg.maxAuditItems = 1;
  cfg.portfolioMaxItems = 4;

  const source = [
    {
      path: "packages/bridge/src/token_bridge.cairo",
      kind: "source",
      content: [
        "#[starknet::contract]",
        "pub mod TokenBridge {",
        "    use starknet::syscalls::send_message_to_l1_syscall;",
        "    #[l1_handler]",
        "    fn handle_deposit(ref self: ContractState, from_address: felt252, l1_token: EthAddress, amount: u256) {",
        "        self.only_from_l1_bridge(:from_address);",
        "        let l2_token = self.l1_l2_token_map.read(l1_token);",
        "        self.l1_locked_amount.write(l1_token, LockedAmount { monitoring_enabled: true, amount });",
        "    }",
        "    fn withdraw(ref self: ContractState, l1_recipient: EthAddress, amount: u256) {",
        "        let result = send_message_to_l1_syscall(to_address: self.l1_bridge.read().into(), payload: message_payload.span());",
        "        assert(result.is_ok(), Errors::MESSAGE_SEND_FAILED);",
        "    }",
        "}",
      ].join("\n"),
    },
  ];
  const graph = extractCairoStarknetProvenance(source);
  const calls = [];
  const logger = {
    async artifact() {
      return "artifact";
    },
    async event() {},
  };
  const llm = {
    async complete(input) {
      calls.push(input.tag);
      if (input.tag === "enumerate") {
        return JSON.stringify([raw("broad-cairo", "packages/bridge/src/token_bridge.cairo:5")]);
      }
      if (input.tag === "enumerate_cairo-starknet_portfolio") {
        assert.match(input.user, /cairo\/starknet provenance evidence/i);
        assert.match(input.user, /L1\/L2 bridge flows/);
        assert.match(input.user, /syscall implementations/);
        assert.doesNotMatch(input.user, /Solana\/Rust portfolio/i);
        return JSON.stringify([raw("cairo-portfolio-item", "packages/bridge/src/token_bridge.cairo:11")]);
      }
      return "[]";
    },
  };

  const items = await enumerateAuditItems({
    cfg,
    corpus: [],
    source,
    sourceIndex: new SourceIndex(source),
    proofObligations: graph.obligations,
    provenanceGraphs: [graph],
    llm,
    logger,
    round: 1,
  });

  assert.deepEqual(calls, ["enumerate", "enumerate_cairo-starknet_portfolio"]);
  assert.deepEqual(items.map((item) => item.id), ["cairo-portfolio-item"]);
  assert.equal(items[0].enumerationSource, "portfolio");
});

function raw(id, location) {
  return {
    id,
    location,
    securityProperty: `${id} security property`,
    failureMode: "missing_constraint",
    why: `${id} rationale`,
  };
}

function answerPhrase(first, second, separator = "\\s+") {
  return new RegExp(`${first}${separator}${second}`, "i");
}
