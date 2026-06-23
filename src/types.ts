export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type ExplorationStrategy = "breadth" | "depth" | "hybrid";
export type ContextRetrievalMode = "source-index" | "source-index+qmd";
export type ReproductionMode = "off" | "plan" | "execute";
export type ScopeMode = "augment" | "restrict";
// "discharged" = an obligation the dig CHECKED and judged satisfied (safe, not a bug). It is not a
// suspicion and not a confirmed bug — its own status so it stops inflating the "suspected" count.
export type ConfirmationStatus = "suspected" | "discharged" | "confirmed-source" | "confirmed-executable" | "confirmed-differential";
export type VerificationVerdict = "confirmed" | "needs-investigation" | "false-positive";

export type BuiltInFailureMode =
  | "missing_constraint"
  | "supply_balance_integrity"
  | "double_spend_nullifier"
  | "soundness_gap"
  | "proof_statement_binding"
  | "proof_aggregation_binding"
  | "proof_verifier_submission_binding"
  | "spec_impl_mismatch"
  | "integer_overflow"
  | "input_validation"
  | "injection"
  | "ssrf"
  | "path_traversal"
  | "deserialization"
  | "access_control"
  | "privilege_boundary"
  | "reentrancy"
  | "signature_replay"
  | "cryptographic_misuse"
  | "consensus_divergence"
  | "dos_resource"
  | "race_condition"
  | "secret_exposure"
  | "dependency_supply_chain";

export type FailureMode = BuiltInFailureMode | (string & {});

export interface AuditorAgentDefinition {
  failureMode: FailureMode;
  id: string;
  displayName: string;
  guidance: string;
}

export interface ProjectContext {
  summary?: string;
  criticalAssets?: string[];
  attackerCapabilities?: string[];
  trustBoundaries?: string[];
  securityInvariants?: string[];
  focusAreas?: string[];
  outOfScope?: string[];
  scenarioGuidance?: string[];
}

export interface AuditLensPackDefinition {
  id: string;
  displayName?: string;
  description?: string;
  projectContext?: ProjectContext;
  failureModes?: FailureMode[];
  auditorAgents?: AuditorAgentDefinition[];
  enumerationGuidance?: string[];
  auditGuidance?: string[];
}

export interface Doc {
  path: string;
  content: string;
  kind: "source" | "corpus";
}

export interface ProjectProfile {
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  manifests: string[];
  likelySecurityDomains: string[];
  entrypoints: string[];
  notes: string[];
}

export interface ProjectLearning {
  scopeSummary?: string;
  securityObjectives?: string[];
  domainConcepts?: string[];
  trustBoundaries?: string[];
  attackerCapabilities?: string[];
  candidateInvariants?: string[];
  implementationMechanics?: string[];
  uncertainty?: string[];
  evidenceRefs?: string[];
}

export interface ProofObligation {
  id: string;
  kind: "spec" | "source" | "learning" | "provenance";
  property: string;
  rationale: string;
  evidenceRefs: string[];
  keywords?: string[];
}

export type ProvenanceFactKind =
  | "advice_assignment"
  | "advice_copy"
  | "equality_constraint"
  | "equality_enabled_column"
  | "gate_creation"
  | "gate_query"
  | "selector"
  | "evm_external_function"
  | "evm_external_call"
  | "evm_delegatecall"
  | "evm_selector_forwarding"
  | "evm_recurring_agreement"
  | "evm_payment_distribution"
  | "evm_state_write"
  | "evm_auth_guard"
  | "evm_signature_check"
  | "evm_permit2_witness_binding"
  | "evm_settler_action_dispatch"
  | "evm_settler_slippage_binding"
  | "evm_settler_calldata_decoder"
  | "evm_settler_transient_context"
  | "evm_settler_restricted_target"
  | "evm_settler_full_balance_bridge_sink"
  | "evm_oracle_read"
  | "evm_upgrade_hook"
  | "evm_token_transfer"
  | "evm_unchecked_arithmetic"
  | "evm_bridge_message"
  | "evm_bridge_asset_mapping"
  | "evm_bridge_credit_accounting"
  | "evm_bridge_native_drop"
  | "evm_wormhole_vaa"
  | "evm_oft_supply_change"
  | "evm_mint_redeem_order"
  | "evm_async_request_settlement"
  | "evm_erc4626_cooldown"
  | "evm_restriction_role"
  | "evm_eip1271_signature"
  | "evm_beneficiary_allowlist"
  | "evm_stable_price_limit"
  | "evm_block_limit"
  | "evm_governance_payload"
  | "evm_dao_governance"
  | "evm_name_registry_resolution"
  | "evm_validator_cluster_accounting"
  | "zk_witness_source"
  | "zk_task_statement"
  | "zk_public_input_metadata"
  | "zk_proof_aggregation"
  | "zk_verifier_submission"
  | "solana_anchor_account"
  | "solana_pda_derivation"
  | "solana_token_accounting"
  | "solana_cpi_call"
  | "solana_cross_chain_message"
  | "solana_governance_execution"
  | "solana_decimal_conversion"
  | "solana_pause_or_config"
  | "cairo_entrypoint"
  | "cairo_syscall"
  | "cairo_storage_access"
  | "cairo_l1_l2_message"
  | "cairo_signature_hash_binding"
  | "cairo_class_hash_binding"
  | "cairo_resource_accounting"
  | "cairo_block_context"
  | "cairo_os_output_commitment"
  | "cairo_assertion_or_constraint"
  | "go_wormhole_guardian_observation"
  | "go_wormhole_vaa_signing"
  | "go_wormhole_governor"
  | "go_wormhole_p2p_message"
  | "go_wormhole_chain_watcher"
  | "go_wormhole_admin_config";

