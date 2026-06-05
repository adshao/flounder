# AGENTS.md

## Project Defaults

- Treat this repository as a public open-source project by default.
- External-facing content must be written in English. This includes README files, docs, CLI help, security policy, contribution notes, prompts, package metadata, and generated public reports.
- Use TypeScript as the default implementation language.
- Use pi-mono primitives by default for agent/runtime integration, especially `pi-ai` and `pi-coding-agent`. Choose a different framework only when there is a concrete technical reason and document that reason.
- Keep the architecture ready for future coding-agent use cases. Separate ingestion, source indexing, checklist enumeration, audit workers, verification, reporting, and security policy guardrails.
- Prefer typed interfaces, schema validation, deterministic tests, and small extension points over ad hoc agent logic.

## Security And White-Hat Boundaries

- Audit only code that is authorized by the owner or explicitly in public bug-bounty scope.
- Verification must run locally or in a sandbox. Use unit tests, fixtures, local devnets, forked nodes, or isolated harnesses.
- Never broadcast transactions, exploit public networks, or target systems outside the authorized scope.
- Treat LLM output as untrusted input. Validate structured output, sanitize paths, and never execute generated commands without policy checks.
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
