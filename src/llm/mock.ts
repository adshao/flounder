import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

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
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
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

function responseFor(tag: string, user: string): string {
  if (tag === "enumerate") {
    return JSON.stringify([
      {
        id: "mock-balance-integrity",
        location: "fixtures/halo2_missing_constraint.rs:5",
        securityProperty: "Advice assignments used as logical circuit inputs must be constrained to their intended source values.",
        failureMode: "missing_constraint",
        why: "Mock enumeration item used to test end-to-end model-driven audit flow.",
        attackerControlledInputs: ["private witness assignment"],
      },
    ]);
  }

  if (tag.startsWith("audit_")) {
    const hasMissingConstraintShape = /assign_advice|missing_constraint|witness advice/i.test(user);
    return JSON.stringify({
      finding: hasMissingConstraintShape,
      title: hasMissingConstraintShape ? "Unconstrained advice assignment can diverge from intended source" : "No finding",
      severity: hasMissingConstraintShape ? "high" : "info",
      confidence: hasMissingConstraintShape ? 0.82 : 0.2,
      description: hasMissingConstraintShape
        ? "The assigned advice value is treated as a logical input but the local context does not show a copy/equality constraint tying it to the intended source."
        : "The mocked auditor did not detect the target bug shape.",
      evidence: hasMissingConstraintShape
        ? "The source context contains assign_advice calls without a nearby copy_advice/constrain_equal chain in the vulnerable function."
        : "No matching evidence in mock response.",
      exploitSketch: hasMissingConstraintShape
        ? "A malicious prover could choose a different private witness value and satisfy downstream checks that assume it equals the intended source."
        : "",
      fix: hasMissingConstraintShape
        ? "Use copy_advice or an explicit equality constraint for the first assigned value, then rely on existing loop equality constraints."
        : "",
    });
  }

  if (tag.startsWith("verify_")) {
    return `1. VERDICT: needs-investigation

The mock verifier confirms the framework path only. A real verifier must inspect the target circuit and write a local unit test.

2. Confidence ladder

- Local gadget unit test that mutates the witness assignment.
- Component proof test in the target circuit.
- Local regtest/devnet end-to-end test if the component test confirms impact.

3. PoC scaffold

\`\`\`rust
// Local-only unit test scaffold. Do not run against testnet or mainnet.
#[test]
fn advice_assignment_must_be_constrained() {
    // Construct honest and malicious witness assignments and assert the malicious
    // assignment is rejected after the fix.
}
\`\`\`

4. Minimal fix

Replace unconstrained advice assignment with copy/equality-constrained assignment.`;
  }

  return "";
}
