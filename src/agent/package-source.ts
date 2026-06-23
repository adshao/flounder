import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { normalizeRelativePath, resolveWorkspacePathForWrite } from "../security/sandbox.js";

const gunzipAsync = promisify(gunzip);

const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 20_000;
const CRATES_IO = "https://crates.io";

export interface PackageFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PackageFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<PackageFetchResponse>;

export interface StagePackageSourceInput {
  workspaceAbsolute: string;
  registry: "crates.io";
  packageName: string;
  version: string;
  destination?: string;
  fetchImpl?: PackageFetch;
}

export interface StagePackageSourceResult {
  registry: "crates.io";
  packageName: string;
  version: string;
  stagedPath: string;
  provenancePath: string;
  checksum: string;
  sha256: string;
  fileCount: number;
  extractedBytes: number;
  componentTemplate: Record<string, unknown>;
  groundTruthTemplate: Record<string, unknown>;
}

interface TarEntry {
  path: string;
  type: "file" | "directory";
  content: Buffer;
}

interface CratesIoMetadata {
  checksum: string;
  downloadUrl: string;
}

export async function stagePackageSource(input: StagePackageSourceInput): Promise<StagePackageSourceResult> {
  validatePackageName(input.packageName);
  validatePackageVersion(input.version);
  const destination = normalizeDestination(input.destination, input.packageName, input.version);
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const metadata = await fetchCratesIoMetadata(input.packageName, input.version, fetchImpl);
  const archive = await fetchArchive(metadata.downloadUrl, fetchImpl);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== metadata.checksum) {
    throw new Error(`crates.io checksum mismatch for ${input.packageName}@${input.version}: expected ${metadata.checksum}, got ${sha256}`);
  }
  const extracted = await extractCrateArchive({
    archive,
    workspaceAbsolute: input.workspaceAbsolute,
    destination,
    expectedRoot: `${input.packageName}-${input.version}`,
  });
  const provenancePath = `metadata/crates.io/${safeSegment(input.packageName)}-${safeSegment(input.version)}.json`;
  const provenance = {
    registry: "crates.io",
    package: input.packageName,
    version: input.version,
    checksum: metadata.checksum,
    sha256,
    source: "published",
    staged_path: destination,
    files: extracted.fileCount,
    extracted_bytes: extracted.extractedBytes,
  };
  await writeWorkspaceJson(input.workspaceAbsolute, provenancePath, provenance);

  const identity = `${input.packageName}@${input.version}`;
  return {
    registry: "crates.io",
    packageName: input.packageName,
    version: input.version,
    stagedPath: destination,
    provenancePath,
    checksum: metadata.checksum,
    sha256,
    fileCount: extracted.fileCount,
    extractedBytes: extracted.extractedBytes,
    componentTemplate: {
      role: "target",
      identity,
      platform: "crates.io",
      revision: input.version,
      source: "published",
      staged_path: destination,
      in_scope: true,
      scope_basis: "first-party",
      match: "n/a",
      match_evidence: `crates.io package checksum sha256:${metadata.checksum}; provenance ${provenancePath}`,
    },
    groundTruthTemplate: {
      kind: "package",
      network: "n/a",
      chain_id: null,
      address: "",
      role: "source",
      block: input.version,
      source_match: "matched",
      evidence: `crates.io ${identity} checksum sha256:${metadata.checksum}`,
      staged_component: destination,
    },
  };
}

export async function extractCrateArchive(input: {
  archive: Buffer;
  workspaceAbsolute: string;
  destination: string;
  expectedRoot: string;
}): Promise<{ fileCount: number; extractedBytes: number }> {
  const decompressed = await gunzipAsync(input.archive);
  const entries = parseTar(decompressed);
  const root = commonRoot(entries.map((entry) => entry.path));
  const stripRoot = root === input.expectedRoot || entries.every((entry) => entry.path.startsWith(`${root}/`));
  let fileCount = 0;
  let extractedBytes = 0;
  for (const entry of entries) {
    const stripped = stripRoot ? stripFirstPathSegment(entry.path) : entry.path;
    if (!stripped) continue;
    const rel = normalizeRelativePath(path.posix.join(input.destination, stripped));
    if (!rel || !rel.startsWith(`${input.destination}/`)) throw new Error(`unsafe archive path: ${entry.path}`);
    if (entry.type === "directory") {
      await mkdir(await resolveWorkspacePathForWrite(input.workspaceAbsolute, rel), { recursive: true });
      continue;
    }
    fileCount += 1;
    extractedBytes += entry.content.byteLength;
    if (fileCount > MAX_EXTRACTED_FILES) throw new Error(`package has too many files: >${MAX_EXTRACTED_FILES}`);
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error(`package extracts too much data: >${MAX_EXTRACTED_BYTES} bytes`);
    await writeFile(await resolveWorkspacePathForWrite(input.workspaceAbsolute, rel), entry.content);
  }
  return { fileCount, extractedBytes };
}

