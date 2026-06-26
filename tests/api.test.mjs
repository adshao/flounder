import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";
import { MetadataStore } from "../dist/db/store.js";
import { loadScopeInventory, saveScopeInventory } from "../dist/agent/scope-store.js";
import { projectHistoryDir } from "../dist/trace/history.js";

// The whole workflow is a REST API an agent can self-learn (GET /api) and drive without
// the UI. This pins the catalog + a project CRUD round-trip over real HTTP.

async function withServer(fn) {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-api-"));
  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, out);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("api: GET /api is a self-describing catalog of every resource + operation", async () => {
  await withServer(async (base) => {
    const cat = await (await fetch(base + "/api")).json();
    assert.deepEqual(cat.resources, ["project", "provider", "daemon", "run", "scope", "finding", "confirm-decision"]);
    const sigs = cat.endpoints.map((e) => e.method + " " + e.path);
    for (const expected of [
      "GET /api/projects", "PATCH /api/projects/order", "POST /api/projects", "GET /api/projects/:uuid",
      "PATCH /api/projects/:uuid", "DELETE /api/projects/:uuid",
      "POST /api/projects/:uuid/runs", "GET /api/projects/:uuid/findings",
      "GET /api/projects/:uuid/scopes", "GET /api/projects/:uuid/confirm-decisions",
      "GET /api/providers", "POST /api/providers", "GET /api/providers/:id",
      "PATCH /api/providers/:id", "DELETE /api/providers/:id",
      "GET /api/daemons", "POST /api/daemons",
      "GET /api/jobs/:id", "POST /api/jobs/:id/cancel",
      "GET /api/runs/:id", "PATCH /api/runs/:id", "POST /api/runs/:id/stop",
      "GET /api/runs/:id/log",
    ]) assert.ok(sigs.includes(expected), `catalog missing ${expected}`);
    // every endpoint documents a summary so an agent can learn it
    assert.ok(cat.endpoints.every((e) => typeof e.summary === "string" && e.summary.length > 0));
    const projectCreate = cat.endpoints.find((e) => e.method === "POST" && e.path === "/api/projects");
    assert.equal(projectCreate.body.daemonId.startsWith("number"), true);
    assert.equal(projectCreate.body.providerId.startsWith("number"), true);
    assert.match(projectCreate.body.config, /phaseProviders/);
    assert.match(projectCreate.body.config, /prepareClue/);
    const projectList = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects");
    assert.match(projectList.query.archived, /archived projects/);
    assert.match(projectList.query.limit, /default 100/);
    assert.match(projectList.query.offset, /default 0/);
    assert.match(projectList.query.q, /project-name search/);
    assert.match(projectList.query.status, /running/);
    const projectOrder = cat.endpoints.find((e) => e.method === "PATCH" && e.path === "/api/projects/order");
    assert.match(projectOrder.summary, /drag-and-drop/);
    const projectRun = cat.endpoints.find((e) => e.method === "POST" && e.path === "/api/projects/:uuid/runs");
    assert.match(projectRun.body.verb, /report/);
    assert.match(projectRun.body.verifyFromStart, /re-run Verify from the beginning/);
    assert.match(projectRun.body.scopeCoverageMode, /one-off coverage mode/);
    assert.match(projectRun.body.maxScopes, /one-off scope cap/);
    assert.match(projectRun.body.mapSteps, /one-off map turn cap/);
    assert.match(projectRun.body.digSteps, /one-off per-scope dig turn cap/);
    assert.match(projectRun.body.verifyFindings, /original row/);
    assert.match(projectRun.body.allowMaterialDrift, /expert override/);
    assert.match(projectRun.body.findingIds, /formal reports/);
    assert.match(projectRun.body.regenerateReports, /already have formal reports/);
    const scopePatch = cat.endpoints.find((e) => e.method === "PATCH" && e.path === "/api/projects/:uuid/scopes/:scopeId");
    assert.match(scopePatch.summary, /top of the next auto-dig batch/i);
    assert.match(scopePatch.body.prioritize, /top/i);
    const projectScopes = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects/:uuid/scopes");
    assert.match(projectScopes.query.limit, /default 50/);
    assert.match(projectScopes.query.offset, /default 0/);
    const projectFindings = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects/:uuid/findings");
    assert.match(projectFindings.query.status, /execution-confirmed/);
    assert.match(projectFindings.query.q, /#finding-id/);
    const globalFindings = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/bugs");
    assert.match(globalFindings.summary, /execution-confirmed/);
    assert.match(globalFindings.query.project, /project uuid/);
    assert.match(globalFindings.query.tracking, /active/);
    assert.match(globalFindings.query.limit, /default 200/);
    const findingTracking = cat.endpoints.find((e) => e.method === "PATCH" && e.path === "/api/findings/:id/tracking");
    assert.match(findingTracking.body.status, /ignored/);
    const runLog = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/runs/:id/log");
    assert.match(runLog.query.tail, /JSON/);
  });
});

test("api: project list supports archive, unarchive, pin, and manual order", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const patch = (p, body) => fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const deleteReq = (p) => fetch(base + p, { method: "DELETE" });

    const alpha = await json(await post("/api/projects", { name: "alpha", sourcePaths: ["./src"] }));
    const beta = await json(await post("/api/projects", { name: "beta", sourcePaths: ["./src"] }));
    const gamma = await json(await post("/api/projects", { name: "gamma", sourcePaths: ["./src"] }));

    let list = await json(await fetch(base + "/api/projects"));
    assert.deepEqual(list.projects.map((project) => project.name), ["gamma", "beta", "alpha"]);
    assert.equal(list.statusCounts.all, 3);
    assert.equal(list.statusCounts["not-started"], 3);
    assert.equal(list.statusCounts.running, 0);

    const notStarted = await json(await fetch(base + "/api/projects?status=not-started&limit=2"));
    assert.deepEqual(notStarted.projects.map((project) => project.name), ["gamma", "beta"]);
    assert.equal(notStarted.total, 3);
    assert.equal(notStarted.statusCounts["not-started"], 3);

    await patch(`/api/projects/${beta.uuid}`, { pinned: true });
    list = await json(await fetch(base + "/api/projects"));
    assert.equal(list.projects[0].name, "beta");
    assert.ok(list.projects[0].pinned_at);

    await patch(`/api/projects/${alpha.uuid}`, { pinned: true });
    await patch(`/api/projects/${alpha.uuid}`, { archived: true });
    list = await json(await fetch(base + "/api/projects"));
    assert.deepEqual(list.projects.map((project) => project.name), ["beta", "gamma"]);

    let archived = await json(await fetch(base + "/api/projects?archived=1"));
    assert.deepEqual(archived.projects.map((project) => project.name), ["alpha"]);
    assert.ok(archived.projects[0].archived_at);
    assert.equal(archived.projects[0].pinned_at, null);

    await patch(`/api/projects/${alpha.uuid}`, { archived: false });
    await patch(`/api/projects/${beta.uuid}`, { pinned: false });
    await patch("/api/projects/order", { uuids: [alpha.uuid, gamma.uuid, beta.uuid] });

    list = await json(await fetch(base + "/api/projects"));
    assert.deepEqual(list.projects.map((project) => project.name), ["alpha", "gamma", "beta"]);
    assert.deepEqual(list.projects.map((project) => project.sort_order), [0, 10, 20]);

    await json(await post("/api/projects", { name: "delta", sourcePaths: ["./src"] }));
    list = await json(await fetch(base + "/api/projects"));
    assert.deepEqual(list.projects.map((project) => project.name), ["delta", "alpha", "gamma", "beta"]);
    assert.deepEqual(list.projects.map((project) => project.sort_order), [-10, 0, 10, 20]);
    assert.equal(list.total, 4);
    assert.equal(list.limit, 100);
    assert.equal(list.offset, 0);

    const page = await json(await fetch(base + "/api/projects?limit=2&offset=1"));
    assert.deepEqual(page.projects.map((project) => project.name), ["alpha", "gamma"]);
    assert.equal(page.total, 4);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);

    const search = await json(await fetch(base + "/api/projects?q=lph"));
    assert.deepEqual(search.projects.map((project) => project.name), ["alpha"]);
    assert.equal(search.total, 1);

    archived = await json(await fetch(base + "/api/projects?archived=1"));
    assert.deepEqual(archived.projects, []);

    const archivedDelete = await json(await post("/api/projects", { name: "archived-delete", sourcePaths: ["./src"] }));
    await patch(`/api/projects/${archivedDelete.uuid}`, { archived: true });
    archived = await json(await fetch(base + "/api/projects?archived=1"));
    assert.deepEqual(archived.projects.map((project) => project.name), ["archived-delete"]);
    assert.equal((await deleteReq(`/api/projects/${archivedDelete.uuid}`)).status, 200);
    archived = await json(await fetch(base + "/api/projects?archived=1"));
    assert.deepEqual(archived.projects, []);
  });
});

test("api: project run defaults leave map/dig turns and scope selection unbounded", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "default-run-budget",
      sourcePaths: ["./src"],
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.pipeline, true);
    assert.equal(spec.clue, "default-run-budget");
    assert.equal(spec.coverageMode, "full");
    assert.equal(spec.maxScopes, undefined);
    assert.equal(spec.mapSteps, undefined);
    assert.equal(spec.digSteps, undefined);
    assert.equal(spec.maxSteps, undefined);
  });
});

test("api: explicit standard coverage leaves map/dig turns unbounded while capping the batch", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "standard-run-budget",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard" },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.pipeline, true);
    assert.equal(spec.clue, "standard-run-budget");
    assert.equal(spec.coverageMode, "standard");
    assert.equal(spec.maxScopes, 30);
    assert.equal(spec.mapSteps, undefined);
    assert.equal(spec.digSteps, undefined);
    assert.equal(spec.maxSteps, undefined);
  });
});

test("api: standard coverage fills the project up to 30 audited scopes instead of adding 30 per run", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "standard-cumulative-run-budget",
      sourcePaths: ["./src"],
      config: { maxScopes: 30 },
    }));

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        ...Array.from({ length: 20 }, (_, i) => ({ scopeId: `audited-${i}`, title: `Audited ${i}`, status: "audited", score: 10 - i })),
        ...Array.from({ length: 20 }, (_, i) => ({ scopeId: `pending-${i}`, title: `Pending ${i}`, status: "pending", score: 20 - i })),
      ]);
    } finally {
      store.close();
    }

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.pipeline, true);
    assert.equal(spec.coverageMode, "standard");
    assert.equal(spec.coverageTarget, 30);
    assert.equal(spec.maxScopes, 10);
  });
});

test("api: standard coverage lets pipeline continue after 30 audited scopes but still allows explicit scopes", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "standard-cumulative-complete",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard" },
    }));

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        ...Array.from({ length: 30 }, (_, i) => ({ scopeId: `audited-${i}`, title: `Audited ${i}`, status: "audited", score: 30 - i })),
        ...Array.from({ length: 5 }, (_, i) => ({ scopeId: `pending-${i}`, title: `Pending ${i}`, status: "pending", score: 5 - i })),
      ]);
    } finally {
      store.close();
    }

    const continued = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(continued.queued, true);
    const continuedJob = (await json(await fetch(base + "/api/jobs/" + continued.jobId))).job;
    const continuedSpec = JSON.parse(continuedJob.spec_json);
    assert.equal(continuedSpec.pipeline, true);
    assert.equal(continuedSpec.coverageTarget, 30);
    assert.equal(continuedSpec.maxScopes, 0);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", scope: "pending-0" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.equal(spec.scope, "pending-0");
    assert.equal(spec.maxScopes, 30);
  });
});

test("api: project prepare defaults leave prepare turns unbounded", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "default-prepare-budget",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard", maxScopes: 30 },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "prepare",
      clue: "authorized target clue",
      posture: "blind",
    }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "prepare");
    assert.equal(spec.maxSteps, undefined);
    assert.equal(spec.mapSteps, undefined);
    assert.equal(spec.digSteps, undefined);
    assert.equal(spec.maxScopes, 30);
  });
});

test("api: project prepare uses stored prepare clue when no launch clue is supplied", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "stored-prepare-clue",
      config: {
        prepareClue: "audit the authorized deployment at 0x123 with official source and docs",
        projectIntent: "audit the authorized deployment at 0x123 with official source and docs",
      },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "prepare",
    }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "prepare");
    assert.equal(spec.clue, "audit the authorized deployment at 0x123 with official source and docs");
    assert.equal(spec.posture, "blind");
    assert.equal(spec.matchDeployed, true);
  });
});

test("api: daemon pipeline jobs can append phase runs and keep job linked to the active phase", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const headers = { "content-type": "application/json" };
    const store = MetadataStore.openForOutput(out);
    let token;
    let jobId;
    try {
      const daemon = store.createDaemonToken("pipeline-daemon");
      token = daemon.token;
      const projectId = store.upsertProject({ name: "pipeline-project", config: {} });
      assert.ok(projectId > 0);
      jobId = store.enqueueJob("pipeline-project", { verb: "run", pipeline: true }, daemon.id);
    } finally {
      store.close();
    }
    const authHeaders = { ...headers, authorization: `Bearer ${token}` };
    const claimed = await json(await fetch(base + "/api/daemon/claim", { method: "POST", headers: authHeaders }));
    assert.equal(claimed.job.id, jobId);

    const first = await json(await fetch(base + "/api/daemon/runs", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jobId, project: "pipeline-project", kind: "prepare", runDir: path.join(out, "pipeline-prepare") }),
    }));
    const second = await json(await fetch(base + "/api/daemon/runs", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ jobId, project: "pipeline-project", kind: "run", runDir: path.join(out, "pipeline-run"), additional: true }),
    }));
    assert.notEqual(second.runId, first.runId);
    const job = (await json(await fetch(base + "/api/jobs/" + jobId))).job;
    assert.equal(job.run_id, second.runId);
  });
});

