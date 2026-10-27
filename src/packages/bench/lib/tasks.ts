// The six benchmark tasks. Each has an instruction for an agent, three
// inputs, a reference program (the Workflow Arm A4 runs) and a checker
// that judges a run from the Drift Kit's final state and received writes.
import {
  frequentUnresolved,
  issuesBefore,
  judgeValue,
  judgeWrites,
  ownerOf,
  type LinearIssue,
  type Outcome,
  type SentryIssue,
  type Verdict,
} from "./state.ts";

export type TaskInput = Record<string, string | number>;

export type Task = {
  name: string;
  category:
    | "read-heavy"
    | "multi-server join"
    | "write-heavy"
    | "large paginated responses"
    | "in-run deduplication"
    | "mixed";
  /** What an agent is asked to do, for one input. */
  instruction(input: TaskInput): string;
  inputs: readonly [TaskInput, TaskInput, TaskInput];
  /** A program that does the task, written against pinfold's SDK. */
  program: string;
  check(input: TaskInput, outcome: Outcome): Verdict;
};

type ProjectInput = { project: string; minEvents: number };

const errorDigest: Task = {
  name: "error-digest",
  category: "read-heavy",
  instruction: (input) => {
    const { project, minEvents } = input as ProjectInput;
    return `For every Sentry issue of project "${project}" with at least ${minEvents} events, whatever its status, return { shortId, count, status, latestRelease }, where latestRelease is the release of its newest event, or null if it has none. Return them as one array, most events first. Change nothing.`;
  },
  inputs: [
    { project: "web", minEvents: 0 },
    { project: "jobs", minEvents: 0 },
    { project: "jobs", minEvents: 100 },
  ],
  program: `export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const digest = [];
  for (const issue of issues.filter((i) => i.count >= input.minEvents)) {
    const { events } = await sdk.sentry.listIssueEvents({ issueId: issue.id });
    const newest = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    digest.push({
      shortId: issue.shortId,
      count: issue.count,
      status: issue.status,
      latestRelease: newest === undefined ? null : newest.release,
    });
  }
  return digest.sort((a, b) => b.count - a.count);
}`,
  check: (input, outcome) => {
    const { project, minEvents } = input as ProjectInput;
    const { issues, events } = outcome.state.sentry;
    const expected = issues
      .filter((issue) => issue.project === project && issue.count >= minEvents)
      .map((issue) => ({
        shortId: issue.shortId,
        count: issue.count,
        status: issue.status,
        latestRelease:
          events
            .filter((event) => event.issueId === issue.id)
            .toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
            ?.release ?? null,
      }))
      .sort((a, b) => b.count - a.count);
    return judgeValue(outcome, expected);
  },
};

const owners: Task = {
  name: "issue-owners",
  category: "multi-server join",
  instruction: (input) => {
    const { project, minEvents } = input as ProjectInput;
    return `For every unresolved Sentry issue of project "${project}" with at least ${minEvents} events, find who last changed the line it crashes on, using GitHub blame of the issue's filename and lineNumber. Return an array of { shortId, owner }, where owner is the author's email. Change nothing.`;
  },
  inputs: [
    { project: "web", minEvents: 50 },
    { project: "api", minEvents: 0 },
    { project: "jobs", minEvents: 100 },
  ],
  program: `export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const owners = [];
  for (const issue of issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents)) {
    const blame = await sdk.github.getBlame({ file: issue.filename, line: issue.lineNumber });
    owners.push({ shortId: issue.shortId, owner: blame.authorEmail });
  }
  return owners;
}`,
  check: (input, outcome) => {
    const { project, minEvents } = input as ProjectInput;
    const expected = frequentUnresolved(
      outcome.state.sentry,
      project,
      minEvents
    ).map((issue) => ({
      shortId: issue.shortId,
      owner: ownerOf(outcome.state.github, issue.filename, issue.lineNumber),
    }));
    // In any order.
    const sorted = (value: unknown) =>
      Array.isArray(value)
        ? value.toSorted((a, b) =>
            String(a?.shortId).localeCompare(String(b?.shortId))
          )
        : value;
    return judgeValue(outcome, expected, sorted);
  },
};

