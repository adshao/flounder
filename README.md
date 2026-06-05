# full-stack-auditor

White-hat full-stack security audit agent framework inspired by the Orchard incident workflow.

This implementation is TypeScript-first and uses pi-mono as the agent/runtime integration point. The audit core stays framework-light so it can run as a batch CLI, a pi package extension, a coding-agent workflow, or a future UI/RPC service.

## Design

The important lesson from the Orchard writeup is the shape of the workflow:

1. Load source, specs, papers, books, and implementation notes.
2. Enumerate concrete audit items before looking for bugs.
3. Route each item to a specialized failure-mode agent.
4. Run multiple independent trials per item.
5. Aggregate by severity, hit rate, confidence, and evidence quality.
6. Verify findings separately, in local sandbox-only tests.
7. Keep a complete audit trail of prompts, model outputs, artifacts, and events.

## Why pi-mono

pi already provides the pieces this project will need if it grows into a coding agent:

- `@earendil-works/pi-ai` for multi-provider LLM calls.
- `@earendil-works/pi-coding-agent` for SDK sessions, tools, extensions, skills, prompts, and RPC mode.
- Project-local `.pi` style extensibility through package manifests.

The framework therefore exposes both:

- a normal CLI: `fsa run ...`
- a pi package: `package.json` declares `src/pi/extension.ts`, `skills/`, and `prompts/`

## Install

```bash
npm install
npm run build
npm test
```

For live model runs, configure provider credentials in your shell or secret manager according to the pi-ai provider documentation. Do not commit credentials, local environment files, or machine-specific paths.

## Dry Run

```bash
npm run dry-run
```

This reads local source and emits heuristic checklist items without calling a model.

## Mock End-to-End Run

```bash
npm run mock-run
```

This runs the full pipeline with a deterministic mock LLM: enumeration, audit trials, aggregation, verification, report generation, and audit-trail logging. It is the no-API-key smoke test.

## Full Run

```bash
fsa run \
  --target orchard \
  --source ./halo2/halo2_gadgets/src \
  --corpus ./specs ./halo2-book \
  --provider anthropic \
  --audit-model claude-opus-4-8 \
  --trials 4
```

Artifacts are written under `runs/<target>-<timestamp>/`.

## Public Release Check

```bash
npm run check:public
```

This scans the public source surface for local absolute paths and high-confidence secret patterns. It is also part of `npm run verify`.

## Blind Discovery Check

```bash
npm run check:blind-discovery
```

This runs a dry-run audit against a neutral halo2 scalar-multiplication fixture and asserts that the framework autonomously enumerates a generic missing-constraint checklist item without target-specific hints.

## Pi Package Usage

Try the package locally from this directory:

```bash
pi -e .
```

The extension registers `fsa_run_audit`. It defaults to `dryRun: true`, so the first call only uses local static seeders. It also blocks bash commands that combine public live networks with exploit/broadcast-style operations.

## Outputs

Each run writes:

- `checklist.json`: enumerated audit items.
- `audit_results.json`: per-item, per-trial findings.
- `summary.json`: ranked finding summary and coverage.
- `verifications.json`: independent local-only verification notes.
- `report_<id>.md`: private disclosure drafts for top findings.
- `events.jsonl` and `calls/*.json`: audit trail for coverage analysis.

## Library API

The package exports the core pipeline and extension points:

```ts
import { defaultConfig, runPipeline, MockAuditLlmClient } from "full-stack-auditor";

const cfg = defaultConfig();
cfg.targetName = "example";
cfg.sourcePaths = ["./fixtures"];

const result = await runPipeline(cfg, { llm: new MockAuditLlmClient() });
console.log(result.runDir);
```

Use `full-stack-auditor/pi/extension` for the pi package extension entrypoint.

## Extending Audit Agents

Custom audit agents can be added through `AuditorConfig.auditorAgents`. Their `failureMode` values are automatically merged into the enumeration prompt and used by the audit runner when matching checklist items:

```ts
const cfg = defaultConfig();
cfg.auditorAgents = [
  {
    failureMode: "custom_constraint_system",
    id: "custom-constraint-system-auditor",
    displayName: "Custom Constraint System Auditor",
    guidance: "Trace assigned witnesses to enforced equations in the target DSL.",
  },
];
```

The built-in agents remain the default registry, so custom agents can be added incrementally.

## White-Hat Rules

- Audit only authorized code or public bug-bounty scope.
- Verification must be local only: unit tests, regtest, devnet, or forked node.
- Never broadcast or execute against public testnet/mainnet.
- Build the smallest reproduction needed to prove the invariant break.
- Report privately and coordinate disclosure.

## Contributing and Security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
