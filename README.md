# pinfold

pinfold is a local MCP server for coding agents. It sits between your agent and the MCP servers you use, such as Sentry, GitHub, or Linear. It runs the code your agent writes in an isolated sandbox, and it does not send any write to those servers until you approve it.

> **Early version (0.0.0).** Only the features below work today. Automatic repairs are planned but not available yet.

## What works today

- **Sandboxed runs.** The agent writes a short TypeScript program. pinfold runs it in a sandbox with no filesystem, network, or imports. The program reaches the outside only through your MCP servers, and it returns only its result.
- **Read tools run live.** Tools you mark as read run against the real server.
- **Writes wait for approval.** Tools that change something are recorded into a plan. Nothing is sent until you approve that exact plan.
- **Resume.** If an approved plan stops partway through, `resume` sends the writes that were not sent yet. A write that may have reached the server is never sent again.
- **Save workflows.** A successful run can be saved as a workflow: an ordinary TypeScript file in `.workflows/` that you own, with the response fields it reads and its recorded tool calls.
- **Run workflows.** A saved workflow runs again from the terminal, cron or CI with no LLM.
- **Drift detection and response adapters.** A run stops before any write when a tool's responses no longer fit the fields the workflow reads. A response adapter that you write maps the responses back, and every workflow that uses the tool works again without any edit.

## Requirements

- Node.js 22.18 or newer
- npm

## Install

```sh
git clone https://github.com/cmlcz/pinfold.git
cd pinfold
npm ci
```

## Configure

Create a `pinfold.json` file in your project:

```json
{
  "servers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "<sentry-mcp-server-package>"],
      "env": { "SENTRY_ACCESS_TOKEN": "${SENTRY_ACCESS_TOKEN}" }
    },
    "linear": {
      "url": "https://<linear-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    }
  },
  "classification": {
    "sentry": { "listIssues": "read" }
  },
  "limits": {
    "timeoutMs": 30000,
    "memoryBytes": 67108864,
    "toolCalls": 100
  }
}
```

- **`servers`** lists the MCP servers pinfold connects to. Each server's tools appear in the sandbox as `sdk.<server>.<tool>`. Server names must be valid JavaScript identifiers. A server is either a `command` that pinfold starts and talks to over stdio, or a Streamable HTTP `url`. A stdio server inherits only a few safe environment variables, such as `PATH` and `HOME`. Give it others in `env`, and a working directory relative to the project in `cwd`. An HTTP server's `headers` are sent with every request. In `env` and `headers`, write a secret as a reference to an environment variable, `${NAME}`, so it never sits in the file. pinfold refuses to start if a referenced variable is not set, and it keeps those values out of its errors.
- **`classification`** marks tools as `"read"`. Any tool you leave out is a write tool.
- **`redact`** is optional. It lists, by server and tool, the fields that are replaced with `[redacted]` before a saved workflow's recorded calls are written to disk. A path starts with `arguments` or `response`, and `[]` stands for every element of an array, as in `"response.issues[].assignee.email"`.
- **`limits`** is optional. The values above are the defaults: 30 seconds, 64 MiB of memory, and 100 tool calls per run.

## Connect your agent

Start pinfold as an MCP server over stdio. Add this command to your agent's MCP settings:

```sh
node src/packages/gateway/bin.ts --config pinfold.json
```

The agent gets five tools:

- **`search_sdk`** finds the TypeScript signatures of the tools that match a keyword query.
- **`run_sandbox`** runs a program that exports `main(input)` and calls tools with `await sdk.<server>.<tool>(args)`.
- **`save_workflow`** saves a successful run as a workflow, after you confirm its result.
- **`run_workflow`** runs a saved workflow with an input.
- **`list_workflows`** lists the saved workflows.

## Mark read tools

Every tool is a write tool until you mark it as read. You can do this in `pinfold.json` or with the CLI:

```sh
node src/packages/cli/bin.ts classify                           # show all tools and their classification
node src/packages/cli/bin.ts classify read sentry.listIssues    # mark a tool as read
node src/packages/cli/bin.ts classify write linear.createIssue  # mark a tool as write
```

The `classify` command reads the tool list from your servers, so they must be reachable.

## Approve writes

When a run includes writes, `run_sandbox` returns the plan and reports that nothing was sent. Review the plan in your terminal:

