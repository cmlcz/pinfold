# Benchmark stage 3: four Arms, three drivers, and the lifecycle

Measured on 2026-10-28 with pinfold 0.0.0 on Node v26.12.0, at commit `d7810f5` (minimal loop and Claude Code) and `a5b28c9` (Codex, after two driver fixes: MCP tool approval and the run time limit). Every agent ran `deepseek/deepseek-v4.1-flash-1017` on OpenRouter, pinned to the `deepinfra/fp8` endpoint with fallbacks off. Claude Code 2.1.312 and Codex CLI 0.153.4 ran headless through a local proxy that adds the pin and reads each call's cost from OpenRouter's answer ([ADR 0011](../../adr/0011-pin-the-cli-drivers-through-a-local-proxy.md)).

Each driver ran six tasks, three inputs each, three runs per Arm: 216 runs per driver, 648 in all, for $0.54. Every driver folder holds `summary.md`, `runs.jsonl`, `provenance.json` and the raw transcripts or CLI events in `transcripts.tar.gz`. `node src/packages/bench/summarize.ts` merges per-task result folders into one summary.

## Findings

- **A4 succeeded on all 162 of its runs, with no tokens, at a median of 72–133 ms per task.** Its Break-even Point against A1, A2 and A3 is one run for every task and driver, with its Exploration Run priced as one run of that Arm. Drift, Repairs and Approval pauses are counted in the lifecycle experiment below.
- **The agent Arms succeeded on 76% to 100% of their runs, depending on the driver.**

  | Driver       | A1    | A2    | A3    | A4    | Cost of the 216 runs |
  | :----------- | :---- | :---- | :---- | :---- | -------------------: |
  | Minimal loop | 48/54 | 41/54 | 48/54 | 54/54 |               $0.127 |
  | Claude Code  | 52/54 | 54/54 | 52/54 | 54/54 |               $0.220 |
  | Codex CLI    | 45/54 | 53/54 | 54/54 | 54/54 |               $0.192 |

- **A3, reusing a saved program, used fewer tokens than A2 with every driver,** by 42% with the loop, 10% with Claude Code and 33% with Codex, per run on average. With the loop and Codex it also succeeded more often. It still pays for an LLM on every run.
- **A1, plain MCP tool calls, struggled with the paged task.** On `commit-counts` it read every page through the agent's context: 86,000 to 214,000 input tokens per run, 5 to 9 times A2's, and it succeeded on 44% (Codex) to 100% (Claude Code) of its runs.
- **The real CLIs cost more tokens per run than the minimal loop:** 30,000 to 38,000 for Claude Code and 46,000 to 89,000 for Codex, against 12,000 to 24,000 for the loop. Every call carries the CLI's own system prompt and tool listing; 77% (Claude Code) and 91% (Codex) of their input tokens were read from the provider's cache.
- **One agent run sent wrong writes.** In one `file-issues` run, the loop's A2 agent filed issues for two Sentry issues the task did not ask for. The harness approves every Write Plan unread, as if the developer did not look; a developer reading the plan would have seen the titles. No other run sent an unintended write.

## Lifecycle (H5)

`lifecycle-a2/` runs `triage-assign` on input 0 a hundred times per Arm with the minimal loop. A rename (`github.getBlame`) turns on before run 26, a type change (`sentry.listIssues`) before run 51 and a wrap of the already renamed `github.getBlame` before run 76, and each stays on.

- **A4 succeeded on all 100 runs and paused for Approval three times, once per Drift.** The rename and the type change were repaired by pinfold's deterministic search. The wrap was repaired by the Repair Model, which the environment named; deterministic Repair alone stopped the Workflow there, with nothing sent ([#47](https://github.com/cmlcz/pinfold/issues/47)). Since then, deterministic Repair settles it by running the earlier rename again after the unwrap.
- **A2 succeeded on 42 of 100 runs**, 10 of the first 25, before any Drift. It cost $0.18 and 3.9 million tokens over the 100 runs.
- **A4 reached its Break-even Point against A2 at run 2**, counting its Exploration Run ($0.0012) and its Approval pauses. **H5 holds against A2.** The Repair Model's one call is not in A4's total; the harness now counts it for future runs.
- An A3 lifecycle, `lifecycle-a3/`, is added when it ends.

## How to read it

- **Wall times are not comparable with stage 2.** Up to 19 processes ran in parallel against the one endpoint, so a model call took up to about 55 s instead of 2 to 5. The agent Arms' wall times here are inflated; A4 makes no model call and is not. H1 is measured on [stage 2](../bench-2026-10-27/README.md), run one at a time: A4 was 85 to 500 times faster than A2.
- Codex's answers do not name the provider, so its records show only the model. The pin still holds: fallbacks are off.
- The harness approves each Write Plan at once and does not time the pause. The Approval column counts them.
- One model on one endpoint, three runs per input. A different model, or the real clients on subscription logins, may do better or worse.
