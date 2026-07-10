# Versioned Coverage Loop

## Goal

Increase blind vulnerability recall without adding target-specific audit strategy,
weakening execution confirmation, or allowing the harness to modify its evaluator
and safety boundary.

## Architecture

```text
prepared material
      |
      v
material fingerprint -----> isolated evaluation attempt state
      |
      v
independent map samples ---> versioned scope union
      |
      v
per-scope dig samples -----> scope outcomes + composition edges
      |                              |
      |                              v
      +----------------------> delta-driven synthesis
                                     |
                                     v
                         verify -> refute/appeal -> confirm
                                     |
                                     v
                    execution-grounded consolidation + report
                                     |
                                     v
                   phase-attributed evaluation / harness gate
```

The framework persists coverage and evidence state. The model still owns which
security obligations to enumerate, which hypotheses to test, and which audit
strategy to use.

## Safety Invariants

- A scope outcome is coverage evidence, never a vulnerability finding.
- Only a passed local confirmation command can create an execution-confirmed
  finding.
- Scope and memory state must match the current material fingerprint.
- Evaluation attempts may share dependency caches, but never scope inventories,
  findings, transcripts, or model memory.
- Map samples are unioned. Lack of sample agreement may affect ordering but must
  never discard a singleton scope.
- Adaptive sampling may allocate more model work; it may not declare a scope safe.
- Finding consolidation is authoritative only when execution proves fix
  equivalence.
- Harness candidates cannot edit the evaluator, evidence gates, material policy,
  sandbox policy, promotion policy, tests, merge authority, or deployment logic.

## Test Plan

### Critical paths

- A changed material fingerprint starts a fresh map instead of resuming stale
  scopes or memory.
- Two independent map samples union complementary scopes and retain provenance.
- A zero-finding dig still writes a scope outcome and triggers cross-scope
  synthesis when new composition evidence exists.
- An incomplete scope outcome remains visible as a coverage blocker and may cause
  bounded adaptive resampling.
- A discharged obligation can be challenged without appearing as a finding first.
- Each Evaluation attempt receives fresh reasoning state while reusing only the
  dependency cache.
- A Harness promotion requires distinct cases/families and passing holdouts and
  controls.
- Fix-equivalent confirmed findings keep all occurrences but project one canonical
  lifecycle item after execution-based consolidation.

### Edge cases

- Legacy scope inventories without a material fingerprint fail closed into a new
  map. Their run artifacts remain readable for operator inspection while the
  active project inventory is refreshed.
- Interrupted map/dig writes remain resumable and cannot mix fingerprints.
- Concurrent dig workspaces cannot overwrite each other's scope outcomes.
- A malformed or missing scope outcome is reported as incomplete coverage rather
  than a safe result.
- Blocked build preparation remains a resource request, not a negative security
  outcome.
- A Harness holdout cannot be mined into the candidate proposal.
- Candidate and baseline groups with different evidence contracts remain
  incomparable.

### UI and API

- Project coverage shows map sample agreement, outcome completeness, composition
  backlog, unique confirmed yield, duplicate rate, and resource-blocked rate at
  project level.
- Evaluations / Harness shows failure phase, distinct cases/families, holdout
  results, and state-isolation provenance.
- Finding rows remain compact; no per-finding progress diagram is introduced.

## Not In Scope

- Target-specific vulnerability taxonomies or platform playbooks.
- Automatic merge, deployment, bounty submission, or live-system writes.
- Treating deterministic source indexes, history facts, scope outcomes, or model
  agreement as findings.
- Unbounded O(N^2) consolidation for large finding sets.
