# Corrected Adaptive Research Pipeline

This pipeline preserves the original campaign in `results/campaigns/full` and writes every corrected or derived artifact to a separate directory.

## 1. Runtime

```powershell
$node = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$python = 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
```

## 2. Preflight Tests

```powershell
& $node barc-sim-tests.js
& $node campaign-tests.js
& $node research-pipeline-tests.js
& $python -m py_compile final-research-analysis.py generate-research-report.py verify-research-report.py
```

## 3. Correct The 3,720 Adaptive Runs

```powershell
& $node adaptive-correction-runner.js `
  --base results/campaigns/full `
  --out results/campaigns/adaptive-correction `
  --phase all `
  --resume
```

The stages are sequential because each selection changes the next stage:

1. `B-training`: 960 corrected adaptive candidates.
2. `B-validation`: 480 runs using the corrected training top three.
3. `C`: 1,200 runs using the corrected oracle.
4. `D`: 960 oracle and D1/D4/D8 feedback runs.
5. `E`: 120 runs using the corrected realistic-feedback winner.

The command is safe to stop and resume. Completed scenario names are not executed twice.

Progress appears every 25 newly completed runs. The long run is expected to take roughly 20-50 hours, with phases C, D, and E dominating.

Validation:

```powershell
Get-Content results/campaigns/adaptive-correction/validation.json
Get-Content results/campaigns/adaptive-correction/selections.json

$corrected = Get-Content results/campaigns/adaptive-correction/reports.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json }

$corrected.Count
$corrected | Group-Object { $_.experiment.phase } | Select-Object Name, Count
($corrected | Where-Object { $_.config.losslessAdmissionControl -ne $false }).Count
($corrected | Where-Object { $_.summary.activeAtEnd }).Count
```

Expected full counts:

| Phase | Runs |
| --- | ---: |
| B-training | 960 |
| B-validation | 480 |
| C | 1,200 |
| D | 960 |
| E | 120 |
| Total | 3,720 |

The last two PowerShell checks must both print `0`.

## 4. Build The Canonical Dataset

```powershell
& $node build-corrected-dataset.js `
  --base results/campaigns/full `
  --correction results/campaigns/adaptive-correction `
  --out results/campaigns/final-corrected
```

The builder removes exactly 3,720 superseded adaptive reports, preserves 9,880 valid reports, and adds 3,720 corrected reports. This supports legitimate changes in the selected B-validation candidates or E feedback winner.

```powershell
Get-Content results/campaigns/final-corrected/canonical-validation.json
Get-Content results/campaigns/final-corrected/validation.json
Get-Content results/campaigns/final-corrected/selections.json
```

The final dataset must contain exactly 13,600 unique reports.

## 5. Phase-Aware Statistical Analysis

```powershell
& $python final-research-analysis.py `
  --campaign results/campaigns/final-corrected `
  --out analysis/final `
  --bootstrap-samples 10000
```

Outputs:

- `analysis/final/statistics.json`
- `analysis/final/report_data.json`
- `analysis/final/tables/runs.csv`
- `analysis/final/tables/paired_comparisons.csv`
- `analysis/final/tables/phase_policy_summary.csv`
- `analysis/final/tables/stratified_summary.csv`
- `analysis/final/tables/policy_model_predictions.csv`
- `analysis/final/figures/*.svg`

Only phases C, D, and E are used as confirmatory evidence. A and B document screening and policy selection.

## 6. Select And Run 80 Forensic Runs

```powershell
& $node select-forensic-cases.js `
  --campaign results/campaigns/final-corrected `
  --count 80 `
  --out results/campaigns/final-corrected/forensic-80.jsonl

Get-Content results/campaigns/final-corrected/forensic-80-selection.json
```

The selector creates 40 focal cases and 40 exact-lossless paired baselines. Exactly four pairs use payload 10,000, limiting full-ledger storage to eight long-payload runs.

```powershell
& $node campaign-runner.js `
  --manifest campaign-manifest.json `
  --scenario-file results/campaigns/final-corrected/forensic-80.jsonl `
  --out results/campaigns/forensic-80 `
  --resume
```

Full forensic telemetry may require approximately 5-15 GB.

```powershell
$forensic = Get-Content results/campaigns/forensic-80/reports.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json }
$forensic.Count
$forensic | Group-Object { $_.experiment.forensicRole } | Select-Object Name, Count
```

Expected: 80 reports, 40 focal and 40 exact-lossless baselines.

## 7. Generate And Verify The PDF

```powershell
& $python generate-research-report.py `
  --campaign results/campaigns/final-corrected `
  --analysis analysis/final `
  --forensic results/campaigns/forensic-80 `
  --out output/pdf/barc_multicast_adaptive_research_report.pdf

& $python verify-research-report.py `
  --pdf output/pdf/barc_multicast_adaptive_research_report.pdf `
  --out tmp/pdfs/barc-report-qa
```

The verifier renders every PDF page to PNG, checks the page count, extracted text and bookmarks, and creates contact sheets under `tmp/pdfs/barc-report-qa/`.

The report generator refuses to produce the final document unless the canonical dataset is valid, contains 13,600 reports, and all 40 forensic pairs are available.
