import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommandSafety, analyzeReproductionCommandSafety, analyzeAgentBashCommandSafety, analyzeConfirmBashCommandSafety, isAgentBuildCommand, isAgentConfirmCommand } from "../dist/security/policy.js";

const cmd = (program, ...args) => ({ program, args });

test("agent bash allows build/dependency commands (the build phase) across ecosystems", () => {
  for (const c of [
    cmd("cargo", "build"),
    cmd("cargo", "fetch"),
    cmd("npm", "install"),
    cmd("go", "mod", "download"),
    cmd("forge", "build"),
    cmd("pip", "install", "-r", "requirements.txt"),
    cmd("cmake", "-S", "source/aztec-packages/barretenberg/cpp", "-B", "build/bbapi-poc", "-DMOBILE=ON"),
    cmd("cmake", "--build", "build/bbapi-poc"),
    cmd("cmake", "--build", "build/bbapi-poc", "--parallel", "2"),
    cmd("ninja", "-C", "build/bbapi-poc"),
    cmd("make", "-C", "build/bbapi-poc"),
  ]) {
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be allowed`);
    assert.equal(isAgentBuildCommand(c), true, `${c.program} ${c.args.join(" ")} should be a build command`);
  }
});

test("a build command is NOT confirmation-eligible (build cannot mint a finding)", () => {
  assert.equal(isAgentConfirmCommand(cmd("cargo", "build")), false);
  assert.equal(isAgentConfirmCommand(cmd("npm", "install")), false);
  assert.equal(isAgentConfirmCommand(cmd("cmake", "--build", "build/bbapi-poc")), false);
  assert.equal(isAgentConfirmCommand(cmd("ninja", "-C", "build/bbapi-poc")), false);
  // and a test runner is a confirm command, not a build command
  assert.equal(isAgentBuildCommand(cmd("cargo", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("cargo", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("ctest", "--test-dir", "build/bbapi-poc")), false);
  assert.equal(isAgentConfirmCommand(cmd("ctest", "--test-dir", "build/bbapi-poc")), true);
});

test("a build command still cannot smuggle a remote/mainnet target in its argv", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("cargo", "build", "--target-dir", "https://evil.example/x")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("forge", "build", "--fork-url", "https://mainnet.example")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cmake", "-S", "https://evil.example/project", "-B", "build")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cmake", "-P", "script.cmake")).blocked, true);
});

test("arbitrary non-build, non-test, non-inspection commands stay blocked", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("curl", "https://evil.example")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("rm", "-rf", "x")).blocked, true);
});

test("command safety policy blocks live-network broadcast-like commands", () => {
  const decision = analyzeCommandSafety("zcash-cli -testnet sendrawtransaction poc");
  assert.equal(decision.blocked, true);
  assert.match(decision.reason, /local-only/i);
  assert.equal(decision.matchedNetwork?.toLowerCase(), "testnet");
  assert.equal(decision.matchedAction?.toLowerCase(), "sendrawtransaction");
});

test("command safety policy allows local-only reproductions", () => {
  assert.equal(analyzeCommandSafety("cargo test local_regtest_poc").blocked, false);
  assert.equal(analyzeCommandSafety("zcash-cli -regtest sendrawtransaction fixture").blocked, false);
});

test("reproduction command policy allows only structured local test commands", () => {
  assert.equal(analyzeReproductionCommandSafety({ program: "cargo", args: ["test", "local_regtest_poc"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "node", args: ["--test", "repro.test.mjs"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--match-test", "testLocalRepro"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "ctest", args: ["--test-dir", "build/bbapi-poc", "-R", "noncanonical"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "test/repro.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "zcash-cli", args: ["-testnet", "sendrawtransaction", "poc"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "bash", args: ["-lc", "cargo test"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "cargo;curl", args: ["test"] }).blocked, true);
});

test("confirm-mode bash MAY fork and read live networks (the open-world difference from run)", () => {
  // The exact things `flounder run` blocks for being network-bound, `flounder confirm` allows —
  // because real-world reproduction forks the live chain and reads public sources.
  for (const c of [
    cmd("forge", "test", "--fork-url", "https://eth.llamarpc.com"),
    cmd("cast", "call", "--rpc-url", "https://mainnet.example", "0xabc", "balanceOf()"),
    cmd("anvil", "--fork-url", "https://mainnet.example"),
    cmd("curl", "-s", "https://github.com/zcash/halo2/issues/578"),
    cmd("git", "clone", "https://github.com/AztecProtocol/aztec-connect"),
    cmd("node", "repro.mjs"),
  ]) {
    assert.equal(analyzeConfirmBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be allowed in confirm mode`);
    // sanity: run mode would have blocked the network-bound ones
  }
  // run mode blocks a remote fork; confirm allows it — the capability difference is real.
  assert.equal(analyzeAgentBashCommandSafety(cmd("forge", "test", "--fork-url", "https://eth.llamarpc.com")).blocked, true);
});

test("confirm-mode bash still NEVER broadcasts a transaction to a non-local network (white-hat line)", () => {
  for (const c of [
    cmd("cast", "send", "--rpc-url", "https://mainnet.example", "0xabc", "drain()"),
    cmd("forge", "script", "Exploit.s.sol", "--broadcast", "--rpc-url", "https://mainnet.example"),
    cmd("cast", "send", "--rpc-url=https://mainnet.example", "0xabc"),
  ]) {
    const decision = analyzeConfirmBashCommandSafety(c);
    assert.equal(decision.blocked, true, `${c.program} ${c.args.join(" ")} must be blocked (broadcast to live network)`);
    assert.match(decision.reason, /never BROADCAST|white-hat/i);
  }
});

test("confirm-mode bash ALLOWS broadcasting to a LOCAL fork (replaying the exploit is the reproduction)", () => {
  for (const c of [
    cmd("cast", "send", "--rpc-url", "http://127.0.0.1:8545", "0xabc", "drain()"),
    cmd("forge", "script", "Exploit.s.sol", "--broadcast", "--rpc-url", "http://127.0.0.1:8545"),
    cmd("cast", "send", "0xabc", "0x123"), // no rpc target → foundry default localhost
  ]) {
    assert.equal(analyzeConfirmBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be allowed (local replay)`);
  }
});

test("confirm-mode bash keeps the structural guards (no shell operators, workspace-contained paths)", () => {
  assert.equal(analyzeConfirmBashCommandSafety({ program: "cast;curl", args: ["send"] }).blocked, true);
  assert.equal(analyzeConfirmBashCommandSafety(cmd("cat", "/etc/passwd")).blocked, true);
  assert.equal(analyzeConfirmBashCommandSafety(cmd("cat", "../secrets")).blocked, true);
});

test("reproduction command policy keeps Solidity fork and network targets local-only", () => {
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "https://eth.llamarpc.com"] }).blocked,
    true,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "http://127.0.0.1:8545"] }).blocked,
    false,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "--network", "sepolia"] }).blocked,
    true,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "--network", "hardhat"] }).blocked,
    false,
  );
  assert.equal(
    analyzeReproductionCommandSafety({ program: "forge", args: ["test", "--fork-url", "$MAINNET_RPC_URL"] }).blocked,
    true,
  );
});
