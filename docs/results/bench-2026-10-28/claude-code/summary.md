# Benchmark results

- Measured on: 2026-10-28T18:11:15.167Z
- Commit: d7810f5
- pinfold: 0.0.0
- Node: v26.12.0
- Driver: claude-code 2.1.312 deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8
- Budget cap (USD): 0.4
- Mode: full
- Merged from: bench-results/full-2026-10-28/claude-code-error-digest, bench-results/full-2026-10-28/claude-code-issue-owners, bench-results/full-2026-10-28/claude-code-file-issues, bench-results/full-2026-10-28/claude-code-commit-counts, bench-results/full-2026-10-28/claude-code-triage-once, bench-results/full-2026-10-28/claude-code-triage-assign

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A1  |    9 |    100% |  100% |        22398 |  17052 |           0 |          1609 |       832 |     0.0011 |         85514 |        437393 |         5.0 |                 0 |         0 |
| error-digest  | A2  |    9 |    100% |  100% |        29736 |  22898 |           0 |          1481 |       588 |     0.0012 |         70385 |        213014 |         5.3 |                 0 |         0 |
| error-digest  | A3  |    9 |    100% |  100% |        28951 |  23083 |           0 |          1427 |       493 |     0.0011 |         57710 |        148773 |         5.3 |                 0 |         0 |
| error-digest  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           105 |           149 |         0.0 |                 0 |         0 |
| issue-owners  | A1  |    9 |    100% |  100% |        13039 |   8789 |           0 |           454 |       143 |     0.0006 |         41662 |        132306 |         3.4 |                 0 |         0 |
| issue-owners  | A2  |    9 |    100% |  100% |        22894 |  16953 |           0 |           925 |       302 |     0.0009 |        104266 |        372183 |         4.3 |                 0 |         0 |
| issue-owners  | A3  |    9 |     78% |   33% |        19573 |  14364 |           0 |           679 |       174 |     0.0008 |         59266 |        249960 |         4.0 |                 0 |         0 |
| issue-owners  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            99 |           135 |         0.0 |                 0 |         0 |
| file-issues   | A1  |    9 |    100% |  100% |        16585 |  11108 |           0 |          1058 |       160 |     0.0009 |         63397 |        237409 |         4.0 |                 0 |         0 |
| file-issues   | A2  |    9 |    100% |  100% |        28088 |  20238 |           0 |          1722 |       578 |     0.0014 |        156366 |        397585 |         5.0 |                 0 |         9 |
| file-issues   | A3  |    9 |    100% |  100% |        23705 |  17508 |           0 |          1006 |       277 |     0.0010 |        101906 |        181358 |         4.7 |                 0 |         9 |
| file-issues   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           108 |           148 |         0.0 |                 0 |         0 |
| commit-counts | A1  |    9 |    100% |  100% |       106493 |  87239 |           0 |          3664 |      3200 |     0.0032 |        228485 |        319876 |         7.7 |                 0 |         0 |
| commit-counts | A2  |    9 |    100% |  100% |        15989 |  10212 |           0 |           836 |       323 |     0.0009 |         49993 |        164737 |         3.4 |                 0 |         0 |
| commit-counts | A3  |    9 |    100% |  100% |        21234 |  15502 |           0 |           926 |       308 |     0.0009 |        104647 |        292645 |         4.4 |                 0 |         0 |
| commit-counts | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           133 |           154 |         0.0 |                 0 |         0 |
| triage-once   | A1  |    9 |    100% |  100% |        26200 |  19755 |           0 |          1832 |       442 |     0.0013 |         94045 |        512620 |         5.4 |                 0 |         0 |
| triage-once   | A2  |    9 |    100% |  100% |        44584 |  36580 |           0 |          2476 |      1038 |     0.0016 |        102179 |        466809 |         6.7 |                 0 |         6 |
| triage-once   | A3  |    9 |    100% |  100% |        34638 |  27762 |           0 |          2285 |      1018 |     0.0014 |         85287 |        177162 |         5.9 |                 0 |         6 |
| triage-once   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           112 |           189 |         0.0 |                 0 |         0 |
| triage-assign | A1  |    9 |     78% |   67% |        29974 |  23268 |           0 |          2099 |      1340 |     0.0014 |        124303 |        396573 |         6.2 |                 0 |         0 |
| triage-assign | A2  |    9 |    100% |  100% |        49374 |  40164 |           0 |          3607 |      2545 |     0.0022 |        196954 |        571464 |         7.0 |                 0 |         6 |
| triage-assign | A3  |    9 |    100% |  100% |        43104 |  30478 |           0 |          3719 |      2669 |     0.0025 |        161741 |        461364 |         6.2 |                 0 |         6 |
| triage-assign | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           110 |           153 |         0.0 |                 0 |         0 |

Break-even Point of A4 against each agent Arm, in runs, with A4's Exploration Run priced as one run of that Arm:

| Task          | Against A1 | Against A2 | Against A3 |
| :------------ | ---------: | ---------: | ---------: |
| error-digest  |          1 |          1 |          1 |
| issue-owners  |          1 |          1 |          1 |
| file-issues   |          1 |          1 |          1 |
| commit-counts |          1 |          1 |          1 |
| triage-once   |          1 |          1 |          1 |
| triage-assign |          1 |          1 |          1 |
