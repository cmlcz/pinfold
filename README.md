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
- **Baseline migration.** When you want a tool's new shape, for example to read a field its server added, `baseline migrate` shows how the live shape differs from the baseline and which workflows it breaks, then re-pins it.
- **Approval in your agent's client.** Where the client supports MCP elicitation, a run that waits for approval asks you in a dialog that shows the plan, instead of sending you to the terminal.
- **Workflows as their own tools.** A workflow you opt in appears to your agent as its own MCP tool.
- **Stats.** `stats` shows what pinfold measured: runs, tool calls, the bytes of tool responses kept in the sandbox, repairs, and the repair model's tokens.
- **Unattended repair through a model.** If you name an OpenRouter model, pinfold asks it for a mapping when it finds none itself, so a cron or CI run can repair drift with no agent. The mapping is checked and approved like any other.

## Requirements

- Node.js 22.18 or newer
- npm

## Install

```sh
git clone https://github.com/cmlcz/pinfold.git
cd pinfold
npm ci     # also builds dist/
npm link   # optional: puts pinfold and pinfold-gateway on your PATH
```

With `npm link`, `pinfold <command>` stands for `node src/packages/cli/bin.ts <command>` below, and `pinfold-gateway` for `node src/packages/gateway/bin.ts`. pinfold is not on npm yet. The package builds to JavaScript in `dist/`, since Node does not run TypeScript from `node_modules`, and CI runs it through `npx` from the packed tarball (`npm pack`) on a fresh runner. `examples/smoke/` holds a small project with a saved workflow, which CI runs that way and from a fresh clone.

## A short demo: drift, repair, approve

`examples/smoke/` runs a saved workflow against the Drift Kit's Sentry-shaped server. The workflow counts a project's unresolved issues:

```console
$ cd examples/smoke
$ pinfold run count_unresolved --project web
2
```

Now the server renames `status` to `issueStatus`. Add `"--drift", "rename:listIssues:issues[].status"` to the server's `args` in `pinfold.json` and run again. pinfold sees that the response no longer fits the fields the workflow reads, finds the rename itself, with no model, and holds the result back:

```console
$ pinfold run count_unresolved --project web
Paused for Approval: the Response Adapter of sentry.listIssues changed since the last finished run of Workflow count_unresolved.

pinfold repaired the Response Adapter of sentry.listIssues, now version 1:
  + {"op":"rename","from":"issues[].issueStatus","to":"issues[].status"}
Value evidence, the live responses through this version next to the Fixtures:
  issues[].status: now "unresolved" ×2, "resolved" ×1; in the Fixtures "unresolved" ×2, "resolved" ×1

The result is held back until the developer approves the changed Response Adapters it was built through, in a terminal:
  pinfold approve 98b322c37834
Then run Workflow count_unresolved again with the same input to apply it.
```

It exits with 3, so cron or CI can tell a pause from a failure. You approve in your own terminal, and the workflow works again without an edit:

```console
$ pinfold approve 98b322c37834
...
Approve Write Plan 98b322c37834? Type yes to confirm: yes
$ pinfold run count_unresolved --project web
2
```

Remove the `--drift` argument and delete `.workflows/adapters/` to start over.

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

