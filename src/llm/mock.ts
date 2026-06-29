import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import type { ThinkingLevel } from "../config.js";

export class MockAuditLlmClient implements LlmClient {
  constructor(private logger?: RunLogger) {}

  setLogger(logger: RunLogger): void {
    this.logger = logger;
  }

  async complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: ThinkingLevel;
  }): Promise<string> {
    const response = responseFor(input.tag, input.user);
    await this.logger?.call({
      tag: input.tag,
      model: input.model ?? "mock",
      system: input.system,
      user: input.user,
      response,
      meta: { mock: true },
    });
    return response;
  }
}

const AUDIT_SUCCESS_PATTERN = "autonomous audit confirmed the missing constraint locally";

// Deterministic agent for the thin audit loop. It progresses by inspecting the
// transcript the loop feeds back, exercising pi-style primitives: read source,
// write a local harness, run it with bash, write findings.json, then return done.
// Keeps mock-audit and tests fully offline.
function auditActionFor(user: string): string {
  const action = (thought: string, tool: string, args: Record<string, unknown>): string => JSON.stringify({ thought, tool, args });
  // MAP phase: enumerate the scope inventory into scopes.json, then stop.
  if (user.includes("Phase: MAP")) {
    if (!user.includes("wrote scopes.json")) {
      return action("Apply the lenses and enumerate the scope inventory.", "write", {
        path: "scopes.json",
        content: JSON.stringify([
          {
            id: "S1",
            obligation: "the advice cell must be constrained to its trusted source value",
            region: "halo2_missing_constraint.rs:5",
            lenses: ["unbound-input"],
            exposure: "critical",
            difficulty: "high",
            score: 95,
            why: "assign_advice writes a prover-controlled value that downstream checks trust, with no visible equality edge.",
          },
          {
            id: "S2",
            obligation: "secondary advice region must bind to its source",
            region: "halo2_missing_constraint.rs:5",
            lenses: ["unbound-input"],
            exposure: "high",
            difficulty: "medium",
            score: 76,
            why: "a second enumerated scope so coverage spans more than one dig batch.",
          },
        ]),
      });
    }
    return JSON.stringify({ thought: "Scope inventory written.", done: true, summary: "1 scope enumerated." });
  }
  if (!user.includes("action: read")) {
    return action("Read the region that assigns advice cells to look for a missing enforcement edge.", "read", {
      path: "halo2_missing_constraint.rs",
    });
  }
  if (!user.includes("audit_repro.test.mjs")) {
    return action("Write a local-only test harness in the sandbox workspace.", "write", {
      path: "audit_repro.test.mjs",
      content: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { confirmsMissingConstraintHarness } from './mock_target.mjs';\n\ntest('${AUDIT_SUCCESS_PATTERN}', () => { assert.equal(confirmsMissingConstraintHarness(), true); console.log('${AUDIT_SUCCESS_PATTERN}'); });\n`,
    });
  }
  if (!user.includes("action: bash")) {
    return action("Prove the missing constraint with a local-only test before claiming it.", "bash", {
      cmd: "node --test audit_repro.test.mjs",
      purpose: "confirm",
      expected_exit_code: 0,
      success_patterns: [AUDIT_SUCCESS_PATTERN],
    });
  }
  if (!user.includes('"path":"findings.json"')) {
    return action("The local command passed; write findings.json citing that evidence.", "write", {
      path: "findings.json",
      content: JSON.stringify([
        {
          title: "Unconstrained advice assignment can affect checked logic",
          severity: "high",
          location: "halo2_missing_constraint.rs:5",
          description: "assign_advice writes a prover-controlled value with no visible copy/equality constraint before downstream checks rely on it.",
          evidence: "vulnerable_region assigns x_p/y_p via assign_advice with no constrain_equal or copy_advice edge.",
          exploit_sketch: "A malicious prover chooses a different value while still satisfying the downstream checks.",
          fix: "Constrain the assigned cell with copy_advice/constrain_equal to the trusted source value.",
          confidence: 0.85,
          command_id: "cmd1",
        },
      ]),
    });
  }
  return JSON.stringify({ thought: "Coverage of the loaded fixture is sufficient.", done: true, summary: "One confirmed-executable missing-constraint finding." });
}

function responseFor(tag: string, _user: string): string {
  // The deterministic mock now only drives the audit loop; the staged-pipeline
  // tags (learn/enumerate/audit/verify/reproduce) were removed with that pipeline.
  if (tag === "audit") return auditActionFor(_user);
  // Independent refutation: the mock skeptic cannot break the (genuinely correct) mock finding.
  if (tag.startsWith("refute_")) return JSON.stringify({ refuted: false, reason: "mock skeptic could not refute the confirmed finding" });
  return "";
}
