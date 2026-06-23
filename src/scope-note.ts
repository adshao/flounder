// Derive the map/audit "authorized scope note" from prepare's provenance manifest. This is what
// makes a `flounder run <clue>` pipeline FOCUS the map/dig on the actual audit target after prepare
// stages it — without overfitting. The focus is a uniform rule applied to facts prepare already
// records (deployment match + the project's own scope + first-party vs vendored), never a per-bug
// hand-pick, so it generalizes to any target. Pure + dependency-free so it is unit-testable.

/** Is a prepare-manifest component part of the PRIMARY audit target (vs a dependency / trust
 * boundary)? Explicit `in_scope` wins; otherwise infer from facts prepare already records — the
 * component `role` and whether it is deployed. Deployment-matched + first-party = focus; third-party
 * deps = boundary. Backward-compatible with manifests written before prepare learned `in_scope`. */
export function isInScope(c: Record<string, unknown>): boolean {
  if (typeof c.in_scope === "boolean") return c.in_scope;
  const role = String(c.role ?? "").toLowerCase();
  if (role === "target" || role === "implementation") return true;
  if (role === "dependency") return false;
  const platform = String(c.platform ?? "").trim().toLowerCase();
  return platform.length > 0 && platform !== "none" && platform !== "n/a"; // a deployed verifier/other is part of the on-chain target; off-deployment material is a boundary
}

/** Turn prepare's manifest into map's "authorized scope note": the in-scope components are the
 * primary target to focus on; the rest are named as trust boundaries the audit should only probe at
 * the TARGET's point of use. Returns undefined when nothing classifies as in-scope, so we never
 * fabricate a focus (map then treats all staged source as in scope — the prior behavior). */
export function deriveScopeNote(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const m = manifest as Record<string, unknown>;
  const comps = Array.isArray(m.components) ? (m.components as Array<Record<string, unknown>>) : [];
  if (comps.length === 0) return undefined;
  const label = (c: Record<string, unknown>): string | undefined => {
    const id = firstText(c.identity, c.name, c.id, c.role);
    const where = firstText(c.staged_path, c.path);
    if (id && where && id !== where) return `${id} — ${where}`;
    return id || where;
  };
  const inScope = comps.filter(isInScope).map(label).filter((s): s is string => Boolean(s));
  const deps = comps.filter((c) => !isInScope(c)).map(label).filter((s): s is string => Boolean(s));
  if (inScope.length === 0) return undefined;
  const parts: string[] = [
    "This scope note is a FACTUAL restatement of what the prepare phase staged (deployment match + the project's own scope declaration). It is NOT a hint about any specific bug — find bugs blind within this boundary.",
    "PRIMARY AUDIT TARGET — concentrate obligation-enumeration and the dig budget here (these are the deployment-matched / in-scope components):\n" + inScope.map((s) => "- " + s).join("\n"),
  ];
  if (deps.length > 0) {
    parts.push(
      "DEPENDENCIES / TRUST BOUNDARIES — staged in the workspace and fully readable, but not the primary target. Start from the TARGET's USE of them (an unchecked return value, a wrong assumption about their behaviour, a missing bound on what they return), and follow the trail INTO a dependency whenever the target relies on a property the dependency does not itself enforce — a forked or modified library, or any dep the target's safety hinges on, is fair game to audit in depth. The only thing to avoid is spending the bulk of the budget auditing well-known third-party code for its own sake; concentrate it on the in-scope target:\n" +
        deps.map((s) => "- " + s).join("\n"),
    );
  }
  const basis = m.scope_declaration ?? m.scope_basis;
  if (typeof basis === "string" && basis.trim()) parts.push("Scope basis (how the in-scope set was determined): " + basis.trim());
  return parts.join("\n\n");
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && trimmed !== "?") return trimmed;
  }
  return undefined;
}
