---
name: flounder
description: >
  Operates Flounder, an autonomous white-hat security auditor. Use when a user
  asks for a security audit, bug-bounty review, vulnerability investigation, or
  exploit proof for an authorized repository, source tree, package, smart
  contract, Solidity/EVM project, ZK or proof-system code, deployed address,
  transaction, project link, or prior Flounder run; to run Flounder prepare,
  map, dig, audit, verify, confirm, or report workflows; to configure Flounder server,
  daemon, provider profiles, model auth, sandboxed execution, corpus paths,
  source paths, build roots, coverage, or budgets; to monitor live audit activity, continue
  pending scopes, verify suspected vulnerabilities, reproduce findings, or
  collect execution-backed bug reports.
---

# Flounder

This skill is the operating manual for Flounder-driven security audits.

Flounder is an autonomous white-hat security auditor. The agent prepares the
target, audits source, constructs exploit paths, runs local proof tests,
confirms real findings, and packages reports. The framework provides the
daemon, sandbox, command policy, run tracking, live activity, and execution
gates.

## Skill Files

| File | When to read |
| --- | --- |
| `SKILL.md` | Always after this skill triggers. It is the operating playbook. |
| `reference/commands.md` | Exact CLI, REST, provider, daemon, budget, output, and pi extension details. |
| `reference/examples.md` | Concrete Solidity/EVM and ZK examples. |
| `reference/product.md` | Dashboard, project lifecycle, run phases, tracking, and artifact model. |
| `reference/safety.md` | White-hat policy, sandbox boundary, evidence ladder, and public-release hygiene. |

Use progressive disclosure: open only the reference file needed for the current
task. Do not duplicate long command references into the conversation when a
short command and status summary is enough.

## What This Skill Must Do

- Turn a security-audit request into an authorized Flounder project or run.
- Keep the operator on the current workflow: `run <clue>` lets Flounder prepare
  the target, then map/dig, confirm, and report; `run --source` is the
  source-provided entry path for sealed map/dig.
- Prefer the dashboard/API control plane for project work so state, daemon
  ownership, live logs, findings, and reports stay durable.
- Preserve the evidence ladder: suspected, locally confirmed, real-target
  reproduced, submission-ready. Do not collapse these into one "bug" bucket.
- Separate machine noise from active work by marking dismissed findings
  `ignored`, never by deleting them.
- Stop with a clear next action or blocker; do not call an audit complete just
  because a command exited.

## Core Audit Modes

Choose the mode from the user's intent before launching anything:

| User intent | Mode | Preparation path | Guardrail |
| --- | --- | --- | --- |
| "Do a blind audit / test Flounder's capability / no hints" | Blind capability audit | Recommended: `flounder run <project-or-repo-or-package-link>` or a dashboard project with a factual target clue. If source is already staged or external preparation is explicitly unwanted, use `flounder run --source <paths...> --build-root <root>`. | Do not add incident docs, known bug names, exploit theories, or answer-bearing corpus. Official target docs are allowed only as target material, not as a hidden answer. |
| "Here is a suspicious tx/address; find the hack/root cause" | Incident investigation | `flounder run <tx-or-address-or-incident-link>` | Treat the clue as evidence, not as proof. Prepare may fetch chain/source data; confirm by local fork/read-only reproduction only. |
| "Audit this project/repo openly like a bounty hunter" | Open-world bounty audit | Create a project with source paths when available plus a task/clue naming the project, bounty, repo, package, or deployment, then Run. | Let Prepare collect official docs, scope, deployments, and provenance. Do not use private or answer-bearing material. |

When in doubt: if the user asks to measure Flounder's unaided recall, use blind
capability audit and keep the clue target-only. If the user gives live exploit
evidence, use incident investigation. If the user wants broad authorized bug
hunting and permits public context collection, use open-world bounty audit.

## Supporting Workflows

Use these when the user is not asking for a full end-to-end audit:

| User intent | Workflow |
| --- | --- |
| "Just map the surface / show scope inventory" | `flounder map`; do not produce findings. |
| "Dig this file/function/scope deeper" | `flounder audit <region>` or `flounder audit --scope <id>`. |
| "Check these suspected bugs" | `flounder audit --verify <claims.json>`; confirm or refute by execution. |
| "Is this locally confirmed bug real on mainnet/deployment?" | `flounder confirm <run-dir>` or selected project Confirm. |
| "Prepare submission package" | selected Report; include only execution-backed, non-ignored findings. |
| "Triage noisy machine findings" | update tracking: `ignored` for dismissed, `open` to recover. |

