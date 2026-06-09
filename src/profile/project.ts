import type { Doc, ProjectProfile } from "../types.js";

export function profileProject(docs: Doc[]): ProjectProfile {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const manifests = new Set<string>();
  const likelySecurityDomains = new Set<string>();
  const entrypoints = new Set<string>();
  const notes = new Set<string>();

  for (const doc of docs) {
    const lowerPath = doc.path.toLowerCase();
    const lowerContent = doc.content.toLowerCase();
    const ext = lowerPath.split(".").at(-1) ?? "";
    detectLanguage(ext, lowerPath, languages);
    detectManifest(lowerPath, manifests, packageManagers);
    detectFrameworks(lowerPath, lowerContent, frameworks);
    detectSecurityDomains(lowerPath, lowerContent, likelySecurityDomains);
    detectEntrypoints(lowerPath, lowerContent, entrypoints);
  }

  if (languages.size === 0) notes.add("No dominant implementation language detected from loaded files.");
  if (likelySecurityDomains.size === 0) notes.add("No specialized security domain detected; use general application and dependency audit lenses.");

  return {
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    manifests: [...manifests].sort(),
    likelySecurityDomains: [...likelySecurityDomains].sort(),
    entrypoints: [...entrypoints].sort().slice(0, 40),
    notes: [...notes].sort(),
  };
}

export function renderProjectProfile(profile: ProjectProfile): string {
  return [
    `Languages: ${join(profile.languages)}`,
    `Frameworks: ${join(profile.frameworks)}`,
    `Package managers: ${join(profile.packageManagers)}`,
    `Manifests: ${join(profile.manifests)}`,
    `Likely security domains: ${join(profile.likelySecurityDomains)}`,
    `Entrypoints: ${join(profile.entrypoints)}`,
    `Notes: ${join(profile.notes)}`,
  ].join("\n");
}

function detectLanguage(ext: string, path: string, out: Set<string>): void {
  const byExt: Record<string, string> = {
    rs: "Rust",
    sol: "Solidity",
    go: "Go",
    py: "Python",
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    java: "Java",
    kt: "Kotlin",
    kts: "Kotlin",
    swift: "Swift",
    rb: "Ruby",
    php: "PHP",
    c: "C",
    cc: "C++",
    cpp: "C++",
    h: "C/C++",
    hpp: "C++",
    move: "Move",
    cairo: "Cairo",
    circom: "Circom",
    vy: "Vyper",
    ex: "Elixir",
    exs: "Elixir",
    cs: "C#",
    fs: "F#",
    scala: "Scala",
    dart: "Dart",
    lua: "Lua",
    sh: "Shell",
    bash: "Shell",
    sql: "SQL",
    proto: "Protocol Buffers",
    graphql: "GraphQL",
    gql: "GraphQL",
    tf: "Terraform",
    hcl: "HCL",
    rego: "Rego",
    json: "JSON",
    jsonc: "JSON",
    toml: "TOML",
    yml: "YAML",
    yaml: "YAML",
    xml: "XML",
    gradle: "Gradle",
  };
  const language = byExt[ext];
  if (language) out.add(language);
  if (path.endsWith("dockerfile")) out.add("Dockerfile");
}