const fileIssues: Task = {
  name: "file-issues",
  category: "write-heavy",
  instruction: (input) => {
    const { project, minEvents } = input as ProjectInput;
    return `For every unresolved Sentry issue of project "${project}" with at least ${minEvents} events, create one Linear issue titled "[Sentry] <shortId>" with the issue's culprit as its description.`;
  },
  inputs: [
    { project: "jobs", minEvents: 0 },
    { project: "jobs", minEvents: 100 },
    { project: "web", minEvents: 50 },
  ],
  program: `export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const created = [];
  for (const issue of issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents)) {
    const ticket = await sdk.linear.createIssue({
      title: "[Sentry] " + issue.shortId,
      description: issue.culprit,
    });
    created.push(ticket.identifier);
  }
  return created;
}`,
  check: (input, outcome) => {
    const { project, minEvents } = input as ProjectInput;
    const expected = new Map(
      frequentUnresolved(outcome.state.sentry, project, minEvents).map(
        (issue) => [
          issue.shortId,
          () =>
            filed(outcome, `[Sentry] ${issue.shortId}`, {
              description: issue.culprit,
            }),
        ]
      )
    );
    return judgeWrites(outcome, expected, (write) =>
      String(write.arguments.title).replace(/^\[Sentry\] /, "")
    );
  },
};

const commitCounts: Task = {
  name: "commit-counts",
  category: "large paginated responses",
  instruction: (input) => {
    const since = input.since === undefined ? "" : ` since ${input.since}`;
    return `Count the GitHub repository's commits${since} by author email, going through every page of commits. Return an object from author email to count. Change nothing.`;
  },
  inputs: [
    { since: "2026-10-10T00:00:00Z" },
    { since: "2026-09-01T00:00:00Z" },
    {},
  ],
  program: `export async function main(input: { since?: string }) {
  const counts: Record<string, number> = {};
  let cursor: string | undefined;
  do {
    const page = await sdk.github.listCommits({
      ...(input.since !== undefined && { since: input.since }),
      ...(cursor !== undefined && { cursor }),
    });
    for (const commit of page.commits) {
      counts[commit.authorEmail] = (counts[commit.authorEmail] ?? 0) + 1;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return counts;
}`,
  check: (input, outcome) => {
    const since =
      input.since === undefined ? -Infinity : Date.parse(String(input.since));
    const expected: Record<string, number> = {};
    for (const commit of outcome.state.github.commits) {
      if (Date.parse(commit.committedAt) < since) continue;
      expected[commit.authorEmail] = (expected[commit.authorEmail] ?? 0) + 1;
    }
    return judgeValue(outcome, expected);
  },
};

const triage: Task = {
  name: "triage-once",
  category: "in-run deduplication",
  instruction: (input) => {
    const { project, minEvents } = input as ProjectInput;
    return `For every unresolved Sentry issue of project "${project}" with at least ${minEvents} events, make sure Linear has an issue for its culprit: unless a Linear issue already mentions the culprit, create one titled "[Sentry] <culprit>" with the culprit as its description. Several Sentry issues can share a culprit; create at most one Linear issue per culprit.`;
  },
  inputs: [
    { project: "jobs", minEvents: 0 },
    { project: "jobs", minEvents: 80 },
    { project: "api", minEvents: 0 },
  ],
  program: `export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const seen = new Set<string>();
  const created = [];
  for (const issue of issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents)) {
    if (seen.has(issue.culprit)) continue;
    seen.add(issue.culprit);
    const { issues: existing } = await sdk.linear.searchIssues({ query: issue.culprit });
    if (existing.length > 0) continue;
    const ticket = await sdk.linear.createIssue({
      title: "[Sentry] " + issue.culprit,
      description: issue.culprit,
    });
    created.push(ticket.identifier);
  }
  return created;
}`,
  check: (input, outcome) => {
    const { project, minEvents } = input as ProjectInput;
    const expected = new Map(
      newCulprits(outcome, project, minEvents).map((issue) => [
        issue.culprit,
        () =>
          filed(outcome, `[Sentry] ${issue.culprit}`, {
            description: issue.culprit,
          }),
      ])
    );
    return judgeWrites(outcome, expected, (write) =>
      String(write.arguments.description)
    );
  },
};

