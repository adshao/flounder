// Offline regression / smoke test: run the deterministic mock model against ./fixtures and
// assert it produces a finding. This calls the LIBRARY directly (runAudit) — it is NOT a CLI
// invocation — because the CLI is a pure thin client of the control plane (no in-process path),
// so a "does a mock run still work end to end" check belongs at the library layer, with no
// server or provider required. Mirrors what `flounder run --quick --mock-llm` used to do.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "../dist/agent/audit.js";
import { MockAuditLlmClient } from "../dist/llm/mock.js";
import { defaultConfig } from "../dist/config.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = defaultConfig();
cfg.targetName = "mock-audit";
cfg.sourcePaths = [path.join(repo, "fixtures")];
cfg.outputDir = "runs";
cfg.auditMaxSteps = 10;
cfg.sandboxBackend = "host";
cfg.sandboxAllowHostFallback = true;
// `run --quick` = a single breadth pass: auditDeep stays false (no map → dig).

const result = await runAudit(cfg, { kind: "run", llm: new MockAuditLlmClient() });
const cov = result.summary.coverage;
console.log(`[mock-audit] run dir ${result.runDir}`);
console.log(`[mock-audit] findings=${cov.itemsWithFinding}/${cov.itemsTotal} by_severity=${JSON.stringify(cov.bySeverity)}`);
if (cov.itemsWithFinding < 1) {
  console.error("[mock-audit] FAIL: expected ≥1 finding from the mock model");
  process.exit(1);
}
console.log("[mock-audit] OK");
