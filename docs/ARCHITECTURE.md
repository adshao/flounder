# Architecture

## Boundary

`flounder` is centered on the thin agentic audit path. The public driver is `flounder run`: with a clue it orchestrates prepare -> sealed map/dig -> confirm -> report; with explicit `--source` it runs the sealed map/dig audit directly. The model decides the audit strategy and the framework supplies only capabilities, safety, confirmation gates, and replayable state. The open-world counterpart, **`flounder confirm`** (`src/agent/confirm.ts`), takes a finished run's findings and reproduces them against real-world ground truth with the network available (see [Open-World Confirmation](#open-world-confirmation-flounder-confirm)).

The main layers are:

- Agent loop: `src/agent/loop.ts`, `src/agent/prompts.ts`, and `src/agent/audit.ts`.
- Agent tools: `src/agent/tools.ts` for pi-style read/write/edit/bash capabilities.
- Ingestion: `src/ingest/source.ts` loads authorized source and corpus material with public-safe paths.
- Safety: `src/security/policy.ts` and `src/security/sandbox.ts` gate local command execution.
- Reporting and history: `src/reports`, `src/trace`, and `src/agent/memory.ts`.
- Provider adapters: `src/llm/pi-ai.ts`, with explicit local CLI fallbacks in `src/llm/codex-cli.ts` and `src/llm/claude-code.ts`.
- Pi integration: `src/pi/extension.ts` registers workflow tools for `prepare`, `run`, `map`, `audit`, and `confirm`, plus the shell guardrail.
- Tracking store: `src/db/store.ts` records every run's metadata to SQLite (see [Tracking, API, and UI](#tracking-api-and-ui)).
- Server / UI: `src/server/` (control-plane REST API `app.ts` + execution-plane `daemon.ts` + web dashboard).

## Product Model

Flounder is an autonomous white-hat security auditor, not a framework-specific scanner. The product boundary is the audit workflow: prepare an authorized target, map the audit surface, dig selected scopes with local proof, and confirm reproduced findings against real-world ground truth. The model owns the audit strategy; the framework owns the capabilities and guarantees that make the result usable.

The default path must stay stack-agnostic. Source code, project docs, optional profiles, and prior runs are inputs the model can inspect. They must not become framework-side bug rules, schedules, or conclusions. The framework should add only:

- affordances the model cannot provide alone: source/corpus loading, sandboxed read/write/edit/bash tools, provider sessions, daemon execution, live activity, and reports;
- guarantees the model cannot self-enforce: command safety, local isolation, path redaction, durable replay, execution confirmation, refutation, confirm provenance, and white-hat no-broadcast policy.

## Audit Flow

