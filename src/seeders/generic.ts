import type { AuditItem, Doc, FailureMode } from "../types.js";

export function genericSecuritySeeders(source: Doc[]): AuditItem[] {
  return [
    ...seedSolidityExternalCalls(source),
    ...seedSignatureReplay(source),
    ...seedBalanceIntegrity(source),
    ...seedSolidityNameRegistryResolution(source),
    ...seedSolidityWormholeVaaBinding(source),
    ...seedZkProofOrchestrationBinding(source),
    ...seedRustDoS(source),
  ];
}

function seedSolidityExternalCalls(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    if (!doc.path.endsWith(".sol")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!/(\.call\s*\(|\.delegatecall\s*\(|\.transfer\s*\(|\.send\s*\()/.test(line)) continue;
      items.push(makeItem({
        id: `solidity-reentrancy-${items.length + 1}`,
        location: `${doc.path}:${idx + 1}`,
        mode: "reentrancy",
        property: "External calls must not allow attacker-controlled re-entry before state and accounting are finalized.",
        why: "This line performs an external value/control transfer. Check whether state changes, balance updates, and authorization happen before the call.",
        inputs: ["callee contract", "fallback/receive function", "transaction ordering"],
        seeder: "solidity_external_call",
      }));
    }
  }
  return items;
}

function seedSignatureReplay(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!/(ecrecover|verify_signature|verifySignature|Signature|signature)/.test(line)) continue;
      const nearby = lines.slice(Math.max(0, idx - 8), Math.min(lines.length, idx + 9)).join("\n");
      if (/(nonce|domain|chain.?id|context|expiry|expires|timestamp)/i.test(nearby)) continue;
      items.push(makeItem({
        id: `signature-replay-${items.length + 1}`,
        location: `${doc.path}:${idx + 1}`,
        mode: "signature_replay",
        property: "Accepted signatures must be bound to domain, context, and uniqueness so they cannot be replayed across calls or deployments.",
        why: "Signature handling appears without a nearby nonce, domain separator, chain id, context, or expiry binding.",
        inputs: ["signed message", "signature bytes", "execution context"],
        seeder: "signature_replay",
      }));
    }
  }
  return items;
}

function seedBalanceIntegrity(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  const functionPattern = /\b(fn|function|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  for (const doc of source) {
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      const match = functionPattern.exec(line);
      const name = match?.[2];
      if (!name || !/(mint|burn|transfer|withdraw|deposit|settle|balance|supply|fee|nullifier|spend)/i.test(name)) continue;
      items.push(makeItem({
        id: `balance-integrity-${items.length + 1}`,
        location: `${doc.path}:${idx + 1}`,
        mode: "supply_balance_integrity",
        property: "Value conservation and accounting invariants must hold across every path through this operation.",
        why: `The operation name '${name}' suggests value, supply, or spend accounting. Check all branches for conservation and turnstile boundaries.`,
        inputs: ["amounts", "fees", "account identifiers", "proof/private inputs"],
        seeder: "balance_integrity",
      }));
    }
  }
  return items;
}

function seedSolidityNameRegistryResolution(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  const declarationPattern = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  const operationPattern =
    /\b(register|renew|reserve|resolve|migrate|wrap|unwrap|setResolver|setSubregistry|setParent|setName|setAddr|setText|setContenthash|setFuses|setChildFuses|claim|ownerOf|getState|getResolver|getSubregistry)\b/;
  const contextPattern =
    /\b(ENS|registry|registrar|resolver|namehash|label|tokenId|owner|expiry|expires|fuse|reverse|DNSSEC|migration|reserved|subregistry)\b/i;

  for (const doc of source) {
    if (!doc.path.endsWith(".sol")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      const fn = declarationPattern.exec(line)?.[1];
      if (!fn || !operationPattern.test(fn)) continue;
      if (line.trim().endsWith(";")) continue;
      const nearby = lines.slice(Math.max(0, idx - 10), Math.min(lines.length, idx + 18)).join("\n");
      if (!contextPattern.test(nearby)) continue;
      items.push(makeItem({
        id: `solidity-name-registry-resolution-${items.length + 1}`,
        location: `${doc.path}:${idx + 1}`,
        mode: "evm_name_registry_resolution",
        property: "Name registry, resolver, expiry, role, and migration operations must preserve owner authority and final resolution without unauthorized minting, resolver substitution, expiry shortening, or stale-state reuse.",
        why: `The Solidity function '${fn}' changes or reads ENS-style registry, resolver, expiry, reverse, fuse, or migration state. Check caller authority, token/resource identity, expiry status, resolver target, and old-version state transitions together.`,
        inputs: ["name label or node", "owner or caller address", "resolver/subregistry address", "expiry or migration state"],
        seeder: "solidity_name_registry_resolution",
      }));
    }
  }
  return items;
}

