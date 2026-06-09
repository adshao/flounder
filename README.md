# full-stack-auditor

White-hat full-stack security audit agent framework for model-driven source auditing across languages, stacks, and security domains.

This implementation is TypeScript-first and uses pi-mono as the agent/runtime integration point. The audit core stays framework-light so it can run as a batch CLI, a pi package extension, a coding-agent workflow, or a future UI/RPC service.

## Design

The core workflow is:

1. Load source, specs, papers, books, and implementation notes.
2. Build a deterministic project profile from language, framework, manifest, entrypoint, and security-domain signals.
3. In live runs, let the model write initialization learning notes from the loaded material.
4. Let the model perform project reconnaissance and propose dynamic lens packs.
5. Enumerate concrete audit items before looking for bugs, including a lens-free baseline pass when configured lenses are present.
6. Route each item to built-in or project-specific failure-mode agents.
7. Run one or more exploration rounds. Later rounds use prior coverage and audit observations to propose novel follow-up items.
8. Run multiple independent model audit trials per item.
9. Aggregate by severity, hit rate, confidence, and evidence quality.
10. Verify findings separately with source-level reasoning.
11. Optionally plan or execute local-only reproductions after findings have been collected.
12. Keep a complete audit trail of prompts, model outputs, artifacts, and events.

Only model-backed audit trials produce bug findings. Project profiles, source indexes, initialization learning notes, dynamic lens packs, and optional local checklist seeders organize context and propose questions; they do not count as discovery evidence by themselves.

The default scope mode is `augment`: configured or model-generated lens packs route attention, but they are not treated as the audit boundary. In augment mode, the first round reserves a configurable slice for lens-free baseline enumeration so manually supplied lenses do not blind the run to adjacent source-backed risks. Use `restrict` only when the engagement scope is intentionally limited and missing out-of-lens bugs is acceptable.

`rounds` and `trials` are separate controls. Rounds deepen project exploration by generating new checklist items from previous coverage gaps. Trials repeat the audit of one item to measure stochastic agreement and reduce one-off model noise. A multi-round run must add novel checklist coverage; it is not a replay of a single pass.

## Why pi-mono

pi already provides the pieces this project will need if it grows into a coding agent:

- `@earendil-works/pi-ai` for multi-provider LLM calls.
- `@earendil-works/pi-coding-agent` for SDK sessions, tools, extensions, skills, prompts, and RPC mode.
- Project-local `.pi` style extensibility through package manifests.

The framework therefore exposes both:

- a normal CLI: `fsa run ...`
- a pi package: `package.json` declares `src/pi/extension.ts`, `skills/`, and `prompts/`

LLM calls use `@earendil-works/pi-ai` by default. Local CLI fallback providers are available for environments where pi provider credentials are unavailable but a CLI is authenticated: `codex-cli` for Codex CLI, and `claude-code` for Claude Code. These are opt-in and do not route through pi-ai.
Provider availability is a runtime concern. Do not hard-code assumptions that every model family is available through every pi provider.

## Install

```bash
npm install
npm run build
npm test
```

For live model runs, configure provider credentials in your shell or secret manager according to the pi-ai provider documentation. Do not commit credentials, local environment files, or machine-specific paths.

## Dry Run

```bash
npm run dry-run
```

This reads local source and emits checklist items without calling a model. Dry-run output is useful for coverage inspection, but it cannot produce bug findings.

The default live pipeline does not use deterministic local seeders. `npm run dry-run` enables them explicitly because dry-run has no model available.

## Mock End-to-End Run

```bash
npm run mock-run
```

This runs the full pipeline with a deterministic mock LLM: enumeration, audit trials, aggregation, verification, report generation, and audit-trail logging. It is the no-API-key smoke test.

## Full Run

```bash
fsa run \
  --target protocol-audit \
  --source ./src ./contracts \
  --corpus ./docs ./specs \
  --provider openai \
  --model gpt-5.5 \
  --thinking xhigh \
  --rounds 2 \
  --strategy hybrid \
  --trials 4
```

Artifacts are written under `runs/<target>-<timestamp>/`.

