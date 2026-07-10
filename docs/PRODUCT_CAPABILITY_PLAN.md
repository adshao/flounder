# Product Capability Expansion Plan

This document is the product and engineering plan for the capability-expansion
layer. The durable evaluation foundation described below is now implemented;
later concrete features remain explicitly tracked here rather than being
silently presented as shipped.

The design goal is balanced abstraction. Flounder should abstract repeated
shapes such as batch work, benchmark cases, evidence gates, and replayable
outputs. It should not wrap every concrete capability in a generic adapter just
because it might vary someday.

## Implementation Status

Implemented foundation:

- SQLite-backed run groups and independently resumable work items;
- bounded scheduling through the existing daemon job queue, including
  pause/resume/cancel, attempt history, terminal reconciliation, and restart
  recovery;
- schema-validated target bundles, blind/informed material policy, evidence
  contracts, and capability-surface context;
- `audit-target`, `verify-claim`, `benchmark-case`, and `regression-replay`
  work items mapped onto the existing sealed `run` / `audit --verify` kernel;
- CLI and self-describing API control plus reports regenerated from persisted
  results without rerunning model work;
- an Evaluations dashboard with run-group search and filtering, group creation,
  validated work-item entry, start/pause/cancel/retry controls, evidence-aware
  scoring, attempt history, and persisted Markdown reports;
- strict separation of lifecycle, security outcome, and benchmark acceptance;
  infrastructure failure is `blocked`, never a negative security result;
- immutable per-dispatch attempt evidence plus blocked-only retry, healthy-run
  scoring, required-refutation completeness checks, and fail-closed corpus
  decisions;
- verifier-grounded harness experiments that cluster baseline misses, control
  failures, blocked execution, and policy-invalid work by terminal cause;
- bounded candidate proposals limited to approved prompt, skill, and agent
  harness files, with passing baseline behavior recorded as a preservation set;
- paired baseline/candidate scoring with stable work-item and contract identity,
  repeated positive/control minimums, zero-regression checks, blocked/duration/
  attempt budgets, and deterministic `promote | reject | needs-more-samples`
  decisions;
- API, CLI, and an Evaluations/Harness UI for proposal refinement, candidate
  attachment, score comparison, and public-safe candidate-brief export.
- material-versioned scope and memory state, independent Map ensembles,
  per-scope obligation/composition outcomes, adaptive Dig sampling, and
  outcome-driven cross-scope synthesis;
- isolated Evaluation attempt state with shared dependency caches only;
- phase-attributed Harness evidence with distinct-case/family and hidden-holdout
  promotion gates;
- execution-grounded finding consolidation reflected into one canonical product
  lifecycle item without overriding explicit operator tracking choices.

Still planned:

- model-generated capability-surface preparation (the current foundation
  accepts an explicit validated surface in a target bundle);
- source-control history context and evidence-package export;
- suite-specific benchmark translators where the generic manifest is
  insufficient.

The evaluator, material policy, sandbox, command safety, confirmation gate, and
promotion decision remain outside the harness self-improvement loop. Candidate
briefs may be implemented on normal reviewable branches or draft pull requests,
but Flounder never merges or deploys them automatically.

## Principles

- Keep `flounder run` as the default audit path: prepare -> map -> dig ->
  synthesize -> verify -> confirm -> report.
- Keep the audit strategy model-owned. The framework supplies affordances and
  guarantees, not bug-class playbooks, target-specific schedules, or conclusions.
- Abstract only when the same mechanism clearly serves multiple current use
  cases.
- Prefer a direct feature when the domain is narrow, stable, and has one natural
  implementation.
- Separate lifecycle state from security outcome. "Running" and "reproduced"
  are different axes.
- Treat every claim as untrusted until it clears an evidence gate. Textual
  similarity, model assertion, benchmark prose, or history context never
  confirms a bug.
- Preserve blind/informed boundaries through explicit material policy, not
  best-effort prompt wording.
- Make outputs replayable, resumable, and public-surface safe by default.

## Abstraction Bar

Before adding a new abstraction, it must pass this bar:

- It has at least two concrete near-term users.
- The shared contract is small and stable.
- It removes duplication from the control plane, store, evidence gate, or
  reporting path.
