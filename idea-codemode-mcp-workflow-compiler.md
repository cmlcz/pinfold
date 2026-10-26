# pinfold: plan-first workflows that survive API drift

pinfold is a local MCP **Gateway** for coding agents (Claude Code, Codex CLI, Antigravity CLI). An agent solves a multi-tool task once by writing a short TypeScript program during an **Exploration Run**; pinfold saves that program as a **Workflow** the developer owns, and runs it again without an LLM. Two ideas distinguish pinfold from existing tools:

1. **Every Workflow Run is a Plan followed by an Apply.** **Read Tools** run live, calls to **Write Tools** are recorded into a **Write Plan**, and only that exact plan is ever sent.
2. **Drift is repaired at the boundary, not in your code.** Each **Tool** is pinned to a **Baseline** response shape. When a **Downstream Server** changes its responses, pinfold updates the Tool's **Response Adapter**—a small declarative mapping back to the Baseline—so every Workflow that uses the Tool keeps working. No LLM ever edits a Workflow file.

In one line: _your agent writes the workflow once; pinfold keeps it running as APIs change, and never sends a write you have not seen in a plan._

Capitalized terms introduced in **bold** are defined in [GLOSSARY.md](GLOSSARY.md). Architectural decisions and their rationale live in [docs/adr/](docs/adr/).

---

## 1. The problem

- **Repeating solved work.** An agent that triaged yesterday's CI failures must plan the same task from scratch today. Every repeat consumes tokens (or subscription quota), takes the time of a full agent loop, and can fail in new ways.
- **Saved code goes stale.** The obvious remedy—saving the agent's code and reusing it—has already been proposed by Anthropic and implemented by several tools (§2). In practice, saved code breaks as soon as a Downstream Server renames a field or wraps a response. Tools that repair such breaks by letting an LLM edit the code risk altering business logic just to make checks pass: a 2026 study of autonomous test repair found agents converging through "assertion weakening and test-case deletion" (arXiv 2605.01471).
- **Writes are the dangerous part.** A reused program that crashes halfway through, retries, or runs after a faulty repair can create duplicate tickets or post wrong messages. Existing tools mostly avoid this by disabling writes when re-running saved work.

How large these costs are in practice is what the benchmark (§8) measures; this document makes no numeric claim it does not test.

---

## 2. Prior art and what is new

Checked against primary sources on 2026-10-18. Items marked † come from a background literature scan and were not read in full.

| Work                                                   | What it does                                                                                                    | Relation to pinfold                                                                            |
| :----------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| Cloudflare Code Mode (2025-09-26)                      | Exposes MCP tools as a TypeScript API inside a throwaway isolate                                                | Same first step; nothing is saved across runs                                                  |
| Anthropic, _Code execution with MCP_ (2025-11-04)      | Proposes code mode where agents "persist their own code as reusable functions" (skills)                         | Suggests saving code, without execution guarantees, drift handling, or write control           |
| Anthropic programmatic tool calling (2025-11-24)       | Lets the model write code that calls tools inside a sandbox                                                     | Code mode inside the API; nothing is persisted                                                 |
| `datalayer/agent-codemode`                             | Implements code mode with `save_skill` and `run_skill`                                                          | Persists scripts, without validation, write control, or drift handling                         |
| Reelier (`seldonframe/reelier`)                        | Records MCP tool-call traces into skills with assertions; read-only by default; `diff` reports `SAME`/`DRIFTED` | Closest match: detects drift, but has no plans, no adapters, and undocumented repair mechanics |
| ASI, _Inducing Programmatic Skills_ (arXiv 2504.06821) | Induces programmatic skills for web agents and re-induces them when sites change                                | Repairs by regenerating code, without fixtures or a human gate                                 |
| TraceCompiler (arXiv 2608.02680)†                      | Compiles agent traces into mostly deterministic workflows; refuses underdetermined irreversible effects         | Similar stance to our Placeholder rules                                                        |
| Atomix (arXiv 2602.14849)†                             | Buffers agent effects until commit and gates irreversible ones                                                  | Stages effects, but is not MCP-specific and produces no reviewable plan                        |
| UiPath Healing Agent                                   | Repairs broken RPA UI selectors, optionally in recommend-only mode                                              | Human-gated repair, scoped to UI selectors                                                     |
| Ink & Switch, Cambria                                  | Translates between document schema versions using bidirectional lenses                                          | Direct inspiration for Response Adapters                                                       |

