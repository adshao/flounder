export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type FailureMode =
  | "missing_constraint"
  | "supply_balance_integrity"
  | "double_spend_nullifier"
  | "soundness_gap"
  | "spec_impl_mismatch"
  | "integer_overflow"
  | "access_control"
  | "reentrancy"
  | "signature_replay"
  | "consensus_divergence"
  | "dos_resource";

export interface Doc {
  path: string;
  content: string;
  kind: "source" | "corpus";
}

export interface AuditItem {
  id: string;
  location: string;
  securityProperty: string;
  failureMode: FailureMode;
  why: string;
  specRefs?: string[];
  attackerControlledInputs?: string[];
  seeder?: string;
}

export interface TrialFinding {
  finding: boolean;
  title: string;
  severity: Severity;
  confidence: number;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
  parseError?: boolean;
  raw?: string;
}

export interface AuditResult {
  item: AuditItem;
  nTrials: number;
  nHits: number;
  hitRate: number;
  trials: TrialFinding[];
}

export interface RankedFinding {
  id: string;
  location: string;
  failureMode: FailureMode;
  title: string;
  severity: Severity;
  hitRate: number;
  confidence: number;
  score: number;
  description: string;
  evidence: string;
  exploitSketch: string;
  fix: string;
}

export interface AuditSummary {
  coverage: {
    itemsTotal: number;
    itemsWithFinding: number;
    bySeverity: Record<Severity, number>;
  };
  findings: RankedFinding[];
}

export interface Verification {
  id: string;
  markdown: string;
}

export interface LlmClient {
  complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<string>;
}
