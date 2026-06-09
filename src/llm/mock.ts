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

const HUNT_SUCCESS_PATTERN = "autonomous hunt confirmed the missing constraint locally";

// Deterministic agent for the thin hunt loop. It progresses by inspecting the
// transcript the loop feeds back, exercising every capability once: explore,
// read, run a passing local test, report a confirmed-executable finding, bank a
// memory note, then finish. Keeps mock-hunt and tests fully offline.
function huntActionFor(user: string): string {
  const action = (thought: string, tool: string, args: Record<string, unknown>): string => JSON.stringify({ thought, tool, args });
  if (!user.includes("action: list_files")) {
    return action("Map the loaded source before forming hypotheses.", "list_files", { kind: "source" });
  }
  if (!user.includes("action: read_file")) {
    return action("Read the region that assigns advice cells to look for a missing enforcement edge.", "read_file", {
      path: "halo2_missing_constraint.rs",
    });
  }
  if (!user.includes("action: run_test")) {
    return action("Prove the missing constraint with a local-only test before claiming it.", "run_test", {
      files: [
        {
          path: "hunt_repro.test.mjs",
          content: `import test from 'node:test';\n\ntest('${HUNT_SUCCESS_PATTERN}', () => {});\n`,
        },
      ],
      command: { program: "node", args: ["--test", "hunt_repro.test.mjs"] },
      expected_exit_code: 0,
      success_patterns: [HUNT_SUCCESS_PATTERN],
    });
  }
  if (!user.includes("action: report_finding")) {
    return action("The local test passed; record the confirmed finding citing that run.", "report_finding", {
      title: "Unconstrained advice assignment can affect checked logic",
      severity: "high",
      location: "halo2_missing_constraint.rs:5",
      description: "assign_advice writes a prover-controlled value with no visible copy/equality constraint before downstream checks rely on it.",
      evidence: "vulnerable_region assigns x_p/y_p via assign_advice with no constrain_equal or copy_advice edge.",
      exploit_sketch: "A malicious prover chooses a different value while still satisfying the downstream checks.",
      fix: "Constrain the assigned cell with copy_advice/constrain_equal to the trusted source value.",
      confidence: 0.85,
      test_run_id: "t1",
    });
  }
  if (!user.includes("action: remember")) {
    return action("Bank the result so future runs of this target start ahead.", "remember", {
      note: "halo2_missing_constraint.rs:5 assign_advice lacks an equality constraint; confirmed-executable.",
      kind: "finding",
      tags: ["halo2", "missing-constraint"],
      source_ref: "halo2_missing_constraint.rs:5",
    });
  }
  return action("Coverage of the loaded fixture is sufficient.", "finish", { summary: "One confirmed-executable missing-constraint finding." });
}

