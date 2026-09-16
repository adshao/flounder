# Pull Request Quality Gates

This document is the canonical merge policy for Flounder. It applies to human
contributors and automation. A green CI run is necessary, but it is not by
itself sufficient approval to merge.

The repository-local maintainer helper is
`.agents/skills/flounder-pr-gate/SKILL.md`. It applies this policy during review
but is intentionally outside the product `skills/` discovery root and the
published npm artifact.

## Decision Model

Every pull request passes three independent gates:

1. **Repository policy** — the change fits Flounder's product direction,
   architecture, safety boundary, and public-release rules.
2. **Deterministic verification** — type checks, tests, packaging checks,
   public-surface scans, and the changed-file quality gate pass at the exact
   pull request head SHA.
3. **Semantic review** — a maintainer examines behavior that automation cannot
   prove, including trust boundaries, completeness, migration safety, and the
   long-term maintenance cost.

A failure in one gate cannot be offset by strength in another. In particular,
security regressions, missing correctness tests, unsafe migrations, leaked
private data, and unverified prompt changes are blockers rather than score
deductions.

## Risk Levels

The deterministic gate assigns the highest applicable level:

| Level | Typical changes | Required review |
| --- | --- | --- |
| Low | Documentation, comments, and non-behavioral metadata | One maintainer; focused checks |
| Medium | Non-executable configuration and contributor-process changes | Maintainer review plus relevant deterministic checks |
| High | Executable source, scripts, skills, dependencies, workflows, containers, agent behavior, prompts, model adapters, command policy, sandboxing, persistence, migrations, and release automation | Explicit maintainer approval, focused tests, and every applicable semantic lens below |

Risk is based on impact, not diff size. A one-line change to an execution or
trust boundary is high risk.

## Non-Compensating Blockers

Do not merge while any of these conditions is true:

- a deterministic CI check fails or did not run at the current head SHA;
- behavior-changing code lacks focused regression coverage;
- a safety, command, sandbox, credential, or model-output boundary is weakened
  without explicit tests proving the intended policy;
- a prompt or agent-control change lacks blind positive and safe/control
  evidence appropriate to its impact;
- a database or persisted-artifact change lacks an upgrade path and upgrade
  test when released data can be affected;
- public files or package contents contain secrets, private material, local
  absolute paths, or machine-specific data;
- a dependency, workflow action, install hook, tracked symlink, or submodule can
  introduce code that is not covered by the repository's immutable integrity
  metadata and review boundary;
- the pull request's head SHA changed after the review evidence was collected;
- an actionable review thread remains unresolved;
- the change is materially outside Flounder's product direction or introduces
  strategy that should remain model-owned.

## Semantic Review Lenses

Apply the lenses selected by `npm run quality:pr`; add others when the diff
crosses more boundaries.

### Product and architecture

- Does the change improve the prepare -> map -> dig -> synthesize -> verify ->
  confirm -> report product rather than creating a one-off scanner?
- Are policy, IO, model prompting, verification, and report rendering kept in
  cohesive modules with narrow typed interfaces?
- Is model/provider selection still runtime-configured and based on pi-mono
  primitives unless a documented technical constraint requires otherwise?

### Completeness and compatibility

- Trace every new enum value, mode, phase, status, provider, or artifact through
  parsing, dispatch, persistence, API/UI rendering, docs, and tests.
- Check old persisted data, interrupted runs, and mixed-version boundaries.
- Exercise platform-sensitive behavior on both Linux and Windows when paths,
  subprocesses, signals, quoting, or executable resolution changed.

### Trust and execution boundaries

- Treat LLM output, corpus files, paths, generated commands, and remote content
  as untrusted input.
- Confirm that all model-generated execution still passes through the shared
  sandbox and command-safety policy.
- Confirm that sealed phases remain network-sealed and that open-world confirm
  cannot broadcast, move funds, write to live systems, or expose host secrets.
- Require execution evidence for confirmation; assertions and mocked trusted
  components cannot promote a finding.

### Supply chain and downstream runtime

