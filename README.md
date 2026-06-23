<p align="center"><img src="assets/flounder-black.png" alt="Flounder" width="280" /></p>

<h1 align="center">Flounder</h1>

<p align="center"><strong>An autonomous white-hat security auditor.</strong><br/>Security automation for target prep, audit, exploit construction, and execution proof.</p>

<p align="center">
  <a href="docs/USAGE.md">Usage</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

Flounder turns modern coding agents into an end-to-end security audit system. Give it an authorized target boundary - a repository, source tree, package, deployed clue, or prior run - and the agent can prepare the workspace, read the code and supporting material, map the attack surface, dig into promising regions, construct exploit paths, run local proof tests, and then reproduce confirmed findings against real-world ground truth.

The important distinction is that Flounder is not a scanner for one stack, a checklist runner, or a set of hand-written bug rules. It is a thin white-hat audit workflow around the model: the model decides how to reason about the target, while Flounder supplies the sandbox, command policy, durable state, execution gates, daemon control plane, and reporting needed to make that reasoning usable.

## Use It With An Agent

Install the skill once:

```bash
npx skills add . --skill flounder -g -a codex -a claude-code
```

Then ask Codex, Claude Code, or another skills-aware agent naturally:

```text
Audit this repository with Flounder.
```

The installed skill should trigger from requests about Flounder audits, authorized source review, smart-contract or ZK audit work, daemon/provider setup, verifying suspected findings, confirming real findings, or collecting execution-backed bug reports. The source of truth is [skills/flounder/SKILL.md](skills/flounder/SKILL.md).

## Why Flounder

- **Autonomous audit loop.** `flounder run <clue>` can execute prepare -> map -> dig -> confirm as a tracked workflow. Prepare can turn a transaction, address, project, repository, or link into staged source and materials; map inventories the audit surface; dig writes and runs proof tests; confirm reproduces findings on the real target. The operator does not have to build a custom scenario pipeline for each target.
- **Framework-agnostic reasoning.** Flounder does not encode a Solidity/EVM, ZK/proof-system, Rust, Go, JavaScript, protocol, or crypto-specific audit strategy. Source, corpus, and optional profiles are inputs; the audit strategy comes from the model. As coding models improve, the audit capability can improve without rewriting the framework around every new stack.
- **Execution-grounded findings.** A finding is not real because the model says it is plausible. It must cite a passing local command that exercises the vulnerable path. Stronger findings also pass differential confirmation, independent refutation, and faithful-PoC appeal checks.
- **Blind discovery plus open-world reproduction.** Discovery runs network-sealed, so findings are derived from the target material rather than copied from disclosures. `flounder confirm` then opens the network only for white-hat reproduction, novelty checks, and submit/no-submit decision sheets.
- **Sandboxed execution boundary.** Model-generated code, PoCs, dependency installs, and local tests run in a copied workspace, not directly in the host checkout. The default OCI backend refuses silent host execution, bind-mounts only the copied workspace and package cache, drops Linux capabilities, uses `no-new-privileges`, read-only root filesystems and tmpfs temp dirs, applies process/memory/CPU limits when configured, and disables network for sealed audit commands. This reduces the blast radius of malicious dependencies, unsafe PoCs, and model mistakes before they can pollute the host machine.
- **Multiple audit scenarios.** Use the same product for blind audits, targeted vulnerability investigation, reproducing prior suspected findings, confirming a finished run, or preparing a deployment-matched workspace from an external clue.
- **Strong fit for Solidity and ZK.** Solidity/EVM targets work well because local forks and Foundry/Hardhat tests can prove real on-chain effects. ZK/proof-system targets work well because local prover and constraint harnesses can turn subtle missing constraints into executable counterexamples. These are high-signal examples, not hard-coded limits.
- **Designed for agent tooling.** Flounder exposes the audit workflow through a CLI, React dashboard, self-describing REST API, pi extension, provider profiles, and daemon execution plane. Codex-style and Claude Code-style providers can be routed through the same sandbox and audit contract.
- **Local control of code and credentials.** The UI server is a control plane. Audits run on a daemon, optionally on another machine, so target code and provider credentials stay on the executor host.

## Where It Fits

- **Blind audits**: give Flounder source and real project materials; it discovers from the code instead of from public disclosures.
- **Solidity/EVM audits**: use Foundry/Hardhat tests and local forks to prove on-chain effects without broadcasting.
- **ZK and proof-system audits**: use local prover or constraint harnesses to turn soundness gaps into executable counterexamples.
- **Vulnerability investigation**: start from a transaction, address, report, or suspected claim, then settle it by execution.
- **Audit continuation**: resume pending scopes, prioritize a suspicious region, or verify a previous suspected finding.
- **Disclosure preparation**: confirm reproduced findings, consolidate duplicates, and collect reports plus command evidence.

## What Flounder Automates

