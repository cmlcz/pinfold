import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { failedOnRequest, structured } from "../reply.ts";
import { createWorld, type World } from "../world.ts";

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  assigneeEmail: z.string().nullable(),
  state: z.enum(["Todo", "In Progress", "Done"]),
});

type LinearIssue = z.infer<typeof issueSchema>;

export type LinearState = { issues: LinearIssue[] };

const seedIssues: readonly LinearIssue[] = [
  {
    id: "lin-1",
    identifier: "ENG-101",
    title: "[Sentry] DatabaseError: deadlock detected",
    description: "orders.ts in reserveStock",
    assigneeEmail: "li@example.com",
    state: "In Progress",
  },
];

export function createLinearWorld(): World<LinearState> {
  return createWorld(() => ({ issues: structuredClone([...seedIssues]) }));
}

export function createLinearServer(world: World<LinearState>): McpServer {
  const server = new McpServer({ name: "drift-kit-linear", version: "0.0.0" });

  server.registerTool(
    "searchIssues",
    {
      description:
        "Search Linear issues whose title or description contains the query.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ issues: z.array(issueSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const needle = query.toLowerCase();
      const output = {
        issues: world.state.issues.filter((issue) =>
          `${issue.title}\n${issue.description}`.toLowerCase().includes(needle)
        ),
      };
      return structured(output);
    }
  );

  const createdSchema = z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
  });

  server.registerTool(
    "createIssue",
    {
      description: "Create a Linear issue.",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        assigneeEmail: z.string().optional(),
      }),
      outputSchema: createdSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      if (!world.receive({ tool: "createIssue", arguments: args })) {
        return failedOnRequest();
      }
      const sequence = world.state.issues.length + 1;
      const issue: LinearIssue = {
        id: `lin-${sequence}`,
        identifier: `ENG-${100 + sequence}`,
        title: args.title,
        description: args.description ?? "",
        assigneeEmail: args.assigneeEmail ?? null,
        state: "Todo",
      };
      world.state.issues.push(issue);
      const output = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: `https://linear.example/issue/${issue.identifier}`,
      };
      return structured(output);
    }
  );

  return server;
}
