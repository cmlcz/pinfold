// What drives an agent Arm: the minimal agent loop, or a real CLI run
// headless. Each drives the same Surface and reports the same Usage.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ModelUnavailable,
  noUsage,
  runAgent,
  type ChatModel,
  type ToolSpec,
  type Usage,
} from "./agent.ts";
import type { PinProxy, ProxiedCall } from "./pin-proxy.ts";
import type { Surface } from "./surface.ts";

export type DriverRun = {
  /** The agent's last answer, or undefined if it gave none. */
  answer: string | undefined;
  usage: Usage;
  /** Model calls made. */
  roundTrips: number;
  /** The chat of the minimal loop, or the CLI's raw JSON events. */
  transcript: unknown[];
  /** Each model and provider that served the calls, where known. */
  served?: string[];
  error?: string;
};

export type Driver = {
  /** The driver, its version and the model it is pinned to. */
  id: string;
  run(options: {
    system: string;
    prompt: string;
    surface: Surface;
    /** The agent's working directory, holding the Surface's files. */
    workdir: string;
  }): Promise<DriverRun>;
};

/**
 * The minimal agent loop. With one server, its Tools keep their names;
 * with several, each is named `<server>__<tool>`. The Surface's files are
 * read with a read_file tool, and its instruction line ends the system
 * prompt.
 */
export function loopDriver(model: ChatModel): Driver {
  return {
    id: model.id,
    async run({ system, prompt, surface, workdir }) {
      const clients: [string, Client][] = [];
      try {
        for (const [name, url] of Object.entries(surface.servers)) {
          const client = new Client({
            name: "pinfold-bench",
            version: "0.0.0",
          });
          await client.connect(new StreamableHTTPClientTransport(new URL(url)));
          clients.push([name, client]);
        }
        const routes = new Map<string, [Client, string]>();
        const tools: ToolSpec[] = [];
        for (const [server, client] of clients) {
          for (const tool of (await client.listTools()).tools) {
            const name =
              clients.length === 1 ? tool.name : `${server}__${tool.name}`;
            routes.set(name, [client, tool.name]);
            tools.push({
              name,
              description: tool.description ?? "",
              parameters: tool.inputSchema as Record<string, unknown>,
            });
          }
        }
        const files = Object.keys(surface.files);
        if (files.length > 0) {
          tools.push({
            name: "read_file",
            description: "Reads a file of the project.",
            parameters: {
              type: "object",
              properties: { path: { type: "string", enum: files } },
              required: ["path"],
            },
          });
        }
        const run = await runAgent(model, {
          system:
            surface.instructions === undefined
              ? system
              : `${system}\n\nThe project's instructions:\n${surface.instructions}`,
          prompt,
          tools,
          async call(name, args) {
            if (name === "read_file") {
              const { path } = args as { path: string };
              if (!files.includes(path)) throw new Error(`no file ${path}`);
              return readFile(join(workdir, path), "utf8");
            }
            const route = routes.get(name);
            if (route === undefined) throw new Error(`no tool ${name}`);
            return callText(route[0], route[1], args);
          },
        });
        return {
          answer: run.answer,
          usage: run.usage,
          roundTrips: run.roundTrips,
          transcript: run.transcript,
          ...(run.answer === undefined && {
            error: "the agent ran out of turns",
          }),
        };
      } finally {
        await Promise.allSettled(clients.map(([, client]) => client.close()));
      }
    },
  };
}

type CliOptions = {
  /** The OpenRouter model, such as deepseek/deepseek-v4.1-flash-1017. */
  model: string;
  /** The proxy that pins the provider. */
  proxy: PinProxy;
  provider: string;
  apiKey: string;
  /** A run that takes longer is stopped. */
  timeoutMs?: number;
};

/**
 * Claude Code, run headless with JSON events, routed through OpenRouter,
 * with a fresh configuration directory so that no login, setting, plugin
 * or hook of the developer's applies. Its only tools are the Surface's MCP
 * servers and Read, all allowed without asking. The instruction line goes
 * to CLAUDE.md.
 */