function seedSolidityWormholeVaaBinding(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  const seen = new Set<string>();
  const declarationPattern = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  const functionPattern =
    /^(?:parseAndVerifyVM|parseVM|verifyVM|verifyVMInternal|verifySignatures|verifyGovernanceVM|verifyGovernanceVm|publishMessage|completeTransfer|completeTransferWithPayload|completeTransferAndUnwrapETH|attestToken|submit|register|upgrade|update|transferTokens|wrapAndTransfer)/i;
  const contextPattern =
    /\b(Wormhole|IWormhole|VAA|vaa|VM|encodedVM|encodedVm|guardianSet|guardianSetIndex|governanceActionIsConsumed|governanceActionsConsumed|emitterChainId|emitterAddress|sequence|consistencyLevel|bridgeContracts|TransferRedeemed)\b/;

  for (const doc of source) {
    if (!doc.path.endsWith(".sol")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      const fn = declarationPattern.exec(line)?.[1];
      if (!fn || !functionPattern.test(fn)) continue;
      const nearby = solidityFunctionSnippet(lines, idx);
      if (!nearby) continue;
      if (!contextPattern.test(nearby)) continue;
      const common = { doc, line: idx + 1, fn, nearby };
      if (/\b(parseAndVerifyVM|parseVM|verifyVM|verifySignatures|guardianSet|guardianSetIndex|quorum|signatures|ecrecover|vm\.hash)\b/.test(nearby)) {
        pushWormholeVaaItem(items, seen, {
          ...common,
          mode: "evm_wormhole_vaa_verification",
          seeder: "solidity_wormhole_vaa_verification",
          idPrefix: "solidity-wormhole-vaa-verification",
          property:
            "Wormhole VAA consumers must bind parsed VM fields to body hash, guardian-set index, guardian quorum, ordered signatures, emitter identity, sequence, and replay state before trusting the VAA.",
          why: `The Solidity function '${fn}' parses, verifies, or consumes Wormhole VAA / guardian-set data. Check that parse-only fields are not trusted without the required hash, quorum, signature-ordering, and guardian-set validity checks.`,
          inputs: ["encoded VAA bytes", "guardian signatures", "guardian-set index", "emitter chain/address", "sequence"],
        });
      }
      if (/\b(verifyGovernanceVM|verifyGovernanceVm|governanceChainId|governanceContract|governanceActionIsConsumed|governanceActionsConsumed|consumedGovernanceActions|setGovernanceActionConsumed|consumeGovernanceAction|parseGovernanceVM|governanceModule)\b/i.test(nearby)) {
        pushWormholeVaaItem(items, seen, {
          ...common,
          mode: "evm_wormhole_governance_binding",
          seeder: "solidity_wormhole_governance_binding",
          idPrefix: "solidity-wormhole-governance-binding",
          property:
            "Wormhole governance VAA execution must bind governance chain, governance emitter, module/action payload, current guardian set, and replay consumption before any privileged mutation.",
          why: `The Solidity function '${fn}' appears to consume governance VAA state. Check that a valid VAA for another emitter, chain, module, action, stale guardian set, or consumed hash cannot execute this mutation.`,
          inputs: ["governance VAA", "governance chain id", "governance emitter", "module/action payload", "consumed hash"],
        });
      }
      if (
        /^(?:completeTransfer|completeTransferWithPayload|completeTransferAndUnwrapETH|transferTokens|transferTokensWithPayload|wrapAndTransfer|wrapAndTransferETH|wrapAndTransferETHWithPayload|attestToken|updateWrapped|createWrapped|logTransfer)/i.test(
          fn,
        ) ||
        /\b(TransferRedeemed|parseTransfer|_completeTransfer|_updateWrapped|_createWrapped|logTransferWithPayload)\b/.test(nearby)
      ) {
        pushWormholeVaaItem(items, seen, {
          ...common,
          mode: "evm_bridge_credit_accounting",
          seeder: "solidity_wormhole_token_bridge_accounting",
          idPrefix: "solidity-wormhole-token-bridge-accounting",
          property:
            "Portal Token Bridge completion must bind source bridge contract, emitter chain/address, sequence, token identity, amount, decimals, recipient, relayer fee, AssetMeta provenance, and replay state to the matching source lock, burn, or attestation.",
          why: `The Solidity function '${fn}' appears to publish or complete a Wormhole Token Bridge transfer or metadata attestation. Check lock/burn to mint/release conservation, source bridge-contract binding, replay, recipient, relayer-fee, AssetMeta source generation, wrapped-token self-attestation, and wrapped-token metadata rules together.`,
          inputs: ["transfer or AssetMeta VAA", "source bridge contract", "token chain/address", "amount and decimals", "recipient and relayer fee", "wrapped-asset registry state"],
        });
      }
    }
  }
  return items;
}

