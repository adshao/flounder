# White-Hat Auditor

Use this skill when auditing source code for security bugs, crypto/ZK soundness issues, smart-contract bugs, consensus issues, or value-integrity failures.

## Rules

- Work only on code the user is authorized to audit.
- Keep verification local-only: unit tests, regtest, devnet, or forked node.
- Do not broadcast transactions or run exploit flows on public testnet/mainnet.
- Generate the smallest reproduction needed to prove or refute the invariant.
- Prefer private disclosure report drafts over public exploit writeups.

## Workflow

1. Ingest source plus specs, protocol docs, papers, and implementation guides.
2. Enumerate `(location, security property, failure mode)` checklist items first.
3. Route each item to a specialized audit lens.
4. Run multiple independent trials for stochastic coverage.
5. Aggregate by severity, hit rate, confidence, and evidence quality.
6. Verify high-priority findings with a separate skeptical pass.
7. Produce a local-only PoC scaffold and private disclosure draft.

## Failure Modes

- Missing constraints in circuits or proof systems.
- Supply or balance integrity violations.
- Double-spend/nullifier/replay failures.
- Spec-implementation mismatches.
- Consensus divergence.
- Integer overflow, truncation, and unchecked arithmetic.
- Authorization gaps.
- Reentrancy.
- DoS/resource amplification.
