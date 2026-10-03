import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectContinueBody } from "../dist/cli-project.js";
import { launchProjectRunViaApi } from "../dist/cli-client.js";

test("cli continue builds the project run pipeline body", () => {
  assert.deepEqual(buildProjectContinueBody([
    "--project", "demo",
    "--verify-from-start",
    "--coverage", "custom",
    "--max-scopes", "3",
    "--map-steps", "5",
    "--dig-steps", "7",
    "--dig-samples", "2",
    "--dig-concurrency", "2",
    "--mock-llm",
  ]), {
    verb: "run",
    pipeline: true,
    verifyFromStart: true,
    mockLlm: true,
    continueCoverage: true,
    scopeCoverageMode: "custom",
    maxScopes: 3,
    mapSteps: 5,
    digSteps: 7,
    digSamples: 2,
    digConcurrency: 2,
  });
});

test("cli continue leaves coverage closed by default", () => {
  assert.deepEqual(buildProjectContinueBody(["--project", "demo"]), {
    verb: "run",
    pipeline: true,
  });
  assert.deepEqual(buildProjectContinueBody(["--project", "demo", "--continue-coverage"]), {
    verb: "run",
    pipeline: true,
    continueCoverage: true,
  });
});

test("cli continue rejects unknown coverage modes before enqueueing", () => {
  assert.throws(() => buildProjectContinueBody(["--coverage", "everything"]), /focused\|standard\|half\|full\|custom/);
});

test("project continue client posts verb run to the project endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let posted;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("http://flounder.test/api/projects?")) {
      return jsonResponse({ projects: [{ uuid: "proj-1", name: "demo" }] });
    }
    if (url === "http://flounder.test/api/projects/proj-1/runs" && init.method === "POST") {
      posted = JSON.parse(String(init.body));
      return jsonResponse({ jobId: 7, verb: "run", daemons: 1 });
    }
    if (url === "http://flounder.test/api/jobs/7") {
      return jsonResponse({ job: { id: 7, status: "done" } });
    }
    return jsonResponse({ error: "not found" }, 404);
  };

  try {
    const run = await launchProjectRunViaApi("http://flounder.test", "demo", { verb: "run", maxScopes: 3 });
    assert.equal(run?.status, "done");
    assert.deepEqual(posted, { verb: "run", maxScopes: 3 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
