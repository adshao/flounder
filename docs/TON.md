# Optional TON / FunC Notes

TON support is a verification-environment extension, not a separate Flounder
product mode and not a framework-owned audit strategy. The agent still decides
what to read, suspect, test, and report; the framework supplies the native tools
needed to run local TON contract tests.

## What The Profile Adds

- A curated sandbox image for TON Blueprint projects, including Blueprint,
  FunC, Tolk, Tact, `@ton/core`, and `@ton/sandbox`.
- Prepare warm-up for Blueprint workspaces: Flounder detects
  `blueprint.config.*` or `tact.config.json` and runs `blueprint build --all`
  after package-manager dependency installation.
- Command-policy support for local TON build and test commands without allowing
  live-network deployment or wallet-based scripts in sealed audit phases.

## Example

Build the baseline and TON sandbox images:

```bash
npm run sandbox:build
npm run sandbox:ton:build
```

Run a source-provided audit against a Blueprint/FunC workspace:

```bash
flounder run \
  --target ton-contract-audit \
  --source <target>/contracts <target>/wrappers <target>/tests \
  --build-root <target> \
  --corpus <target>/README.md <target>/docs <target>/audits \
  --sandbox-image flounder-sandbox:ton \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --thinking xhigh
```

For a narrow bounty scope such as a small set of `.fc` contracts, keep `--source`
focused on the in-scope files and wrappers, but set `--build-root` to the
project root so Blueprint can compile imports and run tests.

## Local Reproduction

Blueprint compiles FunC, Tolk, or Tact contracts and runs TypeScript tests
against an in-process TON sandbox. In sealed `run --source`, `map`, and `audit`
phases, reproduction must stay local: no mainnet/testnet scripts, no TonConnect
deployment flow, no mnemonic provider, and no writes to a live endpoint.

Allowed local build/setup commands include:

- `blueprint build --all`
- `npx blueprint build --all`
- `yarn blueprint build --all`
- `func-js <local files>`
- `tolk-js <local files>`
- `tact --config tact.config.json`

Allowed local confirmation commands include:

- `blueprint test`
- `npx blueprint test`
- `yarn blueprint test`
- `npm test` or `yarn test` when the package's tests are local Blueprint/Sandbox
  tests

Build commands are not confirmation-eligible. A finding reaches
`confirmed-executable` only when a local test command runs with
`purpose=confirm`, exits as expected, and matches verifier-owned success
patterns.

## Input Checklist

Load as much source-backed context as possible:

- In-scope `.fc`, `.tolk`, `.tact` files, plus shared imports.
- `blueprint.config.ts` / `.js` / `.cjs` / `.mjs`, `tact.config.json`,
  `package.json`, lockfiles, wrappers, compilables, and tests.
- Protocol specs, opcode/message formats, storage layouts, prior audits, and
  exact bounty scope declarations.
- Deployment scripts and live addresses as context only; sealed confirmation
  must use local Blueprint/Sandbox tests.
