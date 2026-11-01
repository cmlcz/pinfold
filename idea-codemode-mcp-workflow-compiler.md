# pinfold: plan-first workflows that survive API drift

_Design document for pinfold v1. Status: the Gateway, Plan and Apply, Repair, Baseline Migration, Approval in the client and `pinfold stats` are built. The benchmark is not built yet (§10.2). Last reviewed 2026-10-27._

pinfold is a local MCP (Model Context Protocol) **Gateway** for coding agents such as Claude Code, Codex CLI and Antigravity CLI. An agent solves a multi-tool task once by writing a short TypeScript program during an **Exploration Run**. pinfold saves that program as a **Workflow** the developer owns, and runs it again without an LLM. Two ideas distinguish pinfold from existing tools:

1. **Every Workflow Run is a Plan followed by an Apply.** **Read Tools** run live, and calls to **Write Tools** are recorded into a **Write Plan** instead of being sent. Apply sends that Write Plan and nothing else.
2. **Drift is repaired at the boundary, not in the Workflow's code.** Each **Tool** is pinned to a **Baseline** response shape. When a **Downstream Server** changes its responses, pinfold proposes a new version of the Tool's **Response Adapter**, a declarative mapping back to the Baseline. Once the developer approves it, every Workflow that uses the Tool runs again unchanged. No LLM ever edits a Workflow file.

In one sentence: an agent writes the Workflow once; pinfold runs it as Downstream Servers change, and sends no write outside a Write Plan that the developer approved or that meets the conditions for running unattended (§4.3).

Capitalized terms introduced in **bold** are defined in [GLOSSARY.md](GLOSSARY.md). Architectural decisions live in [docs/adr/](docs/adr/). Configuration and commands are documented in the [README](README.md).

---

## 1. The problem

- **Repeating solved work.** An agent that triaged yesterday's CI failures plans the same task from scratch today. Every repeat consumes tokens or subscription quota, takes the time of a full agent loop, and can fail in new ways.
- **Saved code goes stale.** Saving the agent's code and reusing it has already been proposed by Anthropic and implemented by several tools (§3). Saved code that reads a Downstream Server's responses breaks when the server renames a field or wraps a response. Tools that repair such breaks by letting an LLM edit the code can alter business logic to make checks pass. A 2026 study of autonomous test repair found agents converging through "assertion weakening and test-case deletion" (arXiv 2605.01471).
- **Writes are the dangerous part.** A reused program that crashes halfway through, retries, or runs after a faulty repair can create duplicate tickets or post wrong messages. Reelier, the closest existing tool (§3), avoids this by running saved work read-only by default.

