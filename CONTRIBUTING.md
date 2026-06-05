# Contributing

Thanks for helping improve `full-stack-auditor`.

## Development Setup

```bash
npm install
npm run check
npm test
```

Useful local gates:

```bash
npm run dry-run
npm run mock-run
npm run check:public
npm run verify
```

## Architecture Rules

- Keep the audit engine independent of `@earendil-works/pi-coding-agent`.
- Put pi-specific code under `src/pi/` and LLM provider adapters under `src/llm/`.
- Add new audit lenses through `src/agents/registry.ts`.
- Add static discovery rules under `src/seeders/`.
- Keep verification local-only and report-oriented.
- Preserve structured run artifacts so audits remain explainable and reproducible.

## Safety Rules

- Do not add code that broadcasts, transfers, drains, mints, or submits transactions to public networks.
- Do not add prompts that ask for weaponized exploit code.
- Do not weaken the live-network command guardrail without adding stronger coverage.
- Use deterministic mock tests for pipeline behavior; real provider tests should be opt-in and must not require secrets in CI.
- Do not add local absolute paths, credentials, private URLs, customer data, or machine-specific paths to source, docs, prompts, tests, examples, package metadata, or generated public artifacts.
- If sensitive data reaches Git history, rotate the affected secret when applicable, rewrite history before publication, and verify the cleaned history before pushing.

## Pull Request Checklist

- `npm run check` passes.
- `npm test` passes.
- `npm run dry-run` passes.
- `npm run mock-run` passes.
- `npm run check:public` passes.
- Public-facing text is English.
- The diff and commit messages contain no local absolute paths or obvious secrets.
- New safety-sensitive behavior has tests.
- New output artifacts are documented in `README.md`.
