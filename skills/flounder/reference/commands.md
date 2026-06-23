# Flounder command and API reference

Read [../SKILL.md](../SKILL.md) first. This file is for exact command, daemon,
provider, API, budget, output, and pi extension details.

## Product Surfaces

| Surface | Use |
| --- | --- |
| `flounder ui` | Local control plane, dashboard, REST API, SQLite store, and optional co-located daemon |
| `flounder daemon start` | Execution plane that claims jobs, owns target source and provider credentials, and reports progress |
| CLI verbs | Thin clients of the control plane; they enqueue tracked jobs and stream daemon activity |
| REST API | Agent-drivable surface; start with `GET /api` |
| pi extension | Registers `flounder_prepare`, `flounder_run`, `flounder_map`, `flounder_audit`, and `flounder_confirm` when loaded through pi |

## Setup Commands

```bash
flounder ui                 # dashboard at http://127.0.0.1:4500 plus co-located daemon
flounder ui --no-daemon     # control plane only
flounder server daemon-token mint [name]
flounder daemon start --server http://<server>:4500 --token <token>
flounder daemon provider list
flounder daemon provider login openai-codex
flounder daemon provider check openai-codex
```

Provider auth is daemon-local. The server stores provider profiles and queues
jobs; the daemon executes jobs and owns credentials. For `openai-codex`, run
`flounder daemon provider login openai-codex` to trigger the user-facing OAuth
flow; the command prints a browser URL or device-code instructions. If pi
already has `openai-codex` in `~/.pi/agent/auth.json`, Flounder imports that
provider entry into `~/.flounder/agent/auth.json` on login/check.

CLI naming convention:

- Workflow verbs stay top-level: `flounder run`, `flounder map`, `flounder audit`, `flounder confirm`.
- Server/control-plane resource commands live under `flounder server ...`.
- `flounder daemon ...` commands run on the daemon machine and can touch local
  provider auth, workspace paths, and executor settings. Start executors with
  `flounder daemon start --server <url> --token <token>`.
- Resource commands use noun/action form, matching provider commands:
  `flounder server finding list`, `flounder server run list`,
  `flounder server daemon-token mint`, and
  `flounder daemon provider list|login|check`.
- Do not expose `db` to users; the SQLite store is an implementation detail.

## Audit Verbs

| Verb | What it does |
| --- | --- |
| `flounder prepare <clue>` | Open-world acquisition before map: tx/address/project/repo/link -> staged source, corpus, dependency closure, and deployment match |
| `flounder run <clue>` | One-command pipeline: prepare -> sealed map/dig -> confirm unless disabled |
| `flounder run --source <paths...> --target <name>` | Source-provided sealed audit: map -> dig |
| `flounder map --target <name> --source <paths...>` | Enumerate and persist scope inventory only |
| `flounder audit <region> --source ...` | Deep-audit one region |
| `flounder audit --scope <id,...> --source ...` | Deep-audit selected inventory scopes |
| `flounder audit --verify <file> --source ...` | Confirm or refute suspected findings by execution |
| `flounder confirm <run-dir> --source <paths...>` | Open-world reproduction and submit/no-submit decision sheet |

## Materials

| Flag | Meaning |
| --- | --- |
| `--source <paths...>` | Code under audit. Point at readable source; pair with `--build-root` for buildability. |
| `--build-root <dir>` | Buildable workspace copied into the sandbox. Required for strong execution confirmation on real projects. |
| `--corpus <paths...>` | Project-owned specs, whitepapers, design docs, prior audits, or factual incident briefs. Context, not answers. |
| `--target <name>` | Project/run artifact key. |
| `--config <file>` | Optional JSON profile. CLI flags override it. |
| `--scope-note <text>` | One-line authorized-scope hint. |

## Coverage And Budget Controls

Defaults are designed for real audits: `--max-scopes` defaults to 30, dig samples
default to 1, dig concurrency defaults to 1, and map/dig can run until the model
is done unless capped by launch config.

| Flag | Meaning |
| --- | --- |
| `--quick` | `run` only: one breadth pass instead of map -> dig |
| `--map-steps <n>` | Cap map phase |
| `--dig-steps <n>` | Cap each scope's dig |
| `--dig-samples <n>` | Independent dig passes per scope; findings are unioned |
| `--dig-concurrency <n>` | Deep-audit multiple scopes in isolated workspaces |
| `--max-scopes <n>` | Scopes audited in the next dig batch; default 30 |
| `--remap` | Re-enumerate scope inventory instead of resuming |

