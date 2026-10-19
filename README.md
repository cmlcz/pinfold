# pinfold

pinfold is a local MCP server for coding agents. It sits between your agent and the MCP servers you use, such as Sentry, GitHub, or Linear. It runs the code your agent writes in an isolated sandbox, and it does not send any write to those servers until you approve it.

> **Early version (0.0.0).** Only the features below work today. Saving workflows and automatic repairs are planned but not available yet.

## What works today

- **Sandboxed runs.** The agent writes a short TypeScript program. pinfold runs it in a sandbox with no filesystem, network, or imports. The program reaches the outside only through your MCP servers, and it returns only its result.
- **Read tools run live.** Tools you mark as read run against the real server.
- **Writes wait for approval.** Tools that change something are recorded into a plan. Nothing is sent until you approve that exact plan.
- **Resume.** If an approved plan stops partway through, `resume` sends the writes that were not sent yet. A write that may have reached the server is never sent again.

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
      "args": ["-y", "<sentry-mcp-server-package>"]
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

- **`servers`** lists the MCP servers pinfold connects to. Each server's tools appear in the sandbox as `sdk.<server>.<tool>`. Server names must be valid JavaScript identifiers.
- **`classification`** marks tools as `"read"`. Any tool you leave out is a write tool.
- **`limits`** is optional. The values above are the defaults: 30 seconds, 64 MiB of memory, and 100 tool calls per run.

## Connect your agent

Start pinfold as an MCP server over stdio. Add this command to your agent's MCP settings:

```sh
node src/packages/gateway/bin.ts --config pinfold.json
```

The agent gets two tools:

- **`search_sdk`** finds the TypeScript signatures of the tools that match a keyword query.
- **`run_sandbox`** runs a program that exports `main(input)` and calls tools with `await sdk.<server>.<tool>(args)`.

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

## Where pinfold keeps its state

- **`.pinfold/`** holds the write plans and a journal of the writes already sent. It is git-ignored.
- **`.workflows/baselines/`** holds the recorded response shape of each tool.

## License

MIT