Assume an attacker can submit a plausible contribution and wants a fork user,
maintainer, CI runner, or release consumer to execute it later.

- Treat every executable source file, package/build script, workflow, action,
  container, skill, prompt, dependency manifest, and lockfile as high risk.
- Reject root package install/Git-preparation/packaging hooks, unreviewed
  dependency install scripts, Git/URL/local-path dependencies, mutable GitHub
  Action references, unprotected fork CI secrets, write permissions,
  self-hosted fork runners, direct event-data shell interpolation, tracked
  symlinks, and submodules.
- Forbid repository-local GitHub Actions. Their nested manifests create a
  second executable dependency graph that is easy to miss during workflow-only
  review; keep CI logic visible in the reviewed workflow and repository scripts.
- Keep repository dependency lifecycle scripts disabled by default through
  `.npmrc`; do not ask fork contributors to override that protection.
- Forbid every implicit npm install, Git-dependency preparation, and packaging
  lifecycle entry point. Releases must build explicitly before packing; a fork
  must not gain execution merely because a user installs it from Git.
- Publish `npm-shrinkwrap.json`, require integrity for every resolved registry
  artifact (including dev and optional entries), and pin production dependency
  versions exactly so package consumers receive the reviewed dependency graph.
- Require every dependency that declares an install script, including dev and
  optional dependencies, to match an exact path, version, integrity hash, and
  rationale in `supply-chain-allowlist.json`. The allowlist documents reviewed
  metadata; repository and CI installs still disable script execution. Seek a
  script-free dependency first and treat any allowlist expansion as a high-risk
  policy change.
- Do not claim that the published package can enforce the repository `.npmrc`.
  A consumer's ordinary npm install may execute allowlisted transitive hooks.
  The supported no-execution path is `npm install --ignore-scripts flounders`,
  and the package contract must validate the exact tarball through that path.
- Require each workflow action to match an exact repository, commit SHA,
  release version, source URL, and rationale in the same allowlist. A 40-byte
  SHA proves immutability, not publisher trust.
- Bind every complete workflow file to an exact SHA-256 digest in the protected
  allowlist. Reject new, removed, or changed workflows unless that exact byte
  sequence was pre-authorized; this closes unmodeled shell, permission, secret,
  container-option, and artifact-mutation paths rather than trying to enumerate
  every possible YAML bypass.
- A pull request cannot expand its own allowlist. Compare the candidate with
  the trusted base allowlist; provenance-approved additions must land as a
  maintainer-authored policy change before the dependent contribution.
- Review new network access, subprocesses, filesystem writes, environment or
  credential reads, dynamic loading, native binaries, and generated code as new
  runtime capabilities. Trace who controls the inputs and where data can leave.
- Run fork PR code only on ephemeral GitHub-hosted runners with read-only
  repository permission, no repository secrets, no persisted checkout token,
  and dependency lifecycle scripts disabled.
- Before release, execute the packed artifact contract, scan the public
  surface, audit production dependencies, and publish a SHA-256 checksum and
  CycloneDX SBOM generated from the final packaging tree beside the artifact.
- Build release output inside a disposable, read-only-root container with
  networking disabled and no host socket or credential mounts. Terminate the
  candidate build before a separate trusted packaging step copies only its
  validated `dist` output into a fresh source tree. Require every packaged
  non-`dist` byte, including `package.json`, `npm-shrinkwrap.json`, scripts,
  skills, prompts, and policy, to exactly match the reviewed source. Upload the
  sealed tarball before executing it; validate only a downloaded copy in a
  separate job so validation cannot rewrite the uploaded object.
- A dependency-update bot reduces staleness but does not create trust. Review
  its diffs, integrity changes, ownership changes, release history, and runtime
  capability changes like any other high-risk contribution.

### Prompt changes

- Keep strategy model-owned. Prompts may define capabilities, evidence bars,
  safety boundaries, output contracts, and release gates.
- Keep regression inputs blind and free of answer-bearing names, comments,
  fixtures, corpus, or harness instructions.
