# Prompt Regression Fixtures

These fixtures are minimized, public-safe targets derived from local known-bug evidence. They are intentionally not copies of private run artifacts, transcripts, or full target repositories.

The regression goal is two-part:

1. The default audit prompts must preserve general capabilities needed to rediscover the bug classes: obligation derivation, trusted-value binding, canonical decoding, sink authorization, and attacker-real PoC construction.
2. The default prompts must not hard-code the known answers, target names, contract names, dates, or local run artifacts.

Live model comparison can use these source files as small replay targets. CI keeps the cheaper static contract: prompt capabilities are present, known-answer terms are absent, and the replay fixtures exist.

The tracked data is intentionally distilled:

- `positiveFixtures` are minimized vulnerable shapes for live prompt recall tests.
- `negativeFixtures` are similar safe shapes that should be discharged, not reported.
- `controlFixtures` model prompt-safety boundaries such as unfaithful verifier stubs or owner-only capabilities.
- `expected-artifacts/*-pass.md` and `*-fail.md` test the scorer itself.

Do not add raw `runs/` artifacts, private reports, full target checkouts, transcripts, or exploit-ready production PoCs here. Extract the general bug class into a small public-safe fixture instead.

## Live Eval Harness

Inspect the replay plan without model calls:

```sh
node scripts/prompt-regression-eval.mjs --dry-run --samples 1 --variant current
node scripts/prompt-regression-eval.mjs --dry-run --fixture-set all --samples 1 --variant current
```

Run a low-sample live eval against the current prompt build:

```sh
node scripts/prompt-regression-eval.mjs --live --variant current --samples 1 --max-steps 30
```

For A/B comparison, run the same command on the baseline checkout with
`--variant baseline`, then on the candidate checkout with `--variant current`.
The script writes each run's `prompt_regression_score.json` and an aggregate
`prompt_regression_summary_<variant>.json` under the selected output directory.

The score is intentionally not a bug bounty verdict. It only answers whether the
artifact contains the generic signals the known-bug evidence requires. A passing
score still needs human review of the transcript and any PoC realism; a failing
score means the prompt failed to surface at least one required capability signal
for that case.

Negative/control fixtures invert the scoring target: they pass when the artifact
does **not** satisfy the positive bug signal set. They are false-positive guards,
not recall targets.

Compare two summary files:

```sh
node scripts/compare-prompt-regression.mjs \
  runs/prompt-regression/prompt_regression_summary_baseline.json \
  runs/prompt-regression/prompt_regression_summary_current.json
```
