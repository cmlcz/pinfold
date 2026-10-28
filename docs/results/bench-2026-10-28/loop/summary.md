# Benchmark results

- Measured on: 2026-10-28T18:11:15.026Z
- Commit: d7810f5
- pinfold: 0.0.0
- Node: v26.12.0
- Driver: deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8
- Budget cap (USD): 0.4
- Mode: full
- Merged from: bench-results/full-2026-10-28/loop-error-digest, bench-results/full-2026-10-28/loop-issue-owners, bench-results/full-2026-10-28/loop-file-issues, bench-results/full-2026-10-28/loop-commit-counts, bench-results/full-2026-10-28/loop-triage-once, bench-results/full-2026-10-28/loop-triage-assign

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A1  |    9 |    100% |  100% |         8916 |   7097 |           0 |           979 |       313 |     0.0005 |         17370 |         28218 |         4.0 |                 0 |         0 |
| error-digest  | A2  |    9 |     78% |   33% |        15352 |  12530 |           0 |          1050 |       240 |     0.0006 |         21980 |         40335 |         4.4 |                 0 |         0 |
| error-digest  | A3  |    9 |    100% |  100% |        13081 |  10994 |           0 |          1211 |       439 |     0.0006 |         29117 |         36658 |         4.6 |                 0 |         0 |
| error-digest  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            98 |           110 |         0.0 |                 0 |         0 |
| issue-owners  | A1  |    9 |    100% |  100% |         5525 |   4139 |           0 |           537 |       192 |     0.0003 |         11408 |         14680 |         3.3 |                 0 |         0 |
| issue-owners  | A2  |    9 |     56% |    0% |        11472 |   9714 |           0 |           604 |        88 |     0.0004 |         16784 |         21503 |         4.1 |                 0 |         0 |
| issue-owners  | A3  |    9 |     78% |   33% |        11130 |   9429 |           0 |           564 |       121 |     0.0004 |         15695 |         30707 |         4.1 |                 0 |         0 |
| issue-owners  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            72 |            82 |         0.0 |                 0 |         0 |
| file-issues   | A1  |    9 |    100% |  100% |         8022 |   6044 |           0 |          1114 |       267 |     0.0005 |         17192 |         33289 |         3.9 |                 0 |         0 |
| file-issues   | A2  |    9 |     89% |   67% |        21428 |  17778 |           0 |          1549 |       395 |     0.0009 |         31195 |         73908 |         5.6 |                 2 |        10 |
| file-issues   | A3  |    9 |    100% |  100% |         7361 |   6116 |           0 |           445 |        84 |     0.0003 |         11736 |         14622 |         3.0 |                 0 |         9 |
| file-issues   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           102 |           115 |         0.0 |                 0 |         0 |
| commit-counts | A1  |    9 |     78% |   33% |        85677 |  70158 |           0 |          5327 |      4837 |     0.0033 |        106017 |        407498 |         8.0 |                 0 |         0 |
| commit-counts | A2  |    9 |     67% |    0% |         9374 |   7851 |           0 |           782 |       140 |     0.0004 |         20342 |         32949 |         3.7 |                 0 |         0 |
| commit-counts | A3  |    9 |     56% |   33% |         7225 |   6315 |           0 |           379 |        58 |     0.0002 |         11011 |         14761 |         3.2 |                 0 |         0 |
| commit-counts | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            92 |           126 |         0.0 |                 0 |         0 |
| triage-once   | A1  |    9 |    100% |  100% |        12379 |   9657 |           0 |          2120 |       535 |     0.0009 |         40974 |         57891 |         4.9 |                 0 |         0 |
| triage-once   | A2  |    9 |    100% |  100% |        24701 |  20608 |           0 |          2273 |       663 |     0.0011 |         59225 |         76794 |         6.4 |                 0 |         6 |
| triage-once   | A3  |    9 |    100% |  100% |        13813 |  11179 |           0 |          1408 |       510 |     0.0007 |         28937 |         95677 |         4.6 |                 0 |         6 |
| triage-once   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            97 |           111 |         0.0 |                 0 |         0 |
| triage-assign | A1  |    9 |     56% |   33% |        13592 |  11548 |           0 |          1705 |      1050 |     0.0007 |         38379 |         99603 |         6.0 |                 0 |         0 |
| triage-assign | A2  |    9 |     67% |   33% |        32437 |  28103 |           0 |          3106 |      1861 |     0.0014 |         57688 |        135872 |         7.8 |                 0 |         6 |
| triage-assign | A3  |    9 |    100% |  100% |        13657 |  11292 |           0 |          1880 |      1180 |     0.0008 |         34209 |         67168 |         4.4 |                 0 |         6 |
| triage-assign | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           100 |           126 |         0.0 |                 0 |         0 |

Break-even Point of A4 against each agent Arm, in runs, with A4's Exploration Run priced as one run of that Arm:

| Task          | Against A1 | Against A2 | Against A3 |
| :------------ | ---------: | ---------: | ---------: |
| error-digest  |          1 |          1 |          1 |
| issue-owners  |          1 |          1 |          1 |
| file-issues   |          1 |          1 |          1 |
| commit-counts |          1 |          1 |          1 |
| triage-once   |          1 |          1 |          1 |
| triage-assign |          1 |          1 |          1 |