This live run uses model initialization learning, model-generated lenses, model enumeration, audit trials, aggregation, and source-level verification by default. Deterministic local seeders are off unless `--local-seeders` is passed. Executable PoC planning and execution are off by default.

Live runs use `--scope-mode augment` by default. If a config file supplies project-specific lens packs, augment mode still asks the model for a separate broad baseline checklist. Tune that reserve with `--baseline-exploration-share <0..0.8>`, or use `--scope-mode restrict` for explicitly bounded engagements.

Each audit round also writes `round_<n>_context_retrieval.json`. This artifact records which source slices were included for each audit item, why they were selected, how much budget they used, and whether optional QMD retrieval was available. Use it to debug recall quality before interpreting a no-finding as a model reasoning failure.

If pi provider credentials are unavailable but local Codex CLI is authenticated, use the Codex CLI fallback provider:

```bash
fsa run --config ./audit-config.json --provider codex-cli --model gpt-5.5 --thinking xhigh
```

The Codex CLI fallback runs with an ephemeral read-only workspace, ignores user config, disables local skill loading, and records each model call under the run's `calls/` directory. Provider failures are recorded as trial-level model errors so one transient call does not invalidate the whole round.

For Claude Code, use the direct CLI fallback provider. `xhigh` maps to Claude Code's max effort mode:

```bash
fsa run --config ./audit-config.json --provider claude-code --model claude-opus-4-8 --thinking xhigh
```

For cost-controlled exploratory runs, cap the total audit item budget explicitly:

```bash
fsa run --config ./audit-config.json --max-items 25
```

The default is uncapped.

When `--rounds` is greater than 1, the first enumeration round does not consume the entire cap. The scheduler reserves budget for follow-up rounds and selects the initial checklist with source-location diversity so later modules are not dropped simply because one file produced many early candidates.

## Confirmation And Reproduction

Findings use three confirmation levels:

- `suspected`: at least one model-backed audit trial reported a finding.
- `confirmed-source`: the independent verification stage confirmed the reasoning from source-level evidence.
- `confirmed-executable`: an optional local-only reproduction command matched its expected result and produced a verifier-owned machine-checkable success pattern.

The default `fsa run` mode stops before PoC planning or execution. This keeps vulnerability hunting focused on finding and source-confirming candidates without writing tests or running project commands.

Verification is impact-first by default. `--verify-top <n>` selects the normal ranked queue, and `highImpactVerification` adds high-impact findings beyond that cap. Soundness gaps, missing constraints with malicious-prover impact, value/accounting failures, authorization bypasses, replay, bridge, oracle, solvency, and consensus-style issues should still receive source verification even when early scoring ranks them below lower-impact noise.

To ask for a local-only reproduction plan at the end of a run:

```bash
fsa run --config ./audit-config.json --source <source-paths...> --repro plan
```

To execute local reproductions after all candidate findings are collected:

```bash
fsa run --config ./audit-config.json --source <source-paths...> --repro execute
```

You can also run the reproduction stage later against an existing run:

```bash
fsa reproduce \
  --run runs/<target-run> \
  --source <source-paths...> \
  --repro execute \
  --verify-top 100
```

`--verify-top` controls how many ranked findings receive source verification and optional reproduction. High-impact findings are added beyond this number unless `--no-high-impact-verification` is used. Set `--high-impact-max-findings` higher for high-budget bug hunts.

The ReproductionAgent writes files only inside a copied workspace under the run directory. It does not modify the target source tree. Execution is limited to structured local test commands such as `cargo test`, `go test`, `node --test`, `pytest`, `forge test`, and comparable local test runners. Public testnet, mainnet, production, broadcast, transfer, credential, and exploit-optimization flows are blocked by policy. Generated reproduction files are also scanned for remote URLs, subprocess spawning, and secret/RPC environment access before execution. Executed reproductions receive a minimal workspace-local environment with local cache and temp directories, so model-generated tests do not inherit local credentials, user paths, or Node options.

Executable confirmation requires more than an exit code. The source verifier must provide `executableSuccessPatterns`, and the local command output must match those verifier-owned literal substrings. ReproductionAgent-only `successPatterns` are useful plan hints, but they cannot upgrade a finding to `confirmed-executable` by themselves. A command that exits with the expected status but provides no verifier-owned confirmation signal remains `needs-work`.