## Core Operating Rules

- Use Flounder CLI, dashboard, REST API, or pi extension workflows. Do not edit
  the tracking database directly.
- Confirm authorization and scope before running an audit.
- Keep provider credentials daemon-local. The server stores provider profiles;
  daemons own provider login, API keys, target source, and execution.
- Treat `~/.flounder` as the default product home: tracking DB, run artifacts,
  durable history/build cache, daemon workspace, and daemon-local provider auth
  live there unless the user explicitly passes `--out` or `--workspace`.
- Start with `flounder ui` unless the user already has a control plane running.
  CLI verbs are thin clients of that control plane.
- Use `GET /api` before driving the REST API directly; the catalog is the source
  of truth for endpoint shape.
- Use project-owned docs/specs/audits as corpus. Do not write answer-bearing
  corpus that names the suspected bug, location, or mechanism.
- Do not modify target source in place. Flounder copies a build root into an
  isolated workspace and model-written tests stay inside that workspace.
- Treat `suspected` as unproven. A finding is actionable only when execution
  produced `confirmed-executable`, `confirmed-differential`, or a reproduced
  confirm decision.
- `flounder run <clue>` is the one-command workflow: open-world prepare,
  sealed map/dig, open-world confirm, then report generation. `flounder run
  --source`, `map`, and `audit` are sealed discovery phases. `prepare` and
  `confirm` are open-world phases, still under white-hat no-broadcast rules.
- Never broadcast transactions, move funds, submit writes, persist access, or
  target systems outside the authorized scope.

## First Response Checklist

When a user asks to audit, confirm, verify, report, or inspect Flounder state:

1. Confirm the target is authorized or in public bounty scope. If scope is
   unclear, ask before running.
2. Classify the request into one core audit mode: blind capability audit,
   incident investigation, or open-world bounty.
3. Decide the surface:
   - Existing dashboard/API project: use `GET /api`, then project UUID routes.
   - New project or local operator workflow: start/reuse `flounder ui`.
   - Framework-prepared target: prefer task/clue so Flounder can prepare source and official materials.
   - Source-provided target: use `--source` when code is staged or no external preparation is wanted.
4. Check daemon and provider readiness before launching real model work:
   `flounder daemon provider check openai-codex` on the executor machine.
5. Check sandbox readiness before execution-confirming audits:
   `npm run sandbox:build` if the default OCI image is missing.
6. Choose the workflow from the routing table below, launch the smallest
   correct action, then monitor live logs and persisted state.
7. Report the result with project/run ids, phase, evidence status, and next
   action. Include setup blockers distinctly from audit findings.

For repository development or local builds, use Node 22 LTS from `.nvmrc` /
`.node-version`; do not substitute newer experimental Node versions.

## Quickstart For Codex Or Claude Code

1. Check whether Flounder is available:

   ```bash
   flounder --help
   ```

   If it is not available from PATH but the repository is checked out, build it:

   ```bash
   npm install
   npm run build
   node dist/cli.js --help
   ```

   Until the package is installed or linked, replace `flounder` in command
   examples with `node dist/cli.js`.

2. Start or reuse the local control plane:

   ```bash
   flounder ui
   ```

   For a remote executor, mint a token in Settings or with
   `flounder server daemon-token mint`, then run:

   ```bash
   flounder daemon start --server http://<server>:4500 --token <token>
   ```

3. Authenticate every provider that the selected daemon will run:

   ```bash
   flounder daemon provider login openai-codex
   flounder daemon provider check openai-codex
   ```

   For `openai-codex`, this is how the agent asks the user to authenticate.
   Run the login command in the terminal; it prints a browser URL or device-code
   instructions, the user completes the login, and then `check` verifies it. If
   pi already has `openai-codex` in `~/.pi/agent/auth.json`, Flounder imports
   that provider entry into `~/.flounder/agent/auth.json` on login/check.

4. Ensure the execution sandbox is available on the daemon machine. For real
   audits, install and start Docker or a Docker-compatible runtime, then build
   the default sandbox image from the Flounder repo:

   ```bash
   npm run sandbox:build
   ```

   Default `auto` mode uses the OCI image when it exists and otherwise fails
   closed. If Docker/OCI is unavailable, only use
   `--sandbox-backend host --allow-host-execution` for trusted local smoke tests
   after warning the user that host mode lacks kernel-level filesystem and
   network isolation.

