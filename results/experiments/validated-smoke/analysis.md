# Experiment Analysis

Generated from 84 reports.

## Overall

- Complete runs: 48/84 (57.14%)
- Avg CCT: 69.92 ticks
- FCT p50/p95/p99: 73 / 148 / 329 ticks
- Avg drops: 2284.98
- Avg repair packets: 1645.73
- Avg control reports: 1752.46

## Policy Ranking

| Rank | Policy | Completion | Avg CCT | FCT p95 | Avg Drops | Avg Repairs | Avg Waiting Offset |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | static-lossless-rate | 83.33% | 63.14 | 131 | 832.75 | 628.17 | 0.00 |
| 2 | member-formula-rate | 83.33% | 63.14 | 131 | 832.75 | 628.17 | 0.00 |
| 3 | sequential-smart-recovery | 83.33% | 121.06 | 329 | 667.67 | 491.67 | 0.00 |
| 4 | smart-recovery-max-rate | 50.00% | 46.22 | 83 | 3920.92 | 3301.17 | 0.00 |
| 5 | phase-offset-smart-recovery | 50.00% | 46.56 | 82 | 4004.42 | 3319.17 | 10.50 |
| 6 | intermediate-rate | 50.00% | 47.11 | 87 | 3998.83 | 3151.75 | 0.00 |
| 7 | no-recovery-max-rate | 0.00% | n/a | 19 | 1737.50 | 0.00 | 0.00 |

## Initial Interpretation

- Prefer policies with completion rate near 100%, then compare Avg CCT and FCT p95/p99.
- `smart-recovery-max-rate` should be judged together with repair/control overhead; a low CCT with high drops may still be expensive.
- `static-lossless-rate` is the baseline for robust no-drop operation; if it is much slower, the research target is the gap between it and smart recovery.
- `phase-offset-smart-recovery` includes waiting time in CCT/FCT. It only wins if reduced congestion more than compensates for deliberate delay.
- In this run set, phase offset Avg CCT minus intermediate Avg CCT is -0.56 ticks; negative means offset helped after charging waiting time.

See `ranking.csv` for grouped rankings and the raw CSV/JSONL files for deeper analysis.