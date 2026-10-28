# Benchmark stage 2: A2 against A4

Measured on 2026-10-27 at commit `7966d28`, with pinfold 0.0.0 on Node v26.12.0. A2's model was `deepseek/deepseek-v4.1-flash-1017` on OpenRouter, pinned to the `deepinfra/fp8` endpoint with fallbacks off and temperature 0. The account's setting against providers that train on prompts excluded DeepSeek's own endpoint. Six tasks, three inputs each, three runs per Arm: 108 runs, $0.0457 in all, under a $1 cap. The raw runs, A2's transcripts and the provenance are beside this file.

## Findings

- **H1 holds.** A4's median wall time per task was 80–96 ms, against 7.4–43 s for A2: 85 to 500 times faster, far past the target of 10 times. A4 used no tokens. A2 used 8,700–32,200 input tokens per run, 82–86% of them read from the provider's cache, and 580–3,500 output tokens.
- **A4 succeeded on all 54 runs. A2 succeeded on 48 of 54 (89%).** Its passᵏ, the share of inputs where all three runs succeeded, was 100% on three tasks, 67% on `commit-counts` and 33% on `issue-owners` and `triage-assign`.
- **Half of A2's six failures returned the right data in the wrong shape.** In those three runs the agent wrapped the array or the counts in an object with notes, against the instruction. The other three were real misses: in `triage-assign`, the agent's program filed only some of the issues.
- **Neither Arm sent an unintended write.** A2 paused for Approval 21 times, which the harness approved at once. The pauses are not in the wall times.
- **The Break-even Point is one run for every task.** This comes from the definition, since A4's Exploration Run is priced as one A2 run. The lifecycle experiment adds Drift, Repairs and Approval pauses.

## How to read it

- A2 is pinfold's own Gateway driven by an agent writing a fresh program each run. A1 (plain MCP) and A3 (a saved skill) come in stage 3, so these numbers compare pinfold with code mode only.
- The setup of A4's Workflow is not timed: it was saved from the reference program, and its first run was approved.
- One model on one endpoint, three runs per input. A2's wall time depends on that endpoint's latency on the day.

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A2  |    9 |    100% |  100% |        16829 |  13852 |           0 |          1224 |       263 |     0.0007 |         16241 |         19984 |         5.0 |                 0 |         0 |
| error-digest  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            80 |           115 |         0.0 |                 0 |         0 |
| issue-owners  | A2  |    9 |     78% |   33% |        10712 |   8974 |           0 |           581 |        93 |     0.0004 |          7372 |         11809 |         3.9 |                 0 |         0 |
| issue-owners  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            87 |            99 |         0.0 |                 0 |         0 |
| file-issues   | A2  |    9 |    100% |  100% |        18816 |  15588 |           0 |          1471 |       373 |     0.0008 |         19929 |         32636 |         5.3 |                 0 |         9 |
| file-issues   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            83 |            90 |         0.0 |                 0 |         0 |
| commit-counts | A2  |    9 |     89% |   67% |         8695 |   7438 |           0 |           655 |        99 |     0.0003 |         10169 |         15653 |         3.6 |                 0 |         0 |
| commit-counts | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            96 |           102 |         0.0 |                 0 |         0 |
| triage-once   | A2  |    9 |    100% |  100% |        32212 |  27691 |           0 |          2852 |      1064 |     0.0014 |         32386 |         83452 |         7.6 |                 0 |         6 |
| triage-once   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            94 |           231 |         0.0 |                 0 |         0 |
| triage-assign | A2  |    9 |     67% |   33% |        31703 |  27307 |           0 |          3455 |      2140 |     0.0015 |         42875 |         72916 |         7.6 |                 0 |         6 |
| triage-assign | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            86 |            99 |         0.0 |                 0 |         0 |

Break-even Point of A4 against A2, in runs, with A4's Exploration Run priced as one A2 run:

| Task          | Runs |
| :------------ | ---: |
| error-digest  |    1 |
| issue-owners  |    1 |
| file-issues   |    1 |
| commit-counts |    1 |
| triage-once   |    1 |
| triage-assign |    1 |