- It does not hide important product semantics behind arbitrary JSON.
- It does not let any manifest producer or preparation feature bypass the
  normal confirmation, refutation, or safety policy.

If a capability has only one obvious implementation, build it directly and keep
the interface boring. Git history support is the example: there is one natural
source-control history domain, so it should be a concrete history context tool,
not a plugin point.

## Non-Goals

- Do not add first-class product logic for a single benchmark suite.
- Do not add a default vulnerability taxonomy or hardcoded target playbook.
- Do not add target-type branches that bypass the normal evidence gate.
- Do not infer intent, malicious purpose, or author motive from history context.
- Do not publish raw run artifacts, private corpus material, local paths, or
  secrets.

## Existing Foundations To Reuse

- `run --source` and project `run` already provide map -> dig coverage.
- `audit --verify` already has the right shape for one claim: reproduce or
  refute by local execution, then stop.
- `confirm` already handles finding-grained real-target reproduction and
  submit/no-submit decision sheets.
- The daemon job queue already separates control-plane state from model work.
- The tracking store already records projects, runs, scopes, findings, confirm
  decisions, and operator tracking.
- Prompt-regression fixtures already provide part of the replayable fixture
  foundation.

## Map Effectiveness Post-Mortem

Recent contest campaigns exposed that simply increasing the number of mapped
scopes is not enough. A better map does not mean a larger inventory with the
same shape; it means the next inventory explains what is newly covered, why it
is not a duplicate of prior coverage, and which uncovered trust boundaries it
expects dig to test.

The product should improve map through affordances and feedback loops, not by
injecting a framework-owned vulnerability strategy.

### What Worked

- Short map -> dig -> verify -> report loops keep confirmed bugs moving toward
  submission instead of waiting for all scopes to finish.
- Append-map is better than remap for live campaigns because it preserves
  audited scope state and prior findings.
- Prior scopes are useful as a covered-reference set. They help the agent avoid
  re-enumerating the same functions under slightly different names.
- Scope-level status and duplicate finding tracking are necessary for judging
  whether more mapping is producing new surface or just repeating old work.

### What Failed

- Large one-shot maps plateaued around similar inventory sizes and often
  rediscovered the same regions.
- Remapping could hide older submitted or reviewed findings from the operator's
  current view, which made duplicate filtering harder.
- The UI showed counts but not enough yield information: recent audited scopes,
  newly confirmed findings, duplicate rate, report backlog, and pending coverage
  deltas were not visible together.
- Expanding after exhaustion lacked an explicit objective. The agent could see
  prior scopes, but the product did not make the coverage gap a first-class
  input.

### Better Map Product Contract

Append-map should give the model these neutral inputs:

- the current scope inventory as a covered-reference set;
- audited, pending, deferred, and duplicate-linked scope summaries;
- recent findings grouped by root-cause key, not raw repeated titles;
- source regions with no scope coverage yet;
- high-change or high-authority source regions from optional history context;
- resource requests and follow-up scopes that previous digs emitted;
- a strict instruction to append only novel scopes or explain why no useful
  expansion remains.

The model still owns strategy selection. The framework only supplies evidence
about what is already covered and records whether expansion produced novel
coverage.

### Map Quality Signals

The project view and run summary should show:

- newly appended scopes per map expansion;
- percent of appended scopes later audited;
- locally confirmed findings per recent audited scope window;
- duplicates or ignored findings produced from the new map window;
- scopes that produced resource requests instead of findings;
- whether append-map returned no novel scopes.

These signals support a stop decision without hardcoding a universal stop rule.
For contest mode, the first implementation can surface warnings such as:
"review window elapsed", "inventory exhausted", or "recent batches produced no
locally confirmed findings". A later implementation can turn those warnings
into configurable automation gates.

### Implementation Steps

1. Store append-map runs as expansion windows with `fromScopeCount`,
   `toScopeCount`, and `novelScopeCount`.
2. Pass prior inventory to map as covered-reference material, separated from
   source/corpus material so it cannot become a finding by itself.
