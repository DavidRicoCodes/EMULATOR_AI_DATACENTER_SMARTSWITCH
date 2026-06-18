# Experiment Analysis

Generated from 144 reports.

## Overall

- Complete runs: 132/144 (91.67%)
- Avg CCT: 96.51 ticks
- FCT p50/p95/p99: 76 / 173 / 302 ticks
- Avg drops: 1482.31
- Avg repair packets: 1253.10
- Avg control reports: 1881.19
- Avg retransmitted reports: 914.38
- Avg drops/original block: 1.2692
- Avg repairs/original block: 1.0657
- Avg original TX complete: 45.07 ticks
- Avg post-TX completion tail: 38.83 ticks
- Avg recovery tail: 37.22 ticks

## Policy Ranking

| Rank | Policy | Completion | Avg CCT | TX Complete | Post-TX Tail | Recovery Tail | Drops/Block | Repairs/Block |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | advisor-exact-lossless | 100.00% | 71.56 | 61.67 | 6.08 | 0.00 | 0.0000 | 0.0000 |
| 2 | per-source-lossless | 100.00% | 71.56 | 61.67 | 6.08 | 0.00 | 0.0000 | 0.0000 |
| 3 | adaptive-advisor-overdrive | 100.00% | 72.50 | 61.67 | 7.25 | 5.08 | 0.0055 | 0.0055 |
| 4 | advisor-overdrive-a1.05 | 100.00% | 75.11 | 59.17 | 12.08 | 12.08 | 0.2064 | 0.2064 |
| 5 | advisor-overdrive-a1.10 | 100.00% | 79.83 | 56.67 | 19.92 | 19.92 | 0.4195 | 0.4189 |
| 6 | advisor-overdrive-a1.20 | 100.00% | 83.56 | 51.67 | 28.08 | 28.08 | 0.8370 | 0.8323 |
| 7 | advisor-overdrive-a1.35 | 100.00% | 101.61 | 46.17 | 49.00 | 49.00 | 1.4294 | 1.3538 |
| 8 | max-rate-recovery | 100.00% | 109.06 | 10.00 | 95.67 | 95.67 | 4.7181 | 4.4340 |
| 9 | advisor-overdrive-a1.50 | 100.00% | 123.44 | 41.33 | 75.00 | 75.00 | 1.8116 | 1.7559 |
| 10 | member-formula-rate | 100.00% | 130.39 | 50.00 | 66.00 | 61.08 | 1.1259 | 1.0194 |
| 11 | advisor-overdrive-a2.00 | 100.00% | 143.00 | 30.83 | 100.75 | 100.75 | 2.8685 | 2.7617 |
| 12 | no-recovery-max-rate | 0.00% | n/a | 10.00 | 0.00 | 0.00 | 1.8084 | 0.0000 |

## Initial Interpretation

- Prefer policies with completion rate near 100%, then compare Avg CCT and FCT p95/p99.
- `max-rate-recovery` should be judged together with repair/control overhead; a low original TX time may still create a long recovery tail.
- `advisor-exact-lossless` is the uniform no-drop baseline; the research target is any 100%-completion policy with lower CCT.
- `per-source-lossless` tests whether heterogeneous max-min source rates improve utilization without requiring recovery.

See `ranking.csv` for grouped rankings and the raw CSV/JSONL files for deeper analysis.