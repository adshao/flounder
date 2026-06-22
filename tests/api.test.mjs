import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";
import { MetadataStore } from "../dist/db/store.js";

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
    assert.match(projectRun.body.scopeCoverageMode, /one-off coverage mode/);
    assert.match(projectRun.body.maxScopes, /one-off scope cap/);
    assert.match(projectRun.body.mapSteps, /one-off map turn cap/);
    assert.match(projectRun.body.digSteps, /one-off per-scope dig turn cap/);
    assert.match(projectRun.body.verifyFindings, /original row/);
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
        components: [
          {
            id: "target",
            name: "Target",
            type: "source_repo",
            path: "src/Target.sol",
            origin: { url: "https://example.invalid/repo.git", commit: "abc123" },
            in_scope: true,
            deployment_match: { status: "n/a" },
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
    assert.deepEqual(detail.prepareSummary.issues, []);

    const artifact = await fetch(base + `/api/runs/${detail.prepareSummary.runId}/artifact?name=prepare_manifest.json`);
    assert.equal(artifact.status, 200);
    assert.equal((await artifact.text()).includes("official source only"), true);

    const launched = await json(await post(projectPath + "/runs", { verb: "run" }));
    assert.equal(launched.queued, true);
    const job = (await json(await fetch(base + "/api/jobs/" + launched.jobId))).job;
    const spec = JSON.parse(job.spec_json);
    assert.deepEqual(spec.sourcePaths, [workspace]);
    assert.equal(spec.buildRoot, workspace);
    assert.equal(spec.dir, undefined);
    assert.match(spec.scopeNote, /PRIMARY AUDIT TARGET/);
  });
});

test("api: unresolved prepare manifest status is surfaced as a review issue", async () => {
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
    assert.equal(detail.prepareSummary.manifestState, "in_progress");
    assert.deepEqual(detail.prepareSummary.gaps, ["deployment-artifacts-unresolved: Live deployment artifacts are still being resolved."]);
    assert.match(detail.prepareSummary.issues.join("\n"), /prepare manifest status is in_progress/);
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

test("api: terminal prepare runs display stale in-progress manifests as partial", async () => {
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
    assert.equal(detail.prepareSummary.manifestState, "partial");
    assert.deepEqual(detail.prepareSummary.gaps, ["deployment-artifacts-unresolved: Live deployment artifacts are still being resolved."]);
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

    const res = await fetch(base + `/api/runs/${runId}/log?tail=50`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.runId, runId);
    assert.deepEqual(body.events, []);
    assert.equal(body.limit, 50);
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
