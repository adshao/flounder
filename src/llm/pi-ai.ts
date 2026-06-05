import { complete, getModel, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";

export class PiAiClient implements LlmClient {
  constructor(
    private readonly provider: string,
    private readonly logger?: RunLogger,
  ) {}

  async complete(input: {
    tag: string;
    system: string;
    user: string;
    model?: string;
    maxTokens?: number;
    thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }): Promise<string> {
    if (!input.model) throw new Error("model is required");
    const provider = normalizeProvider(this.provider);
    const model = getModel(provider, input.model as never);
    if (!model) throw new Error(`Unknown pi-ai model: provider=${this.provider} model=${input.model}`);

    const options: { maxTokens?: number; reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" } = {};
    if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
    if (input.thinkingLevel !== undefined) options.reasoning = input.thinkingLevel;

    const response = await complete(
      model,
      {
        systemPrompt: input.system,
        messages: [
          { role: "user", content: input.user, timestamp: Date.now() },
        ],
      },
      options,
    );

    const text = extractText(response);
    await this.logger?.call({
      tag: input.tag,
      model: `${this.provider}/${input.model}`,
      system: input.system,
      user: input.user,
      response: text,
    });
    return text;
  }
}

function normalizeProvider(provider: string): KnownProvider {
  const known = getProviders();
  if (known.includes(provider as KnownProvider)) return provider as KnownProvider;
  throw new Error(`Unknown pi-ai provider: ${provider}. Known providers: ${known.join(", ")}`);
}

function extractText(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      return "";
    })
    .join("");
}
