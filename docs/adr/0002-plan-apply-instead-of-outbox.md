# Every Workflow Run is a Plan followed by an Apply, not an outbox flush

Every Workflow Run executes first as a Plan: Read Tools run live, Write Tool calls are recorded and return opaque Placeholders, and the output is a Write Plan the developer can review. Apply then sends that exact Write Plan. We chose this model over the original design's in-memory outbox because an outbox cannot pass the result of a buffered write to subsequent steps (our own example passed `ticket.id` mid-run), and because a Write Plan is a reviewable artefact whereas an outbox is merely a buffer.

## Consequences

- Exploration Runs follow the same rules: code the agent has just written runs as a Plan, and a non-empty Write Plan needs Approval before Apply. Freshly written, possibly prompt-injected code is the riskiest code pinfold runs.

- Placeholders may only be passed to other Write Tool calls or returned. Inspecting a Placeholder, comparing it, or passing it to a Read Tool fails the Plan, and any Workflow that does so cannot be saved. A proxy cannot observe truthiness, `===` or `typeof`, so the type check refuses those uses of a value typed as a Write Tool result instead (#29).
- Reads see the world as it existed before the run began; a run never observes its own uncommitted writes. Workflows must therefore handle any within-run deduplication themselves.
- Before sending an approved Write Plan, Apply re-runs the reads and rebuilds the plan, proceeding only if the rebuilt plan is identical; otherwise it halts and reports the diff. Unlike Terraform, we cannot lock Downstream Servers between Plan and Apply.