How large these costs are is what the benchmark measures (§10). This document makes no numeric claim that it does not test.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Reuse an agent's solved multi-tool task as a Workflow that runs with no LLM (tested by H1, §10.3).
2. Keep Workflows running through Drift without editing their code: repair deterministically where one mapping stands out, and otherwise through the developer's agent or a Repair Model (tested by H2).
3. Send no write outside a Write Plan that the developer approved or that meets the conditions for running unattended (tested by H3).
4. Run from a fresh clone on a CI runner, and later from npm (tested by H4; publishing is tracked in [#23](https://github.com/cmlcz/pinfold/issues/23)).

### 2.2 Scope of v1

| Item                                                                                                                                                                                                                           | Status                                                     |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| Gateway with six fixed tools (`search_sdk`, `run_sandbox`, `save_workflow`, `list_workflows`, `run_workflow`, `propose_repair`) and opt-in Exposed Workflows; stdio and Streamable HTTP Downstream Servers with static headers | Built                                                      |
| Per-Tool Read/Write classification, TypeScript SDK generation from Baselines, SDK signature search                                                                                                                             | Built                                                      |
| QuickJS/Wasm sandbox with time, memory and Tool-call limits                                                                                                                                                                    | Built                                                      |
| Exploration Runs and the `save_workflow` checks                                                                                                                                                                                | Built                                                      |
| Plan and Apply with Placeholders, Approval in the terminal and in an **Approval Dialog**, the Apply Journal, `pinfold resume` and `pinfold resolve`                                                                            | Built                                                      |
| Baselines, Contracts, Response Adapters; deterministic Repair, Repair through the agent, and an optional Repair Model                                                                                                          | Built                                                      |
| Developer-initiated **Baseline Migration** and marking a Baseline field optional ([ADR 0008](docs/adr/0008-baseline-migration-from-live-responses.md))                                                                         | Built                                                      |
| Redacted, git-ignored Fixtures                                                                                                                                                                                                 | Built                                                      |
| `pinfold stats`                                                                                                                                                                                                                | Built                                                      |
| Property-based tests of H3 over the Drift Kit                                                                                                                                                                                  | Built                                                      |
| **Drift Kit** with Sentry-, Linear- and GitHub-shaped servers and six **Drift Scenarios**                                                                                                                                      | Built                                                      |
| The six benchmark tasks and their checkers (`src/packages/bench/`)                                                                                                                                                             | Built                                                      |
| `pinfold bench` with the four Arms and the minimal loop, Claude Code and Codex CLI drivers ([ADR 0011](docs/adr/0011-pin-the-cli-drivers-through-a-local-proxy.md))                                                            | Built                                                      |
| The lifecycle experiment with published results                                                                                                                                                                                | Planned: [#22](https://github.com/cmlcz/pinfold/issues/22) |
| A `pinfold` command from a clone (`npm link`)                                                                                                                                                                                  | Built                                                      |
| A build to JavaScript in `dist/`, run by CI through `npx` from the packed tarball                                                                                                                                              | Built                                                      |
| npm publication                                                                                                                                                                                                                | Planned: [#23](https://github.com/cmlcz/pinfold/issues/23) |

### 2.3 Non-goals

- Downstream Servers that require OAuth flows.
- `sdk.ai.extract` or any LLM call inside a Workflow.
- Team, hosted, or multi-tenant deployments.
- Response Adapters that execute arbitrary code.
- Baseline Migration that runs without the developer.
- Full benchmark runs on Antigravity CLI.

---

## 3. Prior art and what is new

Checked against primary sources on 2026-10-18. Items marked † come from a background literature scan and were not read in full.

| Work                                                   | What it does                                                                                                    | Relation to pinfold                                                                            |
| :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| Cloudflare Code Mode (2025-09-26)                      | Exposes MCP tools as a TypeScript API inside a short-lived V8 isolate                                           | Same first step; nothing is saved across runs                                                  |
| Anthropic, _Code execution with MCP_ (2025-11-04)      | Proposes code mode where agents "persist their own code as reusable functions" (skills)                         | Suggests saving code, without execution guarantees, drift handling, or write control           |
| Anthropic programmatic tool calling (2025-11-24)       | Lets the model write code that calls tools inside a sandbox                                                     | Code mode inside the API; nothing is persisted                                                 |
| `datalayer/agent-codemode`                             | Implements code mode with `save_skill` and `run_skill`                                                          | Persists scripts, without validation, write control, or drift handling                         |
| Reelier (`seldonframe/reelier`)                        | Records MCP tool-call traces into skills with assertions; read-only by default; `diff` reports `SAME`/`DRIFTED` | Closest match: detects drift, but has no plans, no adapters, and undocumented repair mechanics |
| ASI, _Inducing Programmatic Skills_ (arXiv 2504.06821) | Induces programmatic skills for web agents and re-induces them when sites change                                | Repairs by regenerating code, without fixtures or a human gate                                 |
| TraceCompiler (arXiv 2608.02680)†                      | Compiles agent traces into mostly deterministic workflows; refuses underdetermined irreversible effects         | Similar stance to pinfold's Placeholder rules                                                  |
| Atomix (arXiv 2602.14849)†                             | Buffers agent effects until commit and gates irreversible ones                                                  | Stages effects, but is not MCP-specific and produces no reviewable plan                        |
| UiPath Healing Agent                                   | Repairs broken RPA UI selectors, optionally in recommend-only mode                                              | Human-gated repair, scoped to UI selectors                                                     |
| Ink & Switch, Cambria                                  | Translates between document schema versions using bidirectional lenses                                          | Direct inspiration for Response Adapters                                                       |

**Already established:** code mode, saving successful scripts, trace-to-workflow compilation with assertions, drift detection, and buffering writes.

**What pinfold adds:**

- A reviewable **Write Plan** built with opaque **Placeholders** and applied exactly as reviewed.
- **Repair** through a per-Tool Response Adapter against a pinned Baseline. A Repair is checked against the fields the Workflows read, shared by every Workflow that uses the Tool, and shown with value evidence from the **Fixtures**.
- A Drift Kit and benchmark that measure whether saved Workflows survive **Drift** and what they cost compared with an agent. The literature scan found no existing benchmark for this.

---

## 4. How it works: an end-to-end example

A developer connects Claude Code to pinfold with three Downstream Servers configured: Sentry, GitHub and Linear. The developer has marked `sentry.listIssues`, `linear.searchIssues` and `github.getBlame` as Read Tools. Every other Tool, including `linear.createIssue`, stays a Write Tool ([ADR 0004](docs/adr/0004-tools-are-write-tools-by-default.md)).

### 4.1 Exploration Run

The developer asks: _"Find unresolved Sentry issues from the last 24 hours with at least 50 events, find who last changed the crashing line, and create a Linear issue assigned to them unless one exists."_

The agent calls `search_sdk` to find the relevant TypeScript signatures, then calls `run_sandbox` once:

```typescript
export async function main(input: { project: string; minEvents: number }) {
  const { issues } = await sdk.sentry.listIssues({
    project: input.project,
    statsPeriod: "24h",
  });
  const frequent = issues.filter(
    (i) => i.count >= input.minEvents && i.status === "unresolved"
  );

  const created = [];
  for (const issue of frequent) {
    const existing = await sdk.linear.searchIssues({ query: issue.culprit });
    if (existing.issues.length > 0) continue;

    const blame = await sdk.github.getBlame({
      file: issue.filename,
      line: issue.lineNumber,
    });
    const ticket = await sdk.linear.createIssue({
      title: `[Sentry] ${issue.title}`,
      description: issue.culprit,
      assigneeEmail: blame.authorEmail,
    });
    created.push(ticket.id); // a Placeholder during a Plan; allowed because it is only returned
  }
  return { checked: frequent.length, created };
}
```

The code runs in the sandbox under the same Plan rules as any Workflow Run. The `createIssue` calls are recorded into a Write Plan and need Approval before Apply, so freshly written code cannot send a write unseen. `ticket.id` is itself a Placeholder, which may be returned or passed to another Write Tool, also nested inside its arguments. Large Sentry responses stay in the sandbox; only the return value reaches the agent, with Placeholders replaced by real results after Apply. pinfold records the Read Tool calls with their responses as Fixtures, and tracks which response fields the code read.

The `searchIssues` call finds the tickets earlier runs filed, because each ticket's description holds the culprit it searches for. Deduplicating across runs is the Workflow's job: pinfold never deduplicates separate runs (§6.1).

### 4.2 Saving the Workflow

The developer says _"save that as `triage_sentry`"_. `save_workflow` succeeds only if every check passes:

- the code exports a typed `main(input)` function;
- the Exploration Run finished without error and respected the Placeholder rules;
- the code type-checks against the generated SDK; and
- the agent passes the developer's confirmation of the run's result. pinfold cannot verify this confirmation; it only refuses a save without one.

Saving works only from the Gateway session that ran the Exploration Run, which keeps unredacted responses in memory only.

Each Tool's Baseline was already pinned during the Exploration Run. A Tool that lists an output schema is pinned to it. Otherwise pinfold infers the shape from the first response in which every array shows its elements. Until a Tool is pinned, the SDK types its result from its listed schema, or as `unknown`. When the checks pass, pinfold writes:

- `.workflows/triage_sentry.ts`, an ordinary TypeScript file the developer owns and may edit;
- the Workflow's **Contract**: the Baseline fields the code read, such as `count`, `status`, `culprit`, `filename`, `lineNumber` and `title` on `sentry.listIssues`; and
- the Fixtures under `.workflows/fixtures/`, git-ignored, with the fields named by the developer's redaction rules replaced. Without rules, nothing is redacted.

### 4.3 Routine Workflow Runs

A saved Workflow runs from cron or CI (`pinfold run triage_sentry --project web --minEvents 50`), or when the agent calls `run_workflow`. Each **Workflow Run** has two phases, with Approval between them when it is required:

1. **Plan.** The code runs in the sandbox. Read Tools execute live. Each Write Tool call is recorded and returns an opaque Placeholder. `Date` stands still and `Math.random` is seeded for the whole run. The output is a Write Plan, identified by a hash of its writes and of the Response Adapters it was built through:

   ```text
   Write Plan 7f3c09a1b2c4: 2 writes, none sent yet
     1. linear.createIssue {"assigneeEmail":"ana@…","title":"[Sentry] TypeError in checkout.ts"}
     2. linear.createIssue {"assigneeEmail":"li@…","title":"[Sentry] Timeout in sync-worker"}
   ```

2. **Approval, when required.** The run pauses for **Approval** when any of these holds; otherwise it meets the conditions for running unattended:
   - the developer has never approved writes of the Workflow's code as it is now (any edit to the file requires Approval again);
   - a Response Adapter the run read through is new or changed since its last finished run;
   - the Write Plan has more writes than the Workflow's **Write Budget** (10 unless the file's settings say otherwise).

   A run without writes pauses too when an Adapter changed: its result is held back until the developer approves the Adapter.

   The developer approves the paused plan in the terminal with `pinfold approve`, or in an Approval Dialog of the agent's client where the client supports MCP elicitation forms ([ADR 0009](docs/adr/0009-approval-through-mcp-elicitation.md)). Declining means no run sends that plan.

3. **Apply.** A run that meets the conditions for running unattended sends its own Write Plan. After Approval, the same code and input must run again: the developer or cron reruns the Workflow, the agent calls the same tool again, or the Approval Dialog reruns it at once. That run reuses the approved run's clock and seed, so it rebuilds the same plan if the reads are unchanged. pinfold sends the writes only if the rebuilt plan's ID equals the approved one. Otherwise nothing is sent, and the run shows the approved and the new plan and asks for Approval again. Each sent write is recorded in the **Apply Journal**.

No LLM runs during a Workflow Run, unless Drift makes pinfold ask a configured Repair Model (§4.4).

Unattended runs on a CI runner need the state that `.pinfold/` holds (approvals and the Apply Journal) and the Fixtures in `.workflows/fixtures/`. Both are git-ignored, so a CI setup must keep them between jobs, for example in a cache. Otherwise every run with writes pauses, and deterministic Repair has no Fixture values to compare against.

### 4.4 Drift and Repair

Two months later, Sentry's MCP server renames `count` to `eventCount`.

1. **Drift detection.** Once the Plan is done, the fields the run read are checked against the Baseline. The response from `sentry.listIssues`, after its Response Adapter, no longer has `count`, which this run read. The run stops before Apply, so no write is sent ([ADR 0007](docs/adr/0007-check-drift-against-each-runs-own-reads.md)). Only runs that read a drifted field stop.
2. **Deterministic Repair.** pinfold searches for a mapping from the live responses back to the Baseline. It scores each candidate by how alike the field names are and how well its values agree with the Fixture values. `eventCount` holds values like the Fixtures' `count`, and no other field does, so pinfold writes a new version of the Response Adapter:

   ```json
   {
     "server": "sentry",
     "tool": "listIssues",
     "version": 1,
     "ops": [
       { "op": "rename", "from": "issues[].eventCount", "to": "issues[].count" }
     ]
   }
   ```

   `issues[]` stands for every element of the `issues` array. The ops come from a closed set: `rename`, `wrap`, `unwrap`, `convert`, `map` and `default` (README).

3. **When deterministic Repair finds nothing.** pinfold records the Drift as pending, and runs that read the drifted fields stop.
   - If the developer configured a **Repair Model**, pinfold first asks it for ops, unattended, and checks them like its own. A proposal that fails keeps the Drift pending. The model is not asked again until the Drift changes, and each call's token use is logged.
   - Otherwise, or if the model's ops fail, `list_workflows` and the stopped run point the developer's agent to `propose_repair`. That tool shows the pending Drift and takes the agent's proposed ops.
4. **Review and Approval.** A new or changed Response Adapter makes the next run of every Workflow that uses the Tool pause for Approval. The Approval view shows:
   - the Adapter diff;
   - value evidence, for example "`issues[].count`: now median 112, range 50–3,400; in the Fixtures median 108, range 51–2,900";
   - the Write Plan.
5. **One Repair for every Workflow.** `triage_sentry.ts` is never modified. Every other Workflow that calls `sentry.listIssues` reads through the same Response Adapter version once the developer approves it.

---

## 5. Architecture

```text
 Agent client (Claude Code / Codex CLI / Antigravity CLI)      pinfold CLI (run, list, classify, plans, approve, decline,
                 │ MCP (stdio)                                   resume, resolve, baseline, stats; bench planned)
                 ▼                                                               │
 ┌──────────────────────────────────── pinfold ──────────────────────────────────┴─────┐
 │  Gateway: search_sdk, run_sandbox, save_workflow, list_workflows, run_workflow,     │
 │           propose_repair, and opt-in Exposed Workflows                              │
 │                                                                                     │
 │  SDK generator ── Tool classification (Read/Write) ── signature search              │
 │  Sandbox (QuickJS/Wasm) ◄── sdk.* host functions ── Plan engine (Placeholders, reads)│
 │  Baselines · Contracts · Response Adapters ── Repair (deterministic → model / agent) │
 │  Approval (terminal; Approval Dialog where supported) ── Apply + Apply Journal       │
 │  Model client (OpenRouter, optional)                                                │
 └─────────────────────────────────────────────────────────────────────────────────────┘
                 │ MCP (stdio / Streamable HTTP with static headers)
                 ▼
 Downstream Servers (Sentry, GitHub, Linear, …)
```

| Component                       | Responsibility                                                                                                                                                        | Key decisions                                                                                                                                                                                               |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway                         | Exposes one MCP server to the agent with six fixed tools, plus each Exposed Workflow as its own tool, registered at startup                                           | [ADR 0003](docs/adr/0003-build-a-thin-gateway.md); Exposed Workflows are opt-in and need a Gateway restart (§9)                                                                                             |
| SDK generator                   | Compiles Downstream Server tool schemas into TypeScript definitions from pinned Baselines                                                                             | Types follow the pinned Baseline, not the live schema                                                                                                                                                       |
| Tool classification             | Treats every Tool as a Write Tool until the developer marks it as a Read Tool                                                                                         | [ADR 0004](docs/adr/0004-tools-are-write-tools-by-default.md); MCP annotations only pre-fill a suggestion                                                                                                   |
| Sandbox                         | Runs transpiled TypeScript in QuickJS/Wasm with no host access except `sdk.*`; by default 30 s, 64 MiB and 100 Tool calls per run, which the `limits` setting changes | [ADR 0005](docs/adr/0005-quickjs-wasm-sandbox.md); the runtime sits behind an interface                                                                                                                     |
| Plan engine                     | Records writes, issues opaque Placeholders, tracks the fields each run reads, and keeps reads from seeing unapplied writes                                            | [ADR 0002](docs/adr/0002-plan-apply-instead-of-outbox.md)                                                                                                                                                   |
| Contracts and Response Adapters | Pins Baselines, records per-Workflow Contracts, checks each run's reads, and versions Response Adapters                                                               | [ADR 0001](docs/adr/0001-repair-drift-with-response-adapters.md), [ADR 0007](docs/adr/0007-check-drift-against-each-runs-own-reads.md), [ADR 0008](docs/adr/0008-baseline-migration-from-live-responses.md) |
| Repair                          | Runs deterministic Repair first, then the Repair Model if configured, then the developer's agent; all proposals are checked the same way                              | Limited to the closed set of declarative ops ([ADR 0001](docs/adr/0001-repair-drift-with-response-adapters.md))                                                                                             |
| Approval                        | Shows the Write Plan, the Adapter diff and value evidence; no MCP tool approves                                                                                       | Terminal everywhere; Approval Dialog where the client supports elicitation forms ([ADR 0009](docs/adr/0009-approval-through-mcp-elicitation.md))                                                            |
| Apply and Apply Journal         | Sends an approved or unattended plan, stops at the first failed write, and holds a write that may have been sent in doubt                                             | `pinfold resume` skips writes the journal records as sent; `pinfold resolve` settles a write in doubt                                                                                                       |
| Model client                    | Optional OpenRouter client for the Repair Model and, once built, the benchmark                                                                                        | Off unless a Repair Model is named and `OPENROUTER_API_KEY` is set                                                                                                                                          |

**On-disk layout.** Workflows, Baselines, Contracts and Response Adapters live in `.workflows/` and are committed to version control. Fixtures live in `.workflows/fixtures/` and are git-ignored. Run history, approvals, the Apply Journal (SQLite through `node:sqlite`) and the logs that `stats` reads live in `.pinfold/`, also git-ignored. pinfold needs Node 22.18 or newer. It runs from a clone today; npm publication under the MIT license is planned (§2.2).

---

## 6. Guarantees and their limits

### 6.1 What pinfold guarantees

These hold as long as only the developer, not the agent, runs `pinfold approve`, `classify` and `resolve`, and edits `.pinfold/` and the classification in `pinfold.json` (§7, risk R1).

- **No write outside an approved or unattended plan.** A write reaches a Downstream Server only as part of a Write Plan that the developer approved, or that met the conditions for running unattended (§4.3). After Approval, a write is sent only if the rebuilt plan's ID equals the approved one.
- **No Placeholder used as data.** A Placeholder may only be passed to a Write Tool or returned from `main`. Formatting a Placeholder, calling it, or passing it to a Read Tool fails the Plan, and a Workflow that does so cannot be saved. The SDK types every Write Tool result as `Placeholder<T>`, so the type check refuses code where one decides an `if`, a loop, a conditional, `!`, `&&`, `||` or `??`, a comparison, or a `switch`, or has its `typeof` taken.
- **Reads from before the run.** A run never sees its own unapplied writes, so the Write Plan shows possible duplicates instead of hiding them. Deduplicating within one run is the Workflow's job.
- **Safe resumption.** Apply stops at the first failed write. `pinfold resume <run>` continues the same Write Plan and skips the writes the Apply Journal records as sent. A write that failed while being sent may still have reached its server. It is held in doubt and never sent again until the developer checks the server and settles it with `pinfold resolve`. Separate Workflow Runs are never deduplicated against each other.
- **Business logic untouched by Repair.** A Repair changes only a declarative Response Adapter. Its mapped responses must fit the Baseline wherever the Workflows read them, and Repair cannot change the Workflows or their Contracts.

### 6.2 What it does not guarantee

- **Every unattended write seen by the developer.** Approval is per version of a Workflow's code. Once approved, the code sends later Write Plans unattended, with other inputs and targets, as long as they stay within the Write Budget and no Response Adapter changed.
- **Branches on Placeholders the type check cannot see.** A JavaScript Proxy cannot observe truthiness, `===` or `typeof` at run time, so the check is static ([#29](https://github.com/cmlcz/pinfold/issues/29)). A Placeholder that loses its type, through a cast to `any` or a call such as `Boolean(ticket.id)`, can still decide a branch unseen.
- **Semantic drift without structural drift.** If `count` keeps its name and type but starts counting something else, no field is missing or mistyped, and nothing stops the run.
- **Changed Read Tool arguments.** A planned write that no longer fits the arguments its Write Tool lists now stops the run before Approval, with nothing sent. A Read Tool is called live during the Plan, so a change in what it accepts shows only as a failed call.
- **Drift beyond a single-response mapping.** A response that is now paged, or data that needs an extra Tool call, cannot be mapped by a Response Adapter. pinfold reports that it needs a manual edit and a Baseline Migration.
- **Data leaving through Read Tool arguments.** The sandbox has no network, filesystem or environment access, but data can still leave through the arguments of a Read Tool call, such as a search query.
- **Approval when the client answers for the developer.** A client hook or setting that answers elicitations without showing them approves every plan unread. The README warns against it.
- **A misclassified Write Tool.** A Write Tool that the developer marks as a Read Tool runs live during the Plan.

---

## 7. Risks and mitigations

| #   | Risk                                                                                                                                                                                                                  | Effect                                                                                          | Mitigation now                                                                                                                                                                                                                                                                                                                              | Open step                                                                                                                                                                                                                                               |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | The agent bypasses Approval through its shell. It can run `pinfold approve`, `classify read`, `resolve … not-sent` or `baseline optional`, or edit `.pinfold/`, `.workflows/baselines/` or `pinfold.json`.            | Writes the developer never saw. All three target clients give the agent a shell in the project. | `approve`, `resolve`, `classify read` and `baseline optional` ask for confirmation and run only in an interactive terminal, which an agent's shell tool lacks. The README gives client deny rules for these commands and for `.pinfold/`, `.workflows/baselines/` and `pinfold.json`.                                                       | The agent still runs as the developer: a faked terminal, an `sh -c` wrapper or a script that writes the files gets past both. Signed approval records, or approval state outside the project, would close that; until then, Claude Code's sandbox does. |
| R2  | Per-code Approval lets approved code send unseen plans (§6.2).                                                                                                                                                        | Up to the Write Budget of unseen writes per run, for example after a new `--project` input.     | The Write Budget caps each run; any code edit or Adapter change asks again.                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                       |
| R3  | A plan over fast-changing reads never rebuilds the same after Approval.                                                                                                                                               | A Workflow keeps asking for Approval. There is no lock between the rebuild and the send.        | The clock and seed are reused; the run shows the old and new plans.                                                                                                                                                                                                                                                                         | Accept for v1, and measure with the benchmark.                                                                                                                                                                                                          |
| R4  | Repair sends response data out: the Repair Model's prompt goes to OpenRouter, and `propose_repair` goes into the agent's context and model.                                                                           | Production data at a third party.                                                               | Redaction rules apply to the Fixtures and the Repair prompts. Without rules, nothing is redacted.                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                       |
| R5  | Repair evidence is thin. Fixtures come from one run, are git-ignored, may be redacted on the drifted field, and stay at the old paths after a migration. The `default` op supplies values the server no longer sends. | A wrong mapping that the developer approves. Approving per Workflow invites rubber-stamping.    | Deterministic Repair proposes only a candidate that stands out, and counts value agreement only where the Fixtures hold at least three values of the field; with fewer, only a candidate whose name matches outright passes. A Repair Model `default` that contradicts a Fixture value is refused. The Approval view names every `default`. | —                                                                                                                                                                                                                                                       |
| R6  | The Apply Journal uses `node:sqlite`, which is experimental on Node 22.                                                                                                                                               | An API change could break resumption.                                                           | The module loads lazily, and CI runs on Node 22 and 24.                                                                                                                                                                                                                                                                                     | Pin the minimum Node version that keeps it stable.                                                                                                                                                                                                      |
| R7  | The benchmark (#19–#22) is a large build for one part-time developer (§12).                                                                                                                                           | v1 slips, or the benchmark ships thin.                                                          | The benchmark is built in three stages (§10.2): H2 first with no LLM, then H1 and H5 on A2 against A4, then the other Arms and clients.                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                       |
| R8  | The other limits in §6.2: misclassification, semantic drift, and data leaving through Read Tool arguments.                                                                                                            | Unintended writes or leaked data.                                                               | Every Tool is a Write Tool until the developer classifies it ([ADR 0004](docs/adr/0004-tools-are-write-tools-by-default.md)).                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                       |

---

## 8. Alternatives considered

| Decision                         | Chosen                                                                              | Rejected, and why                                                                                                                                                                                                                                    | Source                                                                      |
| :------------------------------- | :---------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| How Drift is repaired            | Per-Tool Response Adapters against a pinned Baseline                                | An LLM editing the Workflow code: it can change business logic, and the only check is the edited code. Per-Workflow Contracts with no shared Baseline: two Workflows could expect different shapes of one Tool, so one Adapter could not serve both. | [ADR 0001](docs/adr/0001-repair-drift-with-response-adapters.md)            |
| How writes are held              | Plan then Apply with Placeholders                                                   | An in-memory outbox: it cannot pass a buffered write's result to later steps, and it is not a reviewable artifact.                                                                                                                                   | [ADR 0002](docs/adr/0002-plan-apply-instead-of-outbox.md)                   |
| The Gateway                      | A thin Gateway of its own                                                           | Reusing a code-mode implementation: none exposes the sandbox-to-server boundary that Plan needs.                                                                                                                                                     | [ADR 0003](docs/adr/0003-build-a-thin-gateway.md)                           |
| Default classification           | Every Tool is a Write Tool                                                          | Trusting `readOnlyHint`: MCP calls annotations untrusted hints.                                                                                                                                                                                      | [ADR 0004](docs/adr/0004-tools-are-write-tools-by-default.md)               |
| Sandbox                          | QuickJS compiled to WebAssembly                                                     | A Deno subprocess, which needs a binary and relies on flags for isolation; `isolated-vm`, a native addon in maintenance mode; `node:vm`, not a security boundary.                                                                                    | [ADR 0005](docs/adr/0005-quickjs-wasm-sandbox.md)                           |
| Benchmark access                 | OpenRouter API keys                                                                 | Consumer subscriptions: vendor terms forbid automated use.                                                                                                                                                                                           | [ADR 0006](docs/adr/0006-benchmark-through-openrouter-not-subscriptions.md) |
| What Drift is checked against    | Each run's own reads, after its Plan                                                | The saved Contract alone: it misses fields read on other branches or after an edit.                                                                                                                                                                  | [ADR 0007](docs/adr/0007-check-drift-against-each-runs-own-reads.md)        |
| Baseline Migration source        | Live responses                                                                      | The server's listed schema: it can lag behind what the server sends.                                                                                                                                                                                 | [ADR 0008](docs/adr/0008-baseline-migration-from-live-responses.md)         |
| Approval outside the terminal    | MCP elicitation, trusting the client                                                | An `approve_plan` tool with a code shown in the terminal: the agent would hold the code once the developer types it into the chat.                                                                                                                   | [ADR 0009](docs/adr/0009-approval-through-mcp-elicitation.md)               |
| H2 scenario set                  | A grid generated from the fields the tasks read                                     | A hand-picked list: whoever picks the scenarios can pick ones Repair handles.                                                                                                                                                                        | [ADR 0010](docs/adr/0010-generate-the-h2-scenario-grid.md)                  |
| Pinning the CLI drivers          | A local proxy that adds the provider pin and reads each call's cost                 | Each CLI's own cost figure: Claude Code prices every model at Anthropic's rates, and Codex reports none.                                                                                                                                             | [ADR 0011](docs/adr/0011-pin-the-cli-drivers-through-a-local-proxy.md)      |
| What Approval covers             | A version of the Workflow's code, plus every changed Adapter, plus the Write Budget | Every plan: each cron run would need a human, which defeats unattended runs. Code plus input: not built yet (R2).                                                                                                                                    | This document                                                               |
| Where approval state lives       | `.pinfold/` in the project, git-ignored                                             | A service, or the repository: pinfold is local-first, and plans hold live data. The cost is R1, and state a CI setup must keep (§4.3).                                                                                                               | This document                                                               |
| A write that fails while sending | Held in doubt until the developer settles it                                        | Retrying with an idempotency key: MCP has no standard key, and Downstream Tools differ.                                                                                                                                                              | This document                                                               |
| What a plan ID covers            | The writes and the digests of the Adapters the plan was built through               | Including the Workflow's code: code approval is tracked separately, by a hash of the source, so an Exploration Run and a Workflow Run can share a plan.                                                                                              | This document                                                               |

---

## 9. Client compatibility

| Capability                                  | Claude Code                 | Codex CLI                                                                              | Antigravity CLI                   |
| :------------------------------------------ | :-------------------------- | :------------------------------------------------------------------------------------- | :-------------------------------- |
| Connect to pinfold as an MCP server (stdio) | Yes                         | Yes                                                                                    | Yes                               |
| Approval Dialog through MCP elicitation     | Yes                         | Interactive mode only (`exec` cancels the dialog, and the plan waits for the terminal) | Undocumented                      |
| Terminal Approval through `pinfold approve` | Yes                         | Yes                                                                                    | Yes                               |
| Exposed Workflows visible as tools          | After a Gateway restart     | After a Gateway restart                                                                | Undocumented (use `run_workflow`) |
| Repair through the developer's agent        | Yes                         | Yes                                                                                    | Yes                               |
| Planned benchmark coverage                  | Measured through OpenRouter | Measured through OpenRouter                                                            | Compatibility check only          |

_Sources: each CLI's official documentation, verified 2026-10-18. Exposed Workflows are registered when the Gateway starts, and the Gateway sends no tool-list updates, so no client sees a newly exposed Workflow until it restarts pinfold._

---

## 10. Measurement

### 10.1 Local stats (`pinfold stats`)

`pinfold stats` reports only quantities pinfold observes itself:

- Exploration Runs and Workflow Runs, with their wall time;
- Downstream Server Tool calls, and the bytes of Tool responses kept in the sandbox and out of the agent's context;
- Repairs, by who made them; and
- the tokens and cost pinfold spent through the Repair Model.

It never estimates tokens saved, because pinfold cannot observe the host agent's token use.

### 10.2 Benchmark (`pinfold bench`)

_Partly built._ The work is split across four issues:

- [#19](https://github.com/cmlcz/pinfold/issues/19): the GitHub-shaped server and the six tasks (built);
- [#20](https://github.com/cmlcz/pinfold/issues/20): the harness and the minimal agent loop, for all four Arms (built: `pinfold bench`);
- [#21](https://github.com/cmlcz/pinfold/issues/21): the Claude Code and Codex CLI drivers (built: `--driver claude-code|codex`, [ADR 0011](docs/adr/0011-pin-the-cli-drivers-through-a-local-proxy.md));
- [#22](https://github.com/cmlcz/pinfold/issues/22): the lifecycle experiment.

It is built in three stages, each ending with results that stand on their own:

1. **H2, no LLM.** The GitHub-shaped server, the six tasks and their checkers (#19), and the Drift Scenario suite run against deterministic Repair alone. Done: deterministic Repair alone repaired 46 of 53 runs of mappable scenarios (86.8%), with no wrong Repair ([results](docs/results/h2-2026-10-27.md)). On the changelog set, ported from github/github-mcp-server's trims of its responses, it first repaired 3 of 10 fields an Adapter could map back, missing every object that became one of its fields ([results](docs/results/h2-changelog-2026-10-28.md)). After #50 it proposes a wrap there, a rename back into an object a field was lifted out of, and a wrap of each element of an array. That makes three more fields mappable. It also checks values against every Fixture call when those with the drifted run's arguments hold too few, as when the run stopped at its first call. It then repaired all 13, with no wrong Repair, and the grid rose to 47 of 53 (88.7%) ([changelog](docs/results/h2-changelog-2026-10-31.md), [grid](docs/results/h2-2026-10-31.md)).
2. **H1 and H5 on A2 and A4.** The harness with the minimal OpenRouter agent loop (#20), run on A2 against A4, and the lifecycle experiment for those two Arms (#22). H1 measured: A4 ran 85 to 500 times faster than A2 at the median, with no tokens ([results](docs/results/bench-2026-10-27/README.md)).
3. **The other Arms and clients.** A1, A3, and the Claude Code and Codex CLI drivers (#21), added only once stages 1 and 2 have results. Measured: A4 succeeded on all 162 runs across the three drivers, against 76% to 100% for the agent Arms, and over the 100-run lifecycle A4 reached its Break-even Point against A2 at run 2 ([results](docs/results/bench-2026-10-28/README.md)).

The benchmark compares four **Arms** on identical tasks:

| Arm                | Description                                                                                                                  |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **A1 Plain MCP**   | The agent has every Downstream Server tool loaded and calls them one at a time.                                              |
| **A2 Code mode**   | The agent writes and runs a fresh program through `run_sandbox` for every task.                                              |
| **A3 Saved skill** | The agent reuses its earlier program, as told by one line in `CLAUDE.md` or `AGENTS.md`, with an LLM still driving each run. |
| **A4 pinfold**     | A pinfold Workflow Run, with no LLM.                                                                                         |

- **Tasks.** Six tasks run against the Drift Kit, one per category: read-heavy (`error-digest`), multi-server join (`issue-owners`), write-heavy (`file-issues`), large paginated responses (`commit-counts`), in-run deduplication (`triage-once`), and mixed (`triage-assign`). Each task is run with three different inputs. A checker judges each run from the servers' final state and received writes, and from the returned value for a task that only reads; the tasks and checkers are in `src/packages/bench/`.
- **Drivers.** Claude Code and Codex CLI routed through OpenRouter, plus a minimal OpenRouter agent loop for other models. Every run pins the exact model and provider, with fallbacks disabled; the CLIs go through a local proxy that adds the pin and reads each call's cost from OpenRouter's answer ([ADR 0011](docs/adr/0011-pin-the-cli-drivers-through-a-local-proxy.md)). Every run logs the CLI version, the model ID, the time and the raw JSON events. Each agent Arm offers the same MCP servers to every driver: A1 the Drift Kit servers themselves, A2 and A3 pinfold's Gateway behind a proxy that approves each Write Plan as a developer would; A3 also gets the saved program and one line in `CLAUDE.md` or `AGENTS.md`. Subscription logins are used only for single compatibility runs ([ADR 0006](docs/adr/0006-benchmark-through-openrouter-not-subscriptions.md)).
- **Metrics per Arm and task:**
  - token counts (input, cached, cache-write, output, reasoning), normalized across CLI log formats;
  - API cost in USD from OpenRouter's `cost` field;
  - wall time, p50 and p95;
  - LLM round-trips;
  - task success, checked mechanically against Drift Kit state;
  - pass^k: the share of tasks for which all k repeated runs succeed;
  - unintended writes;
  - the **Break-even Point** of A4 against A2 and A3.
- **Lifecycle experiment.** 100 sequential runs per Arm, with three Drift Scenarios injected along the way. For each Arm it reports cumulative tokens and cost, failed runs, and Approval pauses per run, and it tests H5. Human time per pause is not measured automatically.
- **Budget.** A pilot of 1 task × 4 Arms × 3 runs sets the cost per run before the full suite runs under a hard budget cap, starting at $50 and adjusted after the pilot.
- **Publication standards:**
  - every benchmark artifact is committed to the repository: tasks, state checkers, Drift Kit servers, pricing tables, raw logs and analysis scripts;
  - results carry their provenance: "measured on `<date>` with `<versions>`";
  - unfavorable results are reported with favorable ones;
  - savings for subscription users are stated in tokens, not dollars.

### 10.3 Hypotheses for v1

| ID     | Hypothesis                                                                                                                                                                                                                                  | Evaluation method                                                                                                                                                                                  |
| :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** | A4's p50 wall time per task is at most one tenth of A2's and A3's on the same tasks. Approval pauses are excluded and reported separately.                                                                                                  | Benchmark across all six tasks                                                                                                                                                                     |
| **H2** | Deterministic Repair alone repairs at least 80% of the mappable Drift Scenarios. The scenario set and its mappable subset are fixed and committed before the run. Scenarios taken from real MCP server changelogs are reported separately.  | The committed scenario grid ([ADR 0010](docs/adr/0010-generate-the-h2-scenario-grid.md)), run by `node src/packages/bench/h2.ts run`; Repairs by the Repair Model or agent are reported separately |
| **H3** | No write reaches a Downstream Server outside a Write Plan that was approved or met the conditions for running unattended. The agent bypassing Approval through its shell (R1) is outside this test.                                         | Property-based tests over the Drift Kit: `core/tests/no-unreviewed-writes.test.ts`                                                                                                                 |
| **H4** | On a fresh GitHub Actions runner, a clone with `npm ci` and `npm link` runs a saved Workflow through the `pinfold` command to completion with exit code 0, given its `.workflows/` and, for a Workflow with writes, a restored `.pinfold/`. | The `smoke` job in `.github/workflows/ci.yml`, on `examples/smoke/`, which also runs the packed tarball through `npx`                                                                              |
| **H5** | Over the lifecycle experiment of 100 runs with three Drift Scenarios, A4 reaches its Break-even Point against A2 and A3, counting its Exploration Run, every Repair and every Approval pause.                                               | Lifecycle experiment ([#22](https://github.com/cmlcz/pinfold/issues/22)); Approval pauses per run are reported with it                                                                             |

These thresholds are initial targets. If an experiment falls short, the measured number is reported; the hypothesis is not adjusted after the fact.

---

## 11. Decided elsewhere, and still open

**Decided, documented in the README or the code:**

- the closed set of Response Adapter ops and its syntax;
- how deterministic Repair scores candidates;
- the redaction rule format (`redact` in `pinfold.json`);
- classification storage (`classification` in `pinfold.json`);
- on-disk files in `.workflows/` and `.pinfold/`;
- the Write Plan format and plan IDs;
- the `search_sdk` ranking (BM25 over Tool names and descriptions).

Nothing architectural is open. The open steps in §7 wait for evidence from the benchmark or from use; the reviewers' other suggestions (per-input Approval, per-target allow-lists, value-shift alarms) are not planned.

---

## 12. Constraints

- **Team and timeline:** one developer, about three months part-time.
- **Deployment model:** local-first, for a single developer.
- **Zero-key core:** no external API key is required for any core feature.

The initial concept document is preserved in [docs/archive/](docs/archive/).
