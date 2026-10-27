// Random cases for the H3 property: Workflows over the Drift Kit's Tools,
// their inputs, and what the developer, the Drift Kit or a scheduler does
// between their runs.
import fc from "fast-check";
import { sentryDriftScenarios } from "../../drift-kit/index.ts";

// A Workflow over the Drift Kit's Tools, as the code an agent might write.
export type Program = {
  prefix: "[Sentry] " | "Bug: ";
  /** Skips a Sentry issue that already has a Linear issue. */
  dedupe: boolean;
  /** Only unresolved Sentry issues. */
  unresolvedOnly: boolean;
  /**
   * A parent issue written first, whose Placeholder each later write
   * carries in its description.
   */
  parent: boolean;
};

const programArb: fc.Arbitrary<Program> = fc.record({
  prefix: fc.constantFrom("[Sentry] ", "Bug: "),
  dedupe: fc.boolean(),
  unresolvedOnly: fc.boolean(),
  parent: fc.boolean(),
});

export function codeOf(program: Program): string {
  const filter = program.unresolvedOnly
    ? `(i) => i.count >= input.minEvents && i.status === "unresolved"`
    : `(i) => i.count >= input.minEvents`;
  return [
    `export async function main(input: { project: string; minEvents: number }) {`,
    `  const { issues } = await sdk.sentry.listIssues({ project: input.project });`,
    ...(program.parent
      ? [
          `  const parent = await sdk.linear.createIssue({ title: "Triage " + input.project });`,
        ]
      : []),
    `  const created = [];`,
    `  for (const issue of issues.filter(${filter})) {`,
    ...(program.dedupe
      ? [
          `    const { issues: existing } = await sdk.linear.searchIssues({ query: issue.shortId });`,
          `    if (existing.length > 0) continue;`,
        ]
      : []),
    `    const ticket = await sdk.linear.createIssue({`,
    `      title: ${JSON.stringify(program.prefix)} + issue.shortId,`,
    `      description: ${program.parent ? "parent.url" : "issue.culprit"},`,
    `    });`,
    `    created.push(ticket.identifier);`,
    `  }`,
    `  return created;`,
    `}`,
  ].join("\n");
}

export type Input = { project: string; minEvents: number };

const inputArb: fc.Arbitrary<Input> = fc.record({
  project: fc.constantFrom("web", "api"),
  minEvents: fc.constantFrom(0, 60, 200),
});

// What the developer, the Drift Kit or a scheduler does next. A pick
// chooses among what exists when the action runs, modulo its count, so
// actions build on earlier ones: a rerun repeats a recent Exploration Run
// or Workflow Run, which applies a plan approved since.
export type Action =
  | { kind: "explore"; program: number; input: Input }
  | { kind: "rerun"; pick: number }
  | { kind: "approve"; pick: number }
  | { kind: "decline"; pick: number }
  | { kind: "failWrite"; call: number }
  | { kind: "sentryDrift"; scenario: string; on: boolean }
  | { kind: "linearDrift"; on: boolean }
  | { kind: "save"; pick: number }
  | { kind: "run"; pick: number; input: Input }
  | { kind: "edit"; pick: number; program: number; budget: number }
  | { kind: "resume"; pick: number; sent: boolean };

const program = fc.nat({ max: 2 });
const pick = fc.nat({ max: 3 });
// Mostly the newest, as a developer reruns what they just approved.
const newest = fc.oneof(
  { weight: 3, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: pick }
);

function weighted<T>(
  weight: number,
  fields: { [K in keyof T]: fc.Arbitrary<T[K]> }
) {
  return { weight, arbitrary: fc.record(fields) as fc.Arbitrary<T> };
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  weighted(6, {
    kind: fc.constant("explore" as const),
    program,
    input: inputArb,
  }),
  weighted(20, { kind: fc.constant("rerun" as const), pick: newest }),
  weighted(16, { kind: fc.constant("approve" as const), pick: newest }),
  weighted(2, { kind: fc.constant("decline" as const), pick }),
  weighted(3, {
    kind: fc.constant("failWrite" as const),
    call: fc.integer({ min: 1, max: 3 }),
  }),
  weighted(2, {
    kind: fc.constant("sentryDrift" as const),
    scenario: fc.constantFrom(...sentryDriftScenarios),
    on: fc.boolean(),
  }),
  weighted(1, { kind: fc.constant("linearDrift" as const), on: fc.boolean() }),
  weighted(4, { kind: fc.constant("save" as const), pick }),
  weighted(6, { kind: fc.constant("run" as const), pick, input: inputArb }),
  weighted(2, {
    kind: fc.constant("edit" as const),
    pick,
    program,
    budget: fc.constantFrom(0, 1, 10),
  }),
  weighted(4, {
    kind: fc.constant("resume" as const),
    pick,
    sent: fc.boolean(),
  })
);

