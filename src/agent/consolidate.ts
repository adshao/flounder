import type { AuditorConfig } from "../config.js";
import type { SandboxWorkspace } from "../security/sandbox.js";
import type { RunLogger } from "../trace/logger.js";
import { runDifferentialConfirmation } from "./differential.js";
import type { AgentFinding, CommandRunRecord, FixPatch } from "./tools.js";

// Framework-orchestrated, execution-grounded consolidation (the "fix-equivalence
// matrix"). Two reproduced bugs are the SAME underlying bug iff a single fix
// neutralizes both PoCs — proven by EXECUTION, not by similar titles or nearby
// locations. We test it by cross-application: apply bug i's fix to the pristine
// target source and re-run bug j's exploit PoC; if j's exploit is now blocked, fix i
// neutralizes poc j. When that holds in BOTH directions the two are merged. This
// reuses the differential primitive (apply-fix-to-baseline, re-run, check-blocked);
// the framework — never the model — runs it and decides the merges.

export interface FixEquivItem {
  id: string;
  fixPatch?: FixPatch;
  /** The passing PoC run for this bug (its commandSpec is re-run after a fix is applied). */
  exploitRun?: CommandRunRecord;
  /** Patterns the PoC prints once the exploit is BLOCKED (the differential's blocked signal). */
  patchedSuccessPatterns?: string[];
}

export interface FixEquivEdge {
  fixOf: string;
  pocOf: string;
  blocked: boolean;
  reason: string;
}

export interface FixEquivResult {
  /** Connected components over the symmetric "same bug" relation (input order preserved). */
  clusters: string[][];
  /** Every cross-application probe the matrix ran, for the audit trail. */
  edges: FixEquivEdge[];
  /** Set when the matrix was skipped (too many items) — every item stays its own cluster. */
  skipped?: boolean;
}

/**
 * Pure transitive clustering: items a and b land in the same cluster when
 * `equivalent(a, b)` (the relation is treated as symmetric and transitively closed).
 * Cluster + representative order follows first appearance in `ids`. No I/O — unit-testable.
 */
export function unionFindClusters(ids: string[], equivalent: (a: string, b: string) => boolean): string[][] {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (start: string): string => {
    let root = start;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = start;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      if (equivalent(a, b)) union(a, b);
    }
  }
  const out: string[][] = [];
  const repIndex = new Map<string, number>();
  for (const id of ids) {
    const root = find(id);
    let idx = repIndex.get(root);
    if (idx === undefined) {
      idx = out.length;
      repIndex.set(root, idx);
      out.push([]);
    }
    (out[idx] as string[]).push(id);
  }
  return out;
}

/**
 * Run the fix-equivalence matrix over reproduced bugs and return their clusters. Only
 * items that carry BOTH a fix and a passing PoC (with a blocked-exploit signal) can be
 * probed; an item missing either cannot be tested and stays its own singleton cluster
 * (honest — the framework never merges what it cannot prove). Confirm is unbounded by
 * default, so the full matrix runs unless a caller explicitly supplies `maxItems` for a
 * bounded run.
 */
export async function consolidateByFixEquivalence(input: {
  items: FixEquivItem[];
  workspace: SandboxWorkspace;
  baselineFiles: Set<string>;
  cfg: AuditorConfig;
  logger: RunLogger;
  cacheDir?: string;
  maxItems?: number;
}): Promise<FixEquivResult> {
  const { items } = input;
  const ids = items.map((item) => item.id);
  const edges: FixEquivEdge[] = [];
  const maxItems = input.maxItems;
  if (maxItems !== undefined && items.length > maxItems) {
    await input.logger.event("audit_confirm_equiv_skipped", { items: items.length, maxItems });
    return { clusters: ids.map((id) => [id]), edges, skipped: true };
  }

  // Does applying `fixItem`'s fix to the pristine source block `pocItem`'s exploit PoC?
  const fixBlocksPoc = async (fixItem: FixEquivItem, pocItem: FixEquivItem): Promise<boolean> => {
    if (!fixItem.fixPatch || !pocItem.exploitRun || !pocItem.exploitRun.passed) return false;
    if (pocItem.exploitRun.successPatterns.length === 0) return false;
    if (!pocItem.patchedSuccessPatterns || pocItem.patchedSuccessPatterns.length === 0) return false;
    const synthetic: AgentFinding = {
      id: `${fixItem.id}~fix~blocks~${pocItem.id}~poc`,
      title: "",
      severity: "medium",
      location: "",
      description: "",
      evidence: "",
      exploitSketch: "",
      fix: "",
      confidence: 1,
      confirmationStatus: "confirmed-executable",
      fixPatch: fixItem.fixPatch,
      patchedSuccessPatterns: pocItem.patchedSuccessPatterns,
    };
    const res = await runDifferentialConfirmation({
      workspace: input.workspace,
      finding: synthetic,
      exploitRun: pocItem.exploitRun,
      baselineFiles: input.baselineFiles,
      cfg: input.cfg,
      logger: input.logger,
      ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}),
    });
    edges.push({ fixOf: fixItem.id, pocOf: pocItem.id, blocked: res.confirmed, reason: res.reason });
    return res.confirmed;
  };

  // Collect the symmetric "same bug" pairs. Short-circuit: only probe the reverse
  // direction when the forward one held, so non-equivalent pairs cost one probe.
  const equivPairs = new Set<string>();
  const key = (a: string, b: string): string => (a < b ? `${a}::${b}` : `${b}::${a}`);
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i] as FixEquivItem;
      const b = items[j] as FixEquivItem;
      if (!(await fixBlocksPoc(a, b))) continue;
      if (!(await fixBlocksPoc(b, a))) continue;
      equivPairs.add(key(a.id, b.id));
    }
  }
  const clusters = unionFindClusters(ids, (a, b) => equivPairs.has(key(a, b)));
  await input.logger.event("audit_confirm_equiv", { items: items.length, clusters: clusters.length, merges: items.length - clusters.length });
  return { clusters, edges };
}
