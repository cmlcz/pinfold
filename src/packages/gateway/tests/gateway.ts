// The Gateway test setup, shared by the Gateway's test files: each test
// gets a project with Sentry and Linear Drift Kit servers, and a Gateway
// process with a client connected over stdio.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientCapabilities } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach } from "vitest";
import { connectControl, driftKitCommand } from "../../drift-kit/index.ts";

export let dir: string;
let config: string;
export let client: Client;

export type Answer = "accept" | "decline" | "cancel";

// A Gateway process with a client connected over stdio. A client given
// `answer` declares form elicitation, unless `capabilities` say otherwise,
// and answers each Approval dialog with it. `stderr` collects the Gateway's.
export async function connectGateway(
  options: {
    answer?: (message: string) => Answer | Promise<Answer>;
    capabilities?: ClientCapabilities;
    stderr?: string[];
  } = {}
): Promise<Client> {
  const { answer } = options;
  const connected = new Client(
    { name: "gateway-test", version: "0.0.0" },
    {
      capabilities:
        options.capabilities ?? (answer ? { elicitation: { form: {} } } : {}),
    }
  );
  if (answer) {
    connected.setRequestHandler("elicitation/create", async (request) => ({
      action: await answer(request.params.message),
    }));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../bin.ts", import.meta.url)),
      "--config",
      config,
    ],
    stderr: options.stderr ? "pipe" : "inherit",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    options.stderr?.push(chunk.toString());
  });
  await connected.connect(transport);
  return connected;
}

/** Starts the Gateway again, with a client connected with `options`. */
export async function reconnect(
  options: Parameters<typeof connectGateway>[0] = {}
): Promise<void> {
  await client.close();
  client = await connectGateway(options);
}

/** Sets up each test of the calling file. */
export function useGateway(): void {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinfold-gateway-"));
    config = join(dir, "pinfold.json");
    const sentry = driftKitCommand("sentry", { control: join(dir, "s.sock") });
    const linear = driftKitCommand("linear", { control: join(dir, "l.sock") });
    await writeFile(
      config,
      JSON.stringify({
        servers: { sentry, linear },
        classification: {
          sentry: { listIssues: "read", listIssueEvents: "read" },
          linear: { searchIssues: "read" },
        },
      })
    );

    client = await connectGateway();
  });

  afterEach(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
}

export const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as [{ type: "text"; text: string }])[0].text;

export const writing = `export async function main() {
  const ticket = await sdk.linear.createIssue({ title: "Fix totals" });
  return [ticket.identifier];
}`;

// The writes the Linear Drift Kit server received.
export const linearWrites = () =>
  connectControl(join(dir, "l.sock")).receivedWrites();

// Saves the run of `code` as Workflow `name`, its settings replaced by
// `settings`, then starts the Gateway again so it sees them, connected
// with `options`.
export async function saveWorkflow(
  name: string,
  run: { code: string; input?: unknown },
  settings = "export const settings = { writeBudget: 10 };",
  options: Parameters<typeof connectGateway>[0] = {}
) {
  const ran = await client.callTool({ name: "run_sandbox", arguments: run });
  const exploration = /Exploration Run ([0-9a-f]{8})/.exec(textOf(ran))![1]!;
  await client.callTool({
    name: "save_workflow",
    arguments: { run: exploration, name, confirmed: true },
  });
  const file = join(dir, ".workflows", `${name}.ts`);
  const source = await readFile(file, "utf8");
  await writeFile(
    file,
    source.replace("export const settings = { writeBudget: 10 };", settings)
  );
  await reconnect(options);
}
