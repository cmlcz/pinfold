# Take Approval through MCP elicitation, and trust the client to show it

A run that pauses for Approval asks the developer in an Approval Dialog when the MCP client declares elicitation forms. The Gateway returns `inputRequired` with the Write Plan as the dialog's message; the SDK's legacy shim sends it as `elicitation/create` to 2025-era clients. Accept approves the plan the dialog showed and runs the same request again, which applies it only if it rebuilds the same plan; a different plan gets a new dialog. Decline declines the plan; closing the dialog leaves it pending for `pinfold approve`. Taking the answer lives in core, beside the terminal's Approval; the Gateway only carries it.

Until now, only the developer's terminal could approve: no MCP tool can, so the agent cannot approve its own writes. An Approval Dialog keeps that, since the answer comes from the client's user interface rather than from a tool call the agent makes. It moves trust to the client, though: a client, or a hook in it, that answers elicitations without showing them approves every plan unread. The README warns against that.

## Considered Options

- **Keep Approval in the terminal only.** Rejected: switching to a terminal for every plan is the friction #16 removes, and the agent still cannot approve.
- **An `approve_plan` tool that takes a code shown only in the terminal.** Rejected: the agent would hold the code once the developer types it into the chat, and the plan would still be read in the terminal.
- **Trust the plan ID that comes back with the answer as is.** Rejected: in the 2026-07-28 protocol, `requestState` round-trips through the client. The Gateway seals it with an HMAC key of its own process, so an answer can only approve the plan its dialog showed.

## Consequences

- The Gateway serves only 2025-era protocols for now, so `requestState` stays in its process; the seal guards the day it serves 2026-07-28.
- A seal and a dialog round last an hour. A longer wait ends the call with an error, and the plan waits for `pinfold approve`.
- Approval of a plan already approved in a terminal while its dialog was open counts as given, so the run goes on.
