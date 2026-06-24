# Security Policy

`flounder` is built for white-hat source auditing. It can help produce high-impact vulnerability hypotheses, so project use and contributions must preserve the safety boundary.

## Supported Use

- You may create projects and run sealed local audits for source code that is publicly available, code you own, code you are engaged to audit, or code that is explicitly in a public bug-bounty scope.
- Treat public-source audits without a bug bounty as private white-hat research: keep verification local, do not interact with live systems except by read-only access or local forks, and disclose privately to maintainers before sharing details.
- `flounder run` verification stays local-only and network-sealed: unit tests, regtest, devnet, forked nodes, or isolated fixtures.
- `flounder confirm` may fork and read a live network/data to reproduce a finding locally, but it must never broadcast a transaction to a non-local network or write to any live system — replay the exploit against a local fork only.
- Never broadcast transactions or run exploit flows against a public testnet or mainnet, in either command.
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