**Already established:** code mode, saving successful scripts, trace-to-workflow compilation with assertions, drift detection, and buffering writes.

**What pinfold adds:**

- A reviewable **Write Plan** built with opaque **Placeholders** and applied exactly as reviewed.
- **Repair** via a per-Tool **Response Adapter** against a pinned **Baseline**: verified against each Workflow's frozen **Contract**, shared across every Workflow that uses the Tool, and backed by value evidence for ambiguous renames.
- A **Drift Kit** and benchmark suite that measure whether saved Workflows survive **Drift** and what they actually save. Our literature scan found no existing benchmark for this.

---

## 3. How it works: an end-to-end example

Suppose a developer connects Claude Code to pinfold with three Downstream Servers configured: Sentry, GitHub, and Linear.

### 3.1 Exploration Run

The developer asks: _"Find unresolved Sentry issues from the last 24 hours with at least 50 events, find who last changed the crashing line, and create a Linear issue assigned to them unless one exists."_

The agent calls `search_sdk` to inspect the relevant TypeScript signatures, then calls `run_sandbox` once:

```typescript
export async function main(input: { project: string; minEvents: number }) {
  const issues = await sdk.sentry.listIssues({
    project: input.project,
    statsPeriod: "24h",
  });
  const frequent = issues.filter(
    (i) => i.count >= input.minEvents && i.status === "unresolved"
  );

  const created = [];
  for (const issue of frequent) {
    const existing = await sdk.linear.searchIssues({ query: issue.culprit });
    if (existing.length > 0) continue;

    const blame = await sdk.github.getBlame({
      file: issue.filename,
      line: issue.lineNumber,
    });
    const ticket = await sdk.linear.createIssue({
      title: `[Sentry] ${issue.title}`,
      assigneeEmail: blame.authorEmail,
    });
    created.push(ticket.id); // a Placeholder during a Plan; allowed because it is only returned
  }
  return { checked: frequent.length, created };
}
```

The code runs inside the sandbox, under the same Plan rules as any Workflow Run: the `createIssue` calls are recorded into a Write Plan and need Approval before Apply, so even freshly written code cannot send a write unseen. Large Sentry responses stay in the sandbox, and only the return value (with Placeholders replaced by real results after Apply) is sent back to the agent. Along the way, pinfold records the **Fixtures** (requests and responses) and tracks which response fields the code actually read.

### 3.2 Saving the Workflow

The developer says _"save that as `triage_sentry`"_. `save_workflow` succeeds only if every check passes:

- the code exports a typed `main(input)` function;
- the Exploration Run, which itself ran as a Plan, finished without error and respected the Placeholder rules;
- the code type-checks against the generated SDK; and
- the developer has confirmed the Exploration Run's result.

Each Tool's **Baseline** was already pinned during the Exploration Run, from the first response that showed its full shape. When those checks pass, pinfold writes:

- `.workflows/triage_sentry.ts`, an ordinary TypeScript file the developer owns and may edit;
- the Workflow's **Contract**—the subset of Baseline fields the code actually reads (such as `count`, `status`, `culprit`, `filename`, `lineNumber`, and `title` on `sentry.listIssues`); and
- the Fixtures under `.workflows/fixtures/`, redacted by configurable rules and git-ignored by default.

### 3.3 Routine Workflow Runs

A saved Workflow can be run from cron or CI (`pinfold run triage_sentry --project web --minEvents 50`; until pinfold is published, `pinfold` stands for `node src/packages/cli/bin.ts`) or triggered by the agent (`run_workflow`). Each **Workflow Run** has three steps:

1. **Plan.** Read Tools execute live against Downstream Servers; each Write Tool call is recorded and returns an opaque **Placeholder**. The output is a **Write Plan**:
   ```
   Plan 7f3c · triage_sentry · 2 writes (budget 10)
     1. linear.createIssue  title="[Sentry] TypeError in checkout.ts"  assignee=ana@…
     2. linear.createIssue  title="[Sentry] Timeout in sync-worker"     assignee=li@…
   ```
2. **Approval (only when required).** A run pauses for **Approval** if the developer has never approved writes of the Workflow's code as it is now (so any edit to the file asks again), if a Response Adapter it depends on is new or updated, or if the Write Plan exceeds the Workflow's **Write Budget**. Otherwise, the run proceeds unattended. Approval happens in the terminal with `pinfold approve`, or in an **Approval Dialog** of the agent's client where it supports MCP elicitation ([ADR 0009](docs/adr/0009-approval-through-mcp-elicitation.md)).
3. **Apply.** pinfold re-runs the reads and rebuilds the Write Plan. It sends the writes only if the rebuilt plan matches the approved one, recording each completed call in the **Apply Journal**.

