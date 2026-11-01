# Benchmark results

- Measured on: 2026-11-01T17:58:25.682Z
- Commit: bfcd5cb
- pinfold: 0.1.0
- Node: v26.12.0
- Driver: claude-code 2.1.316 own login
- Repair Model: none
- Budget cap (USD): 0
- Mode: full
- Runs at a time: 1

Tokens and cost are means per run; wall time excludes Approval pauses. passᵏ is the share of inputs whose every repeated run succeeded.

| Task          | Arm | Runs | Success | passᵏ | Input tokens | Cached | Cache write | Output tokens | Reasoning | Cost (USD) | Wall p50 (ms) | Wall p95 (ms) | Round trips | Unintended writes | Approvals |
| :------------ | :-- | ---: | ------: | ----: | -----------: | -----: | ----------: | ------------: | --------: | ---------: | ------------: | ------------: | ----------: | ----------------: | --------: |
| error-digest  | A2  |    1 |    100% |  100% |        20178 |  16523 |        3649 |           666 |       117 |     0.0000 |          8194 |          8194 |         0.0 |                 0 |         0 |
| issue-owners  | A2  |    1 |    100% |  100% |        20883 |  16963 |        3914 |           521 |        20 |     0.0000 |          7009 |          7009 |         0.0 |                 0 |         0 |
| file-issues   | A2  |    1 |    100% |  100% |        26672 |  22386 |        4278 |          1331 |       121 |     0.0000 |         13513 |         13513 |         0.0 |                 0 |         1 |
| commit-counts | A2  |    1 |    100% |  100% |        19558 |  16246 |        3306 |           545 |        51 |     0.0000 |          6987 |          6987 |         0.0 |                 0 |         0 |
| triage-once   | A2  |    1 |    100% |  100% |        27264 |  22573 |        4683 |          1520 |        76 |     0.0000 |         15016 |         15016 |         0.0 |                 0 |         1 |
| triage-assign | A2  |    1 |    100% |  100% |        21088 |  16887 |        4195 |           777 |       147 |     0.0000 |          9081 |          9081 |         0.0 |                 0 |         1 |