The agent gets six tools, plus one for each workflow you opt in (see [Save a workflow](#save-a-workflow)):

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

When a run includes writes, nothing is sent until you approve its plan. If your client supports MCP elicitation forms, the run asks you in a dialog that shows the plan and the repair behind each response adapter it was built through. Approve, and pinfold runs the same code again and sends the writes if it rebuilds the same plan; if it builds a different one, it asks again. Decline, and no run sends that plan. Close the dialog, and the plan waits for you in the terminal. A dialog left open for more than an hour ends the call with an error, and the plan waits in the terminal too.

> [!WARNING]
> The dialog is the safeguard. A client hook or setting that answers elicitations for you, without showing them, approves every plan unread. Do not auto-answer pinfold's elicitations.

Otherwise, `run_sandbox` returns the plan and reports that nothing was sent. Review the plan in your terminal:

```sh
node src/packages/cli/bin.ts plans              # list pending plans
node src/packages/cli/bin.ts approve <plan-id>  # approve the plan
node src/packages/cli/bin.ts decline <plan-id>  # do not send this plan; a later run asks again
node src/packages/cli/bin.ts resume <run-id>    # finish a plan that stopped partway
node src/packages/cli/bin.ts resolve <run-id> <write> sent|not-sent  # settle a write in doubt
```

`approve`, `resolve` and `classify read` show what they change and ask you to type `yes`. They run only in an interactive terminal, so an agent cannot run them through its shell tool, which has none.

### Keep your agent away from approval

Your agent's shell runs as you. A determined agent could fake a terminal, or edit the files where pinfold keeps approvals. Deny it the commands and files that approve writes. In Claude Code, add to `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(node src/packages/cli/bin.ts approve *)",
      "Bash(node src/packages/cli/bin.ts resolve *)",
      "Bash(node src/packages/cli/bin.ts classify read *)",
      "Edit(/.pinfold/**)",
      "Edit(/pinfold.json)"
    ]
  }
}
```

These rules catch the commands as an agent usually writes them, chained ones included, and shell redirects into those files. They do not catch a command wrapped in `sh -c`, or a script that writes the files itself. For a hard boundary, run the agent in Claude Code's sandbox. Codex CLI has its own rules files for forbidden commands.

A write whose real result no longer has a field a later write needs, because the write tool's response drifted, stops the Apply with the earlier writes sent. No resume can finish that run; a response adapter for the write tool lets later runs read its results as planned.

A write that fails while it is being sent may still have reached its server: a server can make the change and then answer with an error. pinfold never sends such a write again by itself. The run stops with that write in doubt, and `resume` refuses to go on. Check the server, then tell pinfold what you found with `resolve`. A write you resolve as `not-sent` is sent by the next `resume`; one resolved as `sent` never is, and the writes after it follow.

After you approve a plan in the terminal, the agent runs the same code again; after the dialog, pinfold does that itself. pinfold rebuilds the plan and sends the writes only if the plan has not changed. If it has changed, nothing is sent, and you need to approve the new plan. Inside a run, `Date` stands still and `Math.random` is seeded. The run after Approval gets the same time and seed, so a write that uses them rebuilds as you approved it.

## Save a workflow

Each successful `run_sandbox` result names its run. When you are happy with the result, tell the agent to save it, for example "save that as `triage_sentry`". The agent calls `save_workflow` with the run, the name, and your confirmation. pinfold saves the run only if all of these hold:

- the code exports `main(input)` with a typed `input`;
- the run finished without error;
- the code, with the workflow's settings added, type-checks against the SDK; and
- you confirmed the result.

If a check fails, nothing is written, and the result names the failed check. A run can be saved only from the gateway session that ran it.

A saved workflow is made of these files:

- **`.workflows/<name>.ts`** holds the code and `export const settings = { writeBudget: 10 }`. You own this file and may edit it. Add `expose: true` to settings to give the agent the workflow as its own tool, named after it and taking `main`'s input as its arguments, from the next gateway start. Add `description: "..."` to say what the tool does. A workflow whose input is not an object, or that fails its checks, is left out, and the gateway says why on stderr.
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

Each tool's response shape is pinned in its baseline the first time a call shows its full shape, which is usually the first call. For a tool that declares no output schema, pinfold infers the shape from that response, waiting while an array in it is still empty, so it cannot know yet which fields are optional. Within an array, a field that some elements leave out or hold as null, while others have it, is not drift. A field missing from a single response is: if the server leaves it out at times, mark it optional in the baseline:

```sh
node src/packages/cli/bin.ts baseline optional sentry.getIssue assignee
```

A field marked optional may be missing or null, and workflows that read it must handle that to type-check. When a server later answers differently, say it renames `count` to `eventCount`, a run that reads `count` stops before it sends anything. Each run is checked against the fields it read itself, so an edit to the workflow, or an input that takes another branch, is checked as it runs. The run reports the tool, the fields that drifted and every workflow the drift affects. A run that does not read the drifted fields goes on as before.

pinfold then tries to repair the drift itself, with no model. It looks for a mapping from the live responses back to the baseline, such as a renamed field, a response now wrapped in another object, an object that became one of its fields (`milestone` now holds only the title), a field moved up out of its object, a number sent as text, or renamed enum values. It scores each candidate by how alike the field names are and by how well its values agree with those in the saved fixtures. Values count only where the fixtures hold at least three of them; with fewer, only a candidate whose field name matches outright, such as a wrapped response, can pass. A response that moves under another object after the tool's adapter already maps some of its fields gets the unwrap and, after it, those mappings again, since they no longer find their fields where the adapter's earlier ops look. When one candidate stands out and the mapped responses fit every workflow that uses the tool, pinfold writes it as a new version of the tool's response adapter and runs the workflow again. That run pauses for approval and shows the adapter diff, the value evidence and the write plan:

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
- **`wrap`** puts the value at `at` under `field`, and **`unwrap`** replaces the value at `at` with its `field`. Without `at`, they act on the whole response; an `at` that ends in `[]`, such as `labels[]`, acts on each element.
- **`convert`** turns the value at `path` into a `number` or a `string`, or an ISO date into `epoch-ms` and back with `iso-date`.
- **`map`** replaces enum values at `path` by the `values` they map to.
- **`default`** gives a missing field at `path` the `value`.

Whoever proposes a `default`, the approval view says the server sends no value there and names the value given. A new or changed adapter makes the next run of every workflow that uses the tool pause for approval. That includes a workflow that sends no writes: its result is held back until you approve. A write tool can change too: when its server lists other arguments than its baseline and a planned write no longer fits them, the run stops before approval, with nothing sent, and says which argument no longer fits. `baseline migrate` shows the change. Some drift, such as a response that is now paged, cannot be mapped back by an adapter: pinfold reports that it needs a manual fix. Edit the workflow to read the new shape, and migrate the tool's baseline to it.

## Migrate a baseline

A field a server adds stays out of the baseline, so no workflow can read it until you migrate the tool's baseline on purpose:

```sh
node src/packages/cli/bin.ts baseline migrate sentry.listIssues
```

pinfold calls the tool again with the arguments of its calls in the saved fixtures, and infers the shape the server gives it now. Where the server still lists an output schema that every response fits, it keeps that schema. A field whose values all still fit its old schema, an enum for one, keeps that schema too. Arguments that redaction kept out of the fixtures are not sent, and a write tool is never called: only the output schema its server lists can say its shape.

The command shows each field whose shape changes, and checks every workflow that calls the tool against the new baseline: its code must type-check, and every field it reads must be there. Nothing changes until you run it again with `--yes`:

```text
Baseline of sentry.listIssues, against the shape its server gives it now:
  - response.issues[].count: number
  + response.issues[].eventCount: number
