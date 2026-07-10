import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  type DaemonRow,
  type ExpectedOutcome,
  type HarnessExperimentRow,
  type ProviderProfile,
  type RunGroupCreatePayload,
  type RunGroupReportResponse,
  type RunGroupRow,
  type WorkItemPayload,
  type WorkItemRow,
} from "./api";
import { Button, Counter, IconButton, Modal } from "./components";
import {
  canAddWorkItem,
  canCancelRunGroup,
  canPauseRunGroup,
  canRetryWorkItem,
  canStartRunGroup,
  evaluationMetrics,
  groupStateLabel,
  groupStateTone,
  workItemStateLabel,
  workItemTone,
  type EvaluationTone,
} from "./evaluation-domain";
import {
  AttachHarnessCandidateModal,
  HarnessExperimentDetail,
  HarnessExperimentRailRow,
  HarnessExperimentsOverview,
  NewHarnessExperimentModal,
  RefineHarnessProposalModal,
} from "./HarnessExperimentsView";
import { Icon } from "./icons";

type EvaluationFilter = "all" | "active" | "attention" | "finished" | "draft";
type ToastTone = "info" | "success" | "warning" | "error";

interface EvaluationsWorkspaceProps {
  selectedUuid?: string;
  providers: ProviderProfile[];
  daemons: DaemonRow[];
  onSelect: (uuid?: string) => void;
  onToast: (tone: ToastTone, message: string) => void;
}

