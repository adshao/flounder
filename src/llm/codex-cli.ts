import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import type { ThinkingLevel } from "../config.js";

export class CodexCliClient implements LlmClient {
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
    const tmp = await mkdtemp(path.join(os.tmpdir(), "flounder-codex-cli-"));
    const outputFile = path.join(tmp, "last-message.txt");
    const prompt = renderPrompt(input.system, input.user, input.agentic ?? false);
    const webSearch = readCodexWebSearchEnv();
    const args = buildCodexExecArgs({
      model: input.model,
      workdir: tmp,
      outputFile,
      ...(input.thinkingLevel && input.thinkingLevel !== "off" ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(webSearch ? { webSearch } : {}),
    });
    let eventChain = Promise.resolve();
    let textLineCount = 0;
    let textLineSuppressed = false;
    const enqueueEvent = (kind: string, data: Record<string, unknown>): void => {
      if (!this.logger) return;
      eventChain = eventChain
        .then(() => this.logger?.event(kind, data))
        .then(() => undefined)
        .catch(() => undefined);
    };

    try {
      await this.logger?.event("model_call_start", {
        tag: input.tag,
        model: `codex-cli/${input.model}`,
      });
      await spawnCodex(args, prompt, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: Number(process.env.FLOUNDER_CODEX_TIMEOUT_MS ?? 900_000),
        onJsonEvent: (event) => {
          enqueueEvent("codex_cli_event", {
            tag: input.tag,
            ...summarizeCodexEvent(event),
          });
        },
        onTextLine: ({ stream, line }) => {
          if (line.trim().length === 0) return;
          if (textLineCount >= 24) {
            if (!textLineSuppressed) {
              textLineSuppressed = true;
              enqueueEvent("codex_cli_output_suppressed", { tag: input.tag, reason: "too_many_non_json_lines" });
            }
            return;
          }
          textLineCount += 1;
          enqueueEvent("codex_cli_output", { tag: input.tag, stream, line: sanitizeRuntimeLine(line) });
        },
      });
      await eventChain;
      const text = await readFile(outputFile, "utf8");
      await this.logger?.call({
        tag: input.tag,
        model: `codex-cli/${input.model}`,
        system: input.system,
        user: input.user,
        response: text,
      });
      if (text.trim().length === 0) throw new Error(`codex-cli returned no text: model=${input.model}`);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await eventChain;
      await this.logger?.call({
        tag: input.tag,
        model: `codex-cli/${input.model}`,
        system: input.system,
        user: input.user,
        response: "",
        meta: { error: message },
      });
      throw new Error(`codex-cli completion failed: ${message}`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

export function buildCodexExecArgs(input: {
  model: string;
  workdir: string;
  outputFile: string;
  thinkingLevel?: Exclude<ThinkingLevel, "off">;
  webSearch?: "live" | "cached" | "disabled";
}): string[] {
  const args = [
    "exec",
    "--model",
    input.model,
    "--json",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--cd",
    input.workdir,
    "--output-last-message",
    input.outputFile,
    "-",
  ];
  if (input.thinkingLevel) {
    args.splice(1, 0, "-c", `model_reasoning_effort="${input.thinkingLevel}"`);
  }
  if (input.webSearch) {
    args.splice(1, 0, "-c", `web_search=${input.webSearch}`);
  }
  return args;
}

function readCodexWebSearchEnv(): "live" | "cached" | "disabled" | undefined {
  const value = process.env.FLOUNDER_CODEX_WEB_SEARCH;
  if (value === "live" || value === "cached" || value === "disabled") return value;
  return undefined;
}

function renderPrompt(system: string, user: string, agentic: boolean): string {
  if (agentic) {
    return `You are a non-interactive model driving one turn of an automated audit loop.
The task below defines tools that the surrounding framework runs for you. To act, respond in the exact format the task specifies (a single JSON object) and nothing else. You will receive each tool's result and then take the next turn. Use the tools to investigate the code yourself; do not assume the work is already done.

System instructions:
${system}

User task:
${user}
`;
  }
  return `You are acting as a non-interactive language model inside an audit pipeline.
Do not run tools, inspect files, or rely on external context. Answer only from the text below.

System instructions:
${system}

User task:
${user}
`;
}

function spawnCodex(
  args: string[],
  input: string,
  options: {
    maxBuffer: number;
    timeout: number;
    onJsonEvent?: (event: Record<string, unknown>) => void;
    onTextLine?: (input: { stream: "stdout" | "stderr"; line: string }) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const stdoutLines = createLineParser((line) => {
      handleCodexLine(line, "stdout", options);
    });
    const stderrLines = createLineParser((line) => {
      handleCodexLine(line, "stderr", options);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`codex-cli timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, options.maxBuffer);
      stdoutLines.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxBuffer);
      stderrLines.push(chunk);
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
      stdoutLines.flush();
      stderrLines.flush();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex exited with code ${code}: ${(stderr || stdout).slice(0, 2000)}`));
      }
    });
    child.stdin.end(input);
  });
}

function createLineParser(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    },
    flush() {
      if (buffer.length === 0) return;
      onLine(buffer);
      buffer = "";
    },
  };
}

function handleCodexLine(
  line: string,
  stream: "stdout" | "stderr",
  options: {
    onJsonEvent?: (event: Record<string, unknown>) => void;
    onTextLine?: (input: { stream: "stdout" | "stderr"; line: string }) => void;
  },
): void {
  const trimmed = line.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        options.onJsonEvent?.(parsed as Record<string, unknown>);
        return;
      }
    } catch {
      // Fall through to non-JSON output handling.
    }
  }
  options.onTextLine?.({ stream, line });
}

function summarizeCodexEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.type === "string" ? event.type : "unknown";
  if (type === "thread.started") {
    return {
      eventType: type,
      ...(typeof event.thread_id === "string" ? { threadId: event.thread_id } : {}),
    };
  }
  if (type === "turn.completed") {
    return {
      eventType: type,
      ...(event.usage && typeof event.usage === "object" ? { usage: event.usage } : {}),
    };
  }
  if (type === "item.completed") {
    const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : {};
    const itemType = typeof item.type === "string" ? item.type : "unknown";
    const text = typeof item.text === "string" ? item.text : undefined;
    const includePreview = itemType.includes("reason") || itemType.includes("thinking");
    return {
      eventType: type,
      itemType,
      ...(typeof item.id === "string" ? { itemId: item.id } : {}),
      ...(text !== undefined ? { textChars: text.length } : {}),
      ...(includePreview && text ? { textPreview: sanitizeRuntimeLine(text).slice(0, 500) } : {}),
    };
  }
  return { eventType: type };
}

function sanitizeRuntimeLine(line: string): string {
  const home = os.homedir();
  return line
    .replaceAll(home, "~")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}