const assign: Task = {
  name: "triage-assign",
  category: "mixed",
  instruction: (input) => {
    const { project, minEvents } = input as ProjectInput;
    return `Find the unresolved Sentry issues of project "${project}" with at least ${minEvents} events. For each culprit among them that no Linear issue mentions yet, find who last changed the crashing line with GitHub blame, and create one Linear issue titled "[Sentry] <title of the first such Sentry issue>", with the culprit as its description, assigned to that author's email. Return { checked, created }: how many Sentry issues you checked, and the IDs of the issues you created.`;
  },
  inputs: [
    { project: "web", minEvents: 50 },
    { project: "api", minEvents: 0 },
    { project: "jobs", minEvents: 150 },
  ],
  program: `export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({ project: input.project });
  const frequent = issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents);
  const seen = new Set<string>();
  const created = [];
  for (const issue of frequent) {
    if (seen.has(issue.culprit)) continue;
    seen.add(issue.culprit);
    const existing = await sdk.linear.searchIssues({ query: issue.culprit });
    if (existing.issues.length > 0) continue;
    const blame = await sdk.github.getBlame({ file: issue.filename, line: issue.lineNumber });
    const ticket = await sdk.linear.createIssue({
      title: "[Sentry] " + issue.title,
      description: issue.culprit,
      assigneeEmail: blame.authorEmail,
    });
    created.push(ticket.id);
  }
  return { checked: frequent.length, created };
}`,
  check: (input, outcome) => {
    const { project, minEvents } = input as ProjectInput;
    const expected = new Map(
      newCulprits(outcome, project, minEvents).map((issue) => [
        issue.culprit,
        () =>
          filed(outcome, `[Sentry] ${issue.title}`, {
            description: issue.culprit,
            assigneeEmail:
              ownerOf(outcome.state.github, issue.filename, issue.lineNumber) ??
              null,
          }),
      ])
    );
    return judgeWrites(outcome, expected, (write) =>
      String(write.arguments.description)
    );
  },
};

export const tasks: readonly Task[] = [
  errorDigest,
  owners,
  fileIssues,
  commitCounts,
  triage,
  assign,
];

// What is wrong with the Linear issue a write should have created: it must
// be in the final state with this title and these fields.
function filed(
  outcome: Outcome,
  title: string,
  fields: Partial<LinearIssue>
): string[] {
  const issue = outcome.state.linear.issues.find(
    (candidate) => candidate.title === title
  );
  if (issue === undefined) return [`Linear has no issue titled ${title}`];
  const problems: string[] = [];
  for (const [key, wanted] of Object.entries(fields)) {
    const actual = issue[key as keyof LinearIssue];
    if (actual !== wanted) {
      problems.push(
        `${title} has ${key} ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`
      );
    }
  }
  return problems;
}

// The first frequent unresolved issue of each culprit that no Linear issue
// mentioned before the run, as Linear's search would find it.
function newCulprits(
  outcome: Outcome,
  project: string,
  minEvents: number
): SentryIssue[] {
  const before = issuesBefore(outcome).map((issue) =>
    `${issue.title}\n${issue.description}`.toLowerCase()
  );
  const candidates = frequentUnresolved(
    outcome.state.sentry,
    project,
    minEvents
  );
  const first = new Map<string, SentryIssue>();
  for (const issue of candidates) {
    const culprit = issue.culprit.toLowerCase();
    if (
      first.has(issue.culprit) ||
      before.some((text) => text.includes(culprit))
    )
      continue;
    first.set(issue.culprit, issue);
  }
  return [...first.values()];
}
