export type SubmissionDecisionLike = {
  bug?: string | undefined;
  members?: string[] | undefined;
  reproduced?: string | null | undefined;
  recommendation?: string | null | undefined;
  humanGates?: string | null | undefined;
  engagementProfile?: unknown;
  adjudication?: unknown;
  evidenceLevel?: string | null | undefined;
};

export interface SubmissionReadinessOptions {
  impactInventory?: unknown;
  requireImpactInventory?: boolean;
}

export function enforceSubmissionReadiness<T extends object>(
  rows: T[],
  options: SubmissionReadinessOptions = {},
): T[] {
  return rows.map((row) => {
    const decision = row as SubmissionDecisionLike;
    if (decisionRecommendation(decision) !== "submit-candidate") return row;
    const blocker = submissionReadinessBlocker(decision, options);
    if (!blocker) return row;
    const humanGates = appendHumanGate(decisionHumanGates(decision), `Framework blocked submit-candidate: ${blocker}`);
    return { ...row, recommendation: "needs-human", humanGates } as T;
  });
}

export function isSubmissionReadyDecision(row: object, options: SubmissionReadinessOptions = {}): boolean {
  const decision = row as SubmissionDecisionLike;
  return decisionReproduced(decision) === "yes"
    && decisionRecommendation(decision) === "submit-candidate"
    && !submissionReadinessBlocker(decision, { ...options, requireImpactInventory: options.requireImpactInventory ?? false });
}

export function needsSubmissionReadinessWork(row: object): boolean {
  const decision = row as SubmissionDecisionLike;
  if (decisionReproduced(decision) !== "yes") return false;
  if (decisionRecommendation(decision) === "drop") return false;
  if (isSubmissionReadyDecision(decision)) return false;
  return decisionRecommendation(decision) === "submit-candidate"
    || hasOpenSubmissionGate(decision)
    || isBountyLikePolicy(decision);
}

export function isResumeSettledDecision(row: object): boolean {
  const decision = row as SubmissionDecisionLike;
  if (decisionReproduced(decision) === "no") return true;
  if (decisionRecommendation(decision) === "drop") return true;
  return isSubmissionReadyDecision(decision);
}

export function submissionReadinessBlocker(row: SubmissionDecisionLike, options: SubmissionReadinessOptions = {}): string | undefined {
  if (decisionReproduced(row) !== "yes") return "the row is not reproduced on the real target";
  const evidenceLevel = normalizedWord(decisionEvidenceLevel(row));
  if (evidenceLevel && !isRealTargetEvidenceLevel(evidenceLevel)) return `evidence level is ${evidenceLevel}, not real-target or local-fork reproduced`;
  if (!isBountyLikePolicy(row)) {
    return hasOpenSubmissionGate(row) ? "submission gates remain unsettled in human_gates or adjudication" : undefined;
  }
  const adjudication = decisionAdjudication(row);
  if (options.requireImpactInventory !== false && !impactInventoryCoversRow(row, options.impactInventory)) {
    return "impact_inventory.json has no entry covering this reproduced bounty-like row";
  }
  for (const gate of ["scope", "live_impact", "known_issue", "payout"] as const) {
    const status = bountyGateStatus(adjudication, gate);
    if (!isPassingBountyGateStatus(status, gate)) return `${gate} gate is ${status ? JSON.stringify(status) : "missing"}`;
  }
  if (hasOpenSubmissionGate(row)) return "submission gates remain unsettled in human_gates or adjudication";
  return undefined;
}

export function hasOpenSubmissionGate(row: SubmissionDecisionLike): boolean {
  return hasStructuredBlockingGate(decisionAdjudication(row)) || hasUnsettledHumanGateText(decisionHumanGates(row));
}

export function isBountyLikePolicy(row: SubmissionDecisionLike): boolean {
  const profile = asRecord(decisionEngagementProfile(row));
  const adjudication = asRecord(decisionAdjudication(row));
  const policyKind = normalizedWord(stringValue(profile?.policy_kind ?? profile?.policyKind ?? profile?.kind));
  if (policyKind.includes("bug_bounty") || policyKind.includes("bounty") || policyKind.includes("contest")) return true;
  const requiredRaw = profile?.required_gates ?? profile?.requiredGates;
  const requiredGates = Array.isArray(requiredRaw) ? requiredRaw.map((entry) => normalizedWord(stringValue(entry))) : [];
  const adjudicationHasPayout = Boolean(adjudication && ("payout_estimate" in adjudication || "payoutEstimate" in adjudication || "reward_estimate" in adjudication || "rewardEstimate" in adjudication));
  if (policyKind === "custom" && (requiredGates.some(isRewardGate) || adjudicationHasPayout)) return true;
  if (requiredGates.some(isRewardGate) && adjudicationHasPayout) return true;
  return /\b(?:bounty|reward|payout|collectible)\b/.test(decisionHumanGates(row).toLowerCase());
}

