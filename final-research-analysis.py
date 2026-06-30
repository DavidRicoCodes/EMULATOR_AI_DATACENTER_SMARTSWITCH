#!/usr/bin/env python3
"""Phase-aware analysis for the canonical corrected BARC multicast campaign."""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from reportlab.graphics import renderSVG
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.linecharts import HorizontalLineChart
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors


PALETTE = {
    "advisor-exact-lossless": colors.HexColor("#24557A"),
    "per-source-lossless": colors.HexColor("#4F86A8"),
    "advisor-overdrive-a1.05": colors.HexColor("#D17A22"),
    "selected-adaptive-oracle": colors.HexColor("#7A5195"),
    "adaptive-feedback-d1": colors.HexColor("#2A9D8F"),
    "adaptive-feedback-d4": colors.HexColor("#55A868"),
    "adaptive-feedback-d8": colors.HexColor("#8AB17D"),
    "member-formula-rate": colors.HexColor("#777777"),
    "max-rate-recovery": colors.HexColor("#C44E52"),
    "no-recovery-max-rate": colors.HexColor("#222222"),
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", default="results/campaigns/final-corrected")
    parser.add_argument("--forensic", default="results/campaigns/forensic-80")
    parser.add_argument("--out", default="analysis/final")
    parser.add_argument("--bootstrap-samples", type=int, default=10000)
    return parser.parse_args()


def percentile(values, q):
    clean = [value for value in values if value is not None and math.isfinite(value)]
    return float(np.percentile(clean, q)) if clean else None


def run_complete(report):
    active = [item for item in report.get("collectives", []) if item.get("memberHosts")]
    return all(item.get("complete") for item in active)


def run_cct(report):
    values = [
        item.get("cctTicks") for item in report.get("collectives", [])
        if item.get("memberHosts") and item.get("complete")
    ]
    return max(values) if values else None


def policy_family(policy):
    if policy == "advisor-exact-lossless":
        return "exact-lossless"
    if policy == "per-source-lossless":
        return "per-source-lossless"
    if policy == "advisor-overdrive-a1.05":
        return "fixed-overdrive-1.05"
    if policy == "selected-adaptive-oracle" or policy.startswith("adaptive-lhs-"):
        return "adaptive-oracle"
    if policy.startswith("adaptive-feedback-"):
        return policy
    return policy


def parse_profile(profile):
    values = [int(value) for value in str(profile).split("-") if value]
    return {
        "members": sum(values),
        "collectives": len(values),
        "max_group": max(values),
        "min_group": min(values),
        "heterogeneity": (max(values) - min(values)) / max(values) if max(values) else 0,
    }


def report_row(report):
    experiment = report["experiment"]
    summary = report["summary"]
    fcts = []
    for host in report.get("hostStats", []):
        for item in host.get("breakdown", []):
            if item.get("complete") and item.get("fctTicks") is not None:
                fcts.append(item["fctTicks"])
    profile = parse_profile(experiment["profile"])
    original_blocks = max(1, summary.get("totalDataBlocks", 0))
    return {
        "scenarioName": report["scenarioName"],
        "pairedScenarioId": experiment["pairedScenarioId"],
        "phase": experiment["phase"],
        "policy": experiment["policy"],
        "policyFamily": policy_family(experiment["policy"]),
        "placement": experiment["placement"],
        "profile": experiment["profile"],
        "payloadBlocks": experiment["payloadBlocks"],
        "capacity": experiment["capacity"],
        "bufferLimit": experiment["bufferLimit"],
        "capacityBufferRatio": experiment["capacity"] / experiment["bufferLimit"],
        "seed": experiment["seed"],
        "complete": run_complete(report),
        "timeout": bool(summary.get("activeAtEnd")),
        "timeoutReason": summary.get("timeoutReason") or (
            "active-at-end" if summary.get("activeAtEnd") else ""
        ),
        "cct": run_cct(report),
        "fctP50": percentile(fcts, 50),
        "fctP95": percentile(fcts, 95),
        "fctP99": percentile(fcts, 99),
        "originalTxCompleteTick": summary.get("originalTxCompleteTick"),
        "postTxTailTicks": summary.get("postTxCompletionTailTicks"),
        "recoveryTailTicks": summary.get("recoveryTailTicks"),
        "drops": summary.get("totalDrops", 0),
        "repairs": summary.get("totalRepairsInjected", 0),
        "dropReports": summary.get("totalControlReports", 0),
        "dropReportRetransmissions": summary.get("retransmittedDropReports", 0),
        "dataBlocks": summary.get("totalDataBlocks", 0),
        "repairBlocks": summary.get("totalRepairBlocks", 0),
        "recoveryControlBlocks": summary.get("totalControlBlocks", 0),
        "adaptiveControlBlocks": summary.get("totalAdaptiveControlBlocks", 0),
        "dropsPerOriginalBlock": summary.get("totalDrops", 0) / original_blocks,
        "repairsPerOriginalBlock": summary.get("totalRepairsInjected", 0) / original_blocks,
        "hotTicks": sum(item.get("hotTicks", 0) for item in report.get("hotLinks", {}).values()),
        "maxUtilizationPct": max(
            [item.get("maxPct", 0) for item in report.get("hotLinks", {}).values()] or [0]
        ),
        "profileMembers": profile["members"],
        "collectiveCount": profile["collectives"],
        "profileHeterogeneity": profile["heterogeneity"],
        "dropsByLayer": report.get("dropsByLayer", {}),
        "dropsByInterface": report.get("dropsByInterface", {}),
    }


def read_reports(path):
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                report = json.loads(line)
                policy = report["experiment"]["policy"]
                adaptive = (
                    policy == "adaptive-advisor-overdrive"
                    or policy == "selected-adaptive-oracle"
                    or policy.startswith("adaptive-lhs-")
                    or policy.startswith("adaptive-feedback-")
                )
                if adaptive and report["config"].get("losslessAdmissionControl"):
                    raise RuntimeError(
                        f"Adaptive report retained lossless admission: {report['scenarioName']}"
                    )
                if policy in {"advisor-exact-lossless", "per-source-lossless"}:
                    if not report["config"].get("losslessAdmissionControl"):
                        raise RuntimeError(
                            f"Lossless baseline lacks admission control: {report['scenarioName']}"
                        )
                    if report["summary"].get("totalDrops", 0) != 0:
                        raise RuntimeError(
                            f"Lossless baseline dropped packets: {report['scenarioName']}"
                        )
                rows.append(report_row(report))
    return rows


def paired_rows(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[row["pairedScenarioId"]].append(row)
    output = []
    for paired_id, items in groups.items():
        baseline = next(
            (item for item in items if item["policy"] == "advisor-exact-lossless"), None
        )
        if not baseline or not baseline["complete"]:
            continue
        for item in items:
            if item is baseline:
                continue
            pair = dict(item)
            pair["baselineCct"] = baseline["cct"]
            pair["baselineFctP99"] = baseline["fctP99"]
            pair["deltaCct"] = item["cct"] - baseline["cct"] if item["complete"] else None
            pair["relativeDelta"] = (
                pair["deltaCct"] / baseline["cct"] if pair["deltaCct"] is not None else None
            )
            pair["p99Regression"] = (
                (item["fctP99"] - baseline["fctP99"]) / baseline["fctP99"]
                if item["fctP99"] is not None and baseline["fctP99"] else None
            )
            output.append(pair)
    return output


def wilson(successes, total, z=1.96):
    if not total:
        return None, None
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator
    return max(0, center - margin), min(1, center + margin)


def bootstrap_interval(values, statistic, samples, seed):
    data = np.asarray([value for value in values if value is not None], dtype=float)
    if not len(data):
        return None, None
    rng = np.random.default_rng(seed)
    estimates = np.empty(samples)
    chunk = 500
    cursor = 0
    while cursor < samples:
        count = min(chunk, samples - cursor)
        indices = rng.integers(0, len(data), size=(count, len(data)))
        sampled = data[indices]
        estimates[cursor:cursor + count] = (
            sampled.mean(axis=1) if statistic == "mean" else np.median(sampled, axis=1)
        )
        cursor += count
    return tuple(float(value) for value in np.percentile(estimates, [2.5, 97.5]))


def summarize_group(items, bootstrap_samples, seed):
    complete = [item for item in items if item["complete"] and item["deltaCct"] is not None]
    incomplete = [item for item in items if not item["complete"]]
    deltas = [item["deltaCct"] for item in complete]
    relatives = [item["relativeDelta"] for item in complete]
    wins = sum(value < 0 for value in deltas)
    ties = sum(value == 0 for value in deltas)
    losses = sum(value > 0 for value in deltas)
    wilson_low, wilson_high = wilson(wins, len(complete))
    mean_low, mean_high = bootstrap_interval(deltas, "mean", bootstrap_samples, seed)
    median_low, median_high = bootstrap_interval(deltas, "median", bootstrap_samples, seed + 1)
    median_relative = float(np.median(relatives)) if relatives else None
    p99_regressions = [
        item["p99Regression"] for item in complete if item["p99Regression"] is not None
    ]
    p99_ok = not p99_regressions or float(np.percentile(p99_regressions, 99)) <= 0.10
    relevant = (
        len(complete) == len(items)
        and bool(complete)
        and median_relative <= -0.05
        and median_high is not None
        and median_high < 0
        and p99_ok
    )
    return {
        "runs": len(items),
        "completeRuns": len(complete),
        "incompleteRuns": len(incomplete),
        "completionRate": len(complete) / len(items) if items else None,
        "timeoutRuns": sum(item.get("timeout") for item in items),
        "wins": wins,
        "ties": ties,
        "losses": losses,
        "dominatedLosses": losses + len(incomplete),
        "dominatedWinRate": wins / len(items) if items else None,
        "winRate": wins / len(complete) if complete else None,
        "wilsonLow": wilson_low,
        "wilsonHigh": wilson_high,
        "meanDeltaCct": float(np.mean(deltas)) if deltas else None,
        "medianDeltaCct": float(np.median(deltas)) if deltas else None,
        "medianRelativeDelta": median_relative,
        "meanBootstrapLow": mean_low,
        "meanBootstrapHigh": mean_high,
        "medianBootstrapLow": median_low,
        "medianBootstrapHigh": median_high,
        "p99WithinTenPercent": p99_ok,
        "practicallyRelevant": relevant,
    }


def summarize_pairs(pairs, bootstrap_samples):
    dimensions = [
        "phase", "placement", "profile", "payloadBlocks", "capacity", "bufferLimit",
        "collectiveCount", "profileHeterogeneity",
    ]
    summaries = []
    primary = [item for item in pairs if item["phase"] in {"C", "D", "E"}]
    groups = defaultdict(list)
    for item in primary:
        groups[("phase-policy", item["phase"], item["policy"])].append(item)
        for dimension in dimensions[1:]:
            groups[(dimension, str(item[dimension]), item["policy"])].append(item)
    for index, (key, items) in enumerate(sorted(groups.items(), key=lambda value: str(value[0]))):
        summary = summarize_group(items, bootstrap_samples, 20260618 + index * 2)
        summary.update({"dimension": key[0], "stratum": key[1], "policy": key[2]})
        summaries.append(summary)
    return summaries


def phase_policy_status(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row["phase"], row["policy"])].append(row)
    output = []
    for (phase, policy), items in sorted(groups.items()):
        timeout_reasons = Counter(item["timeoutReason"] for item in items if item["timeoutReason"])
        completed = [item for item in items if item["complete"]]
        output.append({
            "phase": phase,
            "policy": policy,
            "runs": len(items),
            "completeRuns": len(completed),
            "incompleteRuns": len(items) - len(completed),
            "completionRate": len(completed) / len(items) if items else None,
            "timeoutRuns": sum(item["timeout"] for item in items),
            "timeoutReasons": "|".join(f"{key}:{value}" for key, value in sorted(timeout_reasons.items())),
            "meanCctCompleted": float(np.mean([item["cct"] for item in completed])) if completed else None,
            "medianCctCompleted": float(np.median([item["cct"] for item in completed])) if completed else None,
            "fctP99Completed": percentile([item["fctP99"] for item in completed], 99),
        })
    return output


def timeout_breakdown(rows):
    groups = defaultdict(list)
    for row in rows:
        if row["timeout"] or not row["complete"]:
            groups[(
                row["phase"], row["policy"], row["profile"], row["capacity"],
                row["bufferLimit"], row["timeoutReason"] or "incomplete"
            )].append(row)
    output = []
    for key, items in sorted(groups.items(), key=lambda item: (-len(item[1]), str(item[0]))):
        phase, policy, profile, capacity, buffer, reason = key
        output.append({
            "phase": phase,
            "policy": policy,
            "profile": profile,
            "capacity": capacity,
            "bufferLimit": buffer,
            "reason": reason,
            "runs": len(items),
            "scenarioNames": "|".join(item["scenarioName"] for item in items[:8]),
        })
    return output


def gini(labels):
    if not labels:
        return 0
    counts = Counter(labels)
    return 1 - sum((count / len(labels)) ** 2 for count in counts.values())


def train_tree(rows, features, depth=0, max_depth=3, min_leaf=8):
    labels = [row["label"] for row in rows]
    majority = Counter(labels).most_common(1)[0][0]
    node = {"prediction": majority, "samples": len(rows), "distribution": dict(Counter(labels))}
    if depth >= max_depth or len(set(labels)) == 1 or len(rows) < min_leaf * 2:
        return node
    best = None
    for feature in features:
        values = sorted(set(row[feature] for row in rows))
        thresholds = [(left + right) / 2 for left, right in zip(values, values[1:])]
        for threshold in thresholds:
            left = [row for row in rows if row[feature] <= threshold]
            right = [row for row in rows if row[feature] > threshold]
            if len(left) < min_leaf or len(right) < min_leaf:
                continue
            score = (len(left) * gini([r["label"] for r in left])
                     + len(right) * gini([r["label"] for r in right])) / len(rows)
            candidate = (score, feature, threshold, left, right)
            if best is None or candidate[:3] < best[:3]:
                best = candidate
    if best is None:
        return node
    _, feature, threshold, left, right = best
    node.update({
        "feature": feature,
        "threshold": threshold,
        "left": train_tree(left, features, depth + 1, max_depth, min_leaf),
        "right": train_tree(right, features, depth + 1, max_depth, min_leaf),
    })
    return node


def predict_tree(node, row):
    while "feature" in node:
        node = node["left"] if row[node["feature"]] <= node["threshold"] else node["right"]
    return node["prediction"]


def policy_model(rows):
    groups = defaultdict(list)
    for row in rows:
        if row["phase"] == "E" and row["policy"] in {
            "advisor-exact-lossless", "advisor-overdrive-a1.05",
            "adaptive-feedback-d1", "adaptive-feedback-d4", "adaptive-feedback-d8",
        }:
            groups[row["pairedScenarioId"]].append(row)
    examples = []
    for items in groups.values():
        by_family = {}
        for item in items:
            family = "feedback" if item["policy"].startswith("adaptive-feedback") else (
                "fixed" if item["policy"] == "advisor-overdrive-a1.05" else "lossless"
            )
            if item["complete"] and (family not in by_family or item["cct"] < by_family[family]["cct"]):
                by_family[family] = item
        if set(by_family) != {"lossless", "fixed", "feedback"}:
            continue
        best = min(by_family, key=lambda family: by_family[family]["cct"])
        base = items[0]
        examples.append({
            "seed": base["seed"],
            "capacity": base["capacity"],
            "bufferLimit": base["bufferLimit"],
            "capacityBufferRatio": base["capacityBufferRatio"],
            "profileMembers": base["profileMembers"],
            "collectiveCount": base["collectiveCount"],
            "profileHeterogeneity": base["profileHeterogeneity"],
            "label": best,
            "costs": {family: item["cct"] for family, item in by_family.items()},
        })
    features = [
        "capacity", "bufferLimit", "capacityBufferRatio", "profileMembers",
        "collectiveCount", "profileHeterogeneity",
    ]
    predictions = []
    seeds = sorted(set(item["seed"] for item in examples))
    for seed in seeds:
        train = [item for item in examples if item["seed"] != seed]
        test = [item for item in examples if item["seed"] == seed]
        if not train or not test:
            continue
        tree = train_tree(train, features)
        for item in test:
            predicted = predict_tree(tree, item)
            predictions.append({
                "seed": seed,
                "actual": item["label"],
                "predicted": predicted,
                "correct": predicted == item["label"],
                "regretTicks": item["costs"][predicted] - min(item["costs"].values()),
            })
    final_tree = train_tree(examples, features) if examples else {}
    return {
        "examples": len(examples),
        "crossValidatedPredictions": predictions,
        "accuracy": (
            sum(item["correct"] for item in predictions) / len(predictions) if predictions else None
        ),
        "meanRegretTicks": (
            float(np.mean([item["regretTicks"] for item in predictions])) if predictions else None
        ),
        "medianRegretTicks": (
            float(np.median([item["regretTicks"] for item in predictions])) if predictions else None
        ),
        "tree": final_tree,
    }


def lexicographic_policy_ranking(rows):
    status = phase_policy_status([row for row in rows if row["phase"] in {"C", "D", "E"}])
    return sorted(status, key=lambda row: (
        row["phase"],
        -row["completionRate"],
        row["medianCctCompleted"] if row["medianCctCompleted"] is not None else math.inf,
        row["fctP99Completed"] if row["fctP99Completed"] is not None else math.inf,
        row["policy"],
    ))


def write_csv(path, rows):
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    columns = []
    for row in rows:
        for key in row:
            if key not in columns and not isinstance(row[key], (dict, list)):
                columns.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def save_bar_chart(path, title, labels, values, chart_colors):
    drawing = Drawing(720, 360)
    drawing.add(String(20, 334, title, fontName="Helvetica-Bold", fontSize=15))
    chart = VerticalBarChart()
    chart.x = 60
    chart.y = 55
    chart.height = 245
    chart.width = 620
    chart.data = [values]
    chart.categoryAxis.categoryNames = labels
    chart.categoryAxis.labels.angle = 30
    chart.categoryAxis.labels.fontSize = 7
    chart.valueAxis.valueMin = min(0, min(values or [0]))
    chart.valueAxis.valueMax = max(values or [1]) * 1.15 if max(values or [1]) > 0 else 1
    chart.bars[0].fillColor = chart_colors[0] if chart_colors else colors.HexColor("#24557A")
    drawing.add(chart)
    renderSVG.drawToFile(drawing, str(path))


def save_line_chart(path, title, series, labels):
    drawing = Drawing(720, 360)
    drawing.add(String(20, 334, title, fontName="Helvetica-Bold", fontSize=15))
    chart = HorizontalLineChart()
    chart.x = 60
    chart.y = 55
    chart.height = 245
    chart.width = 620
    chart.data = series
    chart.categoryAxis.categoryNames = labels
    chart.categoryAxis.labels.fontSize = 8
    for index in range(len(series)):
        chart.lines[index].strokeColor = list(PALETTE.values())[index % len(PALETTE)]
        chart.lines[index].strokeWidth = 2
    drawing.add(chart)
    renderSVG.drawToFile(drawing, str(path))


def generate_figures(figures_dir, summaries, pairs, rows):
    phase_c = [
        item for item in summaries
        if item["dimension"] == "phase-policy" and item["stratum"] == "C"
    ]
    phase_c.sort(key=lambda item: item["medianRelativeDelta"] if item["medianRelativeDelta"] is not None else 99)
    save_bar_chart(
        figures_dir / "held_out_median_delta.svg",
        "Held-out phase C: median relative CCT delta vs exact lossless",
        [policy_family(item["policy"]) for item in phase_c],
        [100 * (item["medianRelativeDelta"] or 0) for item in phase_c],
        [PALETTE.get(item["policy"], colors.grey) for item in phase_c],
    )
    feedback = [
        item for item in summaries
        if item["dimension"] == "phase-policy" and item["stratum"] == "D"
        and item["policy"].startswith("adaptive-feedback")
    ]
    feedback.sort(key=lambda item: item["policy"])
    save_bar_chart(
        figures_dir / "feedback_delay_penalty.svg",
        "Realistic feedback: mean CCT delta vs exact lossless",
        [item["policy"].replace("adaptive-feedback-", "").upper() for item in feedback],
        [item["meanDeltaCct"] or 0 for item in feedback],
        [PALETTE.get(item["policy"], colors.grey) for item in feedback],
    )
    fixed_by_buffer = []
    for buffer_size in sorted(set(item["bufferLimit"] for item in pairs if item["phase"] == "C")):
        values = [
            item["relativeDelta"] for item in pairs
            if item["phase"] == "C" and item["policy"] == "advisor-overdrive-a1.05"
            and item["bufferLimit"] == buffer_size and item["relativeDelta"] is not None
        ]
        fixed_by_buffer.append(float(np.median(values)) * 100 if values else 0)
    save_line_chart(
        figures_dir / "fixed_overdrive_by_buffer.svg",
        "Fixed 1.05x overdrive sensitivity to buffer",
        [fixed_by_buffer],
        [str(value) for value in sorted(set(item["bufferLimit"] for item in pairs if item["phase"] == "C"))],
    )
    completion_by_phase = []
    labels = ["A", "B-training", "B-validation", "C", "D", "E"]
    for phase in labels:
        phase_rows = [item for item in rows if item["phase"] == phase]
        completion_by_phase.append(
            100 * sum(item["complete"] for item in phase_rows) / len(phase_rows) if phase_rows else 0
        )
    save_bar_chart(
        figures_dir / "completion_by_phase.svg",
        "Dataset completion rate by phase",
        labels,
        completion_by_phase,
        [colors.HexColor("#2A9D8F")],
    )


def main():
    args = parse_args()
    campaign = Path(args.campaign)
    out = Path(args.out)
    tables = out / "tables"
    figures = out / "figures"
    tables.mkdir(parents=True, exist_ok=True)
    figures.mkdir(parents=True, exist_ok=True)

    validation = json.loads((campaign / "validation.json").read_text(encoding="utf-8"))
    if not validation.get("valid"):
        raise RuntimeError("Canonical corrected campaign is not valid.")
    rows = read_reports(campaign / "reports.jsonl")
    if len(rows) != 13600:
        raise RuntimeError(f"Expected 13600 canonical reports, found {len(rows)}.")
    pairs = paired_rows(rows)
    summaries = summarize_pairs(pairs, args.bootstrap_samples)
    model = policy_model(rows)
    status_rows = phase_policy_status(rows)
    timeout_rows = timeout_breakdown(rows)
    lexicographic_ranking = lexicographic_policy_ranking(rows)

    write_csv(tables / "runs.csv", rows)
    write_csv(tables / "paired_comparisons.csv", pairs)
    write_csv(tables / "phase_policy_summary.csv", [
        item for item in summaries if item["dimension"] == "phase-policy"
    ])
    write_csv(tables / "stratified_summary.csv", summaries)
    write_csv(tables / "phase_policy_status.csv", status_rows)
    write_csv(tables / "timeout_breakdown.csv", timeout_rows)
    write_csv(tables / "lexicographic_policy_ranking.csv", lexicographic_ranking)
    write_csv(tables / "policy_model_predictions.csv", model["crossValidatedPredictions"])

    confirmatory = [
        item for item in summaries
        if item["dimension"] == "phase-policy" and item["stratum"] in {"C", "D", "E"}
    ]
    layer_drops = Counter()
    interface_drops = Counter()
    for row in rows:
        if row["phase"] not in {"C", "D", "E"}:
            continue
        layer_drops.update(row["dropsByLayer"])
        interface_drops.update(row["dropsByInterface"])
    statistics = {
        "schemaVersion": "barc-final-analysis-v1",
        "campaignReports": len(rows),
        "pairedComparisons": len(pairs),
        "phaseCounts": dict(Counter(row["phase"] for row in rows)),
        "completionByPhase": {
            phase: {
                "runs": len(items),
                "complete": sum(item["complete"] for item in items),
            }
            for phase, items in (
                (phase, [row for row in rows if row["phase"] == phase])
                for phase in sorted(set(row["phase"] for row in rows))
            )
        },
        "timeouts": {
            "total": sum(row["timeout"] for row in rows),
            "byPhasePolicyReason": timeout_rows,
        },
        "phasePolicyStatus": status_rows,
        "lexicographicPolicyRanking": lexicographic_ranking,
        "confirmatoryPolicySummaries": confirmatory,
        "topDropLayers": layer_drops.most_common(20),
        "topDropInterfaces": interface_drops.most_common(30),
        "policySelectionModel": model,
    }
    (out / "statistics.json").write_text(json.dumps(statistics, indent=2), encoding="utf-8")
    report_data = {
        "statistics": statistics,
        "selections": json.loads((campaign / "selections.json").read_text(encoding="utf-8")),
        "relevantStrata": [item for item in summaries if item["practicallyRelevant"]],
        "phasePolicySummaries": confirmatory,
        "phasePolicyStatus": status_rows,
        "timeoutBreakdown": timeout_rows,
        "lexicographicPolicyRanking": lexicographic_ranking,
        "modelTree": model["tree"],
    }
    (out / "report_data.json").write_text(json.dumps(report_data, indent=2), encoding="utf-8")
    generate_figures(figures, summaries, pairs, rows)
    print(f"Final research analysis written to {out.resolve()}")


if __name__ == "__main__":
    main()
