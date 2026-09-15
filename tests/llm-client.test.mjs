import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../dist/config.js";
import { createLlmClient } from "../dist/llm/client.js";
import { claudeCodeEffort, ClaudeCodeClient } from "../dist/llm/claude-code.js";
import { buildCodexExecArgs, CodexCliClient } from "../dist/llm/codex-cli.js";
import { PiAiClient } from "../dist/llm/pi-ai.js";
import { RunLogger } from "../dist/trace/logger.js";

test("llm factory uses pi-ai by default and CLI fallbacks only when requested", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-llm-client-"));
  const logger = new RunLogger(out, "factory-test");
  const cfg = defaultConfig();

  assert.ok(createLlmClient(cfg, logger) instanceof PiAiClient);
  cfg.provider = "codex-cli";
  assert.ok(createLlmClient(cfg, logger) instanceof CodexCliClient);
  cfg.provider = "claude-code";
  assert.ok(createLlmClient(cfg, logger) instanceof ClaudeCodeClient);
});

test("codex-cli fallback isolates non-interactive audit calls from user config and rules", () => {
  const args = buildCodexExecArgs({
    model: "gpt-5.5",
    workdir: "tmp-workdir",
    outputFile: "tmp-workdir/last-message.txt",
    thinkingLevel: "max",
    webSearch: "disabled",
  });

  assert.deepEqual(args.slice(0, 5), ["exec", "-c", "web_search=disabled", "-c", 'model_reasoning_effort="max"']);
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("--sandbox"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.doesNotMatch(args.join(" "), /danger-full-access/);
});

test("claude-code forwards max reasoning effort", () => {
  assert.equal(claudeCodeEffort("max"), "max");
});
