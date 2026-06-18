# Experiment Analysis

Generated from 84 reports.

## Overall

- Complete runs: 72/84 (85.71%)
- Avg CCT: 119.22 ticks
- FCT p50/p95/p99: 76 / 285 / 387 ticks
- Avg drops: 2914.94
- Avg repair packets: 2436.87
- Avg control reports: 3931.20
- Avg retransmitted reports: 2047.12

## Policy Ranking

| Rank | Policy | Completion | Avg CCT | FCT p95 | Avg Drops | Avg Repairs | Avg Report Retries | Avg Waiting Offset |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | static-lossless-rate | 100.00% | 71.56 | 146 | 0.00 | 0.00 | 0.00 | 0.00 |
| 2 | smart-recovery-max-rate | 100.00% | 109.06 | 282 | 5669.08 | 5215.83 | 3964.08 | 0.00 |
| 3 | intermediate-rate | 100.00% | 121.56 | 281 | 4993.50 | 4584.58 | 4173.58 | 0.00 |
| 4 | phase-offset-smart-recovery | 100.00% | 121.67 | 198 | 5535.33 | 5047.00 | 3987.67 | 10.50 |
| 5 | member-formula-rate | 100.00% | 130.39 | 304 | 1801.50 | 1631.00 | 1476.50 | 0.00 |
| 6 | sequential-smart-recovery | 100.00% | 161.11 | 384 | 667.67 | 579.67 | 728.00 | 0.00 |
| 7 | no-recovery-max-rate | 0.00% | n/a | 19 | 1737.50 | 0.00 | 0.00 | 0.00 |

## Initial Interpretation

- Prefer policies with completion rate near 100%, then compare Avg CCT and FCT p95/p99.
- `smart-recovery-max-rate` should be judged together with repair/control overhead; a low CCT with high drops may still be expensive.
- `static-lossless-rate` is the baseline for robust no-drop operation; if it is much slower, the research target is the gap between it and smart recovery.
- `phase-offset-smart-recovery` includes waiting time in CCT/FCT. It only wins if reduced congestion more than compensates for deliberate delay.
- In this run set, phase offset Avg CCT minus intermediate Avg CCT is 0.11 ticks; negative means offset helped after charging waiting time.

See `ranking.csv` for grouped rankings and the raw CSV/JSONL files for deeper analysis.