## Sandbox And Network

| Flag | Meaning |
| --- | --- |
| `--sandbox-backend auto|oci|host` | Default `auto`; OCI is preferred for model-generated commands |
| `--sandbox-image <image>` | OCI image for sandboxed commands |
| `--allow-host-execution` | Trusted-local opt-in fallback only |
| `--prepare-network none|enabled` | Dependency warm-up/build network policy |
| `--confirm-network none|enabled` | Prepare/confirm open-world network policy |
| `--no-prepare` | Skip toolchain warm-up |
| `--prepare-timeout-ms <n>` | Warm-up timeout |

Real execution-confirming audits require Docker, or a Docker-compatible runtime
that provides the `docker` CLI, plus a built or pulled sandbox image. Build the
default image with `npm run sandbox:build`. Default `auto` mode fails closed if
the image is unavailable; it does not silently run model-generated commands on
the host.

Host execution is only for trusted local smoke tests and fixtures:

```bash
flounder run --source ./src --build-root . --sandbox-backend host --allow-host-execution
```

Host mode keeps the copied workspace and isolated `HOME` / package caches, but
it does not provide kernel-level network or filesystem isolation.

Sealed `run`, `map`, and `audit` confirmation commands should not use public
network access. `prepare` and `confirm` may fetch, fork, search, and read under
the white-hat command policy, but they must not broadcast or write to live
systems.

## Provider Profiles

The dashboard stores provider profiles:

- provider id, such as `openai-codex`
- model, such as `gpt-5.5`
- thinking level, such as `xhigh`
- optional role defaults

Projects select a default provider profile and may override it per phase:
prepare, map, dig, confirm. The selected daemon must authenticate every provider
profile the project can use.

## REST API

Start with:

```bash
curl http://127.0.0.1:4500/api
```

Common agent calls:

```bash
curl http://127.0.0.1:4500/api/projects
curl http://127.0.0.1:4500/api/providers
curl http://127.0.0.1:4500/api/daemons
curl http://127.0.0.1:4500/api/projects/<uuid>
curl http://127.0.0.1:4500/api/projects/<uuid>/findings
curl http://127.0.0.1:4500/api/projects/<uuid>/confirm-decisions
curl http://127.0.0.1:4500/api/runs/<id>/log
```

Creating a project requires both a provider profile and a daemon:

```bash
curl -X POST http://127.0.0.1:4500/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"p","providerId":1,"daemonId":1,"dir":"p","sourcePaths":["."],"buildRoot":".","corpusPaths":["docs/specs"],"config":{"maxScopes":30}}'
```

Starting a run:

```bash
PROJECT_UUID=<uuid-from-project-create-or-list>
curl -X POST http://127.0.0.1:4500/api/projects/$PROJECT_UUID/runs \
  -H 'content-type: application/json' \
  -d '{"verb":"run"}'
```

## Outputs

Each audit run writes:

- `audit_scopes.json`
- `audit_findings.json`
- `audit_hypotheses.json`
- `audit_command_runs.json`
- `audit_report.md`
- `summary.json`
- `events.jsonl`
- `calls/*.json`

Each confirm run writes:

- `confirm_provenance.json`
- `confirm_decision.json`
- `confirm_report.md`
- `confirm_equivalence.json`
- `confirm_transcript.json`

The tracking store records metadata and artifact paths; run artifacts remain
private by default.

Default local state is under `~/.flounder`: `flounder.db` for tracking,
`history/` for durable memory/build cache, `agent/auth.json` for daemon-local
provider auth, and `workspace/` for daemon project directories. System temp is
only for short-lived scratch.

## Pi Extension

When loaded through pi, Flounder registers:

- `flounder_prepare`: open-world target acquisition from a clue
- `flounder_run`: with a clue, prepare -> sealed map/dig -> confirm; with source paths, sealed map/dig source audit
- `flounder_map`: sealed scope inventory only
- `flounder_audit`: sealed dig, pinned region audit, selected scope audit, or inline finding verification
- `flounder_confirm`: open-world reproduction for a finished run

The dashboard/API path is still the recommended agent surface for project,
daemon, provider, live activity, and finding lifecycle management.
