# Benchmark results

- Measured on: 2026-10-28T18:27:43.434Z
- Commit: a5b28c9
- pinfold: 0.0.0
- Node: v26.12.0
- Driver: codex 0.153.4 deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8
- Budget cap (USD): 0.4
- Mode: full
- Merged from: bench-results/full-2026-10-28/codex-error-digest, bench-results/full-2026-10-28/codex-issue-owners, bench-results/full-2026-10-28/codex-file-issues, bench-results/full-2026-10-28/codex-commit-counts, bench-results/full-2026-10-28/codex-triage-once, bench-results/full-2026-10-28/codex-triage-assign

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A1  |    9 |    100% |  100% |        46294 |  42069 |           0 |           829 |       221 |     0.0008 |        108439 |        156352 |         3.8 |                 0 |         0 |
| error-digest  | A2  |    9 |    100% |  100% |        55675 |  50873 |           0 |           850 |       249 |     0.0009 |        104577 |        280447 |         4.1 |                 0 |         0 |
| error-digest  | A3  |    9 |    100% |  100% |        45855 |  40405 |           0 |           742 |       162 |     0.0009 |         72667 |        112859 |         3.6 |                 0 |         0 |
| error-digest  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           132 |           152 |         0.0 |                 0 |         0 |
| issue-owners  | A1  |    9 |    100% |  100% |        53833 |  48967 |           0 |           617 |       193 |     0.0008 |        107955 |        151752 |         4.4 |                 0 |         0 |
| issue-owners  | A2  |    9 |    100% |  100% |        46502 |  42325 |           0 |           545 |        83 |     0.0007 |         74702 |        117433 |         3.6 |                 0 |         0 |
| issue-owners  | A3  |    9 |    100% |  100% |        39114 |  35342 |           0 |           389 |        18 |     0.0006 |         74991 |        109701 |         3.1 |                 0 |         0 |
| issue-owners  | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |            89 |           110 |         0.0 |                 0 |         0 |
| file-issues   | A1  |    9 |    100% |  100% |        59077 |  54571 |           0 |          1049 |       262 |     0.0009 |         87583 |        186800 |         4.8 |                 0 |         0 |
| file-issues   | A2  |    9 |    100% |  100% |        67497 |  60971 |           0 |          1482 |       474 |     0.0013 |        127792 |        251751 |         4.9 |                 0 |         9 |
| file-issues   | A3  |    9 |    100% |  100% |        38145 |  34133 |           0 |           437 |        49 |     0.0006 |         72187 |        120882 |         3.0 |                 0 |         9 |
| file-issues   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           118 |           151 |         0.0 |                 0 |         0 |
| commit-counts | A1  |    9 |     44% |   33% |       214104 | 189099 |           0 |          5153 |      4400 |     0.0045 |        249827 |        385241 |         9.8 |                 0 |         0 |
| commit-counts | A2  |    9 |    100% |  100% |        46929 |  42140 |           0 |           723 |       233 |     0.0008 |         68212 |        125658 |         3.7 |                 0 |         0 |
| commit-counts | A3  |    9 |    100% |  100% |        51224 |  47602 |           0 |           592 |       104 |     0.0007 |         74484 |        200965 |         4.0 |                 0 |         0 |
| commit-counts | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           127 |           146 |         0.0 |                 0 |         0 |
| triage-once   | A1  |    9 |    100% |  100% |        68030 |  62492 |           0 |          1617 |       512 |     0.0012 |        145123 |        204602 |         5.3 |                 0 |         0 |
| triage-once   | A2  |    9 |    100% |  100% |        81751 |  75634 |           0 |          2178 |       901 |     0.0015 |         82758 |        593520 |         5.7 |                 0 |         6 |
| triage-once   | A3  |    9 |    100% |  100% |        50388 |  44999 |           0 |           829 |       254 |     0.0009 |         68792 |        101809 |         3.9 |                 0 |         6 |
| triage-once   | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           114 |           152 |         0.0 |                 0 |         0 |
| triage-assign | A1  |    9 |     56% |   33% |        78958 |  73273 |           0 |          2064 |      1368 |     0.0014 |        100514 |        240980 |         6.2 |                 0 |         0 |
| triage-assign | A2  |    9 |     89% |   67% |       102987 |  95531 |           0 |          3853 |      2775 |     0.0021 |        194170 |        317159 |         7.1 |                 0 |         6 |
| triage-assign | A3  |    9 |    100% |  100% |        48509 |  44587 |           0 |           912 |       404 |     0.0008 |         64761 |        197546 |         3.8 |                 0 |         6 |
| triage-assign | A4  |    9 |    100% |  100% |            0 |      0 |           0 |             0 |         0 |     0.0000 |           124 |           148 |         0.0 |                 0 |         0 |

Break-even Point of A4 against each agent Arm, in runs, with A4's Exploration Run priced as one run of that Arm:

| Task          | Against A1 | Against A2 | Against A3 |
| :------------ | ---------: | ---------: | ---------: |
| error-digest  |          1 |          1 |          1 |
| issue-owners  |          1 |          1 |          1 |
| file-issues   |          1 |          1 |          1 |
| commit-counts |          1 |          1 |          1 |
| triage-once   |          1 |          1 |          1 |
| triage-assign |          1 |          1 |          1 |
