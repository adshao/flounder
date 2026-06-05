import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export class RunLogger {
  readonly runDir: string;
  readonly callsDir: string;
  readonly eventsPath: string;
  #callSeq = 0;

  constructor(baseDir: string, targetName: string, now = new Date()) {
    const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    this.runDir = path.join(baseDir, `${targetName}-${ts}`);
    this.callsDir = path.join(this.runDir, "calls");
    this.eventsPath = path.join(this.runDir, "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.callsDir, { recursive: true });
  }

  async event(kind: string, data: Record<string, unknown> = {}): Promise<void> {
    const rec = { ts: new Date().toISOString(), kind, ...data };
    await appendFile(this.eventsPath, `${JSON.stringify(rec)}\n`);
  }

  async call(input: {
    tag: string;
    model: string;
    system: string;
    user: string;
    response: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    this.#callSeq += 1;
    const file = path.join(this.callsDir, `${String(this.#callSeq).padStart(4, "0")}_${safeName(input.tag)}.json`);
    const publicFile = toPosix(path.relative(this.runDir, file));
    await writeFile(
      file,
      JSON.stringify(
        {
          seq: this.#callSeq,
          tag: input.tag,
          model: input.model,
          system: input.system,
          user: input.user,
          response: input.response,
          meta: input.meta ?? {},
        },
        null,
        2,
      ),
    );
    await this.event("model_call", {
      tag: input.tag,
      model: input.model,
      call: publicFile,
      charsIn: input.system.length + input.user.length,
      charsOut: input.response.length,
    });
  }

  async artifact(name: string, value: unknown): Promise<string> {
    const file = path.join(this.runDir, name);
    const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    await writeFile(file, body);
    await this.event("artifact", { name, path: toPosix(name) });
    return file;
  }
}

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120);
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