async function fetchCratesIoMetadata(packageName: string, version: string, fetchImpl: PackageFetch): Promise<CratesIoMetadata> {
  const url = `${CRATES_IO}/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const raw = await fetchJson(url, fetchImpl);
  const versionRecord = objectRecord(objectRecord(raw)?.version);
  const checksum = asString(versionRecord?.checksum);
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`crates.io metadata for ${packageName}@${version} has no sha256 checksum`);
  const dlPath = asString(versionRecord?.dl_path);
  const downloadUrl = dlPath
    ? dlPath.startsWith("http://") || dlPath.startsWith("https://") ? dlPath : `${CRATES_IO}${dlPath}`
    : `${CRATES_IO}/api/v1/crates/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/download`;
  return { checksum: checksum.toLowerCase(), downloadUrl };
}

async function fetchJson(url: string, fetchImpl: PackageFetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: packageFetchHeaders() });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText ?? ""}: ${url}`);
  return res.json();
}

async function fetchArchive(url: string, fetchImpl: PackageFetch): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: packageFetchHeaders() });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText ?? ""}: ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_PACKAGE_BYTES) throw new Error(`package archive is too large: ${arrayBuffer.byteLength} bytes`);
  return Buffer.from(arrayBuffer);
}

function packageFetchHeaders(): Record<string, string> {
  return { "user-agent": "flounder-prepare/0.1 (+https://github.com/adshao/flounder)" };
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<PackageFetchResponse> {
  if (typeof fetch !== "function") throw new Error("fetch is not available in this Node runtime");
  return fetch(url, init) as Promise<PackageFetchResponse>;
}

function parseTar(input: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;
  while (offset + 512 <= input.length) {
    const header = input.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const typeFlag = readTarString(header, 156, 1) || "0";
    const size = parseTarSize(header);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > input.length) throw new Error("truncated tar archive");
    const content = input.subarray(contentStart, contentEnd);
    offset = contentStart + Math.ceil(size / 512) * 512;

    if (typeFlag === "L") {
      pendingLongName = stripNull(content.toString("utf8"));
      continue;
    }
    if (typeFlag === "x") {
      pendingPaxPath = parsePaxPath(content.toString("utf8"));
      continue;
    }
    if (typeFlag === "g") continue;

    const prefix = readTarString(header, 345, 155);
    const name = readTarString(header, 0, 100);
    const rawPath = pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    pendingLongName = undefined;
    pendingPaxPath = undefined;
    const safePath = safeTarPath(rawPath);
    if (!safePath) continue;
    if (typeFlag === "0" || typeFlag === "") entries.push({ path: safePath, type: "file", content: Buffer.from(content) });
    else if (typeFlag === "5") entries.push({ path: safePath, type: "directory", content: Buffer.alloc(0) });
  }
  if (entries.length === 0) throw new Error("tar archive contained no extractable files");
  return entries;
}

function readTarString(input: Buffer, start: number, length: number): string {
  const slice = input.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8").trim();
}

function parseTarSize(header: Buffer): number {
  const raw = readTarString(header, 124, 12);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid tar entry size: ${raw}`);
  return parsed;
}

function isZeroBlock(input: Buffer): boolean {
  for (const byte of input) if (byte !== 0) return false;
  return true;
}

function parsePaxPath(input: string): string | undefined {
  for (const line of input.split("\n")) {
    const match = /^\d+\s+path=(.*)$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function safeTarPath(input: string): string | undefined {
  if (!input || input.includes("\0")) return undefined;
  const normalized = path.posix.normalize(input.replaceAll("\\", "/").replace(/^\/+/, ""));
  if (!normalized || normalized === ".") return undefined;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`unsafe archive path escapes destination: ${input}`);
  }
  return normalized;
}

function commonRoot(paths: string[]): string {
  const roots = new Set(paths.map((entry) => entry.split("/")[0]).filter((entry): entry is string => Boolean(entry)));
  return roots.size === 1 ? [...roots][0] ?? "" : "";
}

function stripFirstPathSegment(input: string): string | undefined {
  const parts = input.split("/");
  if (parts.length <= 1) return undefined;
  return parts.slice(1).join("/");
}

function normalizeDestination(input: string | undefined, packageName: string, version: string): string {
  const raw = input ?? `sources/crates/${safeSegment(packageName)}-${safeSegment(version)}`;
  const normalized = normalizeRelativePath(raw);
  if (!normalized || !normalized.startsWith("sources/")) throw new Error('"destination" must be a safe relative path under sources/');
  return normalized;
}

function validatePackageName(input: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input)) throw new Error(`invalid crates.io package name: ${input}`);
}

function validatePackageVersion(input: string): void {
  if (!/^[A-Za-z0-9_.+-]{1,80}$/.test(input)) throw new Error(`invalid crates.io package version: ${input}`);
}

function safeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "package";
}

function stripNull(input: string): string {
  const idx = input.indexOf("\0");
  return idx >= 0 ? input.slice(0, idx) : input;
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

async function writeWorkspaceJson(workspaceAbsolute: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(await resolveWorkspacePathForWrite(workspaceAbsolute, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
