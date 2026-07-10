import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCommandSafety, analyzeReproductionCommandSafety, analyzeAgentBashCommandSafety, analyzeConfirmBashCommandSafety, isAgentBuildCommand, isAgentConfirmCommand, openWorldCommandNeedsNetwork } from "../dist/security/policy.js";

const cmd = (program, ...args) => ({ program, args });

test("agent bash allows build/dependency commands (the build phase) across ecosystems", () => {
  for (const c of [
    cmd("cargo", "build"),
    cmd("cargo", "-Znext-lockfile-bump", "build"),
    cmd("cargo", "fetch"),
    cmd("npm", "install"),
    cmd("go", "mod", "download"),
    cmd("forge", "build"),
    cmd("pip", "install", "-r", "requirements.txt"),
    cmd("python3", "-m", "venv", ".venv"),
    cmd("python3", "-m", "pip", "install", "-r", "requirements.txt"),
    cmd("scarb", "build"),
    cmd("scarb", "fetch"),
    cmd("scarb", "check"),
    cmd("scarb", "metadata", "--format-version", "1"),
    cmd("scarb", "--offline", "build"),
    cmd("scarb", "--offline", "metadata", "--format-version", "1"),
    cmd("env", "SCARB_CACHE=./.scarb-cache", "scarb", "fetch"),
    cmd("blueprint", "build", "--all"),
    cmd("npx", "blueprint", "build", "--all"),
    cmd("yarn", "blueprint", "build", "--all"),
    cmd("func-js", "contracts/pool.fc"),
    cmd("tolk-js", "contracts/router.tolk"),
    cmd("tact", "--config", "tact.config.json"),
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
  assert.equal(isAgentConfirmCommand(cmd("python3", "-m", "venv", ".venv")), false);
  assert.equal(isAgentConfirmCommand(cmd("cmake", "--build", "build/bbapi-poc")), false);
  assert.equal(isAgentConfirmCommand(cmd("ninja", "-C", "build/bbapi-poc")), false);
  assert.equal(isAgentConfirmCommand(cmd("scarb", "build")), false);
  assert.equal(isAgentConfirmCommand(cmd("scarb", "--offline", "build")), false);
  assert.equal(isAgentConfirmCommand(cmd("env", "SCARB_CACHE=./.scarb-cache", "scarb", "fetch")), false);
  assert.equal(isAgentConfirmCommand(cmd("blueprint", "build", "--all")), false);
  assert.equal(isAgentConfirmCommand(cmd("func-js", "contracts/pool.fc")), false);
  assert.equal(isAgentBuildCommand(cmd("func-js")), false);
  assert.equal(isAgentConfirmCommand(cmd("tolk-js", "contracts/router.tolk")), false);
  assert.equal(isAgentConfirmCommand(cmd("tact", "--config", "tact.config.json")), false);
  // and a test runner is a confirm command, not a build command
  assert.equal(isAgentBuildCommand(cmd("cargo", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("cargo", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("cargo", "-Znext-lockfile-bump", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("cargo", "-Znext-lockfile-bump", "test")), true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cargo", "-Znext-lockfile-bump", "test", "--test", "padded_proof_acceptance")).blocked, false);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cargo", "+nightly", "-Z", "next-lockfile-bump", "test")).blocked, false);
  assert.equal(isAgentBuildCommand(cmd("ctest", "--test-dir", "build/bbapi-poc")), false);
  assert.equal(isAgentConfirmCommand(cmd("ctest", "--test-dir", "build/bbapi-poc")), true);
  assert.equal(isAgentBuildCommand(cmd("scarb", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("scarb", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("scarb", "--offline", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("scarb", "--offline", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("snforge", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("snforge", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("blueprint", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("blueprint", "test")), true);
  assert.equal(isAgentBuildCommand(cmd("npx", "blueprint", "test")), false);
  assert.equal(isAgentConfirmCommand(cmd("npx", "blueprint", "test")), true);
});

test("a build command still cannot smuggle a remote/mainnet target in its argv", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("cargo", "build", "--target-dir", "https://evil.example/x")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("forge", "build", "--fork-url", "https://mainnet.example")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cmake", "-S", "https://evil.example/project", "-B", "build")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cmake", "-P", "script.cmake")).blocked, true);
});

test("arbitrary non-build, non-test, non-inspection commands stay blocked", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("curl", "https://evil.example")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("env", "FOO=bar", "curl", "https://evil.example")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("env", "SCARB_CACHE=../outside", "scarb", "fetch")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("env", "BAD=https://evil.example", "scarb", "fetch")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("rm", "-rf", "x")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("env", "FOO=bar", "rm", "-rf", "x")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("python3", "-c", "print('unchecked script')")).blocked, true);
});

test("agent bash allows creating model-owned PoC harness directories only", () => {
  for (const c of [
    cmd("mkdir", "-p", "poc/src"),
    cmd("mkdir", "--parents", "tests/verify_poc/src"),
    cmd("mkdir", "-p", ".tmp/flounder-repro/src"),
    cmd("mkdir", "-p", "scratch/harness"),
  ]) {
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be allowed`);
    assert.equal(isAgentBuildCommand(c), false);
    assert.equal(isAgentConfirmCommand(c), false);
  }

  assert.equal(analyzeAgentBashCommandSafety(cmd("mkdir", "src")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("mkdir", "-p", "../poc")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("mkdir", "-m", "777", "poc/src")).blocked, true);
});

test("destructive filesystem commands stay blocked even in network-enabled confirm mode", () => {
  for (const c of [
    cmd("rm", "-rf", "sources/reserve-protocol-protocol/sources"),
    cmd("rmdir", "sources/tmp"),
    cmd("find", "sources", "-delete"),
    cmd("find", "sources", "-exec", "rm", "-rf", "{}", ";"),
    cmd("sed", "-i", "s/a/b/g", "contracts/Target.sol"),
    cmd("git", "-C", "sources/repo", "clean", "-fdx"),
    cmd("git", "-C", "sources/repo", "reset", "--hard"),
    cmd("env", "FOO=bar", "rm", "-rf", "sources/tmp"),
    cmd("env", "FOO=bar", "env", "BAR=baz", "rm", "-rf", "sources/tmp"),
  ]) {
    const decision = analyzeConfirmBashCommandSafety(c);
    assert.equal(decision.blocked, true, `${c.program} ${c.args.join(" ")} must be blocked`);
    assert.match(decision.reason, /destructive filesystem/i);
  }
});

test("agent bash allows readonly tool discovery, version, and local JSON inspection", () => {
  for (const c of [
    cmd("which", "nargo"),
    cmd("which", "scarb"),
    cmd("which", "tact"),
    cmd("nargo", "--version"),
    cmd("scarb", "--version"),
    cmd("scarb", "--help"),
    cmd("snforge", "--version"),
    cmd("sncast", "--version"),
    cmd("blueprint", "--version"),
    cmd("func-js", "--version"),
    cmd("tolk-js", "--version"),
    cmd("tact", "--version"),
    cmd("forge", "--version"),
    cmd("jq", ".", "provenance/mainnet_rpc_state_20260614.json"),
    cmd("python3", "-m", "json.tool", "provenance/mainnet_rpc_state_20260614.json"),
  ]) {
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be readonly inspection`);
    assert.equal(isAgentBuildCommand(c), false, `${c.program} ${c.args.join(" ")} should not be a build command`);
    assert.equal(isAgentConfirmCommand(c), false, `${c.program} ${c.args.join(" ")} should not confirm findings`);
  }
});

test("agent bash allows readonly file-existence inspection tests only", () => {
  for (const c of [
    cmd("test", "-f", "specs/zips/zips/zip-0032.rst"),
    cmd("test", "-d", "source_packages"),
    cmd("[", "-e", "prepare_manifest.json", "]"),
  ]) {
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, false, `${c.program} ${c.args.join(" ")} should be readonly inspection`);
    assert.equal(isAgentBuildCommand(c), false);
    assert.equal(isAgentConfirmCommand(c), false);
  }

  assert.equal(analyzeAgentBashCommandSafety(cmd("test", "a", "=", "b")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("test", "-w", "source_packages")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("[", "-f", "prepare_manifest.json")).blocked, true);
});

test("agent bash distinguishes RPC-named local files from RPC secret references", () => {
  assert.equal(analyzeAgentBashCommandSafety(cmd("rg", "Inbox", "provenance/mainnet_rpc_state_20260614.json")).blocked, false);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cat", "provenance/MAINNET_RPC_STATE.json")).blocked, false);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cat", "$MAINNET_RPC_URL")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cat", "${MAINNET_RPC_URL}")).blocked, true);
  assert.equal(analyzeAgentBashCommandSafety(cmd("cat", "MAINNET_RPC_URL")).blocked, true);
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
  assert.equal(analyzeReproductionCommandSafety({ program: "scarb", args: ["test"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "snforge", args: ["test"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "blueprint", args: ["test"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "npx", args: ["hardhat", "test", "test/repro.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "npx", args: ["blueprint", "test", "tests/repro.spec.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "yarn", args: ["hardhat", "test", "test/repro.ts"] }).blocked, false);
  assert.equal(analyzeReproductionCommandSafety({ program: "yarn", args: ["blueprint", "test", "repro"] }).blocked, false);
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

test("open-world egress is granted per command instead of per phase", () => {
  for (const c of [
    cmd("forge", "test", "--fork-url", "https://eth.llamarpc.com"),
    cmd("cast", "call", "--rpc-url", "https://mainnet.example", "0xabc", "balanceOf()"),
    cmd("curl", "-fsSL", "https://example.com/spec.json"),
    cmd("wget", "-q", "https://example.com/spec.json"),
    cmd("git", "clone", "https://github.com/example/project"),
    cmd("gh", "api", "repos/example/project"),
    cmd("gh", "issue", "view", "123"),
  ]) assert.equal(openWorldCommandNeedsNetwork(c, "inspect"), true, `${c.program} should receive read-only egress`);

  for (const c of [
    cmd("node", "repro.mjs"),
    cmd("node", "-e", "fetch('https:'+'//mainnet.example',{method:'POST',body:'eth_'+'sendRawTransaction'})"),
    cmd("curl", "-X", "POST", "https://mainnet.example", "--data", "{}"),
    cmd("curl", "-XPOST", "https://mainnet.example"),
    cmd("curl", "-sXPOST", "https://mainnet.example"),
    cmd("curl", "-Tpayload.json", "https://mainnet.example"),
    cmd("curl", "-sTpayload.json", "https://mainnet.example"),
    cmd("curl", "-Ffile=@proof.json", "https://mainnet.example"),
    cmd("curl", "--config", "poc/curl.conf", "https://mainnet.example"),
    cmd("curl", "https://example.com", "gopher://victim.example:8545/_payload"),
    cmd("curl", "--header", "X-HTTP-Method-Override: DELETE", "https://mainnet.example"),
    cmd("curl", "--next", "https://mainnet.example"),
    cmd("wget", "--config=poc/wgetrc", "https://mainnet.example"),
    cmd("wget", "-epost_data=payload", "https://mainnet.example"),
    cmd("wget", "-qepost_data=payload", "https://mainnet.example"),
    cmd("wget", "--header=X-HTTP-Method-Override: DELETE", "https://mainnet.example"),
    cmd("wget", "--input-file=poc/urls.txt", "https://mainnet.example"),
    cmd("git", "clone", "ext::sh -c id"),
    cmd("git", "clone", "--upload-pack=touch-pwned", "https://github.com/example/project"),
    cmd("git", "clone", "-utouch-pwned", "https://github.com/example/project"),
    cmd("git", "clone", "ssh://evil.example/project", "https://github.com/example/destination"),
    cmd("git", "-C", "clone", "push", "https://example.com/repo"),
    cmd("git", "--git-dir", "clone", "push", "https://example.com/repo"),
    cmd("git", "clone", "--template=poc/template", "https://github.com/example/project"),
    cmd("git", "push", "origin", "main"),
    cmd("gh", "api", "repos/example/project/issues", "--method", "POST"),
    cmd("gh", "api", "-XPOST", "repos/example/project/issues"),
    cmd("gh", "api", "-iXPOST", "repos/example/project/issues"),
    cmd("gh", "api", "repos/example/project/issues", "-ftitle=mutate"),
    cmd("gh", "repo", "clone", "example/project", "--", "--upload-pack=touch-pwned"),
    cmd("gh", "repo", "create", "clone", "--public"),
    cmd("gh", "release", "create", "list", "--notes", "mutation"),
    cmd("gh", "issue", "create", "--title", "list", "--body", "mutation"),
    cmd("forge", "test", "--fork-url", "https://mainnet.example", "--ffi=true"),
  ]) assert.equal(openWorldCommandNeedsNetwork(c, "inspect"), false, `${c.program} must remain network-sealed`);

  assert.equal(openWorldCommandNeedsNetwork(cmd("npm", "install"), "build"), true);
  assert.equal(openWorldCommandNeedsNetwork(cmd("npm", "test"), "confirm"), false);
});

test("env wrappers cannot alter the executable or sandbox settings behind an egress decision", () => {
  for (const c of [
    cmd("env", "PATH=.", "forge", "test", "--fork-url", "https://mainnet.example"),
    cmd("env", "FOUNDRY_FFI=true", "forge", "test", "--fork-url", "https://mainnet.example"),
    cmd("env", "CURL_HOME=poc", "curl", "https://mainnet.example"),
    cmd("env", "LD_PRELOAD=poc/shim.so", "curl", "https://mainnet.example"),
    cmd("env", "-u", "FOO", "curl", "https://mainnet.example"),
  ]) {
    assert.equal(analyzeConfirmBashCommandSafety(c).blocked, true, `${c.args[0]} must be rejected`);
    assert.equal(analyzeAgentBashCommandSafety(c).blocked, true, `${c.args[0]} must be rejected in sealed agent mode too`);
    assert.equal(openWorldCommandNeedsNetwork(c, "inspect"), false, `${c.args[0]} must not receive egress`);
  }

  // Harmless local wrappers remain usable, but never acquire open-world egress:
  // the allowlisted executable must be launched directly for that capability.
  const cacheWrapper = cmd("env", "SCARB_CACHE=./.scarb-cache", "scarb", "fetch");
  assert.equal(analyzeConfirmBashCommandSafety(cacheWrapper).blocked, false);
  assert.equal(openWorldCommandNeedsNetwork(cacheWrapper, "build"), false);
});

test("confirm-mode bash cannot smuggle remote URLs into generated test files", () => {
  const pythonWrite = cmd(
    "python3",
    "-c",
    "open('poc/Scarb.toml','w').write('[[tool.snforge.fork]]\\nurl = \"https://rpc.starknet.lava.build\"\\n')",
  );
  const nodeWrite = cmd(
    "node",
    "-e",
    "require('fs').writeFileSync('repro/config.json', '{\"rpc\":\"https://mainnet.example\"}')",
  );
  for (const c of [pythonWrite, nodeWrite]) {
    const decision = analyzeConfirmBashCommandSafety(c);
    assert.equal(decision.blocked, true, `${c.program} ${c.args.join(" ")} must be blocked`);
    assert.match(decision.reason, /generated test file.*remote URLs/i);
  }

  assert.equal(
    analyzeConfirmBashCommandSafety(
      cmd("python3", "-c", "open('poc/Scarb.toml','w').write('[dependencies]\\nstaking = { path = \"..\" }\\n')"),
    ).blocked,
    false,
  );
  assert.equal(
    analyzeConfirmBashCommandSafety(
      cmd("python3", "-c", "import urllib.request; print(urllib.request.urlopen('https://rpc.starknet.lava.build').status)"),
    ).blocked,
    false,
  );
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
    analyzeReproductionCommandSafety({ program: "yarn", args: ["hardhat", "test", "--network", "sepolia"] }).blocked,
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
