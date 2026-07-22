import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";
import { MetadataStore } from "../dist/db/store.js";
import { DAEMON_PROTOCOL_VERSION } from "../dist/server/protocol.js";

async function withServer(fn) {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-run-groups-"));
  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, out);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const json = (response) => response.json();
const request = (base, method, route, body, token) => fetch(base + route, {
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(route === "/api/daemon/register" ? { ...body, protocolVersion: DAEMON_PROTOCOL_VERSION } : body) } : {}),
});

function item(itemKey, expectedOutcome, target) {
  return {
    itemKey,
    kind: "benchmark-case",
    targetBundle: {
      target,
      targetClass: "logic",
      sourcePaths: ["/authorized/source"],
      corpusPaths: [],
      mockLlm: true,
    },
    materialPolicy: { posture: "blind", materials: [] },
    evidenceContract: {
      kind: "benchmark-oracle",
      expectedOutcome,
      requiresDifferential: expectedOutcome === "detect-positive",
      requiresRefutation: true,
      networkPolicy: "sealed",
    },
  };
}

test("run-group API schedules bounded work and advances from daemon evidence", async () => {
  await withServer(async (base, out) => {
    const createdResponse = await request(base, "POST", "/api/run-groups", {
      version: 1,
      name: "http-eval",
      kind: "evaluation",
      parallelism: 1,
      items: [item("positive", "detect-positive", "eval-c1-f1-s1"), item("control", "reject-positive", "eval-c1-f2-s1")],
    });
    assert.equal(createdResponse.status, 201);
    const created = await json(createdResponse);
    assert.equal(created.state, "draft");
    assert.equal(created.items.length, 2);

    const started = await json(await request(base, "POST", `/api/run-groups/${created.uuid}/start`, {}));
    assert.equal(started.state, "running");
    assert.equal(started.scheduled, 1);
    assert.equal(started.items.filter((entry) => entry.job_id !== null).length, 1);

    const daemon = await json(await request(base, "POST", "/api/daemons", { name: "evaluation-daemon" }));
    const token = daemon.token;
    const registered = await request(base, "POST", "/api/daemon/register", { name: "evaluation-daemon", capabilities: {}, workspace: out }, token);
    assert.equal(registered.status, 200);
    await json(registered);

    const firstClaim = await json(await request(base, "POST", "/api/daemon/claim", {}, token));
    assert.equal(firstClaim.job.project, `evaluation:${started.items[0].uuid}`);
    const firstRun = await json(await request(base, "POST", "/api/daemon/runs", {
      jobId: firstClaim.job.id,
      project: firstClaim.job.project,
      kind: "run",
      runDir: path.join(out, "positive-run"),
    }, token));
    await json(await request(base, "PATCH", `/api/daemon/runs/${firstRun.runId}`, {
      findings: [{ findingKey: "F-positive", title: "Execution-backed positive", status: "confirmed-differential" }],
      stage: { name: "refutation", info: { candidates: 1, attempted: 1, verdicts: 1, errors: 0 } },
      health: { status: "healthy", reasons: [], signals: [] },
      finish: { status: "done", findingsTotal: 1 },
    }, token));
    await json(await request(base, "POST", `/api/daemon/jobs/${firstClaim.job.id}/status`, { status: "done" }, token));

    const operatorProjects = await json(await fetch(base + "/api/projects"));
    assert.deepEqual(operatorProjects.projects, [], "evaluation tracking rows must not enter the normal project rail");
    const evaluationProjects = await json(await fetch(base + "/api/projects?origin=evaluation"));
    assert.equal(evaluationProjects.projects.length, 1);
    assert.equal(evaluationProjects.projects[0].origin, "evaluation");
    assert.equal(evaluationProjects.projects[0].name, `evaluation:${started.items[0].uuid}`);

    const projectFindings = await json(await fetch(base + "/api/bugs"));
    assert.equal(projectFindings.total, 0, "evaluation evidence must not enter Findings by default");
    const evaluationFindings = await json(await fetch(base + "/api/bugs?source=evaluation"));
    assert.equal(evaluationFindings.total, 1);
    assert.equal(evaluationFindings.findings[0].source, "evaluation");
    assert.equal(evaluationFindings.findings[0].evaluation_uuid, created.uuid);
    assert.equal(evaluationFindings.findings[0].evaluation_name, "http-eval");

    let group = await json(await fetch(base + `/api/run-groups/${created.uuid}`));
    assert.equal(group.items[0].state, "finished");
    assert.equal(group.items[0].project_id, evaluationProjects.projects[0].id);
    assert.equal(group.items[0].outcome, "findings_reported");
    assert.equal(group.items[0].result.accepted, true);
    assert.ok(group.items[1].job_id, "second item should be scheduled after the first frees the only slot");

    const secondClaim = await json(await request(base, "POST", "/api/daemon/claim", {}, token));
    assert.equal(secondClaim.job.project, `evaluation:${group.items[1].uuid}`);
    const secondRun = await json(await request(base, "POST", "/api/daemon/runs", {
      jobId: secondClaim.job.id,
      project: secondClaim.job.project,
      kind: "run",
      runDir: path.join(out, "control-run"),
    }, token));
    await json(await request(base, "PATCH", `/api/daemon/runs/${secondRun.runId}`, {
      health: { status: "healthy", reasons: [], signals: [] },
      finish: { status: "done", findingsTotal: 0 },
    }, token));
    await json(await request(base, "POST", `/api/daemon/jobs/${secondClaim.job.id}/status`, { status: "done" }, token));

    group = await json(await fetch(base + `/api/run-groups/${created.uuid}`));
    assert.equal(group.state, "finished");
    assert.equal(group.items[1].outcome, "no_findings");
    assert.equal(group.items[1].result.accepted, true);

    const report = await json(await fetch(base + `/api/run-groups/${created.uuid}/report`));
    assert.equal(report.summary.passedItems, 2);
    assert.equal(report.summary.passRate, 1);
    assert.match(report.markdown, /\| positive \| benchmark-case \| finished \| findings_reported \| true \|/);
    assert.match(report.markdown, /\| control \| benchmark-case \| finished \| no_findings \| true \|/);
  });
});

