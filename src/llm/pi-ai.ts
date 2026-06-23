import { complete, getModel, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import type { LlmClient } from "../types.js";
import type { RunLogger } from "../trace/logger.js";
import type { ThinkingLevel } from "../config.js";

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
    thinkingLevel?: ThinkingLevel;
  }): Promise<string> {
    if (!input.model) throw new Error("model is required");
    const provider = normalizeProvider(this.provider);
    const model = getModel(provider, input.model as never);
    if (!model) throw new Error(`Unknown pi-ai model: provider=${this.provider} model=${input.model}`);

    const options: { maxTokens?: number; reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" } = {};
    if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
    if (input.thinkingLevel !== undefined && input.thinkingLevel !== "off") options.reasoning = input.thinkingLevel;

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
    const error = responseErrorMessage(response);
    await this.logger?.call({
      tag: input.tag,
      model: `${this.provider}/${input.model}`,
      system: input.system,
      user: input.user,
      response: text,
      ...(error ? { meta: { error } } : {}),
    });
    if (error) throw new Error(`pi-ai completion failed: ${error}`);
    if (text.trim().length === 0) throw new Error(`pi-ai completion returned no text: provider=${this.provider} model=${input.model}`);
    return text;
  }
}

function normalizeProvider(provider: string): KnownProvider {
  const known = getProviders();
  if (known.includes(provider as KnownProvider)) return provider as KnownProvider;
  throw new Error(`Unknown pi-ai provider: ${provider}. Known providers: ${known.join(", ")}`);
}

export function extractText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  const raw = response as Record<string, unknown>;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.output_text === "string") return raw.output_text;

  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content.map(extractContentBlockText).join("");
  }
  if (typeof content === "string") return content;

  const message = raw.message;
  if (message && typeof message === "object") {
    const messageContent = (message as { content?: unknown }).content;
    if (Array.isArray(messageContent)) return messageContent.map(extractContentBlockText).join("");
    if (typeof messageContent === "string") return messageContent;
  }

  const choices = raw.choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        return extractText((choice as { message?: unknown; text?: unknown }).message ?? (choice as { text?: unknown }).text);
      })
      .join("");
  }

  const output = raw.output;
  if (Array.isArray(output)) {
    return output.map(extractText).join("");
  }

  return "";
}

export function responseErrorMessage(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const raw = response as Record<string, unknown>;
  const errorMessage = raw.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim()) return errorMessage.trim();
  const stopReason = raw.stopReason;
  if (stopReason === "error") return "provider returned stopReason=error";
  const error = raw.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}

function extractContentBlockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const raw = block as Record<string, unknown>;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.output_text === "string") return raw.output_text;
  if (typeof raw.content === "string") return raw.content;
  if (Array.isArray(raw.content)) return raw.content.map(extractContentBlockText).join("");
  return "";
}
