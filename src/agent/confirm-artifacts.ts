import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

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
