import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startUiServer } from "../dist/server/app.js";
import { ensureDaemonDirectories } from "../dist/server/daemon.js";
import { MetadataStore } from "../dist/db/store.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

// Execution is decoupled: the server owns the DB + a job queue and never runs an audit;
// a daemon claims queued jobs, runs them elsewhere, and reports progress over HTTP. These
// drive the server as BOTH the UI client (public API) and a simulated daemon (the hidden
// /api/daemon/* protocol), pinning the whole handoff without spawning a real audit.

async function withServerAndToken(fn) {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-daemon-"));
  // Simulate `flounder server daemon-token mint` without going through the CLI.
  // The UI server and remote daemons both use these control-plane tokens.
  const minting = MetadataStore.openForOutput(out);
  const { token } = minting.createDaemonToken("test-daemon");
  minting.close();

  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, token, out });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withServer(out, fn) {
  const server = startUiServer({ port: 0, out, host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const j = (r) => r.json();
const ui = (base, method, p, body) => fetch(base + p, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const asDaemon = (base, token, method, p, body) =>
  fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("daemon: startup creates the reported product home and workspace directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-daemon-dirs-"));
  const out = path.join(root, "home");
  const workspace = path.join(root, "home", "workspace");

  await ensureDaemonDirectories(out, workspace);

  assert.equal((await stat(out)).isDirectory(), true);
  assert.equal((await stat(workspace)).isDirectory(), true);
});

test("daemon: register requires a valid bearer token", async () => {
  await withServerAndToken(async ({ base, token }) => {
    assert.equal((await fetch(base + "/api/daemon/register", { method: "POST" })).status, 401); // no token
    assert.equal((await asDaemon(base, "deadbeef", "POST", "/api/daemon/register")).status, 401); // wrong token
    const ok = await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1", capabilities: {} });
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).ok, true);
    // claim/run/activity/status all reject an unknown token too
    assert.equal((await fetch(base + "/api/daemon/claim", { method: "POST" })).status, 401);
  });
});

test("daemon: CLI daemon-token mint uses the server API when --server is passed", async () => {
  await withServerAndToken(async ({ base }) => {
    const { stdout } = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), "server", "daemon-token", "mint", "cli-remote", "--server", base], { cwd: root });

    assert.match(stdout, /\[daemon \d+\] cli-remote/);
    assert.match(stdout, new RegExp(`flounder daemon start --server ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --token [a-f0-9]+`));

    const daemons = await j(await ui(base, "GET", "/api/daemons"));
    assert.equal(daemons.daemons.some((daemon) => daemon.name === "cli-remote"), true);
  });
});

test("daemon: remote executor restart reuses token identity and claims pinned backlog", async () => {
  await withServerAndToken(async ({ base, token }) => {
    const reg = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "remote-1" }));
    const daemonId = reg.daemonId;
    const created = await j(await ui(base, "POST", "/api/projects", { name: "remote-pinned", daemonId, sourcePaths: ["."], buildRoot: "." }));

    // A project pinned to an offline daemon fails loudly by default instead of creating
    // a queued job that no connected daemon can claim.
    const offline = await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true });
    assert.equal(offline.status, 409);

    const launched = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true, allowOfflineQueue: true }));
    assert.equal(launched.daemonId, daemonId);
    assert.equal(launched.daemons, 0);

    // Restarting the daemon with the SAME token keeps the same daemon row/id and drains
    // the backlog pinned to that id.
    const regAgain = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "remote-1-restarted" }));
    assert.equal(regAgain.daemonId, daemonId);
    const claim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, launched.jobId);
    assert.equal(claim.job.project, "remote-pinned");
  });
});

