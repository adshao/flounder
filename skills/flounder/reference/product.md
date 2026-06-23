# Flounder product reference

Read this when the task involves dashboard projects, run phases, tracking state,
REST automation, or artifact layout.

## Contents

- [Product Surfaces](#product-surfaces)
- [Project Lifecycle](#project-lifecycle)
- [Run Phases](#run-phases)
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

Use **Run** before the first pipeline run and **Continue** after one exists.
Use More actions for Prepare, Map, Dig, Verify, Confirm, and Report when the
user asks for a precise phase. Leave **Run after create** checked when immediate
execution is wanted.

Project list behavior:

- default order is newest-created first;
- pinned projects sort before unpinned projects;
- drag ordering affects active projects only;
- archiving hides the project, clears pin, and preserves all runs, scopes,
  findings, reports, and decisions;
- recover archived projects from Settings -> Archived Projects.

## Run Phases

The normal project run is prepare-if-needed -> map/dig -> confirm -> report.

- Prepare acquires or stages source, corpus, dependency closure, and
  deployment-match evidence from a clue.
- Map enumerates and scores the audit surface without producing findings.
- Dig deep-audits selected scopes and execution-confirms local findings.
- Confirm reproduces locally confirmed findings on real-world ground truth.
- Report writes formal Markdown reports for eligible non-ignored findings.

`flounder run <clue>` uses the full pipeline. `flounder run --source ...`,
`map`, and `audit` enter the sealed discovery path directly.

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
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=active'
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=ignored'
curl http://127.0.0.1:4500/api/projects/<uuid>/confirm-decisions
curl http://127.0.0.1:4500/api/runs/<id>/log
```

Selected report regeneration:

```bash
curl -X POST http://127.0.0.1:4500/api/projects/<uuid>/runs \
  -H 'content-type: application/json' \
  -d '{"verb":"report","findingIds":[123,456]}'
```

## Artifact Model

Default local state lives under `~/.flounder`:

- `flounder.db`: local tracking database;
- `<target>-<timestamp>/`: run artifacts and copied workspaces;
- `history/<target>/`: durable memory, scope inventory, and build cache;
- `workspace/`: default daemon project directories;
- `agent/auth.json`: daemon-local provider auth.

Run artifacts include `audit_scopes.json`, `audit_findings.json`,
`audit_hypotheses.json`, `audit_command_runs.json`, `events.jsonl`,
`audit_transcript.json`, `summary.json`, and report files. Confirm artifacts
include `confirm_provenance.json`, `confirm_decision.json`,
`confirm_report.md`, and `confirm_equivalence.json`.