## Default Hunting Profiles

Use the reusable vulnerability-hunting profile when you want a live model-backed run with the project-learning, dynamic-lens, portfolio-enumeration, and multi-round behavior already enabled:

```bash
fsa run \
  --config ./configs/vulnerability-hunt.default.json \
  --target target-audit \
  --source <source-paths...> \
  --corpus <reference-paths...> \
  --provider openai \
  --model gpt-5.5
```

For zero-knowledge or constraint-system targets, start from the ZK profile:

```bash
fsa run \
  --config ./configs/zk-constraint-hunt.default.json \
  --target zk-target-audit \
  --source <source-paths...> \
  --corpus <specs-books-papers-and-design-notes...> \
  --provider openai \
  --model gpt-5.5
```

For Solidity and EVM smart-contract targets, start from the contract profile:

```bash
fsa run \
  --config ./configs/solidity-contract-hunt.default.json \
  --target contract-audit \
  --source <contract-source-paths...> \
  --corpus <specs-docs-and-prior-audit-material...> \
  --provider openai \
  --model gpt-5.5
```

See [docs/SOLIDITY.md](docs/SOLIDITY.md) for the Solidity-specific lens packs, provenance extraction, recommended inputs, and local reproduction workflow.

For Cairo and Starknet targets, including Starknet OS and StarkGate-style bridge code, start from the Cairo/Starknet profile:

```bash
fsa run \
  --config ./configs/cairo-starknet-hunt.default.json \
  --target starknet-target-audit \
  --source <cairo-and-contract-source-paths...> \
  --corpus <specs-docs-and-prior-audit-material...> \
  --provider openai \
  --model gpt-5.5
```

See [docs/STARKNET.md](docs/STARKNET.md) for the Cairo/Starknet-specific lens packs, provenance extraction, recommended inputs, and local reproduction workflow.

These profiles are live-audit templates, not dry-run templates. They keep deterministic local checklist seeders disabled, enable source-backed portfolio enumeration, use `hybrid` breadth/depth exploration, reserve budget for later rounds, run multiple audit trials per item, force high-impact findings through follow-up beyond the normal topK queue, and keep PoC reproduction off by default. They intentionally leave `sourcePaths`, `corpusPaths`, and `qmdCollections` empty so public package artifacts do not contain local paths or private collection names.

Use `source-index+qmd` only with a QMD collection scoped to the target material when possible:

```bash
fsa run \
  --config ./configs/zk-constraint-hunt.default.json \
  --source <source-paths...> \
  --corpus <reference-paths...> \
  --qmd-collection target-code
```

## Context Retrieval

Audit trials need bounded source context. The default retriever is deterministic `source-index`: it includes explicit `file:line` ranges, nearby functions, same-file constraint setup, referenced helper definitions from direct context, and lexical term matches. This retrieval layer is not a bug detector; it only decides which code the model receives.

For larger repositories, enable QMD as an optional semantic supplement:

```bash
fsa run \
  --config ./audit-config.json \
  --retrieval source-index+qmd \
  --qmd-command qmd \
  --qmd-limit 6 \
  --qmd-min-score 0.25 \
  --qmd-timeout-ms 60000 \
  --qmd-collection target-code
```

QMD must already be installed and indexed for the target material. Use `--qmd-collection` to constrain retrieval to the target repository or corpus collection; scoped retrieval is faster and gives cleaner recall than searching every local QMD collection. If QMD is unavailable or times out, the run records `qmd_unavailable` and continues with deterministic source-index retrieval. QMD results are mapped back to the already ingested source files before they enter prompts, so run artifacts keep repository-relative paths instead of local absolute paths.

Good recall quality is enforced through three mechanisms:

- deterministic source navigation is tested with fixtures for multi-file locations, semicolon-separated locations, and delegated helper calls;
- each run emits enumeration and audit context retrieval traces so missed definitions are visible and reproducible;
- proof obligations and provenance facts are extracted before enumeration, then used to prioritize source slices that might otherwise be truncated by a large repository overview;
- optional QMD retrieval is collection-scoped, score-filtered, traced, and treated as a supplement to structural retrieval, not a replacement for it.