test("daemon: split server restart preserves remote daemon backlog", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-split-restart-"));
  const minting = MetadataStore.openForOutput(out);
  const { token } = minting.createDaemonToken("split-daemon");
  minting.close();

  let daemonId;
  let jobId;
  await withServer(out, async (base) => {
    const reg = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "split-remote-1" }));
    daemonId = reg.daemonId;
    const created = await j(await ui(base, "POST", "/api/projects", { name: "split-pinned", daemonId, sourcePaths: ["."], buildRoot: "." }));
    const launch = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true, allowOfflineQueue: true }));
    assert.equal(launch.daemonId, daemonId);
    jobId = launch.jobId;
  });

  // The control-plane process is back with the same DB, but the executor is a
  // separate process. Re-registering with the same minted token must keep the
  // daemon id and make pre-restart queued work claimable.
  await withServer(out, async (base) => {
    const regAgain = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "split-remote-1-reconnected" }));
    assert.equal(regAgain.daemonId, daemonId);
    const claim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, jobId);
    assert.equal(claim.job.project, "split-pinned");
  });
});

test("daemon: local auto-executor identity survives same-machine UI restart", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-local-restart-"));
  const store = MetadataStore.openForOutput(out);
  const local = store.getOrCreateLocalDaemonToken();
  store.close();

  let jobId;
  await withServer(out, async (base) => {
    const created = await j(await ui(base, "POST", "/api/projects", { name: "local-pinned", daemonId: local.id, sourcePaths: ["."], buildRoot: "." }));
    const rejected = await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true });
    assert.equal(rejected.status, 409);
    const launch = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true, allowOfflineQueue: true }));
    assert.equal(launch.daemonId, local.id);
    assert.equal(launch.daemons, 0);
    jobId = launch.jobId;
  });

  // This is what `flounder ui` does on the same machine before spawning its child
  // daemon. It must pick the same local daemon id/token, not mint local-${pid}.
  const afterRestartStore = MetadataStore.openForOutput(out);
  const localAgain = afterRestartStore.getOrCreateLocalDaemonToken();
  afterRestartStore.close();
  assert.equal(localAgain.id, local.id);
  assert.equal(localAgain.token, local.token);

  await withServer(out, async (base) => {
    const reg = await j(await asDaemon(base, localAgain.token, "POST", "/api/daemon/register", { name: "local-restarted" }));
    assert.equal(reg.daemonId, local.id);
    const claim = await j(await asDaemon(base, localAgain.token, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, jobId);
    assert.equal(claim.job.project, "local-pinned");
  });
});

test("daemon: project run uses configured source before prepare clues", async () => {
  await withServerAndToken(async ({ base, token }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });

    const sourceProject = await j(await ui(base, "POST", "/api/projects", {
      name: "source-first",
      sourcePaths: ["./src"],
      buildRoot: ".",
      config: {
        projectIntent: "Audit the configured source",
        prepareClue: "https://example.invalid/should-not-prepare",
      },
    }));
    const sourceLaunch = await j(await ui(base, "POST", `/api/projects/${sourceProject.uuid}/runs`, { verb: "run", mockLlm: true }));
    const sourceClaim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));

    assert.equal(sourceClaim.job.id, sourceLaunch.jobId);
    assert.equal(sourceClaim.job.spec.verb, "run");
    assert.equal(sourceClaim.job.spec.pipeline, false);
    assert.equal(sourceClaim.job.spec.clue, undefined);
    assert.deepEqual(sourceClaim.job.spec.sourcePaths, ["./src"]);
    assert.equal(sourceClaim.job.spec.scopeNote, "Audit the configured source");

    const clueProject = await j(await ui(base, "POST", "/api/projects", {
      name: "clue-only",
      config: { prepareClue: "https://github.com/example/project" },
    }));
    const clueLaunch = await j(await ui(base, "POST", `/api/projects/${clueProject.uuid}/runs`, { verb: "run", mockLlm: true }));
    const clueClaim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));

    assert.equal(clueClaim.job.id, clueLaunch.jobId);
    assert.equal(clueClaim.job.spec.verb, "run");
    assert.equal(clueClaim.job.spec.pipeline, true);
    assert.equal(clueClaim.job.spec.clue, "https://github.com/example/project");
    assert.deepEqual(clueClaim.job.spec.sourcePaths, []);
  });
});

