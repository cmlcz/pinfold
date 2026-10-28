# Generate the H2 scenario grid from what the tasks read

H2's Drift Scenario set is generated, not chosen. For each field that one of the six tasks' reference programs reads, on any of its inputs, the grid holds a rename and a removal of that field, a type change if it is a number, and an enum change if its Baseline lists values. For each Tool a task calls, the grid also holds a wrapped response and, for a response that holds a list and is not paged already, pagination. `src/packages/bench/h2-scenarios.json` holds the result. A test regenerates the grid and fails if it differs from the committed file, so the set stays fixed before any run.

The Drift Kit applies these field-level scenarios to any Tool's response by name (`<kind>:<tool>[:<path>]`). A renamed field follows one fixed rule: a camelCase name becomes snake_case; a one-word field of array elements takes the element's noun as a prefix, so `issues[].count` becomes `issueCount`; any other one-word field gains a `Value` suffix.

A scenario is mappable when a Response Adapter op can express the change: rename, type change, enum change and wrap. A removed field has no value to map from, and pages need calls that an Adapter cannot make. H2's rate counts runs, where a run is one task's Workflow facing one scenario: it counts as repaired only if the repaired run then passes the task's checker.

## Considered Options

- **A hand-picked list of scenarios.** Rejected: whoever picks them can pick ones Repair handles, and the six named Sentry scenarios already show that bias is easy.
- **Synonyms for renamed fields, such as `count` to `total`.** Rejected for the grid: a synonym table is another choice that shapes the result. Renames that share no words belong in the set of scenarios taken from real MCP server changelogs, which H2 reports apart.
- **Counting scenarios rather than runs.** Rejected: a scenario that several Workflows read would count once whether Repair fixed it for one of them or all.

## Consequences

- The rename rule keeps the old name's words in the new one, which favours deterministic Repair's name matching. The H2 report must say so. The changelog set, not built yet, is the check against it.
- Changing a task's reference program or the Drift Kit's seeds can change the grid. Then the grid must be regenerated and committed, and earlier results do not compare with later ones.
- Type changes cover numbers only. A date that turns into epoch milliseconds is left out, since Baselines do not mark which strings are dates.