5. Create or reuse a provider profile in Settings. A provider profile selects
   provider, model, and thinking level. Fresh stores seed `openai-codex ·
   gpt-5.5 · xhigh` and `claude-code · opus 4.8 max`; the selected daemon still
   needs local auth for every provider the project can use. A project can
   override the profile per phase: prepare, map, dig, confirm.

6. Create or reuse a project. Set:

   - task/clue in the project composer
   - execution daemon
   - default provider profile
   - project directory under the daemon workspace, defaulting to the project UUID
   - source paths
   - build root
   - corpus paths
   - coverage and budget controls

7. Start the audit. Leave **Run after create** checked to launch immediately, or
   use the project **Run** button before the first pipeline run and **Continue**
   afterward. For a clue:

   ```bash
   flounder run <tx-or-address-or-project-or-repo-or-link>
   ```

   For source already on disk:

   ```bash
   flounder run --target <name> --source <paths...> --build-root <root> --corpus <docs...>
   ```

8. Monitor progress from the dashboard, CLI stream, or REST API:

   - current phase: prepare, map, dig, confirm, report
   - live activity: `GET /api/runs/:id/log`
   - project state: `GET /api/projects/:uuid`
   - prepare quality: `prepareSummary.quality` is `ready`, `limited`,
     `preparing`, `needs-review`, `missing`, or `invalid`; use
     `prepareSummary.auditReady` as the automation gate. `limited` means the
     audit can continue automatically while recorded trust boundaries or
     material gaps stay visible for later confirm/report decisions. Stop only
     for `prepareSummary.blockingIssues`, `invalid`, or missing usable source.
   - findings: `GET /api/projects/:uuid/findings?tracking=active`
   - ignored findings recovery: `GET /api/projects/:uuid/findings?tracking=ignored`
   - confirm decisions: `GET /api/projects/:uuid/confirm-decisions`

   Project names are display labels. Resolve a project UUID from `POST /api/projects`
   or `GET /api/projects`; do not build a project URL from the name.

9. Decide the next action using the rules below. Do not call the task complete
   just because one run ended.

## Fast Recipes

### Blind Capability Audit

Use this when the user wants no hints, no incident context, or a
framework-capability check.

Recommended target-prepared path:

```bash
flounder run <project-or-repo-or-package-link>
```

Existing source path:

```bash
flounder run --target <name> --source <paths...> --build-root <root> --corpus <user-supplied-docs...>
```

- Leave `--corpus` empty unless the user supplied official docs/specs as part of
  the blind package.
- Do not use incident reports, known bug names, exploit theories, hand-written
  scope notes that point at a suspected bug, or answer-bearing corpus.
- Judge the result by evidence status and coverage: mapped scopes, audited
  scopes, suspected findings, locally confirmed findings, pending scopes.
- A negative result is "no confirmed finding in covered scope", not proof the
  target is safe.

### Incident Investigation From A Transaction Or Address

Use this when the user gives a suspicious transaction, address, exploit link, or
asks "why was this hacked?"

```bash
flounder run <tx-or-address-or-incident-link>
```

- Let Prepare collect deployed source, chain facts, official project material,
  and real-target confirmation requirements.
- Keep the incident clue factual. Do not write a theory of the bug into corpus.
- Confirm the root cause with attacker-real local reproduction, usually a local
  fork or source-level replay. Never broadcast or write to a live system.
- The answer should explain the exploited invariant, attacker path, affected
  component, and whether the finding is reproduced, not-reproduced, or still
  suspected.

### Open-World Bounty Audit

Use this when the user wants Flounder to actively collect official public
context, deployments, package metadata, docs, or bounty scope. Source paths are
useful when already available, but they are not what defines the scenario.

1. Start or reuse `flounder ui`.
2. Create a project with:
   - local source/build/corpus paths if available;
   - a task/clue naming the project, repo, bounty page, deployment, or package;
   - an online daemon;
   - a provider profile such as `openai-codex · gpt-5.5 · xhigh`.
3. Leave **Run after create** checked when the user wants immediate execution.
4. Monitor `GET /api/runs/:id/log` and `GET /api/projects/:uuid`.
5. Treat `limited` prepare as audit-ready unless it has blocking issues; carry
   caveats forward to verify/confirm/report decisions.
6. Use official/public materials only; do not add private notes or answer-bearing
   docs that name a suspected bug.

### Continue An Existing Project

1. Resolve the project UUID from `GET /api/projects`.
2. Use the project **Continue** action or:

   ```bash
   curl -X POST http://127.0.0.1:4500/api/projects/<uuid>/runs \
     -H 'content-type: application/json' \
     -d '{"verb":"run"}'
   ```