test("daemon: full job handoff — enqueue → claim → run start → ingest → finish", async () => {
  await withServerAndToken(async ({ base, token }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });

    // UI creates a project and queues a run.
    const created = await j(await ui(base, "POST", "/api/projects", { name: "acme", sourcePaths: ["./src"], config: { model: "m" } }));
    const projectPath = "/api/projects/" + created.uuid;
    const launch = await j(await ui(base, "POST", projectPath + "/runs", { verb: "run", mockLlm: true }));
    assert.equal(launch.queued, true);
    assert.equal(typeof launch.jobId, "number");

    // Daemon claims the oldest queued job (FIFO), then opens a run row for it.
    const claim = await j(await asDaemon(base, token, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, launch.jobId);
    assert.equal(claim.job.project, "acme");
    assert.equal(claim.job.spec.verb, "run");
    assert.equal((await asDaemon(base, token, "POST", "/api/daemon/claim").then(j)).job, undefined); // queue drained

    const invalidStart = await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId: launch.jobId, project: "acme", kind: "arbitrary", runDir: "/tmp/acme-run-invalid" });
    assert.equal(invalidStart.status, 400);
    const start = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId: launch.jobId, project: "acme", kind: "run", runDir: "/tmp/acme-run-1", budgets: { model: "m" } }));
    assert.equal(typeof start.runId, "number");
    const runId = start.runId;
    // job ↔ run is linked (so a stop-by-run can find the job).
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "running");

    // Daemon reports the scope inventory; the run's live coverage updates.
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { scopes: [{ scopeId: "s1", title: "decode", status: "audited" }, { scopeId: "s2", title: "settle", status: "pending" }] });
    const afterScopes = await j(await ui(base, "GET", projectPath));
    assert.deepEqual(afterScopes.progress, { total: 2, audited: 1, pending: 1, deferred: 0 });

    // Daemon reports findings (with a status reason for the timeline) and a confirm decision.
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { findings: [{ findingKey: "f1", title: "unbound input", location: "src/x:10", status: "suspected" }], reason: "first sighting" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { findings: [{ findingKey: "f1", title: "unbound input", location: "src/x:10", status: "confirmed-differential" }], reason: "differential passed" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { confirmDecisions: [{ bug: "unbound input", reproduced: "yes", recommendation: "submit-candidate", evidenceLevel: "real-target-reproduced" }], decisionPath: "/tmp/acme-run-1/confirm_report.md" });

    const findings = await j(await ui(base, "GET", projectPath + "/findings"));
    assert.equal(findings.findings.length, 1);
    assert.equal(findings.findings[0].status, "confirmed-differential");
    assert.deepEqual(findings.findings[0].timeline.map((e) => e.to_status), ["suspected", "confirmed-differential"]);
    const detail = await j(await ui(base, "GET", projectPath));
    assert.equal(detail.auditConfirmedFindings, 1);
    assert.equal(detail.reproducedBugs, 1);
    assert.equal(detail.confirmedBugs, 1); // legacy alias for reproduced=yes

    // Daemon finishes the run; status + final coverage/finding-count persist.
    await asDaemon(base, token, "POST", `/api/daemon/jobs/${launch.jobId}/status`, { status: "done" });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { finish: { status: "done", coverage: { total: 2, audited: 2, pending: 0, deferred: 0 }, findingsTotal: 1 } });
    const finished = await j(await ui(base, "GET", `/api/runs/${runId}`));
    assert.equal(finished.run.status, "done");
    assert.equal(finished.run.findings_total, 1);
    const staleTerminal = await j(await asDaemon(base, token, "POST", `/api/daemon/jobs/${launch.jobId}/status`, { status: "error", error: "late update" }));
    assert.equal(staleTerminal.stale, true);
    assert.equal((await j(await ui(base, "GET", `/api/jobs/${launch.jobId}`))).job.status, "done");
  });
});

