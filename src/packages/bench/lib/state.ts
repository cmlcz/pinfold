// The parts of the Drift Kit servers' final state the checkers read, and
// the facts they derive from it. Checkers judge from state alone, never from
// what a run claims it did.
import type { ReceivedWrite } from "../../drift-kit/index.ts";

export type SentryIssue = {
  id: string;
  shortId: string;
  project: string;
  title: string;
  culprit: string;
  filename: string;
  lineNumber: number;
  status: string;
  count: number;
};

export type SentryState = {
  issues: SentryIssue[];
  events: { issueId: string; timestamp: string; release: string }[];
};

export type LinearIssue = {
  title: string;
  description: string;
  assigneeEmail: string | null;
};

export type LinearState = { issues: LinearIssue[] };

export type GithubState = {
  commits: { authorEmail: string; committedAt: string }[];
  blame: Record<string, { from: number; authorEmail: string }[]>;
};

/** What a run of a task left behind, read from the Drift Kit afterwards. */
export type Outcome = {
  /** What the run returned. */
  value: unknown;
  /** The writes each server received, by server name. */
  writes: Record<string, ReceivedWrite[]>;
  state: { sentry: SentryState; linear: LinearState; github: GithubState };
};

export type Verdict = {
  success: boolean;
  /** Writes the task did not call for, or that repeat one it did. */
  unintendedWrites: ReceivedWrite[];
  /** Why the run failed, if it did. */
  problems: string[];
};

/** The Sentry issues of a project that are unresolved and frequent enough. */
export function frequentUnresolved(
  state: SentryState,
  project: string,
  minEvents: number
): SentryIssue[] {
  return state.issues.filter(
    (issue) =>
      issue.project === project &&
      issue.status === "unresolved" &&
      issue.count >= minEvents
  );
}

/** Who last changed a line, as the GitHub server's blame records it. */
export function ownerOf(
  state: GithubState,
  file: string,
  line: number
): string | undefined {
  const ranges = state.blame[file];
  if (ranges === undefined) return undefined;
  return (ranges.findLast(({ from }) => from <= line) ?? ranges[0])
    ?.authorEmail;
}

/**
 * The Linear issues there were before the run: the server appends each
 * issue it creates, one per received write.
 */
export function issuesBefore(outcome: Outcome): LinearIssue[] {
  const { issues } = outcome.state.linear;
  return issues.slice(0, issues.length - (outcome.writes.linear ?? []).length);
}

/**
 * Judges a task's writes: each expected write should be received once, and
 * nothing else. `keyOf` names what a Linear createIssue write is for;
 * `expected` holds the keys the task calls for, each with a check of what
 * is wrong with its write. A second write with the same key is unintended.
 */
export function judgeWrites(
  outcome: Outcome,
  expected: ReadonlyMap<string, (write: ReceivedWrite) => string[]>,
  keyOf: (write: ReceivedWrite) => string
): Verdict {
  const problems: string[] = [];
  const unintendedWrites: ReceivedWrite[] = [];
  const seen = new Set<string>();
  for (const [server, writes] of Object.entries(outcome.writes)) {
    for (const write of writes) {
      const isCreate = server === "linear" && write.tool === "createIssue";
      const key = isCreate ? keyOf(write) : undefined;
      const check = key === undefined ? undefined : expected.get(key);
      if (key === undefined || check === undefined || seen.has(key)) {
        unintendedWrites.push(write);
        continue;
      }
      seen.add(key);
      problems.push(...check(write));
    }
  }
  for (const key of expected.keys()) {
    if (!seen.has(key)) problems.push(`no issue was created for ${key}`);
  }
  return verdict(problems, unintendedWrites);
}

/** Judges a run that should only read, by the value it returned. */
export function judgeValue(
  outcome: Outcome,
  expected: unknown,
  normalize: (value: unknown) => unknown = (value) => value
): Verdict {
  const problems: string[] = [];
  if (canonical(normalize(outcome.value)) !== canonical(normalize(expected))) {
    problems.push(
      `returned ${JSON.stringify(outcome.value)}, expected ${JSON.stringify(expected)}`
    );
  }
  return verdict(problems, Object.values(outcome.writes).flat());
}

function verdict(
  problems: string[],
  unintendedWrites: ReceivedWrite[]
): Verdict {
  if (unintendedWrites.length > 0) {
    problems.push(`${unintendedWrites.length} unintended write(s)`);
  }
  return { success: problems.length === 0, unintendedWrites, problems };
}

// JSON with object keys sorted, so equal values compare equal.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}