Workflow short_ids: checks against the new Baseline.
Workflow triage_sentry: does not check against the new Baseline:
  TS2339: Property 'count' does not exist on type '{ id: string; shortId: string; project: string; title: string; culprit: string; filename: string; lineNumber: number; level: "fatal" | "error" | "warning" | "info"; firstSeen: string; lastSeen: string; eventCount: number; userCount: number; status: "unresolved" | ... 1 more ... | "ignored"; }'.
    at program.ts:9:46
  it reads issues[].count, which the new Baseline does not have
Nothing changed yet. `pinfold baseline migrate sentry.listIssues --yes` re-pins the Baseline.
```

With `--yes`, pinfold re-pins the baseline and resets the tool's response adapter as a new version with no ops, since the baseline is now the live shape. Like any changed adapter, that makes the next run of every workflow that uses the tool pause for approval, with the baseline's changes in the approval view. Pending drift of the tool is dropped, as it was drift from the old baseline. Edit each workflow that no longer checks before you run it again.

## See what pinfold did

```sh
node src/packages/cli/bin.ts stats         # read it
node src/packages/cli/bin.ts stats --json  # for scripts
```

`stats` reports only what pinfold measured itself:

- exploration runs and workflow runs with their wall time, per workflow and in total;
- the tool calls they made, and the bytes of the tool responses, which stay in the sandbox: the agent reads only what a run returns;
- repairs, by who made them;
- the tokens and cost pinfold spent through the repair model.

It never estimates tokens saved. Runs from before pinfold measured them are counted apart, not as zero. Repairs are counted from the repair log, which began with this version.

## Benchmark

Measured on the Drift Kit with `deepseek/deepseek-v4.1-flash-1017`, pinned to one OpenRouter endpoint, through a minimal agent loop, Claude Code and Codex CLI. These are results on one model and six synthetic tasks, not a general claim:

- A saved workflow ran each task in about 0.1 s with no tokens, 85 to 500 times faster than an agent writing a fresh program ([stage 2](docs/results/bench-2026-10-27/README.md)).
- It succeeded on all 162 of its runs, against 76% to 100% for agents calling the tools directly, writing fresh code, or reusing a saved program ([stage 3](docs/results/bench-2026-10-28/README.md)).
- Over 100 runs with three drifts, it paid back its first agent run by run 2 and kept working through every drift, pausing once for approval each time. An agent writing fresh code each run succeeded on 42 of them, and one reusing a saved program on 29, failing on most runs after the first drift.
- Deterministic repair alone fixed 46 of 53 mappable drift cases from a generated grid (86.8%), with no wrong repair ([H2](docs/results/h2-2026-10-27.md)). On real changes from GitHub's MCP server it fixed 3 of 10 that a mapping could fix, again with none wrong; the rest stop with nothing sent and wait for your agent or the repair model ([changelog set](docs/results/h2-changelog-2026-10-28.md)).

## What pinfold guarantees, and what it does not

These hold as long as only you, not your agent, run `pinfold approve`, `classify` and `resolve`, and edit `.pinfold/` and the classification in `pinfold.json` (see [Keep your agent away from approval](#keep-your-agent-away-from-approval)).

- **No write outside an approved or unattended plan.** A write reaches a server only as part of a write plan you approved, or one that met the conditions for running unattended. After approval, a write is sent only if the rebuilt plan is the one you approved.
- **No placeholder used as data.** A write's result is known only after you approve it, so the type check refuses code that branches on it, compares it or takes its `typeof`.
- **Safe resumption.** A write that may have reached its server is never sent again until you check and say it did not.
- **Business logic untouched by repair.** A repair changes only a response adapter, and its mapped responses must fit every workflow that reads the tool.

It does not guarantee:

- **That you see every unattended write.** Approval is per version of a workflow's code. Once approved, that code sends later plans unattended, with other inputs, as long as they stay within its write budget and no adapter changed.
- **Branches the type check cannot see.** A placeholder cast to `any`, or passed through a call such as `Boolean(x)`, can still decide a branch unseen.
- **Semantic drift.** If `count` keeps its name and type but starts counting something else, nothing stops the run.
- **Drift a single response cannot map.** A response that is now paged needs a manual edit and a baseline migration.
- **That no data leaves.** The sandbox has no network, filesystem or environment, but data can leave through the arguments of a read tool, such as a search query.
- **A client that answers for you.** A client setting that answers approval dialogs without showing them approves every plan unread.
- **A misclassified tool.** A write tool you mark as read runs live.

## Where pinfold keeps its state

- **`.pinfold/`** holds the write plans, a journal of the writes already sent, the run history, a history of exploration runs, the repairs pinfold made and a log of them, the drift it could not repair and the repair model's usage. It is git-ignored.
- **`.workflows/baselines/`** holds the recorded response shape of each tool.
- **`.workflows/adapters/`** holds the response adapters.
- **`.workflows/`** also holds the saved workflows. **`.workflows/fixtures/`** is git-ignored.

Your approvals live in `.pinfold/runs.jsonl` and `.pinfold/plans/`. A workflow runs unattended only where they are: on a CI runner that starts each job afresh, keep `.pinfold/` between jobs, for example as a cache, or every run with writes pauses for approval. Keep `.workflows/fixtures/` there too: without the recorded values, deterministic repair has nothing to compare candidates with and proposes less.

## License

MIT, see [LICENSE](LICENSE).
