import type { AuditResult, AuditSummary, RankedFinding, Severity, TrialFinding } from "../types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function aggregate(results: AuditResult[]): AuditSummary {
  const findings: RankedFinding[] = [];
  for (const result of results) {
    if (result.nHits === 0) continue;
    const best = bestTrial(result.trials);
    const score = SEVERITY_RANK[best.severity] * 2 + result.hitRate * 3 + best.confidence;
    findings.push({
      id: result.item.id,
      location: result.item.location,
      failureMode: result.item.failureMode,
      title: best.title,
      severity: best.severity,
      hitRate: round(result.hitRate),
      confidence: best.confidence,
      score: round(score),
      description: best.description,
      evidence: best.evidence,
      exploitSketch: best.exploitSketch,
      fix: best.fix,
    });
  }
  findings.sort((a, b) => b.score - a.score);
  return {
    coverage: {
      itemsTotal: results.length,
      itemsWithFinding: findings.length,
      bySeverity: {
        critical: count(findings, "critical"),
        high: count(findings, "high"),
        medium: count(findings, "medium"),
        low: count(findings, "low"),
        info: count(findings, "info"),
      },
    },
    findings,
  };
}

function bestTrial(trials: TrialFinding[]): TrialFinding {
  const hits = trials.filter((trial) => trial.finding);
  const pool = hits.length > 0 ? hits : trials;
  return pool.reduce((best, trial) => {
    const a = SEVERITY_RANK[trial.severity] * 2 + trial.confidence;
    const b = SEVERITY_RANK[best.severity] * 2 + best.confidence;
    return a > b ? trial : best;
  });
}

function count(findings: RankedFinding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
