import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginProvider, providerAuthPath, providerAuthStatus } from "../dist/provider-auth.js";

test("provider auth imports an existing pi provider credential into the Flounder agent dir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-auth-"));
  const flounderAgent = path.join(root, "flounder-agent");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(piAgent, { recursive: true });
  const credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account" };
  await writeFile(path.join(piAgent, "auth.json"), JSON.stringify({ "openai-codex": credential, anthropic: { type: "oauth", subject: "other" } }), "utf8");

  const oldFlounderAgentDir = process.env.FLOUNDER_AGENT_DIR;
  const oldPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.FLOUNDER_AGENT_DIR = flounderAgent;
  process.env.PI_AGENT_DIR = piAgent;
  try {
    const status = await providerAuthStatus("openai-codex");
    assert.equal(status.oauthLogin, true);
    assert.equal(status.configured, true);
    assert.equal(status.source, "stored");
    assert.match(status.sourceLabel ?? "", /imported from/);

    const authPath = providerAuthPath();
    const copied = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(copied, { "openai-codex": credential });
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  } finally {
    restoreEnv("FLOUNDER_AGENT_DIR", oldFlounderAgentDir);
    restoreEnv("PI_AGENT_DIR", oldPiAgentDir);
  }
});

test("provider status rejects an unusable stored OAuth credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-auth-invalid-"));
  const flounderAgent = path.join(root, "flounder-agent");
  await mkdir(flounderAgent, { recursive: true });
  await writeFile(path.join(flounderAgent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", expires: 0 } }), "utf8");

  const oldFlounderAgentDir = process.env.FLOUNDER_AGENT_DIR;
  const oldDisablePiImport = process.env.FLOUNDER_DISABLE_PI_AUTH_IMPORT;
  process.env.FLOUNDER_AGENT_DIR = flounderAgent;
  process.env.FLOUNDER_DISABLE_PI_AUTH_IMPORT = "1";
  try {
    const status = await providerAuthStatus("openai-codex");
    assert.equal(status.configured, false);
  } finally {
    restoreEnv("FLOUNDER_AGENT_DIR", oldFlounderAgentDir);
    restoreEnv("FLOUNDER_DISABLE_PI_AUTH_IMPORT", oldDisablePiImport);
  }
});

test("provider status replaces an unusable Flounder credential with usable pi auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-auth-recover-"));
  const flounderAgent = path.join(root, "flounder-agent");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(flounderAgent, { recursive: true });
  await mkdir(piAgent, { recursive: true });
  await writeFile(path.join(flounderAgent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", expires: 0 } }), "utf8");
  const credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account" };
  await writeFile(path.join(piAgent, "auth.json"), JSON.stringify({ "openai-codex": credential }), "utf8");

  const oldFlounderAgentDir = process.env.FLOUNDER_AGENT_DIR;
  const oldPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.FLOUNDER_AGENT_DIR = flounderAgent;
  process.env.PI_AGENT_DIR = piAgent;
  try {
    const status = await providerAuthStatus("openai-codex");
    assert.equal(status.configured, true);
    assert.match(status.sourceLabel ?? "", /imported from/);
    const copied = JSON.parse(await readFile(providerAuthPath(), "utf8"));
    assert.deepEqual(copied, { "openai-codex": credential });
  } finally {
    restoreEnv("FLOUNDER_AGENT_DIR", oldFlounderAgentDir);
    restoreEnv("PI_AGENT_DIR", oldPiAgentDir);
  }
});

test("explicit provider login refreshes an existing Flounder credential from pi auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-auth-refresh-"));
  const flounderAgent = path.join(root, "flounder-agent");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(flounderAgent, { recursive: true });
  await mkdir(piAgent, { recursive: true });
  const staleCredential = { type: "oauth", access: "stale", refresh: "stale" };
  const freshCredential = { type: "oauth", access: "fresh", refresh: "fresh" };
  const unrelatedCredential = { type: "oauth", subject: "keep-me" };
  await writeFile(
    path.join(flounderAgent, "auth.json"),
    JSON.stringify({ "openai-codex": staleCredential, anthropic: unrelatedCredential }),
    "utf8",
  );
  await writeFile(path.join(piAgent, "auth.json"), JSON.stringify({ "openai-codex": freshCredential }), "utf8");

  const oldFlounderAgentDir = process.env.FLOUNDER_AGENT_DIR;
  const oldPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.FLOUNDER_AGENT_DIR = flounderAgent;
  process.env.PI_AGENT_DIR = piAgent;
  try {
    await loginProvider("openai-codex");

    const copied = JSON.parse(await readFile(providerAuthPath(), "utf8"));
    assert.deepEqual(copied, {
      "openai-codex": freshCredential,
      anthropic: unrelatedCredential,
    });
    assert.equal((await stat(providerAuthPath())).mode & 0o777, 0o600);
  } finally {
    restoreEnv("FLOUNDER_AGENT_DIR", oldFlounderAgentDir);
    restoreEnv("PI_AGENT_DIR", oldPiAgentDir);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}


test("provider login consumes pi auth interactions and persists the typed OAuth credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-login-"));
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { readFile, stat } from "node:fs/promises";
    const credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 12345 };
    let closed = false;
    mock.module("node:readline", { namedExports: { createInterface: () => ({
      question(message, options, done) { done(message.startsWith("Enter number") ? "1" : "fixture-code"); },
      close() { closed = true; }
    }) } });
    const originalProviders = await import("@earendil-works/pi-ai/providers/all");
    mock.module("@earendil-works/pi-ai/providers/all", { namedExports: { ...originalProviders, builtinProviders: () => [{
      id: "fixture-oauth", auth: { oauth: { async login(interaction) {
        assert.ok(interaction.signal instanceof AbortSignal);
        interaction.notify({ type: "auth_url", url: "https://example.com/login", instructions: "Fixture login" });
        interaction.notify({ type: "device_code", verificationUri: "https://example.com/device", userCode: "fixture" });
        interaction.notify({ type: "progress", message: "Fixture progress" });
        interaction.notify({ type: "info", message: "Fixture info", links: [{ url: "https://example.com" }] });
        assert.equal(await interaction.prompt({ type: "manual_code", message: "Code" }), "fixture-code");
        assert.equal(await interaction.prompt({ type: "select", message: "Account", options: [{ id: "fixture", label: "Fixture" }] }), "fixture");
        const controller = new AbortController();
        controller.abort(new Error("Fixture canceled"));
        await assert.rejects(interaction.prompt({ type: "text", message: "Canceled", signal: controller.signal }), /Fixture canceled/);
        return credential;
      } } }
    }] } });
    const { loginProvider, providerAuthPath } = await import("./dist/provider-auth.js");
    await loginProvider("fixture-oauth");
    assert.deepEqual(JSON.parse(await readFile(providerAuthPath(), "utf8")), { "fixture-oauth": credential });
    assert.equal((await stat(providerAuthPath())).mode & 0o777, 0o600);
    assert.equal(closed, true);
  `;
  execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, FLOUNDER_AGENT_DIR: root, FLOUNDER_DISABLE_PI_AUTH_IMPORT: "1" },
    stdio: "pipe",
  });
});