export async function claudeCodeDriver(options: CliOptions): Promise<Driver> {
  const version = (await output("claude", ["--version"])).split(" ")[0];
  return {
    id: `claude-code ${version} ${options.model}@${options.provider}`,
    async run({ system, prompt, surface, workdir }) {
      if (surface.instructions !== undefined) {
        await writeFile(
          join(workdir, "CLAUDE.md"),
          `${surface.instructions}\n`
        );
      }
      const servers = Object.entries(surface.servers);
      const config = await mkdtemp(join(tmpdir(), "pinfold-claude-"));
      try {
        const run = await runCli(
          "claude",
          [
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            options.model,
            "--append-system-prompt",
            system,
            "--mcp-config",
            JSON.stringify({
              mcpServers: Object.fromEntries(
                servers.map(([name, url]) => [name, { type: "http", url }])
              ),
            }),
            "--strict-mcp-config",
            "--tools",
            "Read",
            "--allowedTools",
            "Read",
            ...servers.map(([name]) => `mcp__${name}`),
            "--disable-slash-commands",
            "--no-session-persistence",
          ],
          {
            cwd: workdir,
            env: {
              CLAUDE_CONFIG_DIR: config,
              ANTHROPIC_BASE_URL: `${options.proxy.url}/api`,
              ANTHROPIC_AUTH_TOKEN: options.apiKey,
              ANTHROPIC_API_KEY: "",
              // Background calls go to the same model, not to Anthropic's.
              ANTHROPIC_DEFAULT_HAIKU_MODEL: options.model,
              ANTHROPIC_DEFAULT_SONNET_MODEL: options.model,
              ANTHROPIC_DEFAULT_OPUS_MODEL: options.model,
              CLAUDE_CODE_SUBAGENT_MODEL: options.model,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            },
            timeoutMs: options.timeoutMs,
          }
        );
        return settle(
          run,
          options.proxy.takeCalls(),
          claudeCodeOutcome(run.events)
        );
      } finally {
        await rm(config, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Codex CLI, run headless with JSON events, routed through OpenRouter as a
 * custom model provider, with a fresh CODEX_HOME so that no login or
 * setting of the developer's applies. It runs in a read-only sandbox, with
 * the Surface's MCP tools allowed without asking. The
 * instruction line goes to AGENTS.md; Codex has no option for a system
 * prompt, so the harness's opens the prompt.
 */
export async function codexDriver(options: CliOptions): Promise<Driver> {
  const version = (await output("codex", ["--version"])).split(" ").at(-1);
  return {
    id: `codex ${version} ${options.model}@${options.provider}`,
    async run({ system, prompt, surface, workdir }) {
      if (surface.instructions !== undefined) {
        await writeFile(
          join(workdir, "AGENTS.md"),
          `${surface.instructions}\n`
        );
      }
      const home = await mkdtemp(join(tmpdir(), "pinfold-codex-"));
      try {
        const run = await runCli(
          "codex",
          [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--cd",
            workdir,
            "--sandbox",
            "read-only",
            "--model",
            options.model,
            "-c",
            'model_provider="openrouter"',
            "-c",
            `model_providers.openrouter={ name = "OpenRouter", base_url = "${options.proxy.url}/api/v1", env_key = "OPENROUTER_API_KEY", wire_api = "responses" }`,
            "-c",
            'approval_policy="never"',
            // Every MCP tool is allowed without asking, as for Claude Code:
            // under approval_policy "never", Codex refuses any it would ask.
            ...Object.entries(surface.servers).flatMap(([name, url]) => [
              "-c",
              `mcp_servers.${name}.url="${url}"`,
              "-c",
              `mcp_servers.${name}.default_tools_approval_mode="approve"`,
            ]),
            `${system}\n\n${prompt}`,
          ],
          {
            cwd: workdir,
            env: { CODEX_HOME: home, OPENROUTER_API_KEY: options.apiKey },
            timeoutMs: options.timeoutMs,
          }
        );
        return settle(run, options.proxy.takeCalls(), codexOutcome(run.events));
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}

type CliRun = { events: unknown[]; stderr: string; error?: string };

/** What a CLI's events say: its answer and tokens; cost comes later. */
type CliOutcome = {
  answer: string | undefined;
  usage: Usage;
  error?: string;
};

// The cost and who served each call come from OpenRouter's answers, read
// by the proxy; the tokens come from the CLI's events.
function settle(
  run: CliRun,
  calls: ProxiedCall[],
  outcome: CliOutcome
): DriverRun {
  const error = outcome.error ?? run.error;
  // No call got through: the model, not the agent, failed.
  if (calls.length === 0 && error !== undefined) {
    throw new ModelUnavailable(`${error}: ${run.stderr.slice(-300)}`);
  }
  const unpriced = calls.filter((call) => call.cost === undefined).length;
  return {
    answer: outcome.answer,
    usage: {
      ...outcome.usage,
      cost: calls.reduce((sum, call) => sum + (call.cost ?? 0), 0),
    },
    roundTrips: calls.length,
    transcript: [...run.events, { stderr: run.stderr, unpriced }],
    served: [
      ...new Set(calls.flatMap((call) => (call.served ? [call.served] : []))),
    ],
    ...(error !== undefined && { error }),
  };
}

/**
 * Claude Code's answer and tokens, from its final `result` event. Its
 * input tokens leave out the cached ones, which are counted here.
 */
export function claudeCodeOutcome(events: readonly unknown[]): CliOutcome {
  const result = events.find(
    (event): event is ClaudeResult =>
      (event as { type?: string }).type === "result"
  );
  if (result === undefined) {
    return {
      answer: undefined,
      usage: noUsage,
      error: "Claude Code gave no result",
    };
  }
  const usage = result.usage ?? {};
  const cached = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    answer: result.is_error ? undefined : result.result,
    usage: {
      promptTokens: (usage.input_tokens ?? 0) + cached + cacheWrite,
      cachedTokens: cached,
      cacheWriteTokens: cacheWrite,
      completionTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
      cost: 0,
    },
    ...(result.is_error && { error: `Claude Code: ${result.subtype}` }),
  };
}

type ClaudeResult = {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number } | null;
  };
};

/**
 * Codex's answer, its last agent message, and its tokens, summed over its
 * `turn.completed` events. Its input tokens include the cached ones.
 */
export function codexOutcome(events: readonly unknown[]): CliOutcome {
  let usage = noUsage;
  let answer: string | undefined;
  let error: string | undefined;
  for (const event of events as CodexEvent[]) {
    if (event.type === "turn.completed") {
      const used = event.usage;
      usage = {
        promptTokens: usage.promptTokens + used.input_tokens,
        cachedTokens: usage.cachedTokens + (used.cached_input_tokens ?? 0),
        cacheWriteTokens:
          usage.cacheWriteTokens + (used.cache_write_input_tokens ?? 0),
        completionTokens: usage.completionTokens + used.output_tokens,
        reasoningTokens:
          usage.reasoningTokens + (used.reasoning_output_tokens ?? 0),
        cost: 0,
      };
    } else if (
      event.type === "item.completed" &&
      event.item.type === "agent_message"
    ) {
      answer = event.item.text;
    } else if (event.type === "turn.failed") {
      error = `Codex: ${event.error.message.slice(0, 300)}`;
    }
  }
  return { answer, usage, ...(error !== undefined && { error }) };
}

type CodexEvent =
  | {
      type: "turn.completed";
      usage: {
        input_tokens: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens: number;
        reasoning_output_tokens?: number;
      };
    }
  | { type: "item.completed"; item: { type: string; text?: string } }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "other" };

// Runs a CLI with no input, and the developer's own Claude, Anthropic,
// Codex and OpenAI settings taken out of its environment.
function runCli(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number | undefined;
  }
): Promise<CliRun> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(CLAUDE|ANTHROPIC|CODEX|OPENAI|OPENROUTER)/.test(key)
    )
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...inherited, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 600_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        });
      resolve({
        events,
        stderr,
        ...(timedOut
          ? { error: `${command} timed out` }
          : code !== 0 && { error: `${command} exited with ${code}` }),
      });
    });
  });
}

async function output(command: string, args: string[]): Promise<string> {
  const run = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(text.trim()));
  });
  return run;
}

async function callText(
  client: Client,
  name: string,
  args: unknown
): Promise<string> {
  const result = await client.callTool({
    name,
    arguments: (args ?? {}) as Record<string, unknown>,
  });
  const text = (result.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return result.isError ? `Error: ${text}` : text;
}
