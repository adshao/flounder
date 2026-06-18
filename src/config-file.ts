// Persistent, layered CLI configuration — so common knobs (the control-plane endpoint, the
// provider/model/thinking the daemon should use, the output dir, the prepare posture) don't
// have to be retyped on every invocation. Auto-discovered, with a precedence chain that
// mirrors git/gh/docker:
//
//   defaultConfig()  <  user-global file  <  project-local file  <  env  <  flags
//
// The user-global file is $XDG_CONFIG_HOME/flounder/config.json (else ~/.config/flounder/
// config.json); the project-local file is the nearest .flounder/config.json found by walking
// up from the cwd (like .git). `flounder config get|set|unset|list|path` reads and writes
// these files. This module is the source of truth for WHICH keys are persistable and how each
// validates; cli.ts layers the resolved values under --config and the flags.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
const POSTURES = ["blind", "informed"] as const;

// The persistable keys. Each maps 1:1 to a CLI concept; the type drives validation in `set`
// and parsing on load. Keep this list small and meaningful — these are the knobs a user sets
// once and forgets, NOT every flag.
export interface CliConfigValues {
  /** control-plane URL the CLI drives (the single entry point for run/map/audit/confirm/prepare). */
  server?: string;
  /** pi-ai provider id the daemon should use (e.g. openai-codex). */
  provider?: string;
  /** audit model id. */
  model?: string;
  /** reasoning effort. */
  thinking?: ThinkingLevel;
  /** artifact output dir + tracking-store location (must match the control plane's --out to share state). */
  out?: string;
  /** default posture for `flounder prepare`. */
  posture?: (typeof POSTURES)[number];
}
export type CliConfigKey = keyof CliConfigValues;

interface KeySpec {
  type: "string" | "thinking" | "posture";
  summary: string;
}
export const CLI_CONFIG_KEYS: Record<CliConfigKey, KeySpec> = {
  server: { type: "string", summary: "control-plane URL the CLI drives, e.g. http://127.0.0.1:4500" },
  provider: { type: "string", summary: "pi-ai provider id (default openai-codex)" },
  model: { type: "string", summary: "audit model id" },
  thinking: { type: "thinking", summary: "reasoning effort: minimal|low|medium|high|xhigh" },
  out: { type: "string", summary: "artifact output dir + store location (match the control plane to share state)" },
  posture: { type: "posture", summary: "flounder prepare default posture: blind|informed" },
};

export type ConfigSource = "default" | "user" | "project" | "env" | "flag";

export interface LoadedCliConfig {
  /** merged values (user < project < env), with no flag layer yet — cli.ts applies flags last. */
  values: CliConfigValues;
  /** where each present value came from, for `config list`. */
  sources: Partial<Record<CliConfigKey, ConfigSource>>;
  userFile: string;
  /** the discovered project-local file, if any (else undefined). */
  projectFile?: string;
}

/** The user-global config path: $XDG_CONFIG_HOME/flounder/config.json or ~/.config/flounder/config.json. */
export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "flounder", "config.json");
}

/** Walk up from `cwd` for the nearest .flounder/config.json (like git). Undefined if none. */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".flounder", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/** Where `set --local` writes: the discovered project file, else <cwd>/.flounder/config.json. */
export function projectConfigWritePath(cwd: string): string {
  return findProjectConfig(cwd) ?? path.join(path.resolve(cwd), ".flounder", "config.json");
}

/** The file a given scope reads/writes. */
export function configFilePath(scope: "global" | "local", cwd: string): string {
  return scope === "local" ? projectConfigWritePath(cwd) : userConfigPath();
}

/** Validate+coerce a raw string for a key (used by `set`). Throws on an invalid value. */
export function coerceCliConfigValue(key: CliConfigKey, raw: string): string | ThinkingLevel {
  const spec = CLI_CONFIG_KEYS[key];
  const value = raw.trim();
  if (value.length === 0) throw new Error(`value for "${key}" is empty`);
  if (spec.type === "thinking") {
    if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
      throw new Error(`invalid thinking "${value}" — one of ${THINKING_LEVELS.join("|")}`);
    }
  } else if (spec.type === "posture") {
    if (!(POSTURES as readonly string[]).includes(value)) {
      throw new Error(`invalid posture "${value}" — one of ${POSTURES.join("|")}`);
    }
  }
  return value;
}

