import type { AuditItem, Doc } from "../types.js";

export function halo2MissingConstraintSeeder(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    if (!doc.path.endsWith(".rs")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!looksLikeUnconstrainedAssignment(line)) continue;

      const nearby = lines.slice(Math.max(0, idx - 3), Math.min(lines.length, idx + 4)).join("\n");
      const hasLocalConstraint = /(copy_advice|constrain_equal|assert_equal|enable_equality|assign_advice_from_instance)/.test(nearby);
      const id = `halo2-missing-constraint-${items.length + 1}`;
      items.push({
        id,
        location: `${doc.path}:${idx + 1}`,
        securityProperty:
          "Every witness value used as a logical input to a circuit check must be constrained to the intended source value.",
        failureMode: "missing_constraint",
        why: hasLocalConstraint
          ? "This assignment is near equality-related code; verify the actual value used downstream is constrained to the intended source."
          : "This assigns witness advice without an obvious local equality/copy constraint. Trace whether a malicious prover can choose a different value.",
        attackerControlledInputs: ["private witness values assigned by the prover"],
        seeder: "halo2_missing_constraint",
      });
    }
  }
  return items;
}

function looksLikeUnconstrainedAssignment(line: string): boolean {
  return (
    /\bassign_advice\s*\(/.test(line) ||
    /\bassign_region\s*\(/.test(line) ||
    /\bValue::known\s*\(/.test(line)
  );
}