test("api: daemon pipeline worklist exposes verify candidates before confirm", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "pipeline-verify-worklist", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    let token;
    let suspectedId;
    try {
      const daemon = store.createDaemonToken("pipeline-verify-daemon");
      token = daemon.token;
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir: path.join(out, "pipeline-verify-run") });
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "suspected-bug",
          title: "Proof input is not bound",
          location: "src/Rollup.sol:44",
          severity: "high",
          status: "suspected",
          confidence: 0.82,
        },
      ], "synthesis");
      suspectedId = Number(store.listFindings(created.id)[0].id);
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "confirmed-bug",
          title: "Confirmed escrow drain through unchecked withdrawal proof",
          location: "src/Vault.sol:88",
          severity: "critical",
          status: "confirmed-executable",
          confidence: 0.91,
        },
      ], "differential");
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "kalreadyreproduced",
          title: "Already reproduced unchecked withdrawal proof",
          location: "src/Vault.sol:90",
          severity: "critical",
          status: "confirmed-executable",
          confidence: 0.93,
        },
      ], "differential");
      const confirmRun = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "pipeline-confirm-run") });
      store.upsertConfirmDecisions(created.id, confirmRun, [
        { bug: "prior reproduced withdrawal proof", reproduced: "yes", recommendation: "submit-candidate", members: ["kalreadyreproduced"] },
      ]);
      store.finishRun(confirmRun, "done");
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "duplicate-suspected-bug",
          title: "Escrow drain is reachable through unchecked withdrawal proof",
          location: "src/Vault.sol:88",
          severity: "high",
          status: "suspected",
          confidence: 0.72,
        },
      ], "synthesis");
    } finally {
      store.close();
    }

    const authHeaders = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const verify = await json(await fetch(base + "/api/daemon/pipeline-worklist", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project: "pipeline-verify-worklist", phase: "verify" }),
    }));
    assert.equal(verify.phase, "verify");
    assert.equal(verify.verifyFindings.length, 1);
    assert.equal(verify.verifyFindings[0].id, suspectedId);
    assert.equal(verify.verifyFindings[0].originId, suspectedId);
    assert.equal(verify.verifyFindings[0].finding_key, "suspected-bug");

    const restartVerify = await json(await fetch(base + "/api/daemon/pipeline-worklist", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project: "pipeline-verify-worklist", phase: "verify", verifyFromStart: true }),
    }));
    assert.equal(restartVerify.phase, "verify");
    assert.equal(restartVerify.verifyFromStart, true);
    assert.deepEqual(new Set(restartVerify.verifyFindings.map((finding) => finding.finding_key)), new Set(["suspected-bug", "confirmed-bug"]));

    const confirm = await json(await fetch(base + "/api/daemon/pipeline-worklist", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project: "pipeline-verify-worklist", phase: "confirm" }),
    }));
    assert.ok(confirm.confirmKeys.includes("confirmed-bug"));
    assert.ok(confirm.confirmKeys.includes("kalreadyreproduced"), "confirm worklist carries prior decided findings as consolidation context");
    assert.deepEqual(confirm.confirmSettledRows.map((row) => row.bug), ["prior reproduced withdrawal proof"]);
    assert.ok(confirm.confirmKeys.some((key) => /^origin:\d+:confirmed-bug$/.test(key)), "worklist carries origin selector for verify-artifact recovery");

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    const suspected = detail.allFindings.find((finding) => finding.finding_key === "suspected-bug");
    assert.equal(suspected.timeline[0].reason, "synthesis");
    assert.equal(detail.allFindings.some((finding) => finding.finding_key === "duplicate-suspected-bug"), false);
  });
});

test("api: current confirm decisions hide older rows superseded by newer member decisions", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "superseded-confirm-decisions", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      const oldConfirm = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "old-confirm") });
      store.upsertConfirmDecisions(created.id, oldConfirm, [
        { bug: "old setup blocker", reproduced: "could-not-set-up", recommendation: "needs-human", members: ["kabc123"] },
        { bug: "still unsettled", reproduced: "could-not-set-up", recommendation: "needs-human", members: ["kstill"] },
      ]);
      store.finishRun(oldConfirm, "done");
      const newConfirm = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "new-confirm") });
      store.upsertConfirmDecisions(created.id, newConfirm, [
        { bug: "new reproduced result", reproduced: "yes", recommendation: "submit-candidate", members: ["kabc123"] },
      ]);
      store.finishRun(newConfirm, "done");
      const setupFailedConfirm = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "setup-failed-confirm") });
      store.upsertConfirmDecisions(created.id, setupFailedConfirm, [
        { bug: "new setup failed retry", reproduced: "could-not-set-up", recommendation: "needs-human", members: ["kabc123"] },
      ]);
      store.finishRun(setupFailedConfirm, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.deepEqual(new Set(detail.confirmDecisions.map((row) => row.bug)), new Set(["new reproduced result", "still unsettled"]));
    assert.equal(detail.reproducedBugs, 1);

    const current = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions`));
    assert.deepEqual(new Set(current.confirmDecisions.map((row) => row.bug)), new Set(["new reproduced result", "still unsettled"]));

    const withHistory = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions?includeStale=true`));
    assert.deepEqual(new Set(withHistory.confirmDecisions.map((row) => row.bug)), new Set(["new setup failed retry", "new reproduced result", "old setup blocker", "still unsettled"]));
  });
});

test("api: project prepare reuses prior neutral clue when resolving materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "neutral-material-resolution",
      dir: "neutral-project-dir",
      config: { scopeCoverageMode: "standard", maxScopes: 30 },
    }));
    const runDir = path.join(out, "neutral-material-resolution-prepare");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        clue: "official source and deployment material for neutral project",
        posture: "blind",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          ground_truth: [],
          confirm_guidance: { required: false, not_required_reason: "source-only fixture" },
        },
        components: [],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "prepare" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.equal(spec.verb, "prepare");
    assert.equal(spec.clue, "official source and deployment material for neutral project");
    assert.equal(spec.posture, "blind");
    assert.equal(spec.matchDeployed, true);
  });
});

test("api: project run one-off coverage options are copied into the queued launch spec", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "one-off-run-budget",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard" },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "audit",
      scope: "S1,S2",
      scopeCoverageMode: "custom",
      maxScopes: 2,
      mapSteps: 3,
      digSteps: 5,
      maxSteps: 7,
      digSamples: 2,
      digConcurrency: 2,
    }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "audit");
    assert.equal(spec.scope, "S1,S2");
    assert.equal(spec.maxScopes, 2);
    assert.equal(spec.mapSteps, 3);
    assert.equal(spec.digSteps, 5);
    assert.equal(spec.maxSteps, 7);
    assert.equal(spec.digSamples, 2);
    assert.equal(spec.digConcurrency, 2);
  });
});

test("api: verify launch links project finding rows back to the original finding", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "verify-origin", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "verify-origin-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "suspected-bug",
          title: "Proof input is not bound",
          location: "src/Rollup.sol:44",
          severity: "high",
          status: "suspected",
          scopeId: "SCOPE-1",
          confidence: 0.82,
        },
      ]);
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.allFindings.length, 1);
    const finding = detail.allFindings[0];
    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "audit",
      verifyFindings: [finding],
    }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "audit");
    assert.equal(spec.verifyFindings[0].id, finding.id);
    assert.equal(spec.verifyFindings[0].originId, finding.id);
  });
});

test("api: verify launch rejects findings produced before a newer prepare run", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "verify-material-drift", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    let findingId;
    try {
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "verify-material-drift-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", auditRun);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "stale-suspected-bug",
          title: "Stale proof input is not bound",
          location: "src/Rollup.sol:44",
          severity: "high",
          status: "suspected",
        },
      ]);
      findingId = Number(store.listFindings(created.id)[0].id);
      const prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "verify-material-drift-prepare") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepareRun);
      store.finishRun(prepareRun, "done");
    } finally {
      store.close();
    }

    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", verifyFindings: [{ id: findingId }] });
    assert.equal(rejected.status, 409);
    const rejectedBody = await json(rejected);
    assert.equal(rejectedBody.materialDrift, true);
    assert.equal(rejectedBody.findings[0].findingId, findingId);
    assert.match(rejectedBody.error, /newer Prepare run/);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "audit",
      verifyFindings: [{ id: findingId }],
      allowMaterialDrift: true,
    }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.equal(spec.verifyFindings[0].originId, findingId);
  });
});

test("api: verify launch treats killed newer prepare as material drift", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "verify-killed-material-drift", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    let prepareRun;
    let findingId;
    try {
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "verify-killed-material-drift-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", auditRun);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "stale-suspected-bug",
          title: "Stale proof input is not bound",
          location: "src/Rollup.sol:44",
          severity: "high",
          status: "suspected",
        },
      ]);
      findingId = Number(store.listFindings(created.id)[0].id);
      prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "verify-killed-material-drift-prepare") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepareRun);
      store.finishRun(prepareRun, "killed");
    } finally {
      store.close();
    }

    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", verifyFindings: [{ id: findingId }] });
    assert.equal(rejected.status, 409);
    const rejectedBody = await json(rejected);
    assert.equal(rejectedBody.materialDrift, true);
    assert.equal(rejectedBody.findings[0].findingId, findingId);
    assert.equal(rejectedBody.findings[0].prepareRunId, prepareRun);
  });
});

test("api: project current view ignores downstream data from older prepare materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "material-current-view", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      const prepare1 = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "material-current-view-prepare-1") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", prepare1);
      store.finishRun(prepare1, "done");
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "material-current-view-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T01:00:00.000Z", auditRun);
      store.upsertScopes(created.id, [{ scopeId: "old-scope", title: "Old scope", status: "audited", score: 1 }]);
      await saveScopeInventory(projectHistoryDir({ outputDir: out, targetName: "material-current-view" }), [
        { id: "old-scope", title: "Old scope", region: "src/Old.sol", obligation: "Old source obligation", status: "audited", score: 1 },
      ]);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "old-bug",
          title: "Old source bug",
          location: "src/Old.sol:1",
          severity: "high",
          status: "confirmed-executable",
        },
      ]);
      const prepare2 = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "material-current-view-prepare-2") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepare2);
      store.finishRun(prepare2, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.findingsTotal, 0);
    assert.equal(detail.progress.total, 0);
    assert.equal(detail.auditConfirmedFindings, 0);
    assert.equal(detail.currentRunsTotal, 1);
    assert.equal(detail.material.currentPrepareRunId > 0, true);
    assert.equal(detail.runs.some((run) => run.kind === "audit" && run.material_stale === true), true);

    const scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.equal(scopes.total, 0);
    assert.deepEqual(scopes.scopes, []);

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.equal(snapshot.progress.total, 0);
    assert.equal(snapshot.findingsTotal, 0);
    assert.equal(snapshot.auditConfirmedFindings, 0);
    assert.equal(snapshot.reproducedBugs, 0);
    assert.equal(snapshot.currentRunCount, 1);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
    const afterLaunch = MetadataStore.openForOutput(out);
    try {
      assert.equal(afterLaunch.countScopes(created.id), 0);
    } finally {
      afterLaunch.close();
    }
    assert.deepEqual(await loadScopeInventory(projectHistoryDir({ outputDir: out, targetName: "material-current-view" })), []);
  });
});

test("api: launching prepare clears the current scope inventory projection", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "prepare-clears-scopes", sourcePaths: ["./src"] }));
    const inventoryDir = projectHistoryDir({ outputDir: out, targetName: "prepare-clears-scopes" });
    const store = MetadataStore.openForOutput(out);
    try {
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "prepare-clears-scopes-audit") });
      store.upsertScopes(created.id, [{ scopeId: "old-scope", title: "Old scope", status: "pending", score: 1 }]);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "old-verified",
          title: "Old verified finding",
          location: "src/Old.sol:9",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.9,
        },
      ]);
      const confirmRun = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "prepare-clears-scopes-confirm") });
      store.upsertConfirmDecisions(created.id, confirmRun, [
        {
          bug: "Old verified finding",
          reproduced: "yes",
          recommendation: "submit-candidate",
          members: ["old-verified"],
        },
      ]);
      await saveScopeInventory(inventoryDir, [{ id: "old-scope", title: "Old scope", status: "pending", score: 1 }]);
    } finally {
      store.close();
    }

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "prepare" }));
    assert.equal(launched.queued, true);
    const after = MetadataStore.openForOutput(out);
    try {
      assert.equal(after.countScopes(created.id), 0);
    } finally {
      after.close();
    }
    const inventory = await loadScopeInventory(inventoryDir);
    assert.deepEqual(inventory, []);

    const detail = await json(await fetch(`${base}/api/projects/${created.uuid}`));
    assert.equal(detail.progress.total, 0);
    assert.equal(detail.findingsTotal, 0);
    assert.equal(detail.reproducedBugs, 0);
    assert.deepEqual(detail.confirmDecisions, []);
    assert.equal(detail.prepareSummary, null);
    assert.ok(detail.material.activePrepareRefreshStartedAt);
    assert.equal(detail.currentRunsTotal, 0);
    assert.equal(detail.runs.filter((run) => !run.material_stale).length, 0);
    assert.equal(detail.runs.some((run) => run.kind === "audit" && run.material_stale === true), true);
    assert.equal(detail.runs.some((run) => run.kind === "confirm" && run.material_stale === true), true);

    const scopes = await json(await fetch(`${base}/api/projects/${created.uuid}/scopes`));
    assert.equal(scopes.total, 0);
    assert.deepEqual(scopes.scopes, []);
    assert.equal(scopes.progress.total, 0);

    const currentDecisions = await json(await fetch(`${base}/api/projects/${created.uuid}/confirm-decisions`));
    assert.deepEqual(currentDecisions.confirmDecisions, []);
    const staleDecisions = await json(await fetch(`${base}/api/projects/${created.uuid}/confirm-decisions?includeStale=true`));
    assert.equal(staleDecisions.confirmDecisions.length, 1);
    assert.equal(staleDecisions.confirmDecisions[0].bug, "Old verified finding");
    assert.equal(staleDecisions.confirmDecisions[0].material_stale, true);

    const list = await json(await fetch(`${base}/api/projects`));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.equal(snapshot.progress.total, 0);
    assert.equal(snapshot.findingsTotal, 0);
    assert.equal(snapshot.reproducedBugs, 0);
    assert.equal(snapshot.confirmDecisionCount, 0);
    assert.equal(snapshot.activeRuns, 1);
    assert.equal(snapshot.latestRun, null);
  });
});

