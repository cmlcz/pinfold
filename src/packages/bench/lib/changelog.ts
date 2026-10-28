// H2's changelog set: Drift taken from a real MCP server's changelog, apart
// from the generated grid. github/github-mcp-server trimmed its responses
// to "minimal" shapes in a series of pull requests; the Drift Kit's
// githubMcp server ports those trims. Each scenario here is one field a
// Workflow might read and one trim that changes or keeps it, and a run
// checks whether deterministic Repair maps the trimmed responses back to
// the values the Workflow read before.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openCore, type WorkflowRunResult } from "../../core/index.ts";
import { connectControl, serveDriftKitHttp } from "../../drift-kit/index.ts";
import { approvedRun } from "./h2.ts";

type Call = { tool: string; args: Record<string, unknown>[] };

const issues: Call = {
  tool: "issue_read",
  args: [1, 2, 3, 4].map((number) => ({ number })),
};
const pullRequests: Call = {
  tool: "pull_request_read",
  args: [10, 11, 12, 13].map((number) => ({ number })),
};
const releases: Call = { tool: "list_releases", args: [{}] };
const tags: Call = { tool: "list_tags", args: [{}] };
const code: Call = { tool: "search_code", args: [{ query: "fetch" }] };

export type ChangelogScenario = {
  /** The pull request of github/github-mcp-server that made the change. */
  pr: number;
  /** The githubMcp Drift Scenario that ports it. */
  scenario: string;
  call: Call;
  /** The field the Workflow reads, as a path from the response's root. */
  read: string;
  /** What the trim did to it. */
  change: string;
  /** The closed-set ops that would map it back, if any do. */
  mappableBy?: string;
};

const issue = { pr: 2022, scenario: "minimal-issue", call: issues };
const pr = { pr: 2017, scenario: "minimal-pull-request", call: pullRequests };
const release = { pr: 2091, scenario: "minimal-release", call: releases };
const tag = { pr: 2088, scenario: "minimal-tag", call: tags };
const search = { pr: 2476, scenario: "minimal-code-search", call: code };

export const changelogScenarios: ChangelogScenario[] = [
  { ...issue, read: "user.login", change: "kept" },
  { ...issue, read: "comments", change: "kept" },
  {
    ...issue,
    read: "user.html_url",
    change: "renamed user.profile_url",
    mappableBy: "rename",
  },
  {
    ...issue,
    read: "milestone.title",
    change: "milestone became its title",
    mappableBy: "wrap",
  },
  {
    ...issue,
    read: "closed_by.login",
    change: "closed_by became its login",
    mappableBy: "wrap",
  },
  {
    ...issue,
    read: "type.name",
    change: "type became issue_type, its name",
    mappableBy: "rename, then wrap",
  },
  {
    ...issue,
    read: "labels[].name",
    change: "each label became its name",
  },
  {
    ...issue,
    read: "assignees[].login",
    change: "each assignee became its login",
  },
  { ...issue, read: "id", change: "dropped" },
  { ...pr, read: "head.repo.full_name", change: "kept" },
  {
    ...pr,
    read: "user.html_url",
    change: "renamed user.profile_url",
    mappableBy: "rename",
  },
  {
    ...pr,
    read: "merged_by.login",
    change: "merged_by became its login",
    mappableBy: "wrap",
  },
  {
    ...pr,
    read: "milestone.title",
    change: "milestone became its title",
    mappableBy: "wrap",
  },
  {
    ...pr,
    read: "requested_reviewers[].login",
    change: "each reviewer became its login",
  },
  { ...pr, read: "head.label", change: "dropped" },
  { ...release, read: "releases[].tag_name", change: "kept" },
  {
    ...release,
    read: "releases[].author.html_url",
    change: "renamed author.profile_url",
    mappableBy: "rename",
  },
  { ...release, read: "releases[].created_at", change: "dropped" },
  {
    ...release,
    read: "releases[].assets[].download_count",
    change: "dropped with assets",
  },
  {
    ...tag,
    read: "tags[].commit.sha",
    change: "moved up to sha",
    mappableBy: "rename",
  },
  { ...tag, read: "tags[].zipball_url", change: "dropped" },
  {
    ...search,
    read: "items[].repository.full_name",
    change: "repository became its full_name",
    mappableBy: "wrap",
  },
  { ...search, read: "items[].score", change: "dropped" },
];

export type ChangelogOutcome =
  "repaired" | "wrong repair" | "unrepaired" | "unaffected" | "missed";

export type ChangelogResult = ChangelogScenario & {
  outcome: ChangelogOutcome;
  detail: string;
};

/**
 * The Workflow that reads a scenario's field: each call's value at the
 * path, `[]` mapping over an array.
 */