// A developer's usual steps, between which single actions interleave.
// Random actions alone rarely line up into these, so without them few
// cases would send a write:
// - review a new run and rerun it;
// - save a Workflow, approve its first run and let later runs go
//   unattended;
// - edit it, or let Drift change its Adapters, and approve it afresh;
// - change the Drift Kit's state between an Approval and its rerun;
// - resume an Apply that a failed write stopped.
const approveAndRerun: Action[] = [
  { kind: "approve", pick: 0 },
  { kind: "rerun", pick: 0 },
];
// A Workflow saved from a new Exploration Run, whose first run is approved
// and applied.
function firstApplied(program: number, input: Input): Action[] {
  return [
    { kind: "explore", program, input },
    { kind: "save", pick: 0 },
    { kind: "run", pick: 0, input },
    ...approveAndRerun,
  ];
}

const stepsArb: fc.Arbitrary<Action[]> = fc.oneof(
  { weight: 3, arbitrary: actionArb.map((action) => [action]) },
  {
    weight: 1,
    arbitrary: fc
      .record({ program, input: inputArb })
      .map(({ program, input }): Action[] => [
        { kind: "explore", program, input },
        ...approveAndRerun,
      ]),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ program, input: inputArb, again: inputArb })
      .map(({ program, input, again }): Action[] => [
        ...firstApplied(program, input),
        { kind: "run", pick: 0, input: again },
      ]),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        program,
        input: inputArb,
        to: fc.nat({ max: 2 }),
        budget: fc.constantFrom(0, 1, 10),
        again: inputArb,
      })
      .map(({ program, input, to, budget, again }): Action[] => [
        ...firstApplied(program, input),
        { kind: "edit", pick: 0, program: to, budget },
        { kind: "rerun", pick: 0 },
        ...approveAndRerun,
        { kind: "run", pick: 0, input: again },
      ]),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        program,
        input: inputArb,
        scenario: fc.constantFrom(...sentryDriftScenarios),
      })
      .map(({ program, input, scenario }): Action[] => [
        ...firstApplied(program, input),
        { kind: "sentryDrift", scenario, on: true },
        { kind: "rerun", pick: 0 },
        ...approveAndRerun,
        { kind: "rerun", pick: 0 },
      ]),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        program,
        project: fc.constantFrom("web", "api"),
        scenario: fc.option(fc.constantFrom(...sentryDriftScenarios)),
      })
      .map(({ program, project, scenario }): Action[] => [
        { kind: "explore", program, input: { project, minEvents: 0 } },
        { kind: "approve", pick: 0 },
        // Drift, or writes of the same code that a deduping Workflow then
        // finds, so its rerun would build another plan.
        ...(scenario !== null
          ? [{ kind: "sentryDrift", scenario, on: true } as const]
          : [
              {
                kind: "explore",
                program,
                input: { project, minEvents: 100 },
              } as const,
              ...approveAndRerun,
            ]),
        // The run approved first, now the oldest of up to three.
        { kind: "rerun", pick: scenario !== null ? 0 : 2 },
      ]),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        program,
        input: inputArb,
        call: fc.integer({ min: 1, max: 3 }),
        sent: fc.boolean(),
      })
      .map(({ program, input, call, sent }): Action[] => [
        { kind: "failWrite", call },
        { kind: "explore", program, input },
        ...approveAndRerun,
        { kind: "resume", pick: 0, sent },
      ]),
  }
);

export const caseArb = fc.record({
  programs: fc.array(programArb, { minLength: 3, maxLength: 3 }),
  actions: fc
    .array(stepsArb, { minLength: 3, maxLength: 10 })
    .map((steps) => steps.flat()),
});