test("api: project findings search can target a finding id link", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-id-search", sourcePaths: ["./src"] }));
    let linkedId = 0;
    const store = MetadataStore.openForOutput(out);
    try {
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "finding-id-search-audit") });
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "linked-finding",
          title: "Linked finding target",
          location: "src/Target.sol:10",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.9,
        },
        {
          findingKey: "other-finding",
          title: "Other finding",
          location: "src/Other.sol:20",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.9,
        },
      ]);
      linkedId = Number(store.listFindings(created.id).find((row) => row.finding_key === "linked-finding")?.id);
    } finally {
      store.close();
    }

    const byId = await json(await fetch(`${base}/api/projects/${created.uuid}/findings?q=%23${linkedId}`));
    assert.equal(byId.total, 1);
    assert.equal(byId.findings[0].id, linkedId);
    assert.equal(byId.findings[0].finding_key, "linked-finding");
  });
});

test("api: running prepare resets the project current view to the new material snapshot", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "prepare-refresh-running", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      const prepare1 = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "prepare-refresh-running-prepare-1") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", prepare1);
      store.finishRun(prepare1, "done");

      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "prepare-refresh-running-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T01:00:00.000Z", auditRun);
      store.updateRunCoverage(auditRun, { total: 42, audited: 30, pending: 12 });
      store.recordStage(auditRun, "synthesis", { status: "done", produced: 2, scopes: 30 });
      store.upsertScopes(created.id, [{ scopeId: "old-scope", title: "Old scope", status: "audited", score: 1 }]);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "old-verified",
          title: "Old verified finding",
          location: "src/Old.sol:9",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.9,
          reportMarkdown: "# Old report\n",
        },
      ]);
      const confirmRun = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "prepare-refresh-running-confirm") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T02:00:00.000Z", confirmRun);
      store.upsertConfirmDecisions(created.id, confirmRun, [
        {
          bug: "Old verified finding",
          reproduced: "yes",
          recommendation: "submit-candidate",
          members: ["old-verified"],
        },
      ]);
      store.finishRun(confirmRun, "done");
      const reportRun = store.startRun({ projectId: created.id, kind: "report", runDir: path.join(out, "prepare-refresh-running-report") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T03:00:00.000Z", reportRun);
      store.finishRun(reportRun, "done");

      const jobId = store.enqueueJob(created.name, { verb: "prepare" });
      store.db.prepare("UPDATE job SET created_at = ?, updated_at = ? WHERE id = ?").run("2026-01-01T23:59:00.000Z", "2026-01-01T23:59:00.000Z", jobId);
      const prepare2 = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "prepare-refresh-running-prepare-2") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepare2);
      store.setJobRun(jobId, prepare2);
      const strayAuditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "prepare-refresh-running-stray-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:01:00.000Z", strayAuditRun);
      store.recordStage(strayAuditRun, "synthesis", { status: "done", produced: 9, scopes: 9 });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.deepEqual(detail.progress, { total: 0, audited: 0, deferred: 0, pending: 0 });
    assert.equal(detail.findingsTotal, 0);
    assert.equal(detail.auditConfirmedFindings, 0);
    assert.equal(detail.reproducedBugs, 0);
    assert.deepEqual(detail.confirmDecisions, []);
    assert.deepEqual(detail.allFindings, []);
    assert.equal(detail.currentRunsTotal, 1);
    assert.equal(detail.runs.find((run) => !run.material_stale)?.kind, "prepare");
    assert.equal(detail.runs.some((run) => run.kind === "audit" && run.material_stale === true), true);
    assert.equal(detail.runs.some((run) => run.kind === "confirm" && run.material_stale === true), true);
    assert.equal(detail.runs.some((run) => run.kind === "report" && run.material_stale === true), true);
    assert.equal(detail.runs.filter((run) => !run.material_stale).map((run) => run.kind).join(","), "prepare");
    assert.equal(detail.material.currentPrepareStatus, "running");

    const currentFindings = await json(await fetch(base + `/api/projects/${created.uuid}/findings`));
    assert.equal(currentFindings.total, 0);
    assert.deepEqual(currentFindings.findings, []);

    const staleFindings = await json(await fetch(base + `/api/projects/${created.uuid}/findings?includeStale=true`));
    assert.equal(staleFindings.total, 1);
    assert.equal(staleFindings.findings[0].title, "Old verified finding");
    assert.equal(staleFindings.findings[0].material_stale, true);

    const currentDecisions = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions`));
    assert.deepEqual(currentDecisions.confirmDecisions, []);
    const staleDecisions = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions?includeStale=true`));
    assert.equal(staleDecisions.confirmDecisions.length, 1);
    assert.equal(staleDecisions.confirmDecisions[0].bug, "Old verified finding");
    assert.equal(staleDecisions.confirmDecisions[0].material_stale, true);

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.deepEqual(snapshot.progress, { total: 0, audited: 0, deferred: 0, pending: 0 });
    assert.equal(snapshot.findingsTotal, 0);
    assert.equal(snapshot.auditConfirmedFindings, 0);
    assert.equal(snapshot.reproducedBugs, 0);
    assert.equal(snapshot.confirmDecisionCount, 0);
    assert.equal(snapshot.currentRunCount, 1);
    assert.equal(snapshot.latestRun.kind, "prepare");
  });
});

