import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import type { ThinkingLevel } from "../config.js";

export class ClaudeCodeClient implements LlmClient {
  constructor(private readonly logger?: RunLogger) {}

  async complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: ThinkingLevel;
    agentic?: boolean;
  }): Promise<string> {
    if (!input.model) throw new Error("model is required");
    // Built (and validated) before the temp directory exists: an unsafe model id
    // must not be able to leave a directory behind on its way out.
    const invocation = buildClaudeInvocation({ model: input.model, thinkingLevel: input.thinkingLevel, user: input.user });
    const tmp = await mkdtemp(path.join(os.tmpdir(), "flounder-claude-code-"));
    const system = renderSystemPrompt(input.system, input.agentic ?? false);
    // NOTE: keep these flags aligned with the installed `claude` CLI. The provider
    // is a pure text-completion backend: flounder parses the model's JSON action and runs
    // the tool itself inside its sandbox, so the spawned `claude` must NOT use its own
    // tools (that would emit non-JSON output and bypass the sandbox/confirmation gate).
    // `--permission-mode default` (NOT bypassPermissions) is correct here — there are no
    // tools to approve, and host harnesses (rightly) block bypassPermissions as an unsafe
    // autonomous-agent spawn. The system prompt is appended because the CLI exposes
    // `--append-system-prompt[-file]` (no replace flag); the appended instruction + disabled
    // tools is sufficient to get a single JSON action per turn.

    try {
      // The rendered prompt is passed BY FILE: it can be far larger than Windows' 32k
      // CreateProcess command-line limit, which made claude.cmd exit(255) instantly with no
      // output (upstream then surfaced that as a 15-minute timeout). Keeping it on stdin
      // instead would collapse the system/user role boundary, so only the user turn is piped.
      // It is written under the temp cwd but referenced by the constant RELATIVE name in the
      // arguments (see buildClaudeInvocation): an OS-derived absolute path on that command
      // line is a %NAME% expansion surface in cmd.exe, and the relative name has none.
      await writeFile(path.join(tmp, SYSTEM_PROMPT_FILENAME), system);
      const stdout = await spawnClaude(invocation.args, invocation.stdin, {
        cwd: tmp,
        maxBuffer: 20 * 1024 * 1024,
        timeout: Number(process.env.FLOUNDER_CLAUDE_CODE_TIMEOUT_MS ?? 900_000),
      });
      const { text, meta } = parseClaudeOutput(stdout);
      await this.logger?.call({
        tag: input.tag,
        model: `claude-code/${input.model}`,
        system: input.system,
        user: input.user,
        response: text,
        meta,
      });
      if (text.trim().length === 0) throw new Error(`claude-code returned no text: model=${input.model}`);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger?.call({
        tag: input.tag,
        model: `claude-code/${input.model}`,
        system: input.system,
        user: input.user,
        response: "",
        meta: { error: message },
      });
      throw new Error(`claude-code completion failed: ${message}`);
    } finally {
      await cleanupTempDir(tmp, this.logger);
    }
  }
}

// Name of the file holding the rendered system prompt inside the per-call temp
// directory. Also passed verbatim as the `--append-system-prompt-file` argument,
// which is why it is a constant with no path separator and no `%`: the child runs
// with cwd=tmp, and anything cmd.exe could expand must not reach its command line.
export const SYSTEM_PROMPT_FILENAME = "system-prompt.txt";

// The model id is the one caller-supplied value that reaches the command line;
// reject anything cmd.exe could read as a metacharacter before it gets there.
export function assertSafeModelId(model: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(model)) {
    throw new Error(`unsafe model id: ${JSON.stringify(model)}`);
  }
}

// Pure: what to launch, with which arguments, and what to feed it on stdin. The
// system prompt is deliberately NOT accepted here — it travels by file, so the
// only thing on stdin is the user turn and the system/user role boundary holds.
export function buildClaudeInvocation(input: {
  model: string;
  thinkingLevel?: ThinkingLevel | undefined;
  user: string;
}): { args: string[]; stdin: string } {
  assertSafeModelId(input.model);
  const effort = claudeCodeEffort(input.thinkingLevel);
  return {
    args: [
      "-p",
      "--model",
      input.model,
      ...(effort ? ["--effort", effort] : []),
      "--append-system-prompt-file",
      SYSTEM_PROMPT_FILENAME,
      "--output-format",
      "json",
      "--disallowedTools",
      DISABLED_CLAUDE_TOOLS,
      "--permission-mode",
      "default",
    ],
    stdin: input.user,
  };
}

