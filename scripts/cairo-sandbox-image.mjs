#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_SCARB_VERSION = "2.19.0";
const DEFAULT_STARKNET_FOUNDRY_VERSION = "0.62.0";
const DEFAULT_USC_VERSION = "2.9.0";

const STARKNET_FOUNDRY_SHA256 = {
  "0.49.0": {
    x86_64: "6661acb0774dc1e81de2abd08fabb2d73f27bddbce10ff6f739cbcdb8795ae79",
    aarch64: "f083666f7bdb626743dc2973d7caabea92c94814043b112cc5907b7833b53909",
  },
  "0.55.0": {
    x86_64: "a12542f28c5427a85b122784341926e1371454669d5881a315b5cab209006608",
    aarch64: "306b61ff2842abf8a9da0101a37379faa15ad63fa1b6dc4bd4b0635b24036b9e",
  },
  "0.62.0": {
    x86_64: "156a56b5d11c0d4ebc645537e2140d7a39022759663c0b981ffeb90a0ced1804",
    aarch64: "7f5def2014b83a4147949cc1870e88f09d617e52e187cf7a80980fd3bff09ab0",
  },
};

const USC_SHA256 = {
  "2.9.0": {
    x86_64: "c51bdb3fd5a544085c0b635de2431687f1decb224ff41a87be52f6afc518ab8a",
    aarch64: "845d981b7d13d8cea90110b07fec2b5212ffdb25ecee0a1c634e09689b5767b0",
  },
};

const VERSION_RE = /^[0-9]+[.][0-9]+[.][0-9]+(?:[-+._a-zA-Z0-9]+)?$/;

