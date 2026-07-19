export interface CommandSafetyPolicy {
  liveNetworkPatterns: RegExp[];
  highRiskActionPatterns: RegExp[];
  message: string;
}

export interface CommandSafetyDecision {
  blocked: boolean;
  reason?: string;
  matchedNetwork?: string;
  matchedAction?: string;
}

export interface StructuredReproductionCommand {
  program: string;
  args: string[];
}

export type AgentCommandPurpose = "inspect" | "build" | "confirm";

export const DEFAULT_COMMAND_SAFETY_POLICY: CommandSafetyPolicy = {
  liveNetworkPatterns: [
    /\bmainnet\b/i,
    /\bmain\s*net\b/i,
    /\btestnet\b/i,
    /\btest\s*net\b/i,
    /\blivenet\b/i,
    /\blive\s*network\b/i,
    /\bproduction\b/i,
    /\bprod\b/i,
    /\bpublic\s+rpc\b/i,
  ],
  highRiskActionPatterns: [
    /\bsendrawtransaction\b/i,
    /\bsubmit(?:transaction|tx|block)?\b/i,
    /\bbroadcast\b/i,
    /\btransfer\b/i,
    /\bwithdraw\b/i,
    /\bdrain\b/i,
    /\bmint\b/i,
    /\bexploit\b/i,
    /\bpoc\b/i,
  ],
  message:
    "Blocked by flounder white-hat guardrail: verification must stay local-only and must not broadcast to public networks.",
};

export function analyzeCommandSafety(
  command: string,
  policy: CommandSafetyPolicy = DEFAULT_COMMAND_SAFETY_POLICY,
): CommandSafetyDecision {
  const matchedNetwork = findMatch(command, policy.liveNetworkPatterns);
  const matchedAction = findMatch(command, policy.highRiskActionPatterns);
  if (!matchedNetwork || !matchedAction) return { blocked: false };
  return {
    blocked: true,
    reason: policy.message,
    matchedNetwork,
    matchedAction,
  };
}

export function analyzeReproductionCommandSafety(command: StructuredReproductionCommand): CommandSafetyDecision {
  const baseDecision = analyzeStructuredCommandBaseSafety(command);
  if (baseDecision.blocked) return baseDecision;

  if (!isAllowedLocalTestCommand(command.program.trim(), command.args.map((arg) => String(arg)))) {
    return {
      blocked: true,
      reason: "Blocked by flounder guardrail: reproduction execution is limited to local test commands.",
    };
  }

  return { blocked: false };
}

export function analyzeAgentBashCommandSafety(command: StructuredReproductionCommand): CommandSafetyDecision {
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) {
    return {
      blocked: true,
      reason: "Blocked by flounder guardrail: env wrappers may only set simple local environment variables before an allowed command.",
    };
  }

  const baseDecision = analyzeStructuredCommandBaseSafety(normalized);
  if (baseDecision.blocked) return baseDecision;

  const program = normalized.program.trim();
  const args = normalized.args.map((arg) => String(arg));
  const workspaceDecision = analyzeWorkspacePathSafety(args);
  if (workspaceDecision.blocked) return workspaceDecision;

  if (
    isAllowedLocalTestCommand(program, args) ||
    isAllowedLocalInspectionCommand(program, args) ||
    isAllowedBuildCommand(program, args) ||
    isAllowedWorkspaceSetupCommand(program, args)
  ) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason:
      "Blocked by flounder guardrail: agent bash is limited to local inspection, build/dependency, and local test commands.",
  };
}

/**
 * True only for an allowlisted local test/build runner — the kind of command that
 * may upgrade a finding to confirmed-executable. Inspection commands (cat, rg,
 * ls, …) are deliberately excluded so a model cannot mint executable confirmation
 * by printing a success pattern from a file it wrote itself.
 */
export function isAgentConfirmCommand(command: StructuredReproductionCommand): boolean {
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) return false;
  return isAllowedLocalTestCommand(normalized.program.trim(), normalized.args.map((arg) => String(arg)));
}

/**
 * True for an allowlisted build / dependency-resolution command (cargo build,
 * cmake -S/-B/--build, ninja, npm install, go mod download, forge build, pip install, …). These are the
 * "prepare/build phase": they may need a package registry to fetch dependencies,
 * which is categorically different from the exploit/confirm run. They are NOT
 * confirmation-eligible — a build can never upgrade a finding (only isAgentConfirmCommand can).
 */
export function isAgentBuildCommand(command: StructuredReproductionCommand): boolean {
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) return false;
  return isAllowedBuildCommand(normalized.program.trim(), normalized.args.map((arg) => String(arg)));
}