No LLM is invoked at any point during a normal Workflow Run.

### 3.4 Drift and Repair

Two months later, Sentry's MCP server renames `count` to `eventCount`.

1. **Drift detection.** Once the Plan is done, the run's reads are checked against the Baseline: the adapted response from `sentry.listIssues` no longer has `count`, which this run read. The run stops before Apply, so no write is sent ([ADR 0007](docs/adr/0007-check-drift-against-each-runs-own-reads.md)).
2. **Deterministic search.** pinfold compares the live response against the saved Fixtures. Because `eventCount` has values matching the historical distribution of `count`—and no other field does—pinfold proposes a new Response Adapter version:
   ```json
   {
     "tool": "sentry.listIssues",
     "version": 2,
     "ops": [{ "op": "rename", "from": "[].eventCount", "to": "[].count" }]
   }
   ```
   _(Illustrative format; exact syntax is left to the spec.)_
3. **Fallback to agent or model.** If deterministic search finds no unambiguous match, pinfold records the Drift as pending and the Workflow's runs stop. `list_workflows` and the stopped run point the developer's coding agent to `propose_repair`, which shows the pending Drift and takes the agent's proposed ops. Alternatively, if a **Repair Model** is named (`repairModel` or `PINFOLD_REPAIR_MODEL`) and `OPENROUTER_API_KEY` is set, pinfold asks that model first, unattended.
4. **Review and Approval.** A new or updated Response Adapter triggers Approval on the next run of every Workflow that uses that Tool. The approval view displays the Adapter diff, value evidence (e.g., "`eventCount`: median 112, range 50–3,400; historical `count`: median 108, range 51–2,900"), and the resulting Write Plan.
5. **Fix once, share everywhere.** `triage_sentry.ts` is never modified, and every other Workflow that calls `sentry.listIssues` inherits the repaired Adapter automatically.

---

## 4. Architecture

```text
 Agent client (Claude Code / Codex CLI / Antigravity CLI)        pinfold CLI (cron, CI, approve, resume, stats; bench planned)
                 │ MCP (stdio)                                                   │
                 ▼                                                               ▼
 ┌──────────────────────────────────── pinfold ───────────────────────────────────────┐
 │  Gateway: fixed tool set: search_sdk, run_sandbox, save_workflow, list_workflows,  │
 │           run_workflow, propose_repair (per-Workflow tools opt-in)                 │
 │                                                                                    │
 │  SDK generator ── Tool classification (Read/Write) ── search index                 │
 │  Sandbox (QuickJS/Wasm) ◄── sdk.* bridge ── Plan engine (Placeholders, field use)  │
 │  Baselines · Contracts · Response Adapters ── Repair (deterministic → agent / LLM) │
 │  Approval (CLI; elicitation where supported) ── Apply + Apply Journal (SQLite)     │
 │  Model client (OpenRouter, optional)                                               │
 └────────────────────────────────────────────────────────────────────────────────────┘
                 │ MCP (stdio / Streamable HTTP with static headers)
                 ▼
 Downstream Servers (Sentry, GitHub, Linear, …)
```