function isRewardGate(gate: string): boolean {
  return gate.includes("payout") || gate.includes("reward") || gate.includes("bounty") || gate.includes("collectible");
}

function decisionReproduced(row: SubmissionDecisionLike): string {
  return stringField(row, ["reproduced"]).toLowerCase();
}

function decisionRecommendation(row: SubmissionDecisionLike): string {
  return stringField(row, ["recommendation"]).toLowerCase();
}

function decisionEvidenceLevel(row: SubmissionDecisionLike): string {
  return stringField(row, ["evidenceLevel", "evidence_level"]);
}

function isRealTargetEvidenceLevel(value: string): boolean {
  return value === "real_target_reproduced" || value === "fork_reproduced" || value === "local_fork_reproduced";
}

function decisionHumanGates(row: SubmissionDecisionLike): string {
  return stringField(row, ["humanGates", "human_gates"]);
}

function decisionEngagementProfile(row: SubmissionDecisionLike): unknown {
  return structuredField(row, ["engagementProfile", "engagement_profile", "engagement_profile_json"]);
}

function decisionAdjudication(row: SubmissionDecisionLike): unknown {
  return structuredField(row, ["adjudication", "adjudication_json"]);
}

function stringField(row: SubmissionDecisionLike, keys: string[]): string {
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
    if (value !== undefined && value !== null && typeof value !== "object") return String(value).trim();
  }
  return "";
}

function structuredField(row: SubmissionDecisionLike, keys: string[]): unknown {
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string") return jsonParseOrNull(value) ?? value;
    return value;
  }
  return undefined;
}

function hasUnsettledHumanGateText(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text) return false;
  if (/^(?:none|n\/a|not applicable|no remaining gates?|no human gates?)\.?$/.test(text)) return false;
  if (/\b(?:no|none)\b.{0,32}\b(?:remaining|open|unsettled|human)\b.{0,24}\b(?:gate|gates|blocker|blockers)\b/.test(text)) return false;
  return /\b(?:scope|venue|eligib|bounty|reward|payout|collectible|live|funded|funds|deployment|production|current|human gate|needs?|requires?|not established|not confirmed|unknown|unclear|unverified|pending|review|cannot be settled|must)\b/.test(text);
}

function hasStructuredBlockingGate(value: unknown): boolean {
  const root = typeof value === "string" ? jsonParseOrNull(value) : value;
  if (!root || typeof root !== "object" || Array.isArray(root)) return false;
  const obj = root as Record<string, unknown>;
  for (const key of ["scope_status", "scopeStatus", "live_impact_status", "liveImpactStatus", "known_issue_status", "knownIssueStatus", "payout_status", "payoutStatus", "reward_status", "rewardStatus"]) {
    const status = stringValue(obj[key]);
    if (status && !isPassingGenericStatus(status)) return true;
  }
  const payout = asRecord(obj.payout_estimate ?? obj.payoutEstimate ?? obj.reward_estimate ?? obj.rewardEstimate);
  const payoutStatus = stringValue(payout?.status);
  if (payoutStatus && !isPassingBountyGateStatus(payoutStatus, "payout")) return true;
  const gateArrays = [obj.gates, obj.required_gates, obj.requiredGates].filter(Array.isArray) as unknown[][];
  for (const gates of gateArrays) {
    for (const gate of gates) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) continue;
      const status = stringValue((gate as Record<string, unknown>).status);
      if (!status) continue;
      if (!isPassingGenericStatus(status)) return true;
    }
  }
  return false;
}

function isPassingGenericStatus(status: string): boolean {
  const normalized = normalizedWord(status);
  return Boolean(normalized) && !isNegativeGateStatus(normalized) && matchesStatus(normalized, [
    "pass",
    "passed",
    "yes",
    "ok",
    "satisfied",
    "confirmed",
    "established",
    "not_required",
    "not_applicable",
    "in_scope",
    "eligible",
    "novel",
    "estimated",
  ]);
}

function bountyGateStatus(adjudication: unknown, gate: "scope" | "live_impact" | "known_issue" | "payout"): string | undefined {
  const record = asRecord(adjudication);
  if (!record) return undefined;
  const direct = directGateStatus(record, gate);
  if (direct) return direct;
  const gates = Array.isArray(record.gates) ? record.gates.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
  const needles = gateNeedles(gate);
  for (const entry of gates) {
    const id = normalizedWord(stringValue(entry.id ?? entry.key ?? entry.name ?? entry.gate));
    if (needles.some((needle) => id.includes(needle))) {
      const status = stringValue(entry.status ?? entry.result ?? entry.state);
      if (status) return status;
    }
  }
  return undefined;
}

