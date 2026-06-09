import type { AuditorAgentDefinition, BuiltInFailureMode, FailureMode } from "../types.js";

export type AuditorAgentRegistry = Record<string, AuditorAgentDefinition>;

export const BUILTIN_AUDITOR_AGENTS: Record<BuiltInFailureMode, AuditorAgentDefinition> = {
  missing_constraint: {
    failureMode: "missing_constraint",
    id: "missing-constraint-auditor",
    displayName: "Missing Constraint Auditor",
    guidance:
      "Check whether a security property is relied on by a verifier, guard, state transition, equation, or protocol rule but is not enforced by the visible implementation. Identify the exact enforcement edge or the specific missing edge.",
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
  proof_statement_binding: {
    failureMode: "proof_statement_binding",
    id: "proof-statement-binding-auditor",
    displayName: "Proof Statement Binding Auditor",
    guidance:
      "Check whether requested task inputs, witness source results, serialized witness data, metadata, and public inputs all bind to the same statement before proving or accepting a proof.",
  },
  proof_aggregation_binding: {
    failureMode: "proof_aggregation_binding",
    id: "proof-aggregation-binding-auditor",
    displayName: "Proof Aggregation Binding Auditor",
    guidance:
      "Check whether chunk, batch, bundle, or recursive aggregation consumes proofs and public inputs that are length-checked, order-checked, and rebound to the expected metadata and verification keys.",
  },
  proof_verifier_submission_binding: {
    failureMode: "proof_verifier_submission_binding",
    id: "proof-verifier-submission-binding-auditor",
    displayName: "Proof Verifier Submission Binding Auditor",
    guidance:
      "Check whether coordinator submit-proof and verifier paths bind submitted proof bytes to the stored task id, statement metadata, verification key, batch assignment, and downstream state transition.",
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
  input_validation: {
    failureMode: "input_validation",
    id: "input-validation-auditor",
    displayName: "Input Validation Auditor",
    guidance:
      "Check whether attacker-controlled inputs are parsed, normalized, bounded, and validated before they influence trust decisions, resource use, file paths, commands, or protocol state.",
  },
  injection: {
    failureMode: "injection",
    id: "injection-auditor",
    displayName: "Injection Auditor",
    guidance:
      "Trace untrusted data into interpreters such as SQL, shell, template engines, LDAP, XPath, GraphQL, eval-like APIs, and command arguments. Confirm parameterization or equivalent separation.",
  },
  ssrf: {
    failureMode: "ssrf",
    id: "ssrf-auditor",
    displayName: "SSRF Auditor",
    guidance:
      "Check URL, webhook, fetch, proxy, and metadata-client paths for attacker-controlled destinations, redirect handling, protocol allowlists, DNS rebinding, and internal network access.",
  },
  path_traversal: {
    failureMode: "path_traversal",
    id: "path-traversal-auditor",
    displayName: "Path Traversal Auditor",
    guidance:
      "Trace user-controlled filenames, archive entries, upload names, and route parameters into filesystem reads, writes, extraction, or deletion. Confirm canonicalization and base-directory enforcement.",
  },
  deserialization: {
    failureMode: "deserialization",
    id: "deserialization-auditor",
    displayName: "Deserialization Auditor",
    guidance:
      "Check whether untrusted serialized data can instantiate dangerous types, trigger gadget chains, bypass validation, or exceed expected object graph and resource bounds.",
  },
  access_control: {
    failureMode: "access_control",
    id: "access-control-auditor",
    displayName: "Access Control Auditor",
    guidance: "Check who can call or mutate this state and whether every path enforces that boundary.",
  },
  privilege_boundary: {
    failureMode: "privilege_boundary",
    id: "privilege-boundary-auditor",
    displayName: "Privilege Boundary Auditor",
    guidance:
      "Check cross-user, cross-tenant, admin, service-account, plugin, sandbox, and host/guest boundaries. Verify identity, authorization, and object ownership are enforced together.",
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
  cryptographic_misuse: {
    failureMode: "cryptographic_misuse",
    id: "cryptographic-misuse-auditor",
    displayName: "Cryptographic Misuse Auditor",
    guidance:
      "Check randomness, nonce reuse, key derivation, hash/domain separation, signature verification, encryption modes, constant-time boundaries, and downgrade or algorithm-confusion paths.",
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
  race_condition: {
    failureMode: "race_condition",
    id: "race-condition-auditor",
    displayName: "Race Condition Auditor",
    guidance:
      "Check time-of-check/time-of-use gaps, concurrent updates, retries, idempotency, locking, distributed coordination, async cancellation, and state transitions that can be interleaved by an attacker.",
  },
  secret_exposure: {
    failureMode: "secret_exposure",
    id: "secret-exposure-auditor",
    displayName: "Secret Exposure Auditor",
    guidance:
      "Check logs, traces, error messages, client bundles, config loading, debug endpoints, reports, and generated artifacts for credentials, tokens, private keys, or sensitive internal data.",
  },
  dependency_supply_chain: {
    failureMode: "dependency_supply_chain",
    id: "dependency-supply-chain-auditor",
    displayName: "Dependency Supply Chain Auditor",
    guidance:
      "Check dependency manifests, plugin loading, install scripts, dynamic imports, update channels, generated code, and package boundaries for trust confusion or execution of untrusted code.",
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