function detectManifest(path: string, manifests: Set<string>, packageManagers: Set<string>): void {
  const base = path.split("/").at(-1) ?? path;
  const known: Record<string, [string, string]> = {
    "package.json": ["Node package manifest", "npm/yarn/pnpm"],
    "package-lock.json": ["npm lockfile", "npm"],
    "bun.lockb": ["Bun lockfile", "bun"],
    "bun.lock": ["Bun lockfile", "bun"],
    "deno.json": ["Deno manifest", "deno"],
    "deno.jsonc": ["Deno manifest", "deno"],
    "pnpm-lock.yaml": ["pnpm lockfile", "pnpm"],
    "yarn.lock": ["Yarn lockfile", "yarn"],
    "cargo.toml": ["Rust package manifest", "cargo"],
    "cargo.lock": ["Cargo lockfile", "cargo"],
    "scarb.toml": ["Scarb package manifest", "scarb"],
    "scarb.lock": ["Scarb lockfile", "scarb"],
    "go.mod": ["Go module manifest", "go"],
    "go.sum": ["Go checksum file", "go"],
    "pyproject.toml": ["Python project manifest", "pip/poetry/uv"],
    "requirements.txt": ["Python requirements", "pip"],
    "uv.lock": ["uv lockfile", "uv"],
    "poetry.lock": ["Poetry lockfile", "poetry"],
    "pipfile": ["Pipenv manifest", "pipenv"],
    "pom.xml": ["Maven manifest", "maven"],
    "build.gradle": ["Gradle build", "gradle"],
    "composer.json": ["PHP Composer manifest", "composer"],
    "gemfile": ["Ruby bundle manifest", "bundler"],
    "mix.exs": ["Elixir Mix manifest", "mix"],
    "foundry.toml": ["Foundry manifest", "foundry"],
    "remappings.txt": ["Solidity remappings", "foundry/hardhat"],
    "hardhat.config.ts": ["Hardhat config", "hardhat"],
    "hardhat.config.js": ["Hardhat config", "hardhat"],
    "hardhat.config.cjs": ["Hardhat config", "hardhat"],
    "hardhat.config.mjs": ["Hardhat config", "hardhat"],
    "slither.config.json": ["Slither config", "slither"],
    "echidna.yaml": ["Echidna config", "echidna"],
    "echidna.yml": ["Echidna config", "echidna"],
    "medusa.json": ["Medusa config", "medusa"],
  };
  const hit = known[base];
  if (hit) {
    manifests.add(hit[0]);
    packageManagers.add(hit[1]);
  }
  if (base.endsWith(".csproj")) {
    manifests.add(".NET project file");
    packageManagers.add("dotnet");
  }
}

