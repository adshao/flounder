import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { findEnvKeys, getEnvApiKey, getProviders } from "@earendil-works/pi-ai";
import { getOAuthProvider, getOAuthProviders, type OAuthPrompt, type OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import { flounderHomeDir } from "./config.js";

const LOCAL_FALLBACK_PROVIDERS = new Set(["mock", "codex-cli", "claude-code"]);

const EXPECTED_ENV: Record<string, string[]> = {
  "amazon-bedrock": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK"],
  "ant-ling": ["ANT_LING_API_KEY"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME"],
  cerebras: ["CEREBRAS_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  groq: ["GROQ_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
};

export interface ProviderAuthStatus {
  provider: string;
  required: boolean;
  configured: boolean;
  source?: "stored" | "environment" | "ambient" | "not-managed";
  sourceLabel?: string;
  authPath: string;
  oauthLogin: boolean;
  expectedEnvVars: string[];
  loginCommand: string;
  checkCommand: string;
}

export function providerAuthPath(): string {
  return join(flounderAgentDir(), "auth.json");
}

export function flounderAgentDir(): string {
  return process.env.FLOUNDER_AGENT_DIR || join(flounderHomeDir(), "agent");
}

function defaultPiAuthPath(): string {
  const piAgentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(piAgentDir, "auth.json");
}

export function knownRuntimeProviders(): string[] {
  let piProviders: string[] = [];
  try {
    piProviders = getProviders() as unknown as string[];
  } catch {
    piProviders = [];
  }
  return [...new Set([...piProviders, ...LOCAL_FALLBACK_PROVIDERS])].sort();
}

export async function providerAuthStatus(provider: string): Promise<ProviderAuthStatus> {
  const normalized = provider.trim();
  const authPath = providerAuthPath();
  const oauthLogin = getOAuthProviders().some((entry) => entry.id === normalized);
  const base = {
    provider: normalized,
    authPath,
    oauthLogin,
    expectedEnvVars: EXPECTED_ENV[normalized] ?? [],
    loginCommand: `flounder daemon provider login ${normalized}`,
    checkCommand: `flounder daemon provider check ${normalized}`,
  };

  if (!normalized || LOCAL_FALLBACK_PROVIDERS.has(normalized)) {
    return { ...base, required: false, configured: true, source: "not-managed", sourceLabel: normalized ? "local fallback" : "none" };
  }

  const stored = await hasStoredAuth(normalized, authPath);
  if (stored) return { ...base, required: true, configured: true, source: "stored", sourceLabel: authPath };

  const importedFrom = await importDefaultPiAuth(normalized, authPath);
  if (importedFrom) return { ...base, required: true, configured: true, source: "stored", sourceLabel: `${authPath} (imported from ${importedFrom})` };

  const envKeys = findEnvKeys(normalized);
  if (envKeys?.length) {
    return { ...base, required: true, configured: true, source: "environment", sourceLabel: envKeys.join(", ") };
  }

  if (getEnvApiKey(normalized)) {
    return { ...base, required: true, configured: true, source: "ambient", sourceLabel: "ambient provider credentials" };
  }

  return { ...base, required: true, configured: false };
}

export async function assertProviderAuthenticated(provider: string): Promise<void> {
  const status = await providerAuthStatus(provider);
  if (!status.required || status.configured) return;
  const env = status.expectedEnvVars.length ? ` Expected environment: ${status.expectedEnvVars.join(", ")}.` : "";
  throw new Error(`provider "${provider}" is not authenticated on this daemon. Run \`${status.loginCommand}\` on this machine, or start the daemon with the provider credentials in its environment.${env}`);
}

export async function loginProvider(provider: string): Promise<void> {
  const normalized = provider.trim();
  const importedFrom = await importDefaultPiAuth(normalized, providerAuthPath());
  if (importedFrom) {
    console.log(`${normalized} credentials imported from existing pi auth (${importedFrom}) into ${providerAuthPath()}.`);
    return;
  }

  const oauth = getOAuthProvider(normalized);
  if (!oauth) {
    const expected = EXPECTED_ENV[normalized] ?? [];
    const env = expected.length ? `\nExpected environment variables: ${expected.join(", ")}` : "";
    throw new Error(`provider "${normalized}" does not support browser login. Set its credentials in the daemon environment, then run \`flounder daemon provider check ${normalized}\`.${env}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const credentials = await oauth.login({
      onAuth: (info) => {
        console.log(`\nOpen this URL in your browser:\n${info.url}`);
        if (info.instructions) console.log(info.instructions);
        console.log();
      },
      onDeviceCode: (info) => {
        console.log(`\nOpen this URL in your browser:\n${info.verificationUri}`);
        console.log(`Enter code: ${info.userCode}`);
        console.log();
      },
      onPrompt: (prompt) => promptLine(rl, formatPrompt(prompt)),
      onManualCodeInput: () => promptLine(rl, "Paste the authorization code: "),
      onSelect: async (prompt) => selectOption(rl, prompt),
      onProgress: (message) => console.log(message),
    });

    const authPath = providerAuthPath();
    await mkdir(dirname(authPath), { recursive: true });
    const auth = await readAuthFile(authPath);
    auth[normalized] = { type: "oauth", ...credentials };
    await writeFile(authPath, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600).catch(() => undefined);
    console.log(`\n${normalized} credentials saved for Flounder daemons on this machine.`);
  } finally {
    rl.close();
  }
}

export async function printProviderCheck(provider: string): Promise<boolean> {
  const status = await providerAuthStatus(provider);
  if (!status.required) {
    console.log(`${status.provider}: no Flounder-managed provider credentials required (${status.sourceLabel}).`);
    return true;
  }
  if (status.configured) {
    console.log(`${status.provider}: authenticated via ${status.source}${status.sourceLabel ? ` (${status.sourceLabel})` : ""}.`);
    return true;
  }
  console.log(`${status.provider}: not authenticated on this machine.`);
  if (status.oauthLogin) console.log(`Run: ${status.loginCommand}`);
  if (status.expectedEnvVars.length) console.log(`Or start the daemon with: ${status.expectedEnvVars.join(", ")}`);
  console.log(`Recheck with: ${status.checkCommand}`);
  return false;
}

async function hasStoredAuth(provider: string, authPath: string): Promise<boolean> {
  if (!existsSync(authPath)) return false;
  const auth = await readAuthFile(authPath);
  return Boolean(auth[provider]);
}

async function importDefaultPiAuth(provider: string, authPath: string): Promise<string | undefined> {
  if (process.env.FLOUNDER_DISABLE_PI_AUTH_IMPORT === "1") return undefined;
  const piAuthPath = defaultPiAuthPath();
  if (piAuthPath === authPath || !existsSync(piAuthPath)) return undefined;
  const piAuth = await readAuthFile(piAuthPath);
  const entry = piAuth[provider];
  if (!entry) return undefined;

  await mkdir(dirname(authPath), { recursive: true });
  const auth = await readAuthFile(authPath);
  if (!auth[provider]) {
    auth[provider] = entry;
    await writeFile(authPath, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(authPath, 0o600).catch(() => undefined);
  }
  return piAuthPath;
}

async function readAuthFile(authPath: string): Promise<Record<string, unknown>> {
  if (!existsSync(authPath)) return {};
  try {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function promptLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function formatPrompt(prompt: OAuthPrompt): string {
  return `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
}

async function selectOption(rl: ReturnType<typeof createInterface>, prompt: OAuthSelectPrompt): Promise<string | undefined> {
  console.log(`\n${prompt.message}`);
  prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const answer = await promptLine(rl, `Enter number (1-${prompt.options.length}): `);
  const index = Number.parseInt(answer, 10) - 1;
  return prompt.options[index]?.id;
}
