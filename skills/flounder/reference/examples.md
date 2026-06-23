# Flounder examples

Read the root `SKILL.md` first. These examples show common audit paths.

## Contents

- [Agent Requests](#agent-requests)
- [Blind Audit / Capability Check](#blind-audit--capability-check)
- [Open-World Bounty Audit](#open-world-bounty-audit)
- [ZK / Proof-System Audit](#zk--proof-system-audit)
- [Incident Investigation](#incident-investigation)
- [Dashboard Project Triage](#dashboard-project-triage)
- [Verify Existing Suspicions](#verify-existing-suspicions)

## Agent Requests

After installing the skill, ask Codex or Claude Code naturally:

```text
Blind audit this repository with Flounder. Do not use external hints or incident reports.

Investigate why transaction 0x... was hacked with Flounder.

Run an open-world bug-bounty audit for ./contracts. Use the official docs and public bounty scope if available.
```

## Blind Audit / Capability Check

Use this to measure Flounder's unaided capability on an authorized target. The
target can be prepared by Flounder, or supplied as existing local source. Do not
use incident writeups, known bug names, exploit theories, or answer-bearing
corpus.

Recommended target-prepared path:

```bash
flounder run <repo-or-project-or-package-link>
```

Existing source path:

```bash
flounder ui
flounder daemon provider login openai-codex
flounder daemon provider check openai-codex

flounder run \
  --target evm-audit \
  --source ./contracts --build-root . \
  --corpus ./docs/specs \
  --map-steps 60 --dig-steps 60 --dig-samples 2 --max-scopes 30
```

Then inspect:

```bash
flounder server finding list --project evm-audit
```

Confirm real candidates:

```bash
flounder confirm ~/.flounder/evm-audit-<timestamp> \
  --source ./contracts --build-root .
```

## Open-World Bounty Audit

Use this when the user permits Flounder to collect public context, official
docs, deployment facts, and bounty scope. Add source paths when you already
have a checkout; the scenario is defined by the allowed open-world context, not
by whether source was pre-supplied.

```bash
flounder ui
# Create a project with source/build paths and a task clue such as:
# "Open-world bounty audit for <project>; collect official docs, deployments, and scope."
# Leave Run after create checked, or later:
curl -X POST http://127.0.0.1:4500/api/projects/<uuid>/runs \
  -H 'content-type: application/json' \
  -d '{"verb":"run"}'
```

## ZK / Proof-System Audit

```bash
flounder run \
  --target zk-circuit-audit \
  --source ./crates/circuit --build-root . \
  --corpus ./docs/circuit-spec \
  --dig-samples 2 --max-scopes 30
```

If map finds a subtle high-value region but rank order is not ideal:

```bash
flounder map --target zk-circuit-audit --source ./crates/circuit --build-root . --corpus ./docs/circuit-spec
flounder audit --scope <id> --source ./crates/circuit --build-root . --dig-samples 3
```

## Incident Investigation

For a suspicious transaction, address, exploit link, or incident clue:

```bash
flounder run <clue>
```

This uses prepare first, then sealed audit, then confirm when possible, then
report generation for reportable bugs. Keep the clue factual; do not put a
theory of the root cause into corpus.

## Dashboard Project Triage

Use the dashboard/API when the user is operating a durable project:

1. Resolve the project UUID from `GET /api/projects`.
2. Open project setup if the overview reports daemon, provider auth, source, or
   prepared-material attention.
3. Use **Run** before the first pipeline run and **Continue** after one exists.
4. Use More actions for Prepare, Map, Dig, Verify, Confirm, and Report when the
   user asks for a precise phase.
5. Archive dormant projects from the project card menu; recover them later from
   Settings -> Archived Projects.

Findings triage:

```bash
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=active'
curl 'http://127.0.0.1:4500/api/projects/<uuid>/findings?tracking=ignored'
```

Mark human-dismissed machine findings as `ignored`, not deleted. Regenerate
selected reports with a project run body like:

```json
{"verb":"report","findingIds":[123,456]}
```

## Verify Existing Suspicions

Write a JSON file:

```json
[
  {
    "title": "suspected issue",
    "location": "src/Foo.sol:120",
    "description": "The suspected security property failure.",
    "exploit_sketch": "How an attacker might trigger it."
  }
]
```

Then run:

```bash
flounder audit --verify claims.json --source ./contracts --build-root .
```

Return each claim as confirmed, refuted, or still suspected. Do not merge these
statuses.