function detectFrameworks(path: string, content: string, out: Set<string>): void {
  const text = `${path}\n${content}`;
  if (/(react|next\/|nextjs|next\.config|"next"\s*:)/.test(text)) out.add("React/Next.js");
  if (/(vue|nuxt)/.test(text)) out.add("Vue/Nuxt");
  if (/(express|fastify|koa|nestjs)/.test(text)) out.add("Node HTTP API");
  if (/(django|flask|fastapi)/.test(text)) out.add("Python web API");
  if (/(actix|axum|rocket|warp)/.test(text)) out.add("Rust web API");
  if (/(springframework|spring boot)/.test(text)) out.add("Spring");
  if (/(phoenix|plug\.router|liveview)/.test(text)) out.add("Phoenix/Plug");
  if (/(aspnetcore|microsoft\.aspnetcore)/.test(text)) out.add("ASP.NET Core");
  if (/(tokio|async-std)/.test(text)) out.add("Rust async runtime");
  if (/(halo2|constraintsystem|assign_advice|copy_advice)/.test(text)) out.add("Halo2/constraint system");
  if (/(#\[starknet::contract\]|#\[l1_handler\]|starknet::syscalls|scarb\.toml|func\s+[a-z_][a-z0-9_]*\{|%builtins)/i.test(text)) out.add("Cairo/Starknet");
  if (/(solidity|contract\s+[a-z_][a-z0-9_]*)/i.test(text)) out.add("EVM smart contract");
  if (/(foundry\.toml|forge-std|forge test|vm\.)/.test(text)) out.add("Foundry");
  if (/(hardhat\.config|@nomicfoundation\/hardhat|hardhat-deploy)/.test(text)) out.add("Hardhat");
  if (/(openzeppelin|@openzeppelin|erc20|erc721|erc1155|erc4626)/.test(text)) out.add("OpenZeppelin/ERC standards");
  if (/(transparentupgradeableproxy|uups|upgradeable|initializer|reinitializer|delegatecall|eip1967)/.test(text)) out.add("Upgradeable proxy");
  if (/(chainlink|aggregatorv3interface|latestrounddata|oracle|twap)/.test(text)) out.add("Oracle integration");
  if (/(kubernetes|helm|terraform|pulumi|cloudformation)/.test(text)) out.add("Infrastructure as code");
}

function detectSecurityDomains(path: string, content: string, out: Set<string>): void {
  const text = `${path}\n${content}`;
  if (/(halo2|constraintsystem|assign_advice|copy_advice|zero-knowledge|zk|proof)/.test(text)) out.add("zero-knowledge proof soundness");
  if (/(solidity|delegatecall|reentrancy|erc20|erc721|msg\.sender)/.test(text)) out.add("smart contract security");
  if (/(vault|erc4626|amm|swap|pool|liquidat|borrow|lend|collateral|staking|reward|share|slippage)/.test(text)) out.add("DeFi economic and accounting security");
  if (/(proxy|upgradeable|initializer|reinitializer|delegatecall|eip1967|storage gap|__gap)/.test(text)) out.add("smart contract upgradeability and storage safety");
  if (/(oracle|latestrounddata|twap|pricefeed|sequencer|flashloan|mev|sandwich|slippage)/.test(text)) out.add("oracle and market manipulation risk");
  if (/(permit|eip712|domain_separator|nonces?|ecrecover|ecdsa\.recover)/.test(text)) out.add("EVM signature and permit replay security");
  if (/(bridge|cross[- ]?chain|chainid|lzendpoint|wormhole|ccip|message root|merkle proof)/.test(text)) out.add("cross-chain message and bridge security");
  if (/(starknet|cairo|l1_handler|send_message_to_l1|class_hash|contract_state_changes|os_output|state_update)/.test(text)) out.add("Starknet state transition and bridge security");
  if (/(jwt|oauth|session|cookie|password|login|auth)/.test(text)) out.add("authentication and session security");
  if (/(sql|query|postgres|mysql|sqlite|mongodb)/.test(text)) out.add("data access and injection risk");
  if (/(fetch|httpclient|requests\.|urllib|webhook|callback url|proxy)/.test(text)) out.add("server-side request and proxy safety");
  if (/(path\.join|readfile|writefile|open\(|sendfile|archive|zip|tar|upload)/.test(text)) out.add("file path and upload safety");
  if (/(deserialize|unmarshal|pickle|yaml\.load|objectinputstream|msgpack|protobuf)/.test(text)) out.add("deserialization and parser safety");
  if (/(signature|ecrecover|verify_signature|ed25519|secp256k1)/.test(text)) out.add("signature and replay security");
  if (/(balance|supply|mint|burn|transfer|withdraw|deposit|ledger)/.test(text)) out.add("accounting and value conservation");
  if (/(consensus|block|transaction|mempool|p2p|network upgrade)/.test(text)) out.add("consensus and protocol safety");
  if (/(tenant|workspace|organization|role|admin|permission|policy)/.test(text)) out.add("authorization and tenant isolation");
  if (/(api[_-]?key|secret|token|credential|private key|dotenv|env\.)/.test(text)) out.add("secret handling");
  if (/(lock|mutex|race|concurrent|parallel|queue|retry|idempot)/.test(text)) out.add("concurrency and idempotency");
}

function detectEntrypoints(path: string, content: string, out: Set<string>): void {
  if (/\b(fn|function|def)\s+(main|handler|route|verify|prove|transfer|withdraw|deposit|mint|burn|spend)\b/i.test(content)) {
    out.add(path);
  }
  if (path.endsWith(".sol") && /\bfunction\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*[^;{]*\b(public|external)\b/.test(content)) {
    out.add(path);
  }
  if (path.endsWith(".cairo") && /(#\[starknet::contract\]|#\[l1_handler\]|\bpub\s+mod\s+|\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*\()/i.test(content)) {
    out.add(path);
  }
  if (/(server|router|controller|handler|contract|circuit|chip|gadget)/i.test(path)) {
    out.add(path);
  }
}

function join(values: string[]): string {
  return values.length === 0 ? "(none detected)" : values.join(", ");
}
