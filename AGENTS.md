# AGENTS.md

## Project Defaults

- Treat this repository as a public open-source project by default.
- External-facing content must be written in English. This includes README files, docs, CLI help, security policy, contribution notes, prompts, package metadata, and generated public reports.
- Use TypeScript as the default implementation language.
- Use pi-mono primitives by default for agent/runtime integration, especially `pi-ai` and `pi-coding-agent`. Choose a different framework only when there is a concrete technical reason and document that reason.
- Keep model/provider selection runtime-configured. Do not assume every model family is available through every pi provider; use `codex-cli` only as an explicit local fallback when the user selects it.
- Keep the architecture ready for future coding-agent use cases. Separate ingestion, source indexing, checklist enumeration, audit workers, verification, reporting, and security policy guardrails.
- Prefer typed interfaces, schema validation, deterministic tests, and small extension points over ad hoc agent logic.
- Treat deterministic project profiles, source indexes, checklist seeders, and lens packs as planning aids only. They may route attention, but they must not produce vulnerability findings.
- When new learning materials appear during a specialized audit, study the target domain first so the audit has the required protocol, cryptography, proof-system, financial, or application-specific expertise before running or finalizing the audit.
- In live audits, prefer a project reconnaissance stage that lets the model propose dynamic lens packs from the target's assets, trust boundaries, invariants, and attacker model before checklist enumeration.
- Treat `rounds` and `trials` as different mechanisms. Rounds must generate novel checklist coverage from prior observations; trials independently audit one item for stochastic agreement.
- Later exploration rounds must use duplicate filtering and coverage deltas. Do not call repeated single-pass audits "multi-round" unless they add new source-grounded audit items.
- Let project-specific configuration add context, lens packs, failure modes, and auditor agents without modifying core code.
- For blind proof runs, disable deterministic checklist seeders so the model must enumerate the relevant audit item itself before any audit trial can produce a finding.

## Thin-Layer Agentic Mode

- The framework has two drivers: `fsa hunt` (thin agentic) and `fsa run` (staged pipeline). Keep both working over the shared substrate (ingestion, `src/security/sandbox.ts`, verification, reporting, project history, command-safety policy).
- In agentic mode the framework provides capabilities and guarantees, not strategy. A new component is justified only if it gives the model an affordance it lacks (read/search source, run an isolated local test, recall prior runs) or a guarantee the model cannot self-provide (execution confirmation, sandbox isolation, command safety, durable replayable state). Do not add taxonomy, domain playbooks, or search schedules to the hunt path; if a human prior is useful, expose it as an optional model-callable tool, not as injected prompt preamble.
- Keep the one hard opinion: a claim is not a finding until a local test confirms it. `report_finding` may only reach `confirmed-executable` by citing a `run_test` that actually passed. Never let the model upgrade confirmation by assertion.
- All generated-test execution must route through the shared sandbox module and the command-safety policy. Verification stays local-only.
- Prefer making hunt mode benefit from stronger models without framework changes. Resist re-introducing framework-side direction of how the model should reason.

## Security And White-Hat Boundaries

- Audit only code that is authorized by the owner or explicitly in public bug-bounty scope.
- Verification must run locally or in a sandbox. Use unit tests, fixtures, local devnets, forked nodes, or isolated harnesses.
- After confirming that a bug exists in a mainnet deployment, perform a final known-issue check before treating it as submission-ready. Check existing audit reports, public disclosures, current GitHub development branches, pull requests, issues, and relevant security advisories to confirm the bug is not already known, fixed, or publicly documented.
- Never broadcast transactions, exploit public networks, or target systems outside the authorized scope.
- Treat LLM output as untrusted input. Validate structured output, sanitize paths, and never execute generated commands without policy checks.
- Treat model-generated lens packs as untrusted planning artifacts. Normalize, bound, log, and review them before using them as audit guidance.
- Default to deny for commands that combine network access with exploit, broadcast, credential, destructive, or persistence behavior.
- Keep audit artifacts private by default. Redact them before sharing outside the trusted project context.

## Public Release Hygiene

- This rule applies to every committed file, generated file intended for publication, package artifact, commit message, tag, and release note.
- Do not commit secrets, passwords, tokens, API keys, private keys, credentials, private URLs, customer data, internal hostnames, local usernames, local absolute paths, or machine-specific paths.
- Do not include local paths in generated reports, traces, snapshots, tests, package metadata, examples, or documentation. Use repository-relative paths or explicit placeholders.
- Do not commit private reference material, source corpora, PDFs, local scaffolds, run output, build output, caches, or dependency folders unless they are intentionally safe for publication.
- Keep ignore rules strict enough that local-only inputs and generated artifacts stay out of the public repository.
- Before publishing or committing release candidates, run the full verification suite and a public-surface scan for secrets and local paths.
- If sensitive data ever reaches Git history, do not merely delete it in a later commit. Rotate the affected secret if applicable, rewrite the history before publishing, and verify the cleaned history before pushing.

## Code Quality Bar

- Design for maintainability, extension, and security review. Public APIs should be narrow, documented, and typed.
- Keep modules cohesive and avoid mixing policy, IO, model prompting, and report rendering in the same component.
- Add tests for behavior that affects audit correctness, command safety, artifact contents, path redaction, or public packaging.
- Prefer deterministic mock-mode tests for CI and explicit opt-in for live model/provider calls.
- Keep examples safe by default. They should work without credentials unless they clearly document an opt-in live path.

## Git And Packaging

- Assume every commit may become public. Commit messages, branch names, tags, package contents, and generated changelog text must not contain sensitive or machine-specific information.
- Review package contents before release. The package should contain source, compiled outputs, docs, prompts, skills, fixtures intended for publication, and license/security files only.
- Do not rely on later cleanup to protect secrets. Prevent them from entering Git, package archives, run artifacts, and logs in the first place.