function responseFor(tag: string, user: string): string {
  if (tag === "hunt") {
    return huntActionFor(user);
  }

  if (tag === "learn_project") {
    return JSON.stringify({
      scopeSummary: "Mock initialization notes for a small source set with circuit-like checks.",
      securityObjectives: ["Checked statements should enforce the properties they rely on."],
      domainConcepts: ["assigned values", "verification checks", "local enforcement edges"],
      trustBoundaries: ["prover-controlled data entering trusted verification logic"],
      attackerCapabilities: ["choose private inputs or other values accepted by the checked code"],
      candidateInvariants: ["Values that affect a verified statement should be enforced by visible checks or equations."],
      implementationMechanics: ["Some source locations assign values before later checks use them."],
      uncertainty: ["Mock learning is only a deterministic test fixture."],
      evidenceRefs: ["fixtures"],
    });
  }

  if (tag === "discover_lenses") {
    return JSON.stringify([
      {
        id: "mock-project-lens",
        displayName: "Mock Project Lens",
        description: "Mock lens pack used to test model-generated project reconnaissance.",
        projectContext: {
          criticalAssets: ["verified statement integrity"],
          attackerCapabilities: ["choose private values accepted by the checked code"],
          securityInvariants: ["properties relied on by checks must be visibly enforced"],
        },
        failureModes: ["missing_constraint"],
        enumerationGuidance: ["Map values used by checks to the code that enforces them."],
        auditGuidance: ["Identify the visible enforcement edge before claiming a missing constraint."],
      },
    ]);
  }

  if (tag === "enumerate") {
    return JSON.stringify([
      {
        id: "mock-balance-integrity",
        location: "fixtures/halo2_missing_constraint.rs:5",
        securityProperty: "Values used by a verified statement must be enforced before downstream checks rely on them.",
        failureMode: "missing_constraint",
        why: "Mock enumeration item used to test end-to-end model-driven audit flow.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag === "enumerate_halo2_portfolio" || tag === "enumerate_assignment_dataflow") {
    return JSON.stringify([
      {
        id: "mock-assignment-dataflow",
        location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
        securityProperty: "Assigned values used by checked logic must have a visible enforcement path.",
        failureMode: "missing_constraint",
        why: "Mock portfolio item used to test focused evidence-portfolio enumeration.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag === "deepen_round_2" || tag === "deepen_round_2_breadth") {
    return JSON.stringify([
      {
        id: "mock-round-2-enforcement-edge",
        location: "fixtures/halo2_scalar_mul_binding.rs:13-14",
        securityProperty: "Neighboring values used by the same checked computation must have a visible enforcement edge.",
        failureMode: "missing_constraint",
        why: "Round 2 follows prior coverage into a neighboring data-flow edge that was not checked by the initial checklist.",
        attackerControlledInputs: ["private values used by the checked computation"],
      },
    ]);
  }

  if (tag === "deepen_round_2_depth") {
    return JSON.stringify([
      {
        id: "mock-round-2-proof-obligation",
        location: "fixtures/halo2_missing_constraint.rs:5-9",
        securityProperty: "The candidate missing-constraint hypothesis must be refuted or confirmed by checking the exact enforcement edge used by downstream logic.",
        failureMode: "missing_constraint",
        why: "Depth strategy follows the top candidate into the cheapest source-backed proof obligation instead of broadening to another module.",
        attackerControlledInputs: ["private value assignment"],
      },
    ]);
  }

  if (tag.startsWith("audit_")) {
    const hasMissingConstraintShape = /assign_advice|missing_constraint|witness advice/i.test(user);
    return JSON.stringify({
      finding: hasMissingConstraintShape,
      title: hasMissingConstraintShape ? "Assigned value can affect checked logic without visible enforcement" : "No finding",
      severity: hasMissingConstraintShape ? "high" : "info",
      confidence: hasMissingConstraintShape ? 0.82 : 0.2,
      description: hasMissingConstraintShape
        ? "The assigned value is treated as a logical input but the local context does not show an enforcement edge before downstream checks rely on it."
        : "The mocked auditor did not detect the target bug shape.",
      evidence: hasMissingConstraintShape
        ? "The source context contains assign_advice calls without a nearby copy_advice/constrain_equal chain in the vulnerable function."
        : "No matching evidence in mock response.",
      exploitSketch: hasMissingConstraintShape
        ? "A malicious prover could choose a different private value while satisfying downstream checks that assume the property was enforced."
        : "",
      fix: hasMissingConstraintShape
        ? "Add an explicit constraint or equivalent enforcement edge before the downstream check relies on the value."
        : "",
    });
  }

  if (tag.startsWith("verify_")) {
    return `1. VERDICT: confirmed

The mock verifier confirms the candidate at source level for framework testing. A real verifier must inspect the target circuit and write a local unit test.

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

Executable success patterns:

- mock reproduction demonstrates the local harness

Replace unconstrained advice assignment with copy/equality-constrained assignment.`;
  }

  if (tag.startsWith("reproduce_")) {
    return JSON.stringify({
      summary: "Mock local-only reproduction plan for CI coverage of the ReproductionAgent stage.",
      files: [
        {
          path: "repro.test.mjs",
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('mock reproduction demonstrates the local harness', () => {\n  assert.equal(1 + 1, 2);\n});\n",
        },
      ],
      commands: [
        {
          program: "node",
          args: ["--test", "repro.test.mjs"],
          cwd: ".",
          timeoutMs: 30000,
          expectedExitCode: 0,
        },
      ],
      successCriteria: ["The local test command exits with the expected status inside the copied workspace."],
      successPatterns: ["mock reproduction demonstrates the local harness"],
      safetyNotes: ["The command uses node --test in a local temporary workspace and does not target a public network."],
    });
  }

  return "";
}
