import type { AuditItem, Doc, FailureMode } from "../types.js";

export function genericSecuritySeeders(source: Doc[]): AuditItem[] {
  return [
    ...seedSolidityExternalCalls(source),
    ...seedSignatureReplay(source),
    ...seedBalanceIntegrity(source),
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
