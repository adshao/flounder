# `configs/` - optional context profiles

These JSON files are optional, answer-free context profiles. They are not Flounder product modes and they are not loaded by default. They exist for cases where an operator deliberately wants to give the model a familiar frame for a class of target.

| File | Optional context |
| --- | --- |
| `vulnerability-audit.default.json` | generic security audit context (domain-agnostic) |
| `zk-constraint-audit.default.json` | zero-knowledge / constraint-system circuits |
| `solidity-contract-audit.default.json` | Solidity / EVM smart contracts |
| `thegraph-contracts.default.json` | The Graph protocol contracts |
| `cairo-starknet-audit.default.json` | Cairo contracts and Starknet-related components |

Each is a `projectContext` scaffold for that class: the kind of assets, attacker
capabilities, trust boundaries, invariants, and focus areas a known stack tends to have.
The model still owns the audit strategy and the framework still requires execution proof.

## Not used by default — and that's deliberate

The framework **never loads these on its own.** A default `flounder run` / `flounder map` /
`flounder audit` carries **no preset bug knowledge**: the run is blind and execution-grounded,
so the model has to enumerate the attack surface from the *actual* source before any
audit trial can find anything. Handing the model a pre-written list of where bugs usually
live biases it toward the listed areas and away from the unlisted, and risks turning the
audit into checklist-matching instead of reading. That is the opposite of how this tool is
meant to find novel bugs, so the profiles stay off unless you ask for them.

They exist for the cases where that trade-off is worth it: a **well-trodden vulnerability
class** where seeding the common surface is genuinely useful, a **capped budget** that
needs a head start on focus/out-of-scope, or **quickly framing scope** for a familiar
stack. The Solidity/EVM and ZK profiles are common high-signal examples. In those situations, opt in:

```bash
flounder run --config ./configs/solidity-contract-audit.default.json \
        --target my-protocol --source ./contracts --corpus ./docs
```

## What a profile actually changes

`--config <file>` merges into the run config (`applyConfigOverrides`), then **command-line
flags override it** — so `--target` / `--source` / `--corpus` / `--max-steps` you pass on
the CLI win over the file. From `projectContext`, only **`summary`, `focusAreas`, and
`outOfScope`** currently reach the model (woven into its scope note). The richer fields
below are **documentation/scaffold today** — they record the threat model for a human
author but are not yet injected into the prompt.

```jsonc
{
  "targetName": "…",
  "sourcePaths": [],          // usually left empty; pass the real target via --source
  "corpusPaths": [],          // usually left empty; pass the project's own docs via --corpus
  "thinkingLevel": "xhigh",
  "projectContext": {
    "summary": "…",            // ── injected into the model's scope note
    "focusAreas": ["…"],       // ── injected
    "outOfScope": ["…"],       // ── injected
    "criticalAssets": ["…"],         // scaffold only (declared, not yet prompted)
    "attackerCapabilities": ["…"],   // scaffold only
    "trustBoundaries": ["…"],        // scaffold only
    "securityInvariants": ["…"],     // scaffold only
    "scenarioGuidance": ["…"]        // scaffold only
  }
}
```

Leave `sourcePaths` / `corpusPaths` empty in the profile and pass the **real** target and
the **project's own** specs/docs on the command line. A profile is a frame, not a
substitute for the target's actual material.

## The line a profile must not cross

A profile is **context, never a verdict.** It may tell the model where to look; it may not
tell the model what it will find. Confirmation still comes only from execution — a finding
is real because a PoC ran, never because it matched a profile. (The profiles' own
`scenarioGuidance` says it outright: "Do not write static bug rules that claim findings.")

## Extending this directory

This is the opt-in home for **domain context packs**. To add one, keep it generic to a
*class* and **answer-free**: capture the attack surface and invariants a class tends to
have, never a specific known bug in a specific target. Anything target-specific belongs in
that audit's `--corpus`, not here.