test("api: remap resets downstream findings and decisions from the current view", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "remap-current-view", sourcePaths: ["./src"] }));
    const mapDir = await mkdtemp(path.join(out, "remap-current-view-map-"));
    const workspace = path.join(mapDir, "audit", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "scopes.json"),
      JSON.stringify([
        { id: "NEW-1", obligation: "Bind remapped input.", region: "src/New.sol:1-40", score: 9 },
        { id: "NEW-2", obligation: "Reject stale state.", region: "src/New.sol:41-80", score: 8 },
      ]),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "remap-current-view-prepare") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", prepareRun);
      store.finishRun(prepareRun, "done");

      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "remap-current-view-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T01:00:00.000Z", auditRun);
      store.upsertScopes(created.id, [{ scopeId: "OLD-1", title: "Old scope", status: "audited", score: 10 }]);
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "old-bug",
          title: "Old bug",
          location: "src/Old.sol:9",
          severity: "high",
          status: "confirmed-executable",
        },
      ]);
      store.finishRun(auditRun, "done");

      const confirmRun = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "remap-current-view-confirm") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T02:00:00.000Z", confirmRun);
      store.upsertConfirmDecisions(created.id, confirmRun, [
        {
          bug: "Old bug",
          reproduced: "yes",
          recommendation: "submit-candidate",
          members: ["old-bug"],
        },
      ]);
      store.finishRun(confirmRun, "done");

      const mapRun = store.startRun({ projectId: created.id, kind: "map", runDir: mapDir });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T03:00:00.000Z", mapRun);
      store.finishRun(mapRun, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.deepEqual(detail.progress, { total: 2, audited: 0, deferred: 0, pending: 2 });
    assert.equal(detail.findingsTotal, 0);
    assert.equal(detail.auditConfirmedFindings, 0);
    assert.equal(detail.reproducedBugs, 0);
    assert.deepEqual(detail.confirmDecisions, []);
    assert.deepEqual(detail.allFindings, []);
    assert.equal(detail.material.currentScopeInventoryStatus, "done");
    assert.equal(detail.currentRunsTotal, 1);
    assert.equal(detail.runs.find((run) => !run.material_stale)?.kind, "map");

    const currentFindings = await json(await fetch(base + `/api/projects/${created.uuid}/findings`));
    assert.equal(currentFindings.total, 0);
    const staleFindings = await json(await fetch(base + `/api/projects/${created.uuid}/findings?includeStale=true`));
    assert.equal(staleFindings.total, 1);
    assert.equal(staleFindings.findings[0].title, "Old bug");
    assert.equal(staleFindings.findings[0].material_stale, true);

    const currentDecisions = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions`));
    assert.deepEqual(currentDecisions.confirmDecisions, []);
    const staleDecisions = await json(await fetch(base + `/api/projects/${created.uuid}/confirm-decisions?includeStale=true`));
    assert.equal(staleDecisions.confirmDecisions.length, 1);
    assert.equal(staleDecisions.confirmDecisions[0].bug, "Old bug");
    assert.equal(staleDecisions.confirmDecisions[0].material_stale, true);

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.deepEqual(snapshot.progress, { total: 2, audited: 0, deferred: 0, pending: 2 });
    assert.equal(snapshot.findingsTotal, 0);
    assert.equal(snapshot.reproducedBugs, 0);
    assert.equal(snapshot.confirmDecisionCount, 0);
    assert.equal(snapshot.currentRunCount, 1);
    assert.equal(snapshot.latestRun.kind, "map");
  });
});

test("api: report launch queues only reproduced real-target findings that were not dropped", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "report-launch", sourcePaths: ["./src"], corpusPaths: ["./docs"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "report-launch-audit") });
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "kready",
          title: "Ready bug",
          location: "src/Target.sol:12",
          severity: "high",
          status: "confirmed-executable",
          description: "A reproduced bug.",
          evidence: "Local proof passed.",
          confidence: 0.91,
        },
        {
          findingKey: "kdrop",
          title: "Dropped bug",
          location: "src/Target.sol:34",
          severity: "medium",
          status: "confirmed-executable",
        },
        {
          findingKey: "kexisting",
          title: "Existing report bug",
          location: "src/Target.sol:45",
          severity: "medium",
          status: "confirmed-executable",
        },
        {
          findingKey: "knotreproduced",
          title: "Not reproduced bug",
          location: "src/Target.sol:56",
          severity: "medium",
          status: "confirmed-executable",
        },
      ]);
      const confirmRun = store.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "report-launch-confirm") });
      store.upsertConfirmDecisions(created.id, confirmRun, [
        {
          bug: "Ready bug",
          reproduced: "yes",
          recommendation: "submit-candidate",
          members: ["kready"],
          reproEvidence: "purpose=confirm command cmd1 reproduced the real target effect",
          reproCommandId: "cmd1",
        },
        {
          bug: "Dropped bug",
          reproduced: "yes",
          recommendation: "drop",
          members: ["kdrop"],
        },
        {
          bug: "Existing report bug",
          reproduced: "yes",
          recommendation: "submit-candidate",
          members: ["kexisting"],
          reproEvidence: "purpose=confirm command cmd-existing reproduced the real target effect",
          reproCommandId: "cmd-existing",
          reportMarkdown: "# Existing report bug\n\nExisting formal report.",
        },
        {
          bug: "Not reproduced bug",
          reproduced: "no",
          recommendation: "drop",
          members: ["knotreproduced"],
        },
      ]);
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    const ready = detail.allFindings.find((finding) => finding.finding_key === "kready");
    const dropped = detail.allFindings.find((finding) => finding.finding_key === "kdrop");
    const existing = detail.allFindings.find((finding) => finding.finding_key === "kexisting");
    const readyDecision = detail.confirmDecisions.find((decision) => decision.bug === "Ready bug");
    const existingDecision = detail.confirmDecisions.find((decision) => decision.bug === "Existing report bug");
    assert.ok(ready);
    assert.ok(dropped);
    assert.ok(existing);
    assert.ok(readyDecision);
    assert.ok(existingDecision);
    assert.equal(existing.has_report, false);
    assert.equal(existingDecision.has_report, true);
    const generatedDecisionReport = await json(await fetch(base + `/api/confirm-decisions/${readyDecision.id}/report`));
    assert.equal(generatedDecisionReport.source, "generated");
    assert.match(generatedDecisionReport.markdown, /^# Ready bug/);
    assert.match(generatedDecisionReport.markdown, /## Summary/);
    assert.match(generatedDecisionReport.markdown, /## Root Cause/);
    assert.match(generatedDecisionReport.markdown, /src\/Target\.sol:12/);
    assert.match(generatedDecisionReport.markdown, /A reproduced bug/);
    assert.match(generatedDecisionReport.markdown, /Submission confidence: high/);
    assert.doesNotMatch(generatedDecisionReport.markdown, /Linked Findings|Finding #|finding_key|kready/);
    const storedDecisionReport = await json(await fetch(base + `/api/confirm-decisions/${existingDecision.id}/report`));
    assert.equal(storedDecisionReport.source, "db");
    assert.match(storedDecisionReport.markdown, /^# Existing report bug/);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "report" }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "report");
    assert.equal(spec.reportFindings.length, 1);
    assert.equal(spec.reportFindings[0].unit, "decision");
    assert.match(spec.reportFindings[0].findingKey, /^decision-/);
    assert.equal(spec.reportFindings[0].title, "Ready bug");
    assert.equal(spec.reportFindings[0].linkedFindings[0].finding_key, "kready");
    assert.equal(spec.reportFindings[0].decisions[0].repro_command_id, "cmd1");
    assert.match(spec.reportFindings[0].decisions[0].repro_evidence, /real target effect/);

    const regenerated = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "report", findingIds: [existing.id] }));
    const regeneratedJob = (await json(await fetch(base + "/api/jobs/" + regenerated.jobId))).job;
    const regeneratedSpec = JSON.parse(regeneratedJob.spec_json);

    assert.equal(regeneratedSpec.verb, "report");
    assert.equal(regeneratedSpec.reportFindings.length, 1);
    assert.equal(regeneratedSpec.reportFindings[0].unit, "decision");
    assert.equal(regeneratedSpec.reportFindings[0].title, "Existing report bug");
    assert.equal(regeneratedSpec.reportFindings[0].linkedFindings[0].finding_key, "kexisting");
    assert.equal(regeneratedSpec.reportFindings[0].decisions[0].repro_command_id, "cmd-existing");

    const regeneratedAll = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "report", regenerateReports: true }));
    const regeneratedAllJob = (await json(await fetch(base + "/api/jobs/" + regeneratedAll.jobId))).job;
    const regeneratedAllSpec = JSON.parse(regeneratedAllJob.spec_json);

    assert.equal(regeneratedAllSpec.verb, "report");
    assert.deepEqual(regeneratedAllSpec.reportFindings.map((finding) => finding.title).sort(), ["Existing report bug", "Ready bug"]);

    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "report", findingIds: [dropped.id] });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not reproduced on the real target|dropped/);
  });
});

test("api: report launch accepts source-only execution-confirmed findings without real-target confirm", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "source-only-report", sourcePaths: ["./src"], corpusPaths: ["./docs"] }));
    const prepareDir = path.join(out, "source-only-report-prepare");
    const workspace = path.join(prepareDir, "prepare", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        clue: "official source package",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "This fixture audits official source only; no live deployment is in scope.",
          ground_truth: [],
          confirm_guidance: { required: false, not_required_reason: "source-only fixture" },
        },
        components: [{ id: "pkg", kind: "git_repository", source: { revision: "abc123" }, in_scope: true }],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: prepareDir });
      store.finishRun(prepareRun, "done");
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "source-only-report-audit") });
      store.upsertFindings(created.id, auditRun, [
        {
          findingKey: "ksource",
          title: "Source-only execution confirmed bug",
          location: "src/Target.rs:12",
          severity: "medium",
          status: "confirmed-executable",
          description: "A locally confirmed source-only bug.",
          evidence: "Local proof passed.",
          confidence: 0.88,
        },
        {
          findingKey: "ksuspected",
          title: "Source-only suspected bug",
          location: "src/Target.rs:34",
          severity: "medium",
          status: "suspected",
        },
      ]);
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.realTarget.requiresConfirmation, false);
    const ready = detail.allFindings.find((finding) => finding.finding_key === "ksource");
    const suspected = detail.allFindings.find((finding) => finding.finding_key === "ksuspected");
    assert.ok(ready);
    assert.ok(suspected);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "report", findingIds: [ready.id] }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "report");
    assert.equal(spec.reportFindings.length, 1);
    assert.equal(spec.reportFindings[0].findingKey, "ksource");
    assert.equal(spec.reportFindings[0].evidenceMode, "source-only-local-confirmed");
    assert.deepEqual(spec.reportFindings[0].decisions, []);

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.equal(snapshot.auditConfirmedFindings, 1);
    assert.equal(snapshot.confirmPendingFindings, 0);
    assert.equal(snapshot.verifyPendingFindings, 1);

    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "report", findingIds: [suspected.id] });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not locally execution-confirmed/);
  });
});

test("api: one-off maxScopes overrides the project's saved coverage mode", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "one-off-scope-cap",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard" },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", maxScopes: 5 }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.maxScopes, 5);
  });
});

test("api: verify runs do not hide the latest scope inventory checkpoint", async () => {
  await withServer(async (base, out) => {
    const created = await (await fetch(base + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "verify-scope-view", sourcePaths: ["./src"] }),
    })).json();

    const inventoryRunDir = path.join(out, "verify-scope-view-map");
    await mkdir(inventoryRunDir, { recursive: true });
    await writeFile(path.join(inventoryRunDir, "scopes.json"), JSON.stringify([
      { id: "S1", obligation: "first scope", region: "src/a.ts:1", status: "audited", score: 9 },
      { id: "S2", obligation: "second scope", region: "src/b.ts:1", status: "pending", score: 8 },
    ]));

    const store = MetadataStore.openForOutput(out);
    try {
      const projectId = Number(created.id);
      const inventoryRun = store.startRun({ projectId, kind: "audit", runDir: inventoryRunDir });
      store.finishRun(inventoryRun, "done", { total: 2, audited: 1, pending: 1, deferred: 0 });
      const verifyRun = store.startRun({ projectId, kind: "audit", runDir: path.join(out, "verify-scope-view-verify"), budgets: { verify: true } });
      store.finishRun(verifyRun, "done");
    } finally {
      store.close();
    }

    const detail = await (await fetch(base + `/api/projects/${created.uuid}`)).json();
    assert.deepEqual(detail.progress, { total: 2, audited: 1, pending: 1, deferred: 0 });
    assert.equal(detail.scopes.length, 2);
    assert.equal(detail.material.currentScopeInventoryRunId, undefined);
  });
});

test("api: startup reconciles error runs that have successful terminal artifacts", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-api-reconcile-"));
  const runDir = path.join(out, "artifact-success-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "audit_done", stoppedReason: "finished", findings: 1 }) + "\n");

  const store = MetadataStore.openForOutput(out);
  let runId;
  try {
    const projectId = store.upsertProject({ name: "artifact-success" });
    runId = store.startRun({ projectId, kind: "audit", runDir, provider: "openai-codex", model: "gpt-5.5" });
    store.finishRun(runId, "error");
  } finally {
    store.close();
  }

  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await (await fetch(base + `/api/runs/${runId}`)).json();
    assert.equal(run.run.status, "done");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("api: project CRUD round-trip over HTTP", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    assert.deepEqual((await json(await fetch(base + "/api/projects"))).projects, []);

    const created = await json(await post("/api/projects", { name: "项目一", sourcePaths: ["./s"], config: { model: "gpt-5.5" } }));
    assert.equal(created.ok, true);
    assert.match(created.uuid, /^[0-9a-f-]{36}$/);
    const projectPath = "/api/projects/" + created.uuid;
    assert.equal((await post("/api/projects", { name: "项目一" })).status, 409); // duplicate rejected
    assert.equal((await fetch(base + "/api/projects/" + encodeURIComponent("项目一"))).status, 404); // URLs are UUID-only

    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.project.name, "项目一");
    assert.equal(detail.project.uuid, created.uuid);
    assert.equal(detail.project.dir, created.uuid);
    assert.equal(detail.findingsTotal, 0);
    assert.deepEqual(detail.progress, { total: 0, audited: 0, pending: 0, deferred: 0 });
    assert.deepEqual(detail.scopes, []);
    assert.deepEqual(detail.allFindings, []);

    await fetch(base + projectPath, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { model: "opus" } }) });
    assert.equal(JSON.parse((await json(await fetch(base + projectPath))).project.config_json).model, "opus");

    assert.deepEqual((await json(await fetch(base + projectPath + "/findings"))).findings, []);
    assert.equal((await fetch(base + projectPath, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(base + projectPath)).status, 404);
  });
});

test("api: project launch rejects a selected offline daemon instead of creating an unclaimable job", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const store = MetadataStore.openForOutput(out);
    const daemon = store.createDaemonToken("local");
    store.close();

    const created = await json(await post("/api/projects", { name: "offline-daemon", daemonId: daemon.id, sourcePaths: ["."], buildRoot: "." }));
    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "run" });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /not connected/);

    const queued = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run", allowOfflineQueue: true }));
    assert.equal(queued.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + queued.jobId))).job;
    assert.equal(job.daemon_id, daemon.id);

    const canceled = await json(await post(`/api/jobs/${queued.jobId}/cancel`, {}));
    assert.equal(canceled.ok, true);
    const after = (await json(await fetch(base + "/api/jobs/" + queued.jobId))).job;
    assert.equal(after.status, "canceled");
  });
});

test("api: project detail summarizes the latest prepare manifest and workspace quality", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "prepared-target" }));
    const projectPath = "/api/projects/" + created.uuid;
    const runDir = path.join(out, "prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        clue: "stale root checkpoint",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "Early checkpoint before workspace finalization.",
          ground_truth: [],
        },
        components: [],
      }),
    );
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(path.join(workspace, "source", ".git"), { recursive: true });
    await writeFile(path.join(workspace, "src", "Target.sol"), "contract Target {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        clue: "official source only",
        posture: "blind",
        scope_declaration: "First-party source and official docs only.",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "This fixture audits official source only; no deployed target is in scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No live deployment or published artifact is part of this prepared target.",
          },
        },
        components: [
          {
            id: "target",
            name: "Target",
            type: "source_repo",
            platform: "GitHub/crates.io",
            path: "src/Target.sol",
            origin: { url: "https://example.invalid/repo.git", commit: "abc123" },
            in_scope: true,
            deployment_match: { status: "n/a-source-only-pinned" },
          },
        ],
        gaps: ["deployment bytecode not applicable"],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({
        projectId: created.id,
        kind: "prepare",
        runDir,
        provider: "openai-codex",
        model: "gpt-5.5",
        thinking: "xhigh",
      });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.prepareSummary.manifestStatus, "present");
    assert.equal(detail.prepareSummary.quality, "preparing");
    assert.equal(detail.prepareSummary.manifestState, undefined);
    assert.equal(detail.prepareSummary.componentsTotal, 1);
    assert.equal(detail.prepareSummary.inScope, 1);
    assert.equal(detail.prepareSummary.sourcePinned, 1);
    assert.equal(detail.prepareSummary.answerFirewall, "clean");
    assert.equal(detail.prepareSummary.workspace.files, 2);
    assert.equal(detail.prepareSummary.workspace.gitDirs, 1);
    assert.equal("runDir" in detail.prepareSummary, false);
    assert.equal("workspaceDir" in detail.prepareSummary, false);
    assert.equal("manifestPath" in detail.prepareSummary, false);
    assert.equal(detail.prepareSummary.manifestArtifact, "prepare_manifest.json");
    assert.deepEqual(detail.prepareSummary.workspace.sampleFiles, ["src/Target.sol"]);
    assert.equal(detail.prepareSummary.realTarget.requiresConfirmation, false);
    assert.equal(detail.prepareSummary.realTarget.mode, "source-only");
    assert.equal(detail.prepareSummary.realTarget.guidance.required, false);
    assert.deepEqual(detail.prepareSummary.issues, []);

    const artifact = await fetch(base + `/api/runs/${detail.prepareSummary.runId}/artifact?name=prepare_manifest.json`);
    assert.equal(artifact.status, 200);
    const artifactJson = JSON.parse(await artifact.text());
    assert.equal(artifactJson.scope_declaration, "First-party source and official docs only.");
    assert.equal(artifactJson.components.length, 1);

    const launched = await json(await post(projectPath + "/runs", { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.equal(spec.pipeline, true);
    assert.deepEqual(spec.sourcePaths, [workspace]);
    assert.equal(spec.buildRoot, workspace);
    assert.equal(spec.dir, undefined);
    assert.equal(spec.clue, undefined);
    assert.match(spec.scopeNote, /PRIMARY AUDIT TARGET/);

    const auditRunDir = path.join(out, "prepared-target-audit-test");
    const confirmStore = MetadataStore.openForOutput(out);
    try {
      const auditRunId = confirmStore.startRun({ projectId: created.id, kind: "audit", runDir: auditRunDir, provider: "openai-codex", model: "gpt-5.5" });
      confirmStore.upsertFindings(created.id, auditRunId, [
        {
          findingKey: "confirmed-bug",
          title: "Prepared source bug",
          location: "src/Target.sol:1",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.9,
        },
        {
          findingKey: "kalreadyreproduced",
          title: "Prepared source bug already reproduced",
          location: "src/Target.sol:2",
          severity: "high",
          status: "confirmed-executable",
          confidence: 0.88,
        },
      ]);
      const confirmRunId = confirmStore.startRun({ projectId: created.id, kind: "confirm", runDir: path.join(out, "prepared-target-confirm-test"), provider: "openai-codex", model: "gpt-5.5" });
      confirmStore.upsertConfirmDecisions(created.id, confirmRunId, [
        { bug: "prior prepared source bug", reproduced: "yes", recommendation: "submit-candidate", members: ["kalreadyreproduced"] },
      ]);
      confirmStore.finishRun(confirmRunId, "done");
    } finally {
      confirmStore.close();
    }

    const confirmLaunch = await json(await post(projectPath + "/runs", { verb: "confirm" }));
    assert.equal(confirmLaunch.queued, true);
    const confirmJob = (await json(await fetch(base + "/api/jobs/" + confirmLaunch.jobId))).job;
    const confirmSpec = JSON.parse(confirmJob.spec_json);
    assert.deepEqual(confirmSpec.sourcePaths, [workspace]);
    assert.equal(confirmSpec.buildRoot, workspace);
    assert.equal(confirmSpec.dir, undefined);
    assert.equal(confirmSpec.inputRunDir, auditRunDir);
    assert.deepEqual(confirmSpec.inputRunDirs, [auditRunDir]);
    assert.ok(confirmSpec.confirmKeys.includes("confirmed-bug"));
    assert.ok(confirmSpec.confirmKeys.includes("kalreadyreproduced"), "project confirm carries prior decided findings as consolidation context");
    assert.deepEqual(confirmSpec.confirmSettledRows.map((row) => row.bug), ["prior prepared source bug"]);
    assert.ok(confirmSpec.confirmKeys.some((key) => /^origin:\d+:confirmed-bug$/.test(key)), "confirm spec carries origin selector for verify-artifact recovery");
  });
});

test("api: prepare summary normalizes verified deployment evidence", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "deployed-prepared-target" }));
    const runDir = path.join(out, "deployed-prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "sources", "sourcify", "1", "0xabc"), { recursive: true });
    await mkdir(path.join(workspace, "sources", "repo"), { recursive: true });
    await writeFile(path.join(workspace, "sources", "sourcify", "1", "0xabc", "Target.sol"), "contract Target {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        posture: "blind",
        answer_firewall: [],
        real_target: {
          requires_confirmation: true,
          reason: "The target is a deployed contract.",
          read_only_method: "Use read-only RPC calls or a local fork; never broadcast.",
          ground_truth: [
            {
              network: "ethereum-mainnet",
              chain_id: 1,
              address: "0xabc",
              role: "target_proxy",
              deployment_match_status: "verified_full_sourcify",
              block_number: 123,
            },
          ],
        },
        components: [
          {
            id: "repo",
            type: "git_repository",
            path: "sources/repo",
            provenance: { origin: "https://example.invalid/repo.git", revision: "abc123" },
            deployment_match: { status: "source_files_matched_to_sourcify_for_core_targets" },
            in_scope: true,
          },
          {
            id: "deployed-target",
            type: "ethereum_contract_implementation",
            address: "0xabc",
            path: "sources/sourcify/1/0xabc",
            provenance: {
              source_verifier: "Sourcify full_match",
              metadata: "provenance/sourcify_target_metadata.json",
              code_digest: { sha256: "0x123" },
            },
            deployment_match: { status: "verified_full_sourcify" },
            in_scope: true,
          },
          {
            id: "external-registry",
            type: "ethereum_contract_registry",
            address: "0xdef",
            path: "sources/repo/Registry.sol",
            provenance: { source_pin: "sources/repo/Registry.sol@abc123" },
            deployment_match: { status: "unverified" },
            in_scope: true,
          },
        ],
        gaps: [{ id: "external-registry-unverified", description: "Registry source is unverified." }],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.componentsTotal, 3);
    assert.equal(detail.prepareSummary.matched, 1);
    assert.equal(detail.prepareSummary.unverified, 1);
    assert.equal(detail.prepareSummary.sourcePinned, 3);
    assert.equal(detail.prepareSummary.realTarget.mode, "deployed");
    assert.equal(detail.prepareSummary.realTarget.guidance.recommendedMethod, "Use read-only RPC calls or a local fork; never broadcast.");
    assert.equal(detail.prepareSummary.realTarget.groundTruth[0].kind, "chain");
    assert.equal(detail.prepareSummary.realTarget.groundTruth[0].sourceMatch, "verified_full_sourcify");
    assert.equal(detail.prepareSummary.quality, "limited");
    assert.equal(detail.prepareSummary.auditReady, true);
    assert.equal(detail.prepareSummary.blocked, false);
    assert.deepEqual(detail.prepareSummary.blockingIssues, []);
    assert.deepEqual(detail.prepareSummary.caveats, [
      "1 deployed component(s) are unverified and should be treated as trust boundaries",
      "external-registry-unverified: Registry source is unverified.",
    ]);
    assert.deepEqual(detail.prepareSummary.issues, ["1 deployed component(s) are unverified and should be treated as trust boundaries"]);
  });
});

test("api: source-only prepare does not require real-target confirm guidance", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "source-only-no-guidance" }));
    const runDir = path.join(out, "source-only-no-guidance-prepare");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source"), { recursive: true });
    await writeFile(path.join(workspace, "source", "lib.rs"), "pub fn target() {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        clue: "official source only",
        posture: "blind",
        scope_declaration: "Official source package only.",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "This target is source-only; no live deployment or published runtime is in scope.",
          ground_truth: [],
        },
        components: [
          {
            identity: "source/package",
            platform: "none",
            revision: "v1.0.0",
            source: "repo@tag",
            staged_path: "source",
            in_scope: true,
            match: "n/a",
          },
        ],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.quality, "ready");
    assert.equal(detail.prepareSummary.realTarget.requiresConfirmation, false);
    assert.equal(detail.prepareSummary.realTarget.guidance.required, false);
    assert.equal(detail.prepareSummary.realTarget.guidance.allowedNetworkActions, "none");
    assert.equal(detail.prepareSummary.realTarget.guidance.notRequiredReason, "This target is source-only; no live deployment or published runtime is in scope.");
    assert.ok(!detail.prepareSummary.issues.includes("real_target.confirm_guidance is missing"));
    assert.deepEqual(detail.prepareSummary.issues, []);
  });
});

test("api: prepare summary accepts string real-target confirm guidance", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "string-confirm-guidance" }));
    const runDir = path.join(out, "string-confirm-guidance-prepare");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "contracts"), { recursive: true });
    await writeFile(path.join(workspace, "contracts", "Rollup.sol"), "contract Rollup {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        clue: "deployed target with string guidance",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: true,
          mode: "deployed",
          reason: "A deployed contract is in scope.",
          ground_truth: [
            {
              kind: "chain",
              network: "ethereum-mainnet",
              chain_id: 1,
              address: "0x1111111111111111111111111111111111111111",
              role: "rollup",
              block: "latest",
              source_match: "matched",
              evidence: "official docs",
              staged_component: "contracts/Rollup.sol",
            },
          ],
          confirm_guidance: "Use read-only RPC or a local fork; never broadcast.",
        },
        components: [
          {
            identity: "rollup",
            platform: "ethereum-mainnet",
            revision: "block 1",
            source: "verified",
            staged_path: "contracts/Rollup.sol",
            in_scope: true,
            match: "matched",
          },
        ],
        gaps: [],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.realTarget.guidance.required, true);
    assert.equal(detail.prepareSummary.realTarget.guidance.recommendedMethod, "Use read-only RPC or a local fork; never broadcast.");
    assert.ok(!detail.prepareSummary.issues.includes("real_target.confirm_guidance is missing"));
  });
});

test("api: unresolved prepare manifest status is surfaced as limited materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "unresolved-prepared-target" }));
    const runDir = path.join(out, "unresolved-prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source", "target"), { recursive: true });
    await writeFile(path.join(workspace, "source", "target", "README.md"), "official source snapshot\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "in_progress",
        clue: "official source around a date",
        posture: "blind",
        real_target: {
          requires_confirmation: true,
          mode: "deployed-contract",
          reason: "The prepared target is expected to be confirmed against a deployed contract once deployment artifacts resolve.",
          ground_truth: [],
          confirm_guidance: {
            required: true,
            allowed_network_actions: "read-and-local-fork",
            recommended_method: "Resolve the deployed address and reproduce against a local fork.",
          },
        },
        components: [
          {
            id: "target",
            type: "source_repository",
            staged_path: "source/target",
            origin: { url: "https://example.invalid/repo.git", tag: "v1.2.3", revision: "abc123" },
            in_scope: true,
            deployment_match: { status: "n/a", reason: "deployment artifacts still being resolved" },
          },
        ],
        gaps: [
          {
            id: "deployment-artifacts-unresolved",
            description: "Live deployment artifacts are still being resolved.",
          },
        ],
        answer_firewall: [],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.quality, "preparing");
    assert.equal(detail.prepareSummary.manifestState, "in_progress");
    assert.deepEqual(detail.prepareSummary.gaps, ["deployment-artifacts-unresolved: Live deployment artifacts are still being resolved."]);
    assert.match(detail.prepareSummary.issues.join("\n"), /prepare manifest status is in_progress/);
  });
});

test("api: nonstandard terminal prepare status remains automatable as limited materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "nonstandard-prepare-status" }));
    const runDir = path.join(out, "nonstandard-prepare-status-run");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source"), { recursive: true });
    await writeFile(path.join(workspace, "source", "README.md"), "official source snapshot\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "verified_with_notes",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "This target is source-only; no deployed target is in scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No deployed target is in scope.",
          },
        },
        components: [
          {
            identity: "source/package",
            platform: "none",
            revision: "v1.0.0",
            source: "repo@tag",
            staged_path: "source",
            in_scope: true,
            match: "n/a",
          },
        ],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.quality, "limited");
    assert.equal(detail.prepareSummary.auditReady, true);
    assert.equal(detail.prepareSummary.blocked, false);
    assert.deepEqual(detail.prepareSummary.blockingIssues, []);
    assert.equal(detail.prepareSummary.manifestState, "verified_with_notes");
    assert.match(detail.prepareSummary.issues.join("\n"), /prepare manifest status is verified_with_notes/);
    assert.match(detail.prepareSummary.caveats.join("\n"), /prepare manifest status is verified_with_notes/);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
  });
});

test("api: answer-bearing prepare materials are explicit hard blockers", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "blocked-answer-material" }));
    const runDir = path.join(out, "blocked-answer-material-prepare");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source"), { recursive: true });
    await writeFile(path.join(workspace, "source", "Target.sol"), "contract Target {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        posture: "blind",
        answer_firewall: "included incident post-mortem that names the exploit",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "No deployed target is in scope.",
          ground_truth: [],
        },
        components: [
          {
            identity: "source/target",
            platform: "none",
            revision: "abc123",
            staged_path: "source",
            in_scope: true,
            match: "n/a",
          },
        ],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.quality, "needs-review");
    assert.equal(detail.prepareSummary.auditReady, false);
    assert.equal(detail.prepareSummary.blocked, true);
    assert.match(detail.prepareSummary.blockingIssues.join("\n"), /answer firewall is included incident post-mortem/);
  });
});

test("api: clean prepare firewall notes and optional material gaps do not block audits", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "source-ready-with-notes" }));
    const runDir = path.join(out, "source-ready-with-notes-prepare");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "sources", "target"), { recursive: true });
    await writeFile(path.join(workspace, "sources", "target", "lib.rs"), "pub fn target() {}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        posture: "blind",
        scope_declaration: "Official published packages selected from package metadata.",
        answer_firewall: [
          "No material whose purpose is a vulnerability report, CVE, exploit, incident article, post-mortem, or target-specific bug writeup was staged.",
          "During neutral documentation resolution, an official protocol prose source surfaced historical vulnerability wording; that source was not copied into the staged docs, and temporary checkout material was removed.",
          "No vulnerability mechanism, affected code location, exploit steps, or security conclusion has been summarized in this manifest.",
        ],
        real_target: {
          requires_confirmation: false,
          mode: "source-only/published-packages",
          reason: "The target is source-only; neutral official materials did not identify a live deployed contract or service target requiring fork/read-only confirmation.",
          ground_truth: [
            {
              kind: "package",
              network: "n/a",
              address: "",
              role: "target",
              block: "1.0.0",
              source_match: "source-pinned",
              evidence: "registry checksum sha256:abc123",
              staged_component: "sources/target",
            },
          ],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks against staged package sources.",
            not_required_reason: "No deployed target is in scope.",
          },
        },
        components: [
          {
            identity: "target@1.0.0",
            platform: "crates.io",
            revision: "1.0.0",
            source: "published",
            staged_path: "sources/target",
            in_scope: true,
            match: "n/a",
          },
        ],
        gaps: [
          "No live deployed target was resolved because the task is source-only.",
          "Project-owned docs were best-effort and are not required for source provenance.",
        ],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.quality, "limited");
    assert.equal(detail.prepareSummary.auditReady, true);
    assert.equal(detail.prepareSummary.blocked, false);
    assert.deepEqual(detail.prepareSummary.blockingIssues, []);
    assert.deepEqual(detail.prepareSummary.issues, []);
    assert.equal(detail.prepareSummary.answerFirewall, "clean · 3 guardrail notes");
    assert.match(detail.prepareSummary.caveats.join("\n"), /Project-owned docs were best-effort/);
  });
});

test("api: blind prepare manifests get a clean answer-firewall fallback", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "blind-prepare-firewall" }));
    const runDir = path.join(out, "blind-prepare-firewall-run");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source"), { recursive: true });
    await writeFile(path.join(workspace, "source", "README.md"), "official source snapshot\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "partial",
        posture: "blind",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "Blind source-only fixture; no live target is part of scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No deployed target is in scope.",
          },
        },
        components: [
          {
            id: "source",
            staged_path: "source",
            origin: { url: "https://example.invalid/repo.git", tag: "v1.0.0" },
            in_scope: true,
            deployment_match: { status: "n/a" },
          },
        ],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.answerFirewall, "clean · blind posture");
    assert.deepEqual(detail.prepareSummary.issues, []);
  });
});

test("api: prepared workspace file count reports scan truncation", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "large-prepared-target" }));
    const runDir = path.join(out, "large-prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    const many = path.join(workspace, "source", "many");
    await mkdir(many, { recursive: true });
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        clue: "large official source",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "Large source fixture; no deployed target is in scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No deployed target is in scope.",
          },
        },
        components: [{ id: "target", in_scope: true, origin: { url: "https://example.invalid/repo.git", commit: "abc123" }, deployment_match: { status: "n/a" } }],
      }),
    );
    for (let batch = 0; batch < 5001; batch += 200) {
      await Promise.all(
        Array.from({ length: Math.min(200, 5001 - batch) }, (_, offset) =>
          writeFile(path.join(many, `file-${String(batch + offset).padStart(4, "0")}.txt`), ""),
        ),
      );
    }

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.prepareSummary.workspace.files, 5000);
    assert.equal(detail.prepareSummary.workspace.fileLimit, 5000);
    assert.equal(detail.prepareSummary.workspace.filesTruncated, true);
  });
});

test("api: terminal prepare runs display stale in-progress manifests as limited partial materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "partial-prepared-target" }));
    const runDir = path.join(out, "partial-prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source", "target"), { recursive: true });
    await writeFile(path.join(workspace, "source", "target", "README.md"), "official source snapshot\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "in_progress",
        clue: "official source around a date",
        posture: "blind",
        real_target: {
          requires_confirmation: true,
          mode: "deployed-contract",
          reason: "Deployment artifacts are still unresolved, so later confirmation requires the real deployed target once resolved.",
          ground_truth: [],
          confirm_guidance: {
            required: true,
            allowed_network_actions: "read-and-local-fork",
            recommended_method: "Resolve the deployed address and reproduce against a local fork.",
          },
        },
        components: [
          {
            identity: "repo",
            platform: "none",
            revision: "abc123",
            staged_path: "source/target",
            in_scope: true,
            match: "n/a",
          },
        ],
        gaps: [{ id: "deployment-artifacts-unresolved", description: "Live deployment artifacts are still being resolved." }],
        answer_firewall: [],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.quality, "limited");
    assert.equal(detail.prepareSummary.manifestState, "partial");
    assert.deepEqual(detail.prepareSummary.gaps, ["deployment-artifacts-unresolved: Live deployment artifacts are still being resolved."]);
    assert.match(detail.prepareSummary.issues.join("\n"), /staged materials are usable but partial/);
  });
});

test("api: terminal prepare with no components is not audit ready", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "empty-components-prepare" }));
    const runDir = path.join(out, "empty-components-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, ".tmp"), { recursive: true });
    await writeFile(path.join(workspace, ".tmp", "metadata.json"), "{}\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "partial",
        clue: "official source around a date",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "No live deployment is in scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No live deployment is in scope.",
          },
        },
        components: [],
        gaps: ["source packages not yet staged"],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.quality, "needs-review");
    assert.equal(detail.prepareSummary.auditReady, false);
    assert.equal(detail.prepareSummary.blocked, true);
    assert.match(detail.prepareSummary.blockingIssues.join("\n"), /manifest lists no components/);
  });
});

test("api: terminal prepare manifests with unresolved placeholders display as limited partial materials", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "placeholder-prepared-target" }));
    const runDir = path.join(out, "placeholder-prepared-target-prepare-test");
    const workspace = path.join(runDir, "prepare", "workspace");
    await mkdir(path.join(workspace, "source", "target"), { recursive: true });
    await writeFile(path.join(workspace, "source", "target", "README.md"), "official source snapshot\n");
    await writeFile(
      path.join(workspace, "prepare_manifest.json"),
      JSON.stringify({
        status: "done",
        clue: "official source around a date",
        posture: "blind",
        answer_firewall: "clean",
        real_target: {
          requires_confirmation: false,
          mode: "source-only",
          reason: "No live deployment is in scope.",
          ground_truth: [],
          confirm_guidance: {
            required: false,
            allowed_network_actions: "none",
            recommended_method: "Run local source-level checks only.",
            not_required_reason: "No live deployment is in scope.",
          },
        },
        components: [
          {
            identity: "official source",
            platform: "GitHub",
            revision: "pending resolution",
            staged_path: "pending",
            in_scope: true,
            match: "n/a-source-only-pending",
          },
        ],
        gaps: ["exact source revision still being resolved"],
      }),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "prepare", runDir, provider: "openai-codex", model: "gpt-5.5" });
      store.finishRun(runId, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + "/api/projects/" + created.uuid));
    assert.equal(detail.prepareSummary.quality, "limited");
    assert.equal(detail.prepareSummary.manifestState, "partial");
    assert.equal(detail.prepareSummary.sourcePinned, 0);
    assert.match(detail.prepareSummary.issues.join("\n"), /unresolved prepare placeholder/);
    assert.match(detail.prepareSummary.issues.join("\n"), /staged materials are usable but partial/);
  });
});

test("api: project detail previews live scope checkpoints before daemon ingest", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "scope-preview", sourcePaths: ["./src"] }));
    const projectPath = "/api/projects/" + created.uuid;
    const runDir = await mkdtemp(path.join(out, "scope-preview-run-"));
    const workspace = path.join(runDir, "audit", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "scopes.json"),
      JSON.stringify([
        { id: "S1", obligation: "Bind value balance to proof public inputs.", region: "src/A.sol:1-40", score: 10 },
        { id: "S2", title: "Replay guard", location: "src/B.sol:1-30", status: "deferred", score: 5 },
        {
          id: "S3",
          scope: "Verifier public input binding",
          region: "src/C.sol:1-90",
          spec: "The proof input must bind the committed root.",
          value: "Invalid proofs could release escrowed funds.",
          inputs: "Proof bytes, public input, committed root.",
          exposure: "critical",
        },
      ]),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({ projectId: created.id, kind: "run", runDir });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + projectPath));
    assert.deepEqual(detail.progress, { total: 3, audited: 0, deferred: 1, pending: 2 });
    assert.equal(detail.scopes.length, 3);
    const detailScopeById = new Map(detail.scopes.map((scope) => [scope.scope_id, scope]));
    const detailS1 = detailScopeById.get("S1");
    const detailS3 = detailScopeById.get("S3");
    assert.equal(detailS1.title, "Bind value balance to proof public inputs.");
    assert.equal(detailS1.obligation, "Bind value balance to proof public inputs.");
    assert.equal(detailS1.region, "src/A.sol:1-40");
    assert.equal(detailS3.title, "Verifier public input binding");
    assert.equal(detailS3.obligation, "Spec: The proof input must bind the committed root. Value at risk: Invalid proofs could release escrowed funds. Inputs/trust boundary: Proof bytes, public input, committed root.");
    assert.equal(detailS3.score, 10);

    const scopes = await json(await fetch(base + projectPath + "/scopes"));
    assert.deepEqual(scopes.progress, detail.progress);
    assert.equal(scopes.scopes.length, 3);
    const listedScopeById = new Map(scopes.scopes.map((scope) => [scope.scope_id, scope]));
    const listedS2 = listedScopeById.get("S2");
    assert.equal(listedS2.obligation, "Replay guard");
    assert.equal(listedS2.region, "src/B.sol:1-30");
  });
});

test("api: running remap checkpoint replaces stored scope inventory in current views", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "scope-remap-preview", sourcePaths: ["./src"] }));
    const projectPath = "/api/projects/" + created.uuid;

    const runDir = await mkdtemp(path.join(out, "scope-remap-run-"));
    const workspace = path.join(runDir, "audit", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "scopes.json"),
      JSON.stringify([
        { id: "NEW-1", obligation: "Bind the current proof input.", region: "src/New.sol:1-40", score: 9 },
        { id: "NEW-2", obligation: "Reject stale authorization.", region: "src/Auth.sol:1-30", score: 8 },
      ]),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "OLD-1", title: "Old inventory", status: "audited", score: 1 },
      ]);
      store.startRun({ projectId: created.id, kind: "map", runDir });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + projectPath));
    assert.deepEqual(detail.progress, { total: 2, audited: 0, deferred: 0, pending: 2 });
    assert.equal(detail.scopes.length, 2);
    assert.equal(detail.scopes[0].scope_id, "NEW-1");

    const scopes = await json(await fetch(base + projectPath + "/scopes"));
    assert.deepEqual(scopes.progress, detail.progress);
    assert.equal(scopes.total, 2);
    assert.equal(scopes.scopes[0].scope_id, "NEW-1");

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.deepEqual(snapshot.progress, detail.progress);
  });
});

test("api: running audit keeps the mapped scope inventory before its first checkpoint", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "audit-keeps-scopes", sourcePaths: ["./src"] }));

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "S1", title: "Mapped scope", status: "pending", score: 10 },
      ]);
      const mapRun = store.startRun({ projectId: created.id, kind: "map", runDir: path.join(out, "audit-keeps-scopes-map") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", mapRun);
      store.finishRun(mapRun, "done");
      const auditRun = store.startRun({ projectId: created.id, kind: "audit", runDir: path.join(out, "audit-keeps-scopes-audit") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T01:00:00.000Z", auditRun);
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.deepEqual(detail.progress, { total: 1, audited: 0, deferred: 0, pending: 1 });
    assert.equal(detail.scopes.length, 1);
    assert.equal(detail.scopes[0].scope_id, "S1");

    const scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.equal(scopes.total, 1);
    assert.equal(scopes.scopes[0].scope_id, "S1");
  });
});

test("api: latest map checkpoint bounds current scope inventory despite stale db rows", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "map-bounds-stale-scopes", sourcePaths: ["./src"] }));
    const projectPath = `/api/projects/${created.uuid}`;
    const runDir = await mkdtemp(path.join(out, "map-bounds-stale-scopes-map-"));
    const workspace = path.join(runDir, "audit", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, "scopes.json"),
      JSON.stringify([
        { id: "NEW-1", obligation: "Audit current source.", region: "src/New.sol:1-40", status: "pending", score: 10 },
        { id: "NEW-2", obligation: "Audit current auth.", region: "src/Auth.sol:1-20", status: "pending", score: 8 },
      ]),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "OLD-1", title: "Old stale scope", status: "audited", score: 99 },
      ]);
      const mapRun = store.startRun({ projectId: created.id, kind: "map", runDir });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", mapRun);
      store.finishRun(mapRun, "done");
      store.upsertScopes(created.id, [
        { scopeId: "NEW-1", title: "New scope with status", status: "audited", score: 10 },
      ]);
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + projectPath));
    assert.deepEqual(detail.progress, { total: 2, audited: 1, deferred: 0, pending: 1 });
    assert.deepEqual(detail.scopes.map((scope) => scope.scope_id), ["NEW-1", "NEW-2"]);
    assert.equal(detail.scopes[0].status, "audited");

    const scopes = await json(await fetch(base + `${projectPath}/scopes`));
    assert.equal(scopes.total, 2);
    assert.deepEqual(scopes.scopes.map((scope) => scope.scope_id), ["NEW-1", "NEW-2"]);
    assert.deepEqual(scopes.progress, detail.progress);

    const list = await json(await fetch(base + "/api/projects"));
    const snapshot = list.projects.find((project) => project.uuid === created.uuid);
    assert.deepEqual(snapshot.progress, detail.progress);
  });
});

test("api: scope prioritize moves a mapped scope to the top of the queue", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const patch = (p, body) => fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "scope-priority", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "high", title: "High score", status: "pending", score: 10 },
        { scopeId: "low", title: "Low score", status: "pending", score: 1 },
      ]);
    } finally {
      store.close();
    }

    let scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.deepEqual(scopes.scopes.map((scope) => scope.scope_id), ["high", "low"]);

    const prioritized = await json(await patch(`/api/projects/${created.uuid}/scopes/low`, { prioritize: true }));
    assert.equal(prioritized.prioritized, true);

    scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.deepEqual(scopes.scopes.map((scope) => scope.scope_id), ["low", "high"]);
    assert.ok(scopes.scopes[0].priority > scopes.scopes[1].priority);
  });
});

test("api: stale auditing scopes recover when no job is active", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "scope-stale", sourcePaths: ["./src"] }));
    const inventoryDir = projectHistoryDir({ outputDir: out, targetName: created.name });
    await saveScopeInventory(inventoryDir, [
      { id: "stale", title: "Stale scope", region: "src/Stale.sol", obligation: "Recover interrupted scope.", status: "auditing", score: 10 },
      { id: "queued", title: "Queued scope", region: "src/Queued.sol", obligation: "Stay pending.", status: "pending", score: 9 },
    ]);

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "stale", title: "Stale scope", status: "auditing", score: 10 },
        { scopeId: "queued", title: "Queued scope", status: "pending", score: 9 },
      ]);
    } finally {
      store.close();
    }

    const scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.deepEqual(scopes.scopes.map((scope) => [scope.scope_id, scope.status]), [["stale", "pending"], ["queued", "pending"]]);

    const inventory = await loadScopeInventory(inventoryDir);
    assert.deepEqual(inventory.map((scope) => [scope.id, scope.status]), [["stale", "pending"], ["queued", "pending"]]);
  });
});

test("api: active jobs keep auditing scopes in flight", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "scope-active", sourcePaths: ["./src"] }));
    const inventoryDir = projectHistoryDir({ outputDir: out, targetName: created.name });
    await saveScopeInventory(inventoryDir, [
      { id: "live", title: "Live scope", region: "src/Live.sol", obligation: "Remain in flight.", status: "auditing", score: 10 },
    ]);

    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [{ scopeId: "live", title: "Live scope", status: "auditing", score: 10 }]);
      store.enqueueJob(created.name, { verb: "audit" });
    } finally {
      store.close();
    }

    const scopes = await json(await fetch(base + `/api/projects/${created.uuid}/scopes`));
    assert.deepEqual(scopes.scopes.map((scope) => [scope.scope_id, scope.status]), [["live", "auditing"]]);
    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.activeScopeCount, 1);

    const inventory = await loadScopeInventory(inventoryDir);
    assert.deepEqual(inventory.map((scope) => [scope.id, scope.status]), [["live", "auditing"]]);
  });
});

test("api: project scopes endpoint paginates large inventories", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "scope-pages", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    try {
      store.upsertScopes(created.id, [
        { scopeId: "scope-a", title: "A", status: "pending", score: 10 },
        { scopeId: "scope-b", title: "B", status: "pending", score: 9 },
        { scopeId: "scope-c", title: "C", status: "pending", score: 8 },
      ]);
    } finally {
      store.close();
    }

    const page = await json(await fetch(base + `/api/projects/${created.uuid}/scopes?limit=2&offset=1`));
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.deepEqual(page.scopes.map((scope) => scope.scope_id), ["scope-b", "scope-c"]);
    assert.equal(page.progress.total, 3);
  });
});

test("api: info-only audit ledgers are hidden from actionable findings", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-filter", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-filter-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.upsertFindings(created.id, runId, [
        { findingKey: "ledger", title: "Obligation ledger: safe", location: "src/A.sol:1", severity: "info", status: "suspected" },
        { findingKey: "bug", title: "Unbound value", location: "src/B.sol:2", severity: "high", status: "suspected", evidence: "full proof detail kept for the project findings endpoint" },
      ]);
    } finally {
      store.close();
    }

    const projectPath = "/api/projects/" + created.uuid;
    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.findingsTotal, 1);
    assert.deepEqual(detail.statusCounts, { suspected: 1 });
    assert.equal(detail.auditConfirmedFindings, 0);
    assert.equal(detail.reproducedBugs, 0);
    assert.deepEqual(detail.allFindings.map((finding) => finding.finding_key), ["bug"]);
    assert.equal("evidence" in detail.allFindings[0], false, "project overview should use lightweight finding summaries");

    const findings = await json(await fetch(base + projectPath + "/findings"));
    assert.equal(findings.total, 1);
    assert.equal(findings.findings[0].finding_key, "bug");
    assert.equal(findings.findings[0].evidence, "full proof detail kept for the project findings endpoint");

    const bugs = await json(await fetch(base + "/api/bugs"));
    assert.equal(bugs.findings.length, 1);
    assert.equal("evidence" in bugs.findings[0], false, "global findings list should use lightweight finding summaries");
  });
});

test("api: project findings endpoint paginates detailed rows", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "finding-pages", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-pages-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.upsertFindings(created.id, runId, [
        { findingKey: "a", title: "A", location: "src/A.sol:1", severity: "low", status: "suspected", evidence: "detail-a" },
        { findingKey: "b", title: "B", location: "src/B.sol:1", severity: "medium", status: "suspected", evidence: "detail-b", reportPath: path.join(runDir, "report_b.md"), reportMarkdown: "# Report B\n" },
        { findingKey: "c", title: "C", location: "src/C.sol:1", severity: "high", status: "suspected", evidence: "detail-c" },
      ]);
    } finally {
      store.close();
    }

    const page = await json(await fetch(base + `/api/projects/${created.uuid}/findings?limit=2&offset=1`));
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.equal(page.findings.length, 2);
    assert.deepEqual(page.findings.map((finding) => finding.title), ["B", "A"]);
    assert.ok(page.findings.every((finding) => typeof finding.evidence === "string"));
    assert.equal(page.findings[0].has_report, true);
    assert.equal("report_path" in page.findings[0], false);
    assert.equal("report_markdown" in page.findings[0], false);
  });
});

test("api: ignored findings are hidden from active filters and can be recovered", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const patch = (p, body) => fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "ignored-findings", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "ignored-findings-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.upsertFindings(created.id, runId, [
        { findingKey: "keep", title: "Keep visible", location: "src/Keep.sol:1", severity: "medium", status: "suspected" },
        { findingKey: "ignore", title: "Human ignored", location: "src/Ignore.sol:1", severity: "low", status: "suspected" },
      ]);
    } finally {
      store.close();
    }

    const all = await json(await fetch(base + `/api/projects/${created.uuid}/findings`));
    const ignored = all.findings.find((finding) => finding.finding_key === "ignore");
    assert.ok(ignored);

    await patch(`/api/findings/${ignored.id}/tracking`, { status: "ignored" });

    const projectActive = await json(await fetch(base + `/api/projects/${created.uuid}/findings?tracking=active`));
    assert.deepEqual(projectActive.findings.map((finding) => finding.finding_key), ["keep"]);

    const projectIgnored = await json(await fetch(base + `/api/projects/${created.uuid}/findings?tracking=ignored`));
    assert.deepEqual(projectIgnored.findings.map((finding) => finding.finding_key), ["ignore"]);

    const globalActive = await json(await fetch(base + `/api/bugs?project=${encodeURIComponent(created.uuid)}&tracking=active`));
    assert.equal(globalActive.total, 1);
    assert.equal(globalActive.stats.total, 2);
    assert.equal(globalActive.stats.active, 1);
    assert.equal(globalActive.stats.byTracking.ignored, 1);

    await patch(`/api/findings/${ignored.id}/tracking`, { status: "open" });
    const restored = await json(await fetch(base + `/api/projects/${created.uuid}/findings?tracking=active`));
    assert.deepEqual(restored.findings.map((finding) => finding.finding_key).sort(), ["ignore", "keep"]);
  });
});

test("api: global findings endpoint paginates without changing global stats", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "global-finding-pages", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "global-finding-pages-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.upsertFindings(created.id, runId, [
        { findingKey: "a", title: "A", location: "src/A.sol:1", severity: "low", status: "suspected" },
        { findingKey: "b", title: "B", location: "src/B.sol:1", severity: "medium", status: "confirmed-executable" },
        { findingKey: "c", title: "C", location: "src/C.sol:1", severity: "high", status: "suspected" },
      ]);
    } finally {
      store.close();
    }

    const page = await json(await fetch(base + "/api/bugs?limit=2&offset=1"));
    assert.equal(page.total, 3);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.equal(page.findings.length, 2);
    assert.equal(page.stats.total, 3);

    const confirmed = await json(await fetch(base + "/api/bugs?status=execution-confirmed&limit=1"));
    assert.equal(confirmed.total, 1);
    assert.equal(confirmed.findings[0].status, "confirmed-executable");
    assert.equal(confirmed.stats.total, 3, "saved-view stats remain global when the table is filtered");
    assert.equal(confirmed.stats.byStatus.suspected, 2);
  });
});

test("api: global findings endpoint filters by project and scopes stats", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const alpha = await json(await post("/api/projects", { name: "global-finding-alpha", sourcePaths: ["./src"] }));
    const beta = await json(await post("/api/projects", { name: "global-finding-beta", sourcePaths: ["./src"] }));
    const alphaRunDir = await mkdtemp(path.join(out, "global-finding-alpha-run-"));
    const betaRunDir = await mkdtemp(path.join(out, "global-finding-beta-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const alphaRunId = store.startRun({ projectId: alpha.id, kind: "audit", runDir: alphaRunDir });
      store.upsertFindings(alpha.id, alphaRunId, [
        { findingKey: "alpha-a", title: "Alpha A", location: "src/A.sol:1", severity: "low", status: "suspected" },
        { findingKey: "alpha-b", title: "Alpha B", location: "src/B.sol:1", severity: "medium", status: "confirmed-executable" },
      ]);
      const betaRunId = store.startRun({ projectId: beta.id, kind: "audit", runDir: betaRunDir });
      store.upsertFindings(beta.id, betaRunId, [
        { findingKey: "beta-a", title: "Beta A", location: "src/A.sol:1", severity: "high", status: "suspected" },
      ]);
    } finally {
      store.close();
    }

    const scoped = await json(await fetch(base + `/api/bugs?project=${encodeURIComponent(alpha.uuid)}`));
    assert.equal(scoped.total, 2);
    assert.equal(scoped.stats.total, 2);
    assert.equal(scoped.stats.byStatus.suspected, 1);
    assert.equal(scoped.stats.byStatus["confirmed-executable"], 1);
    assert.deepEqual(scoped.findings.map((finding) => finding.project_uuid), [alpha.uuid, alpha.uuid]);

    const confirmed = await json(await fetch(base + `/api/bugs?project=${encodeURIComponent(alpha.uuid)}&status=execution-confirmed`));
    assert.equal(confirmed.total, 1);
    assert.equal(confirmed.findings[0].finding_key, "alpha-b");
    assert.equal(confirmed.stats.total, 2, "saved-view stats stay scoped to the selected project");
  });
});

test("api: duplicate findings from different scopes collapse to one user-facing bug", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-dedupe", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-dedupe-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "scope-a-bug",
          title: "Assigned L1 block number is not bound to the proof",
          location: "src/Rollup.sol:254",
          severity: "high",
          status: "suspected",
          scopeId: "SCOPE-A",
          confidence: 0.7,
          evidence: "first scope",
        },
        {
          findingKey: "scope-b-bug",
          title: "Assigned L1 block number is not bound to the proof",
          location: "src/Rollup.sol:254",
          severity: "high",
          status: "confirmed-executable",
          scopeId: "SCOPE-B",
          confidence: 0.95,
          evidence: "stronger executable proof",
        },
      ]);
    } finally {
      store.close();
    }

    const projectPath = "/api/projects/" + created.uuid;
    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.findingsTotal, 1);
    assert.deepEqual(detail.statusCounts, { "confirmed-executable": 1 });
    assert.equal(detail.auditConfirmedFindings, 1);
    assert.equal(detail.reproducedBugs, 0);
    assert.equal(detail.allFindings[0].status, "confirmed-executable");
    assert.equal(detail.allFindings[0].scope_id, "SCOPE-B");

    const findings = await json(await fetch(base + projectPath + "/findings"));
    assert.equal(findings.total, 1);
    assert.equal(findings.findings[0].status, "confirmed-executable");
    assert.equal(findings.findings[0].evidence, "stronger executable proof");
    const confirmedFindings = await json(await fetch(base + projectPath + "/findings?status=execution-confirmed"));
    assert.equal(confirmedFindings.total, 1);
    assert.equal(confirmedFindings.findings[0].status, "confirmed-executable");

    const bugs = await json(await fetch(base + "/api/bugs"));
    assert.equal(bugs.stats.total, 1);
    assert.equal(bugs.findings[0].status, "confirmed-executable");
    const confirmedBugs = await json(await fetch(base + "/api/bugs?status=execution-confirmed"));
    assert.equal(confirmedBugs.stats.total, 1);
    assert.equal(confirmedBugs.findings[0].status, "confirmed-executable");
  });
});

test("api: verified duplicates hide older suspected candidates at the same scope and location", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-verified-dedupe", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-verified-dedupe-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "suspected-normalize",
          title: "Native verifier silently normalizes non-canonical public input words",
          location: "src/bbapi_shared.hpp:233",
          severity: "medium",
          status: "suspected",
          scopeId: "BB-PROOF",
          confidence: 0.82,
        },
        {
          findingKey: "confirmed-normalize",
          title: "Native verifier accepts non-canonical field words by normalizing uint256_t",
          location: "src/bbapi_shared.hpp:233",
          severity: "medium",
          status: "confirmed-executable",
          scopeId: "BB-PROOF",
          confidence: 0.96,
        },
        {
          findingKey: "same-line-distinct",
          title: "Governance action list stays mutable after approval",
          location: "src/bbapi_shared.hpp:233",
          severity: "medium",
          status: "suspected",
          scopeId: "BB-PROOF",
          confidence: 0.75,
        },
      ]);
    } finally {
      store.close();
    }

    const projectPath = "/api/projects/" + created.uuid;
    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.findingsTotal, 2);
    assert.deepEqual(detail.allFindings.map((finding) => finding.finding_key).sort(), ["confirmed-normalize", "same-line-distinct"].sort());
    assert.deepEqual(detail.statusCounts, { "confirmed-executable": 1, suspected: 1 });

    const findings = await json(await fetch(base + projectPath + "/findings"));
    assert.equal(findings.total, 2);
    assert.deepEqual(findings.findings.map((finding) => finding.finding_key).sort(), ["confirmed-normalize", "same-line-distinct"].sort());
  });
});

test("api: strongly related suspected duplicates hide behind confirmed findings", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-related-dedupe", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-related-dedupe-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.upsertFindings(created.id, runId, [
        {
          findingKey: "confirmed-bytecode-length",
          title: "Contract class id does not bind the exact public bytecode length",
          location: "noir/contracts/protocol/contract_class_registry/src/main.nr:54",
          severity: "high",
          status: "confirmed-executable",
          scopeId: "CLASS-REGISTRY",
          confidence: 0.95,
        },
        {
          findingKey: "suspected-bytecode-length",
          title: "Public bytecode class IDs do not bind the exact byte length",
          location: "yarn-project/protocol-contracts/src/class-registry/contract_class_published_event.ts:49",
          severity: "medium",
          status: "suspected",
          scopeId: "EVENT-PARSER",
          confidence: 0.78,
        },
        {
          findingKey: "distinct-bytecode",
          title: "Public bytecode parser accepts malformed function selectors",
          location: "yarn-project/protocol-contracts/src/class-registry/contract_class_published_event.ts:92",
          severity: "medium",
          status: "suspected",
          scopeId: "EVENT-PARSER",
          confidence: 0.8,
        },
      ]);
    } finally {
      store.close();
    }

    const projectPath = "/api/projects/" + created.uuid;
    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.findingsTotal, 2);
    assert.deepEqual(detail.allFindings.map((finding) => finding.finding_key).sort(), ["confirmed-bytecode-length", "distinct-bytecode"].sort());
    assert.deepEqual(detail.statusCounts, { "confirmed-executable": 1, suspected: 1 });

    const findings = await json(await fetch(base + projectPath + "/findings"));
    assert.equal(findings.total, 2);
    assert.deepEqual(findings.findings.map((finding) => finding.finding_key).sort(), ["confirmed-bytecode-length", "distinct-bytecode"].sort());

    const bugs = await json(await fetch(base + "/api/bugs"));
    assert.equal(bugs.stats.total, 2);
    assert.deepEqual(bugs.findings.map((finding) => finding.finding_key).sort(), ["confirmed-bytecode-length", "distinct-bytecode"].sort());
  });
});

test("api: user-facing finding titles do not expose model status prefixes", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "finding-title-cleanup", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "finding-title-cleanup-run-"));
    const store = MetadataStore.openForOutput(out);
    try {
      const runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.upsertFindings(created.id, runId, [
        { findingKey: "unmet", title: "UNMET: public input count is not bound", location: "src/Rollup.sol:44", severity: "high", status: "suspected", evidence: "raw title kept in DB evidence path" },
      ]);
    } finally {
      store.close();
    }

    const projectPath = "/api/projects/" + created.uuid;
    const detail = await json(await fetch(base + projectPath));
    assert.equal(detail.allFindings[0].title, "public input count is not bound");

    const findings = await json(await fetch(base + projectPath + "/findings"));
    assert.equal(findings.findings[0].title, "public input count is not bound");
    assert.equal(findings.findings[0].evidence, "raw title kept in DB evidence path");

    const bugs = await json(await fetch(base + "/api/bugs"));
    assert.equal(bugs.findings[0].title, "public input count is not bound");
  });
});

test("api: run log supports a bounded JSON tail for agents", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "log-tail", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "log-tail-run-"));
    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      runId = store.startRun({ projectId: created.id, kind: "run", runDir });
    } finally {
      store.close();
    }
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({
      ts: "2026-06-22T08:12:50.000Z",
      kind: "audit_command_run",
      runId: "cmd23",
      purpose: "confirm",
      passed: false,
      exitCode: 127,
      output: "docker: Error response from daemon: exec: \"forge\": executable file not found in $PATH.",
    })}\n`);

    const res = await fetch(base + `/api/runs/${runId}/log?tail=50`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.runId, runId);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].kind, "audit_command_run");
    assert.equal(body.events[0].runId, "cmd23");
    assert.equal(body.events[0].passed, false);
    assert.equal(body.events[0].exitCode, 127);
    assert.match(body.events[0].output, /forge/);
    assert.equal(body.limit, 50);
  });
});

