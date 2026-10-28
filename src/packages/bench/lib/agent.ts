// The minimal agent loop: a chat model with tools, called until it answers
// without asking for a tool. The benchmark drives it through OpenRouter
// with the model and provider pinned and fallbacks off (ADR 0006).
import * as z from "zod";

/** A message of an OpenAI-compatible chat. */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** A tool the agent may call, with the JSON Schema of its arguments. */
export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** Tokens and cost of one or more model calls. */
export type Usage = {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** In USD, as OpenRouter reports it. */
  cost: number;
};

export const noUsage: Usage = {
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cost: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cost: a.cost + b.cost,
  };
}

export type ChatModel = {
  /** The model, and the provider it is pinned to. */
  id: string;
  chat(
    messages: readonly ChatMessage[],
    tools: readonly ToolSpec[]
  ): Promise<{
    message: Extract<ChatMessage, { role: "assistant" }>;
    usage: Usage;
  }>;
};

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              })
            )
            .optional(),
        }),
      })
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost: z.number().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().optional(),
        cache_write_tokens: z.number().optional(),
      })
      .nullish(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().optional() })
      .nullish(),
  }),
});

/** A model on OpenRouter, pinned to one provider with fallbacks off. */
export function openRouterModel({
  model,
  provider,
  apiKey,
  url = "https://openrouter.ai/api/v1/chat/completions",
}: {
  model: string;
  provider: string;
  apiKey: string;
  url?: string;
}): ChatModel {
  return {
    id: `${model}@${provider}`,
    async chat(messages, tools) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.map((tool) => ({ type: "function", function: tool })),
          temperature: 0,
          provider: {
            order: [provider],
            allow_fallbacks: false,
            require_parameters: true,
          },
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        throw new Error(
          `${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`
        );
      }
      const { choices, usage } = responseSchema.parse(await response.json());
      const { content, tool_calls } = choices[0]!.message;
      return {
        message: {
          role: "assistant",
          content: content ?? null,
          ...(tool_calls !== undefined &&
            tool_calls.length > 0 && {
              tool_calls: tool_calls.map((call) => ({
                ...call,
                type: "function" as const,
              })),
            }),
        },
        usage: {
          promptTokens: usage.prompt_tokens,
          cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens:
            usage.prompt_tokens_details?.cache_write_tokens ?? 0,
          completionTokens: usage.completion_tokens,
          reasoningTokens:
            usage.completion_tokens_details?.reasoning_tokens ?? 0,
          cost: usage.cost ?? 0,
        },
      };
    },
  };
}

export type AgentRun = {
  /** The agent's last answer, or undefined if it ran out of turns. */
  answer: string | undefined;
  usage: Usage;
  /** Model calls made. */
  roundTrips: number;
  transcript: ChatMessage[];
};

/**
 * Runs the agent until it answers without calling a tool, or for at most
 * `maxTurns` model calls. A tool that throws answers with its error, as an
 * MCP client shows a failed call.
 */
export async function runAgent(
  model: ChatModel,
  {
    system,
    prompt,
    tools,
    call,
    maxTurns = 20,
  }: {
    system: string;
    prompt: string;
    tools: readonly ToolSpec[];
    call(name: string, args: unknown): Promise<string>;
    maxTurns?: number;
  }
): Promise<AgentRun> {
  const transcript: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  let usage = noUsage;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await model.chat(transcript, tools);
    usage = addUsage(usage, reply.usage);
    transcript.push(reply.message);
    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        answer: reply.message.content ?? "",
        usage,
        roundTrips: turn,
        transcript,
      };
    }
    for (const toolCall of calls) {
      let content: string;
      try {
        content = await call(
          toolCall.function.name,
          JSON.parse(toolCall.function.arguments || "{}")
        );
      } catch (error) {
        content = `Error: ${(error as Error).message}`;
      }
      transcript.push({ role: "tool", tool_call_id: toolCall.id, content });
    }
  }
  return { answer: undefined, usage, roundTrips: maxTurns, transcript };
}