// Pure: how to launch it on this platform. Windows installs the CLI as a
// `claude.cmd` shim, which Node can only launch through a shell, and Node refuses
// to escape arguments it concatenates into a shell command line (DEP0190). So the
// Windows command line is assembled here with explicit cmd.exe quoting, and the
// model id is validated before it can reach the shell (see assertSafeModelId).
export function buildClaudeCommand(
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (platform !== "win32") return { command: "claude", args, shell: false };
  return { command: ["claude.cmd", ...args.map(quoteForCmd)].join(" "), args: [], shell: true };
}

// Windows command-line quoting (backslashes are literal except right before a
// quote). Needed because arguments are joined into the cmd.exe command line.
function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

// Remove the per-call temp directory, reporting (never throwing) a persistent
// failure so it cannot mask the completion error already propagating out. Only
// bounded, non-identifying fields are logged: the directory is environment-derived
// and the raw error message repeats it.
export async function cleanupTempDir(
  dir: string,
  logger?: RunLogger,
  remove: (dir: string, options: { recursive: boolean; force: boolean; maxRetries: number; retryDelay: number }) => Promise<void> = rm,
): Promise<void> {
  await remove(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(async (error: unknown) => {
    const { code, syscall } = describeFsError(error);
    if (logger) await logger.event("claude_code_tmp_cleanup_failed", { code, syscall });
    else process.stderr.write(`[flounder] claude_code_tmp_cleanup_failed code=${code} syscall=${syscall}\n`);
  });
}

export function describeFsError(error: unknown): { code: string; syscall: string } {
  const errno = error as NodeJS.ErrnoException | undefined;
  return {
    code: typeof errno?.code === "string" ? errno.code : "unknown",
    syscall: typeof errno?.syscall === "string" ? errno.syscall : "unknown",
  };
}

function claudeCodeEffort(level?: ThinkingLevel): string | undefined {
  if (!level) return undefined;
  if (level === "off" || level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high" || level === "xhigh") return level;
  return undefined;
}

function renderSystemPrompt(system: string, agentic: boolean): string {
  if (agentic) {
    // Agentic loop: the model must drive its own investigation. The framework
    // executes the tools the task describes when the model emits a tool action,
    // so the only constraint is the exact response format. Do NOT tell the model
    // to avoid inspecting files or to answer only from the provided text — that
    // would defeat the loop.
    return `You are a non-interactive model driving one turn of an automated audit loop.
The task below defines tools that the surrounding framework runs for you. To act, respond in the exact format the task specifies (a single JSON object) and nothing else: no markdown fences, no commentary, no reasoning prose outside that format. You will receive each tool's result and then take the next turn. Use the tools to investigate the code yourself; do not assume the work is already done.

System instructions:
${system}
`;
  }
  return `You are acting as a non-interactive language model inside an audit pipeline.
Do not run tools, inspect files, or rely on external context. Answer only from the text below.
Return only the exact response format requested by the user task. Do not include markdown fences, preambles, or reasoning prose outside that requested format.

System instructions:
${system}
`;
}

// Built-in Claude Code tools to disable so the spawned `claude -p` is a pure
// text completion that only emits the JSON action flounder expects (flounder executes the
// real tool itself inside its sandbox).
const DISABLED_CLAUDE_TOOLS =
  "Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit TodoWrite SlashCommand KillShell BashOutput";

function parseClaudeOutput(stdout: string): { text: string; meta: Record<string, unknown> } {
  const parsed = JSON.parse(stdout) as { result?: unknown; modelUsage?: unknown; usage?: unknown; total_cost_usd?: unknown; session_id?: unknown };
  return {
    text: typeof parsed.result === "string" ? parsed.result : "",
    meta: {
      ...(parsed.modelUsage !== undefined ? { modelUsage: parsed.modelUsage } : {}),
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
      ...(parsed.total_cost_usd !== undefined ? { totalCostUsd: parsed.total_cost_usd } : {}),
      ...(parsed.session_id !== undefined ? { sessionId: parsed.session_id } : {}),
    },
  };
}

function spawnClaude(args: string[], input: string, options: { cwd: string; maxBuffer: number; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const { command, args: commandArgs, shell } = buildClaudeCommand(args);
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`claude-code timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, options.maxBuffer);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxBuffer);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
      }
    });
    child.stdin.end(input);
  });
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}
