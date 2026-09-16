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

Model-generated commands run in a copied workspace through the configured sandbox backend. Sealed audit commands have no external network; open-world prepare/confirm commands receive egress only when they match an explicit read/fork/fetch capability such as a read-only HTTP request, HTTPS Git fetch, chain read, or local-fork test. Arbitrary model-selected programs remain network-sealed. Foundry FFI is disabled, target-source files are immutable to the model, and public-network broadcast remains denied.

The command policy is defense in depth, not a substitute for process isolation. The default OCI/Apple-container backends enforce the filesystem and network boundary. The explicit `host --allow-host-execution` escape hatch cannot provide kernel-level isolation and is only for trusted deterministic fixtures, never untrusted dependencies or real model-generated exploit code.

## Reporting Vulnerabilities in This Project

Do not open a public issue for a vulnerability that could help misuse the framework or bypass its guardrails.

Instead, contact the maintainers privately. If the repository has no private security contact yet, open a public issue that says only: "I have a security report for the maintainers. Please provide a private contact." Do not include exploit details.

## Dependency Security

Run:

```bash
npm run check:supply-chain
npm audit --omit=dev --audit-level=high
```

Before publishing a release or accepting dependency updates.

Flounder treats downstream execution as a primary threat boundary. A fork user
may install, build, start the control plane, load a skill, or run an audit with
provider credentials present. Contributions must not add install lifecycle
hooks, mutable workflow dependencies, privileged fork CI, hidden dependency
sources, or unreviewed access to credentials, the network, subprocesses, or the
host filesystem. The pull request policy and enforcement details live in
[`docs/QUALITY_GATES.md`](docs/QUALITY_GATES.md).

The published npm shrinkwrap pins the reviewed transitive registry graph.
Candidate pull requests are checked against the protected base allowlist, so a
contributor cannot authorize its own workflow bytes, action, container, or
dependency lifecycle script. Every workflow file is also bound to an exact
protected SHA-256 digest, causing any inserted host step, permission, secret,
mount, or artifact mutation to fail closed.

The repository `.npmrc` disables dependency lifecycle scripts for clone and
fork development installs. Do not override it on an unreviewed branch.

An npm package cannot force a consumer's client to honor the repository
`.npmrc`. Install the published package with lifecycle scripts disabled:

```bash
npm install --ignore-scripts flounders
```

A normal npm install may execute the exact transitive dependency hooks recorded
in `supply-chain-allowlist.json`; the current graph includes platform selection
and generated-code hooks inherited from pi-mono dependencies. The shrinkwrap
and allowlist make those artifacts reviewable, but do not turn ordinary npm
installation into a no-execution boundary.

Release artifacts include `SHA256SUMS` and a CycloneDX SBOM. Consumers should
compare the package checksum with `SHA256SUMS`, review the SBOM and source diff,
and avoid running unreviewed fork branches with real provider credentials or
host execution enabled.

Release builds run after dependency installation inside a digest-pinned,
network-denied container with a read-only root, dropped capabilities, and no
host container socket. Candidate build code can export only `dist`; after that
container terminates, a separate container packs a fresh source tree and the
verifier requires every packaged non-`dist` byte to exactly match the reviewed
source. The uploaded package is verified from a downloaded copy in another job,
so package execution cannot rewrite the uploaded object.

## Sensitive Data Hygiene

Run:

```bash
npm run check:public
```

Before committing or publishing. The public repository, package contents, commit messages, and generated public artifacts must not contain credentials, private keys, local absolute paths, private URLs, customer data, or machine-specific paths. If sensitive data enters Git history, rotate the affected secret when applicable and rewrite the history before publication.