3. Add a coverage-gap artifact that lists source regions with no current scope.
4. Add UI yield cards for recent scope windows: audited scopes, confirmed
   findings, duplicate-linked findings, ignored findings, and report backlog.
5. Add a map expansion result state: `expanded`, `no-novel-coverage`, or
   `blocked`.
6. Use those states in contest mode to recommend continue, review, or pause.

## Target Architecture

The expansion adds one generic orchestration layer above the existing audit
kernel, plus a small number of concrete features that plug into it.

```text
Operator / API / UI
        |
        v
Run Group
        |
        v
Work Items -----> Target Bundle -----> Material Policy
        |                 |                  |
        |                 v                  v
        |          Existing audit / verify / confirm kernel
        |                 |
        v                 v
Evidence Gate -----> Outcome Store -----> Reports / Evidence Exports

Concrete producers of work items:
  - benchmark manifest translator
  - multi-target audit manifest
  - capability surface preparation
  - regression replay list

Concrete optional context:
  - source-control history context
```

The audit kernel remains narrow: source/corpus loading, sandboxed tools,
provider session, command policy, durable logs, confirmation, refutation,
appeal, confirm, and reporting. New modes compose the kernel rather than fork
it.

## Core Abstraction 1: Run Group

A run group is a durable container for multiple related work items. It covers
batch audits, benchmark evaluations, multi-module campaigns, repeated samples,
and regression replay.

This is worth abstracting because those workflows share the same operational
needs: queueing, concurrency, retry, progress, reporting, budget, and resume.

### Data

- `uuid`
- `name`
- `kind`: display/category label, not a dispatch mechanism
- `state`: `draft | queued | running | paused | finished | failed | cancelled`
- `config_json`
- `budget_json`
- `summary_json`
- timestamps

### API

```text
POST /api/run-groups
GET  /api/run-groups
GET  /api/run-groups/:uuid
POST /api/run-groups/:uuid/items
POST /api/run-groups/:uuid/start
POST /api/run-groups/:uuid/pause
POST /api/run-groups/:uuid/cancel
GET  /api/run-groups/:uuid/report
GET  /api/work-items/:id
POST /api/work-items/:id/retry
```

### CLI

```bash
flounder group create --name <name> --manifest <file>
flounder group start <uuid-or-name> [--parallel <n>]
flounder group status <uuid-or-name>
flounder group pause|cancel <uuid-or-name>
flounder group retry <work-item-id>
flounder group report <uuid-or-name>
```

Product-specific aliases may be added later, but aliases must call the same
run-group implementation.

### Acceptance Criteria

- A run group can contain benchmark, audit, and replay items without schema
  changes.
- State survives server restart.
- A group report can be regenerated without re-running model work.
- The scheduler never runs model work in the control-plane process.

## Core Abstraction 2: Work Item

A work item is one independently resumable unit of model or verification work.
It is the common representation for a benchmark case, module audit, selected
scope, claim verification, or regression replay.

This is worth abstracting because all of those need the same state machine and
evidence accounting, even though their inputs differ.

### Data

- `uuid`
- `run_group_id`
- `item_key`: stable producer-provided id
- `kind`: `audit-target | verify-claim | benchmark-case | regression-replay |
  custom`
- `state`: `queued | claimed | running | finished | failed | cancelled`
- `outcome`: `null | reproduced | confirmed | not_reproduced | refuted |
  blocked | invalid | no_findings | findings_reported`
- `target_bundle_json`
- `material_policy_json`
- `evidence_contract_json`
- `result_json`
- `project_id`, `run_id`, and `job_id` when linked to existing records
- `attempts`
- `last_error`

`state` is lifecycle. `outcome` is security or scoring result. Core scheduling
must only depend on `state`; reports may interpret `outcome`.

### Execution

Each item resolves to one existing kernel action:

- audit a target bundle
- verify one claim
- confirm one or more findings
- replay a stored evidence package
- run a local oracle through the sandbox

The first implementation should support only the smallest complete set:

- verify-like reproduction items
- audit-target items
- benchmark-case items
- regression-replay items

### Acceptance Criteria

- A failed build becomes `outcome=blocked`, not `not_reproduced`.
- A policy-disallowed command becomes `outcome=invalid` or `blocked`, not a
  negative security result.