`proof_obligations.json` records spec, source, initialization-learning, and provenance-derived properties that should be turned into source-backed audit items when relevant. `halo2_provenance_graph.json` records Halo2 advice/copy/equality/gate facts when the source uses that API. `solidity_provenance_graph.json` records EVM facts such as external functions, external calls, delegatecall, state writes, authorization guards, signatures, oracle reads, upgrade hooks, token transfers, and unchecked arithmetic. `zk-proof-orchestration_provenance_graph.json` records Rust/Go zkVM/prover-coordinator facts around witness sources, task statements, public-input metadata, recursive aggregation, and submit-proof verifier boundaries. `cairo-starknet_provenance_graph.json` records Cairo/Starknet facts around entrypoints, syscalls, storage access, L1/L2 messages, class-hash binding, resource accounting, block context, and OS output commitments. These artifacts are context-routing inputs only. They do not produce findings and should not be treated as static vulnerability rules.

## Continuing A Run

Every completed run updates `runs/.fsa-last-run.json` with the previous run directory name only. The pointer avoids absolute local paths.

Append one more exploration round to the latest run under `--out`:

```bash
fsa run --config ./audit-config.json --resume-last --rounds 1
```

In normal mode, `--rounds 2` means run rounds 1 and 2 in a new run. With `--resume-last` or `--resume-run <dir>`, `--rounds 2` means append two additional rounds after the completed rounds already stored in that run directory.

Resume an explicit run directory when needed:

```bash
fsa run --config ./audit-config.json --resume-run runs/protocol-audit-20260605T161105Z --rounds 1
```

Resume mode reuses prior `checklist.json`, `audit_results.json`, `lens_packs.json`, and `project_learning.json`, then writes cumulative `summary.json`, `audit_results.json`, and coverage artifacts. Per-round artifacts such as `round_1_audit_results.json` remain in place, and newly appended rounds write `round_<n>_*` artifacts. If a run stops after writing per-round artifacts but before the final cumulative files, resume mode recovers from the completed `round_<n>_audit_results.json` files. If a run contains model errors, parse errors, or explicit needs-more-context trials, resume discards that round and later results, then re-audits the whole affected round so later deepening does not inherit stale partial evidence. If deepening items were already produced for the next incomplete round, resume audits those pending items instead of regenerating them.

## Project Audit History And Materials

Every completed run updates a project-level history manifest in `<out>/history/<target>/manifest.json`. Use `--history-dir <dir>` to store the history somewhere else, for example in a private ignored workspace. The manifest keeps a project-scoped list of runs, source-confirmed findings, aggregate coverage, severity counts, source files, failure modes, and a material index.

Each project also gets `materials/index.json`. This index points to reusable project material such as `project_learning.json`, `lens_packs.json`, `source_index.json`, `proof_obligations.json`, context retrieval traces, checklists, audit results, verifications, reproduction outputs, reports, event logs, and model-call traces. The material paths are relative to the project history directory. Configured source and corpus paths are sanitized before they are written.

To continue from the latest run saved for a project:

```bash
fsa run \
  --config ./audit-config.json \
  --continue-project protocol-audit \
  --rounds 1
```

To import an older run snapshot into project history:

```bash
fsa history import-run \
  --target protocol-audit \
  --run runs/protocol-audit-20260605T161105Z
```

Importing a run copies that run directory into `<history-dir>/<target>/runs/<run-id>/`, then rebuilds the manifest and materials index from the copied snapshot. This makes future rounds and broader audits able to reuse the prior checklist, model learning, dynamic lenses, context traces, verification notes, and reports without relying on a global last-run pointer.

## Exploration Strategy

Later rounds can use one of three strategies:

- `breadth`: spend follow-up budget on new modules, trust boundaries, invariants, and unexamined data-flow edges.
- `depth`: spend follow-up budget around the strongest candidates and skeptical observations, producing source-backed checks that can confirm, refute, or narrow those hypotheses.
- `hybrid`: the default. Split the budget into breadth and depth planner branches, then deduplicate and audit the combined items.