/** True for a read-only local inspection command. Callers use this distinction
 * to run discovery against an authorized source view instead of a wider build root. */
export function isAgentInspectionCommand(command: StructuredReproductionCommand): boolean {
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) return false;
  return isAllowedLocalInspectionCommand(normalized.program.trim(), normalized.args.map((arg) => String(arg)));
}

/** Workspace setup is safe from shell injection, but it is not read-only. Sealed
 * discovery routes these mutations through write/edit so hidden build-root files
 * cannot be copied into the model-visible source view. */
export function isAgentWorkspaceSetupCommand(command: StructuredReproductionCommand): boolean {
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) return false;
  return isAllowedWorkspaceSetupCommand(normalized.program.trim(), normalized.args.map((arg) => String(arg)));
}

/**
 * Verbs that PUSH a transaction/block to a network (as opposed to reading/forking
 * it). The confirm-mode white-hat line is "fork and READ live networks freely, but
 * never BROADCAST to one" — so these are blocked only when their target is non-local
 * (replaying the exploit against a LOCAL fork is exactly what reproduction needs).
 * A small, domain-free safety denylist, not a per-ecosystem recipe.
 */
export const CONFIRM_BROADCAST_PATTERNS: RegExp[] = [
  /\bcast\s+send\b/i,
  /--broadcast\b/i,
  /\bsend-?raw-?transaction\b/i,
  /\beth_send(?:raw)?transaction\b/i,
  /\bsendtransaction\b/i,
  /\bsubmit(?:raw)?(?:transaction|tx|block)\b/i,
  /\bpublish(?:raw)?(?:transaction|tx|block)\b/i,
  /\bbroadcast(?:tx|transaction)?\b/i,
];

/**
 * CONFIRM-mode bash policy: the open-world counterpart to analyzeAgentBashCommandSafety.
 * It KEEPS the structural guards (plain program name, simple argv, workspace-contained
 * paths) and the white-hat no-broadcast line, while allowing the model to choose the
 * local tooling needed for reproduction. Network egress is decided separately by
 * openWorldCommandNeedsNetwork: only an explicit read/fork/fetch capability surface is
 * network-enabled; arbitrary accepted programs still execute in a sealed sandbox.
 */