function directGateStatus(record: Record<string, unknown>, gate: "scope" | "live_impact" | "known_issue" | "payout"): string | undefined {
  const keys: Record<typeof gate, string[]> = {
    scope: ["scope_status", "scopeStatus", "asset_status", "assetStatus", "eligibility_status", "eligibilityStatus"],
    live_impact: ["live_impact_status", "liveImpactStatus", "funds_status", "fundsStatus", "exposure_status", "exposureStatus"],
    known_issue: ["known_issue_status", "knownIssueStatus", "novelty_status", "noveltyStatus", "duplicate_status", "duplicateStatus"],
    payout: ["payout_status", "payoutStatus", "reward_status", "rewardStatus"],
  };
  for (const key of keys[gate]) {
    const status = stringValue(record[key]);
    if (status) return status;
  }
  if (gate === "payout") {
    const payout = asRecord(record.payout_estimate ?? record.payoutEstimate ?? record.reward_estimate ?? record.rewardEstimate);
    const status = stringValue(payout?.status);
    if (status) return status;
  }
  return undefined;
}

function gateNeedles(gate: "scope" | "live_impact" | "known_issue" | "payout"): string[] {
  switch (gate) {
    case "scope": return ["scope", "venue", "eligib", "asset"];
    case "live_impact": return ["live", "impact", "fund", "exposure", "deployment"];
    case "known_issue": return ["known", "novel", "duplicate", "disclos"];
    case "payout": return ["payout", "reward", "collectible", "bounty"];
  }
}

function isPassingBountyGateStatus(status: string | undefined, gate: "scope" | "live_impact" | "known_issue" | "payout"): boolean {
  const normalized = normalizedWord(status);
  if (!normalized) return false;
  if (isNegativeGateStatus(normalized)) return false;
  if (matchesStatus(normalized, ["pass", "passed", "satisfied", "confirmed", "established", "eligible", "ok", "yes"])) return true;
  if (gate === "scope" && matchesStatus(normalized, ["in_scope", "eligible"])) return true;
  if (gate === "live_impact" && matchesStatus(normalized, ["funded", "live", "live_funded", "affected_live_deployment"])) return true;
  if (gate === "known_issue" && matchesStatus(normalized, ["novel", "not_duplicate", "not_disclosed", "no_known_issue", "not_known"])) return true;
  if (gate === "payout" && matchesStatus(normalized, ["estimated", "collectible"])) return true;
  return false;
}

function isNegativeGateStatus(normalized: string): boolean {
  return matchesStatus(normalized, [
    "fail",
    "failed",
    "unknown",
    "needs_human",
    "blocked",
    "missing",
    "unsettled",
    "not_applicable",
    "unfunded",
    "not_funded",
    "not_live",
    "no_live",
    "no_funds",
    "not_novel",
    "not_estimated",
    "already_disclosed",
    "duplicate",
    "disclosed",
  ]);
}

function matchesStatus(normalized: string, tokens: string[]): boolean {
  return tokens.some((token) => normalized === token || normalized.startsWith(`${token}_`));
}

function impactInventoryCoversRow(row: SubmissionDecisionLike, impactInventory: unknown): boolean {
  const inventory = asRecord(impactInventory);
  const inventoryItems = inventory?.items;
  const itemsRaw = Array.isArray(inventoryItems)
    ? inventoryItems
    : Array.isArray(impactInventory)
      ? impactInventory
      : [];
  if (itemsRaw.length === 0) return false;
  const rowMembers = new Set(decisionMembers(row).map((member) => normalizedWord(member)).filter(Boolean));
  const record = row as Record<string, unknown>;
  const rowBug = normalizedWord(stringValue(row.bug ?? record.title));
  for (const raw of itemsRaw) {
    const item = asRecord(raw);
    if (!item) continue;
    const bug = normalizedWord(stringValue(item.bug ?? item.title));
    if (bug && rowBug && bug === rowBug) return true;
    const members = Array.isArray(item.members) ? item.members.map((member) => normalizedWord(stringValue(member))).filter(Boolean) : [];
    if (members.some((member) => rowMembers.has(member))) return true;
  }
  return false;
}

function decisionMembers(row: SubmissionDecisionLike): string[] {
  if (Array.isArray(row.members)) return row.members.filter((member): member is string => typeof member === "string");
  const raw = (row as Record<string, unknown>).members_json;
  if (typeof raw === "string") {
    const parsed = jsonParseOrNull(raw);
    if (Array.isArray(parsed)) return parsed.filter((member): member is string => typeof member === "string");
  }
  return [];
}

function appendHumanGate(existing: string | undefined, note: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) return note;
  if (trimmed.includes(note)) return trimmed;
  return `${trimmed} ${note}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function normalizedWord(value: unknown): string {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function jsonParseOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
