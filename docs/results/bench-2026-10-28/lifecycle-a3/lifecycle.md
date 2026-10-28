# Lifecycle experiment

- Measured on: 2026-10-28T18:24:33.714Z
- Commit: f0208d3
- pinfold: 0.0.0
- Node: v26.12.0
- Driver: deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8
- Budget cap (USD): 1
- Mode: full
- Task: triage-assign, input 0
- Before run 26: `rename:getBlame:authorEmail` on github, kept on
- Before run 51: `type-change:listIssues:issues[].count` on sentry, kept on
- Before run 76: `wrap:getBlame` on github, kept on

A4's totals include its Exploration Run, one agent run: 47886 tokens, $0.0029. Correction, added after the run: not every Repair was deterministic. The environment named a Repair Model (`PINFOLD_REPAIR_MODEL`), and it repaired the wrap at run 76, which deterministic Repair could not then settle on a Tool already repaired once (#47, since fixed). Its cost was not recorded and is missing from A4's totals; it was one model call. a run that paused waited for the developer's Approval of a changed Response Adapter or a new plan.

| Arm | Runs | Failed | Approval pauses |  Tokens | Cost (USD) |
| :-- | ---: | -----: | --------------: | ------: | ---------: |
| A3  |  100 |     71 |             100 | 3902815 |     0.2105 |
| A4  |  100 |      0 |               3 |   47886 |     0.0029 |

A4 reached its Break-even Point against A3 at run 4: from there on, its cumulative cost is at most A3's.

Cumulative cost (USD) by run:

| Run |     A3 |     A4 |
| --: | -----: | -----: |
|   1 | 0.0007 | 0.0029 |
|  10 | 0.0081 | 0.0029 |
|  25 | 0.0268 | 0.0029 |
|  26 | 0.0288 | 0.0029 |
|  50 | 0.0926 | 0.0029 |
|  51 | 0.0952 | 0.0029 |
|  75 | 0.1530 | 0.0029 |
|  76 | 0.1547 | 0.0029 |
| 100 | 0.2105 | 0.0029 |
