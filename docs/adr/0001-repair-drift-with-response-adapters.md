# Repair drift with per-Tool Response Adapters, never by editing Workflow code

When a Downstream Server's response shape drifts, pinfold writes or updates a declarative Response Adapter that maps the live response back to the Tool's pinned Baseline; it never edits a Workflow file. Each Tool has a single Baseline, pinned when the Tool is first used, and every Workflow accesses the Tool through that Baseline. As a result, a single reviewed Response Adapter repairs every Workflow that uses the Tool, while adopting a newer upstream shape requires an explicit Baseline Migration rather than happening silently.

## Considered Options

- **Let an LLM edit the Workflow code** (our original design, and how most "self-healing" tools work). Rejected: a code edit can silently alter business logic, and the only check it must pass is the edited code itself. A 2026 case study on autonomous test repair (arXiv 2605.01471) found agents reaching "superficial convergence" through assertion weakening and test deletion; verifying repairs against a frozen Contract that the repair process cannot touch rules this out.
- **Freeze a separate Contract per Workflow at save time, without a shared Baseline.** Rejected: two Workflows saved a month apart could expect different shapes for the same Tool, preventing a single Response Adapter from serving both.

## Consequences

- Repairs are small, reviewable mappings. For ambiguous field renames, Approval can display value evidence comparing candidate live values against the historical Fixture values of the missing field.
- New fields added by a Downstream Server remain invisible to Workflows until an explicit Baseline Migration.
- Drift that cannot be expressed as a single-response mapping (for example, a Tool that now requires an extra call to fetch the same data) is outside the scope of Repair and must be resolved manually.

