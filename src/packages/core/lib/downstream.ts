// MCP client sessions to the configured Downstream Servers.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolveReferences, type ServerConfig } from "./config.ts";
import type { JsonSchema } from "./schema.ts";
import type { SdkTool } from "./sdk.ts";

/** A Tool as its Downstream Server lists it now, before any Baseline. */
export type DownstreamTool = SdkTool & {
  /** The server's own claim that the Tool changes nothing; untrusted (ADR 0004). */
  readOnlyHint: boolean;
  call(args: unknown): Promise<unknown>;
};

/** The Tool's server answered the call with an error result. */
export class ToolError extends Error {}

export type Downstream = {
  tools: DownstreamTool[];
  close(): Promise<void>;
};

/** `root` is the project root, which a stdio server's cwd is relative to. */
export async function connectDownstream(
  servers: Record<string, ServerConfig>,
  root: string
): Promise<Downstream> {
  const sessions = await Promise.allSettled(
    Object.entries(servers).map(([name, config]) => connect(name, config, root))
  );
  const connected = sessions.flatMap((s) =>
    s.status === "fulfilled" ? [s.value] : []
  );
  const failures = sessions.flatMap((s) =>
    s.status === "rejected" ? [s.reason as Error] : []
  );
  const close = async () => {
    await Promise.all(connected.map(({ client }) => client.close()));
  };
  if (failures.length > 0) {
    await close();
    throw new Error(failures.map((error) => error.message).join("\n"));
  }
  return { tools: connected.flatMap(({ tools }) => tools), close };
}

// Responses are taken as they come, even when they no longer fit the Tool's
// listed output schema: telling them from the Tool's Baseline is Drift
// detection's job, and a Response Adapter may map them back.
const takeAsTheyCome = {
  getValidator: () => (input: unknown) => ({
    valid: true as const,
    data: input as never,
    errorMessage: undefined,
  }),
};

async function connect(server: string, config: ServerConfig, root: string) {
  const client = new Client(
    { name: "pinfold", version: "0.0.0" },
    { jsonSchemaValidator: takeAsTheyCome }
  );
  const secrets = keepSecrets();
  try {
    if ("command" in config) {
      const env = resolveReferences(server, config.env ?? {}, process.env);
      secrets.values.push(...env.secrets);
      const cwd = resolve(root, config.cwd ?? ".");
      // Spawning in a missing directory fails as if the command were missing.
      const directory = await stat(cwd).catch(() => undefined);
      if (!directory?.isDirectory()) {
        throw new Error(`its cwd ${cwd} is not a directory`);
      }
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: env.values,
          cwd,
        })
      );
    } else {
      const headers = resolveReferences(
        server,
        config.headers ?? {},
        process.env
      );
      secrets.values.push(...headers.secrets);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: headers.values },
        })
      );
    }
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      client,
      tools: tools.map((tool): DownstreamTool => ({
        server,
        tool: tool.name,
        ...(tool.description !== undefined && {
          description: tool.description,
        }),
        // The SDK checks only the top level of a listed schema; the rest is
        // read as JSON Schema, which may hold any of its forms (JsonSchema).
        inputSchema: tool.inputSchema as JsonSchema,
        ...(tool.outputSchema !== undefined && {
          outputSchema: tool.outputSchema,
        }),
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        call: (args) => callTool(client, server, tool.name, args, secrets),
      })),
    };
  } catch (error) {
    await client.close().catch(() => {});
    const verb = "command" in config ? "be started" : "connect";
    throw secrets.error(
      `Downstream Server "${server}" could not ${verb}: ${reason(error)}`,
      error
    );
  }
}

type Secrets = ReturnType<typeof keepSecrets>;

// Values filled in from the environment, kept out of every message.
function keepSecrets() {
  const values: string[] = [];
  const scrub = (message: string) =>
    values.reduce(
      (text, secret) => text.replaceAll(secret, "[secret]"),
      message
    );
  return {
    values,
    scrub,
    // The cause would carry the secrets the message leaves out.
    error: (message: string, cause: unknown) =>
      new Error(scrub(message), values.length === 0 ? { cause } : undefined),
  };
}

// Why connecting failed, in words that hold up without the stack.
function reason(error: unknown): string {
  if (error instanceof SdkHttpError && [401, 403].includes(error.status)) {
    return `the server rejected its credentials (HTTP ${error.status})`;
  }
  const { message, cause } = error as Error;
  return cause instanceof Error ? `${message} (${cause.message})` : message;
}

async function callTool(
  client: Client,
  server: string,
  name: string,
  args: unknown,
  secrets: Secrets
): Promise<unknown> {
  let result;
  try {
    result = await client.callTool({
      name,
      arguments: args as Record<string, unknown>,
    });
  } catch (error) {
    throw secrets.error(
      `${server}.${name} failed: ${(error as Error).message}`,
      error
    );
  }
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  if (result.isError) {
    throw new ToolError(secrets.scrub(`${server}.${name} failed: ${text}`));
  }
  return result.structuredContent ?? parseJsonText(text);
}

// Many servers send JSON objects and arrays only as text. Anything else,
// including text that happens to parse as a number, stays a string.
function parseJsonText(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : text;
  } catch {
    return text;
  }
}
