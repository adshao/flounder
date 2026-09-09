import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runCli(args, cwd, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CLI exited ${code}: ${stderr || stdout}`)));
  });
}

test("CLI defers implicit model selection to the control plane", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "flounder-cli-default-"));
  const posted = [];
  let nextJobId = 1;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/launch") {
      let body = "";
      for await (const chunk of req) body += chunk;
      posted.push(JSON.parse(body));
      const jobId = nextJobId++;
      return json(res, { jobId, daemons: 1 });
    }
    const job = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
    if (req.method === "GET" && job) return json(res, { job: { id: Number(job[1]), status: "running", run_id: Number(job[1]) } });
    const run = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (req.method === "GET" && run) return json(res, { run: { id: Number(run[1]), status: "done", kind: "run", findings_total: 0 } });
    if (req.method === "GET" && /^\/api\/runs\/\d+\/log$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end();
    }
    json(res, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await runCli(["run", "--source", temp, "--target", "implicit-model", "--server", base, "--mock-llm"], process.cwd(), temp);
    await runCli(["run", "--source", temp, "--target", "explicit-model", "--server", base, "--mock-llm", "--model", "gpt-5.6-sol"], process.cwd(), temp);
    await runCli(["run", "--source", temp, "--target", "max-thinking", "--server", base, "--mock-llm", "--thinking", "max"], process.cwd(), temp);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(posted.length, 3);
  assert.equal("provider" in posted[0], false);
  assert.equal("model" in posted[0], false);
  assert.equal("customModels" in posted[0], false);
  assert.equal("thinking" in posted[0], false);
  assert.equal(posted[1].provider, "openai-codex");
  assert.equal(posted[1].model, "gpt-5.6-sol");
  assert.equal(posted[1].thinking, "xhigh");
  assert.equal(posted[2].thinking, "max");
});

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
