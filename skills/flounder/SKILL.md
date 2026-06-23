---
name: flounder
description: >
  Operates Flounder, an autonomous white-hat security auditor. Use when a user
  asks for a security audit, bug-bounty review, vulnerability investigation, or
  exploit proof for an authorized repository, source tree, package, smart
  contract, Solidity/EVM project, ZK or proof-system code, deployed address,
  transaction, project link, or prior Flounder run; to run Flounder prepare,
  map, dig, audit, verify, or confirm workflows; to configure Flounder server,
  daemon, provider profiles, model auth, sandboxed execution, corpus paths,
  source paths, build roots, coverage, or budgets; to monitor live audit activity, continue
  pending scopes, verify suspected vulnerabilities, reproduce findings, or
  collect execution-backed bug reports.
---

# Flounder

This skill is the operating manual for Flounder-driven security audits.

Flounder is an autonomous white-hat security auditor. The agent prepares the
target, audits source, constructs exploit paths, runs local proof tests, and
confirms real findings. The framework provides the daemon, sandbox, command
policy, run tracking, live activity, and execution gates.

## Install This Skill

Install from this repository with the `skills` CLI. The recommended install
targets Codex and Claude Code explicitly, avoiding unsupported global targets:

```bash
npx skills add . --skill flounder -g -a codex -a claude-code
```

To ask the installer to try every supported agent:

```bash
npx skills add . --skill flounder -g
```

Some agents do not support global skill installation; the targeted command
above is the clean path for Codex/Claude Code users.

Use `npx skills add . --skill flounder --list` from the repository root to
confirm the skill is discoverable before installing.

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
- `flounder run`, `map`, and `audit` are sealed discovery phases. `prepare` and
  `confirm` are open-world phases, still under white-hat no-broadcast rules.
- Never broadcast transactions, move funds, submit writes, persist access, or
  target systems outside the authorized scope.

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
   provider, model, and thinking level. A project can override the profile per
   phase: prepare, map, dig, confirm.

6. Create or reuse a project. Set:

   - execution daemon
   - default provider profile
   - project directory under the daemon workspace
   - source paths
   - build root
   - corpus paths
   - coverage and budget controls

7. Start the audit. For a clue:

   ```bash
   flounder run <tx-or-address-or-project-or-repo-or-link>
   ```

   For source already on disk:

   ```bash
   flounder run --target <name> --source <paths...> --build-root <root> --corpus <docs...>
   ```

8. Monitor progress from the dashboard, CLI stream, or REST API:

   - current phase: prepare, map, dig, confirm
   - live activity: `GET /api/runs/:id/log`
   - project state: `GET /api/projects/:uuid`
   - prepare quality: `prepareSummary.quality` is `ready`, `limited`,
     `preparing`, `needs-review`, `missing`, or `invalid`; use
     `prepareSummary.auditReady` as the automation gate. `limited` means the
     audit can continue automatically while recorded trust boundaries or
     material gaps stay visible for later confirm/report decisions. Stop only
     for `prepareSummary.blockingIssues`, `invalid`, or missing usable source.
   - findings: `GET /api/projects/:uuid/findings`
   - confirm decisions: `GET /api/projects/:uuid/confirm-decisions`

   Project names are display labels. Resolve a project UUID from `POST /api/projects`
   or `GET /api/projects`; do not build a project URL from the name.

9. Decide the next action using the rules below. Do not call the task complete
   just because one run ended.

## Workflow Map

Open only the references needed for the current task:

- exact CLI, REST, provider, daemon, budget, output, and pi extension details:
  [reference/commands.md](reference/commands.md)
- Solidity/EVM and ZK examples:
  [reference/examples.md](reference/examples.md)
- product usage details:
  [../../docs/USAGE.md](../../docs/USAGE.md)
- architecture and trust boundary:
  [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- white-hat policy:
  [../../SECURITY.md](../../SECURITY.md)

## Task Routing

| User intent | Use |
| --- | --- |
| "Audit this repo/source" | Create project or run `flounder run --source ... --build-root ... --corpus ...` |
| "Audit this transaction/address/project link" | `flounder run <clue>` or `flounder prepare <clue>` first |
| "Map the attack surface first" | `flounder map`, then inspect scopes and run `flounder audit --scope ...` |
| "Dig this file/function/region" | `flounder audit <region> --source ... --build-root ...` |
| "Verify this suspected bug" | Write a claims JSON and run `flounder audit --verify <file>` |
| "Continue coverage" | Resume the project run or audit pending scopes from the inventory |
| "Confirm whether this is real" | `flounder confirm <run-dir>` or project/finding Confirm in the UI |
| "Collect bugs for disclosure" | Read findings, reports, confirm decisions, and artifacts; return only execution-backed items |

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
- Confirm decision is `not-reproduced`: treat it as not submission-ready unless
  the failure is a known environment limitation and the user approves more work.
- Confirm decision is `submit-candidate`: collect the bug package and stop
  further exploitation.
- No findings and material coverage is low: improve source/build/corpus setup or
  continue pending scopes before concluding.

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
