# Compatibility checks on subscription logins

These checks test whether pinfold works with three agent CLIs as people use them every day: on a subscription login, with each CLI's default model. They are part of the launch work in [#23](https://github.com/cmlcz/pinfold/issues/23).

## Setup

- **When:** 2026-11-01, on macOS, with pinfold 0.1.0 at commit `bfcd5cb` and Node v26.12.0.
- **Tasks:** the six benchmark tasks, each run once on its first input.
- **Arm:** A2. The agent gets only pinfold's Gateway, and writes a program for the task with `search_sdk` and `run_sandbox`. Tasks that write pause for Approval, and the harness approves each plan in place of the developer.
- **Command:** `pinfold bench --subscription --driver <cli> --budget 0 --arms A2 --inputs 0 --repeats 1`

| CLI             | Version | Login                | Model                                                      |
| :-------------- | :------ | :------------------- | :--------------------------------------------------------- |
| Claude Code     | 2.1.316 | Claude subscription  | `claude-opus-5-5`, its default                             |
| Codex CLI       | 0.153.4 | ChatGPT subscription | its default; its events do not name it                     |
| Antigravity CLI | 1.4.12  | Google account       | Gemini 3.8 Flash (Medium), set in the developer's settings |

How each CLI ran:

- **Claude Code** loaded no user settings, so none of the developer's plugins or hooks ran. Its only tools were pinfold's Gateway and `Read`.
- **Codex CLI** ignored the developer's `config.toml` and ran in a read-only sandbox. It still loaded the developer's skills from `~/.codex/skills`.
- **Antigravity CLI** has no option to pass MCP servers, so each run added the Gateway to its global MCP settings and removed it after. All its tools were allowed, with its terminal sandboxed.

The three CLIs ran at the same time, each against its own Drift Kit servers, so wall times may include some contention. A subscription has no per-run price, so cost was not measured.

## Results

| CLI             | Tasks passed | Wall time per task                     | Input tokens per task                              |
| :-------------- | -----------: | :------------------------------------- | :------------------------------------------------- |
| Claude Code     |          6/6 | 7–15 s                                 | 20,000–27,000                                      |
| Codex CLI       |          6/6 | 14–44 s                                | 104,000–210,000                                    |
| Antigravity CLI |          5/6 | 36–103 s, and 360 s for the failed run | 71,000–232,000, and 2.8 million for the failed run |

Input tokens include cached ones. Each folder holds `summary.md`, `runs.jsonl`, `provenance.json`, the run log and the transcripts in `transcripts.tar.gz`.

## Findings

- **pinfold worked with all three CLIs.** Each one connected to the Gateway over MCP, found Tools with `search_sdk`, ran programs with `run_sandbox`, and paused for Approval on the tasks that write.
- **Antigravity failed `triage-assign` because it sent test writes.** It filed two issues titled `test` and `test2` to learn what a write returns. The harness approved them, as it approves every plan; a developer reading the plans would have seen the titles and declined. Most of the rest of its six minutes went to work outside its working directory: it searched the web, listed temporary folders and the home folder, and read the benchmark's own source code. Its final answer was right, but the two test issues fail the task.
- **Antigravity's tools reach far beyond MCP.** In print mode with all tools allowed, it can read any file and search the web; its sandbox stopped only some commands, such as `ps`. Run it in a stronger sandbox when it works with real servers. The same advice applies to every agent: see [Keep your agent away from approval](../../../README.md#keep-your-agent-away-from-approval).
- **The Approval Dialog was not tested.** These runs are headless, so no CLI showed a dialog. Plans were approved through the harness instead.

## What was removed from the transcripts

The transcripts showed files from the developer's machine. Before publishing, the output of every tool call that is not an MCP call was replaced with `[removed: ...]`: Antigravity's commands, file reads and web searches, and Codex's shell commands. The calls themselves and their parameters remain. Antigravity's `summary.md` was rebuilt from `runs.jsonl` after a parser fix counted its cached input tokens, which its events report apart from the others.