| Component               | Responsibility                                                                                                   | Key decisions                                                                                                                        |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| Gateway                 | Exposes a single MCP server to the agent with a small, fixed tool set registered at startup                      | [ADR 0003](docs/adr/0003-build-a-thin-gateway.md); per-Workflow tools are opt-in because Codex CLI ignores dynamic tool-list updates |
| SDK generator           | Compiles Downstream Server tool schemas into TypeScript definitions via pinned Baselines                         | Generated types reflect the pinned Baseline, not the unadapted live schema                                                           |
| Tool classification     | Treats every Tool as a Write Tool until the developer marks it as a Read Tool                                    | [ADR 0004](docs/adr/0004-tools-are-write-tools-by-default.md); MCP annotations only pre-fill a suggestion                            |
| Sandbox                 | Executes transpiled TypeScript in QuickJS/Wasm with memory, time, and call limits; no host access except `sdk.*` | [ADR 0005](docs/adr/0005-quickjs-wasm-sandbox.md); runtime sits behind an interface                                                  |
| Plan engine             | Records writes, issues opaque Placeholders, tracks field reads, and isolates reads from uncommitted writes       | [ADR 0002](docs/adr/0002-plan-apply-instead-of-outbox.md)                                                                            |
| Contracts and Adapters  | Pins Baselines, derives per-Workflow Contracts, validates adapted responses, and versions Response Adapters      | [ADR 0001](docs/adr/0001-repair-drift-with-response-adapters.md)                                                                     |
| Repair                  | Runs deterministic candidate search first, then falls back to the developer's agent or an optional model         | Restricted to a closed set of declarative Adapter operations                                                                         |
| Approval                | Presents the Write Plan, Adapter diff, and value evidence; never exposed as an MCP tool the agent can call       | CLI everywhere; MCP elicitation where supported (Claude Code)                                                                        |
| Apply and Apply Journal | Re-plans before sending writes, halts at the first failed write, and supports `pinfold resume`                   | Resumed runs skip calls already recorded in the Apply Journal                                                                        |
| Model client            | Optional OpenRouter (OpenAI-compatible) client for unattended Repair and, once built, benchmarking               | Disabled unless a Repair Model is named and `OPENROUTER_API_KEY` is set                                                              |

**On-disk layout and distribution.** Workflows, Baselines, Contracts, and Response Adapters live in `.workflows/` and are meant to be committed to version control. Redacted Fixtures live in `.workflows/fixtures/` (git-ignored by default). Run history and the SQLite Apply Journal live in `.pinfold/` (git-ignored). pinfold is to be distributed on npm for Node 22.18 or newer under the MIT license; it is not published yet, and runs from a clone.

---

## 5. Guarantees and their limits

**What pinfold guarantees**

- **No unreviewed writes.** A write reaches a Downstream Server only if it belongs to a Write Plan that was either approved or eligible to run unattended, and the rebuilt Write Plan at Apply time is identical.
- **Faithful plans.** Placeholders may only be passed to Write Tools or returned from `main`. Using a Placeholder's value—formatting it, calling it, or passing it to a Read Tool—fails the Plan, and any Workflow that does so cannot be saved. One gap remains: no proxy can observe truthiness, `===`, or `typeof`, so a Plan that branches on a Placeholder silently takes one branch ([#29](https://github.com/cmlcz/pinfold/issues/29)); the `run_sandbox` instructions warn against it.
- **Pre-run read consistency.** A run never sees its own uncommitted writes, so the Write Plan surfaces potential duplicates instead of hiding them; deduplicating within a single run is the Workflow's responsibility.
- **Safe resumption of interrupted Applies.** Apply stops at the first failed write. Running `pinfold resume <run>` continues the same Write Plan while skipping calls already recorded in the Apply Journal. A write that failed while being sent may still have reached its server, so it is held in doubt and never sent again until the developer checks the server and settles it with `pinfold resolve <run> <write> sent|not-sent`. Separate Workflow Runs are never deduplicated against each other.
- **Business logic untouched by Repair.** Repairs can only update declarative Response Adapters, which must map live responses to satisfy a frozen Contract that the Repair process cannot edit.

**What it does not guarantee**

- **Semantic drift without structural drift.** If `count` keeps its name and type but starts counting something else, no Contract is violated. Value evidence helps only when a structural change triggers a Repair.
- **Drift beyond a single-response mapping.** Pagination changes, or data that now requires an extra Tool call to fetch, cannot be expressed as a Response Adapter. pinfold flags these as requiring a manual edit or **Baseline Migration**.
- **Data exfiltration via Read Tool arguments.** Although the sandbox has no network, filesystem, or environment access and all writes appear in the Write Plan, sensitive data can still leave through arguments passed to a Read Tool (such as a search query).
- **Client-side auto-approval hooks.** If a developer configures their agent client to auto-accept MCP elicitations, that safeguard is bypassed. The documentation explicitly warns against this.
- **Misclassified Write Tools.** If a developer mistakenly classifies a Write Tool as a Read Tool, it will execute live during Plan.

---

## 6. Client compatibility

