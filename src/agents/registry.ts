import type { AuditorAgentDefinition, BuiltInFailureMode, FailureMode } from "../types.js";

export type AuditorAgentRegistry = Record<string, AuditorAgentDefinition>;

export const BUILTIN_AUDITOR_AGENTS: Record<BuiltInFailureMode, AuditorAgentDefinition> = {
  missing_constraint: {
    failureMode: "missing_constraint",
    id: "missing-constraint-auditor",
    displayName: "Missing Constraint Auditor",
    guidance:
      "Look for a witnessed or assigned value that is used in a check but is never constrained to equal its intended source. Trace every input to the check back to equality, copy, lookup, range, or public-input constraints.",
  },
  supply_balance_integrity: {
    failureMode: "supply_balance_integrity",
    id: "balance-integrity-auditor",
    displayName: "Balance Integrity Auditor",
    guidance:
      "Check whether value can be created or destroyed. Follow every conservation equation, pool boundary, turnstile, fee path, rounding path, and disabled branch.",
  },
  double_spend_nullifier: {
    failureMode: "double_spend_nullifier",
    id: "nullifier-auditor",
    displayName: "Nullifier Auditor",
    guidance:
      "Check whether the spend marker is unique per spent object. Look for ways to produce two valid markers for the same note/object, replay a marker, or bind it to the wrong key.",
  },
  soundness_gap: {
    failureMode: "soundness_gap",
    id: "soundness-auditor",
    displayName: "Soundness Auditor",
    guidance:
      "Check whether a prover can convince the verifier of a false statement. Compare the claimed statement to the exact checks enforced.",
  },
  spec_impl_mismatch: {
    failureMode: "spec_impl_mismatch",
    id: "spec-implementation-auditor",
    displayName: "Spec Implementation Auditor",
    guidance:
      "Compare implementation and spec line by line. Flag subtle reorderings, missing clauses, incomplete edge cases, or changed preconditions.",
  },
  integer_overflow: {
    failureMode: "integer_overflow",
    id: "integer-safety-auditor",
    displayName: "Integer Safety Auditor",
    guidance: "Find arithmetic that can wrap, overflow, underflow, truncate, or silently change sign or precision.",
  },
  access_control: {
    failureMode: "access_control",
    id: "access-control-auditor",
    displayName: "Access Control Auditor",
    guidance: "Check who can call or mutate this state and whether every path enforces that boundary.",
  },
  reentrancy: {
    failureMode: "reentrancy",
    id: "reentrancy-auditor",
    displayName: "Reentrancy Auditor",
    guidance: "Find external calls or callbacks before local state and accounting are finalized.",
  },
  signature_replay: {
    failureMode: "signature_replay",
    id: "signature-replay-auditor",
    displayName: "Signature Replay Auditor",
    guidance: "Check domain separation, nonces, chain IDs, contexts, and message binding.",
  },
  consensus_divergence: {
    failureMode: "consensus_divergence",
    id: "consensus-divergence-auditor",
    displayName: "Consensus Divergence Auditor",
    guidance:
      "Check whether two conforming implementations could disagree on validity due to ambiguity, undefined behavior, serialization, timing, or platform behavior.",
  },
  dos_resource: {
    failureMode: "dos_resource",
    id: "resource-exhaustion-auditor",
    displayName: "Resource Exhaustion Auditor",
    guidance: "Find cheap inputs that force expensive work, panic, unbounded allocation, infinite loops, or network amplification.",
  },
};

export const AUDITOR_AGENTS: AuditorAgentRegistry = BUILTIN_AUDITOR_AGENTS;

export function createAgentRegistry(extraAgents: AuditorAgentDefinition[] = []): AuditorAgentRegistry {
  const registry: AuditorAgentRegistry = { ...BUILTIN_AUDITOR_AGENTS };
  for (const agent of extraAgents) {
    registry[agent.failureMode] = agent;
  }
  return registry;
}

export function getAuditorAgent(failureMode: FailureMode, registry: AuditorAgentRegistry = AUDITOR_AGENTS): AuditorAgentDefinition {
  return registry[failureMode] ?? {
    failureMode,
    id: `${failureMode.replace(/[^a-zA-Z0-9_.-]+/g, "-")}-auditor`,
    displayName: `${failureMode} Auditor`,
    guidance:
      "Analyze the assigned security property directly from source and reference material. State exactly what enforces the property or what attacker-controlled value can violate it.",
  };
}
