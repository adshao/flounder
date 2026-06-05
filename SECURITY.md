# Security Policy

`full-stack-auditor` is built for authorized white-hat source auditing. It can help produce high-impact vulnerability hypotheses, so project use and contributions must preserve the safety boundary.

## Supported Use

- Audit only code you own, code you are engaged to audit, or code that is explicitly in a public bug-bounty scope.
- Verification must stay local-only: unit tests, regtest, devnet, forked nodes, or isolated fixtures.
- Do not broadcast transactions or run exploit flows against public testnet or mainnet.
- Reproductions should prove the invariant break at the smallest scale needed for maintainers to fix it.
- Reports should be private disclosure drafts, not public exploit guides.

## Built-In Guardrails

The pi extension installs a command safety policy for bash tool calls and direct user bash commands. It blocks commands that combine public live-network wording with exploit/broadcast/value-transfer actions.

This guardrail is intentionally conservative, but it is not a complete sandbox. Treat it as a backstop, not as authorization to run risky commands.

## Reporting Vulnerabilities in This Project

Do not open a public issue for a vulnerability that could help misuse the framework or bypass its guardrails.

Instead, contact the maintainers privately. If the repository has no private security contact yet, open a public issue that says only: "I have a security report for the maintainers. Please provide a private contact." Do not include exploit details.

## Dependency Security

Run:

```bash
npm audit --audit-level=moderate
```

Before publishing a release or accepting dependency updates.

## Sensitive Data Hygiene

Run:

```bash
npm run check:public
```

Before committing or publishing. The public repository, package contents, commit messages, and generated public artifacts must not contain credentials, private keys, local absolute paths, private URLs, customer data, or machine-specific paths. If sensitive data enters Git history, rotate the affected secret when applicable and rewrite the history before publication.
