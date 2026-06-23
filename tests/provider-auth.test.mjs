import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { providerAuthPath, providerAuthStatus } from "../dist/provider-auth.js";

test("provider auth imports an existing pi provider credential into the Flounder agent dir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-provider-auth-"));
  const flounderAgent = path.join(root, "flounder-agent");
  const piAgent = path.join(root, "pi-agent");
  await mkdir(piAgent, { recursive: true });
  const credential = { type: "oauth", subject: "example-user" };
  await writeFile(path.join(piAgent, "auth.json"), JSON.stringify({ "openai-codex": credential, anthropic: { type: "oauth", subject: "other" } }), "utf8");

  const oldFlounderAgentDir = process.env.FLOUNDER_AGENT_DIR;
  const oldPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.FLOUNDER_AGENT_DIR = flounderAgent;
  process.env.PI_AGENT_DIR = piAgent;
  try {
    const status = await providerAuthStatus("openai-codex");
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

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