export function isCliConfigKey(key: string): key is CliConfigKey {
  return Object.prototype.hasOwnProperty.call(CLI_CONFIG_KEYS, key);
}

// Read one config file, keeping only known keys with valid values. A malformed file or a bad
// value is skipped rather than fatal — a broken global config must never block a CLI run.
function readConfigFile(file: string): Partial<CliConfigValues> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<CliConfigValues> = {};
  for (const key of Object.keys(CLI_CONFIG_KEYS) as CliConfigKey[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    try {
      (out as Record<string, unknown>)[key] = coerceCliConfigValue(key, v);
    } catch {
      // skip an invalid persisted value
    }
  }
  return out;
}

// The single env var that participates in the precedence chain: FLOUNDER_SERVER overrides the
// configured endpoint (e.g. CI pointing the CLI at a shared control plane) but stays below an
// explicit --server flag. We deliberately do NOT mint env vars for the other keys — they would
// be noise nobody asked for; add them here only when there's a real need.
function envLayer(): { values: Partial<CliConfigValues>; sources: Partial<Record<CliConfigKey, ConfigSource>> } {
  const server = process.env.FLOUNDER_SERVER?.trim();
  if (server && server.length > 0) return { values: { server }, sources: { server: "env" } };
  return { values: {}, sources: {} };
}

/** Load and merge the persisted config: user < project < env. Flags are applied later by cli.ts. */
export function loadCliConfig(cwd: string = process.cwd()): LoadedCliConfig {
  const userFile = userConfigPath();
  const projectFile = findProjectConfig(cwd);
  const env = envLayer();
  const layers: Array<{ source: ConfigSource; values: Partial<CliConfigValues> }> = [
    { source: "user", values: readConfigFile(userFile) },
    ...(projectFile ? [{ source: "project" as ConfigSource, values: readConfigFile(projectFile) }] : []),
    { source: "env", values: env.values },
  ];
  const values: CliConfigValues = {};
  const sources: Partial<Record<CliConfigKey, ConfigSource>> = {};
  for (const layer of layers) {
    for (const key of Object.keys(layer.values) as CliConfigKey[]) {
      const v = layer.values[key];
      if (v === undefined) continue;
      (values as Record<string, unknown>)[key] = v;
      sources[key] = layer.source;
    }
  }
  return { values, sources, userFile, ...(projectFile ? { projectFile } : {}) };
}

/** Read a single resolved value (for `config get`). */
export function getCliConfigValue(key: CliConfigKey, cwd: string = process.cwd()): { value?: string; source?: ConfigSource } {
  const loaded = loadCliConfig(cwd);
  const value = loaded.values[key];
  if (value === undefined) return {};
  const source = loaded.sources[key];
  return source === undefined ? { value: String(value) } : { value: String(value), source };
}

/** Persist a key to the global or project file (creating it). Returns the file written. */
export function setCliConfigValue(key: CliConfigKey, raw: string, scope: "global" | "local", cwd: string = process.cwd()): { file: string; value: string } {
  const value = String(coerceCliConfigValue(key, raw));
  const file = configFilePath(scope, cwd);
  const current = readRawConfigObject(file);
  current[key] = value;
  writeConfigObject(file, current);
  return { file, value };
}

/** Remove a key from the given scope's file. Returns whether it was present. */
export function unsetCliConfigValue(key: CliConfigKey, scope: "global" | "local", cwd: string = process.cwd()): { file: string; existed: boolean } {
  const file = configFilePath(scope, cwd);
  const current = readRawConfigObject(file);
  const existed = Object.prototype.hasOwnProperty.call(current, key);
  if (existed) {
    delete current[key];
    writeConfigObject(file, current);
  }
  return { file, existed };
}

// Read the raw JSON object of a config file for editing (preserves unknown keys so a hand-added
// comment-key or future field survives a `set`). Malformed JSON resets to {} rather than
// clobbering silently — we surface that by throwing only on write failure, not read.
function readRawConfigObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeConfigObject(file: string, obj: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
