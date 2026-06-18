# BARC Multicast Experiment Batch

Suite: smoke
Generated: 2026-06-17T15:11:07.936Z
Scenarios: 84

## Files

- `manifest.json`: run configuration and assumptions.
- `scenarios.jsonl`: exact scenario inputs.
- `reports.jsonl`: per-run reports, compacted according to manifest storage flags.
- `summary.csv`: one row per scenario.
- `hosts.csv`: per-host CCT/FCT breakdown, including waiting offset ticks.
- `drops.csv`: per-drop ledger.
- `recovery.csv`: drop-report-repair latency ledger.
- `advisors.csv`: rate advisor and bottleneck estimates.
- `ranking.csv`: grouped analysis rankings.
- `analysis.md`: human-readable first-pass interpretation.

Completion metrics start at tick 0, when data is assumed available. Any `startOffsetTicks` is deliberate waiting and is counted in FCT/CCT.