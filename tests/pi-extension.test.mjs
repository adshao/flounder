import assert from "node:assert/strict";
import test from "node:test";
import extension, { applyFsaRunBudgets } from "../dist/pi/extension.js";
import { defaultConfig } from "../dist/config.js";

test("pi extension registers workflow tools", async () => {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const fakePi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  extension(fakePi);

  assert.deepEqual([...tools.keys()].sort(), [
    "flounder_audit",
    "flounder_confirm",
    "flounder_map",
    "flounder_prepare",
    "flounder_run",
  ]);
  assert.ok(commands.has("flounder"));
  assert.ok(handlers.has("tool_call"));
  assert.ok(handlers.has("user_bash"));

  // flounder_run mirrors the current CLI: clue-only starts prepare -> run -> confirm,
  // sourcePaths starts the sealed source audit. Only target is structurally required.
  const runParams = tools.get("flounder_run").parameters;
  assert.ok(runParams.required.includes("target"));
  assert.ok(!runParams.required.includes("sourcePaths"));
  assert.ok(runParams.properties.clue);
  assert.ok(runParams.properties.sourcePaths);

  // flounder_confirm mirrors `flounder confirm`: prior run dir + target source.
  const confirmParams = tools.get("flounder_confirm").parameters;
  assert.ok(confirmParams.required.includes("runDir"));
  assert.ok(confirmParams.required.includes("sourcePaths"));
});

test("pi extension blocks live-network exploit-like bash commands", async () => {
  const handlers = new Map();
  extension({
    registerTool() {},
    registerCommand() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const toolResult = await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "1",
    toolName: "bash",
    input: { command: "zcash-cli -testnet sendrawtransaction poc" },
  });
  assert.equal(toolResult.block, true);

  const prodResult = await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "2",
    toolName: "bash",
    input: { command: "chain-client --network production transfer --amount 1" },
  });
  assert.equal(prodResult.block, true);

  const userResult = await handlers.get("user_bash")({
    type: "user_bash",
    command: "run exploit on mainnet",
    excludeFromContext: false,
    cwd: process.cwd(),
  });
  assert.equal(userResult.result.exitCode, 2);
});

// The sealed workflow pi tools must default to the SAME unbounded budgets as the CLI. Earlier
// flounder_run set only auditMaxSteps and left map/dig at finite config defaults, silently
// truncating a pi-tool-driven map/dig audit. Pin the helper used by the tools.
test("flounder_run defaults to UNBOUNDED map/dig/breadth budgets (matches the `flounder run` CLI)", () => {
  const base = defaultConfig();
  assert.equal(base.auditMaxSteps, Number.POSITIVE_INFINITY);
  assert.equal(base.auditMapSteps, Number.POSITIVE_INFINITY);
  assert.equal(base.auditDigSteps, Number.POSITIVE_INFINITY);

  const cfg = defaultConfig();
  applyFsaRunBudgets(cfg, undefined);
  assert.equal(cfg.auditMaxSteps, Number.POSITIVE_INFINITY);
  assert.equal(cfg.auditMapSteps, Number.POSITIVE_INFINITY);
  assert.equal(cfg.auditDigSteps, Number.POSITIVE_INFINITY);
});

test("flounder_run maxSteps, when given, caps every phase (the one knob the tool exposes)", () => {
  const cfg = defaultConfig();
  applyFsaRunBudgets(cfg, 55);
  assert.equal(cfg.auditMaxSteps, 55);
  assert.equal(cfg.auditMapSteps, 55);
  assert.equal(cfg.auditDigSteps, 55);

  // a non-finite maxSteps is treated as unset → unbounded on every phase
  const unbounded = defaultConfig();
  applyFsaRunBudgets(unbounded, Number.POSITIVE_INFINITY);
  assert.equal(unbounded.auditMapSteps, Number.POSITIVE_INFINITY);
  assert.equal(unbounded.auditDigSteps, Number.POSITIVE_INFINITY);
});
