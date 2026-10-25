# pinfold

pinfold is a local MCP server for coding agents. It sits between your agent and the MCP servers you use, such as Sentry, GitHub, or Linear. It runs the code your agent writes in an isolated sandbox, and it does not send any write to those servers until you approve it.

> **Early version (0.0.0).** Only the features below work today.

## What works today

- **Sandboxed runs.** The agent writes a short TypeScript program. pinfold runs it in a sandbox with no filesystem, network, or imports. The program reaches the outside only through your MCP servers, and it returns only its result.
- **Read tools run live.** Tools you mark as read run against the real server.
- **Writes wait for approval.** Tools that change something are recorded into a plan. Nothing is sent until you approve that exact plan, together with the response adapters it was built through.
- **Resume.** If an approved plan stops partway through, `resume` sends the writes that were not sent yet. A write that may have reached the server is never sent again until you check the server and say it did not.
- **Save workflows.** A successful run can be saved as a workflow: an ordinary TypeScript file in `.workflows/` that you own, with the response fields it reads and its recorded tool calls.
- **Run workflows.** A saved workflow runs again from the terminal, cron or CI with no LLM.
- **Drift detection and response adapters.** A run stops before any write when a tool's responses no longer fit the fields the workflow reads. A response adapter maps the responses back, and every workflow that uses the tool works again without any edit.
- **Deterministic repair.** pinfold searches for that adapter itself, with no model, and proposes it only when one mapping stands out. You approve it after seeing its diff, how its values compare with the recorded ones, and the write plan.
- **Repair through your agent.** When pinfold finds no mapping, your agent can propose one through `propose_repair`, with no API key. pinfold checks it the same way and you approve it the same way.
- **Unattended repair through a model.** If you name an OpenRouter model, pinfold asks it for a mapping when it finds none itself, so a cron or CI run can repair drift with no agent. The mapping is checked and approved like any other.

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
- **`repairModel`** is optional. It names an OpenRouter model, such as `"openai/gpt-4o-mini"`, that proposes a repair when pinfold finds none itself. The environment variable `PINFOLD_REPAIR_MODEL`, if set, picks the model instead. pinfold reads its key from `OPENROUTER_API_KEY`; copy `.env.example` to `.env`, fill it in, and run pinfold with `node --env-file=.env`. With no model named, or without the key, pinfold never calls a model; a run stopped by drift then says the model was not asked.

## Connect your agent

Start pinfold as an MCP server over stdio. Add this command to your agent's MCP settings:

```sh
node src/packages/gateway/bin.ts --config pinfold.json
```

The agent gets six tools:

- **`search_sdk`** finds the TypeScript signatures of the tools that match a keyword query.
- **`run_sandbox`** runs a program that exports `main(input)` and calls tools with `await sdk.<server>.<tool>(args)`.
- **`save_workflow`** saves a successful run as a workflow, after you confirm its result.
- **`run_workflow`** runs a saved workflow with an input.
- **`list_workflows`** lists the saved workflows.
- **`propose_repair`** shows drift that pinfold could not repair by itself and takes the agent's proposed response adapter. The adapter still waits for your approval.

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
node src/packages/cli/bin.ts decline <plan-id>  # do not send this plan; a later run asks again
node src/packages/cli/bin.ts resume <run-id>    # finish a plan that stopped partway
node src/packages/cli/bin.ts resolve <run-id> <write> sent|not-sent  # settle a write in doubt
```

A write whose real result no longer has a field a later write needs, because the write tool's response drifted, stops the Apply with the earlier writes sent. No resume can finish that run; a response adapter for the write tool lets later runs read its results as planned.

A write that fails while it is being sent may still have reached its server: a server can make the change and then answer with an error. pinfold never sends such a write again by itself. The run stops with that write in doubt, and `resume` refuses to go on. Check the server, then tell pinfold what you found with `resolve`. A write you resolve as `not-sent` is sent by the next `resume`; one resolved as `sent` never is, and the writes after it follow.

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

pinfold checks the workflow before each run, since you may have edited it. The code must still export a typed `main(input)`, type-check against the SDK, and set a whole-number `writeBudget`. Every tool it calls must still be offered, and the input must fit `main`'s input type. If a check fails, the run is refused with the reason, and the command exits with 1. A run that reads a field its tool's baseline does not allow stops before its plan, since no drift there could be told.

Each run builds a plan. Its writes are sent without asking you, unless you have never approved writes of the workflow's code as it is now, a response adapter it reads through changed, or the plan has more writes than `writeBudget`. Any edit to the workflow's file counts as new code, whoever made it, so the first plan with writes after an edit waits for you. Then the run pauses: nothing is sent, the command prints the plan and its ID, and exits with 3. Review the plan with `plans`, which also shows the repair behind each changed adapter, approve it with `approve <plan-id>`, then run the workflow again with the same input to apply it.

Every run is recorded in `.pinfold/runs.jsonl`, and `list` shows each workflow's last run.

## Repair drift

Each tool's response shape is pinned in its baseline the first time the tool is called. For a tool that declares no output schema, pinfold infers the shape from that response, so it cannot know yet which fields are optional. Within an array, a field that some elements leave out or hold as null, while others have it, is not drift. A field missing from a single response is: if the server leaves it out at times, mark it optional in the baseline:

```sh
node src/packages/cli/bin.ts baseline optional sentry.getIssue assignee
```

A field marked optional may be missing or null, and workflows that read it must handle that to type-check. When a server later answers differently, say it renames `count` to `eventCount`, a run that reads `count` stops before it sends anything. Each run is checked against the fields it read itself, so an edit to the workflow, or an input that takes another branch, is checked as it runs. The run reports the tool, the fields that drifted and every workflow the drift affects. A run that does not read the drifted fields goes on as before.

pinfold then tries to repair the drift itself, with no model. It looks for a mapping from the live responses back to the baseline, such as a renamed field, a response now wrapped in another object, a number sent as text, or renamed enum values. It scores each candidate by how alike the field names are and by how well its values agree with those in the saved fixtures. When one candidate stands out and the mapped responses fit every workflow that uses the tool, pinfold writes it as a new version of the tool's response adapter and runs the workflow again. That run pauses for approval and shows the adapter diff, the value evidence and the write plan:

```text
pinfold repaired the Response Adapter of sentry.listIssues, now version 1:
  + {"op":"rename","from":"issues[].eventCount","to":"issues[].count"}