export interface ProvenanceFact {
  id: string;
  domain: string;
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string;
  label?: string;
  column?: string;
  rowExpression?: string;
  sourceExpression?: string;
  receiver?: string;
  nearbySignals: string[];
  code: string;
}

export interface ProvenanceGraph {
  domain: string;
  facts: ProvenanceFact[];
  obligations: ProofObligation[];
  summary: {
    files: number;
    facts: number;
    byKind: Partial<Record<ProvenanceFactKind, number>>;
    assignmentFlowObligations: number;
  };
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
  enumerationSource?: "baseline" | "model" | "portfolio" | "seeder" | "deepening";
  round?: number;
  strategy?: Exclude<ExplorationStrategy, "hybrid">;
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
  modelError?: boolean;
  needsMoreContext?: boolean;
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
  confirmationStatus: ConfirmationStatus;
  commandRunId?: string;
  patchedSuccessPatterns?: string[];
  verificationVerdict?: VerificationVerdict;
  reproductionStatus?: ReproductionStatus;
  impactScore?: number;
  impactSignals?: string[];
  /** An execution-proven finding an independent skeptic disputes — needs human review. */
  disputed?: boolean;
  refutationReason?: string;
}

export interface AuditSummary {
  coverage: {
    itemsTotal: number;
    itemsWithFinding: number;
    bySeverity: Record<Severity, number>;
    itemsNeedingRetry: number;
    modelErrorTrials: number;
    parseErrorTrials: number;
    needsMoreContextTrials: number;
    verifiedFindings: number;
    unverifiedFindings: number;
    // Unconfirmed candidates recorded separately from findings. A finding requires
    // execution-grounded confirmation; everything else is a hypothesis.
    hypotheses?: number;
  };
  findings: RankedFinding[];
}

export interface Verification {
  id: string;
  verdict: VerificationVerdict;
  confirmationStatus: Extract<ConfirmationStatus, "suspected" | "confirmed-source">;
  markdown: string;
  mode?: "standard" | "composition";
  queueReason?: "topK" | "high-impact";
  executableSuccessPatterns?: string[];
}

export interface ReproductionFile {
  path: string;
  content: string;
}

export interface ReproductionCommand {
  program: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  expectedExitCode?: number;
}

export interface ReproductionPlan {
  summary: string;
  files: ReproductionFile[];
  commands: ReproductionCommand[];
  successCriteria: string[];
  successPatterns?: string[];
  safetyNotes: string[];
}

export type ReproductionStatus = "planned" | "not-run" | "blocked" | "needs-work" | "confirmed-executable" | "skipped";

export interface ReproductionCommandResult {
  command: ReproductionCommand;
  exitCode: number | null;
  expectedExitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface Reproduction {
  id: string;
  findingId: string;
  status: ReproductionStatus;
  confirmationStatus: ConfirmationStatus;
  plan?: ReproductionPlan;
  workspace?: string;
  commandResults: ReproductionCommandResult[];
  markdown: string;
  blockedReason?: string;
  successPatternsMatched?: string[];
  successPatternsMissing?: string[];
}

export interface LlmClient {
  complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    // When true, the call is one turn of an agentic tool loop: the model must be
    // free to drive its own investigation and emit a tool action. CLI-fallback
    // providers must not inject a "do not inspect files / answer only from the
    // text below" preamble in this mode, which would sabotage the loop.
    agentic?: boolean;
  }): Promise<string>;
}
