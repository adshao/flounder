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
      "GET /api/projects", "POST /api/projects", "GET /api/projects/:uuid",
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
    const projectRun = cat.endpoints.find((e) => e.method === "POST" && e.path === "/api/projects/:uuid/runs");
    assert.match(projectRun.body.verb, /report/);
    assert.match(projectRun.body.scopeCoverageMode, /one-off coverage mode/);
    assert.match(projectRun.body.maxScopes, /one-off scope cap/);
    assert.match(projectRun.body.mapSteps, /one-off map turn cap/);
    assert.match(projectRun.body.digSteps, /one-off per-scope dig turn cap/);
    assert.match(projectRun.body.verifyFindings, /original row/);
    assert.match(projectRun.body.allowMaterialDrift, /expert override/);
    assert.match(projectRun.body.findingIds, /formal reports/);
    const scopePatch = cat.endpoints.find((e) => e.method === "PATCH" && e.path === "/api/projects/:uuid/scopes/:scopeId");
    assert.match(scopePatch.summary, /top of the next auto-dig batch/i);
    assert.match(scopePatch.body.prioritize, /top/i);
    const projectScopes = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects/:uuid/scopes");
    assert.match(projectScopes.query.limit, /default 50/);
    assert.match(projectScopes.query.offset, /default 0/);
    const projectFindings = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/projects/:uuid/findings");
    assert.match(projectFindings.query.status, /execution-confirmed/);
    const globalFindings = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/bugs");
    assert.match(globalFindings.summary, /execution-confirmed/);
    assert.match(globalFindings.query.limit, /default 200/);
    const runLog = cat.endpoints.find((e) => e.method === "GET" && e.path === "/api/runs/:id/log");
    assert.match(runLog.query.tail, /JSON/);
  });
});

test("api: project run defaults leave map/dig turns unbounded while standard coverage caps the batch", async () => {
  await withServer(async (base) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", {
      name: "default-run-budget",
      sourcePaths: ["./src"],
      config: { scopeCoverageMode: "standard" },
    }));

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

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

    assert.equal(spec.coverageMode, "standard");
    assert.equal(spec.coverageTarget, 30);
    assert.equal(spec.maxScopes, 10);
  });
});

test("api: standard coverage stops default runs after 30 audited scopes but allows explicit scopes", async () => {
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

    const stopped = await post(`/api/projects/${created.uuid}/runs`, { verb: "run" });
    assert.equal(stopped.status, 409);
    const stoppedBody = await json(stopped);
    assert.match(stoppedBody.error, /Standard coverage is already complete/);
    assert.equal(stoppedBody.coverageTarget, 30);

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
      const prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "verify-material-drift-prepare") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepareRun);
      store.finishRun(prepareRun, "done");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    const finding = detail.allFindings[0];
    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", verifyFindings: [finding] });
    assert.equal(rejected.status, 409);
    const rejectedBody = await json(rejected);
    assert.equal(rejectedBody.materialDrift, true);
    assert.equal(rejectedBody.findings[0].findingId, finding.id);
    assert.match(rejectedBody.error, /newer Prepare run/);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, {
      verb: "audit",
      verifyFindings: [finding],
      allowMaterialDrift: true,
    }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.equal(spec.verifyFindings[0].originId, finding.id);
  });
});

test("api: verify launch treats killed newer prepare as material drift", async () => {
  await withServer(async (base, out) => {
    const json = (r) => r.json();
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await json(await post("/api/projects", { name: "verify-killed-material-drift", sourcePaths: ["./src"] }));
    const store = MetadataStore.openForOutput(out);
    let prepareRun;
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
      prepareRun = store.startRun({ projectId: created.id, kind: "prepare", runDir: path.join(out, "verify-killed-material-drift-prepare") });
      store.db.prepare("UPDATE run SET started_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", prepareRun);
      store.finishRun(prepareRun, "killed");
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + `/api/projects/${created.uuid}`));
    const finding = detail.allFindings[0];
    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "audit", verifyFindings: [finding] });
    assert.equal(rejected.status, 409);
    const rejectedBody = await json(rejected);
    assert.equal(rejectedBody.materialDrift, true);
    assert.equal(rejectedBody.findings[0].findingId, finding.id);
    assert.equal(rejectedBody.findings[0].prepareRunId, prepareRun);
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
    assert.ok(ready);
    assert.ok(dropped);

    const launched = await json(await post(`/api/projects/${created.uuid}/runs`, { verb: "report" }));
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);

    assert.equal(spec.verb, "report");
    assert.equal(spec.reportFindings.length, 1);
    assert.equal(spec.reportFindings[0].findingKey, "kready");
    assert.equal(spec.reportFindings[0].decisions[0].repro_command_id, "cmd1");
    assert.match(spec.reportFindings[0].decisions[0].repro_evidence, /real target effect/);

    const rejected = await post(`/api/projects/${created.uuid}/runs`, { verb: "report", findingIds: [dropped.id] });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /not reproduced on the real target|dropped/);
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
    assert.deepEqual(spec.sourcePaths, [workspace]);
    assert.equal(spec.buildRoot, workspace);
    assert.equal(spec.dir, undefined);
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
      ]);
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
    assert.deepEqual(confirmSpec.confirmKeys, ["confirmed-bug"]);
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
      ]),
    );

    const store = MetadataStore.openForOutput(out);
    try {
      store.startRun({ projectId: created.id, kind: "run", runDir });
    } finally {
      store.close();
    }

    const detail = await json(await fetch(base + projectPath));
    assert.deepEqual(detail.progress, { total: 2, audited: 0, deferred: 1, pending: 1 });
    assert.equal(detail.scopes.length, 2);
    assert.equal(detail.scopes[0].scope_id, "S1");
    assert.equal(detail.scopes[0].title, "Bind value balance to proof public inputs.");
    assert.equal(detail.scopes[0].obligation, "Bind value balance to proof public inputs.");
    assert.equal(detail.scopes[0].region, "src/A.sol:1-40");

    const scopes = await json(await fetch(base + projectPath + "/scopes"));
    assert.deepEqual(scopes.progress, detail.progress);
    assert.equal(scopes.scopes.length, 2);
    assert.equal(scopes.scopes[1].obligation, "Replay guard");
    assert.equal(scopes.scopes[1].region, "src/B.sol:1-30");
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
        { findingKey: "b", title: "B", location: "src/B.sol:1", severity: "medium", status: "suspected", evidence: "detail-b" },
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
