# Flounder examples

Read [../SKILL.md](../SKILL.md) first. These examples show common audit paths.

## Agent Requests

After installing the skill, ask Codex or Claude Code naturally:

```text
Audit ./contracts with Flounder. The authorized scope is this repository. Use ./docs/specs as corpus.
```

## Solidity/EVM Source Audit

```bash
flounder ui
flounder daemon provider login openai-codex
flounder daemon provider check openai-codex

flounder run \
  --target evm-audit \
  --source ./contracts --build-root . \
  --corpus ./docs/specs \
  --map-steps 60 --dig-steps 60 --dig-samples 2 --max-scopes 30
```

Then inspect:

```bash
flounder server finding list --project evm-audit
```

Confirm real candidates:

```bash
flounder confirm ~/.flounder/evm-audit-<timestamp> \
  --source ./contracts --build-root .
```

## ZK / Proof-System Audit

```bash
flounder run \
  --target zk-circuit-audit \
  --source ./crates/circuit --build-root . \
  --corpus ./docs/circuit-spec \
  --dig-samples 2 --max-scopes 30
```

If map finds a subtle high-value region but rank order is not ideal:

```bash
flounder map --target zk-circuit-audit --source ./crates/circuit --build-root . --corpus ./docs/circuit-spec
flounder audit --scope <id> --source ./crates/circuit --build-root . --dig-samples 3
```

## Clue-Driven Investigation

For a transaction, address, repository, package, or project link:

```bash
flounder run <clue>
```

This uses prepare first, then sealed audit, then confirm when possible. Use this
when the user has a deployment clue rather than a fully staged source tree.

## Verify Existing Suspicions

Write a JSON file:

```json
[
  {
    "title": "suspected issue",
    "location": "src/Foo.sol:120",
    "description": "The suspected security property failure.",
    "exploit_sketch": "How an attacker might trigger it."
  }
]
```

Then run:

```bash
flounder audit --verify claims.json --source ./contracts --build-root .
```

Return each claim as confirmed, refuted, or still suspected. Do not merge these
statuses.