test("daemon: a valid token cannot read or mutate another daemon's job and run", async () => {
  await withServerAndToken(async ({ base, token: ownerToken, out }) => {
    const seed = MetadataStore.openForOutput(out);
    const attacker = seed.createDaemonToken("attacker-daemon");
    seed.upsertProject({ name: "owned-project" });
    seed.close();

    const ownerRegistration = await j(await asDaemon(base, ownerToken, "POST", "/api/daemon/register", { name: "owner" }));
    await asDaemon(base, attacker.token, "POST", "/api/daemon/register", { name: "attacker" });
    const store = MetadataStore.openForOutput(out);
    const jobId = store.enqueueJob("owned-project", { verb: "run", target: "owned-project", sourcePaths: ["."] }, ownerRegistration.daemonId);
    store.close();

    const claim = await j(await asDaemon(base, ownerToken, "POST", "/api/daemon/claim"));
    assert.equal(claim.job.id, jobId);
    const started = await j(await asDaemon(base, ownerToken, "POST", "/api/daemon/runs", {
      jobId,
      project: "owned-project",
      kind: "run",
      runDir: path.join(out, "owned-run"),
    }));

    assert.equal((await asDaemon(base, attacker.token, "PATCH", `/api/daemon/runs/${started.runId}`, { finish: { status: "done" } })).status, 403);
    assert.equal((await asDaemon(base, attacker.token, "POST", `/api/daemon/runs/${started.runId}/activity`, { events: [{ kind: "forged" }] })).status, 403);
    assert.equal((await asDaemon(base, attacker.token, "POST", "/api/daemon/pipeline-worklist", { jobId, project: "owned-project", phase: "verify" })).status, 403);
    assert.equal((await asDaemon(base, attacker.token, "POST", `/api/daemon/jobs/${jobId}/status`, { status: "error" })).status, 403);

    const after = MetadataStore.openForOutput(out);
    assert.equal(after.getRun(started.runId).status, "running");
    assert.equal(after.getJob(jobId).status, "running");
    after.close();

    assert.equal((await asDaemon(base, ownerToken, "PATCH", `/api/daemon/runs/${started.runId}`, { finish: { status: "running" } })).status, 400);
  });
});

test("daemon: confirm setup blockers surface as run health", async () => {
  await withServerAndToken(async ({ base, token, out }) => {
    const registered = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" }));
    const created = await j(await ui(base, "POST", "/api/projects", { name: "confirm-health", sourcePaths: ["."], buildRoot: "." }));
    let jobId;
    const store = MetadataStore.openForOutput(out);
    try {
      jobId = store.enqueueJob(created.name, { verb: "confirm" }, registered.daemonId);
    } finally {
      store.close();
    }

    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", {
      jobId,
      project: created.name,
      kind: "confirm",
      runDir: path.join(out, "confirm-health-run"),
      budgets: {},
    }));
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, {
      confirmDecisions: [
        { bug: "compiler unavailable", reproduced: "could-not-set-up", recommendation: "needs-human", members: ["ksetup"] },
      ],
    });
    await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { finish: { status: "done" } });

    const detail = await j(await ui(base, "GET", `/api/projects/${created.uuid}`));
    assert.equal(detail.latestRunHealth.status, "needs-resource");
    assert.equal(detail.latestRunHealth.signals.couldNotSetUp, 1);
    assert.match(detail.latestRunHealth.reasons[0], /could not be set up/);
  });
});

