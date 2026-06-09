import assert from "node:assert/strict";
import test from "node:test";
import { profileProject, renderProjectProfile } from "../dist/profile/project.js";

test("project profile summarizes multi-language security context", () => {
  const profile = profileProject([
    {
      path: "package.json",
      kind: "source",
      content: JSON.stringify({ dependencies: { next: "latest", express: "latest" } }),
    },
    {
      path: "src/server/router.ts",
      kind: "source",
      content: `
        import express from "express";
        export function handler(req, res) {
          const url = req.query.webhook;
          fetch(url);
          db.query("select * from users where id = " + req.query.id);
        }
      `,
    },
    {
      path: "contracts/Vault.sol",
      kind: "source",
      content: `
        contract Vault {
          function withdraw(uint amount) external {
            msg.sender.call("");
          }
        }
      `,
    },
    {
      path: "pyproject.toml",
      kind: "source",
      content: "[project]\nname = \"sample\"",
    },
    {
      path: "worker/jobs.py",
      kind: "source",
      content: "def handler(event):\n    pickle.loads(event.body)\n",
    },
  ]);

  assert.ok(profile.languages.includes("TypeScript"));
  assert.ok(profile.languages.includes("Solidity"));
  assert.ok(profile.languages.includes("Python"));
  assert.ok(profile.frameworks.includes("React/Next.js"));
  assert.ok(profile.frameworks.includes("Node HTTP API"));
  assert.ok(profile.frameworks.includes("EVM smart contract"));
  assert.ok(profile.packageManagers.includes("npm/yarn/pnpm"));
  assert.ok(profile.packageManagers.includes("pip/poetry/uv"));
  assert.ok(profile.likelySecurityDomains.includes("server-side request and proxy safety"));
  assert.ok(profile.likelySecurityDomains.includes("data access and injection risk"));
  assert.ok(profile.likelySecurityDomains.includes("deserialization and parser safety"));
  assert.ok(profile.likelySecurityDomains.includes("smart contract security"));
  assert.ok(profile.entrypoints.includes("src/server/router.ts"));

  const rendered = renderProjectProfile(profile);
  assert.match(rendered, /Languages:/);
  assert.match(rendered, /Likely security domains:/);
});

test("project profile recognizes Solidity audit toolchain and EVM risk domains", () => {
  const profile = profileProject([
    {
      path: "foundry.toml",
      kind: "source",
      content: "[profile.default]\nsrc = \"src\"\n",
    },
    {
      path: "remappings.txt",
      kind: "source",
      content: "@openzeppelin/=lib/openzeppelin-contracts/\nforge-std/=lib/forge-std/src/\n",
    },
    {
      path: "slither.config.json",
      kind: "source",
      content: "{\"filter_paths\":\"test\"}",
    },
    {
      path: "contracts/UpgradeableVault.sol",
      kind: "source",
      content: `
        import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
        contract UpgradeableVault is UUPSUpgradeable {
          AggregatorV3Interface public priceFeed;
          function initialize() public initializer {}
          function depositWithPermit(bytes calldata sig) external {}
          function withdraw(uint256 shares) external {
            (, int256 answer,,,) = priceFeed.latestRoundData();
          }
          function _authorizeUpgrade(address impl) internal override onlyOwner {}
        }
      `,
    },
  ]);

  assert.ok(profile.manifests.includes("Foundry manifest"));
  assert.ok(profile.manifests.includes("Solidity remappings"));
  assert.ok(profile.manifests.includes("Slither config"));
  assert.ok(profile.frameworks.includes("Foundry"));
  assert.ok(profile.frameworks.includes("OpenZeppelin/ERC standards"));
  assert.ok(profile.frameworks.includes("Upgradeable proxy"));
  assert.ok(profile.frameworks.includes("Oracle integration"));
  assert.ok(profile.likelySecurityDomains.includes("smart contract upgradeability and storage safety"));
  assert.ok(profile.likelySecurityDomains.includes("EVM signature and permit replay security"));
  assert.ok(profile.likelySecurityDomains.includes("oracle and market manipulation risk"));
  assert.ok(profile.entrypoints.includes("contracts/upgradeablevault.sol"));
});

test("project profile recognizes Cairo Starknet code and Scarb manifests", () => {
  const profile = profileProject([
    {
      path: "Scarb.toml",
      kind: "source",
      content: "[package]\nname = \"bridge\"",
    },
    {
      path: "packages/bridge/src/token_bridge.cairo",
      kind: "source",
      content: `
        #[starknet::contract]
        pub mod TokenBridge {
          use starknet::syscalls::send_message_to_l1_syscall;

          #[l1_handler]
          fn handle_deposit(ref self: ContractState, from_address: felt252, amount: u256) {
            let result = send_message_to_l1_syscall(to_address: from_address, payload: array![amount].span());
            assert(result.is_ok(), 'MESSAGE_SEND_FAILED');
          }
        }
      `,
    },
  ]);

  assert.ok(profile.languages.includes("Cairo"));
  assert.ok(profile.manifests.includes("Scarb package manifest"));
  assert.ok(profile.packageManagers.includes("scarb"));
  assert.ok(profile.frameworks.includes("Cairo/Starknet"));
  assert.ok(profile.likelySecurityDomains.includes("Starknet state transition and bridge security"));
  assert.ok(profile.entrypoints.includes("packages/bridge/src/token_bridge.cairo"));
});
