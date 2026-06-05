import type { RankedFinding, Verification } from "../types.js";

export function renderDisclosure(target: string, finding: RankedFinding, verification?: Verification): string {
  return `# Security disclosure: ${finding.title}

Private report for maintainers. Please coordinate disclosure.

- Project: ${target}
- Severity estimate: ${finding.severity.toUpperCase()}
- Component / location: ${finding.location}
- Class: ${finding.failureMode}

## Summary

${finding.description}

## Affected Invariant

${finding.evidence}

## Impact

${finding.exploitSketch}

## Suggested Fix

${finding.fix}

## Reproduction

Verification is intended for a local, isolated environment only: unit tests, regtest, devnet, or forked node. It must not be run against a live public network.

${verification?.markdown ?? "_Verification notes not generated._"}

## Disclosure Preferences

- Please confirm a security contact or encrypted channel.
- Happy to coordinate on an embargo and remediation timeline.
`;
}
