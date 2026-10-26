# Glossary — pinfold

pinfold is a local MCP Gateway that lets a coding agent solve a multi-tool task once in code, saves the result as a Workflow the developer owns, and runs that Workflow again without an LLM—showing every write in a plan before it is sent.

## Servers and tools

**Gateway**:
The single MCP server the agent connects to, standing in front of every Downstream Server.
_Avoid_: proxy, hub, bridge

**Downstream Server**:
An MCP server the Gateway connects to on the developer's behalf (e.g., Sentry, GitHub, Linear).
_Avoid_: upstream server, upstream API, backend

**Tool**:
A single operation exposed by a Downstream Server.
_Avoid_: endpoint, function, capability

**Read Tool**:
A Tool the developer has classified as not changing anything outside the Gateway.
_Avoid_: safe tool, query tool

**Write Tool**:
Any Tool not classified as a Read Tool. Every Tool is treated as a Write Tool until the developer says otherwise; server annotations are only a suggestion.
_Avoid_: mutating tool, destructive tool, side-effect tool

## Runs and workflows

**Exploration Run**:
A one-off execution of code written by the agent to solve the task in front of it.
_Avoid_: sandbox run, first run, code-mode run

**Workflow**:
A saved, parameterized program derived from a successful Exploration Run and kept as a source file the developer owns and may edit.
_Avoid_: skill, compiled workflow, script, recipe

**Exposed Workflow**:
A Workflow whose settings opt it into appearing as its own tool of the Gateway, named after it and taking main's input as its arguments. Its runs are Workflow Runs, as through run_workflow.
_Avoid_: workflow tool, published workflow

**Workflow Run**:
One execution of a saved Workflow with specific inputs, consisting of a Plan followed by an Apply.
_Avoid_: replay, invocation

**Fixture**:
The recorded Tool requests and responses captured from the Exploration Run a Workflow was saved from.
_Avoid_: snapshot, recording, cassette

## Plan and apply

**Plan**:
The first phase of a Workflow Run, in which Read Tools execute live and calls to Write Tools are recorded instead of sent.
_Avoid_: dry run, preview, simulation

**Write Plan**:
The ordered list of Write Tool calls produced by a Plan for the developer to review.
_Avoid_: outbox, planned write preview, changeset

**Placeholder**:
The opaque stand-in value returned by a recorded Write Tool call during a Plan, in place of the real result that will exist after Apply.
_Avoid_: mock value, symbolic value, future

**Apply**:
The second phase of a Workflow Run, which sends the approved Write Plan to the Downstream Servers.
_Avoid_: commit, flush, execute

**Approval**:
The developer's acceptance of a specific Write Plan and the Response Adapters it was built through, required before Apply when the developer has never approved writes of a Workflow's code as it is now, when a Response Adapter it depends on is new or updated, or when the Write Plan exceeds the Workflow's Write Budget.
_Avoid_: confirmation, sign-off

**Approval Dialog**:
The dialog in which the developer's MCP client asks for Approval of a paused run through MCP elicitation, showing the Write Plan and the Repair behind each Response Adapter it was built through. Approving runs the same request again, which applies the plan only if it rebuilds the same one.
_Avoid_: confirmation prompt, popup

**Apply Journal**:
The persistent record of which calls in a Write Plan have already been sent, allowing an interrupted Apply to resume without sending any call twice.
_Avoid_: run log, outbox, idempotency table

**Write Budget**:
The maximum number of Write Tool calls a Workflow's Write Plan may contain without requiring Approval.
_Avoid_: write cap, max writes, circuit breaker

## Contracts and drift

**Baseline**:
The shape of a Tool, both what it accepts and what it returns, pinned the first time the Tool is called, through which every Workflow accesses that Tool.
_Avoid_: schema version, snapshot, original schema

**Contract**:
The subset of a Tool's Baseline response shape that a specific Workflow actually reads, as recorded from the run it was saved from. Each Workflow Run is checked against the fields it reads itself, which an edit or another input may change.
_Avoid_: schema, assertion, expectation

**Drift**:
A discrepancy between a Tool as its Downstream Server offers it now (its responses after the current Response Adapter, or the inputs it accepts) and its pinned Baseline. A Workflow Run is affected only when Drift touches the fields it reads or the inputs it sends.
_Avoid_: breaking change, API change, schema mismatch

**Response Adapter**:
A declarative mapping—one per Tool—that translates the Tool's live response back to its pinned Baseline.
_Avoid_: patch, shim, transformer, lens

**Repair**:
Producing a new version of a Tool's Response Adapter after Drift is detected.
_Avoid_: self-healing, fix, patching

**Repair Model**:
The small model, named in the config, that proposes a Repair unattended when deterministic search finds none. Its proposal is checked and approved like an agent's.
_Avoid_: LLM fallback, AI repair

**Drift Scenario**:
A named, reproducible kind of Drift (such as a renamed field or a newly wrapped response) that a test Downstream Server can apply on demand.
_Avoid_: breaking change, fault, mutation

**Drift Kit**:
The collection of test Downstream Servers and Drift Scenarios used to test, demonstrate, and measure Repair.
_Avoid_: mock servers, benchmark, harness

**Baseline Migration**:
A deliberate, developer-initiated update of a Tool to a newer Baseline, after which the Workflows that use that Tool are checked against the new shape.
_Avoid_: upgrade, rebase

## Measurement

**Arm**:
One experimental setup in the benchmark, compared against the others on identical tasks: plain MCP tool calling (`A1`), code mode without saving (`A2`), an agent reusing a saved skill (`A3`), or a pinfold Workflow Run (`A4`).
_Avoid_: baseline (reserved for a Tool's pinned shape), condition, variant

**Break-even Point**:
The number of runs required for a Workflow's upfront and maintenance costs (its Exploration Run, saving it, and any Repairs) to be paid back by the per-run savings over another Arm.
_Avoid_: payback, ROI
