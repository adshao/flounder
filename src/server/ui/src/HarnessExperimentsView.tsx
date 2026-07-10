import { useState, type FormEvent } from "react";
import {
  api,
  type HarnessCandidateProposal,
  type HarnessExperimentCreatePayload,
  type HarnessExperimentRow,
  type HarnessScoreMetrics,
  type RunGroupRow,
} from "./api";
import { Button, Counter, Modal } from "./components";
import { evaluationMetrics, harnessDecisionLabel, harnessExperimentLabel, harnessExperimentTone, type EvaluationTone } from "./evaluation-domain";
import { Icon } from "./icons";

type ToastTone = "info" | "success" | "warning" | "error";

export function HarnessExperimentRailRow({ experiment, selected, onSelect }: { experiment: HarnessExperimentRow; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`evaluation-rail-row harness-rail-row${selected ? " sel" : ""}`} onClick={onSelect} aria-current={selected ? "page" : undefined}>
      <span className="evaluation-rail-main"><strong>{experiment.name}</strong><small>{experiment.baseline_name} → {experiment.candidate_name ?? "candidate pending"}</small></span>
      <ExperimentPill tone={harnessExperimentTone(experiment)}>{harnessExperimentLabel(experiment)}</ExperimentPill>
      <span className="evaluation-rail-meta">
        <span>{experiment.failurePatterns.length} weaknesses</span>
        <span>{experiment.scorecard ? `${experiment.scorecard.improvedItemKeys.length} improved` : "Not scored"}</span>
      </span>
    </button>
  );
}

export function HarnessExperimentsOverview({ experiments, onSelect, onNew }: { experiments: HarnessExperimentRow[]; onSelect: (uuid: string) => void; onNew: () => void }) {
  const promoted = experiments.filter((experiment) => experiment.decision === "promote").length;
  const awaiting = experiments.filter((experiment) => !experiment.decision).length;
  const weaknesses = experiments.reduce((sum, experiment) => sum + experiment.failurePatterns.length, 0);
  return (
    <div className="evaluation-page harness-overview">
      <div className="evaluation-page-head">
        <div><span className="eyebrow">Governed self-improvement</span><h1>Harness experiments</h1><p>Mine execution-grounded failures, constrain candidate changes, and promote only variants that improve paired evaluations without weakening controls.</p></div>
        <Button variant="primary" icon="package" onClick={onNew}>New experiment</Button>
      </div>
      <div className="evaluation-summary-strip" aria-label="Harness experiment summary">
        <ExperimentMetric label="Experiments" value={String(experiments.length)} detail={`${awaiting} awaiting decision`} />
        <ExperimentMetric label="Weakness patterns" value={String(weaknesses)} detail="Clustered by verifier cause" />
        <ExperimentMetric label="Promoted" value={String(promoted)} detail="No-regression gate passed" tone={promoted ? "success" : "neutral"} />
        <ExperimentMetric label="Protected boundary" value="External" detail="Evaluator and safety stay fixed" />
      </div>
      <section className="evaluation-section">
        <div className="evaluation-section-head"><div><h2>Recent experiments</h2><p>Each candidate is compared against a finished baseline with the same stable work-item keys.</p></div></div>
        {experiments.length ? (
          <div className="evaluation-overview-list harness-overview-list">
            {experiments.slice(0, 8).map((experiment) => (
              <button key={experiment.uuid} onClick={() => onSelect(experiment.uuid)}>
                <ExperimentPill tone={harnessExperimentTone(experiment)}>{harnessExperimentLabel(experiment)}</ExperimentPill>
                <span><strong>{experiment.name}</strong><small>{experiment.baseline_name} → {experiment.candidate_name ?? "Candidate not attached"}</small></span>
                <span className="evaluation-overview-score">{experiment.failurePatterns.length} patterns<Icon name="arrowright" size={14} /></span>
              </button>
            ))}
          </div>
        ) : <div className="evaluation-empty-items"><p>No harness experiment has been created.</p><Button variant="primary" icon="package" onClick={onNew}>Create first experiment</Button></div>}
      </section>
    </div>
  );
}