3. If many mapped scopes are pending, prefer continuing coverage before drawing
   a negative conclusion.

### Project Setup And Housekeeping

Use this when the user asks why a project cannot run, how to clean up the
project rail, or how to recover archived work.

- Open the project setup disclosure first when the overview reports setup
  attention. Fix daemon selection, provider auth, source paths, or prepared
  material blockers before launching new work.
- Pin active projects that need daily attention; archive dormant projects from
  the project card menu. Archiving hides the project from the rail, clears pin,
  and keeps runs, scopes, findings, and reports.
- Recover archived projects from Settings -> Archived Projects.
- Drag ordering is for active projects only; default ordering is newest-created
  first, with pinned projects before unpinned projects.

### Findings Triage

Use this when the user is reviewing machine-reported bugs.

- Start in the Active findings view; filter by project when working one audit.
- Keep audit status (`suspected`, `confirmed-*`, `refuted`) separate from
  tracking state (`open`, `triaging`, `submitted`, `ignored`, etc.).
- Mark human-dismissed false positives as `ignored`; do not delete them.
- Use the Ignored view to recover dismissed findings and set them back to
  `open` if new evidence appears.
- Generate reports only for reproduced real-target bugs, or locally confirmed
  source-provided audit bugs when real-target confirmation is not required.

### Verify, Confirm, And Report Selected Findings

- Suspected finding from JSON: `flounder audit --verify <file> --source ...`.
- Selected project findings: use More actions -> Verify/Confirm/Report, or
  pass `findingId` / `findingIds` to `POST /api/projects/:uuid/runs`.
- Regenerate only specific reports with `{"verb":"report","findingIds":[...]}`.
- Report without `findingIds` generates only missing formal reports.
- Mark a human-dismissed machine finding as `ignored`; recover it later from
  `tracking=ignored` by changing it back to `open`.

## Workflow Map

Open only the references needed for the current task:

- exact CLI, REST, provider, daemon, budget, output, and pi extension details:
  [reference/commands.md](reference/commands.md)
- Solidity/EVM and ZK examples:
  [reference/examples.md](reference/examples.md)
- dashboard, project lifecycle, run phases, and artifact model:
  [reference/product.md](reference/product.md)
- white-hat policy, sandbox boundary, and evidence ladder:
  [reference/safety.md](reference/safety.md)

## Task Routing

| User intent | Use |
| --- | --- |
| "Blind audit this target / test framework capability" | Blind capability audit: prefer `flounder run <target-clue>`; use `flounder run --source ... --build-root ...` when source is already staged or no external preparation is wanted |
| "Find why this tx/address was hacked" | Incident investigation: `flounder run <tx-or-address-or-incident-link>` |
| "Audit this repo/source openly for bug bounty" | Open-world bounty audit: project with source paths plus task/clue, then Run |
| "Map the attack surface first" | `flounder map`, then inspect scopes and run `flounder audit --scope ...` |
| "Dig this file/function/region" | `flounder audit <region> --source ... --build-root ...` |
| "Verify this suspected bug" | Write a claims JSON and run `flounder audit --verify <file>` |
| "Continue coverage" | Use project Continue or audit pending scopes from the inventory |
| "Confirm whether this is real" | `flounder confirm <run-dir>` or project/finding Confirm in the UI |
| "Collect bugs for disclosure" | Read findings, selected reports, confirm decisions, and artifacts; return only execution-backed items |
| "Ignore this false positive" | Set finding tracking to `ignored`; do not delete it |
| "Bring back ignored findings" | Filter `tracking=ignored`, then set selected rows back to `open` |
| "Regenerate reports" | Use report action with selected `findingIds` |

## Deciding The Next Action

- No daemon online: create/connect a daemon before launching jobs.
- Daemon online but provider check fails: run `flounder daemon provider login`
  or set daemon-local provider credentials, then check again.
- Sandbox says no OCI image is available: install/start Docker on the daemon and
  run `npm run sandbox:build`, or ask for explicit trusted-local approval before
  using `--sandbox-backend host --allow-host-execution`.
- Project has no provider profile or daemon: configure those before creating a
  run.
- Run is queued and no daemon can claim it: check the project's selected daemon.
- Run is running: watch `GET /api/runs/:id/log` and the project phase, not only
  aggregate counts.
