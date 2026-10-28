import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { listed, respond } from "../reply.ts";
import { createWorld, type World } from "../world.ts";
import {
  blameOf,
  blameSchema,
  commitSchema,
  seedBlame,
  seedCommits,
  type BlameRange,
  type Commit,
} from "./seed.ts";

export type GithubState = {
  commits: Commit[];
  blame: Record<string, BlameRange[]>;
};

export function createGithubWorld(): World<GithubState> {
  return createWorld(
    () => ({
      commits: structuredClone([...seedCommits]),
      blame: structuredClone(seedBlame) as Record<string, BlameRange[]>,
    }),
    [],
    ["getBlame", "listCommits"]
  );
}

// listCommits answers in pages this long, as GitHub's API does.
const pageSize = 50;

export function createGithubServer(world: World<GithubState>): McpServer {
  const server = new McpServer({ name: "drift-kit-github", version: "0.0.0" });

  server.registerTool(
    "getBlame",
    {
      description: "Get who last changed a line of a file in the repository.",
      inputSchema: z.object({ file: z.string(), line: z.number() }),
      outputSchema: listed(blameSchema, world),
      annotations: { readOnlyHint: true },
    },
    async ({ file, line }) => {
      const blame = blameOf(world.state.blame, file, line);
      if (blame === undefined) {
        return {
          content: [{ type: "text", text: `no file ${file}` }],
          isError: true,
        };
      }
      return respond(world, "getBlame", blame);
    }
  );

  server.registerTool(
    "listCommits",
    {
      description:
        "List the repository's commits, newest first, in pages of 50. Pass a page's nextCursor to get the next one.",
      inputSchema: z.object({
        since: z
          .string()
          .optional()
          .describe("Only commits at or after this ISO 8601 time"),
        cursor: z.string().optional(),
      }),
      outputSchema: listed(
        z.object({
          commits: z.array(commitSchema),
          nextCursor: z.string().nullable(),
        }),
        world
      ),
      annotations: { readOnlyHint: true },
    },
    async ({ since, cursor }) => {
      const matching = world.state.commits.filter(
        (commit) =>
          since === undefined ||
          Date.parse(commit.committedAt) >= Date.parse(since)
      );
      const start = cursor === undefined ? 0 : Number(cursor);
      const end = start + pageSize;
      return respond(world, "listCommits", {
        commits: matching.slice(start, end),
        nextCursor: end < matching.length ? String(end) : null,
      });
    }
  );

  return server;
}
