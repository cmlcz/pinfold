# Benchmark results

- Measured on: 2026-11-01T17:58:25.713Z
- Commit: bfcd5cb
- pinfold: 0.1.0
- Node: v26.12.0
- Driver: codex 0.153.4 own login
- Repair Model: none
- Budget cap (USD): 0
- Mode: full
- Runs at a time: 1

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A2  |    1 |    100% |  100% |       129355 | 104960 |           0 |           605 |       111 |     0.0000 |         15009 |         15009 |         0.0 |                 0 |         0 |
| issue-owners  | A2  |    1 |    100% |  100% |       132792 | 102144 |           0 |           656 |       155 |     0.0000 |         22136 |         22136 |         0.0 |                 0 |         0 |
| file-issues   | A2  |    1 |    100% |  100% |       162290 | 141056 |           0 |          1249 |       302 |     0.0000 |         34150 |         34150 |         0.0 |                 0 |         1 |
| commit-counts | A2  |    1 |    100% |  100% |       136605 | 115968 |           0 |           955 |       330 |     0.0000 |         16653 |         16653 |         0.0 |                 0 |         0 |
| triage-once   | A2  |    1 |    100% |  100% |       104496 |  89856 |           0 |           700 |       197 |     0.0000 |         13543 |         13543 |         0.0 |                 0 |         1 |
| triage-assign | A2  |    1 |    100% |  100% |       210466 | 188160 |           0 |          1522 |       395 |     0.0000 |         44245 |         44245 |         0.0 |                 0 |         1 |