Flounder is built for the parts of security work that usually require a human to keep switching tools and context:

| Step | What Flounder does |
| --- | --- |
| Target preparation | Turns a repo, source tree, package, project link, address, transaction, or prior run into staged audit material. |
| Source and corpus review | Lets the model read source plus project-owned specs, docs, prior audits, and design material. |
| Scope mapping | Enumerates the audit surface and scores scopes before spending deep-audit time. |
| Deep audit | Digs selected scopes obligation-by-obligation instead of doing a shallow one-shot prompt. |
| Exploit construction | Writes local PoCs, tests, fixtures, or harnesses inside an isolated workspace. |
| Sandboxed execution | Runs model-generated tests and PoCs away from the host source tree, credentials, and user environment. |
| Execution proof | Runs the proof locally and only upgrades findings when command evidence exists. |
| Real-target confirmation | Reproduces confirmed findings against real-world ground truth, such as a local fork of a deployed target. |
| Reporting | Tracks status, artifacts, reports, confirm decisions, and submission state across projects. |

## Quickstart

Use Node 22 LTS. This repository includes `.nvmrc` and `.node-version` pinned to
22.20.0, the version used by the test suite.

```bash
nvm use
npm install
npm run build
npm run sandbox:build
```

Command examples below use the installed `flounder` binary. In a fresh source
checkout before installing or linking the package, use `node dist/cli.js` in its
place:

```bash
# Start the local control plane and dashboard.
node dist/cli.js ui
```

After installing the package globally, the same command is:

```bash
flounder ui

# On each executor machine, authenticate the providers it will run.
flounder daemon provider login openai-codex
flounder daemon provider check openai-codex

# For a daemon on another machine, mint a control-plane token first.
flounder server daemon-token mint remote-1
flounder daemon start --server http://<server>:4500 --token <token>
```

`openai-codex` uses pi subscription/OAuth auth. An agent can trigger the user
login by running `flounder daemon provider login openai-codex`; the command
prints a browser URL or device-code instructions for the user to complete. If
the same provider is already logged in through pi at `~/.pi/agent/auth.json`,
Flounder imports that provider entry into its daemon-local auth file on
`login`/`check`.

Then create a project in the dashboard, choose its execution daemon and default provider profile, and start a run. The CLI can drive the same control plane:

```bash
# One-command open-world prepare -> sealed audit -> open-world confirm.
flounder run <tx-or-address-or-project-or-repo-or-link>

# Source-provided sealed audit.
flounder run --target my-target --source ./src --build-root . --corpus ./docs

# Confirm a finished run against real-world ground truth.
flounder confirm ~/.flounder/my-target-<timestamp> --source ./src --build-root .
```

`--mock-llm` runs offline for development. See [docs/USAGE.md](docs/USAGE.md) for commands, materials, daemon setup, provider profiles, budgets, and the API.

## Sandbox Runtime

Real audits execute model-generated commands through the sandbox. The safe default is Docker-backed OCI: install and start Docker or a Docker-compatible runtime, then build the default image with `npm run sandbox:build`. `--sandbox-backend auto` uses `flounder-sandbox:latest` when available and otherwise fails closed instead of silently running tests on the host.

The default image is a baseline, not a promise to cover every target stack. It includes common build and audit toolchains so the first run has a safe execution boundary, but specialized targets should use a daemon- or operator-provided image with the exact compiler, prover, chain tooling, or package manager they require:

```bash
flounder run --source ./src --build-root . --sandbox-image your-audit-image:latest
```

Image construction is part of the trusted execution base. The audit model may report missing toolchains or propose an image recipe, but it should not receive unrestricted `docker build` / `docker pull` capability inside the audit loop. A safe automation path is to generate a reviewable target-specific image plan, build it in a controlled daemon/operator step, then pin and reuse that image by name or digest.

For trusted local smoke tests only, use `--sandbox-backend host --allow-host-execution` or set `FLOUNDER_ALLOW_HOST_EXECUTION=1`. Host mode still uses the copied workspace plus isolated `HOME` and package-cache paths, but it does not provide kernel-level filesystem or network isolation and should not be used for untrusted targets, malicious dependencies, or real model-generated exploit code.

## Use It Yourself

Agents can drive everything through [skills/flounder/SKILL.md](skills/flounder/SKILL.md), but every step is also exposed directly:

- **Dashboard**: `flounder ui` for projects, daemons, provider profiles, runs, scopes, findings, live activity, and reports.
- **CLI**: workflow verbs (`prepare`, `run`, `map`, `audit`, `confirm`), control-plane resources under `flounder server ...`, daemon-local operations under `flounder daemon ...`, and `config`.
- **REST API**: `GET /api` returns the self-describing catalog; agents can create projects, enqueue runs, watch logs, and read findings without the UI.
- **pi extension**: `flounder_prepare`, `flounder_run`, `flounder_map`, `flounder_audit`, and `flounder_confirm` mirror the top-level workflow verbs when loaded through pi.

