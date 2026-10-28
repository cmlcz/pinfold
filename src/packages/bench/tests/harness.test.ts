import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  loopDriver,
  ModelUnavailable,
  openRouterModel,
  parseAnswer,
  runBenchmark,
  startBench,
  tasks,
  type Bench,
  type ChatModel,
  type RunRecord,
} from "../index.ts";

let bench: Bench;
let out: string;

beforeAll(async () => {
  bench = await startBench();
});

afterAll(() => bench.close());

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "pinfold-harness-"));
  return () => rm(out, { recursive: true, force: true });
});

// A fake model that solves each task the way a good agent would: it runs
// the task's reference program through run_sandbox, then answers with the
// value the run returned. Each call costs a cent.
const fakeModel: ChatModel = {
  id: "fake/model@fake",
  async chat(messages) {
    const usage = {
      promptTokens: 1000,
      cachedTokens: 400,
      cacheWriteTokens: 0,
      completionTokens: 100,
      reasoningTokens: 20,
      cost: 0.01,
    };
    const prompt = messages.find((message) => message.role === "user")!.content;
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      const value = last.content.split("\n\n")[0]!;
      return { message: { role: "assistant", content: value }, usage };
    }
    const task = tasks.find((candidate) =>
      candidate.inputs.some((input) => candidate.instruction(input) === prompt)
    )!;
    const input = task.inputs.find(
      (input) => task.instruction(input) === prompt
    );
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "run_sandbox",
              arguments: JSON.stringify({ code: task.program, input }),
            },
          },
        ],
      },
      usage,
    };
  },
};

const chosen = ["file-issues", "error-digest"].map((name) =>
  tasks.find((task) => task.name === name)!
);