The diagram below is the **inner per-session loop** — one agent session. The default `flounder run` wraps it in a **map → dig** orchestration (and `flounder confirm` runs it open-world); that orchestration, plus the resumable scope inventory, is described under [Audit Modes](#audit-modes).

```mermaid
flowchart TD
  CLI["CLI: flounder run / map / audit"] --> AUDIT["runAudit"]
  PI["pi tools: flounder_run / flounder_map / flounder_audit"] --> AUDIT
  AUDIT --> INGEST["load source and corpus"]
  INGEST --> SESSION["logger, session, project memory"]
  SESSION --> TOOLS["build pi-style tools"]
  TOOLS --> PROMPT["thin kickoff prompt"]
  PROMPT --> LOOP["agent loop"]
  LOOP --> MODEL["LLM returns one JSON action or done"]
  MODEL --> PARSE{"valid action?"}
  PARSE -->|no| LOOP
  PARSE -->|yes| DISPATCH["dispatch tool"]
  DISPATCH --> READ["read"]
  DISPATCH --> WRITE["write/edit sandbox"]
  DISPATCH --> BASH["bash sandbox"]
  READ --> OBS["append observation"]
  WRITE --> OBS
  BASH --> OBS
  OBS --> WINDOW["transcript windowing"]
  WINDOW --> LOOP
  MODEL -->|done| FINDINGS["parse findings.json"]
  FINDINGS --> CONFIRM{"cites a passed confirm command_id?"}
  CONFIRM -->|yes| EXEC["finding (confirmed-executable)"]
  CONFIRM -->|no| HYP["hypothesis (unconfirmed)"]
  EXEC --> ARTIFACTS["findings + reports + history"]
  HYP --> HYPART["hypotheses artifact (no report)"]
```

The loop has one protocol: the model emits exactly one JSON tool action per turn, or a `done` object after writing `findings.json`. The framework parses it, runs the requested tool, appends the observation, and calls the model again until the agent finishes or the step budget is exhausted.

## Audit Modes

The same loop runs several postures, selected by the CLI verb (`src/cli.ts` `applyAuditPosture`). All share the tools, the confirmation gate, and the white-hat boundary; they differ only in the prompt and (for map → dig) the orchestration around the loop.

- **Breadth** (`flounder run --quick`): one agentic pass. The model decides what to read, suspect, and test. Good for triage; not the default.
- **Deep, pinned** (`flounder audit <region>`): skip enumeration and deep-audit one region the operator names, obligation by obligation ("name the enforcing line or the missing edge"; "looks standard"/"matches upstream" never clears).
- **Map → Dig** (`flounder run`, the default real audit; or `flounder map` then `flounder audit`): two phases.
  - **MAP** (`map` role): a bounded breadth pass whose only job is to enumerate a *complete* scope inventory to `scopes.json`. The model applies three general lenses — spec conditions, value/asset flow, trusted-but-unbound inputs — and scores each scope by exposure × difficulty. The framework encodes **no** domain analysis: the lenses are prompt text, the model reads the code and writes the inventory, and `readScratchScopes` only parses the JSON the model produced. Scoring is the model's; the framework's sole ranking act is `sort(by model score)` then `slice(maxScopes)`.
  - **DIG** (`dig` role): deep-audits the selected scopes one at a time via the pinned-deep posture, each pinned to a scope's obligation + region. Findings are accumulated and tagged with their `scopeId`.

**Resumable coverage.** The scope inventory persists (with per-scope status) under the project history dir (`scope-store.ts`), next to `memory.jsonl`. A map → dig run audits the highest-scored *not-yet-audited* scopes up to `--max-scopes`; the rest stay `pending` (visible, never silently dropped). Re-running `flounder run` (or `flounder audit` against the inventory) **resumes** — it skips MAP and audits the next batch — so a large inventory reaches full coverage across several budget-limited runs. `flounder map` enumerates without digging; `--remap` re-enumerates from scratch. `AuditRunResult.scopeCoverage` and a CLI hint report progress. The inventory is **checkpointed right after the MAP phase and after EACH dig** (status, plus the run dir's partial `audit_findings.json` on the sequential path), so a run KILLED mid-way also resumes — re-running skips MAP and the already-audited scopes, redoing only the one in-flight dig. This matters now that the sealed verbs default to unbounded budgets (longer runs are likelier to be interrupted). (`flounder confirm` likewise checkpoints its decision sheet to the run dir each turn, so an interrupted reproduction keeps the rows done so far.)

**Human-in-the-loop seam.** `flounder audit --scope <id[,id...]>` deep-audits exactly the named inventory scopes (re-auditing an already-audited one is allowed), ignoring score order — the operator picks from the complete map by id, reusing the obligation + region the map already wrote. This is the reliable path when the model's *ranking* under-orders a subtle-but-critical scope: enumeration is complete, so the scope is always pickable even if it ranks low.

**Per-role models.** `map`/`dig`/`refute`/`default` each resolve a provider/model/thinking via `resolveRole` (role entry → `default` → top-level config); nothing is auto-downgraded. This spends the expensive model where it matters and lets the provider be switched in one line (the driver — continuous pi session vs per-step loop — is auto-selected from the resolved provider). See `examples/models.*.json`.

## Thin-Layer Rule

A component belongs in audit mode only if it gives the model something it cannot provide for itself:

- an affordance: read source, write/edit a copied workspace, inspect with local commands, run a local test;
- a guarantee: sandbox isolation, command safety, path redaction, replayable logs, durable history, executable-confirmation gating.

A component does not belong in the default audit path if it tells the model what bug class to look for, what schedule to follow, or what conclusion to reach. If a human prior is still useful, expose it as an optional model-callable tool.

## Tool Surface

Default tools:

- `read`: read loaded source/corpus or files created in the sandbox.
- `write`: write bounded files into the copied sandbox workspace.
- `edit`: replace text in a file inside the copied sandbox workspace.
- `bash`: run one policy-gated local command in the copied workspace. `purpose=inspect` (default) is for exploration (`ls`/`find`/`rg`/`cat`/`sed`/reads) and never confirms anything; `purpose=confirm` must be a real local test/build runner (`cargo test`, `forge test`, `go test`, `node --test`, `pytest`, …) with success patterns, and only it can mint confirmation.

There are no default bug-class, dataflow, checklist, memory, or report tools. Optional priors should live as extension skills, prompt packs, corpus material, or package add-ons, not as default strategy in audit mode.

## Confirmation Boundary

The hard rule is that the model cannot confirm a bug by assertion. The problem is that the model otherwise controls all three of: the code under test, the test, and the success criterion. Three mechanisms take that control away.

**Status ladder** (`ConfirmationStatus`):

- A **hypothesis** (`suspected`) is any candidate not backed by a passing test. Recorded prominently in `audit_hypotheses.json` and counted in `summary.coverage.hypotheses`, but it is not a finding and gets no report.
- `confirmed-executable` — cited a `bash` `command_id` of a `purpose=confirm` run that passed (expected exit plus every declared success pattern).
- `confirmed-differential` — the strongest: also survived fail-after-fix (below). `confirmed-*` candidates are findings: they enter `audit_findings.json`/`summary.findings` and get a disclosure report.

**1. Confirmation requires a real test/build runner.** An inspection command (`cat`, `rg`, …) can never mint confirmation even with `purpose=confirm` and a matching success pattern — otherwise a model could forge proof by printing a success string from a file it wrote itself (`isAgentConfirmCommand` in `src/security/policy.ts`).

**2. Baseline integrity.** Right after the target source is copied, the framework records the pristine file set (`listWorkspaceFiles`, before corpus/warm-up/any model action) on the session. `write`/`edit` reject any path in that baseline — the model may only add new test files. So a test runs against code the model cannot have weakened to make its own exploit pass.

**3. Differential confirmation (fail-after-fix, `src/agent/differential.ts`).** A passing exploit test only proves the test passes. For `confirmed-differential`, a finding also supplies `fix_patch` ({path, old, new}, an edit to a *target-source* file) and `patched_success_patterns`. The framework — not the model, which cannot touch target source — applies the fix to the pristine source, re-runs the *same* cited test, then restores the source. It confirms only when the exploit reproduced on the baseline AND, after the fix, the test still compiles/runs, the blocked-exploit signal appears, and the exploit no longer reproduces. A tautological test behaves identically before and after the fix, so it cannot reach `confirmed-differential`; a fix that merely breaks the build fails the "still runs" check.

`bash` routes through `src/security/sandbox.ts` and the command-safety policy. It must stay local-only: source inspection, unit tests, fixtures, local regtest/devnet, forked local nodes, or isolated harnesses. Public network broadcast, transfer, credential use, persistence, exploit optimization, destructive commands, and paths outside the copied workspace are blocked.

The execution backend is explicit. `AuditorConfig.sandboxBackend` defaults to `auto`, which uses the OCI image `flounder-sandbox:latest` when it is available and otherwise returns a policy failure instead of silently running model-generated code on the host. The current OCI runner is Docker-backed (`docker image inspect` / `docker run`), so real execution-confirming audits need Docker, or a Docker-compatible CLI/daemon, plus a built or pulled sandbox image. `--sandbox-backend oci` requires that container path. `--sandbox-backend host --allow-host-execution` is a trusted-local escape hatch for deterministic fixtures and development smoke tests; it preserves the isolated `HOME`, `TMPDIR`, and package-cache environment, but it is not treated as kernel isolation and should not be used for untrusted targets. The OCI runner bind-mounts only the copied workspace (and the optional persistent package cache), disables image pulling at execution time, drops Linux capabilities, sets `no-new-privileges`, uses a read-only root filesystem with tmpfs temp dirs, applies pids/memory/CPU limits when configured, and uses Docker's `--network none` for sealed inspect/confirm commands.

`flounder-sandbox:latest` is a baseline toolchain image, not a universal audit environment. Specialized targets should supply a target-specific image through `--sandbox-image` or the daemon launch spec. Image construction is part of the trusted execution base: the audit model may produce a missing-tool diagnosis or a reviewable image recipe, but arbitrary `docker build` / `docker pull` is not exposed as a sandboxed audit tool. A future automated image builder should live outside the model-directed audit loop as a controlled prepare step: locked templates, pinned base images, explicit review policy, image digest recording, and no direct access to host credentials.

## Verification Environment

Confirmation is only reachable if the model's local test can compile and run, which on a real target requires the toolchain's dependencies. Two settings make a heavy compiled target workable. First, `--build-root` decouples the buildable workspace from the audit scope: the sandbox copies the build root (e.g. a Cargo workspace whose members the audited crate path-depends on) so the project compiles, while the model still reads only `--source`. Second, `src/agent/prepare.ts` warms the copied workspace once: it detects the toolchain (Cargo, Go, npm/pnpm/yarn, Foundry) and runs the project's own dependency fetch/build (`cargo fetch` + `cargo build`, `go mod download`, `npm ci`, `forge build`, …) with network allowed and a generous timeout (`AuditorConfig.auditPrepareTimeoutMs`). The warm-up uses a **persistent package cache** (`HOME` is the per-run workspace; `CARGO_HOME`/`GOMODCACHE`/npm cache live under the project history dir, shared with the model's own commands), so dependencies download once and the heavy dependency build is reused. In OCI mode, only that cache directory is mounted into the container; host credentials/config are not exposed to the executed command. It builds the lib/deps (not `--tests`) so it never fails on the model's in-progress scratch tests. Afterwards the model's `bash` build/test runs are incremental — and build/test commands (`isAgentBuildCommand`/`isAgentConfirmCommand`) get the build-grade timeout (`max(reproductionCommandTimeoutMs, auditPrepareTimeoutMs)`), not the short inspect budget, so a real `cargo test` can compile and run within budget. These commands are framework-chosen (not model input); the step is gated by `AuditorConfig.auditPrepare` (default on, `--no-prepare` to skip) and is a no-op when no manifest is present.

This path is validated end-to-end: with `--build-root` set to a Cargo workspace and a generous `--prepare-timeout-ms`, the codex provider autonomously found a real crate-internal ZK soundness bug, authored a MockProver exploit, built and ran it, and the finding reached `confirmed-differential` (the framework applied the model's fix to pristine source and re-ran to show the exploit blocked). The codex provider (via pi) is the launchable autonomous path and routes all tools through this sandbox.

Warm-up is **lazy**: the `bash` tool runs it once, on the first test/build command (`isAgentConfirmCommand`), rather than eagerly before the loop. So a read-only audit, or a run that fails authentication before it ever runs a test, pays nothing for it.

Reference-independence is why execution-grounding is the core of confirmation, not a nicety. A reference implementation, spec, book, or prior audit can carry the same bug — some bugs live in the canonical implementation itself — so "matches upstream/spec" inherits the reference's errors and cannot, in principle, catch a bug present in the reference. Only two things are trustworthy because neither depends on an external authority being correct: the security property derived from first principles, and an executable counterexample that the real artifact accepts. The audit prompts therefore forbid comparison-based clearing (a component is cleared only by naming the invariant and the constraint that enforces it, or by an executable counterexample), and differential confirmation is the framework-side instance of the second anchor.

**Independent refutation** (`src/agent/refutation.ts`, gated by `AuditorConfig.auditRefute`, default on) guards against a single reasoning chain inheriting a wrong assumption. After confirmation, a fresh-context skeptic — which never saw the finder's investigation — re-derives the invariant and tries to break each confirmed finding (show the property is enforced, or the exploit does not work), under the same no-comparison-clearing rule. A single-test `confirmed-executable` it debunks is downgraded to a hypothesis; a `confirmed-differential` it disputes is kept (execution is ground truth) but flagged `disputed` in the finding and the disclosure report for human review. Verdicts are written to `audit_refutation.json`.

Remaining hardening targets: execution-driven discovery on a buildable target (adversarial property tests reveal under-constraint empirically, independent of any reference), optional stronger isolation backends for environments that require more than Docker/OCI, and turning `confirmed-differential` findings into stored regression tests that future runs re-execute.

## Open-World Confirmation (`flounder confirm`)

`flounder confirm <run-dir> --source <paths...>` (`src/agent/confirm.ts`, `runConfirm`) is the open-world counterpart to the sealed `run`. It does not discover; it takes confirmed findings to a real-world standard of certainty and emits a submit/no-submit decision sheet. It reuses the same session driver, sandbox, and confirmation gate as `run` — the only capability difference is the network.

Confirm is **finding-grained and resumable.** The CLI form takes one run dir (all its confirmed findings); the dashboard/control-plane form works from finding **status**: `runConfirm` accepts `inputRunDirs[]` + `confirmKeys[]`, unions the confirmed findings across those run dirs (keyed by the shared content key), and keeps only the requested set — so a *project-level* confirm reproduces every still-pending finding (locating each one's source run dir via its `run_id`) and a *finding-level* confirm does just one. As each decision settles, the member findings' `confirm_status` flips (`reproduced` / `not-reproduced`); a re-run only picks up findings still NULL — that is the resume.

**Pipeline (one session):**

1. **Freeze + fingerprint.** Before any network access, `runConfirm` hashes the input run's `audit_report.md` / `audit_findings.json` / `report_*.md` (sha256 + timestamp) to `confirm_provenance.json`. This anchors the provenance claim that the findings were produced blind, independent of anything the open-world pass later reads online.
2. **Reproduce.** The frozen findings seed a single network-enabled session. The model reproduces each against real ground truth — it decides what that is for the target (a mainnet fork of the deployed contract + its real verifier, a real released package, a real local node) and writes the reproduction itself. No per-technology branches: the framework supplies capability + goals + an objective execution-grounded bar (real target, attacker-real capabilities, the effect exhibited as a concrete observable), and refuses to accept a row as `reproduced` unless it cites a passing `purpose=confirm` run that cleared that bar.
3. **Consolidate by execution** (`src/agent/consolidate.ts`). A fix-equivalence matrix cross-applies each reproduced bug's `fix_patch` to the pristine source and re-runs the others' PoCs (reusing `runDifferentialConfirmation`); two bugs are the same iff a single fix neutralizes both, in both directions. `unionFindClusters` turns the symmetric relation into clusters. Distinct bugs are decided by execution, not by similar titles — the framework's call, not the model's.
4. **Decide.** `confirm_decision.json` (one row per distinct bug: reproduced?, evidence, novelty/corroboration, `submit-candidate`/`needs-human`/`drop`), `confirm_report.md`, and `confirm_equivalence.json` (the matrix + clusters).

**Network policy.** `analyzeConfirmBashCommandSafety` (`src/security/policy.ts`) relaxes the sealed-run policy to allow fork/read/fetch/search and arbitrary programs, but keeps the white-hat line: a broadcast/submit verb (`cast send`, `forge script --broadcast`, `eth_sendRawTransaction`, …) is blocked only when its target is non-local, so replaying the exploit against a *local* fork is allowed while pushing it to a live network is not. Structural guards (plain program name, simple argv, workspace-contained paths) are unchanged. The bash tool selects this policy when `AuditorConfig.confirmMode` is set.

**Budget.** Confirm is unbounded by default: `runConfirm` sets `auditMaxSteps` to a non-finite sentinel, and the session driver treats non-finite/≤0 as "no turn cap" (the run ends when the model emits done). Reproduction is heavy and a fixed step count silently truncates productive work; `--max-steps N` caps it only when asked. The confirm prompt pushes the model to reproduce early and own its own stop rather than survey indefinitely. Confirm requires a pi-session provider; the mock/CLI fallbacks cannot fork a live network.

**Resume.** Confirm auto-resumes an interrupted prior confirm of the same input run: `loadSettledFromPriorConfirm` finds the latest prior `<target>-confirm-*` run whose frozen provenance matches this input and returns its SETTLED rows (`reproduced` yes/no). Those are injected into the seed with a "carry verbatim, do not re-reproduce" instruction, the session driver checkpoints `confirm_decision.json` to the run dir each turn (so a hard kill keeps the rows done so far), and a safety net re-adds any settled row the model dropped. So a re-run reproduces only the un-settled findings. `--fresh` ignores prior progress. (The fix-equivalence matrix only spans the current session's PoCs; carried rows pass through as singletons.)

**Epistemics.** The same execution-grounding that makes `run`'s confirmation trustworthy is transposed to the open world: execution against the real target is the only truth; a web source is a lead and a novelty disqualifier, never proof; only attacker-real capabilities count. A finding that only reproduced under a substituted trusted component, an unreachable precondition, or assumed state is recorded `not-reproduced` with the exact crutch named — this is the execution-grounded version of the `run` refutation's faithfulness check, now run against the *real* component rather than a re-mocked one.

Validated end-to-end on a prior `run`'s Aztec findings: the real `numRealTransactions` accounting bug reproduced on a mainnet fork (real proxy + real verifier, flipping one attacker-controllable byte), while the verifier-false-return and short-return-proxy findings were execution-*refuted* (the real verifier reverts; the real proxy returns well-formed data) — 13 findings consolidated to 7 distinct, 1 reproduced, zero false reproductions.

## Memory And History

Each audit writes:

- `audit_transcript.json`: action/observation replay.
- `audit_findings.json`: execution-confirmed findings only.
- `audit_hypotheses.json`: unconfirmed candidates.
- `audit_command_runs.json`: sandboxed local command records.
- `audit_prepare.json`: toolchain warm-up results (when a manifest was detected).
- `summary.json`: ranked summary (findings) with `coverage.hypotheses`.
- `report_<id>.md`: private disclosure drafts, for confirmed findings only.
- `events.jsonl` and `calls/*.json`: trace and model calls.

Each `flounder confirm` writes `confirm_provenance.json` (frozen findings' fingerprints), `confirm_decision.json` + `confirm_report.md` (the decision sheet), `confirm_equivalence.json` (the fix-equivalence matrix and clusters), and the usual `confirm_transcript.json` / `events.jsonl` / `calls/*.json` session trace.

Per-target memory lives at `<out>/history/<target>/memory.jsonl`. Audit surfaces recent memory at kickoff and automatically stores parsed findings for later runs.

Project history lives under `<out>/history/<target>/manifest.json` and records sanitized run metadata, findings, and materials. Paths must stay repository-relative or placeholder-based in public-facing artifacts.

## Drivers

Audit has two interchangeable drivers behind the same tools, sandbox, confirmation gate, and artifacts:

- Continuous session (`src/agent/pi-session.ts`, default for real runs): a pi-coding-agent `AgentSession` owns the loop. The framework registers only the sandboxed tools as the session's `customTools` (with `noTools: "builtin"`, so pi's built-in filesystem tools are disabled while the custom sandboxed tools stay available) and calls `session.prompt()` once; the session keeps context server-side and orchestrates tool calls natively. This avoids the per-step transcript resend that grows quadratically and exhausts quota. The session is bounded by a turn budget (`AuditorConfig.auditMaxSteps`): on reaching it the framework counts `turn_end` events and calls `session.abort()`, so a real run cannot grow unbounded in cost. A non-finite/≤0 budget means **no turn cap** (the run ends only when the model emits done) — `flounder confirm` uses this by default, since reproduction is heavy and a fixed step count truncates productive work. Used whenever the provider is a real pi-ai provider.
- Legacy loop (`src/agent/loop.ts`): the framework re-drives a stateless `complete()` once per step with a JSON action protocol. Used for the deterministic mock (offline tests) and the explicit CLI fallbacks.

The default audit provider profile is `openai-codex · gpt-5.5 · xhigh`. A fresh store also seeds a `claude-code · opus 4.8 max` profile as an explicit local fallback option. The continuous session requires daemon-local provider auth configured through `flounder daemon provider login openai-codex`, imported from an existing pi auth entry in `~/.pi/agent/auth.json`, or supplied through daemon environment variables where the provider supports that. It does not reuse the standalone Codex CLI's credentials, so an unauthenticated run fails fast with an actionable Flounder command (use `--mock-llm` for offline checks). Per project constraint, the session driver targets pi-mono providers such as `openai-codex`; `claude-code` is not used as a session backend (it is not permitted outside Claude apps and needs no API key here).

## Provider Behavior

`provider=codex-cli` and `provider=claude-code` are explicit local CLI fallbacks that run through the legacy loop. CLI fallbacks run non-interactively and must preserve the audit contract: in agentic mode they must not inject "do not inspect files" instructions, because the framework tools are how the model investigates.

Model and provider selection stays runtime-configured. Do not assume every model family is available through every provider. In the dashboard, a **provider profile** is a reusable model strategy: provider id, default model, default thinking level, and optional role defaults. Credentials are not stored in the server; they live on each daemon via `flounder daemon provider login <provider>`, daemon environment variables, or the daemon's local secret manager.

A project selects one execution daemon and one default provider profile. It can also set `config.phaseProviders` for `prepare`, `map`, `dig`, and `confirm` when a phase needs a different provider profile. The selected daemon must authenticate every provider profile the project can use. `launchSpec` resolves the verb's primary phase into the run's top-level provider/model/thinking and maps map/dig/refute into role overrides, so a run can use different models for acquisition, enumeration, deep audit, refutation, and real-target confirmation without changing the audit kernel.

For blind benchmarks with `provider=codex-cli`, set `FLOUNDER_CODEX_WEB_SEARCH=disabled` to prevent public-report contamination. Real audits may leave Codex web search at its runtime default or set `FLOUNDER_CODEX_WEB_SEARCH=live/cached/disabled` explicitly.

## Pi Integration

The package extension exposes the agent-session workflow tools:

- `flounder_prepare`: open-world target acquisition from a clue.
- `flounder_run`: with a clue, the full prepare -> sealed map/dig -> confirm -> report pipeline; with source paths, the sealed map/dig source audit.
- `flounder_map`: sealed scope inventory only.
- `flounder_audit`: sealed dig from inventory, pinned region audit, selected scope audit, or inline finding verification.
- `flounder_confirm`: open-world reproduction pass over finished run findings.

The project-scoped report command is intentionally a CLI/API action rather than
a pi session tool: it depends on the tracking store's current material boundary,
finding eligibility, and existing report state.

The extension also installs the shared shell-command guardrail. The inner model tool surface remains the same sandboxed `read` / `write` / `edit` / `bash` tools; pi built-ins are disabled for the audit session so the model cannot bypass Flounder's sandbox or confirmation gate.

The command guardrail lives in `src/security/policy.ts` so non-pi integrations can reuse the same policy.

## Tracking, API, and UI

A second surface tracks and drives audits across projects. It is additive: the audit kernel is unchanged, and a run produces the same files whether launched from the CLI or this surface.

```mermaid
flowchart LR
  UI["Web dashboard (SPA)"] -->|HTTP / SSE| SRV["control plane — src/server/app.ts<br/>REST API + SQLite + job queue"]
  AGENT["AI agent"] -->|REST + GET /api catalog| SRV
  SRV --- DB[("flounder.db (src/db)")]
  SRV <-->|"SSE (poll/cancel) · HTTP (claim, progress, activity)"| DAE["execution plane — src/server/daemon.ts"]
  DAE -->|in-process| LIB["runAudit / runConfirm"]
  LIB -->|"RemoteTracker → HTTP"| SRV
  LIB --> FILES["run dir on the daemon: events.jsonl, findings, reports"]
```

**Tracking store (`src/db/store.ts`, `record.ts`).** SQLite via `node:sqlite` (no dependency added) at `<out>/flounder.db`, WAL + busy-timeout so readers (the server) and writers coexist. The default `<out>` is `~/.flounder`, so normal installs keep the DB, run artifacts, durable history/build cache, daemon workspace, and provider auth under one product-owned home; system temp is used only for short-lived scratch. It is the **system of record for run tracking**, written live — not a rebuildable projection: projects, the run lifecycle, scope coverage (mapped vs audited vs deferred, per-dig), findings and their status transitions (suspect→confirm→refute, on a `finding_status_event` timeline), and confirm decisions — plus a `daemon` registry (bearer tokens) and a `job` queue that is the control plane's dispatch record. It stores metadata + **paths** to the on-disk artifacts, not their content. Findings map the kernel `confirmationStatus`, with a skeptic-disputed finding surfaced as `refuted`.

Findings are persisted **incrementally** — as each scope's dig lands, then re-persisted as the differential/refutation/appeal stages change a status — keyed on a **content-stable** `finding_key` (hash of scope+location+title, `src/util/finding-key.ts`) so a status update upserts the same row instead of orphaning it, and so the same bug found across resume batches counts once. The schema also carries the axes the dashboard surfaces: per-run `dig_started_at` (the map→dig boundary, so a combined run's elapsed splits into the two phases) and `run_scopes_*` (this run's dig batch); per-scope `dig_seconds` (its own deep-audit duration), an `auditing` status for the in-flight scope, and a manual `priority` (operator dig-queue ordering, **separate from** the map's `score`); and per-finding `confirm_status` (real-target reproduction: `reproduced` / `not-reproduced`, NULL = pending) and `tracking_status` (operator lifecycle: open, triaging, submitted, accepted, fixed, duplicate, rejected, or `ignored`). `ignored` is for human-dismissed machine findings: active views and automatic confirm/report worklists hide it, but it remains recoverable by filtering for ignored and changing it back to `open`.

**Control plane vs. execution plane.** Execution is **decoupled**. The server (control plane) owns the tracking store and the job queue but never runs an audit. One or more `flounder daemon start` processes (the execution plane, possibly on **other machines**) claim queued jobs and run `runAudit`/`runConfirm` locally — so the target **code and provider keys stay on the daemon**, never the server. The seam is `RunTracker`: `runAudit`/`runConfirm` accept `options.makeTracker`; the default `RunRecorder` (`src/db/record.ts`) writes the local SQLite store (the CLI path), while the daemon injects a `RemoteTracker` that **POSTs progress to the server** over HTTP instead of touching the tracking store directly. `specToConfig(spec)` (`src/server/run-manager.ts`) maps a launch spec to an `AuditorConfig` (the equivalent of `parseConfig` + `applyAuditPosture`: posture per verb, unbounded budgets by default, remap/quick/region/scope/mock). Stop is cooperative: `POST /api/runs/:id/stop` flags the job for cancel and pushes an SSE nudge; the daemon aborts (`options.signal` → `session.abort()`, finalize → `killed`). `flounder ui` auto-spawns a co-located daemon unless `--no-daemon`; it reuses the local auto-daemon token so the daemon id is stable across UI restarts and project-pinned queued jobs remain claimable. A remote daemon authenticates with a token from `flounder server daemon-token mint`. Because runs live on the daemon, they **survive a server restart** — the server does not blind-kill `running` rows.

**REST API + self-describing catalog (`src/server/app.ts`).** A `node:http` server that binds to `127.0.0.1` by default. Every workflow operation is a REST resource so an AI agent can drive the whole flow without the UI: **project** (CRUD, including selected daemon, default provider profile, task/clue config, source/build/corpus paths, budgets, phase provider overrides, archive/pin/manual order; project resource URLs use UUIDs, not names), **provider** (model strategy profiles), **daemon** (CRUD, token minting, rename, revoke), **run** (`POST /api/projects/:uuid/runs` **enqueues a job** and returns its `jobId`; `verb:"run"` is the automatic prepare-if-needed -> map/dig -> confirm -> report pipeline; `GET /api/runs/:id`; `POST /api/runs/:id/stop`; `GET /api/runs/:id/artifact?name=` serves an allowlisted report file), and read-only **scope** / **finding** (paginated + filterable) / **confirm-decision**. Findings carry two operator axes: `PATCH /api/projects/:uuid/scopes/:id` with `{prioritize:true}` bumps a scope to the front of the dig queue, and `PATCH /api/findings/:id/tracking` advances a finding's operator state. **Confirm is finding-grained**: `POST …/runs` with `verb:"confirm"` and *no* run dir reproduces every still-pending confirmable finding (the control plane locates each one's source run dir from its `run_id` and passes the pending set); with `findingId`/`findingIds` it confirms selected findings; a re-run skips already-decided findings (resume by `confirm_status`). **Report is finding-grained** too: selected `findingIds` regenerate those reports, `regenerateReports:true` regenerates every current reportable finding, and an unselected report run generates only missing reports. The CLI command `flounder report --project <uuid|name>` drives the same project endpoint; `--finding` sends selected `findingIds`, and `--all` sends `regenerateReports:true`. A cross-project **`GET /api/bugs`** powers the Findings view by returning findings joined with project plus status/tracking aggregates; it supports project scoping (`project=<uuid>`) and `tracking=active` to hide ignored rows. `GET /api` returns a catalog of every endpoint (method, path, params, body, summary) — an agent fetches it once to learn the surface. The execution-plane protocol — `/api/daemon/*` (register, SSE stream, claim, run-start, progress PATCH, activity, job-status, pipeline worklists), each **bearer-token-authenticated** — is **hidden from the catalog** (it is machine-to-machine, not agent-facing). Routing is a data-driven table, so the catalog and the handlers cannot drift.

**Live streams.** `GET /api/stream` (SSE) pushes the project snapshot ~1/s (computed from aggregate queries, so it stays cheap with many findings). `GET /api/runs/:id/log` (SSE) streams a run's live **token-level** activity (thinking/output deltas + tool calls) from a per-run in-memory bus that the daemon feeds via batched activity POSTs, and `?format=json`/`?tail=N` also returns the durable `events.jsonl` tail so an agent can inspect terminal errors after the live stream is gone.

**UI (`src/server/ui`).** A React/Vite TypeScript app compiled into `dist/server/public` and served by the Node control plane. It is **one client of the API above** — it can be ignored entirely in favor of the API. A project is created from a prominent task/clue composer plus execution daemon, default provider profile, source/build/corpus paths, coverage, and optional phase provider overrides. The project directory defaults to the project UUID under the daemon workspace. Its detail view shows the **prepare → map → dig → confirm → report** workflow, the current phase, elapsed timing, live model activity, and scope coverage. The primary button is **Run** before any pipeline run and **Continue** after one exists; finer phase actions live under More actions. Below the overview: a scope queue you can prioritize/skip/resume; findings that **stream in as each scope lands** and update status through refutation; project-scoped finding filters; per-finding tracking including `ignored`; real-target outcomes; selected-finding Verify/Confirm/Report actions; per-scope and per-finding durations; and viewable Markdown **reports**. The cross-project **Findings** view tracks every finding plus submission status, supports project/status/tracking filters, and defaults to Active findings (hiding ignored rows). **Settings** holds provider profiles (provider + model + thinking, with optional phase/role defaults), daemon CRUD, and archived projects. UI state derivation lives in `src/server/ui/src/domain.ts`, API types/client code live in `src/server/ui/src/api.ts`, and every action remains a single REST call.

## Runnable Gates

- `npm run check`: strict TypeScript compile.
- `npm test`: build plus Node tests.
- `npm run mock-audit`: deterministic offline audit smoke test.
- `npm run check:public`: fast public-surface scan for secrets and local paths in the current tree plus latest commit.
- `npm run verify`: full local gate.

## White-Hat Constraints

- Candidate projects and sealed local audits may use publicly available source code or explicitly authorized source code.
- Keep verification local-only.
- Never broadcast transactions or target public networks.
- Treat model output as untrusted input.
- Validate structured output and sanitize paths.
- Keep audit artifacts private by default.