## How It Works

The tracked workflow is:

1. **Prepare**: acquire or stage source, corpus, dependency closure, and deployment-match evidence when the run starts from a clue.
2. **Map**: enumerate and score the audit surface without producing findings.
3. **Dig**: deep-audit selected scopes, construct PoCs, and execution-confirm findings locally.
4. **Confirm**: reproduce confirmed findings on real-world ground truth and decide whether they are submission candidates.

You can run that end to end or drive each phase directly:

| Command | Use |
| --- | --- |
| `flounder run <clue>` | one-command prepare -> sealed map/dig -> confirm from a transaction, address, repo, package, project, or link |
| `flounder prepare <clue>` | acquire and stage a deployment-matched target before audit |
| `flounder run --source <paths...>` | sealed source audit: map -> dig on source you already have |
| `flounder map` | enumerate the scope inventory only |
| `flounder audit <region>` / `--scope` / `--verify` | deep-audit a region, selected inventory scopes, or suspected findings |
| `flounder confirm <run-dir>` | reproduce already-confirmed findings on real-world ground truth |

A finding's status is the framework's verdict from execution:

| Status | Meaning |
| --- | --- |
| `confirmed-differential` | The exploit ran and the model's minimal fix blocked it while the test still ran. |
| `confirmed-executable` | A cited local confirmation test triggered the bug. |
| `suspected` | Credible but not execution-proven, or downgraded by refutation. |
| `refuted` | A skeptic or real-target reproduction broke the claim. |

## Outputs

A run produces private artifacts under the output directory. By default, Flounder keeps local state under `~/.flounder`:

- `~/.flounder/flounder.db`: local tracking database for projects, runs, findings, daemon tokens, and jobs.
- `~/.flounder/<target>-<timestamp>/`: run artifacts, copied workspaces, logs, transcripts, findings, and reports.
- `~/.flounder/history/<target>/`: durable memory, scope inventory, build cache, and project history.
- `~/.flounder/workspace/`: default daemon workspace for project directories.
- `~/.flounder/agent/auth.json`: daemon-local provider auth, created by `flounder daemon provider login` or imported from an existing pi auth entry.

System temp directories are used only for short-lived scratch such as non-interactive CLI subprocess working directories or inline verify payloads; they are not the default tracking store.

A run artifact directory contains:

- scope inventory and coverage (`audit_scopes.json`, `summary.json`)
- findings and hypotheses (`audit_findings.json`, `audit_hypotheses.json`)
- command evidence (`audit_command_runs.json`)
- live/replay trace (`events.jsonl`, `audit_transcript.json`, `calls/*.json`)
- private report drafts (`audit_report.md`, `report_<id>.md`)
- confirm decision sheets (`confirm_decision.json`, `confirm_report.md`, `confirm_equivalence.json`)

The dashboard stores metadata and artifact paths in SQLite so an agent can inspect progress without scraping run directories.

## Dashboard

`flounder ui` is a local control plane and dashboard for projects, daemons, provider profiles, runs, scopes, findings, reports, and live activity. A project is pinned to an execution daemon and a default provider profile, with optional per-phase provider overrides for prepare, map, dig, and confirm. The selected daemon must be authenticated for every provider profile the project can use.

The project view shows the prepare -> map -> dig -> confirm workflow, current phase, scope coverage, live model activity, findings as they land, per-finding confirm actions, and real-target reproduction status. A cross-project Findings view tracks every finding through submission states.

Every UI operation is also a REST call. `GET /api` returns the API catalog, and `GET /api/runs/:id/log` streams the executing daemon's live model output, tool calls, and milestones.

## White-Hat Boundary

Flounder is for authorized audits only: your own code, client-authorized targets, or public bug-bounty scope. Sealed discovery is local-only. Model-generated files and commands run inside the copied sandbox workspace instead of directly mutating the host checkout. Open-world confirmation can fetch, search, fork, and read, but it must never broadcast transactions, move funds, submit writes, persist access, or target systems outside scope. Replay exploits only against local tests, local forks, or isolated harnesses. See [SECURITY.md](SECURITY.md).

## Documentation

- [Usage](docs/USAGE.md): commands, sandbox setup, dashboard, API, materials, providers, daemon setup, and outputs.
- [Architecture](docs/ARCHITECTURE.md): thin-agent design, sandbox boundary, confirmation boundary, control/execution split, and tracking model.
- [Agent skill](skills/flounder/SKILL.md): Codex / Claude Code operating manual.
- [Domain profiles](configs/README.md): optional answer-free context packs. They are not product modes and are off by default.
- [Optional Solidity/EVM notes](docs/SOLIDITY.md) and [ZK constraint profile](configs/zk-constraint-audit.default.json): high-signal context examples, not Flounder's core limit.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). AGPL v3 licensed.
