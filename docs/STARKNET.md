# Optional Cairo / Starknet Notes

`configs/cairo-starknet-audit.default.json` provides optional context for authorized Cairo and Starknet audits, including Starknet OS, Cairo contracts, and StarkGate-style bridge components. This is an example of stack-specific context, not a separate Flounder product mode and not a default strategy.

In audit mode, the profile is context, not a checklist. The agent still decides what to read, suspect, test, and report. Deterministic profiles, provenance facts, source indexes, and local seeders are planning aids only; findings must come from the agent and local evidence.

## What The Profile Adds

- Cairo/Starknet project context for state transition correctness, OS output commitments, L1/L2 bridge messages, token accounting, class hashes, syscalls, resource accounting, and role or governance authority.
- Optional domain hints for entrypoint authority, L1/L2 bridge binding, state transition integrity, OS output commitment, syscall context binding, class-hash binding, and resource accounting.
- Cairo/Starknet provenance facts for entrypoints, syscalls, storage reads and writes, dict/state update flows, L1/L2 messages, class-hash binding, resource accounting, block context, and OS output commitments.

## Example With The Optional Profile

```bash
flounder run \
  --config ./configs/cairo-starknet-audit.default.json \
  --target starknet-target-audit \
  --source <target>/src <target>/crates <target>/packages \
  --corpus <target>/README.md <target>/docs <target>/specs \
  --provider openai-codex \
  --model gpt-5.5 \
  --thinking xhigh \
  --map-steps 60 --dig-steps 60
```

For larger repositories, include the highest-signal specs, bridge message formats, OS design notes, prior audits, test suites, and threat-model material as corpus input.

## Local Reproduction

Reproduction is part of the audit: the agent calls `bash` to run local tests in the copied workspace, and a finding only becomes `confirmed-executable` when a `purpose=confirm` test passes. During `flounder run`, reproduction commands stay inside local test runners, local fixtures, or isolated devnets — no public mainnet/testnet message sending, transaction broadcasting, exploit optimization, or credentialed infrastructure.

## Open-World Confirmation

After a run, `flounder confirm <run-dir> --source <paths...>` reproduces the findings against real-world ground truth and writes a submit/no-submit decision sheet. Confirm may fork and read live networks/data, but still never broadcasts to a live one — the exploit is replayed only against a local fork or node. For heavy or old-toolchain Cairo/Rust workspaces, pre-seed the per-target package cache from a prior run and raise `--prepare-timeout-ms` so the cold build fits; reproducing a proof-system soundness gap against the real circuit/verifying key is the costliest case and may land `needs-human` when the real consumer circuit is out of `--source` scope.

## Input Checklist

Load as much source-backed context as possible:

- Cairo contracts, Starknet OS Cairo files, generated interface files, Solidity L1 bridge contracts, and relevant Rust or Python harness code.
- `Scarb.toml`, `Scarb.lock`, compiler settings, contract manifests, and local test fixtures.
- Protocol specs, Starknet OS design docs, bridge message formats, bounty scope notes, prior audits, known limitations, and threat-model notes.
- Tests are coverage evidence, not proof that a property is enforced.

For high-stakes audits, extend `projectContext` with exact bounty assets, public-network out-of-scope notes, privileged actor assumptions, bridge endpoints, token mappings, class-hash governance model, and local reproduction constraints.