test("daemon: activity POSTs surface on the run's live SSE log", async () => {
  await withServerAndToken(async ({ base, token }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });
    const created = await j(await ui(base, "POST", "/api/projects", { name: "p", sourcePaths: ["./src"] }));
    const { jobId } = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true }));
    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId, project: "p", kind: "run", runDir: "/tmp/p-1", budgets: {} }));

    // A malformed batch is rejected atomically; its valid prefix must not leak into the bus.
    const malformed = await asDaemon(base, token, "POST", `/api/daemon/runs/${runId}/activity`, { events: [{ kind: "poison-prefix" }, { delta: "missing kind" }] });
    assert.equal(malformed.status, 400);

    // Daemon pushes a batch of token-level activity (as the live audit would).
    await asDaemon(base, token, "POST", `/api/daemon/runs/${runId}/activity`, { events: [{ kind: "thinking_delta", delta: "weighing the invariant" }, { kind: "step", tool: "bash", step: 1 }] });

    // The public log stream replays the backlogged events (this is the daemon → bus → SSE pipe).
    const ev = await readFirstActivity(base, runId, 2500);
    assert.ok(ev, "expected an activity event on the SSE log");
    assert.equal(ev.kind, "thinking_delta");
    assert.equal(ev.delta, "weighing the invariant");

    const active = await j(await ui(base, "GET", "/api/active"));
    const row = active.active.find((item) => item.jobId === jobId);
    assert.equal(row.runId, runId);
    assert.match(row.lastActivityAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(row.updatedAt >= row.lastActivityAt, true);
  });
});

test("daemon: active job counts connected daemon identities, not stream connections", async () => {
  await withServerAndToken(async ({ base, token }) => {
    const reg = await j(await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" }));
    const first = new AbortController();
    const second = new AbortController();
    const openStream = (signal) => fetch(base + "/api/daemon/stream", { headers: { authorization: `Bearer ${token}` }, signal });
    const streams = await Promise.all([openStream(first.signal), openStream(second.signal)]);
    try {
      assert.equal(streams.every((res) => res.ok), true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const created = await j(await ui(base, "POST", "/api/projects", { name: "deduped-daemon", daemonId: reg.daemonId, sourcePaths: ["./src"] }));
      const { jobId } = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true }));
      const active = await j(await ui(base, "GET", "/api/active"));
      const row = active.active.find((item) => item.jobId === jobId);
      assert.ok(row);
      assert.equal(row.onlineDaemons, 1);
      assert.equal(Array.isArray(active.daemons?.[0]?.capabilities?.providers), false);
      assert.equal(typeof active.daemons?.[0]?.capabilities?.providerCount, "number");
    } finally {
      first.abort();
      second.abort();
      await Promise.allSettled(streams.map((res) => res.body?.cancel()));
    }
  });
});

