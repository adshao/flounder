import type { Doc, ProofObligation, ProvenanceFact, ProvenanceFactKind, ProvenanceGraph } from "../types.js";

const WORMHOLE_GO_SIGNAL_TERMS = [
  "admin",
  "attestation",
  "broadcast",
  "chain",
  "chain id",
  "consistency",
  "emitter",
  "finality",
  "governance",
  "guardian",
  "guardian set",
  "governor",
  "gossip",
  "hash",
  "libp2p",
  "limit",
  "message",
  "nonce",
  "observation",
  "peer",
  "persistence",
  "price",
  "quorum",
  "reobserve",
  "sequence",
  "signature",
  "token",
  "transaction",
  "vaa",
  "watcher",
];

export function extractGoWormholeProvenance(source: Doc[]): ProvenanceGraph {
  const facts: ProvenanceFact[] = [];
  let files = 0;
  for (const doc of source) {
    if (!looksLikeWormholeGoDoc(doc)) continue;
    files += 1;
    facts.push(...extractFactsFromDoc(doc));
  }
  const obligations = wormholeGoObligations(facts);
  return {
    domain: "go-wormhole",
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
    const functionName = enclosingGoFunction(lines, idx);
    const nearbySignals = nearbySignalsFor(lines, idx);
    for (const fact of factsFromLine(doc.path, idx + 1, code, functionName, nearbySignals)) {
      out.push(fact);
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
): ProvenanceFact[] {
  const out: ProvenanceFact[] = [];
  const common = { path, line, functionName, nearbySignals, code };

  if (
    /\b(?:Observation|SignedObservation|ObservationRequest|MessagePublication|EmitterAddress|EmitterChain|Sequence|ConsistencyLevel|TxHash|TransactionID|AccountDigest|SourceChain|RawContract|HandleObservation|handleObservation|observe|reobserve)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_guardian_observation", sourceExpression: code }));
  }

  if (
    /\b(?:VAA|vaa|SignedVAA|GuardianSet|guardianSet|GuardianSetIndex|guardianSetIndex|Quorum|quorum|Signature|signatures|AddSignature|Sign|sign|digest|Digest|Verify|verify|BodyHash|SigningDigest)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_vaa_signing", sourceExpression: code }));
  }

  if (
    /\b(?:Governor|governor|ChainGovernor|Enqueue|Release|IsVAAEnqueued|CheckTransfer|TrimAndSumValue|notional|tokenPrice|dailyLimit|flow|limit|pending|TransferDetails|TransferPayload)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_governor", sourceExpression: code }));
  }

  if (
    /\b(?:gossipv1|libp2p|peer|Broadcast|Publish|Subscribe|Recv|Send|Envelope|Heartbeat|SignedObservation|SignedVAA|GuardianSetUpdate|HandleMessage|processMessage|p2p)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_p2p_message", sourceExpression: code }));
  }

  if (
    /\b(?:Watcher|watcher|Connector|Run|Poll|PollFinalizedBlocks|Finality|finality|finalized|Block|block|Reorg|reorg|Confirmation|confirmations|transaction|txHash|TxHash|receipt|SourceChain|LogMessagePublished|ParseLogMessagePublished|MessagePublication)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_chain_watcher", sourceExpression: code }));
  }

  if (
    /\b(?:admin|Admin|governance|config|Config|unsafeDevMode|GuardianKey|Set|Update|env|flag|permissioned|operator|guardianAddress|publicRPC|listenAddr)\b/.test(
      code,
    )
  ) {
    out.push(fact({ ...common, kind: "go_wormhole_admin_config", sourceExpression: code }));
  }

  return out;
}

function wormholeGoObligations(facts: ProvenanceFact[]): ProofObligation[] {
  const obligations: ProofObligation[] = [];
  pushObligation(obligations, facts, "go_wormhole_guardian_observation", {
    id: "go-wormhole-observation-source-message-binding",
    property:
      "Guardian observations should bind source chain, emitter address, sequence, payload digest, transaction identity, and finality state before they become signable VAA material.",
    keywords: ["observation", "emitter", "sequence", "finality", "vaa"],
  });
  pushObligation(obligations, facts, "go_wormhole_vaa_signing", {
    id: "go-wormhole-vaa-signature-quorum-binding",
    property:
      "VAA signing and verification should bind the exact body digest, guardian-set index, ordered signatures, quorum threshold, and replay or duplicate-signature handling.",
    keywords: ["vaa", "signature", "guardian set", "quorum", "digest"],
  });
  pushObligation(obligations, facts, "go_wormhole_governor", {
    id: "go-wormhole-governor-queued-transfer-integrity",
    property:
      "Governor queue and release paths should preserve transfer identity, token price/notional accounting, chain limits, and replay state so queued value cannot be released or bypassed under changed context.",
    keywords: ["governor", "queue", "release", "limit", "notional"],
  });
  pushObligation(obligations, facts, "go_wormhole_p2p_message", {
    id: "go-wormhole-p2p-message-auth-dedup-domain",
    property:
      "P2P guardian messages should authenticate the claimed guardian, domain-separate message types, deduplicate observations and VAAs, and bound malformed or oversized gossip before trust-sensitive processing.",
    keywords: ["p2p", "gossip", "guardian", "dedup", "message"],
  });
  pushObligation(obligations, facts, "go_wormhole_chain_watcher", {
    id: "go-wormhole-chain-watcher-finality-reorg-binding",
    property:
      "Chain watchers should bind emitted messages to canonical finalized source-chain events and handle reorg, duplicate log, fork, and chain-ID confusion before publishing observations.",
    keywords: ["watcher", "finality", "reorg", "chain id", "transaction"],
  });
  pushObligation(obligations, facts, "go_wormhole_admin_config", {
    id: "go-wormhole-admin-config-authority-boundary",
    property:
      "Guardian node admin, key, governance, RPC, and operational config should stay inside intended authority boundaries and should not let untrusted network or CLI input alter signing, observation, or release policy.",
    keywords: ["admin", "config", "key", "governance", "authority"],
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
      "This is Wormhole Go provenance guidance, not a finding: the model should enumerate source-backed audit items only when the loaded code makes this guardian, watcher, VAA, governor, or gossip edge security-relevant.",
    evidenceRefs: refs,
    keywords: input.keywords,
  });
}

function fact(input: {
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
    domain: "go-wormhole",
    kind: input.kind,
    path: input.path,
    line: input.line,
    ...(input.functionName ? { functionName: input.functionName } : {}),
    ...(input.sourceExpression ? { sourceExpression: input.sourceExpression.trim() } : {}),
    nearbySignals: input.nearbySignals,
    code: input.code,
  };
}

function looksLikeWormholeGoDoc(doc: Doc): boolean {
  if (!doc.path.endsWith(".go")) return false;
  const text = doc.content.toLowerCase();
  const path = doc.path.toLowerCase();
  const terms = [
    "wormhole",
    "guardian",
    "guardian set",
    "signedobservation",
    "signedvaa",
    "messagepublication",
    "chain governor",
    "chaingovernor",
    "governor",
    "transferdetails",
    "dailylimit",
    "notional",
    "watcher",
    "pollfinalizedblocks",
    "finalized",
    "parselogmessagepublished",
    "sourcechain",
    "txhash",
    "config",
    "guardiankey",
    "unsafedevmode",
    "adminclient",
    "gossipv1",
    "vaa",
    "emitteraddress",
    "sequence",
  ];
  let hits =
    path.includes("wormhole") ||
    path.includes("node/pkg") ||
    path.includes("guardiand") ||
    path.includes("governor") ||
    path.includes("watcher") ||
    path.includes("processor")
      ? 1
      : 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits >= 3;
}

function nearbySignalsFor(lines: string[], idx: number): string[] {
  const start = Math.max(0, idx - 4);
  const end = Math.min(lines.length, idx + 5);
  const text = lines.slice(start, end).join("\n").toLowerCase();
  return WORMHOLE_GO_SIGNAL_TERMS.filter((term) => text.includes(term)).slice(0, 12);
}

function enclosingGoFunction(lines: string[], idx: number): string | undefined {
  for (let pos = idx; pos >= 0 && pos >= idx - 120; pos -= 1) {
    const match = /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[pos] ?? "");
    if (match?.[1]) return match[1];
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
