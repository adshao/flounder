# Flounder product reference

Read this when the task involves dashboard projects, run phases, tracking state,
REST automation, or artifact layout.

## Contents

- [Product Surfaces](#product-surfaces)
- [Project Lifecycle](#project-lifecycle)
- [Engagement Profiles](#engagement-profiles)
- [Run Phases](#run-phases)
- [Discovery Health And Backlog](#discovery-health-and-backlog)
- [Findings And Tracking](#findings-and-tracking)
- [REST Automation](#rest-automation)
- [Artifact Model](#artifact-model)

## Product Surfaces

- `flounder ui`: local control plane, dashboard, REST API, SQLite store, and
  optional co-located daemon.
- `flounder daemon start`: execution plane that claims jobs, owns provider auth
  and target source, and streams progress back to the server.
- CLI workflow verbs: thin clients that enqueue jobs and stream daemon logs.
- REST API: agent-drivable surface. Fetch `GET /api` first.
- pi extension: mirrors the top-level workflow verbs when loaded through pi.

## Project Lifecycle

New dashboard projects should capture:

- task/clue in the project composer;
- selected execution daemon;
- default provider profile and optional phase overrides;
- project directory under the daemon workspace, defaulting to project UUID;
- source paths, build root, corpus paths, and coverage/budget settings.
- engagement config when the project is a normal bounty or contest.

Use **Run** before the first pipeline run and **Continue** after one exists.
The CLI equivalent of the Continue button is
`flounder continue --project <uuid|name>`. Use More actions for Prepare, Map,
Dig, Verify, Confirm, and Report when the user asks for a precise phase. Leave
**Run after create** checked when immediate execution is wanted.

The project setup disclosure is the place to inspect stored project clue,
daemon/provider/source configuration, prepared-material caveats, and setup
attention. A clue is not shown as a separate project card after creation.

Project list behavior:

- default order is newest-created first;
- pinned projects sort before unpinned projects;
- drag ordering affects active projects only;
- archiving hides the project, clears pin, and preserves all runs, scopes,
  findings, reports, and decisions;
- recover archived projects from Settings -> Archived Projects.

## Engagement Profiles

Engagement profiles tell the control plane how the audit will be judged. They
do not change the model-owned audit strategy.

- `standard`: default authorized review.
- `bug-bounty`: normal bounty work. Keep real-target Confirm in the path when a
  live target exists, and gate reports on scope, duplicate, known-issue, impact,
  payout, and disclosure readiness.
- `bug-bounty-contest`: time-limited contest work. Favor short
  verify/refute/report batches, allow source-only local confirmation when venue
  rules permit skipping real-target confirmation, and append-map novel scopes
  when the current inventory is exhausted.

Contest strategy can include `batchScopes`, `digConcurrency`,
`skipRealTargetConfirm`, and `appendMapWhenExhausted`. The project view should
surface stop-review signals such as elapsed review window, exhausted inventory,
recent low-yield scope batches, duplicate rate, report backlog, and open
resource requests.

## Run Phases

The normal project run is prepare-if-needed -> map/dig -> synthesize -> verify
-> confirm -> report.

- Prepare acquires or stages source, corpus, dependency closure, and
  deployment-match evidence from a clue.
- Map enumerates and scores the audit surface without producing findings.
- Dig deep-audits selected scopes and execution-confirms local findings.
- Synthesize composes findings across scopes into distinct bug candidates.
- Verify confirms or refutes suspected and synthesized candidates by local
  execution before real-target confirmation.
- Confirm reproduces locally confirmed findings on real-world ground truth.
- Report writes formal Markdown reports for eligible non-ignored findings.

`flounder run <clue>` uses the full pipeline. `flounder run --source ...`,
`map`, and `audit` enter the sealed discovery path directly.

For contest projects, Continue first settles missing verify/report work before
opening the next scope batch. If the inventory is exhausted and append-map is
enabled, the next run asks MAP for novel scopes while preserving prior scope
status, duplicate links, submitted findings, and reports.

## Discovery Health And Backlog

Audit runs may write discovery-health artifacts in addition to findings:

- `run_health.json`: health verdict (`healthy`, `needs-coverage`,
  `needs-resource`, `shallow`, or `infra-failed`) derived from objective run
  signals.
- `coverage_gaps.json`: obligations or evidence paths that still need coverage.
- `resource_requests.json`: missing tooling, artifacts, dependency state, fork
  setup, credentials, or environment that blocked deeper work.
- `followup_scopes.json`: adjacent audit units proposed by the model; accepted
  rows become pending follow-up scopes rather than immediate side quests.

These rows are not findings. They explain what to do next when a run has few or
zero bugs: fix resource blockers, continue coverage, or prioritize follow-up
scopes. The API and dashboard classify each row as `agent-runnable`,
`needs-resource`, or `needs-decision`. Agents may autonomously continue,
append-map, or prioritize scopes for `agent-runnable` rows; resource and
decision rows stay visible until the blocker is handled or intentionally
ignored. Mark non-actionable backlog rows `ignored`; mark handled blockers
`resolved`; keep unresolved coverage rows `open`.

Resource requests can be model-authored or product-owned. Prepare and toolchain
warm-up failures create product-owned `resource-request` rows with a failed
command, short diagnostic, and retry command even when the model never wrote a
`resource_requests.json` file.

## Findings And Tracking

Keep audit status separate from human tracking state.

- Audit status: `suspected`, `confirmed-executable`,
  `confirmed-differential`, `refuted`, and confirm decisions such as
  `reproduced`, `not-reproduced`, or `submit-candidate`.
- Tracking state: `open`, `triaging`, `submitted`, `ignored`, and similar
  operator workflow labels.

Mark human-dismissed machine findings as `ignored`, not deleted. Recover them
from the Ignored view or `tracking=ignored` API filter by setting tracking back
to `open`.

## REST Automation

Start with:

```bash
curl http://127.0.0.1:4500/api
```

Common calls:

```bash
curl http://127.0.0.1:4500/api/projects
curl http://127.0.0.1:4500/api/providers
curl http://127.0.0.1:4500/api/daemons
curl http://127.0.0.1:4500/api/projects/<uuid>
curl 'http://127.0.0.1:4500/api/projects/<uuid>/backlog?status=open'
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=active'
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=ignored'
curl http://127.0.0.1:4500/api/projects/<uuid>/confirm-decisions
curl http://127.0.0.1:4500/api/runs/<id>/log
```

Selected report regeneration:

```bash
flounder report --project <uuid> --finding 123 --finding 456
flounder report --project <uuid> --all

curl -X POST http://127.0.0.1:4500/api/projects/<uuid>/runs \
  -H 'content-type: application/json' \
  -d '{"verb":"report","findingIds":[123,456]}'

curl -X POST http://127.0.0.1:4500/api/projects/<uuid>/runs \
  -H 'content-type: application/json' \
  -d '{"verb":"report","regenerateReports":true}'
```

Without `--finding`, `--all`, `findingIds`, or `regenerateReports:true`, report
runs generate only missing formal reports.

## Artifact Model

Default local state lives under `~/.flounder`:

- `flounder.db`: local tracking database;
- `<target>-<timestamp>/`: run artifacts and copied workspaces;
- `history/<target>/`: durable memory, scope inventory, and build cache;
- `workspace/`: default daemon project directories;
- `agent/auth.json`: daemon-local provider auth.

Run artifacts include `audit_scopes.json`, `audit_findings.json`,
`audit_hypotheses.json`, `audit_command_runs.json`, `run_health.json`,
`coverage_gaps.json`, `resource_requests.json`, `followup_scopes.json`,
`events.jsonl`, `audit_transcript.json`, `summary.json`, and report files.
Confirm artifacts include `confirm_provenance.json`, `confirm_decision.json`,
`confirm_report.md`, and `confirm_equivalence.json`.