test("api: active jobs recover last activity from persisted run logs", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "active-persisted-activity", sourcePaths: ["./src"] }));
    const runDir = path.join(out, "active-persisted-activity-run");
    const oldActivity = "2000-01-01T00:00:00.000Z";
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({ ts: oldActivity, kind: "audit_action", detail: "persisted after server restart" })}\n`,
    );

    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      const jobId = store.enqueueJob(created.name, { verb: "prepare" });
      runId = store.startRun({ projectId: created.id, kind: "prepare", runDir });
      store.setJobRun(jobId, runId);
    } finally {
      store.close();
    }

    const active = await json(await fetch(base + "/api/active"));
    const row = active.active.find((entry) => entry.target === created.name);
    assert.equal(row.lastActivityAt, oldActivity);
    assert.ok(row.updatedAt >= row.lastActivityAt);
    assert.equal(row.staleActivity, true);
    assert.ok(row.inactiveSeconds > 15 * 60);

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    assert.equal(detail.runs[0].last_activity_at, oldActivity);
    assert.equal(detail.runs[0].stale_activity, true);
    assert.ok(detail.runs[0].inactive_seconds > 15 * 60);

    const single = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(single.run.last_activity_at, oldActivity);
    assert.equal(single.run.stale_activity, true);
  });
});

test("api: daemon heartbeats keep held stale jobs active", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body, token) => fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const daemon = await json(await post("/api/daemons", { name: "heartbeat-held" }));
    const created = await json(await post("/api/projects", { name: "heartbeat-held-project", sourcePaths: ["./src"], daemonId: daemon.id }));
    const runDir = path.join(out, "heartbeat-held-run");
    const oldActivity = "2000-01-01T00:00:00.000Z";
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ ts: oldActivity, kind: "audit_action", detail: "long model call" })}\n`);

    let jobId;
    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      jobId = store.enqueueJob(created.name, { verb: "run" }, daemon.id);
      runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.setJobRun(jobId, runId);
    } finally {
      store.close();
    }

    const heartbeat = await json(await post("/api/daemon/heartbeat", { instanceId: "held-worker", activeJobIds: [jobId] }, daemon.token));
    assert.equal(heartbeat.reconciled, 0);
    const active = await json(await fetch(base + "/api/active"));
    const row = active.active.find((entry) => entry.jobId === jobId);
    assert.equal(row.status, "running");
    assert.equal(row.lastActivityAt, oldActivity);
    assert.equal(row.staleActivity, true);
    assert.equal(row.blockedReason, undefined);
    assert.equal(row.onlineDaemons, 1);

    const single = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(single.run.status, "running");
  });
});

