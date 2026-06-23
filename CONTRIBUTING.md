# Contributing

Thanks for helping improve `flounder`.

Flounder is a public open-source project. Public-facing text, examples, package metadata, CLI help, reports, and generated docs must be English and must not contain secrets, local absolute paths, private URLs, customer data, or machine-specific details.

## Development Setup

Use Node 22 LTS. This repository includes `.nvmrc` and `.node-version` pinned to
22.20.0.

```bash
nvm use
npm install
npm run build
npm run check
npm test
```

Useful local gates:

```bash
npm run mock-audit
npm run check:public
npm run verify
```

`npm run check:public` scans the current tree plus the latest commit for secrets,
local absolute paths, and machine-specific values. To make Git run the commit-only
variant after each local commit:

```bash
npm run hooks:install
```

`npm run sandbox:build` builds the default OCI sandbox image used for model-generated command execution.

## Product Direction

Flounder is an autonomous white-hat security auditor. The product should stay centered on the prepare -> map -> dig -> confirm workflow:

- prepare authorized source, corpus, dependency closure, and deployment-match evidence;
- map the audit surface without producing findings;
- dig selected scopes with local proof tests;
- confirm reproduced findings against real-world ground truth under the white-hat no-broadcast policy.

Do not position Flounder as a scanner for one technology stack. Solidity/EVM and ZK/proof-system audits are high-signal target classes to document clearly, but they remain optional context examples, not hard-coded product modes. Avoid promoting rare stacks as core product positioning.

## Architecture Rules

- Keep the audit kernel independent from the control plane and UI. A run launched by the CLI, dashboard, API, or pi extension should produce the same core artifacts.
- Use pi-mono primitives for agent/runtime integration unless there is a concrete technical reason not to, and document the reason.
- Keep provider/model/thinking selection runtime-configured. Do not assume a model is available through every provider.
- Treat provider credentials as daemon-local. The control plane stores provider profiles and routes jobs; daemons execute jobs and own local auth.
- Add a default audit component only when it gives the model an affordance it lacks or a guarantee it cannot enforce: source loading, sandboxed tools, command safety, path redaction, durable replay, execution confirmation, refutation, provenance, or reporting.
- Do not add default bug-class rules, stack-specific schedules, hidden checklists, or target-specific priors to the audit path. If context is useful, expose it as explicit corpus, an optional profile, or a model-callable extension.
- Keep map/dig coverage resumable. A budget cutoff or killed run must not silently drop scopes.
- Preserve structured run artifacts so audits remain explainable, replayable, and safe to review.

## Safety Rules

- Audit only authorized source code and public bug-bounty scope.
- Do not add code or prompts that broadcast, transfer, drain, mint, submit transactions, persist access, or write to live systems.
- Do not weaken the command guardrails without adding stronger tests. `flounder run` is network-sealed; `flounder confirm` may fork/read/fetch/search but must still block live broadcast and other out-of-scope writes.
- Treat model output as untrusted input. Validate structured output, sanitize paths, and gate model-generated commands through policy.
- Confirmation must be execution-grounded. The model cannot upgrade a claim by assertion.
- Use deterministic mock tests for CI behavior. Live provider tests should be opt-in and must not require secrets in CI.
- Do not commit local corpora, run outputs, caches, dependency folders, or generated private reports unless they are intentionally safe for publication.
- If sensitive data reaches Git history, rotate the affected secret when applicable, rewrite history before publication, and verify the cleaned history before pushing.

## Pull Request Checklist

- `npm run check` passes.
- `npm test` passes, or the PR explains the environment limitation.
- `npm run mock-audit` passes when audit behavior changed.
- `npm run check:public` passes before public-facing changes land.
- Public-facing text is English and product positioning is stack-agnostic.
- The diff and commit messages contain no local absolute paths or obvious secrets.
- New safety-sensitive behavior has tests.
- New output artifacts or user-facing workflow changes are documented in `README.md` and `docs/USAGE.md`.