- Prepare quality is `limited`: continue automatically unless the user asked to
  perfect materials first; preserve `prepareSummary.caveats`, `gaps`, and
  `realTarget` for verify, confirm, and reports.
- Prepare quality is `needs-review`, `missing`, or `invalid`: read
  `prepareSummary.blockingIssues`, `issues`, `gaps`, and `realTarget`. Repair
  only hard blockers such as contaminated answer-bearing material, invalid
  output, empty prepared source, or no usable source; otherwise continue with
  caveats instead of requiring manual review.
- Map is done but many high-score scopes are pending: continue the audit or
  prioritize scopes.
- Findings are only `suspected`: make the target buildable and run verify or
  dig again.
- Findings are confirmed locally but not reproduced: run confirm.
- Machine-reported finding is manually dismissed: set tracking to `ignored`;
  recover it later from the Ignored filter by changing tracking back to `open`.
- Confirm decision is `not-reproduced`: treat it as not submission-ready unless
  the failure is a known environment limitation and the user approves more work.
- Confirm decision is `submit-candidate`: collect the bug package and stop
  further exploitation.
- No findings and material coverage is low: improve source/build/corpus setup or
  continue pending scopes before concluding.

## Common Errors And Recovery

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| No daemon can claim a queued job | Project is pinned to an offline daemon | Start that daemon or edit the project daemon. |
| Provider auth missing | Credentials live on daemon, not server | Run `flounder daemon provider login <provider>` and then `check`. |
| OCI sandbox unavailable | Default image missing or Docker stopped | Start Docker and run `npm run sandbox:build`; host fallback needs explicit trusted-local approval. |
| `prepareSummary.quality=limited` | Source is usable but has caveats | Continue unless blocking issues exist; preserve caveats for confirm/report. |
| `prepareSummary.quality=invalid/missing` | No usable staged source or contaminated material | Repair prepare inputs before audit. |
| Verify rejects selected findings for material drift | New Prepare changed the current material boundary | Re-select current findings or pass the explicit expert override only after checking drift. |
| Confirm returns `not-reproduced` | PoC was not attacker-real on the real target, or environment is incomplete | Treat as not submission-ready unless the user approves more reproduction work. |
| Report action says no findings are missing reports | All reportable rows already have formal reports, or selected rows are not reproduced/confirmed | Select eligible findings or inspect Active/Ignored tracking filters. |
| Node native crash during repo tooling | Unsupported Node version | Use Node 22 LTS from `.nvmrc` / `.node-version`. |

## Collecting Bugs

For every bug candidate, collect:

- project and run id
- title, location, scope id, and status
- why the property matters
- exact command evidence or `command_id`
- PoC files or test path
- differential result, if any
- refutation or appeal result, if any
- confirm decision: reproduced, not-reproduced, submit-candidate, needs-human,
  or drop
- report path and artifact paths
- remaining human gates: bounty scope, duplicate/known issue, embargo, or
  disclosure venue

Do not present a list of model suspicions as bugs. Separate confirmed findings,
suspected findings, refuted findings, and reproduced submit candidates.

## Completion Snapshot

The task is not complete until the agent can report:

- Flounder control plane is reachable, or a clear setup blocker is documented.
- The execution daemon is selected and online.
- Every selected provider profile is authenticated on the daemon.
- The project has source paths, a build root, and corpus paths appropriate for
  the requested audit.
- Prepared materials are `ready` or `limited`; if limited, every caveat needed
  for verify, confirm, or report decisions is called out as a known limitation.
- The audit run reached a terminal state or a meaningful blocker.
- Scope coverage is summarized: mapped, audited, pending, deferred.
- Findings are grouped by status.
- Confirmed findings have been sent through confirm when real-target
  reproduction is required.
- Ignored findings are separated from the active worklist and remain recoverable.
- Reproduced or locally confirmed source-provided audit bugs have selected
  reports when disclosure packaging is requested.
- Submit candidates include evidence and artifact paths.
- Non-submittable items are labeled as suspected, refuted, not-reproduced, or
  needs-human with the reason.

## High-Risk Defaults

- Do not run against a target without explicit authorization.
- Do not use host execution for model-generated tests unless the user explicitly
  approves trusted-local fallback after being told it lacks kernel-level
  filesystem and network isolation.
- Do not treat a mocked trusted component as attacker-real capability.
- Do not conclude from "matches upstream" or "looks standard".
- Do not silently lower model or thinking settings.
- Do not bury daemon/provider setup failures as audit failures.
- Do not submit or disclose without a reproduced, scoped, private report.
