import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Doc } from "../types.js";
import { publicPath } from "../util/paths.js";

const SOURCE_EXTS = new Set([
  ".rs",
  ".sol",
  ".go",
  ".py",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".rb",
  ".php",
  ".ex",
  ".exs",
  ".cs",
  ".fs",
  ".scala",
  ".dart",
  ".lua",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sh",
  ".bash",
  ".move",
  ".cairo",
  ".vy",
  ".circom",
  ".sql",
  ".proto",
  ".graphql",
  ".gql",
  ".tf",
  ".hcl",
  ".rego",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".xml",
  ".gradle",
]);

const SOURCE_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "rakefile",
  "justfile",
  "procfile",
  "pipfile",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "poetry.lock",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "composer.json",
  "mix.exs",
  "foundry.toml",
  "remappings.txt",
  "hardhat.config.ts",
  "hardhat.config.js",
  "hardhat.config.cjs",
  "hardhat.config.mjs",
  "slither.config.json",
  "echidna.yaml",
  "echidna.yml",
  "medusa.json",
  "wrangler.toml",
]);

const DOC_EXTS = new Set([".md", ".txt", ".rst", ".tex", ".org", ".adoc", ".html", ".htm"]);
const PDF_EXTS = new Set([".pdf"]);
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "target",
  "build",
  "dist",
  "coverage",
  "runs",
  "__pycache__",
  ".cache",
  ".npm-cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "venv",
  ".tox",
]);

export async function loadSource(paths: string[]): Promise<Doc[]> {
  return walk(paths, SOURCE_EXTS, "source");
}

export async function loadCorpus(paths: string[]): Promise<Doc[]> {
  return walk(paths, new Set([...SOURCE_EXTS, ...DOC_EXTS, ...PDF_EXTS]), "corpus");
}

export function numberLines(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line, idx) => `${String(idx + 1).padStart(5, " ")}  ${line}`)
    .join("\n");
}

export function assemble(docs: Doc[], charBudget: number, withLineNumbers = false): string {
  const chunks: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const body = withLineNumbers ? numberLines(doc.content) : doc.content;
    const block = `\n===== FILE: ${doc.path} =====\n${body}\n`;
    if (used + block.length > charBudget) {
      const remaining = charBudget - used;
      if (remaining > 1000) chunks.push(`${block.slice(0, remaining)}\n...[truncated]...\n`);
      break;
    }
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("");
}

async function walk(paths: string[], exts: Set<string>, kind: Doc["kind"]): Promise<Doc[]> {
  const docs: Doc[] = [];
  const cwd = process.cwd();
  for (const root of await buildWalkRoots(paths, cwd)) {
    await walkOne(root.full, exts, kind, docs, root);
  }
  return docs;
}

interface WalkRoot {
  full: string;
  cwd: string;
  isDirectory: boolean;
  externalLabel?: string;
}

async function buildWalkRoots(inputs: string[], cwd: string): Promise<WalkRoot[]> {
  const roots = await Promise.all(
    inputs.map(async (input) => {
      const full = path.resolve(input);
      const isDirectory = await isDirectoryPath(full);
      const external = isExternalToCwd(full, cwd);
      return {
        full,
        cwd,
        isDirectory,
        ...(external ? { externalLabel: "" } : {}),
      };
    }),
  );

  const externalBases = roots
    .filter((root) => root.externalLabel !== undefined)
    .map((root) => sanitizedPathSegment(path.basename(root.full) || "source"));
  const duplicateBases = new Set(externalBases.filter((base, idx) => externalBases.indexOf(base) !== idx));
  const usedLabels = new Set<string>();

  return roots.map((root) => {
    if (root.externalLabel === undefined) return root;
    const base = sanitizedPathSegment(path.basename(root.full) || "source");
    const parent = sanitizedPathSegment(path.basename(path.dirname(root.full)) || "external");
    const preferred = duplicateBases.has(base) ? `${parent}-${base}` : base;
    const label = uniqueExternalLabel(preferred, usedLabels);
    return { ...root, externalLabel: label };
  });
}

async function isDirectoryPath(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isDirectory();
  } catch {
    return false;
  }
}

async function walkOne(fullPath: string, exts: Set<string>, kind: Doc["kind"], out: Doc[], root: WalkRoot): Promise<void> {
  let info;
  try {
    info = await stat(fullPath);
  } catch {
    return;
  }

  if (info.isDirectory()) {
    const entries = await readdir(fullPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      await walkOne(path.join(fullPath, entry.name), exts, kind, out, root);
    }
    return;
  }

  if (!info.isFile()) return;

  const ext = path.extname(fullPath).toLowerCase();
  const base = path.basename(fullPath).toLowerCase();
  if (!exts.has(ext) && !SOURCE_BASENAMES.has(base)) return;

  const content = await readDoc(fullPath, ext);
  if (content.trim().length === 0) return;
  out.push({ path: publicSourcePath(fullPath, root), content, kind });
}

function publicSourcePath(fullPath: string, root: WalkRoot): string {
  if (root.externalLabel === undefined) return publicPath(fullPath, root.cwd);
  if (!root.isDirectory) return toPosix(path.posix.join("external", root.externalLabel));

  const relative = path.relative(root.full, fullPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return toPosix(path.posix.join("external", root.externalLabel));
  }
  return toPosix(path.posix.join("external", root.externalLabel, ...relative.split(path.sep)));
}

function isExternalToCwd(fullPath: string, cwd: string): boolean {
  const relative = path.relative(path.resolve(cwd), path.normalize(fullPath));
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function uniqueExternalLabel(preferred: string, used: Set<string>): string {
  let candidate = preferred || "source";
  let idx = 2;
  while (used.has(candidate)) {
    candidate = `${preferred || "source"}-${idx}`;
    idx += 1;
  }
  used.add(candidate);
  return candidate;
}

function sanitizedPathSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "source";
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}

async function readDoc(fullPath: string, ext: string): Promise<string> {
  if (PDF_EXTS.has(ext)) {
    try {
      return execFileSync("pdftotext", [fullPath, "-"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }).slice(0, 500_000);
    } catch {
      return "";
    }
  }
  return (await readFile(fullPath, "utf8")).slice(0, 500_000);
}
