import type { RankedFinding, Reproduction, Verification } from "../types.js";

export function reportArtifactName(findingId: string): string {
  return `report_${safeReportId(findingId)}.md`;
}

export function renderDisclosure(target: string, finding: RankedFinding, verification?: Verification, reproduction?: Reproduction): string {
  const reproductionStatus = reproduction?.status ?? finding.reproductionStatus ?? "not-run";
  const verificationMarkdown = verification?.markdown ?? localVerificationMarkdown(finding);
  const reproductionMarkdown = reproduction?.markdown ?? localReproductionMarkdown(finding);
  const classLine = finding.failureMode && finding.failureMode !== "unknown" && finding.failureMode !== "autonomous"
    ? `- Class: ${finding.failureMode}\n`
    : "";
  return `# Security disclosure: ${finding.title}

Private report for maintainers. Please coordinate disclosure.

- Project: ${target}
- Severity estimate: ${finding.severity.toUpperCase()}
- Component / location: ${finding.location}
${classLine}- Confirmation status: ${finding.confirmationStatus}${finding.disputed ? `\n- DISPUTED by independent refutation (execution-proven but a skeptic disagrees — needs human review): ${finding.refutationReason ?? "see audit_refutation.json"}` : ""}
- Source verifier verdict: ${verification?.verdict ?? "not-run"}
- Verification mode: ${verification?.mode ?? "not-run"}
- Impact signals: ${finding.impactSignals?.join(", ") || "not-scored"}
- Reproduction status: ${reproductionStatus}

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

${verificationMarkdown}

${reproductionMarkdown}

## Disclosure Preferences

- Please confirm a security contact or encrypted channel.
- Happy to coordinate on an embargo and remediation timeline.
`;
}

function localVerificationMarkdown(finding: RankedFinding): string {
  if (finding.confirmationStatus !== "confirmed-executable" && finding.confirmationStatus !== "confirmed-differential") {
    return "_Verification notes not generated._";
  }
  return "_Local execution confirmation was produced by the sealed audit confirmation gate._";
}

function localReproductionMarkdown(finding: RankedFinding): string {
  if (finding.confirmationStatus !== "confirmed-executable" && finding.confirmationStatus !== "confirmed-differential") {
    return "_Executable reproduction not generated. Run Verify to confirm or refute this candidate by local execution._";
  }
  const lines = ["Local executable evidence:"];
  if (finding.commandRunId) lines.push(`- Confirmation command: \`${finding.commandRunId}\``);
  if (finding.confirmationStatus === "confirmed-differential" && finding.patchedSuccessPatterns?.length) {
    lines.push("- Patch-blocking success patterns:");
    for (const pattern of finding.patchedSuccessPatterns) lines.push(`  - \`${pattern}\``);
  }
  if (lines.length === 1) lines.push("- The finding was marked execution-confirmed, but the command id was not recorded in this report artifact.");
  return lines.join("\n");
}

function safeReportId(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return cleaned || "finding";
}