test("daemon: JSON run log compacts token deltas for history views", async () => {
  await withServerAndToken(async ({ base, token, out }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });
    const created = await j(await ui(base, "POST", "/api/projects", { name: "p", sourcePaths: ["./src"] }));
    const { jobId } = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true }));
    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const runDir = path.join(out, "p-1");
    await mkdir(runDir, { recursive: true });
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId, project: "p", kind: "run", runDir, budgets: {} }));
    await writeFile(path.join(runDir, "events.jsonl"), [
      JSON.stringify({ ts: "2026-01-01T00:00:01.000Z", kind: "audit_thinking", text: "checking the invariant" }),
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z", kind: "audit_text", text: "Confirmed candidate" }),
      JSON.stringify({ ts: "2026-01-01T00:00:03.000Z", kind: "step", tool: "bash", step: 1 }),
      JSON.stringify({ ts: "2026-01-01T00:00:04.000Z", kind: "artifact", name: "confirm_decision.json", path: "confirm_decision.json" }),
      JSON.stringify({ ts: "2026-01-01T00:00:04.250Z", kind: "artifact", name: "confirm_decision.json", path: "confirm_decision.json" }),
    ].join("\n") + "\n");

    await asDaemon(base, token, "POST", `/api/daemon/runs/${runId}/activity`, {
      events: [
        { ts: "2026-01-01T00:00:01.100Z", kind: "thinking_delta", delta: "checking " },
        { ts: "2026-01-01T00:00:01.200Z", kind: "thinking_delta", delta: "the invariant" },
        { ts: "2026-01-01T00:00:02.100Z", kind: "text_delta", delta: "Confirmed " },
        { ts: "2026-01-01T00:00:02.200Z", kind: "text_delta", delta: "candidate" },
        { ts: "2026-01-01T00:00:03.100Z", kind: "step", tool: "bash", step: 1 },
        { ts: "2026-01-01T00:00:03.200Z", kind: "step", tool: "bash", step: 1 },
      ],
    });

    const body = await j(await ui(base, "GET", `/api/runs/${runId}/log?tail=50&format=json`));
    assert.equal(body.events.some((ev) => ev.kind === "thinking_delta" || ev.kind === "text_delta"), false);
    assert.equal(body.events.filter((ev) => ev.kind === "audit_thinking").length, 1);
    assert.equal(body.events.find((ev) => ev.kind === "audit_thinking")?.detail, "checking the invariant");
    assert.equal(body.events.filter((ev) => ev.kind === "audit_text").length, 1);
    assert.equal(body.events.find((ev) => ev.kind === "audit_text")?.detail, "Confirmed candidate");
    assert.equal(body.events.filter((ev) => ev.kind === "step").length, 1);
    assert.equal(body.events.filter((ev) => ev.kind === "artifact" && ev.name === "confirm_decision.json").length, 1);
  });
});

test("daemon: stopping a run immediately kills it and ignores stale daemon completion", async () => {
  await withServerAndToken(async ({ base, token, out }) => {
    await asDaemon(base, token, "POST", "/api/daemon/register", { name: "d1" });
    const created = await j(await ui(base, "POST", "/api/projects", { name: "p", sourcePaths: ["./src"] }));
    const { jobId } = await j(await ui(base, "POST", `/api/projects/${created.uuid}/runs`, { verb: "run", mockLlm: true }));
    await asDaemon(base, token, "POST", "/api/daemon/claim");
    const { runId } = await j(await asDaemon(base, token, "POST", "/api/daemon/runs", { jobId, project: "p", kind: "run", runDir: "/tmp/p-1", budgets: {} }));

    // UI stops the run. The server must make the dashboard terminal immediately; a daemon
    // may be stuck inside a provider call and never report back.
    const stop = await j(await ui(base, "POST", `/api/runs/${runId}/stop`));
    assert.equal(stop.stopped, true);
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "killed");
    const store = MetadataStore.openForOutput(out);
    try {
      assert.equal(store.getJob(jobId).status, "canceled");
    } finally {
      store.close();
    }

    const staleUpdate = await j(await asDaemon(base, token, "PATCH", `/api/daemon/runs/${runId}`, { finish: { status: "done" } }));
    assert.equal(staleUpdate.stale, true);
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "killed");

    // A late daemon "done" report must not revive a stopped run or active job.
    await asDaemon(base, token, "POST", `/api/daemon/jobs/${jobId}/status`, { status: "done" });
    assert.equal((await j(await ui(base, "GET", `/api/runs/${runId}`))).run.status, "killed");
    const after = MetadataStore.openForOutput(out);
    try {
      assert.equal(after.getJob(jobId).status, "canceled");
    } finally {
      after.close();
    }
  });
});

// Open the SSE log, return the first activity event (one with a `kind`), then abort. The
// event is already in the bus backlog, so the first read returns it — no hang.
async function readFirstActivity(base, runId, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/runs/${runId}/log`, { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev && ev.kind) {
            controller.abort();
            return ev;
          }
        } catch {
          // skip a non-JSON frame (e.g. the ": open" comment)
        }
      }
    }
  } catch {
    // aborted at the timeout
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}
