// A server shaped like GitHub's own MCP server (github/github-mcp-server)
// before it trimmed its responses. Each Drift Scenario is one of those
// trims, ported from the server's convertToMinimal* functions
// (pkg/github/minimal_types.go) and named after its pull request:
//
//   minimal-issue        #2022 issue_read
//   minimal-pull-request #2017 pull_request_read
//   minimal-release      #2091 list_releases
//   minimal-tag          #2088 list_tags
//   minimal-code-search  #2476 search_code
//
// The responses before a trim keep the fields of GitHub's REST API that the
// trim changes or drops, not every field the API sends.
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { listed, structured } from "../reply.ts";
import { createWorld, type World } from "../world.ts";

export const githubMcpDriftScenarios = [
  "minimal-issue",
  "minimal-pull-request",
  "minimal-release",
  "minimal-tag",
  "minimal-code-search",
] as const;

const user = z.object({
  login: z.string(),
  id: z.number(),
  html_url: z.string(),
  type: z.string(),
});
const label = z.object({ id: z.number(), name: z.string(), color: z.string() });
const milestone = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
});

const issueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  user,
  labels: z.array(label),
  assignees: z.array(user),
  milestone,
  closed_by: user,
  type: z.object({ id: z.number(), name: z.string() }),
  comments: z.number(),
});

const branch = z.object({
  label: z.string(),
  ref: z.string(),
  sha: z.string(),
  repo: z.object({ id: z.number(), full_name: z.string() }),
});
const pullRequestSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  merged: z.boolean(),
  user,
  labels: z.array(label),
  requested_reviewers: z.array(user),
  merged_by: user,
  head: branch,
  base: branch,
  milestone,
});

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string(),
  author: user,
  assets: z.array(z.object({ name: z.string(), download_count: z.number() })),
  created_at: z.string(),
  published_at: z.string(),
  tarball_url: z.string(),
});

const tagSchema = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string(), url: z.string() }),
  zipball_url: z.string(),
});

const codeResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  score: z.number(),
  repository: z.object({ id: z.number(), full_name: z.string() }),
});

type Issue = z.infer<typeof issueSchema>;
type PullRequest = z.infer<typeof pullRequestSchema>;
type Release = z.infer<typeof releaseSchema>;
type Tag = z.infer<typeof tagSchema>;
type CodeResult = z.infer<typeof codeResultSchema>;
type User = z.infer<typeof user>;

export type GithubMcpState = {
  issues: Issue[];
  pullRequests: PullRequest[];
  releases: Release[];
  tags: Tag[];
  code: CodeResult[];
};

const logins = ["mona", "hubot", "octocat", "li"];
const person = (index: number): User => ({
  login: logins[index % logins.length]!,
  id: 100 + (index % logins.length),
  html_url: `https://github.com/${logins[index % logins.length]}`,
  type: "User",
});
const labelsOf = (index: number) =>
  ["bug", "ui", "infra", "docs"]
    .slice(index % 2, (index % 2) + 2)
    .map((name, at) => ({ id: 10 + at, name, color: "ededed" }));
const milestoneOf = (index: number) => ({
  number: 1 + (index % 2),
  title: `v${1 + (index % 2)}.0`,
  state: "open",
});
const sha = (index: number, salt: string) =>
  `${salt}${index}`.padEnd(40, "0").slice(0, 40);
const repo = (index: number) => ({
  id: 7 + (index % 2),
  full_name: ["acme/web", "acme/jobs"][index % 2]!,
});

function seed(): GithubMcpState {
  const four = [0, 1, 2, 3];
  return {
    issues: four.map((index) => ({
      id: 9000 + index,
      number: 1 + index,
      title: `Issue ${1 + index}`,
      state: index % 2 === 0 ? "open" : "closed",
      html_url: `https://github.com/acme/web/issues/${1 + index}`,
      user: person(index),
      labels: labelsOf(index),
      assignees: [person(index + 1), person(index + 2)],
      milestone: milestoneOf(index),
      closed_by: person(index + 3),
      type: { id: 50 + (index % 2), name: ["Bug", "Task"][index % 2]! },
      comments: 3 * index,
    })),
    pullRequests: four.map((index) => ({
      id: 8000 + index,
      number: 10 + index,
      title: `Change ${10 + index}`,
      state: "closed",
      merged: true,
      user: person(index),
      labels: labelsOf(index + 1),
      requested_reviewers: [person(index + 2)],
      merged_by: person(index + 1),
      head: {
        label: `acme:feature-${index}`,
        ref: `feature-${index}`,
        sha: sha(index, "f"),
        repo: repo(index),
      },
      base: {
        label: "acme:main",
        ref: "main",
        sha: sha(index, "b"),
        repo: repo(index),
      },
      milestone: milestoneOf(index + 1),
    })),
    releases: four.map((index) => ({
      id: 700 + index,
      tag_name: `v1.${index}.0`,
      name: `Release 1.${index}`,
      author: person(index),
      assets: [{ name: "app.tar.gz", download_count: 40 + 17 * index }],
      created_at: `2026-0${1 + index}-01T09:00:00Z`,
      published_at: `2026-0${1 + index}-02T09:00:00Z`,
      tarball_url: `https://api.github.com/repos/acme/web/tarball/v1.${index}.0`,
    })),
    tags: four.map((index) => ({
      name: `v1.${index}.0`,
      commit: {
        sha: sha(index, "c"),
        url: `https://api.github.com/repos/acme/web/commits/${sha(index, "c")}`,
      },
      zipball_url: `https://api.github.com/repos/acme/web/zipball/v1.${index}.0`,
    })),
    code: four.map((index) => ({
      name: `file${index}.ts`,
      path: `src/file${index}.ts`,
      sha: sha(index, "e"),
      score: 1 + index / 4,
      repository: repo(index),
    })),
  };
}

