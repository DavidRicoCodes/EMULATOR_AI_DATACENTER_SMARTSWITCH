# BARC Multicast Adaptive Campaign

## Quick Start

Validate the complete pipeline with a small run:

```powershell
node campaign-tests.js
node campaign-runner.js --phase all --mini --out results/campaigns/mini --resume
```

Run the complete 13,600-scenario campaign:

```powershell
node campaign-runner.js --manifest campaign-manifest.json --phase all --out results/campaigns/full --resume
```

The full campaign is intentionally staged. Running `--phase all` performs policy selection after screening, adaptive training, validation and realistic-feedback evaluation before generating dependent phases.

`advisor-exact-lossless` and `per-source-lossless` are idealized offline baselines. They combine advisor rates with topology-aware admission and backpressure so that discrete packet bursts do not create drops.

## Resume And Shards

`--resume` reads `reports.jsonl` and skips completed scenario names. It does not duplicate CSV or JSONL rows.

Use `--shard i/n` to partition a phase:

```powershell
node campaign-runner.js --phase A --shard 1/4 --out results/campaigns/a-shard-1 --resume
```

For dependent phases, distribute the `selections.json` produced by earlier phases to each shard output directory before starting that phase.

Merge completed shards:

```powershell
node merge-campaign-shards.js --out results/campaigns/phase-c-merged results/campaigns/c-shard-1 results/campaigns/c-shard-2
```

## Outputs

- `reports.jsonl`: compact report per run.
- `summary.csv`: run-level completion, CCT, drops and overhead.
- `hosts.csv`: host-level FCT/CCT.
- `interfaces.csv`: drop counts and hot-link metrics.
- `adaptive.csv`: oracle changes and feedback delivery timeline.
- `paired-comparisons.csv`: policy minus exact-lossless for each paired scenario.
- `paired-summary.csv`: win rates, Wilson intervals and paired bootstrap intervals.
- `selections.json`: selected fixed alpha, adaptive oracle and feedback policy.
- `forensic-scenarios.jsonl`: scenarios selected for full-ledger reruns.

## Forensic Runs

```powershell
node campaign-runner.js --scenarioFile results/campaigns/full/forensic-scenarios.jsonl --out results/campaigns/forensic
```

Scenario-file runs force full storage, temporal utilization and detailed ledgers.