Value evidence, the live responses through this version next to the Fixtures:
  issues[].count: now median 128, range 73–210; in the Fixtures median 128, range 73–210
```

Drift that no single mapping settles is recorded as pending. Your agent can repair it: `propose_repair` shows it the pending drift, with the fields that no longer fit, the baseline, a live response and the values in the fixtures, all redacted by your rules. When a tool has redaction rules, any value the drift moved away from where the baseline has it is redacted too, since the rules may no longer reach it. The agent then proposes the adapter operations to add. pinfold rejects any proposal whose mapped responses do not fit every workflow that uses the tool and gives the reason. A proposal that passes becomes the adapter's next version and waits for your approval like any other; the agent cannot approve it. You can also write an adapter of your own.

With `repairModel` set, pinfold first asks that model, unattended. The model sees what the agent would see through `propose_repair`, redacted the same way, and its proposal is checked the same way. One that passes becomes the adapter's next version, and the run pauses for your approval with the diff. pinfold also refuses a `default` from the model for a field the fixtures hold any other value of, since it would only make the data up. One that fails leaves the drift pending, and the run says why. pinfold does not ask the model again until the drift changes, so a stopped cron job does not pay on every run; a model that could not be reached is asked again on the next run. Each call's token counts and cost, as OpenRouter reports them, are added to `.pinfold/model-usage.jsonl`.

A response adapter lives in `.workflows/adapters/`, one file per tool. It maps the tool's live responses back to the baseline, so the workflow code never changes. A write tool's adapter maps the real results of its writes the same way, and later writes in the plan read them through it:

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

Whoever proposes a `default`, the approval view says the server sends no value there and names the value given. A new or changed adapter makes the next run of every workflow that uses the tool pause for approval. That includes a workflow that sends no writes: its result is held back until you approve. Some drift, such as a response that is now paged, cannot be mapped back by an adapter: pinfold reports that it needs a manual fix. Edit the workflow to read the new shape, and migrate the tool's baseline to it: delete the tool's file in `.workflows/baselines/`, and the next call pins the shape the server has now.

## Where pinfold keeps its state

- **`.pinfold/`** holds the write plans, a journal of the writes already sent, the run history, the repairs pinfold made, the drift it could not repair and the repair model's usage. It is git-ignored.
- **`.workflows/baselines/`** holds the recorded response shape of each tool.
- **`.workflows/adapters/`** holds the response adapters.
- **`.workflows/`** also holds the saved workflows. **`.workflows/fixtures/`** is git-ignored.

Your approvals live in `.pinfold/runs.jsonl` and `.pinfold/plans/`. A workflow runs unattended only where they are: on a CI runner that starts each job afresh, keep `.pinfold/` between jobs, for example as a cache, or every run with writes pauses for approval. Keep `.workflows/fixtures/` there too: without the recorded values, deterministic repair has nothing to compare candidates with and proposes less.

## License

MIT