Default `hybrid` is the safest general-purpose policy for unknown projects: it keeps coverage expanding while forcing promising candidates to receive proof-oriented follow-up. When prior findings exist, roughly half the new-item budget goes to depth. When no findings exist, most budget stays on breadth while reserving a smaller slice for near-miss analysis.

Near-miss analysis is not a vulnerability rule. It selects prior no-findings that proved a local invariant, selector edge, caller/callee boundary, or adjacent flow, then asks the planner to inspect the next source-backed edge rather than repeating the same item.

## Project-Specific Lens Packs

Generic built-in agents are the default baseline. For a real project, add project context and custom lens packs through a JSON config file:

```json
{
  "targetName": "example-service",
  "sourcePaths": ["./src"],
  "corpusPaths": ["./docs"],
  "scopeMode": "augment",
  "baselineExplorationShare": 0.25,
  "projectContext": {
    "criticalAssets": ["tenant-owned records", "billing state"],
    "attackerCapabilities": ["authenticated low-privilege user", "malicious webhook sender"],
    "trustBoundaries": ["HTTP request to database object ownership"],
    "securityInvariants": ["users can access only objects in their tenant"],
    "focusAreas": ["authorization", "webhook processing", "billing state transitions"]
  },
  "lensPacks": [
    {
      "id": "tenant-isolation",
      "displayName": "Tenant Isolation",
      "failureModes": ["cross_tenant_object_access", "access_control"],
      "auditorAgents": [
        {
          "failureMode": "cross_tenant_object_access",
          "id": "tenant-object-auditor",
          "displayName": "Tenant Object Auditor",
          "guidance": "Trace tenant identity, object id, authorization checks, and query predicates together."
        }
      ],
      "enumerationGuidance": ["Find routes and jobs that load objects by id."],
      "auditGuidance": ["Confirm tenant ownership is enforced in the same query or transaction."]
    }
  ]
}
```

Run it with:

```bash
fsa run --config ./audit-config.json --provider openai --model gpt-5.5 --thinking xhigh
```

In the default `augment` mode, these lens packs are advisory. They influence reconnaissance, enumeration, routing, and audit guidance, while the baseline pass keeps budget for risks outside the supplied lens set. Switch to `restrict` only when the configured scope is a hard engagement boundary.

Live runs also enable dynamic lens discovery by default. The model reads the project profile and loaded context, writes `lens_packs.json`, and uses those lens packs during enumeration and audit. Disable that stage with `--no-dynamic-lenses` when you want only configured lenses.

Live runs also enable project learning by default. The model reads the loaded source and corpus before lens discovery, writes `project_learning.json`, and uses those notes as the audit-trail record of what it learned from the target material. Disable that stage with `--no-project-learning` only for ablation tests.

## Public Release Check

```bash
npm run check:public
```

This scans the public source surface for local absolute paths and high-confidence secret patterns. It is also part of `npm run verify`.

## Local Seeder Regression Check

```bash
npm run check:blind-discovery
```

This legacy-named command runs a dry-run audit against a neutral fixture and asserts that optional local seeders still produce bounded checklist coverage. It is a seeder regression gate, not proof of model reasoning or autonomous discovery.

To run a live model-only discovery assertion against an external source tree without committing that source:

```bash
npm run check:source-discovery -- \
  --source <path> \
  --corpus <reference-paths...> \
  --provider openai \
  --model gpt-5.5 \
  --thinking xhigh \
  --trials 4 \
  --expect-location-file-regex '<file-regex>' \
  --expect-location-line <line> \
  --max-items 25
```

You can also reuse an audit config file so the check runs with the same source paths, reference corpus, portfolio enumeration, retrieval mode, model, rounds, and project context as a normal audit:

```bash
npm run check:source-discovery -- \
  --config ./audit-config.json \
  --expect-location-file-regex '<file-regex>' \
  --expect-location-line <line> \
  --expect-evidence-regex '<evidence-regex>'
```