test("run-group API rejects unsafe manifests and preserves blocked infrastructure outcomes", async () => {
  await withServer(async (base, out) => {
    const unsafe = await request(base, "POST", "/api/run-groups", {
      name: "unsafe",
      items: [{ ...item("unsafe", "detect-positive", "eval-c2-f1-s1"), targetBundle: { ...item("unsafe", "detect-positive", "eval-c2-f1-s1").targetBundle, sandboxBackend: "host" } }],
    });
    assert.equal(unsafe.status, 400);
    assert.match((await json(unsafe)).error, /cannot enable host execution/);

    const created = await json(await request(base, "POST", "/api/run-groups", { name: "blocked-eval", items: [item("blocked", "detect-positive", "eval-c2-f2-s1")] }));
    await json(await request(base, "POST", `/api/run-groups/${created.uuid}/start`, {}));
    const daemon = await json(await request(base, "POST", "/api/daemons", { name: "blocked-daemon" }));
    await json(await request(base, "POST", "/api/daemon/register", { name: "blocked-daemon", capabilities: {}, workspace: out }, daemon.token));
    const claim = await json(await request(base, "POST", "/api/daemon/claim", {}, daemon.token));
    await json(await request(base, "POST", `/api/daemon/jobs/${claim.job.id}/status`, { status: "error", error: "dependency build failed" }, daemon.token));

    const group = await json(await fetch(base + `/api/run-groups/${created.uuid}`));
    assert.equal(group.state, "finished");
    assert.equal(group.items[0].state, "failed");
    assert.equal(group.items[0].outcome, "blocked");
    assert.equal(group.items[0].result.accepted, false);
    assert.match(group.items[0].last_error, /dependency build failed/);
    assert.equal(group.items[0].attemptHistory.length, 1);
    assert.equal(group.items[0].attemptHistory[0].outcome, "blocked");

    const blockedReport = await json(await fetch(base + `/api/run-groups/${created.uuid}/report`));
    assert.equal(blockedReport.summary.scoredItems, 0);
    assert.equal(blockedReport.summary.passRate, null);

    const retried = await json(await request(base, "POST", `/api/work-items/${group.items[0].id}/retry`, {}));
    assert.equal(retried.state, "paused");
    assert.equal(retried.items[0].state, "queued");
    assert.equal(retried.items[0].attemptHistory.length, 1, "retry must preserve the failed attempt before a new job is scheduled");

    const restarted = await json(await request(base, "POST", `/api/run-groups/${retried.uuid}/start`, {}));
    assert.equal(restarted.state, "running");
    assert.equal(restarted.items[0].attempts, 2);
    assert.equal(restarted.items[0].attemptHistory.length, 2);
    assert.equal(restarted.items[0].attemptHistory[1].state, "queued");
  });
});