export function analyzeConfirmBashCommandSafety(command: StructuredReproductionCommand): CommandSafetyDecision {
  const program = command.program.trim();
  const args = command.args.map((arg) => String(arg));
  if (program.length === 0 || program.includes("/") || program.includes("\\") || /[\s;&|`$<>]/.test(program)) {
    return { blocked: true, reason: "Blocked by flounder guardrail: confirm commands must use a plain program name (no shell operators)." };
  }
  if (args.some((arg) => /[\0\r\n]/.test(arg))) {
    return { blocked: true, reason: "Blocked by flounder guardrail: confirm command arguments must be simple argv entries." };
  }
  const effective = program.toLowerCase() === "env" ? unwrapSafeEnvCommand(command) : command;
  if (!effective) {
    return {
      blocked: true,
      reason: "Blocked by flounder guardrail: env wrappers cannot override executable lookup, runtime injection, or sandbox safety settings.",
    };
  }
  const workspaceDecision = analyzeWorkspacePathSafety(args);
  if (workspaceDecision.blocked) return workspaceDecision;
  const effectiveProgram = effective.program.trim();
  const effectiveArgs = effective.args.map((arg) => String(arg));
  const destructiveDecision = analyzeDestructiveFilesystemCommandSafety(effectiveProgram, effectiveArgs);
  if (destructiveDecision.blocked) return destructiveDecision;
  const inlineFileDecision = analyzeInlineGeneratedFileWriteSafety(effectiveProgram, effectiveArgs);
  if (inlineFileDecision.blocked) return inlineFileDecision;
  const rendered = [effectiveProgram, ...effectiveArgs].join(" ");
  const broadcast = findMatch(rendered, CONFIRM_BROADCAST_PATTERNS);
  if (broadcast && targetsNonLocalNetwork(effectiveArgs)) {
    return {
      blocked: true,
      reason:
        "Blocked by flounder white-hat guardrail: confirm may FORK and READ a live network, but must never BROADCAST a transaction to one. Replay the exploit against a LOCAL fork (anvil/local RPC), not the live network.",
      matchedAction: broadcast,
    };
  }
  return { blocked: false };
}

/**
 * Open-world phases do not grant blanket network access to model-selected code.
 * Only a small capability surface of read/fork/fetch commands receives egress;
 * every other accepted command still runs, but in the network-sealed sandbox.
 * This makes lexical command checks defense-in-depth rather than the boundary.
 */
export function openWorldCommandNeedsNetwork(command: StructuredReproductionCommand, purpose: AgentCommandPurpose): boolean {
  // Egress is attached to the exact executable the sandbox launches. Even a
  // benign-looking env assignment can change a tool's implicit config or runtime
  // behavior, so wrapped commands remain network-sealed. Call the allowlisted
  // tool directly when it needs read/fork/fetch access; sandboxEnv owns the
  // dependency-cache and safety variables.
  if (command.program.trim().toLowerCase() === "env") return false;
  const normalized = unwrapSafeEnvCommand(command);
  if (!normalized) return false;
  const program = normalized.program.trim().toLowerCase();
  const args = normalized.args.map((arg) => String(arg));
  if (purpose === "build" && isAllowedBuildCommand(program, args)) return true;
  if (program === "curl") return isReadOnlyCurl(args);
  if (program === "wget") return isReadOnlyWget(args);
  if (program === "git") return isReadOnlyGitNetworkCommand(args);
  if (program === "gh") return isReadOnlyGitHubCommand(args);
  if (program === "cast") return isReadOnlyCastCommand(args);
  if (program === "forge") return isReadOnlyForgeForkCommand(args);
  if (program === "anvil") return hasRemoteForkTarget(args) && !args.some((arg) => /broadcast|transaction/i.test(arg));
  return false;
}

function isReadOnlyCurl(args: string[]): boolean {
  const forbiddenLong = /^--(?:data(?:-|=|$)|form(?:-|=|$)|upload-file(?:=|$)|json(?:=|$)|url-query(?:=|$)|config(?:=|$)|header(?:=|$)|proto(?:-|=|$)|next$)/i;
  if (args.some((arg) => forbiddenLong.test(arg))) return false;
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    const short = /^-[^-]/.test(arg) ? arg.slice(1) : "";
    // curl permits boolean flags to prefix an attached value-taking option
    // (for example -sTfile or -sXPOST). Reject those ambiguous bundles.
    if (/[dFHTK]/.test(short)) return false;
    const xIndex = short.indexOf("X");
    if (xIndex > 0) return false;
    const method = arg === "-X" || arg === "--request"
      ? args[idx + 1]
      : xIndex === 0 && short.length > 1
        ? short.slice(1)
        : /^--request=/i.test(arg)
          ? arg.slice(arg.indexOf("=") + 1)
          : undefined;
    if (method && !/^(?:GET|HEAD)$/i.test(method)) return false;
  }
  return hasOnlyHttpRemoteTargets(args);
}

function isReadOnlyWget(args: string[]): boolean {
  if (args.some((arg) =>
    /^(?:--post-|--method(?:=|$)|--body-|--upload-file(?:=|$)|--execute(?:=|$)|--config(?:=|$)|--header(?:=|$)|--input-file(?:=|$))/i.test(arg)
    || (/^-[^-]/.test(arg) && /[ei]/.test(arg.slice(1)))
  )) return false;
  return hasOnlyHttpRemoteTargets(args);
}

function isReadOnlyGitNetworkCommand(args: string[]): boolean {
  const verb = args[0];
  if (verb !== "clone" && verb !== "fetch" && verb !== "ls-remote") return false;
  if (args.some((arg) => arg.includes("::"))) return false;
  if (args.slice(1).some((arg) => arg.startsWith("-") && !isSafeGitReadOption(arg))) return false;
  const remoteArgs = args.slice(1).filter((arg) => !arg.startsWith("-"));
  if (remoteArgs.some((arg) => looksLikeNonHttpsGitRemote(arg))) return false;
  return remoteArgs.filter(isHttpsGitRemote).length === 1;
}

function isSafeGitReadOption(arg: string): boolean {
  return arg === "-q"
    || arg === "-v"
    || arg === "--quiet"
    || arg === "--verbose"
    || arg === "--progress"
    || arg === "--no-progress"
    || arg === "--depth"
    || /^--depth=[1-9][0-9]*$/.test(arg)
    || arg === "--single-branch"
    || arg === "--no-single-branch"
    || arg === "--no-tags"
    || arg === "--no-checkout"
    || arg === "--heads"
    || arg === "--tags"
    || arg === "--refs"
    || arg === "--exit-code"
    || arg === "--symref";
}

function looksLikeNonHttpsGitRemote(arg: string): boolean {
  if (isHttpsGitRemote(arg)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(arg) || /^[^@\s]+@[^:\s]+:/.test(arg);
}

function isHttpsGitRemote(arg: string): boolean {
  try {
    const url = new URL(arg);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isReadOnlyGitHubCommand(args: string[]): boolean {
  if (args.includes("--web")) return false;
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    const short = /^-[^-]/.test(arg) ? arg.slice(1) : "";
    if (/[fF]/.test(short)) return false;
    const xIndex = short.indexOf("X");
    if (xIndex > 0) return false;
    const method = arg === "--method" || arg === "-X"
      ? args[idx + 1]
      : xIndex === 0 && short.length > 1
        ? short.slice(1)
        : /^--method=/i.test(arg)
          ? arg.slice(arg.indexOf("=") + 1)
          : undefined;
    if (method && !/^(?:GET|HEAD)$/i.test(method)) return false;
  }
  const verb = args[0];
  const subcommand = args[1];
  if (verb === "search") return new Set(["code", "commits", "issues", "prs", "repos"]).has(subcommand ?? "");
  if (verb === "api") return !args.some((arg) => /^--(?:field|raw-field|input)(?:=|$)/i.test(arg));
  // `gh repo clone` delegates to Git and inherits its implicit configuration.
  // Use the directly hardened `git clone https://...` capability instead.
  if (verb === "repo") return subcommand === "view";
  if (verb === "issue" || verb === "pr" || verb === "release") return subcommand === "list" || subcommand === "view";
  return false;
}

function hasOnlyHttpRemoteTargets(args: string[]): boolean {
  let found = false;
  for (const arg of args) {
    for (const match of arg.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/[^\s"'`<>\\]+/gi)) {
      const protocol = match[1]?.toLowerCase();
      if (protocol !== "http" && protocol !== "https") return false;
      const target = match[0];
      if (target && !isLocalUrl(target)) found = true;
    }
  }
  return found;
}

function isReadOnlyCastCommand(args: string[]): boolean {
  const verb = args.find((arg) => !arg.startsWith("-"));
  const readOnly = new Set(["call", "balance", "code", "storage", "block", "block-number", "logs", "receipt", "tx", "chain-id", "client", "gas-price", "nonce"]);
  return Boolean(verb && readOnly.has(verb) && targetsNonLocalNetwork(args));
}

function isReadOnlyForgeForkCommand(args: string[]): boolean {
  const verb = args.find((arg) => !arg.startsWith("-"));
  return verb === "test"
    && hasRemoteForkTarget(args)
    && !args.some((arg) => arg === "--ffi" || arg.startsWith("--ffi=") || arg === "--broadcast" || /send-?raw-?transaction/i.test(arg));
}

function hasRemoteForkTarget(args: string[]): boolean {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    if (arg === "--fork-url" && firstNonLocalRemoteUrl(args[idx + 1] ?? "")) return true;
    if (arg.startsWith("--fork-url=") && firstNonLocalRemoteUrl(arg.slice("--fork-url=".length))) return true;
  }
  return false;
}

function analyzeInlineGeneratedFileWriteSafety(program: string, args: string[]): CommandSafetyDecision {
  const payload = inlineCommandPayload(program, args);
  if (!payload) return { blocked: false };
  const matchedNetwork = firstNonLocalRemoteUrl(payload);
  if (!matchedNetwork) return { blocked: false };
  const matchedAction = firstInlineWriteTarget(payload);
  if (!matchedAction) return { blocked: false };
  return {
    blocked: true,
    reason: `Blocked by flounder guardrail: generated test file ${matchedAction} must not reference remote URLs.`,
    matchedNetwork,
    matchedAction,
  };
}

function inlineCommandPayload(program: string, args: string[]): string | undefined {
  const name = program.toLowerCase();
  if (name === "python" || name === "python3" || name === "node" || name === "deno" || name === "bun") {
    for (let idx = 0; idx < args.length - 1; idx += 1) {
      const arg = args[idx];
      if (arg === "-c" || arg === "-e" || arg === "--eval") return args[idx + 1];
    }
  }
  if (name === "sh" || name === "bash" || name === "zsh") {
    for (let idx = 0; idx < args.length - 1; idx += 1) {
      const arg = args[idx] ?? "";
      if (arg === "-c" || /^[+-]?[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return args[idx + 1];
    }
  }
  return undefined;
}

function firstInlineWriteTarget(payload: string): string | undefined {
  const patterns = [
    /\bopen\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wa+][^"']*["']/g,
    /\b(?:Path|pathlib\.Path)\(\s*["']([^"']+)["']\s*\)\.write_(?:text|bytes)\s*\(/g,
    /\b(?:fs\.)?(?:writeFile|writeFileSync)\(\s*["']([^"']+)["']/g,
    />\s*([A-Za-z0-9._/+:-]*(?:poc|repro|harness|verify|verification|flounder)[A-Za-z0-9._/+:-]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of payload.matchAll(pattern)) {
      const target = match[1]?.trim();
      if (target) return target;
    }
  }
  return undefined;
}

function firstNonLocalRemoteUrl(input: string): string | undefined {
  for (const url of input.match(/\bhttps?:\/\/[^\s"'`<>\\]+/gi) ?? []) {
    if (!isLocalUrl(url)) return url;
  }
  return undefined;
}

/** True if any rpc/network flag points off-localhost, or a remote URL / RPC-secret reference appears in argv. */
function targetsNonLocalNetwork(args: string[]): boolean {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    const lower = arg.toLowerCase();
    const valueFromEquals = valueAfterEquals(arg);
    if (isRpcFlag(lower) || isNetworkFlag(lower)) {
      const value = valueFromEquals ?? args[idx + 1];
      if (value && !isLocalNetworkValue(value)) return true;
    }
    if (looksLikeRemoteUrl(arg) && !isLocalUrl(arg)) return true;
    if (looksLikeRpcEnvReference(arg)) return true;
  }
  return false;
}

function analyzeStructuredCommandBaseSafety(command: StructuredReproductionCommand): CommandSafetyDecision {
  const program = command.program.trim();
  const args = command.args.map((arg) => String(arg));
  const rendered = [program, ...args].join(" ");
  const liveNetworkDecision = analyzeCommandSafety(rendered);
  if (liveNetworkDecision.blocked) return liveNetworkDecision;
  const localNetworkDecision = analyzeStructuredLocalNetworkSafety(args);
  if (localNetworkDecision.blocked) return localNetworkDecision;

  if (program.length === 0 || program.includes("/") || program.includes("\\") || /[\s;&|`$<>]/.test(program)) {
    return {
      blocked: true,
      reason: "Blocked by flounder guardrail: reproduction commands must use a plain local test runner program name.",
    };
  }

  if (args.some((arg) => /[\0\r\n]/.test(arg))) {
    return {
      blocked: true,
      reason: "Blocked by flounder guardrail: reproduction command arguments must be simple argv entries.",
    };
  }
  const destructiveDecision = analyzeDestructiveFilesystemCommandSafety(program, args);
  if (destructiveDecision.blocked) return destructiveDecision;

  return { blocked: false };
}

function unwrapSafeEnvCommand(command: StructuredReproductionCommand): StructuredReproductionCommand | undefined {
  let current: StructuredReproductionCommand = {
    program: command.program.trim(),
    args: command.args.map((arg) => String(arg)),
  };
  while (current.program.toLowerCase() === "env") {
    const args = current.args.map((arg) => String(arg));
    let index = 0;
    for (; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) break;
      if (!isSafeEnvAssignment(arg)) return undefined;
    }
    const wrappedProgram = args[index];
    if (!wrappedProgram) return undefined;
    if (wrappedProgram.startsWith("-") || wrappedProgram.includes("/") || wrappedProgram.includes("\\") || /[\s;&|`$<>]/.test(wrappedProgram)) return undefined;
    current = { program: wrappedProgram, args: args.slice(index + 1) };
  }
  return current;
}

function isSafeEnvAssignment(arg: string): boolean {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
  if (!match) return false;
  if (isSecuritySensitiveEnvName(match[1] ?? "")) return false;
  const value = match[2] ?? "";
  if (/[\0\r\n;&|`<>]/.test(value)) return false;
  if (looksLikeRpcEnvReference(value)) return false;
  if (looksLikeRemoteUrl(value) && !isLocalUrl(value)) return false;
  if (looksLikePathEscape(value)) return false;
  return true;
}

const SECURITY_SENSITIVE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "FOUNDRY_FFI",
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "GIT_EXEC_PATH",
  "GIT_CONFIG",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "CURL_HOME",
  "WGETRC",
]);

function isSecuritySensitiveEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECURITY_SENSITIVE_ENV_NAMES.has(upper)) return true;
  return upper.startsWith("DYLD_") || upper.startsWith("LD_") || upper.startsWith("GIT_CONFIG_");
}

function analyzeWorkspacePathSafety(args: string[]): CommandSafetyDecision {
  for (const arg of args) {
    const value = valueAfterEquals(arg) ?? arg;
    if (looksLikePathEscape(value)) {
      return {
        blocked: true,
        reason: "Blocked by flounder guardrail: agent bash paths must stay inside the copied workspace.",
        matchedAction: arg,
      };
    }
  }
  return { blocked: false };
}

function analyzeDestructiveFilesystemCommandSafety(program: string, args: string[]): CommandSafetyDecision {
  const name = program.toLowerCase();
  const lower = args.map((arg) => arg.toLowerCase());
  const block = (matchedAction: string): CommandSafetyDecision => ({
    blocked: true,
    reason: "Blocked by flounder guardrail: destructive filesystem commands are not allowed in agent bash.",
    matchedAction,
  });

  if (["rm", "rmdir", "unlink", "shred"].includes(name)) return block(name);
  if (name === "find" && lower.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
    return block("find");
  }
  if (name === "sed" && lower.some((arg) => arg === "-i" || arg.startsWith("-i.") || arg === "--in-place" || arg.startsWith("--in-place="))) {
    return block("sed");
  }
  if (name === "git") {
    if (lower.includes("clean")) return block("git clean");
    if (lower.includes("reset") && lower.includes("--hard")) return block("git reset --hard");
  }

  return { blocked: false };
}

function analyzeStructuredLocalNetworkSafety(args: string[]): CommandSafetyDecision {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    const lower = arg.toLowerCase();
    const valueFromEquals = valueAfterEquals(arg);
    if (isRpcFlag(lower)) {
      const value = valueFromEquals ?? args[idx + 1];
      if (!value || !isLocalNetworkValue(value)) {
        return {
          blocked: true,
          reason: "Blocked by flounder guardrail: reproduction RPC and fork targets must be local-only.",
          matchedAction: arg,
        };
      }
    }
    if (isNetworkFlag(lower)) {
      const value = valueFromEquals ?? args[idx + 1];
      if (value && !isLocalNetworkValue(value)) {
        return {
          blocked: true,
          reason: "Blocked by flounder guardrail: reproduction network targets must be local-only.",
          matchedAction: arg,
          matchedNetwork: value,
        };
      }
    }
    if (looksLikeRemoteUrl(arg) && !isLocalUrl(arg)) {
      return {
        blocked: true,
        reason: "Blocked by flounder guardrail: reproduction commands must not use remote RPC URLs.",
        matchedNetwork: arg,
      };
    }
    if (looksLikeRpcEnvReference(arg)) {
      return {
        blocked: true,
        reason: "Blocked by flounder guardrail: reproduction commands must not depend on RPC or secret environment references.",
        matchedNetwork: arg,
      };
    }
  }
  return { blocked: false };
}

function findMatch(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

function isAllowedLocalTestCommand(program: string, args: string[]): boolean {
  const name = program.toLowerCase();
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();
  if (name === "cargo") return cargoSubcommand(args) === "test";
  if (name === "go") return first === "test";
  if (name === "npm") return first === "test" || (first === "run" && second === "test");
  if (name === "pnpm" || name === "yarn" || name === "bun") return first === "test" || (first === "run" && second === "test") || ((first === "hardhat" || first === "blueprint") && second === "test");
  if (name === "node") return first === "--test";
  if (name === "python" || name === "python3") return first === "-m" && (second === "pytest" || second === "unittest");
  if (name === "pytest") return true;
  if (name === "ctest") return true;
  if (name === "deno") return first === "test";
  if (name === "dotnet") return first === "test";
  if (name === "mvn") return first === "test" || first === "-q" && second === "test";
  if (name === "gradle" || name === "gradlew") return args.some((arg) => arg.toLowerCase() === "test");
  if (name === "forge") return first === "test";
  if (name === "scarb") return scarbSubcommand(args) === "test";
  if (name === "snforge") return first === "test";
  if (name === "blueprint") return first === "test";
  if (name === "npx") return (first === "hardhat" || first === "blueprint") && second === "test";
  return false;
}

/**
 * Build / dependency-resolution commands across ecosystems. Language-agnostic by
 * design: the mechanism is "recognize a package manager's build/fetch verb", and a
 * new ecosystem is added by extending this table, not by new code paths. Content
 * still passes the base network check (analyzeStructuredCommandBaseSafety), so a
 * build command cannot smuggle a remote/mainnet/exploit target in its argv.
 */
function isAllowedBuildCommand(program: string, args: string[]): boolean {
  const name = program.toLowerCase();
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();
  const lower = args.map((arg) => arg.toLowerCase());
  if (name === "cargo") return ["build", "fetch", "check", "generate-lockfile", "vendor", "update"].includes(cargoSubcommand(args) ?? "");
  if (name === "go") return first === "build" || first === "mod"; // go build / go mod download|tidy|vendor
  if (name === "npm") return ["install", "ci", "i"].includes(first ?? "");
  if (name === "pnpm" || name === "yarn" || name === "bun") return ["install", "i", "ci"].includes(first ?? "")
    || (name === "yarn" && args.length === 0)
    || (first === "hardhat" && (second === "compile" || second === "typechain"))
    || (first === "blueprint" && second === "build");
  if (name === "pip" || name === "pip3") return first === "install";
  if (name === "python" || name === "python3") {
    return first === "-m" && (
      second === "venv" ||
      second === "virtualenv" ||
      (second === "pip" && lower[2] === "install")
    );
  }
  // `forge inspect` is compiler-backed, read-only introspection (for example,
  // storage-layout or ABI output). Treat it like a build command so sealed
  // audits run it against the prepared build workspace with dependencies
  // available, while it remains ineligible for executable confirmation.
  if (name === "forge") return ["build", "install", "compile", "update", "inspect"].includes(first ?? "");
  if (name === "cmake") return isAllowedCmakeBuild(args);
  if (name === "ninja") return true;
  if (name === "make" || name === "gmake") return true;
  if (name === "dotnet") return first === "build" || first === "restore";
  if (name === "deno") return first === "cache";
  if (name === "mvn") return lower.some((arg) => ["compile", "package", "install", "dependency:resolve", "dependency:go-offline"].includes(arg));
  if (name === "gradle" || name === "gradlew") return lower.some((arg) => ["build", "assemble", "classes", "compilejava", "dependencies"].includes(arg));
  if (name === "scarb") return ["build", "fetch", "check", "metadata"].includes(scarbSubcommand(args) ?? "");
  if (name === "blueprint") return first === "build";
  if (name === "func-js" || name === "tolk-js" || name === "tact") return args.length > 0 && !isToolInfoArgs(args);
  if (name === "npx") return (first === "hardhat" && (second === "compile" || second === "typechain")) || (first === "blueprint" && second === "build");
  return false;
}

function isAllowedWorkspaceSetupCommand(program: string, args: string[]): boolean {
  if (program.toLowerCase() !== "mkdir") return false;
  const paths: string[] = [];
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower === "-p" || lower === "--parents") continue;
    if (arg.startsWith("-")) return false;
    paths.push(arg);
  }
  return paths.length > 0 && paths.every(isModelOwnedWorkspaceDirectory);
}

function isModelOwnedWorkspaceDirectory(arg: string): boolean {
  if (arg.length === 0) return false;
  if (arg.startsWith("/") || looksLikePathEscape(arg)) return false;
  const normalized = arg.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const tokens = segments.flatMap((segment) => segment.toLowerCase().split(/[._-]+/).filter(Boolean));
  return tokens.some((token) => ["poc", "repro", "harness", "scratch", "verify", "verification", "flounder"].includes(token));
}

function cargoSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.toLowerCase() ?? "";
    if (!arg) continue;
    if (/^\+[\w.-]+$/.test(arg)) continue;
    if (arg === "--") return undefined;
    if (arg === "-z" || arg === "--config" || arg === "-c" || arg === "--color" || arg === "--manifest-path") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-z") || arg.startsWith("--config=") || arg.startsWith("--color=") || arg.startsWith("--manifest-path=")) {
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function scarbSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]?.toLowerCase() ?? "";
    if (!arg) continue;
    if (arg === "--") return undefined;
    if (arg === "--offline" || arg === "--json" || arg === "--no-cache") continue;
    if (arg === "--manifest-path" || arg === "--profile" || arg === "-p") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--manifest-path=") || arg.startsWith("--profile=")) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function isToolInfoArgs(args: string[]): boolean {
  if (args.length !== 1) return false;
  const flag = args[0]?.toLowerCase();
  return flag === "--version" || flag === "-v" || flag === "-version" || flag === "version" || flag === "--help" || flag === "-h" || flag === "help";
}

function isAllowedLocalInspectionCommand(program: string, args: string[]): boolean {
  const name = program.toLowerCase();
  if (name === "pwd") return args.length === 0;
  if (name === "which") return args.length > 0 && args.every(isPlainToolName);
  if (isAllowedVersionInspection(name, args)) return true;
  if (name === "scarb" && scarbSubcommand(args) === "metadata") return args.every((arg) => isSafeInspectionArg(name, arg));
  if (isAllowedJsonToolInspection(name, args)) return true;
  if (name === "test" || name === "[") return isAllowedFileTestInspection(name, args);
  if (name === "ls") return args.every((arg) => isSafeInspectionArg(name, arg));
  if (name === "find") return args.every((arg) => isSafeInspectionArg(name, arg));
  if (name === "rg" || name === "grep" || name === "jq") return args.every((arg) => isSafeInspectionArg(name, arg));
  if (name === "sed") return args.every((arg) => isSafeInspectionArg(name, arg));
  if (["cat", "head", "tail", "wc", "sort", "uniq", "cut"].includes(name)) {
    return args.every((arg) => isSafeInspectionArg(name, arg));
  }
  return false;
}

function isAllowedVersionInspection(program: string, args: string[]): boolean {
  if (args.length !== 1) return false;
  const flag = args[0]?.toLowerCase();
  if (!flag || !["--version", "-v", "-version", "version", "--help", "-h", "help"].includes(flag)) return false;
  return new Set([
    "anvil",
    "bb",
    "bun",
    "cargo",
    "cast",
    "chisel",
    "cmake",
    "deno",
    "dotnet",
    "forge",
    "func-js",
    "git",
    "go",
    "gmake",
    "gradle",
    "gradlew",
    "jq",
    "make",
    "mvn",
    "nargo",
    "ninja",
    "node",
    "noir",
    "npm",
    "pip",
    "pip3",
    "pnpm",
    "python",
    "python3",
    "rustc",
    "rustup",
    "scarb",
    "solc",
    "sncast",
    "snforge",
    "tact",
    "tact-fmt",
    "tolk-js",
    "unboc",
    "yarn",
    "blueprint",
  ]).has(program);
}

function isAllowedJsonToolInspection(program: string, args: string[]): boolean {
  if (program !== "python" && program !== "python3") return false;
  if (args[0] !== "-m" || args[1] !== "json.tool") return false;
  const rest = args.slice(2);
  const paths = rest.filter((arg) => !arg.startsWith("-"));
  if (paths.length > 1) return false;
  return rest.every((arg) => isSafeInspectionArg(program, arg));
}

function isAllowedFileTestInspection(program: string, args: string[]): boolean {
  const tokens = program === "[" ? args.slice(0, -1) : args;
  if (program === "[" && args.at(-1) !== "]") return false;
  if (tokens.length !== 2) return false;
  const [predicate, target] = tokens;
  if (!predicate || !target) return false;
  if (!new Set(["-e", "-f", "-d", "-s", "-r"]).has(predicate)) return false;
  return isSafeInspectionArg(program, target);
}

function isPlainToolName(input: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(input);
}

function isSafeInspectionArg(program: string, arg: string): boolean {
  const lowered = arg.toLowerCase();
  if (program === "find" && ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(lowered)) return false;
  if (program === "sed" && (lowered === "-i" || lowered.startsWith("-i." ) || lowered === "--in-place" || lowered.startsWith("--in-place="))) return false;
  if (arg.includes("\0") || /[\r\n]/.test(arg)) return false;
  return true;
}

function isAllowedCmakeBuild(args: string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  if (lower.includes("--build")) return true;
  if (lower.includes("--install")) return false;
  if (lower.includes("-p") || lower.includes("--script")) return false;
  return lower.includes("-s") || lower.some((arg) => arg.startsWith("-s")) || lower.includes("-b") || lower.some((arg) => arg.startsWith("-b"));
}

function isRpcFlag(input: string): boolean {
  return input === "--fork-url" || input.startsWith("--fork-url=") || input === "--rpc-url" || input.startsWith("--rpc-url=") || input === "--rpc" || input.startsWith("--rpc=");
}

function isNetworkFlag(input: string): boolean {
  return input === "--network" || input.startsWith("--network=");
}

function valueAfterEquals(input: string): string | undefined {
  const idx = input.indexOf("=");
  return idx === -1 ? undefined : input.slice(idx + 1);
}

function isLocalNetworkValue(input: string): boolean {
  const lowered = input.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "hardhat", "anvil", "foundry", "local", "devnet", "regtest"].includes(lowered)) return true;
  if (isLocalUrl(input)) return true;
  return false;
}

function looksLikeRemoteUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^wss?:\/\//i.test(input);
}

function looksLikePathEscape(input: string): boolean {
  if (!input) return false;
  if (/^[A-Za-z]:[\\/]/.test(input)) return true;
  if (input.startsWith("/") || input.startsWith("~/") || input === "~") return true;
  const normalized = input.replace(/\\/g, "/");
  return normalized === ".." || normalized.startsWith("../") || normalized.includes("/../");
}

function isLocalUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function looksLikeRpcEnvReference(input: string): boolean {
  const envName = "[A-Z][A-Z0-9_]*(?:RPC|ALCHEMY|INFURA|QUICKNODE|MORALIS|ETHERSCAN|PRIVATE_KEY|MNEMONIC|TOKEN|SECRET)[A-Z0-9_]*";
  const pattern = new RegExp(`^(?:\\$\\{?${envName}\\}?|%${envName}%|${envName})(?:=.*)?$`);
  return pattern.test(input.trim());
}
