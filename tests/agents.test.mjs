import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditPrompt } from "../dist/agents/prompts.js";
import { createAgentRegistry, getAuditorAgent } from "../dist/agents/registry.js";
import { defaultConfig, effectiveFailureModes } from "../dist/config.js";

test("auditor agent registry can be extended with custom failure modes", () => {
  const cfg = defaultConfig();
  cfg.auditorAgents = [
    {
      failureMode: "custom_constraint_system",
      id: "custom-constraint-system-auditor",
      displayName: "Custom Constraint System Auditor",
      guidance: "Trace custom DSL constraints from assigned witnesses to enforced equations.",
    },
  ];

  const registry = createAgentRegistry(cfg.auditorAgents);
  const agent = getAuditorAgent("custom_constraint_system", registry);
  assert.equal(agent.id, "custom-constraint-system-auditor");
  assert.ok(effectiveFailureModes(cfg).includes("custom_constraint_system"));

  const prompt = buildAuditPrompt(
    {
      id: "custom-1",
      location: "fixtures/custom.dsl:10",
      securityProperty: "Every assigned value must be constrained.",
      failureMode: "custom_constraint_system",
      why: "Custom test item.",
    },
    "assign witness without constraint",
    registry,
  );
  assert.match(prompt, /Custom Constraint System Auditor/);
  assert.match(prompt, /Trace custom DSL constraints/);
});
