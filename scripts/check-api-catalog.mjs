#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { apiCatalog } from "../dist/server/app.js";

const execFileAsync = promisify(execFile);
const root = process.cwd();

const daemonStartUsage = "flounder daemon start --server <url> --token <token>";
const stalePatterns = [
  {
    name: "old daemon top-level start command",
    pattern: /\bflounder daemon --server\b/,
  },
  {
    name: "old db vocabulary",
    pattern: /\bflounder db\b/,
  },
  {
    name: "project-name API route",
    pattern: /\/api\/projects\/(?::name|<name>)/,
  },
];

const [catalog, cliHelp, uiHelp, daemonHelp, daemonStartHelp] = await Promise.all([
  Promise.resolve(apiCatalog()),
  cli(["--help"]),
  cli(["ui", "--help"]),
  cli(["daemon", "--help"]),
  cli(["daemon", "start", "--help"]),
]);

const catalogText = flatten(catalog);
const helpText = [cliHelp, uiHelp, daemonHelp, daemonStartHelp].join("\n");
const publicText = [catalogText, helpText].join("\n");

assert.match(uiHelp, /flounder ui \[--port <n>\].*--concurrency <n>/s, "ui help must be side-effect-free and document local daemon concurrency");
assert.match(daemonStartHelp, new RegExp(escapeRegExp(daemonStartUsage)), "daemon start help must document the current start command");
assert.match(cliHelp, /flounder daemon start --server <url> --token <token>/, "top-level CLI help must expose daemon start");

const daemonCreate = catalog.endpoints.find((endpoint) => endpoint.method === "POST" && endpoint.path === "/api/daemons");
assert.ok(daemonCreate, "catalog must expose POST /api/daemons");
assert.match(daemonCreate.summary, new RegExp(escapeRegExp(daemonStartUsage)), "daemon token API summary must tell users to run daemon start");

const projectRun = endpoint("POST", "/api/projects/:uuid/runs");
assert.match(projectRun.summary, /single action behind the UI/i, "project run catalog must describe the UI launch entry point");
for (const key of ["scopeCoverageMode", "maxScopes", "mapSteps", "digSteps", "maxSteps", "digSamples", "digConcurrency"]) {
  assert.equal(typeof projectRun.body?.[key], "string", `project run catalog must document ${key}`);
}
assert.match(projectRun.body.maxScopes, /one-off scope cap/i, "project run catalog must distinguish scope batch cap from model turn budgets");
assert.match(projectRun.body.digSteps, /one-off per-scope dig turn cap/i, "project run catalog must document explicit dig turn caps");

const scopePatch = endpoint("PATCH", "/api/projects/:uuid/scopes/:scopeId");
assert.match(scopePatch.summary, /top of the next auto-dig batch/i, "scope patch catalog must document queue prioritization");
assert.equal(typeof scopePatch.body?.prioritize, "string", "scope patch catalog must document prioritize:true");
assert.match(scopePatch.body.prioritize, /top/i, "scope prioritize body description must say it moves a scope to the top");
assert.match(scopePatch.body.status, /deferred.*pending/s, "scope patch catalog must document defer/resume statuses");

for (const { name, pattern } of stalePatterns) {
  assert.doesNotMatch(publicText, pattern, `catalog/CLI help still exposes ${name}`);
}

assert.ok(catalog.endpoints.every((endpoint) => typeof endpoint.summary === "string" && endpoint.summary.trim().length > 0), "every catalog endpoint needs a summary");
assert.ok(catalog.endpoints.every((endpoint) => !endpoint.path.includes(":name")), "project routes must use UUIDs, not names");

console.log("API catalog contract passed.");

function endpoint(method, path) {
  const hit = catalog.endpoints.find((entry) => entry.method === method && entry.path === path);
  assert.ok(hit, `catalog must expose ${method} ${path}`);
  return hit;
}

async function cli(args) {
  const result = await execFileAsync(process.execPath, [path.join(root, "dist/cli.js"), ...args], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout}\n${result.stderr}`;
}

function flatten(value) {
  return JSON.stringify(value, null, 2);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
