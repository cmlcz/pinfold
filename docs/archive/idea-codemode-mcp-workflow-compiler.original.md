# Code-Mode MCP Gateway & Self-Healing Workflow Runtime

## Overview

This project is an execution gateway and workflow compiler for the **Model Context Protocol (MCP)**. It sits between an AI agent client (such as Claude Code, Cursor, or OpenCode) and any number of downstream MCP servers (GitHub, Sentry, Linear, Postgres, Slack, local tools).

Instead of exposing dozens of raw MCP tools directly to the LLM and forcing the model to call them one by one in a slow chat loop, the gateway converts all connected MCP servers into a **typed TypeScript SDK inside an isolated sandbox**.

This design solves two problems in sequence:
1. **On the first run (Exploration):** The agent solves a multi-step task by writing and executing a short TypeScript program against the generated SDK inside the sandbox. This replaces 10–30 back-and-forth tool calls with a single execution, keeping large intermediate JSON payloads out of the LLM's context window.
2. **On repeat runs (Compiled Workflows):** Once a sandbox run succeeds and passes validation checks, the gateway compiles that script into a **reusable, parameterized workflow** with runtime schema assertions. Future runs execute as normal code in under a second at **zero token cost**, and only invoke a small LLM if an upstream API changes and a broken step needs to be repaired.

---

## 1. The Problem

Connecting AI agents to real-world tools through MCP currently breaks down in two ways:

### 1.1 The First-Run Problem: Context Bloat and "Tool Ping-Pong"
- **Schema Bloat:** Connecting 5 or 6 MCP servers to an agent adds 80+ tool definitions (often 20,000–40,000 tokens) to the prompt before the user even asks a question.
- **Sequential Round-Trips:** Standard tool calling forces the LLM to act as the CPU for basic control flow. If a task requires fetching 30 items from one tool, filtering them, and calling a second tool for 5 matching items, the agent must make dozens of slow LLM round-trips. Every intermediate JSON response is appended to the conversation history, wasting tokens and degrading accuracy.

### 1.2 The Repeat-Run Problem: Paying an LLM to Repeat Solved Work
- **No Memory of Execution Logic:** Once an agent figures out how to perform a routine operational task—such as triaging daily CI failures, syncing release blockers, or auditing database records—asking it to do the same task tomorrow forces the LLM to re-plan from scratch.
- **Unnecessary Cost, Latency, and Flakiness:** Re-running an LLM loop for a solved workflow takes 30–60 seconds, costs money on every execution, and fails unpredictably (~10–15% of the time) when the model hallucinates a parameter or misses a step.
- **Why Manual Scripts Aren't Enough:** Developers could write static scripts by hand, but manual glue code across multiple APIs takes hours to write and crashes the moment an upstream API renames a field or introduces a new edge case.

---

## 2. How the System Works (End-to-End Example)

Suppose a developer connects three MCP servers—**Sentry**, **GitHub**, and **Linear**—to the gateway, and connects the gateway to Claude Code.

### Step 1: Automatic SDK Generation
When the gateway starts, it queries `tools/list` on each connected MCP server and compiles their JSON Schemas into a typed TypeScript SDK (`sdk.sentry.*`, `sdk.github.*`, `sdk.linear.*`) along with runtime schema validators.

To the AI agent, the gateway exposes only four core tools:
- `search_sdk(query)` — Search available MCP capabilities and return their exact TypeScript function signatures.
- `run_sandbox(code, inputs?)` — Execute a TypeScript program against the SDK inside an isolated sandbox.
- `save_workflow(name, description)` — Compile a verified sandbox program into a permanent, reusable workflow.
- `run_workflow(name, inputs)` — Execute a saved workflow (saved workflows are also registered as individual MCP tools).

### Step 2: Solving a Task on the First Run (Code Mode)
The user asks the agent:
> *"Find unresolved Sentry issues from the last 24 hours with at least 50 events, check `git blame` on the crashing file to find who last modified that line, and create a Linear issue assigned to them if one doesn't already exist."*

1. The agent calls `search_sdk("sentry issues github blame linear create")` and receives the compact TypeScript signatures (~300 tokens).
2. Instead of making 15 separate tool calls, the agent calls `run_sandbox` once with a short TypeScript program:

```typescript
export async function main(input: { project: string; minEvents: number }) {
  const issues = await sdk.sentry.listIssues({
    project: input.project,
    statsPeriod: "24h",
  });

  const frequent = issues.filter(
    (item) => item.count >= input.minEvents && item.status === "unresolved"
  );

  const createdTickets: string[] = [];

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

    createdTickets.push(ticket.id);
  }

  return {
    checkedCount: frequent.length,
    createdTickets,
  };
}
```

3. **Execution:** The sandbox runs the code, performs all MCP calls locally, keeps the large Sentry JSON payloads inside the sandbox, and returns only `{ checkedCount: 3, createdTickets: ["LIN-104"] }` to the agent.

