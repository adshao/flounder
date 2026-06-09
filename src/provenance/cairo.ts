import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const SIGNAL_TERMS = [
  "accesscontrol",
  "amount",
  "assert",
  "balance",
  "block",
  "bridge",
  "builtin",
  "caller",
  "calldata",
  "chain_id",
  "class hash",
  "commitment",
  "contract address",
  "deploy",
  "fee",
  "gas",
  "governance",
  "l1",
  "l2",
  "message",
  "mint",
  "nonce",
  "output",
  "payload",
  "quota",
  "resource",
  "role",
  "signature",
  "state",
  "storage",
  "syscall",
  "token",
  "transaction hash",
  "withdraw",
];

export function extractCairoStarknetProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeCairoDoc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = cairoRoutingObligations(facts);
  return {
    domain: "cairo-starknet",
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
  const pendingAttributes: string[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx] ?? "";
    const code = stripInlineComment(raw).trim();
    if (code.length === 0) continue;
    if (/^#\[[^\]]+\]/.test(code)) {
      pendingAttributes.push(code);
      for (const fact of factsFromLine(doc.path, idx + 1, code, enclosingFunction(lines, idx), nearbySignalsFor(lines, idx), pendingAttributes)) {
        out.push(fact);
      }
      continue;
    }

    const functionName = enclosingFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    for (const fact of factsFromLine(doc.path, idx + 1, code, functionName, nearbySignals, pendingAttributes)) {
      out.push(fact);
    }
    if (/^(?:pub\s+)?(?:func|fn)\s+/.test(code) || /^impl\b/.test(code) || /^\}/.test(code)) {
      pendingAttributes.length = 0;
    }
  }
  return out;
}

function factsFromLine(
  path: string,
  line: number,
  code: string,
  functionName: string | undefined,
  nearbySignals: string[],
  attributes: string[],
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const attrPrefix = attributes.length > 0 ? `${attributes.join(" ")} ` : "";
  const common = { path, line, functionName, nearbySignals, code };

  const legacyFunctionMatch = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/.exec(code);
  const cairoOneFunctionMatch = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(code);
  const functionMatch = legacyFunctionMatch ?? cairoOneFunctionMatch;
  if (functionMatch?.[1]) {
    out.push(
      fact({
        ...common,
        kind: "cairo_entrypoint",
        label: functionMatch[1],
        sourceExpression: oneLine(`${attrPrefix}${code}`),
      }),
    );
  }

  if (/\b(?:execute_[A-Za-z0-9_]*|syscall|syscalls|CallContractRequest|LibraryCallRequest|DeployRequest|ReplaceClassRequest|StorageReadRequest|StorageWriteRequest|GetBlockHashRequest|send_message_to_l1_syscall|deploy_syscall|unwrap_syscall)\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_syscall", sourceExpression: oneLine(`${attrPrefix}${code}`) }));
  }

  if (/\b(?:dict_read|dict_update|squash_dict|squash_state_changes|state_update|contract_state_changes|contract_class_changes|storage_ptr|StateEntry|DictAccess|StorageReadRequest|StorageWriteRequest|\.read\s*\(|\.write\s*\()\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_storage_access", sourceExpression: code }));
  }

  if (/\b(?:l1_handler|send_message_to_l1_syscall|MessageToL1|MessageToL2|messages_to_l1|messages_to_l2|from_address|l1_bridge|l1_token|l2_token|depositor|recipient|payload|WITHDRAW_MESSAGE|handle_deposit|initiate_token_withdraw)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "cairo_l1_l2_message", sourceExpression: oneLine(`${attrPrefix}${code}`) }));
  }

  if (/\b(?:is_valid_signature|validate_signature|signature|VALIDATED|TYPE_HASH|type_hash|message_hash|input_hash|domain_hash|recorded_locks|amount\.low|amount\.high|EIP712|SNIP)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "cairo_signature_hash_binding", sourceExpression: oneLine(`${attrPrefix}${code}`) }));
  }

  if (/\b(?:class_hash|ClassHash|compiled_class_hash|CompiledClassFacts|compiled_class_facts|guess_compiled_class_facts|validate_compiled_class_facts|replace_class|deploy_syscall|erc20_class_hash|l1_l2_token_map|l2_l1_token_map)\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_class_hash_binding", sourceExpression: code }));
  }

  if (/\b(?:remaining_gas|reduce_syscall|ResourceBounds|GAS_COST|fee|quota|locked_amount|total_supply|amount|balance_of|permissioned_mint|permissioned_burn|withdrawal_limit|range_check_ptr|builtin|builtins|gas)\b/i.test(code)) {
    out.push(fact({ ...common, kind: "cairo_resource_accounting", sourceExpression: code }));
  }

  if (/\b(?:BlockContext|get_block_context|block_context|get_block_timestamp|chain_id|fee_token_address|transaction_hash|nonce|block_hash|get_block_hash|TxInfo|ExecutionInfo)\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_block_context", sourceExpression: code }));
  }

  if (/\b(?:OsOutput|os_output|process_os_output|output_ptr|CommitmentUpdate|commitment|calculate_global_state_root|initial_root|final_root|state_update_output|MessageToL1Header|MessageToL2Header|public_keys_hash|starknet_os_config_hash)\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_os_output_commitment", sourceExpression: code }));
  }

  if (/\b(?:assert|assert_lt|assert_nn|assert_nn_le|assert_not_equal|static_assert|with_attr\s+error_message|is_zero|is_non_zero|only_[A-Za-z0-9_]+|AccessControl|only_app_governor|only_security_agent|only_security_admin)\b/.test(code)) {
    out.push(fact({ ...common, kind: "cairo_assertion_or_constraint", sourceExpression: code }));
  }

  return out;
}

function cairoRoutingObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "cairo_entrypoint", {
    id: "cairo-entrypoint-authority-and-state-boundary",
    property:
      "Cairo entrypoints, constructors, embedded ABI implementations, and L1 handlers should bind caller authority, L1 sender, role, lifecycle state, and the affected storage or message domain before mutation.",
    keywords: ["cairo", "entrypoint", "authority", "l1 handler", "state"],
  });
  pushObligation(obligations, facts, "cairo_syscall", {
    id: "cairo-syscall-request-response-context-binding",
    property:
      "Starknet syscall implementations and syscall users should bind request structs, caller execution context, class hash, selector, gas accounting, revert semantics, and response layout before state or message effects.",
    keywords: ["syscall", "context", "gas", "selector", "response"],
  });
  pushObligation(obligations, facts, "cairo_storage_access", {
    id: "cairo-storage-dict-state-commitment-integrity",
    property:
      "Storage reads, writes, dict updates, squashing, and state updates should preserve key domain, previous value, new value, revert log, alias handling, and final state commitment integrity.",
    keywords: ["storage", "dict", "state", "commitment", "revert"],
  });
  pushObligation(obligations, facts, "cairo_l1_l2_message", {
    id: "cairo-l1-l2-message-origin-payload-accounting",
    property:
      "L1/L2 bridge handlers and message sends should bind L1 bridge address, from address, token mapping, sender, recipient, amount, payload ordering, replay assumptions, and callback effects before mint, burn, lock, unlock, or delivery.",
    keywords: ["l1", "l2", "message", "bridge", "payload", "amount"],
  });
  pushObligation(obligations, facts, "cairo_signature_hash_binding", {
    id: "cairo-signature-hash-full-payload-binding",
    property:
      "Cairo signed-request hash construction should bind account, domain, contract, nonce, expiry, delegate or recipient, replay key, and every limb of any u256 amount before the signed request can mutate balances, locks, votes, or permissions.",
    keywords: ["signature", "hash", "nonce", "amount", "replay"],
  });
  pushObligation(obligations, facts, "cairo_class_hash_binding", {
    id: "cairo-class-hash-deploy-replace-binding",
    property:
      "Class hash, compiled class hash, deployment, replacement, and token mapping flows should bind declared code identity, governance authorization, salt, constructor calldata, and mapping uniqueness before execution or asset representation changes.",
    keywords: ["class hash", "deploy", "replace", "mapping", "governance"],
  });
  pushObligation(obligations, facts, "cairo_resource_accounting", {
    id: "cairo-resource-fee-quota-supply-conservation",
    property:
      "Gas, resource bounds, range-check segregation, fee token, withdrawal quota, locked amount, mint, burn, and balance checks should preserve supply and liveness invariants under revert, callback, and boundary conditions.",
    keywords: ["gas", "quota", "fee", "supply", "amount"],
  });
  pushObligation(obligations, facts, "cairo_block_context", {
    id: "cairo-block-context-tx-info-binding",
    property:
      "Block context, transaction hash, nonce, chain id, fee token, block hash, execution info, and version-specific metadata should remain bound to the same executed statement and public output.",
    keywords: ["block", "transaction", "nonce", "chain id", "hash"],
  });
  pushObligation(obligations, facts, "cairo_os_output_commitment", {
    id: "cairo-os-output-state-root-message-commitment",
    property:
      "Starknet OS output should commit to the finalized state roots, class roots, carried L1/L2 messages, block header fields, public keys hash, and serialized output segment without omitting or reordering security-critical data.",
    keywords: ["os output", "state root", "message", "commitment"],
  });
  pushObligation(obligations, facts, "cairo_assertion_or_constraint", {
    id: "cairo-assertion-coverage-for-security-values",
    property:
      "Assertions and constraint-like checks should cover the exact value later used for authority, token accounting, storage keys, class hashes, message payloads, resource accounting, and state commitments.",
    keywords: ["assert", "constraint", "coverage", "binding"],
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
      "This is Cairo/Starknet provenance guidance, not a finding: the model should enumerate source-backed audit items only when the loaded code makes this state, syscall, message, or commitment edge security-relevant.",
    evidenceRefs: refs,
    keywords: input.keywords,
  });
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
    domain: "cairo-starknet",
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

function looksLikeCairoDoc(doc: Doc): boolean {
  return doc.path.endsWith(".cairo");
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length, idx + 5);
  const text = lines.slice(start, end).join("\n").toLowerCase().replace(/[_-]+/g, " ");
  return SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function enclosingFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 160; pos -= 1) {
    const legacy = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/.exec(lines[pos] ?? "");
    if (legacy?.[1]) return legacy[1];
    const cairoOne = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[pos] ?? "");
    if (cairoOne?.[1]) return cairoOne[1];
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

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function slug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "fact";
}