export function HarnessExperimentDetail({ experiment, busy, onBack, onAttach, onRefine, onEvaluate, onCopyBrief }: {
  experiment: HarnessExperimentRow;
  busy: string;
  onBack: () => void;
  onAttach: () => void;
  onRefine: () => void;
  onEvaluate: () => void;
  onCopyBrief: () => void;
}) {
  const baselineMetrics = experiment.scorecard?.baseline ?? metricsFromGroup(experiment.baselineGroup);
  const candidateMetrics = experiment.scorecard?.candidate ?? metricsFromGroup(experiment.candidateGroup);
  const canEvaluate = Boolean(experiment.candidateGroup && experiment.proposal);
  return (
    <div className="evaluation-page harness-detail-page">
      <button className="evaluation-back" onClick={onBack}><Icon name="arrowright" size={13} />Back to harness experiments</button>
      <header className="evaluation-detail-head">
        <div className="evaluation-title-block">
          <div className="evaluation-title-line"><ExperimentPill tone={harnessExperimentTone(experiment)}>{harnessExperimentLabel(experiment)}</ExperimentPill><span>Harness experiment</span><span>{experiment.failurePatterns.length} patterns</span></div>
          <h1>{experiment.name}</h1>
          <p>{experiment.scorecard?.reasons[0] ?? (experiment.proposal ? "Candidate proposal is bounded by verifier-grounded failures and protected promotion rules." : "The baseline has no score-eligible weakness to propose against yet.")}</p>
        </div>
        <div className="evaluation-actions">
          {experiment.proposal ? <Button icon="file" disabled={busy !== ""} onClick={onCopyBrief}>Copy brief</Button> : null}
          {experiment.proposal ? <Button disabled={busy !== ""} onClick={onRefine}>Refine proposal</Button> : null}
          <Button icon="package" disabled={busy !== ""} onClick={onAttach}>{experiment.candidateGroup ? "Replace candidate" : "Attach candidate"}</Button>
          <Button variant="primary" icon="play" disabled={busy !== "" || !canEvaluate} onClick={onEvaluate}>{busy === "evaluate" ? "Evaluating…" : "Evaluate"}</Button>
        </div>
      </header>

      {experiment.decision ? (
        <div className={`harness-decision-banner ${experiment.decision}`}>
          <span><Icon name={experiment.decision === "promote" ? "shieldcheck" : experiment.decision === "reject" ? "bug" : "clock"} /></span>
          <div><strong>{harnessDecisionLabel(experiment.decision)}</strong><p>{experiment.scorecard?.reasons.join(" ")}</p></div>
        </div>
      ) : (
        <div className="evaluation-callout"><Icon name="clock" /><span><strong>Promotion stays external.</strong>This experiment may recommend a candidate, but it cannot edit the evaluator, merge code, or deploy a release.</span></div>
      )}

      <section className="harness-comparison" aria-label="Baseline and candidate comparison">
        <div className="harness-comparison-head">
          <span>Metric</span><strong>Baseline · {experiment.baseline_name}</strong><strong>Candidate · {experiment.candidate_name ?? "not attached"}</strong>
        </div>
        <ComparisonRow label="Positive recall" baseline={formatMetricRate(baselineMetrics?.positiveRecall)} candidate={formatMetricRate(candidateMetrics?.positiveRecall)} />
        <ComparisonRow label="Control pass" baseline={formatMetricRate(baselineMetrics?.controlPassRate)} candidate={formatMetricRate(candidateMetrics?.controlPassRate)} />
        <ComparisonRow label="Holdout pass" baseline={formatHoldouts(baselineMetrics)} candidate={formatHoldouts(candidateMetrics)} />
        <ComparisonRow label="Families / stacks" baseline={formatDiversity(baselineMetrics)} candidate={formatDiversity(candidateMetrics)} />
        <ComparisonRow label="Blocked" baseline={baselineMetrics ? String(baselineMetrics.blocked) : "—"} candidate={candidateMetrics ? String(candidateMetrics.blocked) : "—"} />
        <ComparisonRow label="Attempts" baseline={baselineMetrics ? String(baselineMetrics.attempts) : "—"} candidate={candidateMetrics ? String(candidateMetrics.attempts) : "—"} />
        <ComparisonRow label="Duration" baseline={formatDuration(baselineMetrics?.durationSeconds)} candidate={formatDuration(candidateMetrics?.durationSeconds)} />
      </section>

      <div className="harness-detail-grid">
        <section className="evaluation-section harness-weakness-section">
          <div className="evaluation-section-head"><div><h2>Verifier-grounded weaknesses <Counter>{experiment.failurePatterns.length}</Counter></h2><p>Patterns come only from persisted evidence verdicts and terminal causes.</p></div></div>
          {experiment.failurePatterns.length ? (
            <div className="harness-pattern-list">
              {experiment.failurePatterns.map((pattern) => (
                <div key={pattern.id}>
                  <span className="harness-pattern-kind">{pattern.kind.replaceAll("-", " ")}</span>
                  <strong>{pattern.mechanism}</strong>
                  <p>{pattern.verifierCause}</p>
                  <small>{pattern.occurrences} occurrence{pattern.occurrences === 1 ? "" : "s"} · {pattern.workItemKeys.join(", ")}</small>
                </div>
              ))}
            </div>
          ) : <p className="evaluation-muted">No failed, blocked, or invalid baseline evidence is available to mine.</p>}
        </section>

        <section className="evaluation-section harness-proposal-section">
          <div className="evaluation-section-head"><div><h2>Candidate proposal</h2><p>The proposal can narrow its changes, but cannot widen its editable surface.</p></div></div>
          {experiment.proposal ? (
            <>
              <div className="harness-proposal-copy"><strong>{experiment.proposal.title}</strong><p>{experiment.proposal.hypothesis}</p></div>
              <div className="harness-change-list">
                {experiment.proposal.changes.map((change) => <div key={change.path}><code>{change.path}</code><p>{change.summary}</p></div>)}
              </div>
              <div className="harness-protected-boundary"><Icon name="shieldcheck" /><span><strong>Protected</strong> Evaluator, benchmark answers, material policy, sandbox, confirmation/refutation, tests, promotion, merge, and deploy.</span></div>
            </>
          ) : <p className="evaluation-muted">A candidate proposal appears only after the baseline produces an actionable verifier-grounded weakness.</p>}
        </section>
      </div>

      <section className="evaluation-section harness-gate-section">
        <div className="evaluation-section-head"><div><h2>Promotion gate</h2><p>Deterministic policy applied to paired persisted evidence, never to candidate claims.</p></div></div>
        <div className="harness-gate-rules">
          <span><strong>{experiment.promotionPolicy.minimumSamplesPerClass}</strong> positive and control samples per variant</span>
          <span><strong>{experiment.promotionPolicy.minimumDistinctCases}</strong> distinct positive cases</span>
          <span><strong>{experiment.promotionPolicy.minimumDistinctFamilies}</strong> distinct bug families</span>
          <span><strong>{experiment.promotionPolicy.minimumHoldoutCases}</strong> hidden holdout cases, all passing</span>
          <span><strong>{experiment.promotionPolicy.minimumImprovedCases}</strong> minimum improved paired case</span>
          <span><strong>0</strong> paired regressions</span>
          <span><strong>{formatRate(experiment.promotionPolicy.maxBlockedRate)}</strong> maximum blocked rate</span>
          <span><strong>{experiment.promotionPolicy.maxDurationRatio.toFixed(2)}×</strong> maximum duration ratio</span>
          <span><strong>{experiment.promotionPolicy.maxAttemptRatio.toFixed(2)}×</strong> maximum attempt ratio</span>
        </div>
        {experiment.scorecard ? (
          <div className="harness-score-details">
            <div><small>Improved</small><strong>{experiment.scorecard.improvedItemKeys.length ? experiment.scorecard.improvedItemKeys.join(", ") : "None"}</strong></div>
            <div><small>Regressed</small><strong>{experiment.scorecard.regressedItemKeys.length ? experiment.scorecard.regressedItemKeys.join(", ") : "None"}</strong></div>
            <div><small>Evaluated</small><strong>{formatTime(experiment.scorecard.evaluatedAt)}</strong></div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function NewHarnessExperimentModal({ groups, onClose, onCreated }: { groups: RunGroupRow[]; onClose: () => void; onCreated: (experiment: HarnessExperimentRow) => void }) {
  const finished = groups.filter((group) => group.state === "finished" && group.items.some((item) => typeof item.result?.accepted === "boolean"));
  const [name, setName] = useState("");
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [editableFiles, setEditableFiles] = useState("src/agent/prompts.ts");
  const [minimumSamples, setMinimumSamples] = useState("2");
  const [minimumDistinctCases, setMinimumDistinctCases] = useState("2");
  const [minimumDistinctFamilies, setMinimumDistinctFamilies] = useState("2");
  const [minimumHoldouts, setMinimumHoldouts] = useState("1");
  const [minimumImproved, setMinimumImproved] = useState("1");
  const [maxDurationRatio, setMaxDurationRatio] = useState("1.25");
  const [maxAttemptRatio, setMaxAttemptRatio] = useState("1.25");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const payload: HarnessExperimentCreatePayload = {
        name,
        baselineRunGroupUuid: baseline,
        ...(candidate ? { candidateRunGroupUuid: candidate } : {}),
        editableFiles: splitLines(editableFiles),
        promotionPolicy: {
          minimumSamplesPerClass: Number(minimumSamples),
          minimumDistinctCases: Number(minimumDistinctCases),
          minimumDistinctFamilies: Number(minimumDistinctFamilies),
          minimumHoldoutCases: Number(minimumHoldouts),
          minimumImprovedCases: Number(minimumImproved),
          requireAllControlsPass: true,
          maxBlockedRate: 0,
          maxDurationRatio: Number(maxDurationRatio),
          maxAttemptRatio: Number(maxAttemptRatio),
        },
      };
      onCreated(await api.createHarnessExperiment(payload));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New harness experiment" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="new-harness-experiment-form" variant="primary" disabled={submitting || !name.trim() || !baseline || splitLines(editableFiles).length === 0}>{submitting ? "Mining…" : "Mine and propose"}</Button></>}>
      <form id="new-harness-experiment-form" className="evaluation-form" onSubmit={submit}>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="evaluation-form-grid">
          <label className="field">Experiment name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Map recall candidate" autoFocus /></label>
          <label className="field">Finished baseline<select value={baseline} onChange={(event) => { setBaseline(event.target.value); if (candidate === event.target.value) setCandidate(""); }}><option value="">Select baseline</option>{finished.map((group) => <option key={group.uuid} value={group.uuid}>{group.name}</option>)}</select><small>Weaknesses are mined from this group's persisted evidence.</small></label>
          <label className="field">Candidate evaluation<select value={candidate} onChange={(event) => setCandidate(event.target.value)}><option value="">Attach later</option>{finished.filter((group) => group.uuid !== baseline).map((group) => <option key={group.uuid} value={group.uuid}>{group.name}</option>)}</select><small>Use the same stable work-item keys as the baseline.</small></label>
          <label className="field evaluation-field-wide">Bounded editable files<textarea value={editableFiles} onChange={(event) => setEditableFiles(event.target.value)} rows={4} /><small>One repository-relative path per line. Only approved prompts, skills, and agent harness files are accepted.</small></label>
        </div>
        <div className="harness-policy-fields">
          <label className="field">Samples per class<input type="number" min="1" max="100" value={minimumSamples} onChange={(event) => setMinimumSamples(event.target.value)} /></label>
          <label className="field">Distinct cases<input type="number" min="1" max="100" value={minimumDistinctCases} onChange={(event) => setMinimumDistinctCases(event.target.value)} /></label>
          <label className="field">Distinct families<input type="number" min="1" max="100" value={minimumDistinctFamilies} onChange={(event) => setMinimumDistinctFamilies(event.target.value)} /></label>
          <label className="field">Hidden holdouts<input type="number" min="0" max="100" value={minimumHoldouts} onChange={(event) => setMinimumHoldouts(event.target.value)} /></label>
          <label className="field">Minimum improvements<input type="number" min="1" max="100" value={minimumImproved} onChange={(event) => setMinimumImproved(event.target.value)} /></label>
          <label className="field">Duration budget<input type="number" min="1" max="10" step="0.05" value={maxDurationRatio} onChange={(event) => setMaxDurationRatio(event.target.value)} /></label>
          <label className="field">Attempt budget<input type="number" min="1" max="10" step="0.05" value={maxAttemptRatio} onChange={(event) => setMaxAttemptRatio(event.target.value)} /></label>
        </div>
        <div className="harness-protected-boundary"><Icon name="shieldcheck" /><span><strong>Always outside the loop</strong> Evaluator, expected answers, material policy, sandbox, evidence gates, promotion, merge, and deploy.</span></div>
      </form>
    </Modal>
  );
}

export function AttachHarnessCandidateModal({ experiment, groups, onClose, onAttached }: { experiment: HarnessExperimentRow; groups: RunGroupRow[]; onClose: () => void; onAttached: (experiment: HarnessExperimentRow) => void }) {
  const choices = groups.filter((group) => group.uuid !== experiment.baseline_uuid && group.items.length > 0);
  const [candidate, setCandidate] = useState(experiment.candidate_uuid ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setSubmitting(true);
    try {
      onAttached(await api.attachHarnessCandidate(experiment.uuid, candidate));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Modal title="Attach candidate evaluation" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!candidate || submitting} onClick={() => void submit()}>{submitting ? "Attaching…" : "Attach candidate"}</Button></>}>
      <div className="evaluation-form">
        {error ? <div className="form-error">{error}</div> : null}
        <label className="field">Candidate run group<select value={candidate} onChange={(event) => setCandidate(event.target.value)}><option value="">Select candidate</option>{choices.map((group) => <option key={group.uuid} value={group.uuid}>{group.name} · {group.state}</option>)}</select><small>The promotion gate rejects mismatched work-item keys and evidence expectations.</small></label>
      </div>
    </Modal>
  );
}

export function RefineHarnessProposalModal({ experiment, onClose, onUpdated }: { experiment: HarnessExperimentRow; onClose: () => void; onUpdated: (experiment: HarnessExperimentRow) => void }) {
  const proposal = experiment.proposal!;
  const [title, setTitle] = useState(proposal.title);
  const [hypothesis, setHypothesis] = useState(proposal.hypothesis);
  const [summaries, setSummaries] = useState<Record<string, string>>(Object.fromEntries(proposal.changes.map((change) => [change.path, change.summary])));
  const [preserve, setPreserve] = useState(proposal.preserve.join("\n"));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const next: HarnessCandidateProposal = {
        ...proposal,
        title,
        hypothesis,
        changes: proposal.editableFiles.map((proposalPath) => ({ path: proposalPath, summary: summaries[proposalPath] ?? "" })),
        preserve: splitLines(preserve),
      };
      onUpdated(await api.updateHarnessProposal(experiment.uuid, next));
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Modal title="Refine bounded proposal" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="refine-harness-proposal-form" variant="primary" disabled={submitting || !title.trim() || !hypothesis.trim()}>{submitting ? "Saving…" : "Save proposal"}</Button></>}>
      <form id="refine-harness-proposal-form" className="evaluation-form" onSubmit={submit}>
        {error ? <div className="form-error">{error}</div> : null}
        <label className="field">Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field">Testable hypothesis<textarea rows={3} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></label>
        {proposal.editableFiles.map((proposalPath) => <label key={proposalPath} className="field"><code>{proposalPath}</code><textarea rows={3} value={summaries[proposalPath] ?? ""} onChange={(event) => setSummaries((current) => ({ ...current, [proposalPath]: event.target.value }))} /></label>)}
        <label className="field">Passing behavior to preserve<textarea rows={4} value={preserve} onChange={(event) => setPreserve(event.target.value)} /></label>
        <div className="harness-protected-boundary"><Icon name="shieldcheck" /><span>The file list and verifier-pattern IDs are immutable in this editor.</span></div>
      </form>
    </Modal>
  );
}