export function readToolVersions(target) {
  const file = findToolVersionsFile(target);
  if (!file) return { file: undefined, versions: {} };
  const versions = {};
  const content = readFileSync(file, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.replace(/[#].*$/, "").trim();
    if (!trimmed) continue;
    const [name, version] = trimmed.split(/\s+/, 2);
    if (name && version) versions[name] = version;
  }
  return { file, versions };
}

export function buildCairoSandboxSpec(input = {}) {
  const target = input.target ?? process.cwd();
  const { file, versions } = readToolVersions(target);
  const scarbVersion = requireVersion(input.scarbVersion ?? versions.scarb ?? DEFAULT_SCARB_VERSION, "Scarb");
  const starknetFoundryVersion = requireVersion(input.starknetFoundryVersion ?? versions["starknet-foundry"] ?? DEFAULT_STARKNET_FOUNDRY_VERSION, "Starknet Foundry");
  const uscVersion = requireVersion(input.universalSierraCompilerVersion ?? versions["universal-sierra-compiler"] ?? DEFAULT_USC_VERSION, "universal-sierra-compiler");

  const sfChecksums = completeChecksums(
    "Starknet Foundry",
    starknetFoundryVersion,
    STARKNET_FOUNDRY_SHA256[starknetFoundryVersion],
    input.starknetFoundrySha256,
  );
  const uscChecksums = completeChecksums(
    "universal-sierra-compiler",
    uscVersion,
    USC_SHA256[uscVersion],
    input.universalSierraCompilerSha256,
  );
  const image = input.tag ?? `flounder-sandbox:cairo-scarb-${scarbVersion}-snfoundry-${starknetFoundryVersion}`;
  const runtime = input.runtime ?? "docker";
  if (runtime !== "docker" && runtime !== "container") {
    throw new Error(`Unsupported runtime "${runtime}". Use docker or container.`);
  }

  const root = path.resolve(input.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const dockerfile = path.join(root, "docker", "flounder-sandbox-cairo.Dockerfile");
  const program = runtime;
  const args = [
    "build",
    "-f", dockerfile,
    "-t", image,
    "--build-arg", `SCARB_VERSION=${scarbVersion}`,
    "--build-arg", `STARKNET_FOUNDRY_VERSION=${starknetFoundryVersion}`,
    "--build-arg", `STARKNET_FOUNDRY_X86_64_SHA256=${sfChecksums.x86_64}`,
    "--build-arg", `STARKNET_FOUNDRY_AARCH64_SHA256=${sfChecksums.aarch64}`,
    "--build-arg", `UNIVERSAL_SIERRA_COMPILER_VERSION=${uscVersion}`,
    "--build-arg", `UNIVERSAL_SIERRA_COMPILER_X86_64_SHA256=${uscChecksums.x86_64}`,
    "--build-arg", `UNIVERSAL_SIERRA_COMPILER_AARCH64_SHA256=${uscChecksums.aarch64}`,
    root,
  ];

  return {
    image,
    runtime,
    program,
    args,
    dockerfile,
    context: root,
    toolVersionsFile: file,
    versions: {
      scarb: scarbVersion,
      "starknet-foundry": starknetFoundryVersion,
      "universal-sierra-compiler": uscVersion,
    },
  };
}

function findToolVersionsFile(target) {
  let current = path.resolve(target);
  if (existsSync(current) && !isDirectory(current)) current = path.dirname(current);
  while (true) {
    const candidate = path.join(current, ".tool-versions");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isDirectory(value) {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function requireVersion(value, label) {
  if (!VERSION_RE.test(value)) throw new Error(`${label} version "${value}" is not a supported release version string.`);
  return value;
}

function completeChecksums(label, version, known, override) {
  const x86_64 = override?.x86_64 ?? known?.x86_64;
  const aarch64 = override?.aarch64 ?? known?.aarch64;
  if (!x86_64 || !aarch64) {
    throw new Error(`${label} ${version} is not in the reviewed checksum table. Pass both --${checksumFlagPrefix(label)}-sha256-x86_64 and --${checksumFlagPrefix(label)}-sha256-aarch64 after verifying the official release assets.`);
  }
  return { x86_64, aarch64 };
}

function checksumFlagPrefix(label) {
  return label === "Starknet Foundry" ? "starknet-foundry" : "universal-sierra-compiler";
}

function parseArgs(argv) {
  const out = {
    execute: false,
    runtime: "docker",
    starknetFoundrySha256: {},
    universalSierraCompilerSha256: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      return value;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--execute") out.execute = true;
    else if (arg === "--dry-run") out.execute = false;
    else if (arg === "--target") out.target = next();
    else if (arg === "--tag") out.tag = next();
    else if (arg === "--runtime") out.runtime = next();
    else if (arg === "--scarb-version") out.scarbVersion = next();
    else if (arg === "--starknet-foundry-version") out.starknetFoundryVersion = next();
    else if (arg === "--universal-sierra-compiler-version") out.universalSierraCompilerVersion = next();
    else if (arg === "--starknet-foundry-sha256-x86_64") out.starknetFoundrySha256.x86_64 = next();
    else if (arg === "--starknet-foundry-sha256-aarch64") out.starknetFoundrySha256.aarch64 = next();
    else if (arg === "--universal-sierra-compiler-sha256-x86_64") out.universalSierraCompilerSha256.x86_64 = next();
    else if (arg === "--universal-sierra-compiler-sha256-aarch64") out.universalSierraCompilerSha256.aarch64 = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`Usage: node scripts/cairo-sandbox-image.mjs --target <dir> [--runtime docker|container] [--execute]\n\nBuilds a reviewed Cairo/Starknet sandbox image from .tool-versions pins. Without --execute it prints the exact command as JSON.`);
    return;
  }
  const spec = buildCairoSandboxSpec(options);
  if (!options.execute) {
    console.log(JSON.stringify({ ...spec, command: [spec.program, ...spec.args] }, null, 2));
    return;
  }
  const child = spawn(spec.program, spec.args, { stdio: "inherit", cwd: spec.context });
  const code = await new Promise((resolve) => child.on("close", resolve));
  process.exitCode = typeof code === "number" ? code : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
