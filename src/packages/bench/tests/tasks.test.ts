import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCore, openPlans, type PinfoldConfig } from "../../core/index.ts";
import {
  connectControl,
  serveDriftKitHttp,
  type ControlClient,
  type HttpDriftKitServer,
} from "../../drift-kit/index.ts";
import {
  benchClassification,
  tasks,
  type Outcome,
  type Task,
  type TaskInput,
} from "../index.ts";

const names = ["sentry", "linear", "github"] as const;

let dir: string;
let servers: HttpDriftKitServer[];
let controls: Record<(typeof names)[number], ControlClient>;
let config: PinfoldConfig;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pinfold-bench-"));
  servers = await Promise.all(
    names.map((name) =>
      serveDriftKitHttp(name, { control: join(dir, `${name}.sock`) })
    )
  );
  controls = Object.fromEntries(
    names.map((name) => [name, connectControl(join(dir, `${name}.sock`))])
  ) as typeof controls;
  config = {
    servers: Object.fromEntries(
      names.map((name, index) => [name, { url: servers[index]!.url }])
    ),
    classification: benchClassification,
  };
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await rm(dir, { recursive: true, force: true });
});

// Runs a program through pinfold on freshly seeded servers, approving its
// Write Plan, and reads what it left behind.
async function outcomeOf(program: string, input: TaskInput): Promise<Outcome> {
  await Promise.all(names.map((name) => controls[name].reset()));
  const root = await mkdtemp(join(dir, "run-"));
  const core = await openCore(config, { root });
  try {
    let result = await core.explore({ code: program, input });
    if (result.ok && result.status === "pending") {
      await openPlans(root).approve(result.plan.id);
      result = await core.explore({ code: program, input });
    }
    if (!result.ok) throw new Error(result.error);
    expect(result.status).toMatch(/^(complete|applied)$/);
    const read = async (name: (typeof names)[number]) =>
      [name, await controls[name].receivedWrites()] as const;
    return {
      value: result.value,
      writes: Object.fromEntries(await Promise.all(names.map(read))),
      state: {
        sentry: (await controls.sentry.state()) as Outcome["state"]["sentry"],
        linear: (await controls.linear.state()) as Outcome["state"]["linear"],
        github: (await controls.github.state()) as Outcome["state"]["github"],
      },
    };
  } finally {
    await core.close();
  }
}

function task(name: string): Task {
  return tasks.find((candidate) => candidate.name === name)!;
}

describe("benchmark tasks", () => {
  it("are six, one per category, each with three inputs", () => {
    expect(tasks.map((task) => task.category)).toEqual([
      "read-heavy",
      "multi-server join",
      "write-heavy",
      "large paginated responses",
      "in-run deduplication",
      "mixed",
    ]);
    for (const task of tasks) {
      expect(task.inputs).toHaveLength(3);
      expect(
        new Set(task.inputs.map((input) => JSON.stringify(input))).size
      ).toBe(3);
    }
  });

  for (const each of tasks) {
    it(`passes ${each.name} when its reference program runs on every input`, async () => {
      for (const input of each.inputs) {
        const outcome = await outcomeOf(each.program, input);

        expect(each.check(input, outcome)).toEqual({
          success: true,
          unintendedWrites: [],
          problems: [],
        });
      }
    });
  }
});

// A plausible wrong program for each task, and the input it goes wrong on.
const wrong: Record<
  string,
  { input: TaskInput; program: string; problem: RegExp; unintended?: number }
> = {
  "error-digest": {
    input: { project: "web", minEvents: 0 },
    // Skips the events, so no latest release is known.
    program: `export async function main(input: { project: string; minEvents: number }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      return issues
        .filter((i) => i.count >= input.minEvents)
        .map((i) => ({ shortId: i.shortId, count: i.count, status: i.status, latestRelease: null }))
        .sort((a, b) => b.count - a.count);
    }`,
    problem:
      /^returned .*"latestRelease":null.*, expected .*"latestRelease":"web@3\.4\.1"/,
  },
  "issue-owners": {
    input: { project: "web", minEvents: 50 },
    // Blames the first line of the file, not the crashing one.
    program: `export async function main(input: { project: string; minEvents: number }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      const owners = [];
      for (const issue of issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents)) {
        const blame = await sdk.github.getBlame({ file: issue.filename, line: 1 });
        owners.push({ shortId: issue.shortId, owner: blame.authorEmail });
      }
      return owners;
    }`,
    problem: /^returned .*"owner":"li@example\.com"/,
  },
  "file-issues": {
    input: { project: "jobs", minEvents: 0 },
    // Files resolved and ignored issues too.
    program: `export async function main(input: { project: string; minEvents: number }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      for (const issue of issues.filter((i) => i.count >= input.minEvents)) {
        await sdk.linear.createIssue({ title: "[Sentry] " + issue.shortId, description: issue.culprit });
      }
    }`,
    problem: /^2 unintended write\(s\)$/,
    unintended: 2,
  },
  "commit-counts": {
    input: { since: "2026-09-01T00:00:00Z" },
    // Reads the first page only.
    program: `export async function main(input: { since: string }) {
      const page = await sdk.github.listCommits({ since: input.since });
      const counts: Record<string, number> = {};
      for (const commit of page.commits) counts[commit.authorEmail] = (counts[commit.authorEmail] ?? 0) + 1;
      return counts;
    }`,
    problem: /^returned /,
  },
  "triage-once": {
    input: { project: "jobs", minEvents: 0 },
    // Checks Linear but not its own earlier writes, which a Plan's reads
    // cannot see.
    program: `export async function main(input: { project: string; minEvents: number }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      for (const issue of issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents)) {
        const { issues: existing } = await sdk.linear.searchIssues({ query: issue.culprit });
        if (existing.length > 0) continue;
        await sdk.linear.createIssue({ title: "[Sentry] " + issue.culprit, description: issue.culprit });
      }
    }`,
    problem: /^2 unintended write\(s\)$/,
    unintended: 2,
  },
  "triage-assign": {
    input: { project: "web", minEvents: 50 },
    // Assigns everything to one person.
    program: `export async function main(input: { project: string; minEvents: number }) {
      const { issues } = await sdk.sentry.listIssues({ project: input.project });
      const frequent = issues.filter((i) => i.status === "unresolved" && i.count >= input.minEvents);
      const created = [];
      for (const issue of frequent) {
        const ticket = await sdk.linear.createIssue({
          title: "[Sentry] " + issue.title,
          description: issue.culprit,
          assigneeEmail: "ana@example.com",
        });
        created.push(ticket.id);
      }
      return { checked: frequent.length, created };
    }`,
    problem:
      /has assigneeEmail "ana@example\.com", expected "kim@example\.com"$/,
  },
};

describe("benchmark checkers", () => {
  for (const [
    name,
    { input, program, problem, unintended = 0 },
  ] of Object.entries(wrong)) {
    it(`fail ${name} when a wrong program runs, and say why`, async () => {
      const verdict = task(name).check(input, await outcomeOf(program, input));

      expect(verdict.success).toBe(false);
      expect(verdict.problems).toContainEqual(expect.stringMatching(problem));
      expect(verdict.unintendedWrites).toHaveLength(unintended);
    });
  }
});
