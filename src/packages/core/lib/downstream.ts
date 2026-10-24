// MCP client sessions to the configured Downstream Servers.
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolveHeaders, type ServerConfig } from "./config.ts";
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

export async function connectDownstream(
  servers: Record<string, ServerConfig>
): Promise<Downstream> {
  const sessions = await Promise.allSettled(
    Object.entries(servers).map(([name, config]) => connect(name, config))
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

async function connect(server: string, config: ServerConfig) {
  const client = new Client({ name: "pinfold", version: "0.0.0" });
  const secrets = keepSecrets();
  try {
    if ("command" in config) {
      await client.connect(
        new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
        })
      );
    } else {
      const resolved = resolveHeaders(
        server,
        config.headers ?? {},
        process.env
      );
      secrets.values.push(...resolved.secrets);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: resolved.headers },
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
        inputSchema: tool.inputSchema,
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

// Header values filled in from the environment, kept out of every message.
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
