const COVERAGE_MODES = new Set(["focused", "standard", "half", "full", "custom"]);

export function buildProjectContinueBody(args: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = { verb: "run" };
  if (args.includes("--verify-from-start")) body.verifyFromStart = true;
  if (args.includes("--remap")) body.remap = true;
  if (args.includes("--append-map") || args.includes("--expand-map")) body.appendMap = true;
  if (args.includes("--quick")) body.quick = true;
  if (args.includes("--mock-llm")) body.mockLlm = true;
  if (args.includes("--continue-coverage")) body.continueCoverage = true;
  const scopeCoverageMode = readFlag(args, "--scope-coverage-mode") ?? readFlag(args, "--coverage");
  if (scopeCoverageMode !== undefined) {
    if (!COVERAGE_MODES.has(scopeCoverageMode)) throw new Error("--coverage needs focused|standard|half|full|custom");
    body.scopeCoverageMode = scopeCoverageMode;
    body.continueCoverage = true;
  }
  for (const [flag, key] of [
    ["--max-scopes", "maxScopes"],
    ["--map-steps", "mapSteps"],
    ["--dig-steps", "digSteps"],
    ["--max-steps", "maxSteps"],
    ["--dig-samples", "digSamples"],
    ["--dig-concurrency", "digConcurrency"],
  ] as const) {
    const value = readIntFlag(args, flag);
    if (value !== undefined) {
      body[key] = value;
      if (flag === "--max-scopes") body.continueCoverage = true;
    }
  }
  return body;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readIntFlag(args: readonly string[], name: string): number | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