test("api: recently seen daemons without heartbeat do not lose stale jobs", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const daemon = await json(await post("/api/daemons", { name: "recent-no-heartbeat" }));
    const created = await json(await post("/api/projects", { name: "recent-no-heartbeat-project", sourcePaths: ["./src"], daemonId: daemon.id }));
    const runDir = path.join(out, "recent-no-heartbeat-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", kind: "audit_action", detail: "server just restarted" })}\n`);

    let jobId;
    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      store.touchDaemon(daemon.id);
      jobId = store.enqueueJob(created.name, { verb: "run" }, daemon.id);
      runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.setJobRun(jobId, runId);
    } finally {
      store.close();
    }

    const active = await json(await fetch(base + "/api/active"));
    const row = active.active.find((entry) => entry.jobId === jobId);
    assert.equal(row.status, "running");
    assert.equal(row.staleActivity, true);

    const single = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(single.run.status, "running");
  });
});

test("api: stale jobs not held by daemon heartbeat are reconciled automatically", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body, token) => fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const daemon = await json(await post("/api/daemons", { name: "heartbeat-unheld" }));
    const created = await json(await post("/api/projects", { name: "heartbeat-unheld-project", sourcePaths: ["./src"], daemonId: daemon.id }));
    const runDir = path.join(out, "heartbeat-unheld-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", kind: "audit_action", detail: "executor lost it" })}\n`);

    let jobId;
    let runId;
    let store = MetadataStore.openForOutput(out);
    try {
      jobId = store.enqueueJob(created.name, { verb: "run" }, daemon.id);
      runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.setJobRun(jobId, runId);
    } finally {
      store.close();
    }

    const heartbeat = await json(await post("/api/daemon/heartbeat", { instanceId: "unheld-worker", activeJobIds: [] }, daemon.token));
    assert.equal(heartbeat.reconciled, 1);
    const active = await json(await fetch(base + "/api/active"));
    assert.equal(active.active.some((entry) => entry.jobId === jobId), false);

    store = MetadataStore.openForOutput(out);
    try {
      assert.equal(store.getJob(jobId).status, "canceled");
      assert.equal(store.getJob(jobId).error, "executor no longer holds this job");
      assert.equal(store.getRun(runId).status, "killed");
    } finally {
      store.close();
    }
  });
});