### Step 3: Compiling into a Verified Workflow
Once the user confirms the result, they tell the agent:
> *"Save that as a workflow named `triage_sentry`."*

The gateway's workflow compiler performs four deterministic steps:
1. **Static & AST Validation:** Parses the TypeScript AST, extracts the input parameter schema (`{ project: string, minEvents: number }`) and return type, and verifies that no restricted APIs are used.
2. **Runtime Contract Generation:** Infers strict output schemas (using Zod/JSON Schema) from the actual MCP tool responses recorded during the run, attaching step-level assertions to each `sdk.*` call.
3. **Test Fixture Capture:** Saves sanitized request/response pairs from the run into `.workflows/fixtures/triage_sentry.json` so the workflow can be tested offline without hitting live production APIs.
4. **Tool & CLI Registration:** Writes `.workflows/triage_sentry.ts` and exposes `triage_sentry` both as a **zero-token MCP tool** for the agent and as a standalone CLI command (`mcpflow run triage_sentry --project web --minEvents 50`) for cron jobs or CI pipelines.

### Step 4: Zero-Token Execution and Safe Self-Healing
- **Routine Runs:** Every subsequent call to `triage_sentry` executes the compiled TypeScript directly in the sandbox. It makes **0 LLM calls**, uses **0 tokens**, and completes in under a second.
- **Self-Healing on API Drift:** Suppose two months later, the Sentry MCP server updates its response format and renames `issue.count` to `issue.eventCount`.
  1. When `triage_sentry` runs, the runtime assertion on Step 1 (`sdk.sentry.listIssues`) catches the schema mismatch and throws a `SchemaDriftError` **before** any mutating calls (`sdk.linear.createIssue`) execute.
  2. The runtime triggers the **Scoped Repair Engine**, passing a small, inexpensive model (`gpt-4.1-mini` or `claude-haiku`) only the 25-line workflow file and the exact schema diff (`expected property 'count', received 'eventCount'`).
  3. The model updates `item.count` to `item.eventCount`.
  4. **Dry-Run & Approval Gate:** Because a passing type check does not guarantee correct business logic, repaired workflows that touch `write` tools do not silently execute in production. The runtime runs the patched script in **Dry-Run Mode** (executing real `read` calls while capturing `write` calls in a preview), checks that output guardrails pass (such as max-write limits and replay against saved fixtures), and outputs a **Code Diff + Planned Write Preview** for the user to approve.

---

## 3. System Architecture

```text
+-------------------------------------------------------------------------+
|                 AI Agent Client (Claude Code / Cursor / CLI)            |
+------------------------------------+------------------------------------+
                                     | MCP Protocol (stdio / Streamable HTTP)
                                     v
+-------------------------------------------------------------------------+
|               Code-Mode MCP Gateway & Workflow Runtime                  |
|                                                                         |
|  +---------------------------+     +---------------------------------+  |
|  | 1. Schema-to-SDK Compiler |     | 2. Isolated Code Sandbox        |  |
|  | - Introspects MCP servers |     | - Executes TS (Deno/Bun/Isolate)|  |
|  | - Generates .d.ts & Zod   |     | - Enforces timeouts & call caps |  |
|  | - Indexes tools for search|     | - Intercepts & logs sdk.* calls |  |
|  +---------------------------+     +---------------------------------+  |
|                                                                         |
|  +---------------------------+     +---------------------------------+  |
|  | 3. Workflow Compiler      |     | 4. Safety & Self-Heal Engine    |  |
|  | - Extracts input schemas  |     | - Stages writes in outbox       |  |
|  | - Injects step assertions |     | - Deduplicates retries (SQLite) |  |
|  | - Saves replay fixtures   |     | - Dry-runs & diffs LLM repairs  |  |
|  +---------------------------+     +---------------------------------+  |
+------------------------------------+------------------------------------+
                                     | MCP Protocol (JSON-RPC)
                                     v
+-------------------------------------------------------------------------+
|       Downstream MCP Servers (GitHub, Sentry, Linear, Postgres, ...)    |
+-------------------------------------------------------------------------+
```

### Core Technical Components

1. **Schema-to-SDK Compiler:**
   Connects to downstream MCP servers, normalizes their JSON Schemas, resolves naming collisions across namespaces, and generates TypeScript type definitions (`.d.ts`) plus runtime validators. Includes a lightweight keyword/BM25 index so `search_sdk` returns only the relevant tool signatures for a task.
2. **Isolated Sandbox Runtime:**
   Executes TypeScript programs in a restricted runtime with no direct access to the host filesystem, environment variables, or raw network. The script can only interact with the outside world through the injected `sdk.*` bridge, which enforces per-run timeouts, rate limits, and maximum tool-call budgets.
3. **Structured LLM Helpers for Hybrid Workflows:**
   Some workflows are 95% deterministic logic (`for` loops, filtering, API calls) but need a tiny judgment step (e.g., classifying a log snippet). The SDK provides an optional, strictly typed `sdk.ai.extract<T>(data, schema)` helper so workflows stay deterministic in their control flow while supporting bounded, schema-validated model calls when needed.

