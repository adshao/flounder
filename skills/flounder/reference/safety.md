# Flounder safety reference

Read this when the task involves authorization, sandbox choice, executable
confirmation, real-target confirmation, public disclosure, or generated reports.

## Authorization

Create projects and run sealed local audits only against publicly available
source, the user's own code, client-authorized targets, or public bug-bounty
scope. If the source boundary is unclear, ask before launching model work.

For public-source audits without a bounty, treat findings as private white-hat
research: verify locally, avoid live-system writes, and disclose through a
maintainer or security contact before sharing details.

Do not broadcast transactions, move funds, submit writes, persist access, or
target systems outside the declared local audit boundary or explicit authorized
scope. In confirm mode, replay exploits only against local tests, local forks,
or isolated harnesses.

## Sandbox Boundary

Model-generated code, PoCs, dependency installs, and tests run in a copied
workspace. Do not mutate the host checkout or run model-generated tests directly
on the host.

Use the OCI sandbox for real audits:

```bash
npm run sandbox:build
flounder run --source ./src --build-root . --sandbox-image flounder-sandbox:latest
```

Host execution is trusted-local fallback only:

```bash
flounder run --source ./src --build-root . --sandbox-backend host --allow-host-execution
```

Warn the user before host fallback because it lacks kernel-level filesystem and
network isolation.

## Evidence Ladder

Do not present model suspicions as bugs. Keep these states distinct:

- `suspected`: plausible but not execution-proven, or downgraded by refutation.
- `confirmed-executable`: a cited local confirmation command triggered the bug.
- `confirmed-differential`: the exploit ran and the minimal fix blocked it.
- `reproduced`: confirm reproduced the finding against real-world ground truth.
- `not-reproduced` or `refuted`: the claim failed under attacker-real execution.
- `submit-candidate`: reproduced, scoped, and ready for human disclosure gates.

Findings should cite command evidence, PoC/test paths, differential results,
refutation or appeal outcomes, confirm decisions, report paths, and remaining
human gates.

## Corpus Hygiene

Use project-owned official specs, docs, whitepapers, prior audits, design notes,
or strictly factual incident briefs as corpus. Corpus is context, not an answer.

Do not write answer-bearing materials that include the suspected bug, exact
location, mechanism, exploit recipe, historical incident name, transaction hash,
or report title when measuring blind recall. For incident investigation, keep the
clue factual and let Flounder derive the mechanism.

## Public Release Hygiene

Do not publish secrets, tokens, credentials, private URLs, customer data, local
absolute paths, private corpora, raw run artifacts, build output, caches, or
dependency folders.

Generated reports intended for disclosure should use repository-relative paths
or explicit placeholders, include only scoped evidence, and exclude private run
material unless explicitly reviewed for publication.
