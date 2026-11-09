# pinfold

Save what your coding agent learns. Run it again without the agent.

pinfold is a local MCP server. It is between your coding agent and the tools the agent uses, for example Sentry, GitHub, or Linear. The agent writes a short TypeScript program to do a task. pinfold runs the program in a sandbox. pinfold does not send a write to a tool until you approve it. When the result is correct, you save the program as a **workflow**. A workflow is a TypeScript file in your project. You can read it, change it, and run it from the terminal, from cron, or from CI. A workflow run does not use an LLM.

**Status:** early release (0.1.0). It needs Node.js 22.18 or later.

## How it works

1. **Explore.** Your agent writes a program for your tools. pinfold runs it in a sandbox. The sandbox has no filesystem, no network, and no imports. The program can only call your tools and return a result.
2. **Review.** Tools that you mark as read-only run live. pinfold does not send any other call. It puts each of them in a **write plan**. pinfold sends nothing until you approve that exact plan.
3. **Save.** When the result is correct, the agent saves the program as a workflow in `.workflows/`.
4. **Run again.** `pinfold run <workflow>` does the work again in about 0.1 seconds. It uses no model tokens. Its writes go through the same approval step.
5. **Repair.** Sometimes the responses of a tool change shape. pinfold then stops before it sends a write. It looks for a mapping from the new shape to the old shape, and asks you to approve it. You do not change the workflow.

## Get started

Install the package:

```sh
npm install -g @cmlcz/pinfold
```

Create `pinfold.json` in your project. Put your MCP servers in it. Mark the tools that only read data. pinfold treats each tool that you do not mark as a write tool.

```json
{
  "servers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "<sentry-mcp-server-package>"],
      "env": { "SENTRY_ACCESS_TOKEN": "${SENTRY_ACCESS_TOKEN}" }
    }
  },
  "classification": {
    "sentry": { "listIssues": "read" }
  }
}
```

Replace the package placeholder with the package of your server. Set `SENTRY_ACCESS_TOKEN` in your environment. pinfold supports servers that use stdio and servers that use Streamable HTTP.

Add this command to the MCP configuration of your agent. Use the absolute path to your config file.

```sh
pinfold-gateway --config /absolute/path/to/pinfold.json
```

Then ask your agent to do a task:

> Count the unresolved Sentry issues for a `project` input. Run it for `web`.

When the result is correct, tell the agent to save it:

> Save that as count_unresolved.

Now you can run the workflow yourself:

```sh
pinfold run count_unresolved --project web
```

The [user guide](docs/usage.md) gives every setting and command. It also has a demo that you can run against a local test server.

## Approve writes

When a run is about to write, it stops and shows its write plan. Approve or decline the plan in the approval dialog of your agent, if the client has one. You can also do it in your terminal:

```sh
pinfold plans                # list the plans that wait for a decision
pinfold approve <plan-id>
pinfold decline <plan-id>
```

After you approve in the terminal, run the same command again. pinfold builds the plan again. It sends the writes only if the new plan is the same as the plan that you approved. A stopped command exits with code `3`. A script can use this code to tell a stop from a failure.

After you approve the code of a workflow, later runs can write without approval. The number of writes must not be more than the write budget of the workflow. You must approve again in these cases:

- The code of the workflow changes.
- A response adapter changes. A response adapter is described below.
- A plan is larger than the write budget.

If a run stops in the middle, use `pinfold resume <run-id>`. It sends the writes that pinfold did not send. A write can possibly reach the server, but pinfold has no proof that it did. pinfold keeps that write blocked. You must check the server and mark the write as resolved. In this way, pinfold never sends a write two times by mistake.

**Keep approval away from your agent.** An agent that runs as your user can approve its own plans. To prevent this, turn off automatic answers to approval dialogs. Do not let the agent access the approval commands, `.pinfold/`, or your tool classifications. Refer to [Keep your agent away from approval](docs/usage.md#keep-your-agent-away-from-approval).

## When a tool changes

Tools change. A field gets a new name. A number becomes a string. A value moves into a nested object. This is **drift**. Without protection, a workflow reads a field that does not exist. Then it can write wrong data.

When you save a workflow, pinfold records the fields that the workflow reads. It also records sample responses. Before each write, pinfold compares live responses with this record. If they are different, pinfold stops the run. It then looks for a **response adapter**. A response adapter is a small mapping. It changes the new response back to the old shape. For example, if `count` becomes `eventCount`, an adapter gives `count` again. Each workflow that uses the tool then works again.

pinfold gets repairs from three sources. It uses them in this order:

1. **The search of pinfold.** It uses no model. It proposes an adapter only if one mapping is clearly the best fit for the evidence.
2. **Your agent.** If the search finds nothing, the agent can propose an adapter with the `propose_repair` tool.
3. **An optional model.** For jobs that run without a person, you can put the name of an OpenRouter model in `pinfold.json`. pinfold asks the model only if the first two sources fail.

An adapter always comes from one of these sources. pinfold checks it against each workflow that uses the tool. It has no effect until you approve it. You see the mapping, a comparison of its values with the recorded values, and the write plan.

Sometimes you want the new shape. For example, the server can add a field that you want to read. Use `pinfold baseline migrate`. It shows what changed and which workflows stop working. Then it records the new shape.

There are two limits:

- Some changes need a change to the workflow. An adapter cannot fix them.
- pinfold cannot detect a change in the meaning of a field when the name and the type do not change.

## Before you rely on it

- **You decide the classification.** pinfold runs a tool that you mark as read immediately. It does not ask for a review. Check each tool.
- **The sandbox limits what a program can reach. It does not limit what a program can send.** Data can leave through tool arguments. This includes the arguments of read tools.
- **Approvals are local.** In CI, keep `.pinfold/` and `.workflows/fixtures/` between runs. If you do not, you lose the approvals and the repair evidence.
- **You can measure use.** `pinfold stats` shows the number of runs, tool calls, and repairs. It also shows the tokens that the repair model used.

## Evidence

These results are from one model, six synthetic tasks, and small samples. They show a trend. They do not give a guarantee.

- **Speed and cost.** Saved workflows ran in about 0.1 seconds and used no model tokens. This is 85 to 500 times faster than an agent that writes a new program for each run. In stage 3, all 162 workflow runs succeeded. Refer to the [benchmark results](docs/results/bench-2026-10-28/README.md) and the [measurement setup](docs/results/bench-2026-10-27/README.md).
- **Repair.** Generated drift scenarios that a mapping can fix gave 53 runs. The search of pinfold repaired 47 of them. It made no wrong repair. The scenarios favor the name matching of pinfold. Refer to the [H2 results](docs/results/h2-2026-10-31.md).
- **Clients.** Claude Code and Codex CLI each completed all six tasks through the gateway. Antigravity CLI completed five. These checks ran without a screen. They did not test approval dialogs. Refer to the [versions and results](docs/results/compat-2026-11-01/README.md).

## Documentation

- [User guide](docs/usage.md): setup, approvals, workflows, repair, and each command
- [Design](idea-codemode-mcp-workflow-compiler.md), [glossary](GLOSSARY.md), and [decisions](docs/adr/)
- [Contributing](CONTRIBUTING.md): commit rules
- [Agent instructions](AGENTS.md): shared guidance for coding agents that work on this repository

## License

[MIT](LICENSE)