- Retrying a work item appends attempts without losing previous evidence.

## Core Abstraction 3: Target Bundle

A target bundle is the normalized input to the audit kernel.

This should stay concrete and small. It is not a plugin system; it is a typed
wrapper around the source/build/corpus/sandbox inputs Flounder already uses.

```json
{
  "sourcePaths": [],
  "buildRoot": ".",
  "corpusPaths": [],
  "clue": null,
  "sandbox": {
    "backend": "auto",
    "image": "flounder-sandbox:latest",
    "memoryMb": null,
    "cpus": null
  },
  "metadata": {
    "languageHints": [],
    "repository": null,
    "revision": null
  }
}
```

### Acceptance Criteria

- A target bundle can be serialized into a run artifact.
- Local absolute paths are redacted in public-facing exports.
- The same bundle can be used by audit, verify, confirm, and replay flows when
  applicable.

## Core Abstraction 4: Material Policy

Material policy controls which non-source material is visible to the model and
why. It replaces ad hoc "safe spec" versus "answer-bearing disclosure"
decisions.

This is worth abstracting because blind audits, informed incident reviews,
benchmark runs, and public regression fixtures all need the same contamination
boundary.

### Artifact

Write `material_manifest.json`:

```json
{
  "posture": "blind|informed|open-world|private",
  "materials": [
    {
      "path": "corpus/spec.md",
      "provenance": "official-docs",
      "operatorLabel": "design-intent",
      "policyDecision": "included|excluded|warning",
      "reason": "short evidence-backed reason"
    }
  ]
}
```

### Rules

- The operator or manifest producer provides labels and provenance.
- Automatic classification may warn, but it must not be the sole authority.
- Blind mode rejects inclusion of material labeled as disclosure, incident
  detail, exploit recipe, benchmark answer, issue discussion, or unknown
  high-risk material. Use an explicitly recorded informed posture instead of
  silently overriding blind mode.
- Informed mode may include richer material, but the run metadata must say so.

### Acceptance Criteria

- A blind run records excluded material before the model sees it.
- A warning does not silently become an inclusion or exclusion.
- Reports and confirm provenance can cite the material posture.

## Core Abstraction 5: Evidence Gate

An evidence gate describes what counts as success for a work item.

This is worth abstracting because benchmark scoring, claim verification,
regression replay, and real-target confirmation all need a uniform way to say
"this result is accepted by executable evidence".

```json
{
  "kind": "confirmation-command|benchmark-oracle|replay-package|manual-review",
  "command": null,
  "successPatterns": [],
  "failurePatterns": [],
  "requiresDifferential": false,
  "requiresRefutation": true,
  "networkPolicy": "sealed|open-world-read|local-only"
}
```

### Rules

- `manual-review` may create a human gate, but not a confirmed bug.
- `benchmark-oracle` may score a case, but it does not automatically create a
  product finding unless mapped through the normal finding schema.
- `confirmation-command` must use the existing confirm-command policy.
- `open-world-read` never allows live writes, broadcast, value movement,
  credential harvesting, or persistence.

### Acceptance Criteria

- A work item cannot mark itself reproduced without a satisfied evidence gate.
- A blocked evidence gate is surfaced as actionable setup work.
- The report shows which gate accepted the outcome.

## Concrete Feature: Benchmark Manifest Translator

Benchmark-style tasks need abstraction because there are many suites and each
uses a different manifest, oracle, or expected output. The product should expose
one generic benchmark manifest translator first, then add suite-specific
translators only when an external format cannot map cleanly into the generic
manifest.

### Mapping

- one external case -> one work item
- case source -> target bundle
- case prompt/description -> material governed by material policy
- case oracle -> evidence gate
- case result -> work item outcome

### CLI

Use run groups, not a separate eval state machine:

```bash
flounder group create --name <name> --manifest <benchmark-manifest.json>
flounder group start <name> --parallel <n>
flounder group report <name>
```

A future benchmark-oriented command may be added as a thin alias, but it should
not create a separate storage or scheduler path.

### Acceptance Criteria