function seedZkProofOrchestrationBinding(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  const seen = new Set<string>();
  const statementPattern =
    /\b(BlockWitness|ChunkTask|BatchProvingTask|BundleProvingTask|ProvingTask|block_hashes|block_hash|try_fetch_.*witness|fetch.*Witness|serialized_witness|task_data|pi_hash|public_?inputs?|post_blockhash|metadata)\b/i;
  const aggregationPattern =
    /\b(aggregated_proofs|chunk_proofs|batch_proofs|check_aggregation|AggregationInput|into_stark_proof|verify_.*proof|public_values|pi_hash)\b/i;
  const submissionPattern =
    /\b(submit_?proof|SubmitProof|verify_?proof|Verifier|verifier|task_?id|taskID|ProofMetadata|ProofResult|proofs?|vk)\b/i;

  for (const doc of source) {
    if (!/\.(rs|go)$/.test(doc.path)) continue;
    const lower = doc.content.toLowerCase();
    if (!looksLikeProofOrchestration(lower)) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = stripInlineComment(lines[idx] ?? "");
      if (line.trim().length === 0) continue;
      if (/^\s*(use|pub\s+mod|mod|import|package)\b/.test(line)) continue;
      const nearby = lines.slice(Math.max(0, idx - 8), Math.min(lines.length, idx + 12)).join("\n");
      if (!/\b(proof|proving|prover|verifier|witness|public.?input|pi_hash|metadata|chunk|batch|bundle|rollup|zk|stark|snark|universal|task)\b/i.test(nearby)) {
        continue;
      }
      const scope = enclosingRustOrGoFunction(lines, idx) ?? `line-${idx + 1}`;
      if (statementPattern.test(line)) {
        pushProofBindingItem(items, seen, {
          doc,
          line: idx + 1,
          scope,
          mode: "proof_statement_binding",
          seeder: "zk_proof_statement_binding",
          idPrefix: "zk-proof-statement-binding",
          property:
            "Proof task requests, witness source results, serialized witness bytes, metadata, and public inputs must all describe the same statement before proving or accepting a proof.",
          why: "This proof orchestration line handles task identity, witness data, metadata, or public-input derivation. Check that returned witness material is rebound to the requested task instead of replacing it.",
          inputs: ["requested task identity", "witness source response", "serialized witness", "statement metadata", "public input hash"],
        });
      }
      if (aggregationPattern.test(line)) {
        pushProofBindingItem(items, seen, {
          doc,
          line: idx + 1,
          scope,
          mode: "proof_aggregation_binding",
          seeder: "zk_proof_aggregation_binding",
          idPrefix: "zk-proof-aggregation-binding",
          property:
            "Aggregated proofs and their public inputs must be length-checked, order-checked, and rebound to the expected chunk, batch, bundle, and verification-key metadata.",
          why: "This proof orchestration line handles recursive proof aggregation or public values. Check proof-count, ordering, metadata, and verification-key binding before trusting aggregate outputs.",
          inputs: ["inner proofs", "public values", "chunk or batch metadata", "verification key", "aggregate task id"],
        });
      }
      if (submissionPattern.test(line)) {
        pushProofBindingItem(items, seen, {
          doc,
          line: idx + 1,
          scope,
          mode: "proof_verifier_submission_binding",
          seeder: "zk_proof_verifier_submission_binding",
          idPrefix: "zk-proof-verifier-submission-binding",
          property:
            "Proof submission and verifier paths must bind submitted proof bytes to the stored task id, statement metadata, verification key, assignment state, and downstream finalized claim.",
          why: "This line appears on a verifier or submit-proof boundary. Check that caller-submitted proof bytes cannot be accepted under stale, mismatched, or coordinator-stored metadata for another statement.",
          inputs: ["submitted proof bytes", "task id", "stored metadata", "verification key", "coordinator assignment state"],
        });
      }
    }
  }
  return items;
}