export function createGithubMcpWorld(): World<GithubMcpState> {
  return createWorld(seed, githubMcpDriftScenarios);
}

// The convertToMinimal* functions, for the fields the before shape has.
const minimalUser = (u: User) => ({
  login: u.login,
  id: u.id,
  profile_url: u.html_url,
});
const minimal = {
  issue: (issue: Issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url,
    user: minimalUser(issue.user),
    labels: issue.labels.map((l) => l.name),
    assignees: issue.assignees.map((a) => a.login),
    milestone: issue.milestone.title,
    comments: issue.comments,
    closed_by: issue.closed_by.login,
    issue_type: issue.type.name,
  }),
  pullRequest: (pr: PullRequest) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    user: minimalUser(pr.user),
    labels: pr.labels.map((l) => l.name),
    requested_reviewers: pr.requested_reviewers.map((r) => r.login),
    merged_by: pr.merged_by.login,
    head: {
      ref: pr.head.ref,
      sha: pr.head.sha,
      repo: { full_name: pr.head.repo.full_name },
    },
    base: {
      ref: pr.base.ref,
      sha: pr.base.sha,
      repo: { full_name: pr.base.repo.full_name },
    },
    milestone: pr.milestone.title,
  }),
  release: (release: Release) => ({
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    author: minimalUser(release.author),
    published_at: release.published_at,
  }),
  tag: (tag: Tag) => ({ name: tag.name, sha: tag.commit.sha }),
  code: (result: CodeResult) => ({
    name: result.name,
    path: result.path,
    sha: result.sha,
    repository: result.repository.full_name,
  }),
};

export function createGithubMcpServer(world: World<GithubMcpState>): McpServer {
  const server = new McpServer({
    name: "drift-kit-github-mcp",
    version: "0.0.0",
  });
  const on = (scenario: (typeof githubMcpDriftScenarios)[number]) =>
    world.drift.has(scenario);
  const missing = (what: string) => ({
    content: [{ type: "text" as const, text: `no ${what}` }],
    isError: true,
  });

  server.registerTool(
    "issue_read",
    {
      description: "Get an issue of acme/web by its number.",
      inputSchema: z.object({ number: z.number() }),
      outputSchema: listed(issueSchema, world),
      annotations: { readOnlyHint: true },
    },
    async ({ number }) => {
      const issue = world.state.issues.find((i) => i.number === number);
      if (issue === undefined) return missing(`issue ${number}`);
      return structured(on("minimal-issue") ? minimal.issue(issue) : issue);
    }
  );

  server.registerTool(
    "pull_request_read",
    {
      description: "Get a pull request of acme/web by its number.",
      inputSchema: z.object({ number: z.number() }),
      outputSchema: listed(pullRequestSchema, world),
      annotations: { readOnlyHint: true },
    },
    async ({ number }) => {
      const pr = world.state.pullRequests.find((p) => p.number === number);
      if (pr === undefined) return missing(`pull request ${number}`);
      return structured(
        on("minimal-pull-request") ? minimal.pullRequest(pr) : pr
      );
    }
  );

  server.registerTool(
    "list_releases",
    {
      description: "List the releases of acme/web.",
      inputSchema: z.object({}),
      outputSchema: listed(
        z.object({ releases: z.array(releaseSchema) }),
        world
      ),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { releases } = world.state;
      return structured({
        releases: on("minimal-release")
          ? releases.map(minimal.release)
          : releases,
      });
    }
  );

  server.registerTool(
    "list_tags",
    {
      description: "List the tags of acme/web.",
      inputSchema: z.object({}),
      outputSchema: listed(z.object({ tags: z.array(tagSchema) }), world),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { tags } = world.state;
      return structured({
        tags: on("minimal-tag") ? tags.map(minimal.tag) : tags,
      });
    }
  );

  server.registerTool(
    "search_code",
    {
      description: "Search code across acme's repositories.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: listed(
        z.object({ total_count: z.number(), items: z.array(codeResultSchema) }),
        world
      ),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { code } = world.state;
      return structured(
        on("minimal-code-search")
          ? {
              total_count: code.length,
              incomplete_results: false,
              items: code.map(minimal.code),
            }
          : { total_count: code.length, items: code }
      );
    }
  );

  return server;
}