describe("the benchmark harness", () => {
  it("runs each task, input and Arm repeatedly, checks every run and writes the results", async () => {
    const { records, stopped } = await runBenchmark(bench, {
      tasks: chosen,
      inputs: [0],
      arms: ["A2", "A4"],
      repeats: 2,
      driver: loopDriver(fakeModel),
      budgetUsd: 1,
      out,
      provenance: { "Measured on": "test" },
    });

    expect(stopped).toBeUndefined();
    expect(
      records.map((r) => [
        r.task,
        r.arm,
        r.repeat,
        r.verdict.success,
        r.approvals,
      ])
    ).toEqual([
      ["file-issues", "A2", 1, true, 1],
      ["file-issues", "A4", 1, true, 0],
      ["file-issues", "A2", 2, true, 1],
      ["file-issues", "A4", 2, true, 0],
      ["error-digest", "A2", 1, true, 0],
      ["error-digest", "A4", 1, true, 0],
      ["error-digest", "A2", 2, true, 0],
      ["error-digest", "A4", 2, true, 0],
    ]);
    const a2 = records.find((r) => r.arm === "A2")!;
    expect(a2).toMatchObject({
      model: "fake/model@fake",
      roundTrips: 2,
      usage: { promptTokens: 2000, cachedTokens: 800, cost: 0.02 },
    });
    expect(records.find((r) => r.arm === "A4")).toMatchObject({
      roundTrips: 0,
      usage: { promptTokens: 0, cost: 0 },
    });

    const lines = (await readFile(join(out, "runs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunRecord);
    expect(lines).toEqual(records);
    expect((await readdir(join(out, "transcripts"))).sort()).toEqual([
      "A2-error-digest-0-1.json",
      "A2-error-digest-0-2.json",
      "A2-file-issues-0-1.json",
      "A2-file-issues-0-2.json",
    ]);
    const summary = await readFile(join(out, "summary.md"), "utf8");
    expect(summary).toContain("- Measured on: test");
    expect(summary).toContain(
      "| file-issues | A2 | 2 | 100% | 100% | 2000 | 800 | 0 | 200 | 40 | 0.0200 |"
    );
    expect(summary).toMatch(
      /\| file-issues \| A4 \| 2 \| 100% \| 100% \| 0 \| 0 \| 0 \| 0 \| 0 \| 0\.0000 \|/
    );
    expect(summary).toContain("| file-issues | 1 |");
  });

  it("stops before a model call could pass the budget cap", async () => {
    const { records, stopped } = await runBenchmark(bench, {
      tasks: chosen.slice(0, 1),
      inputs: [0],
      arms: ["A2", "A4"],
      repeats: 3,
      driver: loopDriver(fakeModel),
      budgetUsd: 0.025,
      out,
      provenance: {},
    });

    expect(records.map((r) => [r.arm, r.repeat])).toEqual([
      ["A2", 1],
      ["A4", 1],
    ]);
    expect(stopped).toBe(
      "the budget of $0.025 would be passed: $0.0200 spent, and a run has cost up to $0.0200"
    );
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain(
      "- Stopped early: the budget of $0.025 would be passed"
    );
  });

  it("stops, keeping the runs so far, when the model stays unavailable", async () => {
    let calls = 0;
    const failing: ChatModel = {
      id: fakeModel.id,
      chat(messages, tools) {
        if (++calls > 2) {
          throw new ModelUnavailable("fetch failed, after 6 attempts");
        }
        return fakeModel.chat(messages, tools);
      },
    };

    const { records, stopped } = await runBenchmark(bench, {
      tasks: chosen.slice(0, 1),
      inputs: [0],
      arms: ["A2", "A4"],
      repeats: 2,
      driver: loopDriver(failing),
      budgetUsd: 1,
      out,
      provenance: {},
    });

    expect(records.map((r) => [r.arm, r.repeat])).toEqual([
      ["A2", 1],
      ["A4", 1],
    ]);
    expect(stopped).toBe("fetch failed, after 6 attempts");
  });

  it("reads the JSON an agent answers with, alone or in a fenced block", () => {
    expect(parseAnswer('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseAnswer('Done.\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
    expect(parseAnswer("I created the issues.")).toBeUndefined();
  });
});

describe("the OpenRouter model", () => {
  it("pins the provider with fallbacks off and reads tokens, cache and cost", async () => {
    let body: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "search_sdk",
                      arguments: '{"query":"issues"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 80,
            cost: 0.0031,
            prompt_tokens_details: {
              cached_tokens: 1000,
              cache_write_tokens: 50,
            },
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        })
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const model = openRouterModel({
        model: "vendor/model-1",
        provider: "some-provider",
        apiKey: "key",
        url: `http://127.0.0.1:${port}/`,
      });

      const reply = await model.chat(
        [{ role: "user", content: "hi" }],
        [
          {
            name: "search_sdk",
            description: "Search",
            parameters: { type: "object" },
          },
        ]
      );

      expect(model.id).toBe("vendor/model-1@some-provider");
      expect(body).toMatchObject({
        model: "vendor/model-1",
        temperature: 0,
        provider: {
          order: ["some-provider"],
          allow_fallbacks: false,
          require_parameters: true,
        },
        tools: [
          {
            type: "function",
            function: {
              name: "search_sdk",
              description: "Search",
              parameters: { type: "object" },
            },
          },
        ],
      });
      expect(reply).toEqual({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "search_sdk", arguments: '{"query":"issues"}' },
            },
          ],
        },
        usage: {
          promptTokens: 1200,
          cachedTokens: 1000,
          cacheWriteTokens: 50,
          completionTokens: 80,
          reasoningTokens: 30,
          cost: 0.0031,
        },
      });
    } finally {
      server.close();
    }
  });

  // A server that answers each request with the next of `answers`: a
  // status, or "drop" to close the connection without answering.
  async function flakyServer(answers: (number | "drop")[]) {
    let requests = 0;
    const server = createServer((req, res) => {
      const answer = answers[requests++] ?? 200;
      if (answer === "drop") return req.socket.destroy();
      res.statusCode = answer;
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const lines: string[] = [];
    const model = openRouterModel({
      model: "vendor/model-1",
      provider: "some-provider",
      apiKey: "key",
      url: `http://127.0.0.1:${port}/`,
      retryDelaysMs: [0, 0],
      log: (line) => lines.push(line),
    });
    return {
      model,
      lines,
      requests: () => requests,
      [Symbol.dispose]: () => server.close(),
    };
  }

  it("sends a call again after a dropped connection or a 5xx", async () => {
    using server = await flakyServer(["drop", 503]);

    const reply = await server.model.chat(
      [{ role: "user", content: "hi" }],
      []
    );

    expect(reply.message.content).toBe("done");
    expect(server.requests()).toBe(3);
    expect(server.lines).toEqual([
      expect.stringMatching(/failed: fetch failed.*; trying again in 0 s$/),
      expect.stringMatching(/answered 503: .*; trying again in 0 s$/),
    ]);
  });

  it("fails at once on a 4xx other than 408 and 429", async () => {
    using server = await flakyServer([400]);

    const call = server.model.chat([{ role: "user", content: "hi" }], []);

    await expect(call).rejects.toThrow(/answered 400/);
    await expect(call).rejects.not.toBeInstanceOf(ModelUnavailable);
    expect(server.requests()).toBe(1);
  });

  it("gives up once every retry has failed", async () => {
    using server = await flakyServer([429, 502, 502]);

    const call = server.model.chat([{ role: "user", content: "hi" }], []);

    await expect(call).rejects.toBeInstanceOf(ModelUnavailable);
    await expect(call).rejects.toThrow(/answered 502: .*, after 3 attempts$/);
    expect(server.requests()).toBe(3);
  });
});
