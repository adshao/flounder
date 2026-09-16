import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeModelId,
  buildClaudeCommand,
  buildClaudeInvocation,
  cleanupTempDir,
  describeFsError,
} from "../dist/llm/claude-code.js";

// The command builder is pure and takes the platform explicitly, so the Windows
// execution path is covered on every platform (there is no Windows CI job).
test("claude-code: command construction differs per platform", () => {
  const args = ["-p", "--model", "haiku"];

  const win = buildClaudeCommand(args, "win32");
  assert.equal(win.command, "claude.cmd -p --model haiku");
  assert.deepEqual(win.args, [], "the Windows command line carries the arguments itself");
  assert.equal(win.shell, true, "a .cmd shim can only be launched through a shell");

  const posix = buildClaudeCommand(args, "linux");
  assert.equal(posix.command, "claude");
  assert.deepEqual(posix.args, args, "POSIX passes argv and needs no shell");
  assert.equal(posix.shell, false);
});

test("claude-code: cmd.exe quoting covers spaces, quotes and trailing backslashes", () => {
  const { command } = buildClaudeCommand(
    ["-p", "a b", 'he said "hi"', "C:\\dir with space\\", "plain", "dir\\"],
    "win32",
  );
  assert.equal(
    command,
    'claude.cmd -p "a b" "he said \\"hi\\"" "C:\\dir with space\\\\" plain dir\\',
  );
});

test("claude-code: model ids cmd.exe could interpret are rejected", () => {
  for (const unsafe of ["", "a b", "a&b", "a|b", "a>b", "a%b", 'a"b', "a^b", "a;b", "$x", "a\\b", "-p"]) {
    assert.throws(() => assertSafeModelId(unsafe), /unsafe model id/, `${JSON.stringify(unsafe)} must be rejected`);
    assert.throws(
      () => buildClaudeInvocation({ model: unsafe, user: "u" }),
      /unsafe model id/,
      `${JSON.stringify(unsafe)} must be rejected before the command line is built`,
    );
  }
  for (const safe of ["haiku", "claude-opus-4-8", "claude-sonnet-5", "gpt-5.5", "anthropic/claude-x", "bedrock:anthropic.claude-v1"]) {
    assert.doesNotThrow(() => assertSafeModelId(safe), `${JSON.stringify(safe)} must be accepted`);
  }
});

test("claude-code: the system prompt travels by file, by constant relative name", () => {
  const { args } = buildClaudeInvocation({ model: "haiku", user: "USER-TURN" });
  const idx = args.indexOf("--append-system-prompt-file");
  assert.notEqual(idx, -1, "the system prompt must be passed to the CLI");

  const name = args[idx + 1];
  assert.equal(name, "system-prompt.txt");
  assert.doesNotMatch(name, /[\\/]/, "must not be a path");
  assert.doesNotMatch(name, /:/, "must not carry a drive letter");
  assert.doesNotMatch(name, /%/, "must not be something cmd.exe could expand");
  assert.equal(args.filter((arg) => arg === name).length, 1, "exactly one prompt file");
});

test("claude-code: only the user turn reaches stdin, so the system role is preserved", () => {
  const user = "UNIQUE_USER_PAYLOAD";
  const { args, stdin } = buildClaudeInvocation({ model: "haiku", user });
  assert.equal(stdin, user, "stdin is the user turn alone — the system prompt is never concatenated");
  assert.doesNotMatch(args.join(" "), /UNIQUE_USER_PAYLOAD/, "the user turn is not on the command line");
});

test("claude-code: cleanup asks fs.rm for its own retries and logs nothing on success", async () => {
  const events = [];
  let called;
  await cleanupTempDir("some-dir", { event: async (kind, data) => events.push({ kind, data }) }, async (dir, options) => {
    called = { dir, options };
  });
  assert.equal(called.dir, "some-dir");
  assert.deepEqual(called.options, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  assert.deepEqual(events, []);
});

test("claude-code: a persistent cleanup failure is reported, not thrown, and leaks no path", async () => {
  const dir = path.join(os.tmpdir(), "flounder-cleanup-should-not-appear");
  const busy = Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${dir}'`), { code: "EBUSY", syscall: "rmdir" });
  const events = [];

  await cleanupTempDir(dir, { event: async (kind, data) => events.push({ kind, data }) }, async () => {
    throw busy;
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "claude_code_tmp_cleanup_failed");
  assert.deepEqual(events[0].data, { code: "EBUSY", syscall: "rmdir" });
  assert.doesNotMatch(JSON.stringify(events[0].data), /flounder-cleanup-should-not-appear/);
});

test("claude-code: without a logger the failure is bounded on stderr too", async () => {
  const dir = path.join(os.tmpdir(), "flounder-cleanup-should-not-appear");
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await cleanupTempDir(dir, undefined, async () => {
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${dir}'`), { code: "EPERM", syscall: "rmdir" });
    });
  } finally {
    process.stderr.write = original;
  }

  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /claude_code_tmp_cleanup_failed/);
  assert.match(chunks[0], /code=EPERM/);
  assert.doesNotMatch(chunks[0], /flounder-cleanup-should-not-appear/);
});

test("claude-code: error fields degrade to bounded placeholders", () => {
  assert.deepEqual(describeFsError(new Error("no code here")), { code: "unknown", syscall: "unknown" });
  assert.deepEqual(describeFsError(undefined), { code: "unknown", syscall: "unknown" });
  assert.deepEqual(describeFsError({ code: 42, syscall: "rmdir" }), { code: "unknown", syscall: "rmdir" });
});