```sh
node src/packages/cli/bin.ts plans              # list pending plans
node src/packages/cli/bin.ts approve <plan-id>  # approve the plan
node src/packages/cli/bin.ts decline <plan-id>  # never send the plan
node src/packages/cli/bin.ts resume <run-id>    # finish a plan that stopped partway
```

After you approve a plan, the agent runs the same code again. pinfold rebuilds the plan and sends the writes only if the plan has not changed. If it has changed, nothing is sent, and you need to approve the new plan. Inside a run, `Date` stands still and `Math.random` is seeded. The run after Approval gets the same time and seed, so a write that uses them rebuilds as you approved it.

## Save a workflow

Each successful `run_sandbox` result names its run. When you are happy with the result, tell the agent to save it, for example "save that as `triage_sentry`". The agent calls `save_workflow` with the run, the name, and your confirmation. pinfold saves the run only if all of these hold:

- the code exports `main(input)` with a typed `input`;
- the run finished without error;
- the code, with the workflow's settings added, type-checks against the SDK; and
- you confirmed the result.

If a check fails, nothing is written, and the result names the failed check. A run can be saved only from the gateway session that ran it.

A saved workflow is made of these files:

- **`.workflows/<name>.ts`** holds the code and `export const settings = { writeBudget: 10 }`. You own this file and may edit it.
- **`.workflows/<name>.json`** holds the input schema, the tools the workflow calls, and its contract: the response fields the code read.
- **`.workflows/fixtures/<name>.json`** holds the run's input and its read tool calls with their responses, after redaction. It is git-ignored.

List the saved workflows with their inputs, tools, last run, and status:

```sh
node src/packages/cli/bin.ts list
```

## Run a workflow

A saved workflow runs from the terminal, cron or CI, or from the agent with `run_workflow`. No LLM is called. Pass the input as one flag per field. A value is read as JSON where that fits the field, so `50` is a number for a number field, and as text otherwise. A flag without a value is `true`, and a value that starts with `--` is written `--field=--value`. A workflow whose `main` takes a string, a number or an array takes one value instead of flags.

```sh
node src/packages/cli/bin.ts run triage_sentry --project web --minEvents 50
node src/packages/cli/bin.ts run search_issues "deadlock"
```

pinfold checks the workflow before each run, since you may have edited it. The code must still export a typed `main(input)`, type-check against the SDK, and set a whole-number `writeBudget`. Every tool it calls must still be offered, and every field in its contract must still be allowed by the tool's baseline. The input must fit `main`'s input type. If a check fails, the run is refused with the reason, and the command exits with 1.

Each run builds a plan. Its writes are sent without asking you, unless the workflow has never been applied or the plan has more writes than `writeBudget`. Then the run pauses: nothing is sent, the command prints the plan and its ID, and exits with 3. Approve the plan with `approve <plan-id>`, then run the workflow again with the same input to apply it.

Every run is recorded in `.pinfold/runs.jsonl`, and `list` shows each workflow's last run.

## Repair drift

Each tool's response shape is pinned in its baseline the first time the tool is called. When a server later answers differently, say it renames `count` to `eventCount`, a run of a workflow that reads `count` stops before it makes a plan. It reports the tool, the fields that drifted and every workflow the drift affects. A workflow that does not read the drifted fields runs as before.

Repair the drift with a response adapter in `.workflows/adapters/`, one file per tool. It maps the tool's live responses back to the baseline, so the workflow code never changes:

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

The ops run in order. A path such as `issues[].count` names the `count` of every element of `issues`.

- **`rename`** moves the field at `from` to `to`, within the same array elements.
- **`wrap`** puts the value at `at` under `field`, and **`unwrap`** replaces the value at `at` with its `field`. Without `at`, they act on the whole response.
- **`convert`** turns the value at `path` into a `number` or a `string`, or an ISO date into `epoch-ms` and back with `iso-date`.
- **`map`** replaces enum values at `path` by the `values` they map to.
- **`default`** gives a missing field at `path` the `value`.

A new or changed adapter makes the next run of every workflow that uses the tool pause for approval. Some drift, such as a response that is now paged, cannot be mapped back by an adapter and needs an edit to the workflow.

## Where pinfold keeps its state

- **`.pinfold/`** holds the write plans, a journal of the writes already sent, and the run history. It is git-ignored.
- **`.workflows/baselines/`** holds the recorded response shape of each tool.
- **`.workflows/adapters/`** holds the response adapters.
- **`.workflows/`** also holds the saved workflows. **`.workflows/fixtures/`** is git-ignored.

## License

MIT