- A local benchmark manifest with positive, negative, and blocked cases can run
  to completion.
- Scoring is regenerated from persisted work-item outcomes.
- A suite-specific translator can be added without changing the audit kernel.

## Concrete Feature: Multi-Target Run Groups

Multi-target auditing does not need its own abstraction. It is a run group whose
items are `audit-target` work items.

### Manifest

```json
{
  "kind": "multi-target-audit",
  "items": [
    {
      "key": "module-a",
      "targetBundle": {
        "sourcePaths": ["contracts/module-a"],
        "buildRoot": ".",
        "corpusPaths": ["docs"]
      }
    }
  ]
}
```

### Acceptance Criteria

- A multi-target manifest creates one work item per target bundle.
- Each item dispatches through the existing run/audit kernel.
- Group reporting aggregates setup blockers, findings, cost, and duration.

## Concrete Feature: Capability Surface Preparation

Some targets are not just source trees; they are capability surfaces. Examples
include skills, plugins, MCP servers, CI workflows, browser automation wrappers,
and tool manifests.

This is worth modeling, but it should be one concrete preparation feature, not a
family of target-specific product branches.

### Artifact

Write `capability_surface.json`:

```json
{
  "entrypoints": [],
  "inputs": [],
  "effects": [],
  "authorities": [],
  "boundaries": [],
  "localFixtures": []
}
```

Where:

- `entrypoints` are ways the capability is invoked.
- `inputs` are data sources controlled by users, remote services, repositories,
  documents, webpages, messages, or tool responses.
- `effects` are shell commands, file writes, network calls, browser actions,
  issue/PR changes, email sends, deployment actions, or secret reads.
- `authorities` are credentials, filesystem permissions, network scopes,
  repository permissions, or tool grants.
- `boundaries` are intended bindings between inputs and effects.
- `localFixtures` are deterministic fake inputs/services for confirmation.

### CLI

Use a direct prepare flag:

```bash
flounder prepare --capability-surface --source ./target
flounder run --capability-surface --source ./target
```

This is intentionally not a generic `--adapter` interface in the first
implementation.

### Confirmation Standard

The model may attempt to prove a gap where untrusted input reaches a privileged
effect without the required binding, authorization, or sanitization. Specific
bug classes belong in fixtures and reports, not in default product logic.

### Acceptance Criteria

- The preparation step can produce a capability surface from a simple local
  target.
- A safe fixture produces no confirmed finding.
- An unsafe fixture can be confirmed using only local fake inputs and local
  effects.
- No live account, browser profile, email inbox, repository token, or production
  service is required for confirmation.

## Concrete Feature: Source-Control History Context

History support should be direct, not over-abstracted. There is one natural
domain here: source-control history for the target repository.

History is optional context for map/dig and follow-up scope generation. It is
not a finding source.

### Artifact

Write `history_context.json`:

```json
{
  "facts": [
    {
      "kind": "guard_changed|test_changed|api_changed|dependency_changed|region_changed",
      "region": "file:lines",
      "commits": [],
      "evidence": "neutral summary",
      "followupScope": {}
    }
  ]
}
```

### Rules

- The framework records neutral facts: changed region, changed guard, changed
  test, changed API, changed dependency, or changed dataflow edge.
- The framework does not label a change suspicious.
- The framework does not infer motive or malicious purpose.
- History facts may create or prioritize follow-up scopes.
- No history-only fact is a confirmed finding.

### Acceptance Criteria

- A synthetic repository with a removed guard produces a neutral history fact
  and a follow-up scope.
- A synthetic repository with a safe refactor does not produce a confirmed
  finding.
- Author identity is excluded from public exports unless explicitly required
  and safe.

## Concrete Feature: Evidence Package Exporter

The exporter turns private evidence into controlled outputs. This can be direct
because the export profiles are product policy, not extension points.

### Export Profiles

- `private-replay`: keeps local paths private and replays within the same
  workspace.
- `public-regression`: sanitized fixture suitable for the public repository.
- `benchmark-case`: case manifest plus oracle, with answer leakage checks.
- `report-attachment`: disclosure-safe evidence package.

### Rules

