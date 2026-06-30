# BARC Multicast Smart-Switch Emulator

Research emulator for multicast collectives over a small Clos/fat-tree datacenter topology, focused on smart-switch selective recovery, congestion behavior, completion time, and policy comparison.

The project models BARC-style stateless forwarding as an assumed/offloaded control plane and studies what happens when multicast traffic congests links: where packets drop, how switches record drops, when reports are sent, and whether selective unicast repair can beat conservative lossless transmission.

## What Is In This Repository

- `emulator.html` and `emulator-app.js`: browser UI for interactive inspection.
- `barc-sim-core.js`: deterministic simulation core.
- `barc-sim-tests.js`, `campaign-tests.js`, `research-pipeline-tests.js`: validation tests.
- `experiment-runner.js`: smaller experiment runner.
- `campaign-runner.js`: headless campaign runner.
- `campaign-analysis.js`: campaign analysis helpers.
- `campaign-manifest.json`: default campaign configuration.
- `adaptive-correction-runner.js`: reruns corrected adaptive scenarios.
- `build-corrected-dataset.js`: builds the canonical corrected dataset.
- `select-forensic-cases.js`: selects paired full-telemetry forensic cases.
- `final-research-analysis.py`: final statistical analysis.
- `generate-research-report.py`: PDF report generation.
- `verify-research-report.py`: PDF rendering/verification.
- `CONTEXT.md`: detailed project handoff context for future chats/work.
- `docs/`: project guides and background references.
- `docs/CORRECTED_RESEARCH_PIPELINE.md`: notes on the corrected analysis pipeline.

The repository also includes the source PDFs/texts used as research background under `docs/references/`.

## What Is Not Versioned

Generated datasets and heavy artifacts are intentionally ignored:

- `results/`
- `analysis/`
- `output/`
- `tmp/`
- `__pycache__/`
- generated paper page/contact images
- `XDP_REC_10/`, which is an independent AF_XDP/XDP implementation repo and should stay separate

If you need final datasets or PDFs, regenerate them locally from the scripts.

## Requirements

- A modern browser for the interactive emulator.
- Node.js for the simulator, tests, and campaign runners.
- Python 3 for final analysis and PDF report generation.

No npm install is required for the current JavaScript tooling.

## Quick Start

Open the interactive emulator:

```powershell
start .\emulator.html
```

Run the core tests:

```powershell
node barc-sim-tests.js
node campaign-tests.js
node research-pipeline-tests.js
```

Run a campaign phase:

```powershell
node campaign-runner.js `
  --manifest campaign-manifest.json `
  --phase A `
  --out results/campaigns/example `
  --resume
```

Large campaigns can take a long time. Use `--resume` so interrupted runs continue without duplicating completed scenarios.

## Corrected Research Pipeline

The canonical research workflow is:

```powershell
node adaptive-correction-runner.js `
  --base results/campaigns/full `
  --out results/campaigns/adaptive-correction `
  --phase all `
  --resume

node build-corrected-dataset.js `
  --base results/campaigns/full `
  --correction results/campaigns/adaptive-correction `
  --out results/campaigns/final-corrected
```

Then select and run forensic cases:

```powershell
node select-forensic-cases.js `
  --campaign results/campaigns/final-corrected `
  --count 80 `
  --out results/campaigns/final-corrected/forensic-80.jsonl

node campaign-runner.js `
  --manifest campaign-manifest.json `
  --scenario-file results/campaigns/final-corrected/forensic-80.jsonl `
  --out results/campaigns/forensic-80 `
  --resume `
  --includeTemporal `
  --includeEventLog `
  --includeLedgersInReports
```

Generate final analysis and report:

```powershell
python final-research-analysis.py `
  --campaign results/campaigns/final-corrected `
  --forensic results/campaigns/forensic-80 `
  --out analysis/final `
  --bootstrap-samples 10000

python generate-research-report.py `
  --campaign results/campaigns/final-corrected `
  --analysis analysis/final `
  --forensic results/campaigns/forensic-80 `
  --out output/pdf/barc_multicast_adaptive_research_report.pdf

python verify-research-report.py `
  --pdf output/pdf/barc_multicast_adaptive_research_report.pdf `
  --out tmp/pdfs/barc-report-qa
```

## Main Concepts

- `advisor-exact-lossless`: offline lossless baseline using known topology and multicast load.
- `advisor-overdrive-a1.05`: sends at 105% of the advisor lossless rate.
- `selected-adaptive-oracle`: adaptive policy with idealized local telemetry and no feedback-message cost.
- `adaptive-feedback-d1/d4/d8`: realistic adaptive feedback variants with control messages sharing the same queues as data and repair.
- `drop-report`: small control packet sent by a switch after it drops data.
- `repair-to-switch`: unicast repair from source to the switch that dropped.
- `repair-subtree`: partial multicast repair from the dropping switch only to affected ports.

The key research criterion is completion first, then CCT/FCT and overhead.

## Notes For Future Work

Read `CONTEXT.md` before making major changes. It records current assumptions, corrected results, known limitations, the relation to the independent `XDP_REC_10` AF_XDP implementation, and recommended next steps.
