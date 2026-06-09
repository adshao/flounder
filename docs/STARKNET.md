# Cairo And Starknet Audits

`configs/cairo-starknet-hunt.default.json` is the default profile for authorized Cairo and Starknet audits, including Starknet OS, Cairo contracts, and StarkGate-style bridge components.

The profile keeps the framework's discovery rules intact: deterministic project profiles, source indexes, provenance facts, tool outputs, and local seeders are planning evidence only. Findings still require model-backed audit trials, source verification, known-issue checks, and optional local-only reproduction.

## What The Profile Adds

- Cairo/Starknet project context for state transition correctness, OS output commitments, L1/L2 bridge messages, token accounting, class hashes, syscalls, resource accounting, and role or governance authority.
- Domain lens packs for entrypoint authority, L1/L2 bridge message and accounting, Starknet OS state transition and output commitment, syscall context binding, class-hash deployment or replacement, and resource accounting.
- Custom auditor agents for Cairo-specific failure modes such as `cairo_entrypoint_authority`, `cairo_l1_l2_message_binding`, `cairo_state_transition_integrity`, `cairo_os_output_commitment`, `cairo_syscall_context_binding`, `cairo_class_hash_binding`, and `cairo_resource_accounting`.
- Cairo/Starknet provenance extraction for entrypoints, syscalls, storage reads and writes, dict/state update flows, L1/L2 messages, class-hash binding, resource accounting, block context, and OS output commitments.
- Cairo/Starknet-specific portfolio enumeration that turns provenance facts into candidate audit items for entrypoint authority, bridge payload/accounting, syscall context, state commitments, class hashes, and resource edges.

## Recommended Run

```bash
fsa run \
  --config ./configs/cairo-starknet-hunt.default.json \
  --target starknet-target-audit \
  --source <target>/src <target>/crates <target>/packages \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --provider openai \
  --model gpt-5.5 \
  --rounds 3 \
  --trials 5
```

For larger repositories, use a QMD collection scoped to the target material:

```bash
fsa run \
  --config ./configs/cairo-starknet-hunt.default.json \
  --target starknet-target-audit \
  --source <target>/src <target>/crates <target>/packages \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --qmd-collection target-starknet
```

## Local Reproduction

The default profile does not plan or execute reproductions during the audit run. After findings are collected, request local-only reproduction planning or execution explicitly:

```bash
fsa reproduce \
  --run runs/<target-run> \
  --source <target> \
  --repro plan \
  --verify-top 20
```

When execution is enabled, reproduction commands must stay inside local test runners, local fixtures, or isolated devnets. Do not use public mainnet or public testnet message sending, transaction broadcasting, exploit optimization, or credentialed infrastructure.

## Input Checklist

Load as much source-backed context as possible:

- Cairo contracts, Starknet OS Cairo files, generated interface files, Solidity L1 bridge contracts, and relevant Rust or Python harness code.
- `Scarb.toml`, `Scarb.lock`, compiler settings, contract manifests, and local test fixtures.
- Protocol specs, Starknet OS design docs, bridge message formats, bounty scope notes, prior audits, known limitations, and threat-model notes.
- Tests are coverage evidence, not proof that a property is enforced.

For high-stakes runs, extend `projectContext` with exact bounty assets, mainnet/testnet out-of-scope notes, privileged actor assumptions, bridge endpoints, token mappings, class-hash governance model, and local reproduction constraints.
