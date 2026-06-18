# Campaign Analysis

Reports: 58
Paired comparisons: 50
Validation violations: 0

## Policy Comparison

| Policy | Complete | Win/Tie/Loss | Win Rate | Mean Delta CCT | Median Relative Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| per-source-lossless | 7/7 | 0/7/0 | 0.00% | 0.00 | 0.00% |
| advisor-overdrive-a1.50 | 6/6 | 1/4/1 | 16.67% | 154.17 | 0.00% |
| member-formula-rate | 4/4 | 1/3/0 | 25.00% | -2.75 | 0.00% |
| selected-adaptive-oracle | 4/4 | 0/4/0 | 0.00% | 0.00 | 0.00% |
| max-rate-recovery | 2/2 | 1/1/0 | 50.00% | -2.00 | -7.41% |
| adaptive-lhs-01 | 2/2 | 0/2/0 | 0.00% | 0.00 | 0.00% |
| adaptive-lhs-07 | 2/2 | 0/2/0 | 0.00% | 0.00 | 0.00% |
| adaptive-lhs-05 | 2/2 | 0/1/1 | 0.00% | 0.50 | 0.00% |
| adaptive-feedback-d1 | 2/2 | 1/0/1 | 50.00% | 5.00 | -5.73% |
| adaptive-feedback-d4 | 1/1 | 1/0/0 | 100.00% | -29.00 | -5.73% |
| adaptive-feedback-d8 | 1/1 | 1/0/0 | 100.00% | -29.00 | -5.73% |
| advisor-overdrive-a2.00 | 1/1 | 1/0/0 | 100.00% | -11.00 | -20.37% |
| advisor-overdrive-a1.35 | 1/1 | 1/0/0 | 100.00% | -9.00 | -16.67% |
| advisor-overdrive-a1.20 | 1/1 | 1/0/0 | 100.00% | -7.00 | -12.96% |
| advisor-overdrive-a1.10 | 1/1 | 1/0/0 | 100.00% | -4.00 | -7.41% |
| advisor-overdrive-a1.05 | 1/1 | 1/0/0 | 100.00% | -2.00 | -3.70% |
| adaptive-advisor-overdrive | 1/1 | 0/1/0 | 0.00% | 0.00 | 0.00% |
| no-recovery-max-rate | 1/2 | 0/1/0 | 0.00% | 0.00 | 0.00% |
| adaptive-lhs-09 | 1/1 | 0/0/1 | 0.00% | 1.00 | 2.63% |
| adaptive-lhs-12 | 1/1 | 0/0/1 | 0.00% | 1.00 | 2.63% |
| adaptive-lhs-02 | 1/1 | 0/0/1 | 0.00% | 2.00 | 5.26% |
| adaptive-lhs-10 | 1/1 | 0/0/1 | 0.00% | 3.00 | 7.89% |
| adaptive-lhs-04 | 1/1 | 0/0/1 | 0.00% | 4.00 | 10.53% |
| adaptive-lhs-06 | 1/1 | 0/0/1 | 0.00% | 4.00 | 10.53% |
| adaptive-lhs-11 | 1/1 | 0/0/1 | 0.00% | 4.00 | 10.53% |
| adaptive-lhs-08 | 1/1 | 0/0/1 | 0.00% | 5.00 | 13.16% |
| adaptive-lhs-03 | 1/1 | 0/0/1 | 0.00% | 6.00 | 15.79% |

## Relevant Winning Strata

No stratum satisfies the predefined relevance criteria.

## Selections

```json
{
  "bestFixedAlphaPolicy": "advisor-overdrive-a1.50",
  "topAdaptiveTrainingPolicies": [
    "adaptive-lhs-01",
    "adaptive-lhs-07",
    "adaptive-lhs-05"
  ],
  "bestAdaptiveOraclePolicy": "adaptive-lhs-01",
  "bestAdaptiveFeedbackPolicy": "adaptive-feedback-d1"
}
```