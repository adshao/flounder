import assert from "node:assert/strict";
import test from "node:test";
import { daemonVisibleSandboxReadiness } from "../dist/server/daemon.js";
import { DEFAULT_SANDBOX_IMAGE } from "../dist/security/sandbox.js";

test("daemon: missing default sandbox image is an auto-recoverable capability", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "auto",
    image: DEFAULT_SANDBOX_IMAGE,
    allowHostFallback: false,
    message: "No sandbox backend is available.",
  });

  assert.equal(visible.ok, true);
  assert.equal(visible.autoBuild, true);
  assert.match(visible.message ?? "", /built automatically/);
});

test("daemon: missing custom sandbox image remains operator-visible", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "auto",
    image: "custom-audit-image:latest",
    allowHostFallback: false,
    message: "No sandbox backend is available.",
  });

  assert.equal(visible.ok, false);
  assert.equal(visible.autoBuild, undefined);
});

test("daemon: missing Apple container image does not trigger Docker auto-build", () => {
  const visible = daemonVisibleSandboxReadiness({
    ok: false,
    backend: "apple-container",
    image: DEFAULT_SANDBOX_IMAGE,
    allowHostFallback: false,
    message: "Apple container sandbox image is not available.",
  });

  assert.equal(visible.ok, false);
  assert.equal(visible.autoBuild, undefined);
  assert.match(visible.message ?? "", /Apple container/);
});