function ComparisonRow({ label, baseline, candidate }: { label: string; baseline: string; candidate: string }) {
  return <div className="harness-comparison-row"><span>{label}</span><strong>{baseline}</strong><strong>{candidate}</strong></div>;
}

function ExperimentMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: EvaluationTone }) {
  return <div className={`evaluation-metric tone-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function ExperimentPill({ tone, children }: { tone: EvaluationTone; children: React.ReactNode }) {
  return <span className={`evaluation-status tone-${tone}`}>{children}</span>;
}

function metricsFromGroup(group?: RunGroupRow | null): HarnessScoreMetrics | null {
  if (!group) return null;
  const metrics = evaluationMetrics(group);
  const durations = group.items.map((item) => durationSeconds(item.started_at, item.ended_at)).filter((value): value is number => value !== null);
  const positives = group.items.filter((item) => item.evidenceContract.expectedOutcome === "detect-positive");
  const controls = group.items.filter((item) => item.evidenceContract.expectedOutcome === "reject-positive");
  const distinct = (items: typeof group.items, field: "caseId" | "caseFamily" | "targetStack") => new Set(items.map((item) => item.evidenceContract[field]).filter(Boolean)).size;
  const distinctCases = (items: typeof group.items) => new Set(items.map((item) => item.evidenceContract.caseId ?? item.item_key)).size;
  const holdoutItems = group.items.filter((item) => item.evidenceContract.holdout === true);
  const holdouts = new Map<string, typeof group.items>();
  for (const item of holdoutItems) {
    const key = item.evidenceContract.caseId ?? item.item_key;
    holdouts.set(key, [...(holdouts.get(key) ?? []), item]);
  }
  return {
    total: metrics.total,
    scored: metrics.scored,
    passed: metrics.passed,
    positives: metrics.positives,
    positivesPassed: metrics.positivesPassed,
    controls: metrics.controls,
    controlsPassed: metrics.controlsPassed,
    blocked: metrics.blocked,
    invalid: metrics.invalid,
    attempts: group.items.reduce((sum, item) => sum + item.attempts, 0),
    durationSeconds: durations.length === group.items.length && group.items.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : null,
    passRate: metrics.passRate,
    positiveRecall: metrics.positiveRecall,
    controlPassRate: metrics.controlPassRate,
    blockedRate: metrics.total ? metrics.blocked / metrics.total : 0,
    distinctPositiveCases: distinctCases(positives),
    distinctControlCases: distinctCases(controls),
    distinctFamilies: distinct(positives, "caseFamily"),
    distinctStacks: distinct(group.items, "targetStack"),
    holdouts: holdouts.size,
    holdoutsPassed: [...holdouts.values()].filter((samples) => samples.every((item) => item.result?.accepted === true)).length,
  };
}

function durationSeconds(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : null;
}

function formatMetricRate(value?: number | null): string {
  return value === null || value === undefined ? "—" : formatRate(value);
}

function formatHoldouts(metrics?: HarnessScoreMetrics | null): string {
  return metrics ? `${metrics.holdoutsPassed}/${metrics.holdouts}` : "—";
}

function formatDiversity(metrics?: HarnessScoreMetrics | null): string {
  return metrics ? `${metrics.distinctFamilies} / ${metrics.distinctStacks}` : "—";
}

function formatRate(value: number): string {
  return `${Math.round(value * 10_000) / 100}%`;
}

function formatDuration(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${value % 60}s`;
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function splitLines(value: string): string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