test("api: empty killed runs do not replace the latest material project snapshot", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "latest-material-run", sourcePaths: ["./src"] }));
    let doneRunId;
    let emptyKilledRunId;
    const store = MetadataStore.openForOutput(out);
    try {
      doneRunId = store.startRun({ projectId: created.id, kind: "run", runDir: path.join(out, "latest-material-done") });
      store.updateRunScopes(doneRunId, 30, 30);
      store.finishRun(doneRunId, "done", { total: 30, audited: 30, pending: 0 }, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emptyKilledRunId = store.startRun({ projectId: created.id, kind: "run", runDir: path.join(out, "latest-material-empty-killed") });
      store.finishRun(emptyKilledRunId, "killed");
    } finally {
      store.close();
    }

    const list = await json(await fetch(base + "/api/projects"));
    const row = list.projects.find((project) => project.uuid === created.uuid);
    assert.equal(row.latestRun.id, doneRunId);
    assert.equal(row.latestRun.status, "done");

    const failed = await json(await fetch(base + "/api/projects?status=failed"));
    assert.equal(failed.projects.some((project) => project.uuid === created.uuid), false);

    const single = await json(await fetch(base + `/api/runs/${emptyKilledRunId}`));
    assert.equal(single.run.status, "killed");
  });
});

test("api: run rows include job error summaries", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "run-error-summary", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "run-error-summary-"));
    const store = MetadataStore.openForOutput(out);
    let runId;
    try {
      const jobId = store.enqueueJob("run-error-summary", { verb: "audit" });
      runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.setJobRun(jobId, runId);
      store.setJobStatus(jobId, "error", "sandbox image flounder-sandbox:latest is missing");
      store.finishRun(runId, "error");
    } finally {
      store.close();
    }

    const list = await json(await fetch(base + `/api/projects/${created.uuid}/runs`));
    assert.equal(list.runs[0].job_status, "error");
    assert.equal(list.runs[0].job_error, "sandbox image flounder-sandbox:latest is missing");

    const single = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(single.run.job_status, "error");
    assert.equal(single.run.job_error, "sandbox image flounder-sandbox:latest is missing");
  });
});

