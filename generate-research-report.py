#!/usr/bin/env python3
"""Generate the final academic PDF from the canonical corrected campaign."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.linecharts import HorizontalLineChart
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, KeepTogether, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle
)
from reportlab.platypus.tableofcontents import TableOfContents


NAVY = colors.HexColor("#173F5F")
BLUE = colors.HexColor("#24557A")
ORANGE = colors.HexColor("#D17A22")
TEAL = colors.HexColor("#2A9D8F")
PURPLE = colors.HexColor("#7A5195")
LIGHT = colors.HexColor("#EEF3F6")
MID = colors.HexColor("#D6E0E7")
DARK = colors.HexColor("#263238")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", default="results/campaigns/final-corrected")
    parser.add_argument("--analysis", default="analysis/final")
    parser.add_argument("--forensic", default="results/campaigns/forensic-80")
    parser.add_argument("--out", default="output/pdf/barc_multicast_adaptive_research_report.pdf")
    parser.add_argument("--allow-incomplete", action="store_true")
    return parser.parse_args()


def fmt(value, digits=2, suffix=""):
    if value is None or not math.isfinite(float(value)):
        return "n/a"
    return f"{float(value):.{digits}f}{suffix}"


def pct(value, digits=1):
    return fmt(100 * value if value is not None else None, digits, "%")


def read_csv(path):
    if not path.exists() or not path.stat().st_size:
        return []
    with path.open("r", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def read_jsonl(path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def run_cct(report):
    values = [
        item["cctTicks"] for item in report.get("collectives", [])
        if item.get("memberHosts") and item.get("complete")
    ]
    return max(values) if values else None


class ResearchDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            19 * mm, 18 * mm, A4[0] - 38 * mm, A4[1] - 34 * mm,
            id="normal", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0
        )
        self.addPageTemplates(PageTemplate(id="academic", frames=frame, onPage=self.draw_page))

    def draw_page(self, canvas, doc):
        if doc.page == 1:
            return
        canvas.saveState()
        canvas.setStrokeColor(MID)
        canvas.line(19 * mm, 14 * mm, A4[0] - 19 * mm, 14 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#607D8B"))
        canvas.drawString(19 * mm, 9 * mm, "BARC Multicast Selective Recovery Research")
        canvas.drawRightString(A4[0] - 19 * mm, 9 * mm, str(doc.page))
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph):
            style = flowable.style.name
            if style == "H1":
                level = 0
                text = flowable.getPlainText()
                key = "section-" + re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
                self.canv.bookmarkPage(key)
                self.canv.addOutlineEntry(text, key, level=level, closed=False)
                self.notify("TOCEntry", (level, text, self.page, key))


def styles():
    base = getSampleStyleSheet()
    base.add(ParagraphStyle(
        "CoverTitle", parent=base["Title"], fontName="Helvetica-Bold",
        fontSize=28, leading=32, textColor=colors.white, alignment=TA_LEFT,
        spaceAfter=12
    ))
    base.add(ParagraphStyle(
        "CoverSub", parent=base["Normal"], fontName="Helvetica",
        fontSize=13, leading=18, textColor=colors.HexColor("#DDEAF2")
    ))
    base.add(ParagraphStyle(
        "H1", parent=base["Heading1"], fontName="Helvetica-Bold",
        fontSize=19, leading=23, textColor=NAVY, spaceBefore=5, spaceAfter=11,
        keepWithNext=True
    ))
    base.add(ParagraphStyle(
        "H2", parent=base["Heading2"], fontName="Helvetica-Bold",
        fontSize=13, leading=16, textColor=BLUE, spaceBefore=9, spaceAfter=6,
        keepWithNext=True
    ))
    base.add(ParagraphStyle(
        "Body", parent=base["BodyText"], fontName="Helvetica",
        fontSize=9.2, leading=13.2, textColor=DARK, alignment=TA_JUSTIFY,
        spaceAfter=7
    ))
    base.add(ParagraphStyle(
        "Small", parent=base["BodyText"], fontName="Helvetica",
        fontSize=7.6, leading=10.2, textColor=DARK, spaceAfter=4
    ))
    base.add(ParagraphStyle(
        "Callout", parent=base["BodyText"], fontName="Helvetica-Bold",
        fontSize=10, leading=14, textColor=NAVY, leftIndent=8, rightIndent=8,
        spaceBefore=6, spaceAfter=6
    ))
    base.add(ParagraphStyle(
        "Caption", parent=base["BodyText"], fontName="Helvetica-Oblique",
        fontSize=7.5, leading=10, textColor=colors.HexColor("#546E7A"),
        alignment=TA_CENTER, spaceBefore=3, spaceAfter=8
    ))
    base.add(ParagraphStyle(
        "TOCHeading", parent=base["Heading1"], fontName="Helvetica-Bold",
        fontSize=20, textColor=NAVY, spaceAfter=14
    ))
    return base


def p(text, style):
    return Paragraph(text, style)


def callout(text, style):
    table = Table([[Paragraph(text, style)]], colWidths=[169 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT),
        ("BOX", (0, 0), (-1, -1), 0.7, BLUE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def data_table(headers, rows, widths=None, font_size=7.2):
    body = [[Paragraph(f"<b>{header}</b>", STYLE["Small"]) for header in headers]]
    for row in rows:
        body.append([Paragraph(str(cell), STYLE["Small"]) for cell in row])
    table = Table(body, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.35, MID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FA")]),
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def bar_chart(title, labels, values, color=BLUE, y_min=None):
    drawing = Drawing(500, 235)
    drawing.add(String(5, 217, title, fontName="Helvetica-Bold", fontSize=11, fillColor=NAVY))
    chart = VerticalBarChart()
    chart.x = 52
    chart.y = 38
    chart.width = 425
    chart.height = 155
    chart.data = [values]
    chart.categoryAxis.categoryNames = labels
    chart.categoryAxis.labels.fontSize = 6.5
    chart.categoryAxis.labels.angle = 25
    chart.valueAxis.valueMin = min(0, min(values)) if y_min is None else y_min
    high = max(values) if values else 1
    chart.valueAxis.valueMax = high * 1.2 if high > 0 else 1
    chart.bars[0].fillColor = color
    drawing.add(chart)
    return drawing


def line_chart(title, labels, series, palette):
    drawing = Drawing(500, 235)
    drawing.add(String(5, 217, title, fontName="Helvetica-Bold", fontSize=11, fillColor=NAVY))
    chart = HorizontalLineChart()
    chart.x = 52
    chart.y = 38
    chart.width = 425
    chart.height = 155
    chart.data = series
    chart.categoryAxis.categoryNames = labels
    chart.categoryAxis.labels.fontSize = 7
    for index, color in enumerate(palette):
        chart.lines[index].strokeColor = color
        chart.lines[index].strokeWidth = 2
    drawing.add(chart)
    return drawing


def section(title, paragraphs, chart=None, table=None, callout_text=None, extra_break=False):
    story = [PageBreak(), p(title, STYLE["H1"])]
    if callout_text:
        story.extend([callout(callout_text, STYLE["Callout"]), Spacer(1, 5)])
    for paragraph in paragraphs:
        story.append(p(paragraph, STYLE["Body"]))
    if chart is not None:
        story.extend([Spacer(1, 5), chart])
    if table is not None:
        story.extend([Spacer(1, 6), table])
    if extra_break:
        story.append(PageBreak())
    return story


def summary_lookup(summaries, phase, policy):
    return next(
        (item for item in summaries if item["stratum"] == phase and item["policy"] == policy),
        None,
    )


def forensic_summary(forensic_dir):
    groups = defaultdict(list)
    path = forensic_dir / "reports.jsonl"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            report = json.loads(line)
            experiment = report.get("experiment", {})
            case_id = experiment.get("forensicCaseId")
            if not case_id:
                continue
            groups[case_id].append({
                "role": experiment.get("forensicRole"),
                "category": experiment.get("forensicCategory"),
                "policy": experiment.get("policy"),
                "profile": experiment.get("profile"),
                "capacity": experiment.get("capacity"),
                "buffer": experiment.get("bufferLimit"),
                "payload": experiment.get("payloadBlocks"),
                "cct": run_cct(report),
                "complete": all(
                    item.get("complete") for item in report.get("collectives", [])
                    if item.get("memberHosts")
                ),
                "timeoutReason": report.get("summary", {}).get("timeoutReason") or "",
                "drops": report.get("summary", {}).get("totalDrops", 0),
                "repairs": report.get("summary", {}).get("totalRepairsInjected", 0),
                "recoveryTail": report.get("summary", {}).get("recoveryTailTicks", 0),
                "telemetryTruncated": bool(report.get("summary", {}).get("telemetryTruncated")),
            })
    rows = []
    for case_id, items in sorted(groups.items()):
        focal = next((item for item in items if item.get("role") == "focal"), None)
        baseline = next((item for item in items if item.get("role") == "exact-lossless-baseline"), None)
        if not focal or not baseline:
            continue
        focal_cct = focal.get("cct")
        baseline_cct = baseline.get("cct")
        rows.append({
            "caseId": case_id,
            "category": focal.get("category"),
            "policy": focal.get("policy"),
            "profile": focal.get("profile"),
            "capacity": focal.get("capacity"),
            "buffer": focal.get("buffer"),
            "payload": focal.get("payload"),
            "complete": focal.get("complete"),
            "timeoutReason": focal.get("timeoutReason"),
            "deltaCct": (
                focal_cct - baseline_cct
                if focal_cct is not None and baseline_cct is not None
                else None
            ),
            "drops": focal.get("drops", 0),
            "repairs": focal.get("repairs", 0),
            "recoveryTail": focal.get("recoveryTail", 0),
            "telemetryTruncated": focal.get("telemetryTruncated", False),
        })
    return rows


def report_source(path, stats, summaries, forensic_rows):
    lines = [
        "# BARC Multicast Selective Recovery in Clos Fat-Tree Datacenters",
        "",
        "## Dataset",
        f"- Canonical reports: {stats['campaignReports']}",
        f"- Paired comparisons: {stats['pairedComparisons']}",
        "- Confirmatory phases: C, D, and E.",
        "- Exploratory and tuning phases: A and B.",
        "",
        "## Confirmatory summaries",
    ]
    for item in summaries:
        lines.append(
            f"- {item['stratum']} / {item['policy']}: completion "
            f"{item['completeRuns']}/{item['runs']}, median relative delta "
            f"{pct(item['medianRelativeDelta'])}."
        )
    lines.extend([
        "",
        "## Forensic cases",
        f"- Paired full-telemetry cases available: {len(forensic_rows)}.",
        "",
        "## References",
        "- IEEE 802.1-24-0014-00, Observations of a Layer 2 Clos Fat-tree, 14 March 2024.",
        "- Roger Marks, Collective Multicast in a Fat Tree, 9 February 2025.",
        "- Roger Marks, Data Center Collective Multicast using BARC-assigned Address Blocks, 13 March 2024.",
    ])
    path.write_text("\n".join(lines), encoding="utf-8")


def build_story(data, forensic_rows):
    stats = data["statistics"]
    summaries = data["phasePolicySummaries"]
    selections = data["selections"]
    timeout_breakdown = data.get("timeoutBreakdown", [])
    policy_status = data.get("phasePolicyStatus", [])
    story = []

    # Cover
    cover = Table([[
        Paragraph(
            "BARC Multicast Selective Recovery<br/>in Clos Fat-Tree Datacenters",
            STYLE["CoverTitle"],
        ),
    ], [
        Paragraph(
            "A reproducible simulation study of ideal lossless admission, controlled overdrive, "
            "selective repair, and in-band adaptive feedback for AI collective traffic",
            STYLE["CoverSub"],
        )
    ]], colWidths=[169 * mm], rowHeights=[85 * mm, 55 * mm])
    cover.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 16),
        ("RIGHTPADDING", (0, 0), (-1, -1), 16),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
    ]))
    story.extend([
        Spacer(1, 30 * mm), cover, Spacer(1, 18 * mm),
        p("Technical Research Report | June 2026", STYLE["H2"]),
        p("Canonical dataset: 13,600 paired campaign runs plus 80 directed full-telemetry reruns.",
          STYLE["Body"]),
        PageBreak(),
    ])

    # Abstract and executive summary
    story.extend([
        p("Abstract", STYLE["H1"]),
        p(
            "This report evaluates multicast collective communication over a fixed Layer-2 Clos "
            "fat-tree whose forwarding state is derived from the BARC address-block model. The "
            "control-plane registration process is assumed complete before tick zero; the study "
            "therefore isolates stateless forwarding, queue contention, packet loss, selective "
            "subtree repair, and rate control. The central question is whether deliberately "
            "operating slightly beyond an idealized lossless rate can reduce collective completion "
            "time while retaining complete delivery through switch-aware recovery.", STYLE["Body"]),
        p(
            "The campaign separates screening, parameter selection, held-out evaluation, realistic "
            "feedback, and long-payload robustness. All confirmatory comparisons are paired on "
            "topology, placement, seed, capacity, buffer, profile, and payload. Completion is treated "
            "as a hard constraint; CCT, tail FCT, recovery overhead, and hotspot persistence determine "
            "whether a faster policy is practically useful.", STYLE["Body"]),
        callout(
            f"The canonical analysis contains {stats['campaignReports']:,} reports and "
            f"{stats['pairedComparisons']:,} paired policy comparisons. Adaptive policies use normal "
            "lossy FIFO admission and selective recovery; exact and per-source lossless remain "
            "idealized offline baselines.", STYLE["Callout"]),
        PageBreak(),
        p("Executive Summary", STYLE["H1"]),
        p(
            "The study is designed to distinguish three effects that are often conflated: faster "
            "source injection, congestion-induced work, and the post-transmission recovery tail. "
            "Exact lossless admission removes drops but can leave capacity unused. Fixed 1.05x "
            "overdrive accepts a small amount of loss in exchange for shorter original transmission. "
            "Adaptive oracle varies the rate using immediate fabric visibility, while realistic D1, "
            "D4, and D8 policies pay for congestion reports and rate updates in the same FIFO as data "
            "and repair.", STYLE["Body"]),
        p(
            "Results are interpreted conservatively. A policy is called meaningfully better only if "
            "it completes every run in the stratum, improves median CCT by at least five percent, has "
            "a paired bootstrap interval wholly below zero, and avoids more than ten percent FCT p99 "
            "regression. This prevents a small mean improvement from hiding incomplete collectives or "
            "severe host-level tails.", STYLE["Body"]),
        PageBreak(),
        p("Contents", STYLE["TOCHeading"]),
        TableOfContents(),
    ])

    c = summary_lookup(summaries, "C", "advisor-overdrive-a1.05")
    oracle_c = summary_lookup(summaries, "C", "selected-adaptive-oracle")
    d1 = summary_lookup(summaries, "D", "adaptive-feedback-d1")
    d4 = summary_lookup(summaries, "D", "adaptive-feedback-d4")
    d8 = summary_lookup(summaries, "D", "adaptive-feedback-d8")

    def phase_results_table(phase):
        items = [item for item in summaries if item["stratum"] == phase]
        items.sort(key=lambda item: (
            -(item.get("completionRate") or 0),
            item["medianRelativeDelta"] if item["medianRelativeDelta"] is not None else 99,
            item["policy"],
        ))
        return data_table(
            ["Policy", "Complete", "Timeout", "W/T/L*", "Dom. win", "Median delta"],
            [[
                item["policy"],
                f"{item['completeRuns']}/{item['runs']}",
                item.get("timeoutRuns", 0),
                f"{item['wins']}/{item['ties']}/{item['dominatedLosses']}",
                pct(item.get("dominatedWinRate")),
                pct(item["medianRelativeDelta"]),
            ] for item in items],
            [48 * mm, 21 * mm, 15 * mm, 22 * mm, 21 * mm, 25 * mm],
        )

    timeout_table = data_table(
        ["Phase", "Policy", "Profile", "Cap.", "Buffer", "Reason", "Runs"],
        [[
            item["phase"], item["policy"], item["profile"], item["capacity"],
            item["bufferLimit"], item["reason"], item["runs"]
        ] for item in timeout_breakdown[:16]],
        [13 * mm, 43 * mm, 18 * mm, 12 * mm, 14 * mm, 42 * mm, 12 * mm],
        font_size=6.6,
    ) if timeout_breakdown else None

    relevant = data.get("relevantStrata", [])

    def relevant_results_table(dimensions):
        items = [item for item in relevant if item["dimension"] in dimensions][:24]
        return data_table(
            ["Dimension", "Stratum", "Policy", "Runs", "Median delta"],
            [[
                item["dimension"], item["stratum"], item["policy"], item["runs"],
                pct(item["medianRelativeDelta"])
            ] for item in items],
            [26 * mm, 30 * mm, 52 * mm, 18 * mm, 27 * mm],
        ) if items else None

    drop_layers = stats.get("topDropLayers", [])
    drop_table = data_table(
        ["Layer", "Drops"], [[item[0], item[1]] for item in drop_layers[:12]],
        [80 * mm, 35 * mm],
    ) if drop_layers else None

    phase_table = data_table(
        ["Phase", "Statistical role", "Runs"],
        [
            ["A", "Exploratory screening", stats["phaseCounts"].get("A", 0)],
            ["B-training", "Adaptive parameter search", stats["phaseCounts"].get("B-training", 0)],
            ["B-validation", "Adaptive model selection", stats["phaseCounts"].get("B-validation", 0)],
            ["C", "Primary held-out evaluation", stats["phaseCounts"].get("C", 0)],
            ["D", "Realistic feedback evaluation", stats["phaseCounts"].get("D", 0)],
            ["E", "Long-payload robustness", stats["phaseCounts"].get("E", 0)],
        ],
        [20 * mm, 100 * mm, 25 * mm],
    )

    sections = [
        ("1. Research Questions and Contributions", [
            "The primary research question is whether controlled loss plus selective repair can "
            "outperform ideal lossless admission for AI-oriented multicast collectives. Secondary "
            "questions examine fixed versus adaptive control, the cost of realistic signaling, "
            "heterogeneous groups, hotspot location, and whether scenario features can predict the "
            "best policy.",
            "The contribution is not a new BARC registration protocol. Instead, it is a research "
            "emulator and experimental methodology that treats BARC-derived addressing and forwarding "
            "as the substrate, then studies completion behavior under congestion and smart-switch "
            "recovery."
        ], None, None, "Completion is a hard feasibility constraint, not merely another metric."),
        ("2. BARC and Collective Multicast Context", [
            "P802.1CQ BARC assigns locally unique blocks of unicast and multicast addresses. The "
            "collective-multicast contributions describe how address-block structure can support "
            "stateless forwarding in a Layer-2 Clos fabric, including a collective anchor at the "
            "spine layer and replication toward member subtrees.",
            "This emulator assumes that address claiming, ABI allocation, collective anchor selection, "
            "registration, and initial forwarding state already exist before simulation. That boundary "
            "keeps the research focused on the data plane and recovery behavior most relevant to "
            "completion time."
        ], None, None, None),
        ("3. Emulator Architecture", [
            "The simulator is deterministic and tick driven. Hosts inject paced blocks into a fixed "
            "four-pod Clos topology. Every switch port has one FIFO shared by multicast data, unicast "
            "repair, partial-subtree repair, drop reports, congestion reports, and rate updates.",
            "Capacity and buffer occupancy are measured in blocks. Data and repair occupy one block; "
            "control packets occupy 0.05 blocks. Fractional source rates use deterministic pacing, "
            "allowing rates such as 0.714 blocks per tick without integer rounding."
        ], None, None, None),
        ("4. Assumptions and Scope", [
            "The model intentionally abstracts propagation delay, serialization below one block, "
            "switch pipeline stages, host DMA behavior, and interactions with unrelated tenants. "
            "These simplifications make policy mechanisms comparable, but absolute tick values should "
            "not be read as calibrated production latency.",
            "Lossless policies use idealized topology-aware admission and backpressure. Adaptive oracle "
            "uses immediate fabric state and therefore represents an upper bound. Only adaptive "
            "feedback pays network traffic, processing delay, congestion, and possible control loss."
        ], None, None, None),
        ("5. Smart Selective Recovery", [
            "When a switch cannot admit a multicast copy, it records the original packet, affected "
            "egress interface, drop tick, and repair attempt. The switch defers its compact report "
            "until the source has completed original transmission, then sends the report through the "
            "same network FIFO.",
            "The source retransmits the original block in unicast to the reporting switch. At that "
            "switch, the repair becomes partial multicast only over the previously failed ports. Host "
            "delivery is deduplicated by original packet identifier. A dropped repair creates a new "
            "obligation, preserving eventual completion within the configured timeout."
        ], None, None, "Repair targets the failed subtree; it never repeats the original full multicast."),
        ("6. Rate-Control Policies", [
            "Exact lossless uses the advisor's topology-aware uniform rate. Per-source lossless applies "
            "max-min progressive filling to individual sources. Fixed overdrive multiplies the exact "
            "rate by a selected alpha, with 1.05 emerging from screening.",
            "Adaptive oracle begins above the lossless rate and changes pace using queue and drop state. "
            "Adaptive feedback D1, D4, and D8 replaces free observation with congestion reports to the "
            "collective anchor and in-band rate updates to sources, adding one, four, or eight processing "
            "ticks respectively."
        ], None, None, None),
        ("7. Methodology and Switch Mechanics Primer", [
            "This primer makes explicit how the emulator turns a compact campaign manifest into paired "
            "experiments, and how a smart switch is modeled when it detects drops and requests selective "
            "repair. It is intentionally placed before the results so that completion, recovery tail, "
            "overdrive, and oracle behavior can be interpreted without treating the simulator as a black box.",
            "The physical fabric is fixed across the campaign: sixteen hosts are arranged as four pods, "
            "with two racks per pod and two hosts per rack. A seed never changes that physical topology. "
            "Instead, it makes random-balanced host assignment reproducible and chooses stratified capacity "
            "and buffer combinations in held-out phases."
        ], None, None, "Topology is fixed; seeds make placement and workload variation reproducible."),
        ("8. Scenario Generation, Seeds, and Profiles", [
            "A profile is the membership vector for active collectives. For example, [4] means one "
            "collective with four hosts, [4,4] means two simultaneous collectives of four hosts each, "
            "and [2,6,8] means three simultaneous collectives with unequal membership. The campaign "
            "covers one to four collectives, groups from two to sixteen hosts, payloads of 100, 1,000, "
            "and 10,000 blocks, capacities 5/10/20 blocks per tick, and buffers 8/16/32/64/128 blocks.",
            "For deterministic placements, host order is fixed by the placement rule: rack-compact fills "
            "nearby rack hosts first, pod-compact stays within pods, pod-spread distributes positions "
            "across pods, global-spread uses a hand-spread order, and adversarial-shared-uplink deliberately "
            "aligns hosts on shared bottlenecks. For random-balanced, the seed shuffles the sixteen host "
            "indices and the profile is then laid onto that shuffled list.",
            "Phase C contains 1,200 paired base scenarios: each pairedScenarioId fixes phase, placement, "
            "profile, seed, payload, capacity, and buffer. It has 6,960 reports because each paired base "
            "scenario is replayed under several policies. This is why the same topology/workload can "
            "support exact lossless, fixed overdrive, oracle, member-formula, max-rate, and no-recovery "
            "comparisons without changing the underlying experiment."
        ], None, None, None),
        ("9. Switch Drop State and Selective Recovery", [
            "When a switch drops a multicast copy, it immediately records a compact obligation: sourceHost, "
            "originalPacketId, droppedSwitchId, droppedPortKey, affectedHosts, attempt, and firstDropTick. "
            "The report key coalesces equivalent drops by source host, original packet, switch, affected "
            "port set, and attempt, so one drop-report represents a packet/subtree repair obligation rather "
            "than a separate control packet for every destination host.",
            "The modeled switch does not need to store the full packet payload for the mechanism. It stores "
            "identifiers, affected egress information, and attempt metadata. The emulator keeps additional "
            "ledgers for measurement, and it keeps original packet payload/state in the source-side packet "
            "store so the host can replay the block. In hardware, that source-side state would correspond "
            "to a replay buffer, not infinite switch memory.",
            "Reports are intentionally deferred. A switch may create the obligation at the drop tick, but it "
            "does not release the drop-report until sourceAvailableForRepair(sourceHost) is true: the source "
            "host has no original packets pending and is no longer active. If the normal FIFO cannot accept "
            "the small report packet, the obligation waits outside the queue and is retried later; reports "
            "do not evict data or use a priority queue.",
            "Once the source receives a drop-report, it schedules a repair-to-switch unicast carrying the "
            "original block toward the switch that dropped it. When that switch receives the repair, it "
            "emits repair-subtree packets only on the affected ports. Thus recovery retransmits exactly the "
            "missing subtree rather than repeating the original full multicast."
        ], None, None, "The switch reports a compact repair obligation; the source performs the replay."),
        ("10. Rate Advisor, Lossless Rate, and Fixed Overdrive", [
            "The advisor is an offline research component. It knows the host placement, collective "
            "membership, multicast forwarding state, capacity, and buffer. For each active source it traces "
            "the multicast tree and counts how many block copies each link would need to carry. The largest "
            "combined link load is the combinedMaxLoadFactor.",
            "The uniform lossless rate is approximately effectiveLosslessCapacity divided by "
            "combinedMaxLoadFactor, where effectiveLosslessCapacity is min(capacity, bufferLimit) in this "
            "model. Per-source lossless uses the same traced link loads but applies max-min progressive "
            "filling so sources that do not share the bottleneck can sometimes run faster.",
            "Fixed overdrive uses the exact same advisor lossless rate as its base. For advisor-overdrive-a1.05, "
            "the selected rate is min(capacity, losslessRate * 1.05). The alpha 1.05 is not 1.05 percent; "
            "it is 105 percent of the lossless rate, i.e., a five percent overdrive.",
            "In a real system, a single collective anchor or spine could compute this for a collective only "
            "if it knows that collective's membership and forwarding tree. If multiple roots or collectives "
            "share links, the safe combined rate requires some coordination or shared telemetry across the "
            "entities that own those collective trees."
        ], None, None, None),
        ("11. Adaptive Oracle and Tuning Procedure", [
            "The adaptive oracle is idealized in observability, not omniscience. It uses lossy FIFO admission "
            "and selective recovery, starts from a multiplier above the lossless base, observes drops and "
            "queue occupancy without signaling cost, decreases rate on congestion, and slowly increases "
            "rate after stable periods. It is therefore a reactive control rule with perfect local telemetry, "
            "not a globally optimal scheduler.",
            "The campaign builds twelve adaptive candidates using deterministic Latin hypercube sampling "
            "with seed 20260618. The dimensions are initialMultiplier 1.05-1.35, queueHighWatermark "
            "0.50-0.90, decreaseFactor 0.70-0.95, and increaseStep 0.01-0.05. These correspond to initial "
            "aggressiveness, queue sensitivity, strength of multiplicative backoff, and speed of additive "
            "rate recovery.",
            "B-training ranks the twelve candidates and keeps the top three; B-validation chooses the final "
            "bestAdaptiveOraclePolicy; phases C, D, and E then evaluate held-out behavior. An oracle can "
            "still lose to exact lossless because it may react after queues already form, reduce too hard, "
            "increase too slowly, create repair work that lossless avoids, or synchronize sources into "
            "bursty regimes where the saved original-transmission time is smaller than the recovery tail."
        ], None, None, None),
        ("12. Experimental Design", [
            "Scenarios vary group profile, number of simultaneous collectives, placement, capacity, "
            "buffer, payload, and random seed. Every policy applied to a base scenario shares the same "
            "pairedScenarioId, ensuring that CCT differences are caused by policy rather than workload "
            "or topology.",
            "Seeds 6-15 train adaptive parameters, 16-25 validate them, 26-55 form held-out evaluation, "
            "and 56-65 test long payloads. This partition prevents tuning from consuming the evidence "
            "later used for claims."
        ], None, phase_table, None),
        ("13. Dataset Integrity and Completion", [
            "The canonical dataset contains exactly one report per planned run. Adaptive policies use "
            "lossy FIFO admission with recovery; exact and per-source lossless retain admission control "
            "and must produce zero drops. Validation also checks seed separation, run uniqueness, "
            "explicit timeout state, and monotonic feedback-delay behavior.",
            "All confirmatory statistics are derived only from this canonical dataset. Aggregate campaign "
            "runs retain counters and completion state; selected forensic reruns retain the complete "
            "drop, repair, queue, utilization, and feedback histories.",
            f"The final corrected campaign contains {stats.get('timeouts', {}).get('total', 0)} explicit "
            "timeouts. These are counted as completion failures and dominated outcomes, not removed "
            "from policy ranking."
        ], bar_chart(
            "Completion rate by phase",
            list(stats["completionByPhase"].keys()),
            [100 * value["complete"] / value["runs"] for value in stats["completionByPhase"].values()],
            TEAL,
        ), timeout_table, None),
        ("14. Statistical Method", [
            "For each policy and stratum, the analysis reports paired CCT delta relative to exact "
            "lossless, win/tie/loss counts, Wilson 95 percent intervals for win rate, and deterministic "
            "10,000-sample paired bootstrap intervals for mean and median delta.",
            "Inference is clustered by paired scenario through the paired design. Confirmatory evidence "
            "comes from phases C, D, and E. A/B results explain policy selection but are not presented "
            "as independent confirmation."
        ], None, None, None),
        ("15. Screening Results", [
            f"Phase A selected <b>{selections.get('bestFixedAlphaPolicy', 'n/a')}</b> as the fixed "
            "overdrive carried into validation. Screening is useful for eliminating aggressive alpha "
            "values whose repair tails dominate their injection advantage.",
            "The fixed-alpha pattern is expected to be non-monotonic: a small overdrive can exploit "
            "otherwise idle service opportunities, while large alpha values create repeated drops, "
            "control traffic, and long recovery tails."
        ], None, None, None),
        ("16. Adaptive Tuning", [
            f"Latin-hypercube training retained {', '.join(selections.get('topAdaptiveTrainingPolicies', []))}. "
            f"Validation selected <b>{selections.get('bestAdaptiveOraclePolicy', 'n/a')}</b> as the "
            "oracle configuration for held-out evaluation.",
            "Selection ranks completion before paired CCT. Thus a fast but incomplete configuration "
            "cannot survive into phase C. The tuning dimensions are initial multiplier, queue high "
            "watermark, multiplicative decrease factor, and additive increase step."
        ], None, None, None),
        ("17. Held-Out Fixed Overdrive", [
            "Phase C is the primary test of whether 1.05x fixed overdrive generalizes beyond screening. "
            f"It completes {c['completeRuns'] if c else 'n/a'} of {c['runs'] if c else 'n/a'} paired "
            f"runs, with median relative CCT delta {pct(c['medianRelativeDelta']) if c else 'n/a'} and "
            f"win rate {pct(c['winRate']) if c else 'n/a'}.",
            "A negative median delta means that the shorter original transmission interval outweighs "
            "the repair tail in the typical held-out scenario. Positive tails identify buffer and "
            "placement regimes where even 1.05x crosses a sharp congestion boundary."
        ], bar_chart(
            "Phase C median relative CCT delta (%)",
            ["fixed 1.05x", "adaptive oracle"],
            [
                100 * (c["medianRelativeDelta"] if c and c["medianRelativeDelta"] is not None else 0),
                100 * (oracle_c["medianRelativeDelta"] if oracle_c and oracle_c["medianRelativeDelta"] is not None else 0),
            ],
            ORANGE,
        ), phase_results_table("C"), None),
        ("18. Adaptive Oracle Results", [
            f"The held-out oracle completes {oracle_c['completeRuns'] if oracle_c else 'n/a'} of "
            f"{oracle_c['runs'] if oracle_c else 'n/a'} runs. Its median relative delta is "
            f"{pct(oracle_c['medianRelativeDelta']) if oracle_c else 'n/a'}, with a win rate of "
            f"{pct(oracle_c['winRate']) if oracle_c else 'n/a'}.",
            "Oracle performance is an architectural ceiling rather than a deployable result. The gap "
            "between oracle and realistic feedback estimates how much value is consumed by sensing "
            "latency, in-band control traffic, and delayed source response."
        ], None, phase_results_table("C"), None),
        ("19. Realistic Feedback D1, D4, and D8", [
            f"The selected realistic policy is <b>{selections.get('bestAdaptiveFeedbackPolicy', 'n/a')}</b>. "
            "All feedback packets share the normal FIFO and consume 0.05 blocks. Threshold crossings are "
            "coalesced at the congested port, reports travel to the collective anchor, and rate updates "
            "return to active sources.",
            "D1, D4, and D8 isolate processing delay while holding the control mechanism constant. "
            "Increasing delay should never lead to an earlier applied update; any performance reversal "
            "must therefore arise from traffic dynamics rather than timestamp inconsistency."
        ], bar_chart(
            "Phase D mean CCT delta vs exact lossless (ticks)",
            ["D1", "D4", "D8"],
            [
                d1["meanDeltaCct"] if d1 and d1["meanDeltaCct"] is not None else 0,
                d4["meanDeltaCct"] if d4 and d4["meanDeltaCct"] is not None else 0,
                d8["meanDeltaCct"] if d8 and d8["meanDeltaCct"] is not None else 0,
            ],
            TEAL,
        ), phase_results_table("D"), None),
        ("20. Payload-10,000 Robustness", [
            "Phase E tests whether policy conclusions persist when startup transients become small "
            "relative to the payload and recovery obligations have more time to accumulate. Exact "
            "lossless, per-source lossless, fixed overdrive, and the selected realistic feedback policy "
            "are compared on fresh seeds.",
            "Long payloads are especially informative for adaptive control: a delayed response can still "
            "pay off if the remaining transfer is large, whereas a fixed overdrive may repeatedly revisit "
            "the same congested regime.",
            "The 14 wall-clock timeouts in phase E are interpreted as evidence that the selected "
            "realistic feedback mechanism can enter excessive recovery/control work in long-payload "
            "stress cases."
        ], None, phase_results_table("E"), None),
        ("21. Placement Effects", [
            "Rack-compact and pod-compact groups concentrate replication locally, while global-spread "
            "placements consume more upper-layer links. Adversarial shared-uplink placement deliberately "
            "aligns sources on common bottlenecks.",
            "The paired design permits each policy to be evaluated under identical placement. Winning "
            "strata reveal whether overdrive benefits depend on unused path diversity or remain robust "
            "when replication converges on a small set of interfaces."
        ], None, relevant_results_table({"placement"}), None),
        ("22. Group Profile and Heterogeneity", [
            "Equal profiles isolate collective size and concurrency. Heterogeneous profiles such as "
            "[2,6,8] and [2,4,10] create unequal source pressure and motivate per-source max-min rates.",
            "A uniform lossless rate is constrained by the worst shared link. Per-source allocation can "
            "raise rates for sources whose paths do not traverse that link, but only if the topology "
            "provides genuinely separable bottlenecks."
        ], None, relevant_results_table({"profile", "collectiveCount", "profileHeterogeneity"}), None),
        ("23. Capacity and Buffer Regimes", [
            "Capacity changes service rate; buffer changes how long transient bursts can be absorbed "
            "before loss. Their ratio is therefore a useful scenario feature, but it does not fully "
            "capture multicast fanout because one admitted source block can create several downstream "
            "copies.",
            "Small buffers expose burst synchronization and make feedback timeliness critical. Large "
            "buffers reduce drops but may convert loss into queueing delay, which can still harm tail "
            "completion."
        ], None, relevant_results_table({"capacity", "bufferLimit", "payloadBlocks"}), None),
        ("24. Completion-Time Decomposition", [
            "CCT is decomposed into original source transmission and the post-transmission tail. For "
            "lossless policies the tail is primarily propagation and queue drain. For lossy policies it "
            "also includes deferred reports, source-to-switch repair, partial-subtree delivery, and "
            "possible report retransmission.",
            "A non-lossless policy wins only when its reduction in original transmission exceeds all "
            "additional queueing and recovery work. This decomposition is the clearest causal test of "
            "why a policy wins rather than merely whether it wins."
        ], None, None, None),
        ("25. Recovery and Control Overhead", [
            "Drops per original block and repairs per original block measure data-plane amplification. "
            "Recovery-control blocks quantify switch reports; adaptive-control blocks quantify congestion "
            "reports and rate updates. These classes share the same FIFO, so their effect is visible in "
            "both bandwidth and queue residence.",
            "Efficient recovery should show high delivery completion with a small partial-subtree repair "
            "footprint. Repeated repair drops or report retransmissions indicate that the fabric remains "
            "overdriven after original transmission ends."
        ], None, drop_table, None),
        ("26. Hotspots and Congestion Layers", [
            "The emulator records drops by switch layer and interface, hot ticks per link, and maximum "
            "observed utilization. Concentration at host-facing rack ports has different implications "
            "from repeated congestion at fabric-to-spine or spine-to-fabric links.",
            "A deployable smart-switch mechanism should place detection where congestion first becomes "
            "actionable. The forensic timelines identify hotspot onset, report creation, rate update, "
            "queue drain, and final repair completion."
        ], None, None, None),
        ("27. Forensic Paired Case Studies", [
            f"The forensic dataset contains {len(forensic_rows)} complete paired cases. Forty focal "
            "scenarios cover wins, regressions, near ties, extreme recovery tails, per-source divergence, "
            "and no-recovery controls; every focal run is matched to its exact-lossless baseline.",
            "These runs retain every drop and repair, queue and utilization timelines, feedback messages, "
            "rate updates, per-interface traffic, recovery chains, and partial-subtree destinations. "
            "They are used for mechanistic interpretation, not population-level inference."
        ], None, data_table(
            ["Case", "Category", "Policy", "Profile", "CCT delta", "Drops", "Tail"],
            [[
                item["caseId"], item["category"], item["policy"], item["profile"],
                fmt(item["deltaCct"], 1), item["drops"], item["recoveryTail"]
            ] for item in forensic_rows[:16]],
            [15 * mm, 36 * mm, 38 * mm, 19 * mm, 18 * mm, 15 * mm, 15 * mm],
        ) if forensic_rows else None, None),
        ("28. Predictive Policy Selection", [
            f"An interpretable depth-three decision tree is evaluated by leaving each phase-E seed out "
            f"in turn. Cross-validated accuracy is {pct(stats['policySelectionModel']['accuracy'])}; "
            f"mean regret is {fmt(stats['policySelectionModel']['meanRegretTicks'])} ticks.",
            "Inputs are scenario features available before transmission: capacity, buffer, their ratio, "
            "total members, collective count, and profile heterogeneity. Regret is more informative than "
            "classification accuracy because choosing the second-best policy may be nearly free in one "
            "scenario and disastrous in another."
        ], None, None, None),
        ("29. Practical Smart-Switch Recommendations", [
            "Use exact lossless admission as the conservative default and as a calibration oracle. "
            "Enable mild overdrive only in strata where paired evidence shows that recovery remains "
            "bounded and host tail regression is acceptable.",
            "Keep switch drop state compact and indexed by original packet and failed egress subtree. "
            "Coalesce reports, defer them until source transmission completes, and retransmit with bounded "
            "backoff. For adaptive control, prefer the lowest feedback delay supported by the pipeline and "
            "measure control traffic in the same queue as data."
        ], None, None, "The research target is not TCP in the fabric; it is multicast-aware, subtree-specific recovery."),
        ("30. Limitations and Threats to Validity", [
            "The topology is fixed and small, traffic is synchronized at tick zero, and the workload "
            "contains only the modeled collectives. The advisor has exact topology knowledge. Switch and "
            "host processing costs are simplified, packet sizes are normalized, and failures other than "
            "congestion loss are absent.",
            "The oracle is intentionally unrealistic. Exact lossless admission also represents an ideal "
            "baseline rather than a complete deployed protocol. Statistical intervals quantify variation "
            "within the campaign design, not uncertainty over all possible datacenter fabrics."
        ], None, None, None),
        ("31. Conclusions", [
            "The emulator now supports a disciplined comparison between zero-loss pacing and controlled "
            "loss with smart selective recovery. The campaign design prevents incomplete runs from "
            "appearing attractive and separates policy tuning from held-out evidence.",
            "The most important next step is topology scaling: repeat the same paired methodology on "
            "larger k-ary Clos instances, calibrated link and pipeline delays, and overlapping compute "
            "arrival times. A second direction is to replace the centralized collective-anchor update "
            "with bounded local coordination while preserving subtree-specific repair."
        ], None, None, None),
    ]

    for title, paragraphs, chart, table, callout_text in sections:
        story.extend(section(title, paragraphs, chart, table, callout_text))

    # Appendices deliberately separated for readable schemas and reproducibility.
    appendices = [
        ("Appendix A. Campaign Parameters", [
            "Profiles include equal and heterogeneous groups from two to sixteen hosts, one to four "
            "simultaneous collectives, capacities 5/10/20 blocks per tick, buffers 8/16/32/64/128 blocks, "
            "and payloads 100/1,000/10,000 blocks.",
            "Random-balanced placements use deterministic seeds. Deterministic placements include "
            "rack-compact, pod-compact, pod-spread, global-spread, and adversarial shared uplink."
        ]),
        ("Appendix B. Packet and Queue Semantics", [
            "Data multicast, source-to-switch repair, and repair-subtree packets occupy one block. Drop "
            "reports, congestion reports, and rate updates occupy 0.05 blocks. Every egress port exposes "
            "one FIFO and one block-counted buffer.",
            "Control packets never evict queued data. If a report cannot fit, its obligation remains "
            "pending outside the FIFO and is retried in a later tick."
        ]),
        ("Appendix C. Dataset Schema", [
            "reports.jsonl stores compact run summaries, collective completion, host FCT breakdown, "
            "interface counters, hotspot summaries, advisor outputs, and experiment metadata. Full "
            "forensic reports additionally store ledgers and temporal utilization.",
            "pairedScenarioId is the unit of paired comparison. scenarioName adds the policy identifier "
            "and is globally unique within the canonical campaign."
        ]),
        ("Appendix D. Reproducibility Commands", [
            "The correction runner, canonical builder, phase-aware analysis, forensic selector, campaign "
            "runner, report generator, and PDF verifier are all deterministic under their recorded seeds.",
            "Resume mode skips scenario names already present. Canonical construction replaces only the "
            "planned adaptive scenarios and verifies the final count and uniqueness before analysis."
        ]),
        ("Appendix E. Extended Statistical Criteria", [
            "Practical relevance requires 100 percent completion, median CCT improvement of at least five "
            "percent, a paired bootstrap interval below zero, and no more than ten percent FCT p99 "
            "regression.",
            "Wilson intervals describe uncertainty in win fraction. Bootstrap intervals preserve the "
            "paired scenario deltas and make no normality assumption."
        ]),
        ("Appendix F. References", [
            "[1] S. P. Chittampalli, R. Dhamnani, P. Kumar, A. Srivastava, and W. Wang, "
            "\"Observations of a Layer 2 Clos Fat-tree,\" IEEE 802.1-24-0014-00-ICne, 14 March 2024.",
            "[2] R. Marks, \"Collective Multicast in a Fat Tree,\" EthAirNet Associates, 9 February 2025.",
            "[3] R. Marks, \"Data Center Collective Multicast using BARC-assigned Address Blocks,\" "
            "IEEE 802.1 contribution, 13 March 2024.",
            "[4] IEEE P802.1CQ, Multicast and Local Address Assignment, work in progress."
        ]),
        ("Appendix G. Forensic Case Catalogue", [
            "The table lists every focal case retained for mechanistic analysis. Each row has an "
            "exact-lossless partner with the same pairedScenarioId, topology, workload, capacity, "
            "buffer, placement, and seed."
        ]),
    ]
    for title, paragraphs in appendices:
        appendix_table = None
        if title.startswith("Appendix G"):
            appendix_table = data_table(
                ["Case", "Category", "Policy", "Profile", "Cap.", "Buffer", "Payload", "Delta", "Tail"],
                [[
                    item["caseId"], item["category"], item["policy"], item["profile"],
                    item["capacity"], item["buffer"], item["payload"], fmt(item["deltaCct"], 1),
                    item["recoveryTail"]
                ] for item in forensic_rows],
                [13 * mm, 31 * mm, 34 * mm, 16 * mm, 11 * mm, 13 * mm, 16 * mm, 13 * mm, 12 * mm],
                font_size=6.3,
            ) if forensic_rows else None
        story.extend(section(title, paragraphs, table=appendix_table))

    return story


def main():
    global STYLE
    args = parse_args()
    STYLE = styles()
    campaign = Path(args.campaign)
    analysis = Path(args.analysis)
    forensic = Path(args.forensic)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    validation = json.loads((campaign / "validation.json").read_text(encoding="utf-8"))
    if not validation.get("valid"):
        raise RuntimeError("Refusing to report an invalid canonical campaign.")
    data = json.loads((analysis / "report_data.json").read_text(encoding="utf-8"))
    if data["statistics"]["campaignReports"] != 13600 and not args.allow_incomplete:
        raise RuntimeError("The final report requires exactly 13,600 canonical runs.")
    forensic_rows = forensic_summary(forensic)
    if len(forensic_rows) != 40 and not args.allow_incomplete:
        raise RuntimeError(f"The final report requires 40 paired forensic cases; found {len(forensic_rows)}.")

    source_path = out.parent / "report_source.md"
    report_source(
        source_path, data["statistics"], data["phasePolicySummaries"], forensic_rows
    )
    doc = ResearchDocTemplate(
        str(out), pagesize=A4, title="BARC Multicast Selective Recovery in Clos Fat-Tree Datacenters",
        author="BARC Multicast Research Project",
        subject="Selective recovery and adaptive congestion control for multicast AI collectives",
        leftMargin=19 * mm, rightMargin=19 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
    )
    story = build_story(data, forensic_rows)
    doc.multiBuild(story)
    print(f"Research report written to {out.resolve()}")


if __name__ == "__main__":
    main()
