# Benchmark results

- Measured on: 2026-11-01T17:58:25.998Z
- Commit: bfcd5cb
- pinfold: 0.1.0
- Node: v26.12.0
- Driver: antigravity 1.4.12 own login
- Repair Model: none
- Budget cap (USD): 0
- Mode: full
- Runs at a time: 1
- Merged from: docs/results/compat-2026-11-01/antigravity

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens |  Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | ------: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A2  |    1 |    100% |  100% |       130977 |       0 |           0 |          4237 |      3219 |     0.0000 |         62071 |         62071 |         0.0 |                 0 |         0 |
| issue-owners  | A2  |    1 |    100% |  100% |        70601 |       0 |           0 |          2332 |      1770 |     0.0000 |         35902 |         35902 |         0.0 |                 0 |         0 |
| file-issues   | A2  |    1 |    100% |  100% |       165033 |   15128 |           0 |          5497 |      3867 |     0.0000 |         69242 |         69242 |         0.0 |                 0 |         1 |
| commit-counts | A2  |    1 |    100% |  100% |       128486 |       0 |           0 |          3253 |      2467 |     0.0000 |         51023 |         51023 |         0.0 |                 0 |         0 |
| triage-once   | A2  |    1 |    100% |  100% |       231966 |   77057 |           0 |          9388 |      7211 |     0.0000 |        102639 |        102639 |         0.0 |                 0 |         1 |
| triage-assign | A2  |    1 |      0% |    0% |      2845222 | 2558893 |           0 |         24935 |     20319 |     0.0000 |        359971 |        359971 |         0.0 |                 2 |         3 |
