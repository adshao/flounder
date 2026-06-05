#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const execFileAsync = promisify(execFile);
const currentSkipDirs = new Set([".git", ".npm-cache", "files", "node_modules", "runs"]);
const historySkipDirs = new Set([".git", ".npm-cache", "node_modules"]);
const skipFiles = new Set(["Orchard_Security_Bugv2.pdf", "files.zip"]);
const textExtensions = new Set([
  ".adoc",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sol",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const textFilesWithoutExtension = new Set([".gitignore", "AGENTS", "AGENTS.md", "LICENSE"]);

const localPathPatterns = [
  {
    name: "macOS user home absolute path",
    pattern: new RegExp(`(?:^|[\\s"'(])/${"Users"}/[^\\s"'<>]+`, "g"),
  },
  {
    name: "Unix user home absolute path",
    pattern: new RegExp(`(?:^|[\\s"'(])/${"home"}/[^\\s"'<>]+`, "g"),
  },
  {
    name: "machine temp absolute path",
    pattern: new RegExp(`(?:^|[\\s"'(])/${"private"}/(?:tmp|var)/[^\\s"'<>]+`, "g"),
  },
  {
    name: "Windows user home absolute path",
    pattern: new RegExp(`[A-Za-z]:[\\\\/]${"Users"}[\\\\/][^\\s"'<>]+`, "g"),
  },
];

const secretPatterns = [
  { name: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "private key block", pattern: /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/g },
  {
    name: "credential assignment",
    pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
  },
];

const findings = [];
for (const file of await listFiles(root)) {
  if (!isTextFile(file)) continue;
  const body = await readFile(file, "utf8");
  const relative = toPosix(path.relative(root, file));
  scanBody(relative, body, [...localPathPatterns, ...secretPatterns]);
}
await scanGitHistory();

if (findings.length > 0) {
  console.error("Public-surface scan failed. Remove or redact these values before committing:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log("Public-surface scan passed.");
}

async function listFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (currentSkipDirs.has(entry.name)) continue;
      out.push(...(await listFiles(path.join(dir, entry.name))));
      continue;
    }
    if (!entry.isFile()) continue;
    if (skipFiles.has(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function isTextFile(file) {
  const base = path.basename(file);
  return textFilesWithoutExtension.has(base) || textExtensions.has(path.extname(file).toLowerCase());
}

function scanBody(file, body, patterns) {
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of body.matchAll(pattern)) {
      findings.push({
        file,
        line: lineNumber(body, match.index ?? 0),
        rule: name,
      });
    }
  }
}

async function scanGitHistory() {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
  } catch {
    return;
  }

  const commits = await listGitCommits();
  await scanGitCommitMessages(commits);
  await scanGitBlobHistory(commits);
}

async function listGitCommits() {
  try {
    const result = await execFileAsync("git", ["rev-list", "--all"], {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function scanGitCommitMessages(commits) {
  if (commits.length === 0) return;
  let stdout;
  try {
    const result = await execFileAsync("git", ["log", "--format=%H%x00%B%x00END%x00"], {
      cwd: root,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch {
    return;
  }

  for (const record of stdout.split("\0END\0")) {
    const parts = record.split("\0");
    const hash = parts.shift();
    const body = parts.join("\0").trim();
    if (!hash || !body) continue;
    scanBody(`git-commit:${hash.slice(0, 12)}`, body, [...localPathPatterns, ...secretPatterns]);
  }
}

async function scanGitBlobHistory(commits) {
  for (const commit of commits) {
    let stdout;
    try {
      const result = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", commit], {
        cwd: root,
        maxBuffer: 50 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch {
      continue;
    }

    const files = stdout.split("\0").filter(Boolean).filter(isPublicTextPath);
    for (const file of files) {
      let body;
      try {
        const result = await execFileAsync("git", ["show", `${commit}:${file}`], {
          cwd: root,
          maxBuffer: 10 * 1024 * 1024,
        });
        body = result.stdout;
      } catch {
        continue;
      }
      scanBody(`git-blob:${commit.slice(0, 12)}:${toPosix(file)}`, body, [...localPathPatterns, ...secretPatterns]);
    }
  }
}

function isPublicTextPath(file) {
  const parts = file.split(/[\\/]/);
  if (parts.some((part) => historySkipDirs.has(part))) return false;
  if (skipFiles.has(path.basename(file))) return false;
  return isTextFile(file);
}

function lineNumber(body, offset) {
  let line = 1;
  for (let idx = 0; idx < offset; idx += 1) {
    if (body.charCodeAt(idx) === 10) line += 1;
  }
  return line;
}

function toPosix(input) {
  return input.split(path.sep).join("/");
}
