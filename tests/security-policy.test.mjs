import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommandSafety, analyzeReproductionCommandSafety, analyzeAgentBashCommandSafety, isAgentBuildCommand, isAgentConfirmCommand } from "../dist/security/policy.js";

const cmd = (program, ...args) => ({ program, args });

test("agent bash allows build/dependency commands (the build phase) across ecosystems", () => {
  for (const c of [cmd("cargo", "build"), cmd("cargo", "fetch"), cmd("npm", "install"), cmd("go", "mod", "download"), cmd("forge", "build"), cmd("pip", "install", "-r", "requirements.txt")]) {
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be allowed`);
    assert.equal(isAgentBuildCommand(c), true, `${c.program} ${c.args.join(" ")} should be a build command`);
  }
});

test("a build command is NOT confirmation-eligible (build cannot mint a finding)", () => {
  assert.equal(isAgentConfirmCommand(cmd("cargo", "build")), false);
  assert.equal(isAgentConfirmCommand(cmd("npm", "install")), false);
  // and a test runner is a confirm command, not a build command
  assert.equal(isAgentBuildCommand(cmd("cargo", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("cargo", "test")), true);
});

test("a build command still cannot smuggle a remote/mainnet target in its argv", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("cargo", "build", "--target-dir", "https://evil.example/x")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("forge", "build", "--fork-url", "https://mainnet.example")).blocked, true);
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
  assert.equal(analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "test/repro.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "zcash-cli", args: ["-testnet", "sendrawtransaction", "poc"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "bash", args: ["-lc", "cargo test"] }).blocked, true);
  assert.equal(analyzeReproductionCommandSafety({ program: "cargo;curl", args: ["test"] }).blocked, true);
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
