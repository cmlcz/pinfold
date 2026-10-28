import * as z from "zod";

export const blameSchema = z.object({
  file: z.string(),
  line: z.number(),
  commit: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  committedAt: z.string(),
});

export type Blame = z.infer<typeof blameSchema>;

export const commitSchema = z.object({
  sha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  message: z.string(),
  committedAt: z.string(),
});

export type Commit = z.infer<typeof commitSchema>;

const authors = [
  { name: "Ana", email: "ana@example.com" },
  { name: "Li", email: "li@example.com" },
  { name: "Sam", email: "sam@example.com" },
  { name: "Kim", email: "kim@example.com" },
  { name: "Joe", email: "joe@example.com" },
] as const;

// Who last changed which lines, by file: each range runs from its first
// line to the next range's, and names its author by index.
const ranges: Readonly<
  Record<string, readonly [from: number, author: number, commit: string][]>
> = {
  "src/checkout.ts": [
    [1, 1, "c0ffee1"],
    [30, 0, "c0ffee2"],
  ],
  "src/sync-worker.ts": [
    [1, 2, "c0ffee3"],
    [100, 3, "c0ffee4"],
  ],
  "src/format.ts": [[1, 4, "c0ffee5"]],
  "src/orders.ts": [
    [1, 0, "c0ffee6"],
    [80, 1, "c0ffee7"],
  ],
  "src/jobs/mailer.ts": [[1, 2, "c0ffee8"]],
  "src/jobs/billing.ts": [
    [1, 3, "c0ffee9"],
    [150, 4, "c0ffeea"],
  ],
  "src/jobs/export.ts": [[1, 1, "c0ffeeb"]],
  "src/jobs/cleanup.ts": [[1, 0, "c0ffeec"]],
  "src/jobs/sync.ts": [
    [1, 4, "c0ffeed"],
    [100, 2, "c0ffeee"],
  ],
  "src/jobs/report.ts": [[1, 3, "c0ffeef"]],
};

/** A run of lines of a file, from its first line on, last changed together. */
export type BlameRange = {
  from: number;
  commit: string;
  authorName: string;
  authorEmail: string;
};

/**
 * The blame of every file, by path. The files are the ones the Sentry
 * server's issues crash in.
 */
export const seedBlame: Readonly<Record<string, readonly BlameRange[]>> =
  Object.fromEntries(
    Object.entries(ranges).map(([file, fileRanges]) => [
      file,
      fileRanges.map(([from, author, commit]) => ({
        from,
        commit,
        authorName: authors[author]!.name,
        authorEmail: authors[author]!.email,
      })),
    ])
  );

/** The blame of a line, or undefined for a file the repository lacks. */
export function blameOf(
  blame: Readonly<Record<string, readonly BlameRange[]>>,
  file: string,
  line: number
): Blame | undefined {
  const fileRanges = blame[file];
  if (fileRanges === undefined) return undefined;
  const { commit, authorName, authorEmail } =
    fileRanges.findLast(({ from }) => from <= line) ?? fileRanges[0]!;
  return {
    file,
    line,
    commit,
    authorName,
    authorEmail,
    committedAt: "2026-10-01T12:00:00Z",
  };
}

const messages = [
  "Fix flaky checkout test",
  "Bump dependencies",
  "Refactor sync worker queue",
  "Add price formatting tests",
  "Tune order reservation retries",
  "Update README",
];

/**
 * 480 commits, newest first, one every three hours back from the seed's
 * day. Authors and messages follow a fixed sequence, so every reset seeds
 * the same history.
 */
export const seedCommits: readonly Commit[] = Array.from(
  { length: 480 },
  (_, index) => {
    // A linear congruential sequence: varied, but the same on every run.
    const pick = (index * 7919 + 13) % 101;
    const author = authors[pick % authors.length]!;
    return {
      sha: (0x5eed000 + index).toString(16),
      authorName: author.name,
      authorEmail: author.email,
      message: messages[pick % messages.length]!,
      committedAt: new Date(
        Date.UTC(2026, 9, 17, 21) - index * 3 * 60 * 60 * 1000
      )
        .toISOString()
        .replace(".000Z", "Z"),
    };
  }
);