export function programFor(scenario: ChangelogScenario): string {
  const expression = (path: string[], value: string): string => {
    const [step, ...rest] = path;
    if (step === undefined) return value;
    if (step.endsWith("[]")) {
      return `${value}.${step.slice(0, -2)}.map((e) => ${expression(rest, "e")})`;
    }
    return expression(rest, `${value}.${step}`);
  };
  const { tool, args } = scenario.call;
  return `export async function main() {
  const out = [];
  for (const args of ${JSON.stringify(args)}) {
    const r = await sdk.githubMcp.${tool}(args);
    out.push(${expression(scenario.read.split("."), "r")});
  }
  return out;
}`;
}

/** Runs each scenario against a fresh project and githubMcp server. */
export async function runChangelog(
  scenarios: readonly ChangelogScenario[] = changelogScenarios
): Promise<ChangelogResult[]> {
  const dir = await mkdtemp(join(tmpdir(), "pinfold-changelog-"));
  const control = join(dir, "githubMcp.sock");
  const server = await serveDriftKitHttp("githubMcp", { control });
  const world = connectControl(control);
  const results: ChangelogResult[] = [];
  try {
    for (const scenario of scenarios) {
      await world.reset();
      const root = await mkdtemp(join(dir, "run-"));
      const core = await openCore(
        {
          servers: { githubMcp: { url: server.url } },
          classification: {
            githubMcp: Object.fromEntries(
              [issues, pullRequests, releases, tags, code].map(({ tool }) => [
                tool,
                "read",
              ])
            ),
          },
        },
        { root }
      );
      try {
        results.push({ ...scenario, ...(await tryScenario(scenario)) });
      } finally {
        await core.close();
      }

      async function tryScenario(
        entry: ChangelogScenario
      ): Promise<{ outcome: ChangelogOutcome; detail: string }> {
        const explored = await core.explore({
          code: programFor(entry),
          input: {},
        });
        if (!explored.ok) throw new Error(`${entry.read}: ${explored.error}`);
        const saved = await core.saveWorkflow({
          run: explored.exploration,
          name: "w",
          confirmed: true,
        });
        if (!saved.ok) throw new Error(`${entry.read}: ${saved.error}`);
        const before = valueOf(await approvedRun(core, root, {}));
        await world.reset();
        await world.startDrift(entry.scenario);
        const after = await approvedRun(core, root, {});
        if (!after.ok) {
          const detail = after.error.split("\n")[0]!;
          return {
            outcome: /drifted|manual fix/.test(after.error)
              ? "unrepaired"
              : "missed",
            detail: reasonOf(after.error) ?? detail,
          };
        }
        const same = isDeepStrictEqual(after.value, before);
        if (after.repairs !== undefined) {
          return {
            outcome: same ? "repaired" : "wrong repair",
            // The ops the Repair added, as its diff marks them.
            detail: after.repairs
              .flatMap(({ diff }) =>
                diff.filter((line) => line.startsWith("+"))
              )
              .join(", "),
          };
        }
        return {
          outcome: same ? "unaffected" : "missed",
          detail: same ? "" : "the run read other values, with no Drift found",
        };
      }
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
  return results;
}

function valueOf(result: WorkflowRunResult): unknown {
  if (!result.ok)
    throw new Error(`the run before Drift failed: ${result.error}`);
  return result.value;
}

// Why pinfold found no Repair, from a stopped run's error.
function reasonOf(error: string): string | undefined {
  return /pinfold found no Repair to propose: (.*?)\. The Drift is recorded/.exec(
    error
  )?.[1];
}

/** The changelog set's outcomes, as Markdown. */
export function formatChangelog(
  results: readonly ChangelogResult[],
  provenance: Record<string, string>
): string {
  const mappable = results.filter((result) => result.mappableBy !== undefined);
  const repaired = mappable.filter((result) => result.outcome === "repaired");
  const count = (outcome: ChangelogOutcome) =>
    results.filter((result) => result.outcome === outcome).length;
  return [
    "# H2 changelog set",
    "",
    ...Object.entries(provenance).map(([key, value]) => `- ${key}: ${value}`),
    "",
    `Deterministic Repair alone repaired **${repaired.length} of ${mappable.length}** fields whose change an Adapter op could map back. Over all ${results.length} fields: ${count("repaired")} repaired, ${count("wrong repair")} wrong repairs, ${count("unrepaired")} stopped with nothing sent, ${count("unaffected")} unaffected, ${count("missed")} missed.`,
    "",
    "| PR | Tool | Field read | Change | Mappable by | Outcome | Detail |",
    "| ---: | :--- | :--- | :--- | :--- | :--- | :--- |",
    ...results.map(
      (result) =>
        `| [#${result.pr}](https://github.com/github/github-mcp-server/pull/${result.pr}) | \`${result.call.tool}\` | \`${result.read}\` | ${result.change} | ${result.mappableBy ?? "-"} | ${result.outcome} | ${result.detail.replaceAll("|", "\\|")} |`
    ),
    "",
  ].join("\n");
}
