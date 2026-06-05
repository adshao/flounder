# Architecture

## Boundary

`full-stack-auditor` has two layers:

- Audit engine: deterministic TypeScript modules under `src/ingest`, `src/index`, `src/seeders`, `src/audit`, `src/verify`, and `src/reports`.
- Pi integration: thin adapters under `src/llm/pi-ai.ts` and `src/pi/extension.ts`.

The audit engine should not depend on pi-coding-agent. This keeps batch runs, CI, web UI, RPC mode, and future coding-agent flows on the same underlying artifacts.

## Pipeline

```text
source + corpus
  -> ingest
  -> source index / retrieval
  -> static seeders
  -> LLM enumeration
  -> checklist
  -> specialized audit trials
  -> aggregation
  -> independent verification plan
  -> disclosure draft
```

## Agent Roles

- Enumerator: maps code locations, spec statements, security properties, and failure modes.
- MissingConstraintAuditor: traces witness values to equality/copy/range constraints.
- BalanceIntegrityAuditor: checks conservation and turnstile boundaries.
- NullifierAuditor: checks uniqueness of spend markers and replay resistance.
- SpecMismatchAuditor: compares implementation and written spec line by line.
- ConsensusAuditor: checks ambiguity that could split implementations.
- VerificationAgent: refutes or confirms findings and writes local-only test scaffolds.

Audit roles are declared in `src/agents/registry.ts`. Adding a new role should be a registry change plus tests and, when useful, a static seeder.

The registry is extensible at runtime. `AuditorConfig.auditorAgents` accepts additional agent definitions, and their failure modes are merged into the enumeration prompt through `effectiveFailureModes`. The audit runner builds an agent registry for each run, so custom checklist items can route to custom guidance without changing built-in agents.

## Blind Discovery Gate

`npm run check:blind-discovery` runs the framework against a neutral halo2 scalar-multiplication fixture. The fixture does not name a target protocol, impact, or expected bug. The gate passes only if static discovery produces a generic missing-constraint checklist item from source structure alone.

This is not a substitute for a full target audit. It is a regression gate that prevents the framework from depending on answer-shaped fixture text or prompt hints for this class of issue.

## Pi Integration

The project is a pi package. `package.json` exposes:

- `src/pi/extension.ts` as an extension with audit tools.
- `skills/whitehat-auditor/SKILL.md` as operating instructions.
- `prompts/audit-target.md` as a reusable prompt template.

The extension registers read-only audit tools first. Tools that write tests or run commands should stay behind explicit user confirmation and sandbox guards.

`fsa_run_audit` defaults to dry-run so package users can inspect checklist generation before spending model calls. The extension also installs a guardrail on bash tool calls and direct user bash commands that combine public live networks with exploit/broadcast wording.

The command guardrail lives in `src/security/policy.ts` so non-pi integrations can reuse and test the same policy.

## Runnable Gates

- `npm run check`: strict TypeScript compile.
- `npm test`: build plus Node tests for JSON parsing, seeders, dry-run pipeline, mock end-to-end pipeline, and pi extension registration.
- `npm run dry-run`: static seeder run against fixtures.
- `npm run mock-run`: full model-shaped pipeline using deterministic mock LLM.
- `npm run check:blind-discovery`: blind fixture regression for autonomous missing-constraint enumeration.

## Local-Only Verification

Verification code must default to a local-only ladder:

1. Unit test against the isolated gadget/function.
2. Component test against the local protocol implementation.
3. End-to-end local regtest/devnet/forked-node test.

It must not generate or run live-network exploitation flows.
