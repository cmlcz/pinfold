# Lifecycle experiment

- Measured on: 2026-10-28T17:22:43.593Z
- Commit: 209d758
- pinfold: 0.0.0
- Node: v26.12.0
- Model: deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8
- Budget cap (USD): 1
- Mode: full
- Task: triage-assign, input 0
- Before run 26: `rename:getBlame:authorEmail` on github, kept on
- Before run 51: `type-change:listIssues:issues[].count` on sentry, kept on
- Before run 76: `wrap:getBlame` on github, kept on

A4's totals include its Exploration Run, one agent run: 23841 tokens, $0.0012. Correction, added after the run: not every Repair was deterministic. The environment named a Repair Model (`PINFOLD_REPAIR_MODEL`), and it repaired the wrap at run 76, which deterministic Repair cannot settle on a Tool already repaired once (#47). Its cost was not recorded and is missing from A4's totals; it was one model call. a run that paused waited for the developer's Approval of a changed Response Adapter or a new plan.

| Arm | Runs | Failed | Approval pauses |  Tokens | Cost (USD) |
| :-- | ---: | -----: | --------------: | ------: | ---------: |
| A2  |  100 |     58 |             100 | 3883859 |     0.1815 |
| A4  |  100 |      0 |               3 |   23841 |     0.0012 |

A4 reached its Break-even Point against A2 at run 2: from there on, its cumulative cost is at most A2's.

Cumulative cost (USD) by run:

| Run |     A2 |     A4 |
| --: | -----: | -----: |
|   1 | 0.0010 | 0.0012 |
|  10 | 0.0118 | 0.0012 |
|  25 | 0.0338 | 0.0012 |
|  26 | 0.0355 | 0.0012 |
|  50 | 0.0788 | 0.0012 |
|  51 | 0.0796 | 0.0012 |
|  75 | 0.1249 | 0.0012 |
|  76 | 0.1296 | 0.0012 |
| 100 | 0.1815 | 0.0012 |