function seedRustDoS(source: Doc[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const doc of source) {
    if (!doc.path.endsWith(".rs")) continue;
    const lines = doc.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      if (!/(\.unwrap\s*\(|\.expect\s*\(|panic!\s*\()/.test(line)) continue;
      items.push(makeItem({
        id: `rust-dos-${items.length + 1}`,
        location: `${doc.path}:${idx + 1}`,
        mode: "dos_resource",
        property: "Attacker-controlled inputs must not trigger panics, crashes, or unbounded resource use in consensus or exposed request paths.",
        why: "This Rust panic/unwrap site should be checked for attacker-controlled reachability.",
        inputs: ["serialized inputs", "network messages", "proof data", "RPC parameters"],
        seeder: "rust_dos",
      }));
    }
  }
  return items;
}

function pushWormholeVaaItem(
  items: AuditItem[],
  seen: Set<string>,
  input: {
    doc: Doc;
    line: number;
    fn: string;
    mode: FailureMode;
    seeder: string;
    idPrefix: string;
    property: string;
    why: string;
    inputs: string[];
  },
): void {
  const key = `${input.doc.path}:${input.fn}:${input.mode}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(makeItem({
    id: `${input.idPrefix}-${items.length + 1}`,
    location: `${input.doc.path}:${input.line}`,
    mode: input.mode,
    property: input.property,
    why: input.why,
    inputs: input.inputs,
    seeder: input.seeder,
  }));
}

function pushProofBindingItem(
  items: AuditItem[],
  seen: Set<string>,
  input: {
    doc: Doc;
    line: number;
    scope: string;
    mode: FailureMode;
    seeder: string;
    idPrefix: string;
    property: string;
    why: string;
    inputs: string[];
  },
): void {
  const key = `${input.doc.path}:${input.scope}:${input.mode}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(makeItem({
    id: `${input.idPrefix}-${items.length + 1}`,
    location: `${input.doc.path}:${input.line}`,
    mode: input.mode,
    property: input.property,
    why: input.why,
    inputs: input.inputs,
    seeder: input.seeder,
  }));
}

function looksLikeProofOrchestration(loweredContent: string): boolean {
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
    if (loweredContent.includes(term)) hits += 1;
  }
  return hits >= 3;
}

function stripInlineComment(line: string): string {
  const idx = line.indexOf("//");
  return idx >= 0 ? line.slice(0, idx) : line;
}

function solidityFunctionSnippet(lines: string[], idx: number): string | undefined {
  const snippet: string[] = [];
  let sawBrace = false;
  let depth = 0;
  for (let pos = idx; pos < lines.length && pos < idx + 120; pos += 1) {
    const line = lines[pos] ?? "";
    snippet.push(line);
    if (!sawBrace && line.includes(";") && !line.includes("{")) return undefined;
    for (const char of line) {
      if (char === "{") {
        sawBrace = true;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawBrace && depth <= 0) break;
  }
  return sawBrace ? snippet.join("\n") : undefined;
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

function makeItem(input: {
  id: string;
  location: string;
  mode: FailureMode;
  property: string;
  why: string;
  inputs: string[];
  seeder: string;
}): AuditItem {
  return {
    id: input.id,
    location: input.location,
    securityProperty: input.property,
    failureMode: input.mode,
    why: input.why,
    attackerControlledInputs: input.inputs,
    seeder: input.seeder,
  };
}
