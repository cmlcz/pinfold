// MCP client sessions to the configured Downstream Servers.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerConfig } from "./config.ts";
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
  const close = async () => {
    await Promise.all(connected.map(({ client }) => client.close()));
  };
  const failures = sessions.flatMap((s) =>
    s.status === "rejected" ? [s.reason as Error] : []
  );
  if (failures.length > 0) {
    await close();
    throw new Error(failures.map((error) => error.message).join("\n"));
  }
  return { tools: connected.flatMap(({ tools }) => tools), close };
}

async function connect(server: string, config: ServerConfig) {
  const client = new Client({ name: "pinfold", version: "0.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
      })
    );
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
        call: (args) => callTool(client, server, tool.name, args),
      })),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(
      `Downstream Server "${server}" could not be started: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

async function callTool(
  client: Client,
  server: string,
  name: string,
  args: unknown
): Promise<unknown> {
  const result = await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  });
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  if (result.isError) throw new ToolError(`${server}.${name} failed: ${text}`);
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