| Capability                                    | Claude Code             | Codex CLI                              | Antigravity CLI                   |
| :-------------------------------------------- | :---------------------- | :------------------------------------- | :-------------------------------- |
| Connect to pinfold as an MCP server (`stdio`) | Yes                     | Yes                                    | Yes                               |
| In-client Approval via MCP elicitation dialog | Yes                     | Interactive mode only (`exec` cancels) | Undocumented                      |
| CLI Approval via `pinfold approve`            | Yes                     | Yes                                    | Yes                               |
| Exposed Workflows visible as tools            | After a Gateway restart | After a Gateway restart                | Undocumented (use `run_workflow`) |
| Assisted Repair through the developer's agent | Yes                     | Yes                                    | Yes                               |
| Included in benchmark measurements            | Yes, via OpenRouter     | Yes, via OpenRouter                    | Compatibility check only          |

_Sources: each CLI's official documentation, verified 2026-10-18. Exposed Workflows are registered when the Gateway starts, and the Gateway sends no tool-list updates, so no client sees a newly exposed Workflow until it restarts pinfold. Automated CI checks will continuously verify the rows that can be tested programmatically._

---

## 7. Scope

**In v1:**

- MCP Gateway with the fixed tool set (`search_sdk`, `run_sandbox`, `save_workflow`, `list_workflows`, `run_workflow`, `propose_repair`), supporting `stdio` and Streamable HTTP Downstream Servers with static headers.
- Per-Tool Read/Write classification, TypeScript SDK generation from Baselines, and SDK signature search.
- Isolated QuickJS/Wasm sandbox with resource and call limits.
- Exploration Runs and `save_workflow` validation gates.
- Plan and Apply execution engine with Placeholders, Approval, the SQLite Apply Journal, and `pinfold resume`.
- Baselines, Contracts, and declarative Response Adapters; deterministic Repair and agent-assisted Repair.
- Developer-initiated Baseline Migration (`pinfold baseline migrate`, [ADR 0008](docs/adr/0008-baseline-migration-from-live-responses.md)) and marking a Baseline field optional (`pinfold baseline optional`).
- Optional OpenRouter model client for unattended Repair.
- Redacted, git-ignored Fixtures.
- Local observability (`pinfold stats`), the **Drift Kit** (test Downstream Servers and **Drift Scenarios**), and the benchmark runner (`pinfold bench`).

**Out of v1:**

- Downstream Servers requiring OAuth flows.
- `sdk.ai.extract` or any LLM call inside a Workflow.
- Team, hosted, or multi-tenant deployments.
- Response Adapters that execute arbitrary code.
- Automated **Baseline Migration**, run without the developer.
- Full benchmark runs on Antigravity CLI.

---

## 8. Measurement

### 8.1 Local stats (`pinfold stats`)

`pinfold stats` reports only quantities pinfold observes directly:

- Exploration Runs, Workflow Runs, and wall-clock duration;
- Downstream Server Tool calls;
- bytes of Tool responses kept inside the sandbox and out of the agent's context window; and
- Repairs performed, along with any tokens pinfold itself spent via the optional model client.

It never estimates "tokens saved", because pinfold cannot observe the host agent's internal token consumption.

### 8.2 Benchmark (`pinfold bench`)

_Not built yet: the six tasks, the harness and the lifecycle experiment are issues #19–#21. The Drift Kit has Sentry- and Linear-shaped servers so far._

The benchmark compares four **Arms** on identical tasks:

| Arm                | Description                                                                                                                           |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| **A1 Plain MCP**   | The agent has every Downstream Server tool loaded directly and calls them one at a time.                                              |
| **A2 Code mode**   | The agent writes and runs a fresh program through `run_sandbox` on every task.                                                        |
| **A3 Saved skill** | The agent reuses its earlier program as instructed by a single line in `CLAUDE.md` / `AGENTS.md`, with an LLM still driving each run. |
| **A4 pinfold**     | A deterministic pinfold Workflow Run with no LLM.                                                                                     |

- **Tasks.** Six tasks built against the Drift Kit, each tested across three input variants: read-heavy, multi-server join, write-heavy, large paginated responses, in-run deduplication, and mixed.
- **Drivers.** Claude Code and Codex CLI routed through OpenRouter, plus a minimal OpenRouter agent loop for evaluating smaller models. Every run pins the exact model and provider (with fallbacks disabled) and logs the CLI version, model ID, timestamp, and raw JSON event stream. Consumer subscription logins are used only for single-run compatibility checks at ordinary interactive scale ([ADR 0006](docs/adr/0006-benchmark-through-openrouter-not-subscriptions.md)).
- **Metrics (per Arm and task).**
  - Token counts (input, cached, cache-write, output, reasoning), normalized across CLI log formats;
  - Direct API cost in USD from OpenRouter's `cost` field;
  - Wall-clock latency (p50 and p95);
  - LLM round-trips;
  - Task success rate, verified mechanically against Drift Kit state;
  - $\text{pass}^k$ consistency across repeated runs;
  - Unintended writes; and
  - The **Break-even Point** of A4 compared against A2 and A3.