---

## 4. Safety Guarantees: Handling Writes, Retries, and Self-Healing

Two common failure modes break naive workflow tools in production: **partial failures causing duplicate writes**, and **bad LLM repairs silently corrupting business logic**. The runtime prevents both with four simple mechanisms:

### 4.1 Protecting Against Partial Failures and Duplicate Writes
1. **Staged Writes (Outbox Mode) by Default:**
   Tools are tagged as `read` or `write` (via MCP annotations and gateway config). While a workflow runs, `read` calls execute immediately, while `write` calls (such as `linear.createIssue` or `slack.postMessage`) are held in an in-memory **Commit Outbox**. If a workflow crashes on iteration 3 of a 5-item loop, **zero external writes have been sent**. Writes are flushed only after the script finishes and passes all checks.
2. **SQLite Run Log for Safe Retries (Idempotency):**
   When the outbox flushes `write` calls (or when a workflow must execute a `write` inline to use its returned ID), the gateway logs each completed call in a local SQLite table using a hash of `(workflow_id, run_id, tool_name, args)`. If a network error interrupts a run halfway through and the user retries it, the gateway checks SQLite, skips the `write` calls that already succeeded, and returns their saved responses so duplicates are never created.

### 4.2 Ensuring Self-Healing Doesn't Break Business Logic
Fixing a broken field name so the code compiles does not prove the fix is semantically right (for example, mapping `issue.count` to `issue.warningCount` instead of `issue.errorCount`). To keep self-healing safe:
1. **Dry-Run Quarantine for Mutating Workflows:**
   When a workflow breaks due to an upstream API change, the LLM repair loop generates a candidate patch and runs it in **Dry-Run Mode** (`read` tools run live; `write` tools are intercepted and logged). If the workflow contains `write` tools, the gateway pauses and presents the **Code Diff + Planned Write Preview** (e.g., *"Would create 2 Linear tickets: ..."*) for user approval before applying changes.
2. **Fixture Replay & Write-Count Caps:**
   Before proposing a repair patch, the gateway tests the patched code against the recorded fixture from when the workflow was first saved (verifying it produces the same outputs on historical test data) and enforces a configurable `maxWritesPerRun` circuit breaker so a faulty filter cannot spam an external API.

---

## 5. Comparison with Existing Approaches

| Approach / Project | What It Does | Limitation | How This Project Differs |
| :--- | :--- | :--- | :--- |
| **Standard MCP Clients** (Claude Code, Cursor native MCP) | Loads all tool schemas into context; calls tools one at a time via JSON-RPC. | High token overhead; slow multi-step loops; re-reasons from scratch on every run. | Compresses 80+ tools into 1 SDK; runs multi-step logic in one sandbox turn; compiles repeat tasks into zero-token code. |
| **Throwaway Code-Mode Proxies** (`mj-deving/code-mode-tools`, `akua-dev/codemode`) | Lets an agent run a one-off JS/TS script in a sandbox to chain tool calls. | Scripts are discarded after every turn; next time the user asks, the LLM writes the code from scratch again. | Compiles successful sandbox scripts into permanent, parameterized workflows with recorded fixtures and self-healing. |
| **Browser Recorders** (`browser-use/workflow-use`) | Records browser clicks/inputs and replays them as flat JSON steps. | Browser DOM only; cannot express loops, conditionals, or multi-server MCP logic. | Works across any MCP server and compiles real TypeScript control flow (`for`, `if/else`, data joins). |
| **Hook-Based Shell Compilers** (`agent-jit/AgentJIT`) | Watches CLI logs and asks an LLM to generate bash scripts for repeated commands. | Generates untyped shell scripts without sandboxing, schema assertions, or step-level repair. | Uses typed TypeScript against an auto-generated SDK, validates step contracts, and repairs broken steps in a dry-run sandbox. |

---

## 6. Evaluation & Benchmarking Plan

To measure the system's effectiveness objectively, the project includes an automated evaluation harness testing three dimensions across 15–20 multi-tool workflows:

1. **First-Run Efficiency (Code Mode vs. Standard MCP Tool Calling):**
   - Measure total prompt + completion tokens, number of LLM round-trips, wall-clock latency, and task completion rate when solving multi-step tasks across 3+ MCP servers.
2. **Repeat-Run Performance (Compiled Workflow vs. Re-Running the Agent):**
   - Measure token cost ($0 vs. $0.05–$0.30/run), execution latency (<1s vs. 20–60s), and reliability ($\text{pass}^k$ consistency over 20 runs with varying inputs).
3. **Self-Healing Recovery Under Simulated API Drift:**
   - Introduce controlled breaking changes into mock MCP servers (renamed JSON fields, nested response wrappers, pagination changes, stricter input types) and measure how often the scoped repair loop successfully patches and verifies the workflow using a small model without human intervention.