test("run-group scheduler skips invalid adapters without stranding later items", async () => {
  await withServer(async (base) => {
    const custom = {
      ...item("adapter", "reject-positive", "eval-c3-f1-s1"),
      kind: "custom",
      evidenceContract: { kind: "confirmation-command", networkPolicy: "sealed" },
    };
    const created = await json(await request(base, "POST", "/api/run-groups", {
      name: "invalid-then-valid",
      parallelism: 1,
      items: [custom, item("next", "reject-positive", "eval-c3-f2-s1")],
    }));
    const started = await json(await request(base, "POST", `/api/run-groups/${created.uuid}/start`, {}));
    assert.equal(started.state, "running");
    assert.equal(started.items[0].state, "failed");
    assert.equal(started.items[0].outcome, "invalid");
    assert.ok(started.items[1].job_id, "the valid item must occupy the slot freed by an invalid adapter");
  });
});

test("run-group scheduler resumes terminal work after a control-plane restart", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-run-group-restart-"));
  const firstServer = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!firstServer.listening) await new Promise((resolve) => firstServer.once("listening", resolve));
  const firstBase = `http://127.0.0.1:${firstServer.address().port}`;
  const created = await json(await request(firstBase, "POST", "/api/run-groups", {
    name: "restart-eval",
    parallelism: 1,
    items: [item("restart-first", "detect-positive", "eval-c3-f1-s1"), item("restart-second", "reject-positive", "eval-c3-f2-s1")],
  }));
  const started = await json(await request(firstBase, "POST", `/api/run-groups/${created.uuid}/start`, {}));
  const firstJobId = started.items[0].job_id;
  assert.ok(firstJobId);
  await new Promise((resolve) => firstServer.close(resolve));

  const store = MetadataStore.openForOutput(out);
  store.setJobStatus(firstJobId, "error", "executor ended during server restart");
  store.close();

  const secondServer = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!secondServer.listening) await new Promise((resolve) => secondServer.once("listening", resolve));
  const secondBase = `http://127.0.0.1:${secondServer.address().port}`;
  try {
    const resumed = await json(await fetch(secondBase + `/api/run-groups/${created.uuid}`));
    assert.equal(resumed.state, "running");
    assert.equal(resumed.items[0].state, "failed");
    assert.equal(resumed.items[0].outcome, "blocked");
    assert.match(resumed.items[0].last_error, /executor ended/);
    assert.ok(resumed.items[1].job_id, "restart reconciliation should schedule the next item");
    assert.notEqual(resumed.items[1].job_id, firstJobId);
  } finally {
    await new Promise((resolve) => secondServer.close(resolve));
  }
});
