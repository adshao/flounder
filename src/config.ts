import type { AuditorAgentDefinition, FailureMode } from "./types.js";

export const DEFAULT_FAILURE_MODES: FailureMode[] = [
  "missing_constraint",
  "supply_balance_integrity",
  "double_spend_nullifier",
  "soundness_gap",
  "spec_impl_mismatch",
  "integer_overflow",
  "access_control",
  "reentrancy",
  "signature_replay",
  "consensus_divergence",
  "dos_resource",
];

export interface AuditorConfig {
  targetName: string;
  sourcePaths: string[];
  corpusPaths: string[];
  outputDir: string;
  provider: string;
  enumModel: string;
  auditModel: string;
  verifyModel: string;
  trials: number;
  maxWorkers: number;
  maxTokens: number;
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
  contextCharBudget: number;
  failureModes: FailureMode[];
  auditorAgents: AuditorAgentDefinition[];
  dryRun: boolean;
}

export function defaultConfig(): AuditorConfig {
  return {
    targetName: "target",
    sourcePaths: [],
    corpusPaths: [],
    outputDir: "runs",
    provider: "anthropic",
    enumModel: "claude-opus-4-8",
    auditModel: "claude-opus-4-8",
    verifyModel: "claude-opus-4-8",
    trials: 4,
    maxWorkers: 4,
    maxTokens: 8000,
    thinkingLevel: "xhigh",
    contextCharBudget: 120_000,
    failureModes: DEFAULT_FAILURE_MODES,
    auditorAgents: [],
    dryRun: false,
  };
}

export function effectiveFailureModes(cfg: Pick<AuditorConfig, "failureModes" | "auditorAgents">): FailureMode[] {
  return [...new Set([...cfg.failureModes, ...cfg.auditorAgents.map((agent) => agent.failureMode)])];
}
