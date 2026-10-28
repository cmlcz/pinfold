import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudeCodeOutcome,
  codexOutcome,
  loopDriver,
  runAgentArm,
  servePinProxy,
  startBench,
  tasks,
  type Bench,
  type ChatMessage,
  type ChatModel,
  type ToolSpec,
} from "../index.ts";

let bench: Bench;

beforeAll(async () => {
  bench = await startBench();
});

afterAll(() => bench.close());

const usage = {
  promptTokens: 100,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 10,
  reasoningTokens: 0,
  cost: 0.001,
};

// A model that makes the given tool calls, one per turn, then answers
// with what the last tool returned. It records what it was shown.
function scripted(calls: { name: string; args: (seen: Seen) => unknown }[]) {
  const seen: Seen = { system: "", tools: [], results: [] };
  const model: ChatModel = {
    id: "fake/scripted@fake",
    async chat(messages, tools) {
      seen.system = (messages[0] as { content: string }).content;
      seen.tools = tools.map((tool) => tool.name);
      seen.results = messages
        .filter(
          (message): message is Extract<ChatMessage, { role: "tool" }> =>
            message.role === "tool"
        )
        .map((message) => message.content);
      const next = calls[seen.results.length];
      if (next === undefined) {
        const last = seen.results.at(-1) ?? "";
        return {
          message: { role: "assistant", content: last.split("\n\n")[0]! },
          usage,
        };
      }
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${seen.results.length}`,
              type: "function",
              function: {
                name: next.name,
                arguments: JSON.stringify(next.args(seen)),
              },
            },
          ],
        },
        usage,
      };
    },
  };
  return { model, seen };
}

type Seen = { system: string; tools: ToolSpec["name"][]; results: string[] };

describe("the agent Arms", () => {
  const task = tasks.find((candidate) => candidate.name === "error-digest")!;

  it("gives A1 every Drift Kit Tool, named by its server, and no pinfold", async () => {
    const { model, seen } = scripted([
      { name: "sentry__listIssues", args: () => ({ project: "web" }) },
    ]);

    const run = await runAgentArm(bench, loopDriver(model), "A1", task, 0);

    expect(seen.tools).toEqual(
      expect.arrayContaining([
        "sentry__listIssues",
        "linear__createIssue",
        "github__getBlame",
      ])
    );
    expect(seen.tools).not.toContain("run_sandbox");
    expect(seen.results[0]).toContain('"shortId"');
    expect(run).toMatchObject({ arm: "A1", approvals: 0, roundTrips: 2 });
  });

  it("tells A3 to reuse its saved program, which it reads and runs", async () => {
    const { model, seen } = scripted([
      { name: "read_file", args: () => ({ path: "skills/error-digest.ts" }) },
      {
        name: "run_sandbox",
        args: (shown) => ({ code: shown.results[0], input: task.inputs[0] }),
      },
    ]);

    const run = await runAgentArm(bench, loopDriver(model), "A3", task, 0);

    expect(seen.system).toContain(
      "`skills/error-digest.ts` is a saved program for the task you will be given"
    );
    expect(seen.results[0]).toBe(task.program);
    expect(run).toMatchObject({ arm: "A3", verdict: { success: true } });
  });
});

describe("the CLI drivers", () => {
  it("count Claude Code's cached input tokens into its input", () => {
    const outcome = claudeCodeOutcome([
      { type: "system", subtype: "init", model: "m" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "[]",
        usage: {
          input_tokens: 1161,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 384,
          output_tokens: 3,
          output_tokens_details: { thinking_tokens: 1 },
        },
      },
    ]);

    expect(outcome).toEqual({
      answer: "[]",
      usage: {
        promptTokens: 1565,
        cachedTokens: 384,
        cacheWriteTokens: 20,
        completionTokens: 3,
        reasoningTokens: 1,
        cost: 0,
      },
    });
  });

  it("sum Codex's tokens over its turns and take its last message", () => {
    const turn = {
      type: "turn.completed",
      usage: {
        input_tokens: 10024,
        cached_input_tokens: 6016,
        cache_write_input_tokens: 0,
        output_tokens: 3,
        reasoning_output_tokens: 2,
      },
    };
    const outcome = codexOutcome([
      { type: "thread.started" },
      { type: "item.completed", item: { type: "agent_message", text: "x" } },
      turn,
      { type: "item.completed", item: { type: "agent_message", text: "[]" } },
      turn,
    ]);

    expect(outcome).toEqual({
      answer: "[]",
      usage: {
        promptTokens: 20048,
        cachedTokens: 12032,
        cacheWriteTokens: 0,
        completionTokens: 6,
        reasoningTokens: 4,
        cost: 0,
      },
    });
  });

  it("pin the provider through the proxy and read what each call cost", async () => {
    let received: Record<string, unknown> = {};
    let calls = 0;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      received = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      // The first call is refused, the second streamed.
      if (calls++ === 0) {
        return res.writeHead(400, { "x-generation-id": "gen-1" }).end("{}");
      }
      res.writeHead(200, {
        "x-generation-id": "gen-2",
        "content-type": "text/event-stream",
      });
      res.write(
        'data: {"type":"message_start","message":{"model":"vendor/model","provider":"Some","usage":{}}}\n\n'
      );
      res.end(
        'data: {"type":"message_delta","usage":{"output_tokens":3,"cost":0.0042,"cost_details":{"upstream_inference_cost":0.0042}}}\n\n'
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as AddressInfo;
    const proxy = await servePinProxy({
      provider: "some/fp8",
      upstream: `http://127.0.0.1:${port}`,
    });
    try {
      const call = () =>
        fetch(`${proxy.url}/api/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "vendor/model",
            parallel_tool_calls: false,
          }),
        });
      expect((await call()).status).toBe(400);
      const streamed = await (await call()).text();

      expect(streamed).toContain('"cost":0.0042');
      expect(received).toEqual({
        model: "vendor/model",
        provider: {
          order: ["some/fp8"],
          allow_fallbacks: false,
          require_parameters: true,
        },
      });
      expect(proxy.takeCalls()).toEqual([
        { cost: 0.0042, served: "vendor/model@Some" },
      ]);
      expect(proxy.takeCalls()).toEqual([]);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });
});
