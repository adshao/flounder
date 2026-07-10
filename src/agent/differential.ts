import { readFile } from "node:fs/promises";
import { sandboxExecutionOptions, type AuditorConfig } from "../config.js";
import {
  matchSuccessPatterns,
  normalizeRelativePath,
  resolveWorkspacePathForRead,
  runSandboxCommand,
  writeSandboxFiles,
  type SandboxNetworkMode,
  type SandboxWorkspace,
} from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import type { AgentFinding, CommandRunRecord } from "./tools.js";

// Differential (fail-after-fix) confirmation. A passing exploit test only proves
// the test passes, not that a real bug exists — the model controls both. This
// closes the loop the model cannot fake: apply the model's OWN declared fix to
// the (provably pristine, see baseline integrity) target source and re-run the
// SAME test. A real bug's test passes on the vulnerable code and is blocked once
// the fix lands; a tautological test behaves identically before and after, so it
// cannot reach confirmed-differential. The framework — never the model — applies
// the fix and judges the result.

export interface DifferentialResult {
  findingId: string;
  confirmed: boolean;
  reason: string;
  patchedExitCode: number | null;
  patchedMatched: string[];
  patchedMissing: string[];
  exploitStillReproduces: boolean;
}

/**
 * A differential rerun must never gain more egress than the exploit run that
 * earned confirmation. CommandRunRecord is persisted model output, so missing
 * or unknown historical provenance fails closed to a sealed rerun.
 */
export function differentialNetworkForExploitRun(
  cfg: AuditorConfig,
  exploitRun: Pick<CommandRunRecord, "network">,
): SandboxNetworkMode {
  return cfg.confirmMode && cfg.sandboxConfirmNetwork === "enabled" && exploitRun.network === "enabled"
    ? "enabled"
    : "none";
}

export async function runDifferentialConfirmation(input: {
  workspace: SandboxWorkspace;
  finding: AgentFinding;
  exploitRun: CommandRunRecord;
  baselineFiles: Set<string>;
  cfg: AuditorConfig;
  logger: RunLogger;
  cacheDir?: string;
}): Promise<DifferentialResult> {
  const { finding, exploitRun } = input;
  const base = (reason: string, extra: Partial<DifferentialResult> = {}): DifferentialResult => ({
    findingId: finding.id,
    confirmed: false,
    reason,
    patchedExitCode: null,
    patchedMatched: [],
    patchedMissing: [],
    exploitStillReproduces: false,
    ...extra,
  });

  const fixPatch = finding.fixPatch;
  const patched = finding.patchedSuccessPatterns ?? [];
  if (!fixPatch) return base("no machine-applicable fix_patch supplied");
  if (patched.length === 0) return base("no patched_success_patterns supplied (the test's blocked-exploit signal)");
  if (exploitRun.successPatterns.length === 0) return base("the cited exploit run declared no success_patterns");

  const rel = normalizeRelativePath(fixPatch.path);
  if (!rel || !input.baselineFiles.has(rel)) return base(`fix_patch.path "${fixPatch.path}" is not a target-source file`);

  let target: string;
  try {
    target = await resolveWorkspacePathForRead(input.workspace.absolute, rel);
  } catch {
    return base(`fix_patch.path "${fixPatch.path}" is outside the workspace`);
  }

  let original: string;
  try {
    original = await readFile(target, "utf8");
  } catch {
    return base(`could not read target source "${rel}"`);
  }
  if (!original.includes(fixPatch.old)) return base(`fix_patch.old text was not found in "${rel}"`);

  const patchedContent = original.replace(fixPatch.old, fixPatch.new);
  let patchedRun;
  try {
    await writeSandboxFiles(input.workspace.absolute, [{ path: rel, content: patchedContent }]);
    patchedRun = await runSandboxCommand(
      exploitRun.commandSpec,
      input.workspace.absolute,
      input.cfg.reproductionMaxLogBytes,
      input.cfg.sourcePaths,
      input.cacheDir,
      sandboxExecutionOptions(input.cfg, differentialNetworkForExploitRun(input.cfg, exploitRun)),
    );
  } finally {
    // Always restore the pristine target source so other findings see a clean tree.
    await writeSandboxFiles(input.workspace.absolute, [{ path: rel, content: original }]);
  }

  const exitMatched = patchedRun.exitCode === exploitRun.expectedExitCode && !patchedRun.timedOut;
  const patchedCheck = matchSuccessPatterns(patched, [patchedRun]);
  const exploitCheck = matchSuccessPatterns(exploitRun.successPatterns, [patchedRun]);
  const exploitStillReproduces = exploitCheck.missing.length === 0; // every exploit pattern still present
  // The fix must keep the test compiling/running (exit as expected), make the
  // blocked-exploit signal appear, and stop the exploit from reproducing.
  const confirmed = exitMatched && patchedCheck.missing.length === 0 && !exploitStillReproduces;

  const result: DifferentialResult = {
    findingId: finding.id,
    confirmed,
    reason: confirmed
      ? "exploit reproduces on baseline and is blocked after the declared fix"
      : !exitMatched
        ? `patched test did not exit as expected (exit=${patchedRun.exitCode}); a fix that only breaks the build does not count`
        : exploitStillReproduces
          ? "the exploit still reproduces after the fix — the fix does not close it"
          : `blocked-exploit signal missing after fix: ${patchedCheck.missing.join(" | ")}`,
    patchedExitCode: patchedRun.exitCode,
    patchedMatched: patchedCheck.matched,
    patchedMissing: patchedCheck.missing,
    exploitStillReproduces,
  };
  await input.logger.event("audit_differential", { findingId: finding.id, confirmed, exploitStillReproduces, patchedExit: patchedRun.exitCode });
  return result;
}
