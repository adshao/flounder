import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const SIGNAL_TERMS = [
  "account",
  "anchor",
  "authority",
  "bump",
  "burn",
  "cpi",
  "delegate",
  "eid",
  "escrow",
  "executor",
  "fee",
  "governance",
  "layerzero",
  "lz_receive",
  "mint",
  "nonce",
  "oft",
  "owner",
  "pause",
  "pda",
  "peer",
  "program",
  "remote",
  "seed",
  "signer",
  "spl",
  "token",
  "transfer",
  "withdraw",
];

const ZK_SIGNAL_TERMS = [
  "aggregation",
  "batch",
  "block",
  "bundle",
  "chunk",
  "coordinator",
  "metadata",
  "pi_hash",
  "proof",
  "prover",
  "public",
  "snark",
  "stark",
  "task",
  "universal",
  "verifier",
  "vk",
  "witness",
  "zkvm",
];

export function extractRustSolanaProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeSolanaRustDoc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = solanaRoutingObligations(facts);
  return {
    domain: "solana-rust",
    facts,
    obligations,
    summary: {
      files,
      facts: facts.length,
      byKind: countBy(facts, (fact) => fact.kind),
      assignmentFlowObligations: obligations.length,
    },
  };
}

export function extractRustZkProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeZkProofOrchestrationDoc(doc)) continue;
    files += 1;
    facts.push(...extractZkFactsFromDoc(doc));
  }
  const obligations = zkProofOrchestrationObligations(facts);
  return {
    domain: "zk-proof-orchestration",
    facts,
    obligations,
    summary: {
      files,
      facts: facts.length,
      byKind: countBy(facts, (fact) => fact.kind),
      assignmentFlowObligations: obligations.length,
    },
  };
}

function extractFactsFromDoc(doc: Doc): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const code = stripInlineComment(lines[idx] ?? "").trim();
    if (code.length === 0) continue;
    const functionName = enclosingFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    for (const fact of factsFromLine(doc.path, idx + 1, code, functionName, nearbySignals)) {
      out.push(fact);
    }
  }
  return out;
}

function extractZkFactsFromDoc(doc: Doc): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const lines = doc.content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const code = stripInlineComment(lines[idx] ?? "").trim();
    if (code.length === 0) continue;
    const functionName = enclosingRustOrGoFunction(lines, idx);
    const nearbySignals = nearbyZkSignalsFor(lines, idx);
    for (const fact of zkFactsFromLine(doc.path, idx + 1, code, functionName, nearbySignals)) {
      out.push(fact);
    }
  }
  return out;
}

function zkFactsFromLine(
  path: string,
  line: number,
  code: string,
  functionName: string | undefined,
  nearbySignals: string[],
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const common = { path, line, functionName, nearbySignals, code };

  if (/\b(BlockWitness|block_hashes|block_hash|try_fetch_.*witness|fetch.*Witness|witness)\b/i.test(code)) {
    out.push(zkFact({ ...common, kind: "zk_witness_source", sourceExpression: code }));
  }

  if (/\b(ChunkTask|BatchProvingTask|BundleProvingTask|ProvingTask|task_data|task_id|identifier|GenerateUniversalTask|universal)\b/i.test(code)) {
    out.push(zkFact({ ...common, kind: "zk_task_statement", sourceExpression: code }));
  }

  if (/\b(pi_hash|public_?inputs?|metadata|post_blockhash|prev_state_root|post_state_root|withdraw_root|batch_hash|BundleInfo|BatchInfo|ChunkInfo)\b/i.test(code)) {
    out.push(zkFact({ ...common, kind: "zk_public_input_metadata", sourceExpression: code }));
  }

  if (/\b(aggregated_proofs|chunk_proofs|batch_proofs|check_aggregation|AggregationInput|aggregate|aggregation|into_stark_proof|public_values)\b/i.test(code)) {
    out.push(zkFact({ ...common, kind: "zk_proof_aggregation", sourceExpression: code }));
  }

  if (/\b(submit_?proof|SubmitProof|verify_?proof|Verifier|verifier|ProofMetadata|ProofResult|taskID|stark_proof|snark|vk)\b/i.test(code)) {
    out.push(zkFact({ ...common, kind: "zk_verifier_submission", sourceExpression: code }));
  }

  return out;
}

