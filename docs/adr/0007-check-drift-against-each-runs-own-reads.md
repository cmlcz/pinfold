# Check Drift against each Workflow Run's own reads, after its Plan

A Workflow Run is checked for Drift against the fields that run read, once its Plan is done and before Apply, not against the Contract recorded when the Workflow was saved. The sandbox counts a read of a missing field too, since a renamed or removed field shows as one, and reports its reads even when the program fails.

The saved Contract is what one Exploration Run read on one path with one input. Checking against it alone let Drift in a field read only on another branch, or only after an edit, reach the Write Plan unchecked, and it kept stopping a Workflow edited to no longer read a drifted field. Nothing is sent before Apply, so checking once the Plan is done is as safe as stopping at the drifted response, and it sees exactly what the run used.

## Consequences

- The saved Contract still names the Workflows a Drift affects and what a Repair must keep working; a Repair also covers the reads of the run that found the Drift.
- A run that reads a field its Tool's Baseline does not allow stops before its plan, instead of the load-time check of the saved Contract.
- The program runs to its end on drifted data before the run stops, so its Read Tool calls after the drifted one are made too.
