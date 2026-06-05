import path from "node:path";

export function locationFile(location: string): string {
  const match = /^(.*?):\d+(?:-\d+)?$/.exec(location.trim());
  return match?.[1] ?? location.trim();
}

export function canonicalLocationFile(location: string, cwd = process.cwd()): string {
  return canonicalPath(locationFile(location), cwd);
}

export function canonicalPath(input: string, cwd = process.cwd()): string {
  return publicPath(input, cwd);
}

export function publicLocation(location: string, cwd = process.cwd()): string {
  const trimmed = location.trim();
  const match = /^(.*?):(\d+(?:-\d+)?)$/.exec(trimmed);
  if (!match) return publicPath(trimmed, cwd);
  return `${publicPath(match[1] ?? "", cwd)}:${match[2]}`;
}

export function publicPath(input: string, cwd = process.cwd()): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (looksLikeNonFileLocation(trimmed)) return trimmed;
  if (looksLikeWindowsAbsolutePath(trimmed)) return externalPath(path.win32.basename(trimmed));

  const root = path.resolve(cwd);
  const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  const relative = path.relative(root, path.normalize(absolute));
  if (relative === "") return ".";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return toPosix(relative);
  return externalPath(path.basename(absolute));
}

function looksLikeNonFileLocation(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) || /^[A-Za-z_][A-Za-z0-9_]*(?:[#.][A-Za-z_][A-Za-z0-9_]*)?$/.test(input);
}

function looksLikeWindowsAbsolutePath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\[^\\]+\\[^\\]+/.test(input);
}

function externalPath(base: string): string {
  return toPosix(path.posix.join("external", base || "path"));
}

function toPosix(input: string): string {
  return input.split(path.sep).join("/");
}
