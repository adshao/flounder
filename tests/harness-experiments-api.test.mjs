import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startUiServer } from "../dist/server/app.js";
import { DAEMON_PROTOCOL_VERSION } from "../dist/server/protocol.js";

const json = (response) => response.json();
const request = (base, method, route, body, token) => fetch(base + route, {
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(route === "/api/daemon/register" ? { ...body, protocolVersion: DAEMON_PROTOCOL_VERSION } : body) } : {}),
});

function item(itemKey, expectedOutcome) {
  return {
    itemKey,
    kind: "benchmark-case",
    targetBundle: {
      target: `harness-${itemKey}`,
      targetClass: "logic",
      sourcePaths: ["/authorized/source"],
      corpusPaths: [],
      mockLlm: true,
    },
    materialPolicy: { posture: "blind", materials: [] },
    evidenceContract: {
      kind: "benchmark-oracle",
      expectedOutcome,
      caseId: itemKey,
      caseFamily: itemKey.endsWith("2") ? "family-b" : "family-a",
      targetStack: "javascript",
      holdout: itemKey.endsWith("2"),
      requiresDifferential: expectedOutcome === "detect-positive",
      requiresRefutation: true,
      networkPolicy: "sealed",
    },
  };
}

async function createFinishedGroup(base, out, token, name, acceptedByKey) {
  const created = await json(await request(base, "POST", "/api/run-groups", {
    version: 1,
    name,
    kind: "evaluation",
    parallelism: 4,
    items: [item("p1", "detect-positive"), item("p2", "detect-positive"), item("c1", "reject-positive"), item("c2", "reject-positive")],
  }));
  await json(await request(base, "POST", `/api/run-groups/${created.uuid}/start`, {}));
  for (const workItem of created.items) {
    const claim = await json(await request(base, "POST", "/api/daemon/claim", {}, token));
    assert.equal(claim.job.project, `evaluation:${workItem.uuid}`);
    const run = await json(await request(base, "POST", "/api/daemon/runs", {
      jobId: claim.job.id,
      project: claim.job.project,
      kind: "run",
      runDir: path.join(out, `${name}-${workItem.item_key}`),
    }, token));
    const accepted = acceptedByKey[workItem.item_key];
    const expectedPositive = workItem.item_key.startsWith("p");
    const producesFinding = expectedPositive ? accepted : !accepted;
    await json(await request(base, "PATCH", `/api/daemon/runs/${run.runId}`, {
      findings: producesFinding ? [{ findingKey: `F-${name}-${workItem.item_key}`, title: "Execution-backed evidence", status: "confirmed-differential" }] : [],
      stage: { name: "refutation", info: { candidates: producesFinding ? 1 : 0, attempted: producesFinding ? 1 : 0, verdicts: producesFinding ? 1 : 0, errors: 0 } },
      health: { status: "healthy", reasons: [], signals: [] },
      finish: { status: "done", findingsTotal: producesFinding ? 1 : 0 },
    }, token));
    await json(await request(base, "POST", `/api/daemon/jobs/${claim.job.id}/status`, { status: "done" }, token));
  }
  return await json(await fetch(`${base}/api/run-groups/${created.uuid}`));
}

test("harness experiment API mines, bounds, compares, and persists a promotion decision", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-harness-experiment-"));
  const server = startUiServer({ port: 0, out, host: "127.0.0.1", maintainerMode: true });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const maintainerCatalog = await json(await fetch(`${base}/api`));
    assert.equal(maintainerCatalog.maintainerMode, true);
    assert.ok(maintainerCatalog.resources.includes("harness-experiment"));
    const daemon = await json(await request(base, "POST", "/api/daemons", { name: "harness-daemon" }));
    const token = daemon.token;
    const registered = await request(base, "POST", "/api/daemon/register", { name: "harness-daemon", capabilities: {}, workspace: out }, token);
    assert.equal(registered.status, 200);
    await json(registered);
    const baseline = await createFinishedGroup(base, out, token, "baseline", { p1: false, p2: true, c1: true, c2: true });
    const candidate = await createFinishedGroup(base, out, token, "candidate", { p1: true, p2: true, c1: true, c2: true });

    const createdResponse = await request(base, "POST", "/api/harness-experiments", {
      name: "recall candidate",
      baselineRunGroupUuid: baseline.uuid,
      candidateRunGroupUuid: candidate.uuid,
      editableFiles: ["src/agent/prompts.ts"],
    });
    assert.equal(createdResponse.status, 201);
    const created = await json(createdResponse);
    assert.equal(created.state, "evaluating");
    assert.equal(created.failurePatterns.length, 1);
    assert.equal(created.failurePatterns[0].kind, "positive-miss");
    assert.equal(created.proposal.changes[0].path, "src/agent/prompts.ts");
    assert.equal(created.baselineGroup.items.length, 4);
    assert.equal(created.candidateGroup.items.length, 4);

    const invalidProposal = await request(base, "PATCH", `/api/harness-experiments/${created.uuid}/proposal`, {
      proposal: { ...created.proposal, changes: [{ path: "src/security/policy.ts", summary: "weaken policy" }] },
    });
    assert.equal(invalidProposal.status, 400);

    const briefResponse = await fetch(`${base}/api/harness-experiments/${created.uuid}/brief`);
    assert.equal(briefResponse.status, 200);
    const brief = await json(briefResponse);
    assert.match(brief.markdown, /Verifier-grounded weaknesses/);
    assert.match(brief.markdown, /never merge or deploy automatically/);

    const evaluatedResponse = await request(base, "POST", `/api/harness-experiments/${created.uuid}/evaluate`, {});
    assert.equal(evaluatedResponse.status, 200);
    const evaluated = await json(evaluatedResponse);
    assert.equal(evaluated.state, "decided");
    assert.equal(evaluated.decision, "promote");
    assert.deepEqual(evaluated.scorecard.improvedItemKeys, ["p1"]);
    assert.deepEqual(evaluated.scorecard.regressedItemKeys, []);

    const listed = await json(await fetch(`${base}/api/harness-experiments`));
    assert.equal(listed.total, 1);
    assert.equal(listed.experiments[0].decision, "promote");

    assert.ok(maintainerCatalog.endpoints.some((endpoint) => endpoint.path === "/api/harness-experiments/:uuid/evaluate"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
