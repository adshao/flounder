## Summary

What problem does this change solve, and why does it belong in Flounder?

## Product and technical impact

- User-visible behavior:
- Architecture or trust boundaries affected:
- Compatibility or migration impact:

## Risk classification

- [ ] Low — documentation or non-behavioral metadata
- [ ] Medium — CLI, configuration, UI, packaging, skill, or workflow behavior
- [ ] High — agent, prompt, model, security, sandbox, confirmation, persistence,
      migration, or release behavior

Applicable review lenses:

- [ ] Product and architecture
- [ ] Enum/mode/status completeness
- [ ] LLM output and prompt trust boundary
- [ ] Command, sandbox, or network safety
- [ ] Database or persisted-artifact upgrade
- [ ] Cross-platform behavior
- [ ] Public release hygiene
- [ ] Supply-chain integrity and downstream runtime safety

## Verification

- Automated tests added or updated:
- Manual validation performed:
- Prompt evaluation or safe/control evidence, if applicable:
- Known limitations or intentionally deferred work:

## Checklist

- [ ] `npm run quality:pr -- --base-ref origin/main --head-ref HEAD` passes.
- [ ] `npm run verify` passes.
- [ ] Behavior changes have focused regression tests.
- [ ] Public-facing text is English and documentation is updated.
- [ ] The diff, commits, and package contain no private or machine-specific data.
- [ ] New dependencies, scripts, network access, file access, subprocesses, and
      credential access are necessary, bounded, and covered by tests.
- [ ] Workflow changes use an exact digest pre-authorized in a separate
      maintainer policy change; this PR does not authorize its own workflow.
- [ ] I reviewed [the pull request quality gates](../docs/QUALITY_GATES.md).
