# Migrate a Baseline from live responses, and reset the Response Adapter

A Baseline Migration re-pins a Tool's Baseline from the responses its server gives now, not from the output schema the server lists. pinfold calls a Read Tool again with the arguments of its calls in the Fixtures and infers the shape. It keeps the listed schema only when every live response fits it, and it keeps the old Baseline's schema of each field whose live values all still fit, so a rename does not also lose an enum. The migration then writes the Tool's Response Adapter as a new version with no ops.

A listing can lag behind what a server sends: pinfold already takes responses as they come rather than as listed, and Drift Kit servers keep listing their old schema under Drift. Re-pinning from the listing would leave the Baseline where it was.

## Considered Options

- **Re-pin from the server's listing.** Rejected: a stale listing would make the migration a no-op while the responses have moved on.
- **Rebase the Adapter's ops onto the new Baseline.** Rejected: the new Baseline is the live shape, so no op is needed; any rebase would map responses onto themselves.
- **Track a digest of each Baseline in the run history to require Approval.** Rejected for now: Approval already follows Adapter digests, and the plan ID covers them. Resetting the Adapter as a new version changes its digest, so the next run of each affected Workflow pauses for Approval through the same path as a Repair.

## Consequences

- A Read Tool can be migrated only if the Fixtures hold a call of it whose arguments were not redacted. A Write Tool is never called, so only its listing can give its new shape.
- The Fixtures keep the responses as the old Baseline had them, so deterministic Repair compares later Drift against values recorded at the old paths until the Workflows are saved again.
- An Adapter file with no ops exists for a migrated Tool even if it had none before; its version marks the migration.
