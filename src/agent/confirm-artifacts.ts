import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Check the declared decision-sheet shape before treating Confirm as complete.
 * A JSON object with an unrelated `rows` field is not a checkpoint: it has not
 * passed the output contract or the execution-provenance gate. */
export function missingConfirmDecisionIds(raw: string | undefined, expectedIds: readonly string[]): string[] {
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return [...expectedIds];
  }
  const decisions = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.decisions) ? parsed.decisions : undefined;
  if (!decisions) return [...expectedIds];
  const covered = new Set<string>();
  for (const row of decisions) {
    if (!isObject(row) || !Array.isArray(row.members)) continue;
    for (const member of row.members) {
      if (typeof member === "string" && member.trim()) covered.add(member.trim().toLowerCase());
    }
  }
  return expectedIds.filter((id) => !covered.has(id.trim().toLowerCase()));
}

/** Refresh fixed-name Confirm artifacts that the model may have written with bash. */
export async function syncConfirmWorkspaceArtifacts(workspace: string, scratchFiles: Map<string, string>): Promise<void> {
  for (const name of ["confirm_decision.json", "impact_inventory.json"] as const) {
    const filename = path.join(workspace, name);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
      const content = await readFile(filename, "utf8");
      const parsed: unknown = JSON.parse(content);
      const valid = name === "confirm_decision.json"
        ? Array.isArray(parsed) || (isObject(parsed) && Array.isArray(parsed.decisions))
        : parsed !== null && typeof parsed === "object";
      if (valid) scratchFiles.set(name, content);
    } catch {
      // An absent or mid-write file must not replace the last valid checkpoint.
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