- Exports must reject secrets, local absolute paths, private URLs, raw run
  directories, private corpus material, and answer-bearing names when the target
  profile disallows them.
- Exporting is separate from confirming. A confirmed bug is not automatically
  public-safe.
- Human review is required before adding public fixtures.

### Acceptance Criteria

- A confirmed-differential finding can produce a private replay package.
- A public-regression export fails if it contains local paths or secrets.
- A negative/control fixture can be exported alongside a positive fixture.

## Implementation Order

1. Add the run-group and work-item store schema with lifecycle/outcome
   separation.
2. Add a minimal scheduler that dispatches work items as existing daemon jobs.
3. Add target-bundle and evidence-gate schemas.
4. Add generic verify-like work items using the existing `audit --verify`
   kernel path.
5. Add run-group CLI/API/reporting.
6. Add material-manifest generation and blind/informed policy enforcement.
7. Add the benchmark manifest translator.
8. Add multi-target run-group manifests.
9. Add private evidence replay and public export checks.
10. Add capability surface preparation.
11. Add source-control history context.
12. Add UI views after the API and store model are stable. (Implemented.)

This order builds only the generic substrate needed by multiple immediate
features, then adds concrete features one at a time.

## Test Plan

### Unit Tests

- schema validation for run groups, work items, target bundles, material
  manifests, evidence gates, capability surfaces, history context, and exports
- state/outcome transition validation
- aggregation math for group reports
- public-surface redaction
- material policy inclusion/exclusion decisions

### Integration Tests

- local run group with three work items:
  - one reproduced by a passing local confirmation command
  - one blocked by setup
  - one safe/control item that must not be reproduced
- scheduler resume after server restart
- daemon job failure recorded as work-item failure without losing evidence
- report regeneration from persisted state

### Prompt and LLM Tests

- verify-like work item stops after one claim
- blind material policy prevents answer-bearing material from reaching the model
- negative/control fixture produces zero confirmed findings
- capability-surface prompts do not name specific bug classes as required checks

### Database Tests

- migration from the latest released database
- WAL/busy-timeout behavior under concurrent group reads and job writes
- old project/run/finding records remain readable

### UI Tests

- run-group list and detail views
- item and group lifecycle controls
- blocker visibility and blocked-only retry
- persisted report access
- scoring math for positive, control, blocked, and invalid cases
- no conflation of lifecycle state and security outcome

## Failure Modes To Cover

- Work item times out while the model is still active.
- Daemon disconnects after claiming an item.
- Evidence gate references a missing command id.
- Build failure is accidentally scored as not reproduced.
- Material is excluded by policy but still copied into the model workspace.
- Scheduler retries a non-retryable policy failure.
- Public export contains a local path or private corpus path.
- Benchmark translator emits malformed target bundle JSON.
- Group report is generated while items are still running.

Each failure should have either a deterministic test, explicit error handling,
or a clear user-visible blocker. Silent failure is not acceptable.

## Release Gates

Before a public release containing this work:

- `npm run verify`
- package dry run
- database upgrade smoke from the latest released database
- public-surface scan for secrets, local paths, private corpus, raw run
  artifacts, and answer-bearing benchmark material
- prompt neutrality review for all new prompts
- fixture run proving negative/control items do not produce confirmed findings
- docs review confirming audit, run-group, work-item, and evidence-gate concepts
  are not conflated

## Product Positioning

The resulting product has one kernel, one batch orchestration layer, and a few
direct capabilities:

- **Audit kernel**: one target, model-owned security reasoning,
  execution-backed findings.
- **Run group**: many work items with shared budget, concurrency, state, and
  reports.
- **Benchmark translator**: maps external benchmark formats into work items.
- **Multi-target manifests**: run many normal audits under one group.
- **Capability surface preparation**: extracts entrypoints, inputs, effects,
  authorities, and local fixtures for non-traditional targets.
- **History context**: provides neutral source-control facts and follow-up
  scopes.
- **Evidence exports**: convert private evidence into replay, public regression,
  benchmark, or report packages under explicit safety policy.

The important boundary: preparation features may create context and evidence
requirements, but they do not decide that a vulnerability exists. Only the
evidence gate can do that.