export function EvaluationsWorkspace({ selectedUuid, providers, daemons, onSelect, onToast }: EvaluationsWorkspaceProps) {
  const [groups, setGroups] = useState<RunGroupRow[]>([]);
  const [experiments, setExperiments] = useState<HarnessExperimentRow[]>([]);
  const [railMode, setRailMode] = useState<"runs" | "evolution">("runs");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EvaluationFilter>("all");
  const [newOpen, setNewOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<RunGroupReportResponse | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [experimentBusy, setExperimentBusy] = useState("");
  const [expandedItem, setExpandedItem] = useState<number | null>(null);
  const [newExperimentOpen, setNewExperimentOpen] = useState(false);
  const [attachCandidateOpen, setAttachCandidateOpen] = useState(false);
  const [refineProposalOpen, setRefineProposalOpen] = useState(false);

  const mergeGroup = useCallback((group: RunGroupRow) => {
    setGroups((current) => {
      const next = current.some((entry) => entry.uuid === group.uuid)
        ? current.map((entry) => entry.uuid === group.uuid ? group : entry)
        : [group, ...current];
      return next.sort(sortGroups);
    });
  }, []);

  const mergeExperiment = useCallback((experiment: HarnessExperimentRow) => {
    setExperiments((current) => {
      const next = current.some((entry) => entry.uuid === experiment.uuid)
        ? current.map((entry) => entry.uuid === experiment.uuid ? experiment : entry)
        : [experiment, ...current];
      return next.sort(sortExperiments);
    });
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [groupResponse, experimentResponse] = await Promise.all([api.runGroups(), api.harnessExperiments()]);
      let next = groupResponse.runGroups.sort(sortGroups);
      let nextExperiments = experimentResponse.experiments.sort(sortExperiments);
      if (selectedUuid) {
        const groupExists = next.some((group) => group.uuid === selectedUuid);
        const experimentExists = nextExperiments.some((experiment) => experiment.uuid === selectedUuid);
        if (experimentExists) {
          try {
            const detail = await api.harnessExperiment(selectedUuid);
            nextExperiments = nextExperiments
              .map((experiment) => experiment.uuid === selectedUuid ? detail : experiment)
              .sort(sortExperiments);
          } catch {
            // The lists still provide a useful workspace if a copied URL is stale.
          }
        } else if (!groupExists) {
          try {
            next = [await api.runGroup(selectedUuid), ...next].sort(sortGroups);
          } catch {
            try {
              nextExperiments = [await api.harnessExperiment(selectedUuid), ...nextExperiments].sort(sortExperiments);
            } catch {
              // The lists still provide a useful workspace if a copied URL is stale.
            }
          }
        }
      }
      setGroups(next);
      setExperiments(nextExperiments);
      setError("");
    } catch (refreshError) {
      setError(errorMessage(refreshError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [selectedUuid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needsPolling = groups.some((group) => group.state === "running" || group.state === "queued"
    || group.items.some((item) => item.state === "queued" || item.state === "claimed" || item.state === "running"));
  useEffect(() => {
    if (!needsPolling) return;
    const timer = window.setInterval(() => void refresh(true), 2500);
    return () => window.clearInterval(timer);
  }, [needsPolling, refresh]);

  const selected = selectedUuid ? groups.find((group) => group.uuid === selectedUuid) : undefined;
  const selectedExperiment = selectedUuid ? experiments.find((experiment) => experiment.uuid === selectedUuid) : undefined;
  useEffect(() => {
    if (selectedExperiment) setRailMode("evolution");
    else if (selected) setRailMode("runs");
  }, [selected, selectedExperiment]);
  const visibleGroups = useMemo(() => groups.filter((group) => {
    const metrics = evaluationMetrics(group);
    const text = `${group.name} ${group.kind}`.toLowerCase();
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false;
    if (filter === "active") return group.state === "running" || group.state === "queued" || group.state === "paused";
    if (filter === "attention") return group.state === "failed" || metrics.blocked > 0 || metrics.failed > 0;
    if (filter === "finished") return group.state === "finished";
    if (filter === "draft") return group.state === "draft";
    return true;
  }), [filter, groups, query]);
  const visibleExperiments = useMemo(() => experiments.filter((experiment) => {
    const text = `${experiment.name} ${experiment.baseline_name} ${experiment.candidate_name ?? ""}`.toLowerCase();
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false;
    if (filter === "active") return experiment.state === "evaluating";
    if (filter === "attention") return experiment.state === "needs-evidence" || experiment.decision === "reject" || experiment.decision === "needs-more-samples";
    if (filter === "finished") return experiment.state === "decided";
    if (filter === "draft") return experiment.state === "proposal-ready";
    return true;
  }), [experiments, filter, query]);

  async function applyAction(key: string, action: () => Promise<RunGroupRow>, success: string, successTone: ToastTone = "success") {
    setBusyAction(key);
    try {
      const group = await action();
      mergeGroup(group);
      onToast(successTone, success);
      await refresh(true);
    } catch (actionError) {
      onToast("error", errorMessage(actionError));
    } finally {
      setBusyAction("");
    }
  }

  async function openReport(group: RunGroupRow) {
    setReportOpen(true);
    setReportLoading(true);
    try {
      setReport(await api.runGroupReport(group.uuid));
    } catch (reportError) {
      onToast("error", errorMessage(reportError));
    } finally {
      setReportLoading(false);
    }
  }

  async function applyExperimentAction(key: string, action: () => Promise<HarnessExperimentRow>, success: string) {
    setExperimentBusy(key);
    try {
      const experiment = await action();
      mergeExperiment(experiment);
      onToast(experiment.decision === "promote" ? "success" : "info", success);
      await refresh(true);
    } catch (actionError) {
      onToast("error", errorMessage(actionError));
    } finally {
      setExperimentBusy("");
    }
  }

  async function copyCandidateBrief(experiment: HarnessExperimentRow) {
    setExperimentBusy("brief");
    try {
      const response = await api.harnessExperimentBrief(experiment.uuid);
      await copyText(response.markdown);
      onToast("success", "Bounded candidate brief copied.");
    } catch (copyError) {
      onToast("error", errorMessage(copyError));
    } finally {
      setExperimentBusy("");
    }
  }

  const onlineDaemons = daemons.filter((daemon) => daemon.online).length;
  return (
    <>
      <aside className="evaluation-rail" aria-label="Audit evaluations">
        <div className="rail-head">
          <div><h2>Evaluations</h2><Counter>{railMode === "runs" ? groups.length : experiments.length}</Counter></div>
          <Button size="sm" icon="package" onClick={() => railMode === "runs" ? setNewOpen(true) : setNewExperimentOpen(true)}>New</Button>
        </div>
        <div className="evaluation-mode-switch" role="tablist" aria-label="Evaluation workspace mode">
          <button role="tab" aria-selected={railMode === "runs"} className={railMode === "runs" ? "sel" : ""} onClick={() => { setRailMode("runs"); onSelect(); }}>Runs</button>
          <button role="tab" aria-selected={railMode === "evolution"} className={railMode === "evolution" ? "sel" : ""} onClick={() => { setRailMode("evolution"); onSelect(); }}>Harness</button>
        </div>
        <div className="evaluation-filters">
          <div className="project-search-row evaluation-search-row">
            <Icon name="search" size={14} />
            <input aria-label="Search evaluations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search evaluations" />
          </div>
          <select aria-label="Filter evaluations" value={filter} onChange={(event) => setFilter(event.target.value as EvaluationFilter)}>
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="attention">Needs attention</option>
            <option value="finished">Finished</option>
            <option value="draft">Draft</option>
          </select>
        </div>
        <div className="evaluation-list">
          {loading && groups.length === 0 && experiments.length === 0 ? <RailMessage>Loading evaluations…</RailMessage> : null}
          {!loading && error ? <RailMessage tone="danger">{error}</RailMessage> : null}
          {!loading && !error && railMode === "runs" && visibleGroups.length === 0 ? <RailMessage>No evaluations match this view.</RailMessage> : null}
          {!loading && !error && railMode === "evolution" && visibleExperiments.length === 0 ? <RailMessage>No harness experiments match this view.</RailMessage> : null}
          {railMode === "runs" ? visibleGroups.map((group) => <EvaluationRailRow key={group.uuid} group={group} selected={group.uuid === selectedUuid} onSelect={() => onSelect(group.uuid)} />) : null}
          {railMode === "evolution" ? visibleExperiments.map((experiment) => <HarnessExperimentRailRow key={experiment.uuid} experiment={experiment} selected={experiment.uuid === selectedUuid} onSelect={() => onSelect(experiment.uuid)} />) : null}
        </div>
      </aside>
      <main className="evaluation-workspace">
        {selected ? (
          <EvaluationDetail
            group={selected}
            onlineDaemons={onlineDaemons}
            busyAction={busyAction}
            expandedItem={expandedItem}
            onBack={() => onSelect()}
            onExpand={(id) => setExpandedItem((current) => current === id ? null : id)}
            onAdd={() => setAddItemOpen(true)}
            onStart={() => {
              const waiting = onlineDaemons === 0;
              void applyAction(
                "start",
                () => api.startRunGroup(selected.uuid, selected.parallelism),
                waiting ? "Evaluation is queued, but no online daemon is connected. It will start when one connects." : "Evaluation queued for execution.",
                waiting ? "warning" : "success",
              );
            }}
            onPause={() => void applyAction("pause", () => api.pauseRunGroup(selected.uuid), "Evaluation paused. Running jobs finish; no new items will be scheduled.")}
            onCancel={() => setCancelOpen(true)}
            onReport={() => void openReport(selected)}
            onRetry={(item) => void applyAction(`retry-${item.id}`, () => api.retryWorkItem(item.id), `${item.item_key} is ready to run again.`)}
          />
        ) : selectedExperiment ? (
          <HarnessExperimentDetail
            experiment={selectedExperiment}
            busy={experimentBusy}
            onBack={() => onSelect()}
            onAttach={() => setAttachCandidateOpen(true)}
            onRefine={() => setRefineProposalOpen(true)}
            onEvaluate={() => void applyExperimentAction("evaluate", () => api.evaluateHarnessExperiment(selectedExperiment.uuid), "Promotion gate evaluated persisted baseline and candidate evidence.")}
            onCopyBrief={() => void copyCandidateBrief(selectedExperiment)}
          />
        ) : loading && groups.length === 0 && experiments.length === 0 ? (
          <EvaluationEmpty title="Loading evaluation workspace" body="Reading durable run groups and evidence state." />
        ) : railMode === "evolution" ? (
          <HarnessExperimentsOverview experiments={experiments} onSelect={onSelect} onNew={() => setNewExperimentOpen(true)} />
        ) : groups.length === 0 ? (
          <EvaluationEmpty
            title="Make audit evaluations durable"
            body="Coordinate multi-target audits, repeated checks, regression replays, or evidence verification. Every item keeps its own attempts and evidence verdict."
            action={<Button variant="primary" icon="package" onClick={() => setNewOpen(true)}>New evaluation</Button>}
          />
        ) : (
          <EvaluationOverview groups={groups} onSelect={(uuid) => onSelect(uuid)} onNew={() => setNewOpen(true)} />
        )}
      </main>
      {newOpen ? (
        <NewEvaluationModal providers={providers} onClose={() => setNewOpen(false)} onCreated={(group) => {
          mergeGroup(group);
          setNewOpen(false);
          onSelect(group.uuid);
          onToast("success", "Evaluation created. Add the first work item to define its evidence contract.");
        }} />
      ) : null}
      {addItemOpen && selected ? (
        <AddWorkItemModal
          group={selected}
          daemons={daemons}
          onClose={() => setAddItemOpen(false)}
          onCreated={(group) => {
            mergeGroup(group);
            setAddItemOpen(false);
            onToast("success", "Work item added with an explicit material policy and evidence contract.");
          }}
        />
      ) : null}
      {newExperimentOpen ? (
        <NewHarnessExperimentModal
          groups={groups}
          onClose={() => setNewExperimentOpen(false)}
          onCreated={(experiment) => {
            mergeExperiment(experiment);
            setNewExperimentOpen(false);
            setRailMode("evolution");
            onSelect(experiment.uuid);
            onToast(experiment.proposal ? "success" : "warning", experiment.proposal ? "Verifier-grounded weaknesses mined and a bounded candidate proposal created." : "Experiment created, but the baseline has no actionable failed evidence yet.");
          }}
        />
      ) : null}
      {attachCandidateOpen && selectedExperiment ? (
        <AttachHarnessCandidateModal
          experiment={selectedExperiment}
          groups={groups}
          onClose={() => setAttachCandidateOpen(false)}
          onAttached={(experiment) => {
            mergeExperiment(experiment);
            setAttachCandidateOpen(false);
            onToast("success", "Candidate Evaluation attached. The promotion gate can now compare persisted evidence.");
          }}
        />
      ) : null}
      {refineProposalOpen && selectedExperiment?.proposal ? (
        <RefineHarnessProposalModal
          experiment={selectedExperiment}
          onClose={() => setRefineProposalOpen(false)}
          onUpdated={(experiment) => {
            mergeExperiment(experiment);
            setRefineProposalOpen(false);
            onToast("success", "Candidate proposal refined without widening its protected boundary.");
          }}
        />
      ) : null}
      {cancelOpen && selected ? (
        <Modal
          title="Cancel evaluation"
          onClose={() => setCancelOpen(false)}
          footer={<><Button onClick={() => setCancelOpen(false)}>Keep running</Button><Button variant="danger" disabled={busyAction === "cancel"} onClick={() => {
            setCancelOpen(false);
            void applyAction("cancel", () => api.cancelRunGroup(selected.uuid), "Evaluation cancelled. Completed evidence and attempt history were preserved.");
          }}>Cancel evaluation</Button></>}
        >
          <div className="evaluation-confirm-copy">
            <p>Cancel <strong>{selected.name}</strong> and every queued or running work item?</p>
            <p>Completed evidence stays available. Cancelled items may be retried only if the group itself is not cancelled.</p>
          </div>
        </Modal>
      ) : null}
      {reportOpen ? <EvaluationReportModal report={report} loading={reportLoading} onClose={() => { setReportOpen(false); setReport(null); }} onToast={onToast} /> : null}
    </>
  );
}

function EvaluationRailRow({ group, selected, onSelect }: { group: RunGroupRow; selected: boolean; onSelect: () => void }) {
  const metrics = evaluationMetrics(group);
  const tone = groupStateTone(group);
  return (
    <button className={`evaluation-rail-row${selected ? " sel" : ""}`} onClick={onSelect} aria-current={selected ? "page" : undefined}>
      <span className="evaluation-rail-main"><strong>{group.name}</strong><small>{kindLabel(group.kind)}</small></span>
      <StatusPill tone={tone}>{groupStateLabel(group.state)}</StatusPill>
      <span className="evaluation-mini-progress" aria-label={`${metrics.progress}% complete`}><span style={{ width: `${metrics.progress}%` }} /></span>
      <span className="evaluation-rail-meta">
        <span>{metrics.completed}/{metrics.total || 0} items</span>
        <span>{metrics.blocked ? `${metrics.blocked} blocked` : metrics.scored ? `${metrics.passed}/${metrics.scored} passed` : "Unscored"}</span>
      </span>
    </button>
  );
}

function EvaluationOverview({ groups, onSelect, onNew }: { groups: RunGroupRow[]; onSelect: (uuid: string) => void; onNew: () => void }) {
  const items = groups.flatMap((group) => group.items);
  const active = groups.filter((group) => group.state === "running" || group.state === "queued").length;
  const attention = groups.filter((group) => {
    const metrics = evaluationMetrics(group);
    return group.state === "failed" || metrics.blocked > 0 || metrics.failed > 0;
  }).length;
  const scored = items.filter((item) => item.state === "finished" && typeof item.result?.accepted === "boolean" && item.outcome !== "invalid");
  const passed = scored.filter((item) => item.result?.accepted === true).length;
  return (
    <div className="evaluation-page evaluation-overview">
      <div className="evaluation-page-head">
        <div><span className="eyebrow">Audit quality and scale</span><h1>Audit evaluations</h1><p>Validate Flounder across real targets, regression cases, and safe controls. Every item keeps its own evidence and retry history.</p></div>
        <Button variant="primary" icon="package" onClick={onNew}>New evaluation</Button>
      </div>
      <div className="evaluation-summary-strip" aria-label="Evaluation summary">
        <Metric label="Run groups" value={String(groups.length)} detail={`${active} active`} />
        <Metric label="Work items" value={String(items.length)} detail={`${items.filter((item) => item.state === "running").length} running`} />
        <Metric label="Scored pass" value={scored.length ? `${passed}/${scored.length}` : "—"} detail={scored.length ? formatRate(passed / scored.length) : "No eligible verdicts"} />
        <Metric label="Needs attention" value={String(attention)} detail="Blocked or scored failure" tone={attention ? "warning" : "neutral"} />
      </div>
      <section className="evaluation-section">
        <div className="evaluation-section-head"><div><h2>Recent evaluations</h2><p>Open a run group to inspect lifecycle state separately from evidence outcomes.</p></div></div>
        <div className="evaluation-overview-list">
          {groups.slice(0, 8).map((group) => {
            const metrics = evaluationMetrics(group);
            return (
              <button key={group.uuid} onClick={() => onSelect(group.uuid)}>
                <StatusPill tone={groupStateTone(group)}>{groupStateLabel(group.state)}</StatusPill>
                <span><strong>{group.name}</strong><small>{kindLabel(group.kind)} · {metrics.completed}/{metrics.total} complete</small></span>
                <span className="evaluation-overview-score">{metrics.scored ? `${metrics.passed}/${metrics.scored} passed` : "Not scored"}<Icon name="arrowright" size={14} /></span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function EvaluationDetail({ group, onlineDaemons, busyAction, expandedItem, onBack, onExpand, onAdd, onStart, onPause, onCancel, onReport, onRetry }: {
  group: RunGroupRow;
  onlineDaemons: number;
  busyAction: string;
  expandedItem: number | null;
  onBack: () => void;
  onExpand: (id: number) => void;
  onAdd: () => void;
  onStart: () => void;
  onPause: () => void;
  onCancel: () => void;
  onReport: () => void;
  onRetry: (item: WorkItemRow) => void;
}) {
  const metrics = evaluationMetrics(group);
  const showsQualityMetrics = group.kind === "benchmark" || group.kind === "regression" || group.kind === "evaluation";
  const attemptCount = group.items.reduce((total, item) => total + item.attempts, 0);
  return (
    <div className="evaluation-page evaluation-detail-page">
      <button className="evaluation-back" onClick={onBack}><Icon name="arrowright" size={13} />Back to evaluations</button>
      <header className="evaluation-detail-head">
        <div className="evaluation-title-block">
          <div className="evaluation-title-line"><StatusPill tone={groupStateTone(group)}>{groupStateLabel(group.state)}</StatusPill><span>{kindLabel(group.kind)}</span><span>Parallelism {group.parallelism}</span></div>
          <h1>{group.name}</h1>
          <p>{group.state === "finished" ? finishedSummary(metrics) : lifecycleSummary(group, metrics)}</p>
        </div>
        <div className="evaluation-actions">
          <Button icon="file" disabled={busyAction !== ""} onClick={onReport}>Report</Button>
          {canAddWorkItem(group) ? <Button icon="package" disabled={busyAction !== ""} onClick={onAdd}>Add item</Button> : null}
          {canPauseRunGroup(group) ? <Button disabled={busyAction !== ""} onClick={onPause}>Pause</Button> : null}
          {canStartRunGroup(group) ? <Button variant="primary" icon="play" disabled={busyAction !== ""} onClick={onStart}>{group.state === "paused" ? "Resume" : "Start"}</Button> : null}
          {canCancelRunGroup(group) ? <Button variant="danger" disabled={busyAction !== ""} onClick={onCancel}>Cancel</Button> : null}
        </div>
      </header>
      {onlineDaemons === 0 && (group.state === "draft" || group.state === "paused" || group.state === "queued" || group.state === "running") ? (
        <div className="evaluation-callout warning"><Icon name="clock" /><span><strong>No daemon online.</strong>{group.state === "running" ? "Work is queued and will begin when an executor connects." : "Starting is safe, but work stays queued until a daemon connects."}</span></div>
      ) : null}
      <div className="evaluation-summary-strip" aria-label="Evaluation evidence summary">
        <Metric label="Progress" value={`${metrics.completed}/${metrics.total}`} detail={`${metrics.progress}% terminal`} />
        <Metric label="Scored pass" value={metrics.scored ? `${metrics.passed}/${metrics.scored}` : "—"} detail={metrics.passRate === null ? "Blocked/invalid excluded" : formatRate(metrics.passRate)} tone={metrics.failed ? "danger" : "neutral"} />
        {showsQualityMetrics ? <Metric label="Positive recall" value={metrics.positives ? `${metrics.positivesPassed}/${metrics.positives}` : "—"} detail={metrics.positiveRecall === null ? "No scored positives" : formatRate(metrics.positiveRecall)} /> : <Metric label="Active" value={String(metrics.active)} detail={`${attemptCount} total attempts`} />}
        {showsQualityMetrics ? <Metric label="Control pass" value={metrics.controls ? `${metrics.controlsPassed}/${metrics.controls}` : "—"} detail={metrics.controlPassRate === null ? "No scored controls" : formatRate(metrics.controlPassRate)} /> : null}
        <Metric label="Blocked" value={String(metrics.blocked)} detail={`${metrics.invalid} invalid`} tone={metrics.blocked ? "warning" : "neutral"} />
      </div>
      <div className="evaluation-progress" aria-label={`${metrics.progress}% of work items terminal`}><span style={{ width: `${metrics.progress}%` }} /></div>
      <section className="evaluation-section">
        <div className="evaluation-section-head">
          <div><h2>Work items <Counter>{group.items.length}</Counter></h2><p>Lifecycle and evidence verdicts remain separate. Blocked and invalid attempts never enter the score.</p></div>
          {canAddWorkItem(group) ? <Button size="sm" icon="package" onClick={onAdd}>Add work item</Button> : null}
        </div>
        {group.items.length === 0 ? (
          <div className="evaluation-empty-items"><p>This draft has no work items yet.</p><Button variant="primary" icon="package" onClick={onAdd}>Add first work item</Button></div>
        ) : (
          <div className="evaluation-item-list">
            {group.items.map((item) => (
              <WorkItemEntry
                key={item.id}
                group={group}
                item={item}
                open={expandedItem === item.id}
                retrying={busyAction === `retry-${item.id}`}
                onExpand={() => onExpand(item.id)}
                onRetry={() => onRetry(item)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkItemEntry({ group, item, open, retrying, onExpand, onRetry }: { group: RunGroupRow; item: WorkItemRow; open: boolean; retrying: boolean; onExpand: () => void; onRetry: () => void }) {
  const expected = item.evidenceContract.expectedOutcome;
  const result = item.result ?? {};
  return (
    <article className={`evaluation-item${open ? " open" : ""}`}>
      <button className="evaluation-item-summary" onClick={onExpand} aria-expanded={open}>
        <span className="evaluation-item-chevron"><Icon name="arrowright" size={13} /></span>
        <span className="evaluation-item-name"><strong>{item.item_key}</strong><small>{workItemKindLabel(item.kind)} · {item.targetBundle.target}</small></span>
        <span className="evaluation-item-contract"><small>Expected</small><strong>{expected ? expectedLabel(expected) : "Not scored"}</strong></span>
        <StatusPill tone={workItemTone(item)}>{workItemStateLabel(item)}</StatusPill>
        <span className="evaluation-item-attempts">{item.attempts} {item.attempts === 1 ? "attempt" : "attempts"}</span>
      </button>
      {open ? (
        <div className="evaluation-item-detail">
          <div className="evaluation-evidence-grid">
            <EvidenceBlock title="Target bundle">
              <DetailLine label="Class" value={item.targetBundle.targetClass} />
              <DetailLine label="Source" value={item.targetBundle.sourcePaths.join(" · ")} code />
              {item.targetBundle.buildRoot ? <DetailLine label="Build root" value={item.targetBundle.buildRoot} code /> : null}
              {item.targetBundle.corpusPaths.length ? <DetailLine label="Corpus" value={item.targetBundle.corpusPaths.join(" · ")} code /> : <DetailLine label="Corpus" value="None" />}
            </EvidenceBlock>
            <EvidenceBlock title="Evidence contract">
              <DetailLine label="Gate" value={item.evidenceContract.kind} />
              <DetailLine label="Network" value={item.evidenceContract.networkPolicy} />
              <DetailLine label="Differential" value={item.evidenceContract.requiresDifferential ? "Required" : "Not required"} />
              <DetailLine label="Refutation" value={item.evidenceContract.requiresRefutation ? "Required" : "Not required"} />
              {item.evidenceContract.expectedOutcome ? <DetailLine label="Case" value={item.evidenceContract.caseId ?? item.item_key} code /> : null}
              {item.evidenceContract.caseFamily ? <DetailLine label="Family" value={item.evidenceContract.caseFamily} /> : null}
              {item.evidenceContract.targetStack ? <DetailLine label="Stack" value={item.evidenceContract.targetStack} /> : null}
              {item.evidenceContract.expectedOutcome ? <DetailLine label="Holdout" value={item.evidenceContract.holdout ? "Hidden from failure mining" : "Training-visible"} /> : null}
            </EvidenceBlock>
            <EvidenceBlock title="Recorded result">
              <DetailLine label="Score" value={typeof result.accepted === "boolean" ? result.accepted ? "Accepted" : "Failed" : "Not eligible"} />
              <DetailLine label="Outcome" value={item.outcome ?? "Pending"} />
              <DetailLine label="Run health" value={stringValue(result.runHealth) ?? "—"} />
              <DetailLine label="Confirmed" value={numberValue(result.confirmedFindings)} />
              <DetailLine label="Differential" value={numberValue(result.differentialFindings)} />
            </EvidenceBlock>
          </div>
          <div className="evaluation-material-line">
            <strong>Material policy</strong>
            <StatusPill tone={item.materialPolicy.posture === "blind" ? "success" : "warning"}>{item.materialPolicy.posture}</StatusPill>
            <span>{item.materialPolicy.materials.length ? `${item.materialPolicy.materials.length} explicit decision(s)` : "No corpus material"}</span>
          </div>
          {item.materialPolicy.materials.length ? (
            <div className="evaluation-materials">
              {item.materialPolicy.materials.map((material) => <div key={material.path}><code>{material.path}</code><span>{material.operatorLabel} · {material.policyDecision}</span><small>{material.reason}</small></div>)}
            </div>
          ) : null}
          {item.last_error ? <div className="evaluation-callout warning"><Icon name="bug" /><span><strong>Execution blocker</strong>{item.last_error}</span></div> : null}
          <div className="evaluation-attempts-head">
            <strong>Attempt history</strong>
            {canRetryWorkItem(group, item) ? <Button size="sm" icon="sync" disabled={retrying} onClick={onRetry}>{retrying ? "Retrying…" : "Retry blocked item"}</Button> : null}
          </div>
          {item.attemptHistory.length ? (
            <div className="evaluation-attempts">
              {item.attemptHistory.map((attempt) => (
                <div key={attempt.id}>
                  <span>#{attempt.attempt_number}</span>
                  <StatusPill tone={attempt.outcome === "blocked" ? "warning" : attempt.state === "running" ? "active" : "neutral"}>{attempt.outcome ?? attempt.state}</StatusPill>
                  <span>{attempt.run_id ? `Run ${attempt.run_id}` : "No run linked"}</span>
                  <time>{formatTime(attempt.updated_at)}</time>
                  {attempt.error ? <small>{attempt.error}</small> : null}
                </div>
              ))}
            </div>
          ) : <p className="evaluation-muted">No attempt has been scheduled.</p>}
        </div>
      ) : null}
    </article>
  );
}

function NewEvaluationModal({ providers, onClose, onCreated }: { providers: ProviderProfile[]; onClose: () => void; onCreated: (group: RunGroupRow) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("campaign");
  const [parallelism, setParallelism] = useState("2");
  const [providerId, setProviderId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("Name is required.");
    const provider = providers.find((entry) => String(entry.id) === providerId);
    const payload: RunGroupCreatePayload = {
      name: name.trim(),
      kind,
      parallelism: Math.max(1, Number(parallelism) || 1),
      config: provider ? { provider: provider.provider, ...(provider.model ? { model: provider.model } : {}), ...(provider.thinking ? { thinking: provider.thinking } : {}) } : {},
    };
    setSubmitting(true);
    try {
      onCreated(await api.createRunGroup(payload));
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  }
  return (
    <Modal title="New evaluation" project onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="new-evaluation-form" variant="primary" disabled={submitting}>{submitting ? "Creating…" : "Create draft"}</Button></>}>
      <form id="new-evaluation-form" className="form-grid two" onSubmit={submit}>
        <label className="field span-2">Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Prompt regression — July" /></label>
        <label className="field">Purpose<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="campaign">Audit campaign</option><option value="evaluation">Evidence evaluation</option><option value="benchmark">Benchmark</option><option value="regression">Regression replay</option></select></label>
        <label className="field">Parallel work items<input type="number" min="1" max="32" value={parallelism} onChange={(event) => setParallelism(event.target.value)} /></label>
        <label className="field span-2">Provider profile<select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Use runtime default</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.provider}{provider.model ? ` / ${provider.model}` : ""}</option>)}</select><small>The profile is copied into this group so later profile edits do not silently change the intended configuration.</small></label>
        {error ? <div className="evaluation-form-error span-2">{error}</div> : null}
      </form>
    </Modal>
  );
}

function AddWorkItemModal({ group, daemons, onClose, onCreated }: { group: RunGroupRow; daemons: DaemonRow[]; onClose: () => void; onCreated: (group: RunGroupRow) => void }) {
  const [kind, setKind] = useState<WorkItemPayload["kind"]>("benchmark-case");
  const [itemKey, setItemKey] = useState("");
  const [target, setTarget] = useState("");
  const [targetClass, setTargetClass] = useState<WorkItemPayload["targetBundle"]["targetClass"]>("general");
  const [sourcePaths, setSourcePaths] = useState("");
  const [buildRoot, setBuildRoot] = useState("");
  const [corpusPaths, setCorpusPaths] = useState("");
  const [daemonId, setDaemonId] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState<ExpectedOutcome>("detect-positive");
  const [caseId, setCaseId] = useState("");
  const [caseFamily, setCaseFamily] = useState("");
  const [targetStack, setTargetStack] = useState("");
  const [holdout, setHoldout] = useState(false);
  const [mapSamples, setMapSamples] = useState("2");
  const [digMaxSamples, setDigMaxSamples] = useState("3");
  const [posture, setPosture] = useState<WorkItemPayload["materialPolicy"]["posture"]>("blind");
  const [materialLabel, setMaterialLabel] = useState("specification");
  const [materialReason, setMaterialReason] = useState("Operator-authorized target documentation used as design intent.");
  const [materialAuthorized, setMaterialAuthorized] = useState(false);
  const [requiresDifferential, setRequiresDifferential] = useState(true);
  const [requiresRefutation, setRequiresRefutation] = useState(true);
  const [claim, setClaim] = useState("{}\n");
  const [entrypoints, setEntrypoints] = useState("");
  const [inputs, setInputs] = useState("");
  const [effects, setEffects] = useState("");
  const [authorities, setAuthorities] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [localFixtures, setLocalFixtures] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const scoredKind = kind === "benchmark-case" || kind === "regression-replay";

  function changeKind(next: WorkItemPayload["kind"]) {
    setKind(next);
    if (next === "benchmark-case" || next === "regression-replay") {
      setExpectedOutcome("detect-positive");
      setRequiresDifferential(true);
    } else {
      setRequiresDifferential(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const sources = splitLines(sourcePaths);
    const corpus = splitLines(corpusPaths);
    if (!itemKey.trim() || !target.trim() || sources.length === 0) return setError("Item key, target, and at least one source path are required.");
    if (scoredKind && (!caseFamily.trim() || !targetStack.trim())) return setError("Scored evaluation items require a bug family and target stack for generalization scoring.");
    if (corpus.length && !materialAuthorized) return setError("Confirm that every corpus path and its label are operator-authorized.");
    if (posture === "blind" && /incident|post.?mortem|prior-audit|disclosure|exploit|issue/i.test(materialLabel)) return setError("Blind evaluations cannot include answer-bearing or disclosure material. Choose an informed posture or remove it.");
    let parsedClaim: unknown;
    if (kind === "verify-claim") {
      try { parsedClaim = JSON.parse(claim); } catch { return setError("Claim must be valid JSON."); }
    }
    const surfaceFields = [entrypoints, inputs, effects, authorities, boundaries, localFixtures].map(splitLines);
    if (targetClass === "capability-surface" && surfaceFields.some((values) => values.length === 0)) return setError("Capability-surface targets require all six structured fields.");
    const payload: WorkItemPayload = {
      itemKey: itemKey.trim(),
      kind,
      targetBundle: {
        target: target.trim(),
        targetClass,
        sourcePaths: sources,
        corpusPaths: corpus,
        ...(buildRoot.trim() ? { buildRoot: buildRoot.trim() } : {}),
        ...(daemonId ? { daemonId: Number(daemonId) } : {}),
        ...(scoredKind ? { mapSamples: Math.max(1, Number(mapSamples) || 1), digMaxSamples: Math.max(1, Number(digMaxSamples) || 1), adaptiveDig: true, eagerPrepare: true } : {}),
        ...(kind === "verify-claim" ? { claim: parsedClaim } : {}),
        ...(targetClass === "capability-surface" ? { capabilitySurface: { entrypoints: surfaceFields[0]!, inputs: surfaceFields[1]!, effects: surfaceFields[2]!, authorities: surfaceFields[3]!, boundaries: surfaceFields[4]!, localFixtures: surfaceFields[5]! } } : {}),
      },
      materialPolicy: {
        posture,
        materials: corpus.map((path) => ({ path, provenance: "operator", operatorLabel: materialLabel.trim() || "unknown", policyDecision: "included", reason: materialReason.trim() || "Included by operator." })),
      },
      evidenceContract: {
        kind: kind === "regression-replay" ? "replay-package" : scoredKind ? "benchmark-oracle" : "confirmation-command",
        successPatterns: [],
        failurePatterns: [],
        requiresDifferential,
        requiresRefutation,
        networkPolicy: "sealed",
        ...(scoredKind ? {
          expectedOutcome,
          caseId: caseId.trim() || itemKey.trim(),
          caseFamily: caseFamily.trim(),
          targetStack: targetStack.trim(),
          holdout,
        } : {}),
      },
    };
    setSubmitting(true);
    try {
      onCreated(await api.addRunGroupItems(group.uuid, [payload]));
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Add work item · ${group.name}`} wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="add-work-item-form" variant="primary" disabled={submitting}>{submitting ? "Adding…" : "Add work item"}</Button></>}>
      <form id="add-work-item-form" className="evaluation-item-form" onSubmit={submit}>
        <FormSection title="Identity and target">
          <div className="form-grid two">
            <label className="field">Work item type<select value={kind} onChange={(event) => changeKind(event.target.value as WorkItemPayload["kind"])}><option value="benchmark-case">Benchmark case</option><option value="regression-replay">Regression replay</option><option value="audit-target">Audit target</option><option value="verify-claim">Verify claim</option></select></label>
            <label className="field">Stable item key<input value={itemKey} onChange={(event) => setItemKey(event.target.value)} placeholder="positive-nullifier-01" /></label>
            <label className="field">Target<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="zk-circuit-fixture" /></label>
            <label className="field">Target class<select value={targetClass} onChange={(event) => setTargetClass(event.target.value as typeof targetClass)}><option value="general">General</option><option value="logic">Logic</option><option value="memory-safety">Memory safety</option><option value="crypto-zk">Cryptography / ZK</option><option value="capability-surface">Capability surface</option></select></label>
            <label className="field span-2">Source paths<textarea rows={3} value={sourcePaths} onChange={(event) => setSourcePaths(event.target.value)} placeholder="One repository-relative or absolute path per line" /></label>
            <label className="field">Build root<input value={buildRoot} onChange={(event) => setBuildRoot(event.target.value)} placeholder="Optional workspace root" /></label>
            <label className="field">Pinned daemon<select value={daemonId} onChange={(event) => setDaemonId(event.target.value)}><option value="">Any compatible daemon</option>{daemons.map((daemon) => <option key={daemon.id} value={daemon.id}>{daemon.name || `Daemon ${daemon.id}`}{daemon.online ? " · online" : " · offline"}</option>)}</select></label>
          </div>
        </FormSection>
        {targetClass === "capability-surface" ? (
          <FormSection title="Authorized capability surface">
            <p className="evaluation-form-help">This metadata gives the model an affordance map. It is planning context, never evidence or a finding.</p>
            <div className="form-grid two">
              <SurfaceField label="Entrypoints" value={entrypoints} onChange={setEntrypoints} />
              <SurfaceField label="External inputs" value={inputs} onChange={setInputs} />
              <SurfaceField label="Effects" value={effects} onChange={setEffects} />
              <SurfaceField label="Authorities" value={authorities} onChange={setAuthorities} />
              <SurfaceField label="Intended boundaries" value={boundaries} onChange={setBoundaries} />
              <SurfaceField label="Local fixtures" value={localFixtures} onChange={setLocalFixtures} />
            </div>
          </FormSection>
        ) : null}
        {kind === "verify-claim" ? <FormSection title="Claim to verify"><label className="field">Claim JSON<textarea className="evaluation-code-input" rows={7} value={claim} onChange={(event) => setClaim(event.target.value)} /></label></FormSection> : null}
        <FormSection title="Material policy">
          <div className="form-grid two">
            <label className="field span-2">Corpus paths<textarea rows={3} value={corpusPaths} onChange={(event) => setCorpusPaths(event.target.value)} placeholder="Optional; one authorized specification or project document per line" /></label>
            <label className="field">Evaluation posture<select value={posture} onChange={(event) => setPosture(event.target.value as typeof posture)}><option value="blind">Blind</option><option value="informed">Informed</option><option value="private">Private</option><option value="open-world">Open world</option></select></label>
            <label className="field">Operator label<input value={materialLabel} onChange={(event) => setMaterialLabel(event.target.value)} placeholder="specification" /></label>
            <label className="field span-2">Inclusion reason<input value={materialReason} onChange={(event) => setMaterialReason(event.target.value)} /></label>
            {corpusPaths.trim() ? <label className="check-row span-2"><input type="checkbox" checked={materialAuthorized} onChange={(event) => setMaterialAuthorized(event.target.checked)} />I authorize every corpus path and confirm the label does not hide answer-bearing content.</label> : null}
          </div>
        </FormSection>
        <FormSection title="Evidence contract">
          <div className="form-grid two">
            {scoredKind ? <label className="field">Expected outcome<select value={expectedOutcome} onChange={(event) => { const next = event.target.value as ExpectedOutcome; setExpectedOutcome(next); if (next === "detect-positive") setRequiresDifferential(true); }}><option value="detect-positive">Detect positive</option><option value="reject-positive">Reject positive (safe control)</option></select><small>Positive cases pass only when the required evidence appears. Controls pass only when no confirmed finding appears.</small></label> : <div className="field"><span>Scoring</span><div className="readonly-field">Evidence-only, not benchmark-scored</div></div>}
            <div className="field"><span>Network policy</span><div className="readonly-field">Sealed · local execution only</div></div>
            <label className="check-row"><input type="checkbox" checked={requiresDifferential} onChange={(event) => setRequiresDifferential(event.target.checked)} />Require differential confirmation</label>
            <label className="check-row"><input type="checkbox" checked={requiresRefutation} onChange={(event) => setRequiresRefutation(event.target.checked)} />Require independent refutation</label>
            {scoredKind ? <>
              <label className="field">Case ID<input value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder={itemKey || "stable-case-id"} /><small>Stable identity for paired baseline/candidate scoring.</small></label>
              <label className="field">Bug family<input value={caseFamily} onChange={(event) => setCaseFamily(event.target.value)} placeholder="authorization-binding" /><small>Promotion needs distinct families, not repeated variants of one bug.</small></label>
              <label className="field">Target stack<input value={targetStack} onChange={(event) => setTargetStack(event.target.value)} placeholder="solidity-foundry" /></label>
              <label className="check-row"><input type="checkbox" checked={holdout} onChange={(event) => setHoldout(event.target.checked)} />Hidden holdout; exclude from candidate failure mining</label>
              <label className="field">Map samples<input type="number" min="1" value={mapSamples} onChange={(event) => setMapSamples(event.target.value)} /><small>Independent scope inventories are unioned.</small></label>
              <label className="field">Adaptive dig ceiling<input type="number" min="1" value={digMaxSamples} onChange={(event) => setDigMaxSamples(event.target.value)} /><small>Extra passes run only on incomplete or uncertain scope outcomes.</small></label>
            </> : null}
          </div>
        </FormSection>
        {error ? <div className="evaluation-form-error">{error}</div> : null}
      </form>
    </Modal>
  );
}

function EvaluationReportModal({ report, loading, onClose, onToast }: { report: RunGroupReportResponse | null; loading: boolean; onClose: () => void; onToast: (tone: ToastTone, message: string) => void }) {
  const markdown = report?.markdown ?? "";
  return (
    <Modal title="Evaluation report" wide onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {loading ? <p className="evaluation-muted">Building the report from persisted evidence…</p> : (
        <div className="evaluation-report">
          <div className="evaluation-report-actions">
            <Button size="sm" icon="copy" onClick={() => void copyText(markdown)
              .then(() => onToast("success", "Report copied to clipboard."))
              .catch((copyError) => onToast("error", errorMessage(copyError)))}>Copy</Button>
            <Button size="sm" icon="download" onClick={() => downloadText("evaluation-report.md", markdown)}>Download</Button>
          </div>
          <pre>{markdown}</pre>
        </div>
      )}
    </Modal>
  );
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="form-section evaluation-form-section"><div className="form-section-head">{title}</div>{children}</section>;
}

function SurfaceField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="field">{label}<textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} placeholder="One entry per line" /></label>;
}

function EvidenceBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3><div>{children}</div></section>;
}

function DetailLine({ label, value, code }: { label: string; value: string | number; code?: boolean }) {
  return <div className="evaluation-detail-line"><span>{label}</span>{code ? <code>{value}</code> : <strong>{value}</strong>}</div>;
}

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: EvaluationTone }) {
  return <div className={`evaluation-metric tone-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function StatusPill({ tone, children }: { tone: EvaluationTone; children: React.ReactNode }) {
  return <span className={`evaluation-status tone-${tone}`}>{children}</span>;
}

function EvaluationEmpty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state evaluation-empty"><Icon name="shieldcheck" size={24} /><h1>{title}</h1><p>{body}</p>{action}</div>;
}

function RailMessage({ children, tone = "neutral" }: { children: React.ReactNode; tone?: EvaluationTone }) {
  return <div className={`evaluation-rail-message tone-${tone}`}>{children}</div>;
}

function finishedSummary(metrics: ReturnType<typeof evaluationMetrics>): string {
  if (metrics.blocked > 0) return `Execution ended with ${metrics.blocked} blocked item${metrics.blocked === 1 ? "" : "s"}; blocked work is excluded from scoring.`;
  if (metrics.scored === 0) return "Execution finished, but this group has no score-eligible evidence verdicts.";
  if (metrics.failed > 0) return `${metrics.failed} scored case${metrics.failed === 1 ? "" : "s"} did not meet the evidence contract.`;
  return "Every score-eligible item met its evidence contract.";
}

function lifecycleSummary(group: RunGroupRow, metrics: ReturnType<typeof evaluationMetrics>): string {
  if (group.state === "draft") return "Define work items and their evidence contracts before starting.";
  if (group.state === "paused") return `${metrics.completed}/${metrics.total} items are terminal. Resume to schedule remaining work.`;
  if (group.state === "cancelled") return "Execution was cancelled; completed evidence and attempt history remain available.";
  if (group.state === "running" || group.state === "queued") return `${metrics.active} item${metrics.active === 1 ? "" : "s"} queued or running across the daemon pool.`;
  return `${metrics.completed}/${metrics.total} work items are terminal.`;
}

function sortGroups(a: RunGroupRow, b: RunGroupRow): number {
  return Date.parse(b.updated_at ?? b.created_at ?? "") - Date.parse(a.updated_at ?? a.created_at ?? "");
}

function sortExperiments(a: HarnessExperimentRow, b: HarnessExperimentRow): number {
  return Date.parse(b.updated_at ?? b.created_at ?? "") - Date.parse(a.updated_at ?? a.created_at ?? "");
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: string): string {
  return ({ evaluation: "Evaluation", benchmark: "Benchmark", regression: "Regression replay", campaign: "Multi-target campaign" } as Record<string, string>)[kind] ?? kind.replaceAll("-", " ");
}

function workItemKindLabel(kind: string): string {
  return ({ "benchmark-case": "Benchmark case", "regression-replay": "Regression replay", "audit-target": "Audit target", "verify-claim": "Verify claim" } as Record<string, string>)[kind] ?? kind.replaceAll("-", " ");
}

function expectedLabel(outcome: ExpectedOutcome): string {
  return outcome === "detect-positive" ? "Detect positive" : "Reject positive";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Restricted desktop shells and local HTTP sessions may expose the API but deny writes.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable in this environment.");
}

function downloadText(fileName: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
