import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { checkRequestBoundary, parseAllowedHosts } from "../dist/server/request-guard.js";
import { startUiServer } from "../dist/server/app.js";

const check = (overrides) => checkRequestBoundary({ method: "GET", headers: { host: "127.0.0.1:4500" }, loopbackBound: true, daemonRoute: false, ...overrides });

test("request guard: a loopback bind only answers loopback Host names", () => {
  for (const host of ["127.0.0.1:4500", "localhost:4500", "LOCALHOST", "[::1]:4500"]) {
    assert.equal(check({ headers: { host } }).ok, true, host);
  }
  for (const host of ["attacker.example:4500", "127.0.0.1.attacker.example", "", undefined]) {
    const decision = check({ headers: host === undefined ? {} : { host } });
    assert.equal(decision.ok, false, String(host));
    assert.equal(decision.status, 403);
  }
  // Daemon routes get the same Host check: a rebound name must not reach them either.
  assert.equal(check({ headers: { host: "attacker.example" }, daemonRoute: true }).ok, false);
  // An operator can name a local reverse proxy explicitly.
  assert.equal(check({ headers: { host: "flounder.internal" }, allowedHosts: parseAllowedHosts(" Flounder.Internal , ") }).ok, true);
  // A non-loopback bind is protected by the operator token, not by the Host header.
  assert.equal(check({ headers: { host: "audit-box:4500" }, loopbackBound: false }).ok, true);
});

test("request guard: browser requests must be same-origin", () => {
  const host = "127.0.0.1:4500";
  assert.equal(check({ method: "POST", headers: { host, origin: "http://127.0.0.1:4500" } }).ok, true);
  assert.equal(check({ method: "POST", headers: { host, "sec-fetch-site": "same-origin" } }).ok, true);
  for (const headers of [
    { host, origin: "https://attacker.example" },
    { host, origin: "http://127.0.0.1:9999" },
    { host, origin: "null" },
    { host, "sec-fetch-site": "cross-site" },
  ]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const decision = check({ method, headers });
      assert.equal(decision.ok, false, `${method} ${JSON.stringify(headers)}`);
      assert.equal(decision.status, 403);
    }
  }
  // Bearer-authenticated daemon routes are not browser-facing.
  assert.equal(check({ method: "POST", headers: { host, origin: "https://attacker.example" }, daemonRoute: true }).ok, true);
});

test("request guard: request bodies must be declared as JSON", () => {
  const host = "127.0.0.1:4500";
  assert.equal(check({ method: "POST", headers: { host, "content-length": "2", "content-type": "application/json; charset=utf-8" } }).ok, true);
  assert.equal(check({ method: "POST", headers: { host } }).ok, true, "bodyless POST is fine");
  assert.equal(check({ method: "POST", headers: { host, "content-length": "0" } }).ok, true);
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
    const decision = check({ method: "POST", headers: { host, "content-length": "2", ...(contentType ? { "content-type": contentType } : {}) } });
    assert.equal(decision.ok, false, String(contentType));
    assert.equal(decision.status, 415);
  }
  assert.equal(check({ method: "PATCH", headers: { host, "transfer-encoding": "chunked", "content-type": "text/plain" } }).ok, false);
});

function rawRequest(port, { method = "GET", path: requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("request guard: the control plane enforces it over real HTTP", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "flounder-guard-"));
  const server = startUiServer({ port: 0, out, workspace: path.join(out, "workspace"), host: "127.0.0.1" });
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  try {
    assert.equal(await rawRequest(port, { path: "/api/projects", headers: { host } }), 200);
    // DNS rebinding: the socket is loopback but the browser believes it is another site.
    assert.equal(await rawRequest(port, { path: "/api/projects", headers: { host: `attacker.example:${port}` } }), 403);
    assert.equal(await rawRequest(port, { path: "/", headers: { host: `attacker.example:${port}` } }), 403);
    // Cross-site form/fetch: a "simple" text/plain POST carrying JSON must not create state.
    const body = JSON.stringify({ name: "csrf" });
    const forged = { host, origin: "https://attacker.example", "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) };
    assert.equal(await rawRequest(port, { method: "POST", path: "/api/projects", headers: forged, body }), 403);
    const untyped = { host, "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) };
    assert.equal(await rawRequest(port, { method: "POST", path: "/api/projects", headers: untyped, body }), 415);
    const projects = await (await fetch(`http://${host}/api/projects`)).json();
    assert.equal(JSON.stringify(projects).includes("csrf"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