function factsFromLine(
  path: string,
  line: number,
  code: string,
  functionName: string | undefined,
  nearbySignals: string[],
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const common = { path, line, functionName, nearbySignals, code };

  if (/\b#\s*\[\s*derive\s*\(\s*Accounts\b|\bAccount<'|AccountInfo<'|Signer<'|Program<'|UncheckedAccount<'/.test(code)) {
    out.push(fact({ ...common, kind: "solana_anchor_account", sourceExpression: code }));
  }

  if (/\b(seeds\s*=|bump\b|find_program_address|create_program_address|Pubkey::new_from_array|declare_id!|Program ID|program_id)\b/.test(code)) {
    out.push(fact({ ...common, kind: "solana_pda_derivation", sourceExpression: code }));
  }

  if (/\b(mint_to|burn|transfer_checked|transfer|approve|revoke|sync_native|Mint|TokenAccount|token::|spl_token|amount_ld|amount_sd|shared_decimals|local_decimals|remove_dust)\b/.test(code)) {
    out.push(fact({ ...common, kind: "solana_token_accounting", sourceExpression: code }));
  }

  if (/\b(CpiContext|invoke_signed|invoke|endpoint_cpi|oapp::endpoint|with_signer|seeds_slice|accounts_for_clear|accounts_for_send|cpi)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "solana_cpi_call", sourceExpression: code }));
  }

  if (/\b(lz_receive|LzReceive|quote_send|send|endpoint|eid|peer|remote|guid|nonce|payload|message|compose|oft|LayerZero)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "solana_cross_chain_message", sourceExpression: code }));
  }

  if (/\b(governance|Governance|set_remote|Remote|executor|instruction|call_data|target|CPI_AUTHORITY|CONTEXT_PLACEHOLDER|PAYER_PLACEHOLDER)\b/.test(code)) {
    out.push(fact({ ...common, kind: "solana_governance_execution", sourceExpression: code }));
  }

  if (/\b(shared_decimals|local_decimals|ld2sd|sd2ld|amount_ld|amount_sd|decimal|remove_dust|dust|conversion_rate)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "solana_decimal_conversion", sourceExpression: code }));
  }

  if (/\b(paused|pause|set_pause|set_oft_config|set_peer_config|set_oapp_config|admin|owner|authority|delegate|unpauser)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "solana_pause_or_config", sourceExpression: code }));
  }

  return out;
}

function zkProofOrchestrationObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "zk_witness_source", {
    id: "zk-witness-source-request-binding",
    property:
      "Every witness returned by a coordinator, RPC, interpreter, or prover-side source should be cryptographically or structurally bound to the requested block, batch, task id, fork, and statement before requested identifiers are dropped.",
    keywords: ["witness", "block", "task", "binding", "proof"],
  });
  pushObligation(obligations, facts, "zk_task_statement", {
    id: "zk-task-statement-identity-binding",
    property:
      "Universal or serialized proving tasks should preserve the requested statement identity across checkout, serialization, prover execution, coordinator storage, and verifier submission.",
    keywords: ["task", "statement", "identity", "proof"],
  });
  pushObligation(obligations, facts, "zk_public_input_metadata", {
    id: "zk-public-input-metadata-binding",
    property:
      "Public-input hashes and metadata should be derived from, and later rebound to, the same requested statement rather than only the returned witness, proof wrapper, or coordinator cache.",
    keywords: ["public input", "metadata", "pi_hash", "binding"],
  });
  pushObligation(obligations, facts, "zk_proof_aggregation", {
    id: "zk-aggregation-proof-metadata-binding",
    property:
      "Recursive aggregation should length-check, order-check, and metadata-check every inner proof and public input before constructing chunk, batch, bundle, or final verifier claims.",
    keywords: ["aggregation", "proof", "metadata", "public input"],
  });
  pushObligation(obligations, facts, "zk_verifier_submission", {
    id: "zk-verifier-submission-task-binding",
    property:
      "Submit-proof and verifier paths should bind submitted proof bytes to the stored task id, verification key, metadata, assignment state, and downstream finalized claim.",
    keywords: ["verifier", "submit", "task", "metadata", "vk"],
  });
  return obligations;
}

function solanaRoutingObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "solana_anchor_account", {
    id: "solana-anchor-account-constraint-integrity",
    property:
      "Anchor account constraints should bind signer, owner, program id, PDA seed, bump, mint, token owner, and mutability before state or token movement.",
    keywords: ["anchor", "account", "signer", "owner", "pda", "mint"],
  });
  pushObligation(obligations, facts, "solana_pda_derivation", {
    id: "solana-pda-domain-and-bump-binding",
    property:
      "PDA derivations should domain-separate seeds by program, endpoint, mint, peer, and purpose, and should not accept caller-selected bumps or aliases that cross authority domains.",
    keywords: ["pda", "seed", "bump", "program id", "authority"],
  });
  pushObligation(obligations, facts, "solana_token_accounting", {
    id: "solana-oft-token-accounting-conservation",
    property:
      "SPL token mint, burn, escrow transfer, fee withdrawal, and OFT amount conversion paths should preserve supply and locked-value conservation across local and remote chains.",
    keywords: ["spl token", "mint", "burn", "escrow", "oft", "amount"],
  });
  pushObligation(obligations, facts, "solana_cpi_call", {
    id: "solana-cpi-authority-and-account-list-binding",
    property:
      "CPI calls should bind the invoked program, signer seeds, account list ordering, writable accounts, and authority PDA to the intended token, endpoint, or governance action.",
    keywords: ["cpi", "invoke_signed", "signer seeds", "account list", "authority"],
  });
  pushObligation(obligations, facts, "solana_cross_chain_message", {
    id: "solana-layerzero-message-peer-replay-binding",
    property:
      "LayerZero receive and send paths should bind endpoint, peer, remote EID, nonce or guid, payload type, recipient, amount, and clear/replay semantics before minting, burning, or executing governance.",
    keywords: ["layerzero", "peer", "eid", "nonce", "guid", "payload"],
  });
  pushObligation(obligations, facts, "solana_governance_execution", {
    id: "solana-governance-execution-account-authority",
    property:
      "Cross-chain governance execution should bind the remote sender, target program/account, instruction payload, CPI authority, payer, and contextual accounts without letting the message author smuggle extra authority.",
    keywords: ["governance", "remote", "target", "instruction", "cpi authority"],
  });
  pushObligation(obligations, facts, "solana_decimal_conversion", {
    id: "solana-oft-decimal-dust-conservation",
    property:
      "OFT shared-decimal conversion should bound overflow, dust removal, min-amount checks, fee accounting, and round-trip conservation between local and shared decimals.",
    keywords: ["decimals", "dust", "amount", "rounding", "overflow"],
  });
  pushObligation(obligations, facts, "solana_pause_or_config", {
    id: "solana-config-pause-authority-boundary",
    property:
      "Pause, peer, rate-limit, delegate, and config updates should be authorized by the intended admin path and should not bypass value-safety checks or strand funds.",
    keywords: ["pause", "config", "admin", "peer", "delegate"],
  });
  return obligations;
}

function pushObligation(
  out: ProofObligation[],
  facts: ProvenanceFact[],
  kind: ProvenanceFactKind,
  input: { id: string; property: string; keywords: string[] },
): void {
  const refs = facts.filter((fact) => fact.kind === kind).map((fact) => `${fact.path}:${fact.line}`).slice(0, 16);
  if (refs.length === 0) return;
  out.push({
    id: input.id,
    kind: "provenance",
    property: input.property,
    rationale:
      "This is Solana/Rust provenance guidance, not a finding: the model should enumerate source-backed audit items only when the loaded code makes this account or message edge security-relevant.",
    evidenceRefs: refs,
    keywords: input.keywords,
  });
}

function zkFact(input: {
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string | undefined;
  sourceExpression?: string | undefined;
  nearbySignals: string[];
  code: string;
}): ProvenanceFact {
  return {
    id: `${input.kind}-${slug(input.path)}-${input.line}`,
    domain: "zk-proof-orchestration",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function fact(input: {
  kind: ProvenanceFactKind;
  path: string;
  line: number;
  functionName?: string | undefined;
  label?: string | undefined;
  sourceExpression?: string | undefined;
  nearbySignals: string[];
  code: string;
}): ProvenanceFact {
  return {
    id: `${input.kind}-${slug(input.path)}-${input.line}`,
    domain: "solana-rust",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.label ? { label: input.label.trim() } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function looksLikeSolanaRustDoc(doc: Doc): boolean {
  if (!doc.path.endsWith(".rs")) return false;
  const text = doc.content.toLowerCase();
  return (
    text.includes("anchor_lang") ||
    text.includes("#[program]") ||
    text.includes("#[derive(accounts)]") ||
    text.includes("solana_program") ||
    text.includes("spl_token") ||
    text.includes("tokenaccount") ||
    text.includes("lz_receive") ||
    text.includes("oft")
  );
}

function looksLikeZkProofOrchestrationDoc(doc: Doc): boolean {
  if (!/\.(rs|go)$/.test(doc.path)) return false;
  const text = doc.content.toLowerCase();
  const terms = [
    "provingtask",
    "prover",
    "verifier",
    "proof",
    "witness",
    "public input",
    "public_inputs",
    "pi_hash",
    "stark",
    "snark",
    "zkvm",
    "submitproof",
    "proofmetadata",
    "proofresult",
    "taskid",
    "chunk",
    "batch",
    "bundle",
    "universal",
    "coordinator",
  ];
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits >= 3;
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length, idx + 5);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function nearbyZkSignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length, idx + 5);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return ZK_SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function enclosingFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 120; pos -= 1) {
    const match = /\b(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(lines[pos] ?? "");
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function enclosingRustOrGoFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 120; pos -= 1) {
    const rust = /\b(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(lines[pos] ?? "");
    if (rust?.[1]) return rust[1];
    const go = /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[pos] ?? "");
    if (go?.[1]) return go[1];
  }
  return undefined;
}

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "fact";
}