- Compare the candidate with the baseline under the same model, provider,
  fixture set, scorer, and run order. Use repeated samples for material changes
  and require safe/control cases to remain clean.

### Public release

- Public-facing text is English.
- Package contents contain only intentional public assets.
- Maintainer-only agent instructions stay under `.agents/skills/`; they must
  not be discoverable through the product `skills/` root or shipped in the npm
  artifact.
- No secret, credential, private URL, local username, absolute local path,
  customer data, private corpus, run output, cache, or generated report enters
  the diff, artifact, commit message, tag, or release note.

## Repeatable Review Workflow

1. Snapshot the base and head SHAs. Review and test those immutable revisions.
2. Use an isolated worktree when the current checkout is dirty or belongs to
   another task.
3. Read the pull request description, linked issue, existing discussion, and
   the complete diff. Inspect related call sites outside the diff when checking
   completeness.
4. Run the deterministic gate:

   ```bash
   node <trusted-base>/scripts/pr-quality-gate.mjs --base-ref <base-sha> --head-ref <head-sha>
   node <trusted-base>/scripts/check-supply-chain.mjs \
     --root <candidate-worktree> \
     --baseline-root <trusted-base>
   ```

   A worktree protects unrelated changes but does not isolate execution. Run
   gate code and allowlist from the trusted base revision. A candidate cannot
   self-authorize a new action, workflow digest, container image, or dependency
   install script. Execute candidate builds and tests only in the required
   ephemeral, secret-free hosted CI or a disposable
   no-credential sandbox built independently from the candidate tree. Never run
   candidate code with the maintainer's HOME, agent/provider credentials, SSH
   material, cloud credentials, package credentials, or container socket.
   Inside that safe execution boundary, install with `npm ci --ignore-scripts`
   and run `npm run verify` against the candidate.

5. Apply every reported semantic lens. Record findings with severity,
   confidence, exact location, impact, and a concrete fix direction.
6. Re-read the head SHA immediately before publishing a review. If it changed,
   discard the stale verdict and repeat the affected checks.
7. Re-review only after the contributor updates the pull request. Map each
   prior blocker to its resolution and rerun the full deterministic gate.

## Review Outcomes

- **Approve** — all gates pass at the current head SHA and no unresolved
  blocker remains.
- **Request changes** — at least one reproducible blocker remains. Prefer inline
  comments for exact code defects and a concise summary for cross-cutting risk.
- **Comment** — questions or non-blocking improvements only. Do not use a
  comment-only review when a known blocker exists.

Reviewing is read-only by default. Publishing a GitHub review, approving,
requesting changes, merging, or changing repository rules requires explicit
authorization for that action. Before publishing, confirm the authenticated
GitHub account and use an idempotency marker tied to the reviewed head SHA so a
retry does not post a duplicate review.

## GitHub Enforcement

Repository rules should require the Linux verification job, Windows
compatibility job, resolved review threads, fresh approval after the latest
push, and code-owner review for high-risk paths. The repository-local Trusted
PR Policy job inspects the candidate with a protected-base copy of the gate and
allowlist, but it is defense in depth only: a pull request can also edit the
workflow that creates that status.

Before treating an automated policy result as a merge authority, configure its
status reporter outside the candidate repository: an organization-required
workflow sourced from a separately protected repository, or a GitHub App with
equivalent isolation. Require that external status in the repository ruleset.
Until this external root of trust is active, running the trusted-base commands
in the repeatable workflow and recording their output is a mandatory human
merge gate. CODEOWNERS is also defense in depth, not a root of trust. Enable
newly introduced required checks only after their trusted reporter is active;
enabling absent checks can make every pull request unmergeable.

Workflow changes use a staged maintainer ceremony: calculate and review the
exact proposed workflow bytes offline, add that digest beside the still-valid
current digest in a policy-only change, then land only the byte-identical
workflow. Remove the retired digest afterward. Because ordinary candidates are
not allowed to expand this list, the policy-only change requires an explicitly
recorded code-owner approval and an authorized ruleset bypass; never grant that
bypass to contributor automation.
