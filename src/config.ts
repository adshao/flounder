import type { AuditLensPackDefinition, AuditorAgentDefinition, ContextRetrievalMode, ExplorationStrategy, FailureMode, ProjectContext, ReproductionMode, ScopeMode } from "./types.js";
import { auditorAgentsFromLensPacks } from "./lens/context.js";

export const DEFAULT_FAILURE_MODES: FailureMode[] = [
  "missing_constraint",
  "supply_balance_integrity",
  "double_spend_nullifier",
  "soundness_gap",
  "spec_impl_mismatch",
  "integer_overflow",
  "input_validation",
  "injection",
  "ssrf",
  "path_traversal",
  "deserialization",
  "access_control",
  "privilege_boundary",
  "reentrancy",
  "signature_replay",
  "cryptographic_misuse",
  "consensus_divergence",
  "dos_resource",
  "race_condition",
  "secret_exposure",
  "dependency_supply_chain",
];

export interface AuditorConfig {
  targetName: string;
  sourcePaths: string[];
  corpusPaths: string[];
  outputDir: string;
  historyDir?: string;
  provider: string;
  enumModel: string;
  auditModel: string;
  verifyModel: string;
  rounds: number;
  explorationStrategy: ExplorationStrategy;
  maxNewItemsPerRound: number;
  trials: number;
  maxWorkers: number;
  maxAuditItems?: number;
  highImpactVerification: boolean;
  highImpactMaxFindings: number;
  scopeMode: ScopeMode;
  baselineExplorationShare: number;
  maxTokens: number;
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
  contextCharBudget: number;
  contextRetrieval: ContextRetrievalMode;
  qmdCommand: string;
  qmdLimit: number;
  qmdMinScore: number;
  qmdTimeoutMs: number;
  qmdCollections: string[];
  portfolioEnumeration: boolean;
  portfolioMaxItems: number;
  failureModes: FailureMode[];
  auditorAgents: AuditorAgentDefinition[];
  projectContext: ProjectContext;
  lensPacks: AuditLensPackDefinition[];
  projectLearning: boolean;
  dynamicLensDiscovery: boolean;
  localChecklistSeeders: boolean;
  reproductionMode: ReproductionMode;
  reproductionMaxCommands: number;
  reproductionCommandTimeoutMs: number;
  reproductionMaxFileBytes: number;
  reproductionMaxLogBytes: number;
  huntMaxSteps: number;
  huntScopeNote?: string;
  dryRun: boolean;
}

export function defaultConfig(): AuditorConfig {
  return {
    targetName: "target",
    sourcePaths: [],
    corpusPaths: [],
    outputDir: "runs",
    provider: "openai",
    enumModel: "gpt-5.5",
    auditModel: "gpt-5.5",
    verifyModel: "gpt-5.5",
    rounds: 1,
    explorationStrategy: "hybrid",
    maxNewItemsPerRound: 16,
    trials: 4,
    maxWorkers: 4,
    highImpactVerification: true,
    highImpactMaxFindings: 24,
    scopeMode: "augment",
    baselineExplorationShare: 0.25,
    maxTokens: 8000,
    thinkingLevel: "xhigh",
    contextCharBudget: 120_000,
    contextRetrieval: "source-index",
    qmdCommand: "qmd",
    qmdLimit: 6,
    qmdMinScore: 0.25,
    qmdTimeoutMs: 60_000,
    qmdCollections: [],
    portfolioEnumeration: true,
    portfolioMaxItems: 12,
    failureModes: DEFAULT_FAILURE_MODES,
    auditorAgents: [],
    projectContext: {},
    lensPacks: [],
    projectLearning: true,
    dynamicLensDiscovery: true,
    localChecklistSeeders: false,
    reproductionMode: "off",
    reproductionMaxCommands: 3,
    reproductionCommandTimeoutMs: 120_000,
    reproductionMaxFileBytes: 200_000,
    reproductionMaxLogBytes: 40_000,
    huntMaxSteps: 40,
    dryRun: false,
  };
}

export function effectiveAuditorAgents(cfg: Pick<AuditorConfig, "auditorAgents" | "lensPacks">): AuditorAgentDefinition[] {
  return [...cfg.auditorAgents, ...auditorAgentsFromLensPacks(cfg.lensPacks)];
}

export function effectiveFailureModes(cfg: Pick<AuditorConfig, "failureModes" | "auditorAgents" | "lensPacks">): FailureMode[] {
  return [
    ...new Set([
      ...cfg.failureModes,
      ...cfg.auditorAgents.map((agent) => agent.failureMode),
      ...cfg.lensPacks.flatMap((pack) => pack.failureModes ?? []),
      ...auditorAgentsFromLensPacks(cfg.lensPacks).map((agent) => agent.failureMode),
    ]),
  ];
}
