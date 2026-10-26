// The Repair Model: a small model unattended Repair asks for ops when
// deterministic search finds none. It is any OpenAI-compatible chat API,
// OpenRouter by default, and is used only when the config or
// PINFOLD_REPAIR_MODEL names a model and OPENROUTER_API_KEY is set.
// Each call's token usage and cost are kept in .pinfold/model-usage.jsonl.
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { PinfoldConfig } from "./config.ts";
import { prepareState } from "./files.ts";

export type ModelUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** In credits, where the API reports it, as OpenRouter does. */
  cost?: number;
};

export type ModelClient = {
  /** The model's answer to a prompt, and what it cost. */
  complete(prompt: string): Promise<{ text: string; usage: ModelUsage }>;
};

const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";

const completionSchema = z.object({
  /** The model that answered, which OpenRouter's routing may pick. */
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost: z.number().optional(),
  }),
});

/** A client of an OpenAI-compatible chat completions API. */
export function chatClient({
  model,
  apiKey,
  url = openRouterUrl,
}: {
  model: string;
  apiKey: string;
  url?: string;
}): ModelClient {
  return {
    async complete(prompt) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
      }
      const answered = completionSchema.parse(await response.json());
      const { choices, usage } = answered;
      return {
        text: choices[0]!.message.content ?? "",
        usage: {
          model: answered.model ?? model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          ...(usage.cost !== undefined && { cost: usage.cost }),
        },
      };
    },
  };
}

/** The config, with the Repair Model PINFOLD_REPAIR_MODEL picks, if set. */
export function withPickedModel(
  config: PinfoldConfig,
  env: NodeJS.ProcessEnv
): PinfoldConfig {
  const picked = env.PINFOLD_REPAIR_MODEL;
  return picked ? { ...config, repairModel: picked } : config;
}

/**
 * The Repair Model the config names, through OpenRouter; none if it names
 * none, or if OPENROUTER_API_KEY is not set.
 */
export function configuredModel(
  config: PinfoldConfig,
  env: NodeJS.ProcessEnv
): ModelClient | undefined {
  const apiKey = env.OPENROUTER_API_KEY;
  if (config.repairModel === undefined || !apiKey) return undefined;
  return chatClient({ model: config.repairModel, apiKey });
}

/** Keeps a model call's usage, with the Tool it was asked to repair. */
export async function recordUsage(
  root: string,
  entry: { at: string; tool: string } & ModelUsage
): Promise<void> {
  const state = await prepareState(root);
  await appendFile(
    join(state, "model-usage.jsonl"),
    `${JSON.stringify(entry)}\n`
  );
}