test("api: successful run rows suppress late job errors", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = await json(await post("/api/projects", { name: "run-late-job-error", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "run-late-job-error-"));
    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      const jobId = store.enqueueJob("run-late-job-error", { verb: "audit" });
      runId = store.startRun({ projectId: created.id, kind: "audit", runDir });
      store.setJobRun(jobId, runId);
      store.finishRun(runId, "done");
      store.setJobStatus(jobId, "error", "post-run history sync failed");
    } finally {
      store.close();
    }

    const list = await json(await fetch(base + `/api/projects/${created.uuid}/runs`));
    assert.equal(list.runs[0].status, "done");
    assert.equal(list.runs[0].job_status, "error");
    assert.equal(list.runs[0].job_error, undefined);

    const single = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(single.run.status, "done");
    assert.equal(single.run.job_status, "error");
    assert.equal(single.run.job_error, undefined);
  });
});

test("api: run scope target adjustment only applies to running runs", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const patch = (p, body) => fetch(base + p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "adjust-run", sourcePaths: ["./src"] }));
    const runDir = await mkdtemp(path.join(out, "adjust-run-"));
    let runId;
    const store = MetadataStore.openForOutput(out);
    try {
      runId = store.startRun({ projectId: created.id, kind: "run", runDir });
      store.updateRunScopes(runId, 0, 30);
      store.finishRun(runId, "killed");
    } finally {
      store.close();
    }

    const res = await patch(`/api/runs/${runId}`, { runScopesTarget: 5 });
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /running/);
    const run = await json(await fetch(base + `/api/runs/${runId}`));
    assert.equal(run.run.run_scopes_target, 30);
  });
});

test("api: daemon lists return provider-auth summaries by default", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const created = await json(await fetch(base + "/api/daemons", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "worker-a" }) }));
    await fetch(base + "/api/daemon/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.token}` },
      body: JSON.stringify({
        workspace: "/tmp/flounder-worker",
        capabilities: {
          providers: [
            { provider: "openai-codex", configured: true, required: true, oauthLogin: true, expectedEnvVars: ["SHOULD_NOT_BE_DEFAULT"] },
            { provider: "anthropic", configured: false, required: true, oauthLogin: true, expectedEnvVars: ["ANTHROPIC_API_KEY"] },
          ],
        },
      }),
    });

    const summary = await json(await fetch(base + "/api/daemons"));
    assert.equal(summary.daemons[0].capabilities.configuredProviderCount, 1);
    assert.deepEqual(summary.daemons[0].capabilities.providers[0], { provider: "openai-codex", configured: true, required: true, oauthLogin: true });
    assert.equal(JSON.stringify(summary).includes("SHOULD_NOT_BE_DEFAULT"), false);

    const raw = await json(await fetch(base + "/api/daemons?include=capabilities"));
    assert.equal(JSON.stringify(raw).includes("SHOULD_NOT_BE_DEFAULT"), true);
  });
});

test("api: provider profiles — seed + CRUD + per-phase roles; pi discovery", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // a fresh store is seeded with starter profiles
    const seeded = (await json(await fetch(base + "/api/providers"))).providers;
    assert.ok(seeded.length >= 1 && seeded.some((p) => p.provider === "openai-codex"), "expected seeded providers");
    const codexDefault = seeded.find((p) => p.name === "openai-codex · gpt-5.5 · xhigh");
    assert.ok(codexDefault, "expected codex gpt-5.5 xhigh starter profile");
    assert.equal(codexDefault.provider, "openai-codex");
    assert.equal(codexDefault.model, "gpt-5.5");
    assert.equal(codexDefault.thinking, "xhigh");
    const opusMax = seeded.find((p) => p.name === "claude-code · opus 4.8 max");
    assert.ok(opusMax, "expected opus 4.8 max starter profile");
    assert.equal(opusMax.provider, "claude-code");
    assert.equal(opusMax.model, "claude-opus-4-8");
    assert.equal(opusMax.thinking, "xhigh");

    // discovery: pi-ai's provider list (+ CLI fallbacks) and a provider's models
    const avail = (await json(await fetch(base + "/api/pi/providers"))).providers;
    assert.ok(avail.includes("openai-codex") && avail.includes("claude-code") && avail.includes("mock"));
    const discoveredModels = (await json(await fetch(base + "/api/pi/models/openai-codex"))).models;
    assert.ok(discoveredModels.length >= 1, "expected pi model discovery");
    assert.ok(discoveredModels.every((m) => Array.isArray(m.thinkingLevels) && m.thinkingLevels.length >= 1));
    const gpt55 = discoveredModels.find((m) => m.id === "gpt-5.5");
    if (gpt55) assert.ok(gpt55.thinkingLevels.includes("xhigh"), "gpt-5.5 should expose xhigh through pi metadata");

    // create with a per-phase override (map cheaper than dig), then read it back
    const created = await json(await post("/api/providers", { name: "prof-x", provider: "openai-codex", model: "gpt-5.5", thinking: "high", roles: { map: { thinking: "low" } } }));
    assert.ok(created.ok && typeof created.id === "number");
    assert.equal((await post("/api/providers", { name: "prof-x", provider: "x" })).status, 409); // duplicate name

    const got = (await json(await fetch(base + "/api/providers/" + created.id))).provider;
    assert.equal(got.provider, "openai-codex");
    assert.equal(got.roles.map.thinking, "low");

    // update + delete
    await fetch(base + "/api/providers/" + created.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ thinking: "off" }) });
    assert.equal((await json(await fetch(base + "/api/providers/" + created.id))).provider.thinking, "off");
    await fetch(base + "/api/providers/" + created.id, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ thinking: "xhigh" }) });
    assert.equal((await json(await fetch(base + "/api/providers/" + created.id))).provider.thinking, "xhigh");
    assert.equal((await fetch(base + "/api/providers/" + created.id, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(base + "/api/providers/" + created.id)).status, 404);
  });
});

test("api: non-loopback control plane requires operator bearer auth", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-api-auth-"));
  assert.throws(() => startUiServer({ port: 0, out, host: "0.0.0.0" }), /operator auth/);

  const server = startUiServer({ port: 0, out, host: "0.0.0.0", operatorToken: "secret" });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + "/api")).status, 401);
    const ok = await fetch(base + "/api", { headers: { authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).name, "flounder");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
