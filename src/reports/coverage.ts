import type { AuditItem, AuditResult, Doc, FailureMode, Severity } from "../types.js";
import type { SymbolRef } from "../index/source-index.js";
import { canonicalLocationFile } from "../util/paths.js";

export interface ChecklistCoverage {
  itemsTotal: number;
  byFailureMode: Partial<Record<FailureMode, number>>;
  bySeeder: Record<string, number>;
  bySourceFile: Record<string, number>;
}

export interface RunCoverage {
  checklist: ChecklistCoverage;
  audit: {
    auditedItems: number;
    itemsWithFinding: number;
    bySeverity: Partial<Record<Severity, number>>;
    averageHitRate: number;
  };
}

export function summarizeChecklist(items: AuditItem[]): ChecklistCoverage {
  return {
    itemsTotal: items.length,
    byFailureMode: countBy(items, (item) => item.failureMode),
    bySeeder: countBy(items, (item) => item.seeder ?? "llm"),
    bySourceFile: countBy(items, (item) => canonicalLocationFile(item.location)),
  };
}

export function summarizeRun(items: AuditItem[], results: AuditResult[]): RunCoverage {
  const hits = results.filter((result) => result.nHits > 0);
  return {
    checklist: summarizeChecklist(items),
    audit: {
      auditedItems: results.length,
      itemsWithFinding: hits.length,
      bySeverity: countBy(
        hits.flatMap((result) => result.trials.filter((trial) => trial.finding).map((trial) => trial.severity)),
        (severity) => severity,
      ),
      averageHitRate: round(results.reduce((sum, result) => sum + result.hitRate, 0) / Math.max(1, results.length)),
    },
  };
}

export function summarizeSourceIndex(docs: Doc[], symbols: SymbolRef[]): object {
  return {
    docs: docs.map((doc) => ({
      path: doc.path,
      kind: doc.kind,
      chars: doc.content.length,
      lines: doc.content.split(/\r?\n/).length,
    })),
    symbols,
    bySymbolKind: countBy(symbols, (symbol) => symbol.kind),
  };
}

function countBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