`check:source-discovery` is intentionally not part of default CI because it requires provider credentials and live model calls. It fails unless initialization learning, enumeration, and audit model calls are recorded and a model-produced finding generates a disclosure report.

For stronger source-discovery runs, this gate disables local checklist seeders by default. The model must first learn from the provided source and corpus, enumerate the matching audit item, then audit it. Use `--allow-local-seeders` only for debugging checklist coverage.

Add `--rounds <n>` to test iterative deepening. Round 2 and later write `round_<n>_deepening_items.json`; the gate can then prove that follow-up coverage came from model reasoning rather than local checklist seeders.

Use `--run-dir <path>` to re-check an existing live run artifact without spending another model run. Location checks understand line ranges such as `file.rs:269-372`, so an expected line can match a wider model-produced location.

## Pi Package Usage

Try the package locally from this directory:

```bash
pi -e .
```

The extension registers `fsa_run_audit`. It defaults to `dryRun: true`, so the first call only uses local checklist seeders. It also accepts `projectContext`, `lensPacks`, `projectLearning`, `dynamicLensDiscovery`, `localChecklistSeeders`, `rounds`, `explorationStrategy`, `maxNewItemsPerRound`, `maxAuditItems`, `historyDir`, `continueProject`, `resumeRunDir`, and `resumeLast` parameters for project-specific audits. The extension blocks bash commands that combine public live networks with exploit/broadcast-style operations.

## Outputs

Each run writes:

- `checklist.json`: enumerated audit items.
- `project_profile.json`: deterministic project profile.
- `project_learning.json`: model-written initialization notes derived from loaded source, corpus, and configured high-level scope.
- `proof_obligations.json`: source/spec/learning/provenance properties used to guide checklist enumeration.
- `<domain>_provenance_graph.json`: machine-extracted provenance facts for supported adapters, such as Halo2 advice/copy/equality/gate structure.
- `round_<n>_enumeration_context_retrieval.json`: source slices placed into enumeration before the broad source overview.
- `lens_packs.json`: configured plus model-generated audit lens packs.
- `round_<n>_deepening_items.json`: model-generated novel follow-up items for round 2 and later.
- `round_<n>_audit_results.json`: audit results for one exploration round.
- `audit_results.json`: per-item, per-trial findings.
- `summary.json`: ranked finding summary and coverage.
- `verifications.json`: independent local-only verification notes.
- `reproductions.json`: optional local-only reproduction plans and command results when `--repro plan` or `--repro execute` is enabled.
- `reproduction/<finding-id>/workspace`: optional copied workspace used only for executable reproduction.
- `report_<id>.md`: private disclosure drafts for top findings.
- `events.jsonl` and `calls/*.json`: audit trail for coverage analysis.
- `<out>/history/<target>/manifest.json` and `materials/index.json`: project-level audit history and reusable material index.

## Library API

The package exports the core pipeline and extension points:

```ts
import { defaultConfig, runPipeline, MockAuditLlmClient } from "full-stack-auditor";

const cfg = defaultConfig();
cfg.targetName = "example";
cfg.sourcePaths = ["./fixtures"];

const result = await runPipeline(cfg, { llm: new MockAuditLlmClient() });
console.log(result.runDir);
```

Use `full-stack-auditor/pi/extension` for the pi package extension entrypoint.

## Extending Audit Agents

Custom audit agents can be added through `AuditorConfig.auditorAgents`. Their `failureMode` values are automatically merged into the enumeration prompt and used by the audit runner when matching checklist items:

```ts
const cfg = defaultConfig();
cfg.auditorAgents = [
  {
    failureMode: "custom_constraint_system",
    id: "custom-constraint-system-auditor",
    displayName: "Custom Constraint System Auditor",
    guidance: "Trace assigned values to enforced equations in the target DSL.",
  },
];
```

The built-in agents remain the default registry, so custom agents can be added incrementally.

## White-Hat Rules

- Audit only authorized code or public bug-bounty scope.
- Verification must be local only: unit tests, regtest, devnet, or forked node.
- Never broadcast or execute against public testnet/mainnet.
- Build the smallest reproduction needed to prove the invariant break.
- Report privately and coordinate disclosure.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