- **Lifecycle experiment.** 100 sequential runs per Arm with three Drift Scenarios injected along the timeline. For each Arm, we report cumulative tokens and cost, failed runs, and human minutes spent on Approval.
- **Budget.** A small pilot (1 task × 4 Arms × 3 runs) establishes per-run cost before running the full suite under a hard budget cap (starting at $50 and adjusted after the pilot).
- **Publication standards.**
  - All benchmark artefacts—tasks, state checkers, Drift Kit servers, pricing tables, raw logs, and analysis scripts—are committed to the repository.
  - Published results carry explicit provenance: _"measured on `<date>` with `<versions>`"_.
  - Unfavourable results are reported alongside favourable ones.
  - Savings relevant to subscription users are stated in tokens rather than dollars.

### 8.3 Hypotheses for v1

| ID     | Hypothesis                                                                                                 | Evaluation method                                          |
| :----- | :--------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| **H1** | A Workflow Run consumes zero LLM tokens and completes at least 10× faster than A2 and A3 on the same task. | Benchmark across all six tasks                             |
| **H2** | Deterministic search alone repairs at least 80% of mappable Drift Scenarios without an LLM.                | Drift Kit suite (LLM-assisted Repairs reported separately) |
| **H3** | No write ever reaches a Downstream Server outside an approved (or budget-exempt) Write Plan.               | Property-based tests over the Drift Kit                    |
| **H4** | `npx pinfold` runs cleanly on a fresh GitHub Actions runner with zero extra setup.                         | Automated CI workflow                                      |

These thresholds are initial targets. If an experiment falls short, we report the measured number rather than adjusting the hypothesis after the fact.

---

## 9. Architecture decision records

| ADR                                                                     | Decision                                                                                               |
| :---------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| [0001](docs/adr/0001-repair-drift-with-response-adapters.md)            | Repair Drift with per-Tool Response Adapters against a pinned Baseline, never by editing Workflow code |
| [0002](docs/adr/0002-plan-apply-instead-of-outbox.md)                   | Every Workflow Run is a Plan followed by an Apply, with opaque Placeholders and isolated pre-run reads |
| [0003](docs/adr/0003-build-a-thin-gateway.md)                           | Build a thin Gateway instead of reusing an existing code-mode implementation                           |
| [0004](docs/adr/0004-tools-are-write-tools-by-default.md)               | Treat every Tool as a Write Tool until the developer classifies it as a Read Tool                      |
| [0005](docs/adr/0005-quickjs-wasm-sandbox.md)                           | Run Workflow and Exploration Run code in QuickJS compiled to WebAssembly                               |
| [0006](docs/adr/0006-benchmark-through-openrouter-not-subscriptions.md) | Run benchmark measurements through OpenRouter; use subscriptions only for compatibility checks         |
| [0007](docs/adr/0007-check-drift-against-each-runs-own-reads.md)        | Check Drift against each Workflow Run's own reads, after its Plan, not against the saved Contract      |
| [0008](docs/adr/0008-baseline-migration-from-live-responses.md)         | Migrate a Baseline from live responses, and reset the Tool's Response Adapter                          |
| [0009](docs/adr/0009-approval-through-mcp-elicitation.md)               | Take Approval through MCP elicitation, and trust the client to show it                                 |

## 10. Left for the specification

The following implementation details are deferred to the technical specification rather than treated as open architectural questions:

- On-disk schemas for Baselines, Contracts, and Response Adapters;
- Exact syntax and semantics of the closed Response Adapter operation set;
- Matching heuristics and confidence thresholds for deterministic Repair;
- Configuration format for Fixture redaction rules;
- Terminal formatting and deterministic hashing for Write Plans and plan IDs;
- Storage format for per-Tool Read/Write classifications; and
- Indexing and ranking algorithm behind `search_sdk`.

## 11. Constraints

- **Team and timeline:** Solo developer, roughly three months part-time.
- **Deployment model:** Local-first, single developer.
- **Zero-key core:** No external API key is required for any core feature.
- **History:** The initial concept document is preserved in [docs/archive/](docs/archive/).
