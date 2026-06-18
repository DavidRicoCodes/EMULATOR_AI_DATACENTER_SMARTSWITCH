#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) return [];
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function percentile(values, pct) {
    const nums = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((pct / 100) * nums.length) - 1));
    return nums[idx];
}

function avg(values) {
    const nums = values.filter(v => Number.isFinite(v));
    if (!nums.length) return null;
    return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function csvCell(value) {
    const str = String(value === null || value === undefined ? '' : value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

function collectFcts(report) {
    const fcts = [];
    for (const h of report.hostStats || []) {
        for (const b of h.breakdown || []) {
            if (b.complete && Number.isFinite(b.fctTicks)) fcts.push(b.fctTicks);
        }
    }
    return fcts;
}

function completeCollectiveCcts(report) {
    return (report.collectives || [])
        .filter(c => (c.memberHosts || []).length > 0 && c.complete && Number.isFinite(c.cctTicks))
        .map(c => c.cctTicks);
}

function groupKey(report, fields) {
    const exp = report.experiment || {};
    return fields.map(field => exp[field] === undefined ? '' : exp[field]).join('||');
}

function summarizeGroup(reports) {
    const fcts = reports.flatMap(collectFcts);
    const ccts = reports.flatMap(completeCollectiveCcts);
    const completeRuns = reports.filter(r => (r.collectives || []).filter(c => (c.memberHosts || []).length > 0).every(c => c.complete)).length;
    const drops = reports.map(r => r.summary ? r.summary.totalDrops : 0);
    const repairs = reports.map(r => r.summary ? r.summary.totalRepairsInjected : 0);
    const controls = reports.map(r => r.summary ? r.summary.totalControlReports : 0);
    const reportRetries = reports.map(r => r.summary ? (r.summary.retransmittedDropReports || 0) : 0);
    const dropsPerBlock = reports.map(r => r.summary ? (r.summary.dropsPerOriginalBlock || 0) : 0);
    const repairsPerBlock = reports.map(r => r.summary ? (r.summary.repairsPerOriginalBlock || 0) : 0);
    const txCompleteTicks = reports.map(r => r.summary ? r.summary.originalTxCompleteTick : null);
    const postTxTailTicks = reports.map(r => r.summary ? r.summary.postTxCompletionTailTicks : null);
    const recoveryTailTicks = reports.map(r => r.summary ? r.summary.recoveryTailTicks : null);
    const waiting = reports.map(r => r.summary ? (r.summary.totalWaitingOffsetTicks || 0) : 0);
    const hotTicks = reports.map(r => Object.values(r.hotLinks || {}).reduce((sum, link) => sum + (link.hotTicks || 0), 0));
    const recoveryTicks = reports.flatMap(r => {
        if (r.recoveryLatencies && r.recoveryLatencies.length) {
            return r.recoveryLatencies.map(x => x.totalRecoveryTicks).filter(Number.isFinite);
        }
        if (r.recoveryLatencySummary && Number.isFinite(r.recoveryLatencySummary.p95RecoveryTicks)) {
            return [r.recoveryLatencySummary.p95RecoveryTicks];
        }
        return [];
    });

    return {
        runs: reports.length,
        completeRuns,
        completionRate: reports.length ? completeRuns / reports.length : 0,
        avgCct: avg(ccts),
        p50Fct: percentile(fcts, 50),
        p95Fct: percentile(fcts, 95),
        p99Fct: percentile(fcts, 99),
        avgDrops: avg(drops),
        avgRepairs: avg(repairs),
        avgControlReports: avg(controls),
        avgReportRetries: avg(reportRetries),
        avgDropsPerBlock: avg(dropsPerBlock),
        avgRepairsPerBlock: avg(repairsPerBlock),
        avgOriginalTxCompleteTick: avg(txCompleteTicks),
        avgPostTxCompletionTailTicks: avg(postTxTailTicks),
        avgRecoveryTailTicks: avg(recoveryTailTicks),
        avgWaitingOffsetTicks: avg(waiting),
        avgHotTicks: avg(hotTicks),
        p95RecoveryTicks: percentile(recoveryTicks, 95)
    };
}

function buildRankings(reports) {
    const dimensions = [
        ['policy'],
        ['placement'],
        ['policy', 'placement'],
        ['policy', 'groupSize'],
        ['policy', 'collectiveCount'],
        ['policy', 'overdriveAlpha']
    ];

    const sections = [];
    for (const fields of dimensions) {
        const groups = new Map();
        for (const report of reports) {
            const key = groupKey(report, fields);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(report);
        }
        const rows = Array.from(groups.entries()).map(([key, items]) => {
            const parts = key.split('||');
            const label = fields.map((field, idx) => `${field}=${parts[idx]}`).join(', ');
            return Object.assign({ label }, summarizeGroup(items));
        }).sort((a, b) => {
            if (b.completionRate !== a.completionRate) return b.completionRate - a.completionRate;
            const ac = a.avgCct === null ? Number.POSITIVE_INFINITY : a.avgCct;
            const bc = b.avgCct === null ? Number.POSITIVE_INFINITY : b.avgCct;
            if (ac !== bc) return ac - bc;
            return (a.p95Fct || Number.POSITIVE_INFINITY) - (b.p95Fct || Number.POSITIVE_INFINITY);
        });
        sections.push({ fields, rows });
    }
    return sections;
}

function writeRankingCsv(outDir, rankings) {
    const rows = [[
        'Dimension', 'Label', 'Runs', 'Complete Runs', 'Completion Rate',
        'Avg CCT', 'FCT p50', 'FCT p95', 'FCT p99',
        'Avg Drops', 'Avg Repairs', 'Avg Control Reports', 'Avg Report Retries',
        'Drops Per Block', 'Repairs Per Block', 'Avg Original TX Complete Tick',
        'Avg Post TX Tail Ticks', 'Avg Recovery Tail Ticks',
        'Avg Waiting Offset Ticks', 'Avg Hot Ticks', 'Recovery p95'
    ].join(',')];
    for (const section of rankings) {
        for (const row of section.rows) {
            rows.push([
                csvCell(section.fields.join('+')),
                csvCell(row.label),
                row.runs,
                row.completeRuns,
                row.completionRate.toFixed(4),
                row.avgCct === null ? '' : row.avgCct.toFixed(2),
                row.p50Fct === null ? '' : row.p50Fct,
                row.p95Fct === null ? '' : row.p95Fct,
                row.p99Fct === null ? '' : row.p99Fct,
                row.avgDrops === null ? '' : row.avgDrops.toFixed(2),
                row.avgRepairs === null ? '' : row.avgRepairs.toFixed(2),
                row.avgControlReports === null ? '' : row.avgControlReports.toFixed(2),
                row.avgReportRetries === null ? '' : row.avgReportRetries.toFixed(2),
                row.avgDropsPerBlock === null ? '' : row.avgDropsPerBlock.toFixed(6),
                row.avgRepairsPerBlock === null ? '' : row.avgRepairsPerBlock.toFixed(6),
                row.avgOriginalTxCompleteTick === null ? '' : row.avgOriginalTxCompleteTick.toFixed(2),
                row.avgPostTxCompletionTailTicks === null ? '' : row.avgPostTxCompletionTailTicks.toFixed(2),
                row.avgRecoveryTailTicks === null ? '' : row.avgRecoveryTailTicks.toFixed(2),
                row.avgWaitingOffsetTicks === null ? '' : row.avgWaitingOffsetTicks.toFixed(2),
                row.avgHotTicks === null ? '' : row.avgHotTicks.toFixed(2),
                row.p95RecoveryTicks === null ? '' : row.p95RecoveryTicks
            ].join(','));
        }
    }
    fs.writeFileSync(path.join(outDir, 'ranking.csv'), rows.join('\n'));
}

function fmt(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    return typeof digits === 'number' ? value.toFixed(digits) : String(value);
}

function writeAnalysisMd(outDir, reports, rankings) {
    const overall = summarizeGroup(reports);
    const policyRanking = rankings.find(s => s.fields.length === 1 && s.fields[0] === 'policy');
    const topPolicies = policyRanking ? policyRanking.rows.slice(0, 20) : [];

    const lines = [];
    lines.push('# Experiment Analysis');
    lines.push('');
    lines.push(`Generated from ${reports.length} reports.`);
    lines.push('');
    lines.push('## Overall');
    lines.push('');
    lines.push(`- Complete runs: ${overall.completeRuns}/${overall.runs} (${fmt(overall.completionRate * 100, 2)}%)`);
    lines.push(`- Avg CCT: ${fmt(overall.avgCct, 2)} ticks`);
    lines.push(`- FCT p50/p95/p99: ${fmt(overall.p50Fct)} / ${fmt(overall.p95Fct)} / ${fmt(overall.p99Fct)} ticks`);
    lines.push(`- Avg drops: ${fmt(overall.avgDrops, 2)}`);
    lines.push(`- Avg repair packets: ${fmt(overall.avgRepairs, 2)}`);
    lines.push(`- Avg control reports: ${fmt(overall.avgControlReports, 2)}`);
    lines.push(`- Avg retransmitted reports: ${fmt(overall.avgReportRetries, 2)}`);
    lines.push(`- Avg drops/original block: ${fmt(overall.avgDropsPerBlock, 4)}`);
    lines.push(`- Avg repairs/original block: ${fmt(overall.avgRepairsPerBlock, 4)}`);
    lines.push(`- Avg original TX complete: ${fmt(overall.avgOriginalTxCompleteTick, 2)} ticks`);
    lines.push(`- Avg post-TX completion tail: ${fmt(overall.avgPostTxCompletionTailTicks, 2)} ticks`);
    lines.push(`- Avg recovery tail: ${fmt(overall.avgRecoveryTailTicks, 2)} ticks`);
    lines.push('');
    lines.push('## Policy Ranking');
    lines.push('');
    lines.push('| Rank | Policy | Completion | Avg CCT | TX Complete | Post-TX Tail | Recovery Tail | Drops/Block | Repairs/Block |');
    lines.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    topPolicies.forEach((row, idx) => {
        lines.push(`| ${idx + 1} | ${row.label.replace(/^policy=/, '')} | ${fmt(row.completionRate * 100, 2)}% | ${fmt(row.avgCct, 2)} | ${fmt(row.avgOriginalTxCompleteTick, 2)} | ${fmt(row.avgPostTxCompletionTailTicks, 2)} | ${fmt(row.avgRecoveryTailTicks, 2)} | ${fmt(row.avgDropsPerBlock, 4)} | ${fmt(row.avgRepairsPerBlock, 4)} |`);
    });
    lines.push('');
    lines.push('## Initial Interpretation');
    lines.push('');
    lines.push('- Prefer policies with completion rate near 100%, then compare Avg CCT and FCT p95/p99.');
    lines.push('- `max-rate-recovery` should be judged together with repair/control overhead; a low original TX time may still create a long recovery tail.');
    lines.push('- `advisor-exact-lossless` is the uniform no-drop baseline; the research target is any 100%-completion policy with lower CCT.');
    lines.push('- `per-source-lossless` tests whether heterogeneous max-min source rates improve utilization without requiring recovery.');
    lines.push('');
    lines.push('See `ranking.csv` for grouped rankings and the raw CSV/JSONL files for deeper analysis.');
    fs.writeFileSync(path.join(outDir, 'analysis.md'), lines.join('\n'));
}

function analyzeExperimentDir(outDir) {
    const reports = readJsonl(path.join(outDir, 'reports.jsonl'));
    const rankings = buildRankings(reports);
    writeRankingCsv(outDir, rankings);
    writeAnalysisMd(outDir, reports, rankings);
    return { reports: reports.length, rankings: rankings.length };
}

if (require.main === module) {
    const outDir = process.argv[2];
    if (!outDir) {
        console.error('Usage: node analyze-results.js <results-dir>');
        process.exit(1);
    }
    const result = analyzeExperimentDir(path.resolve(outDir));
    console.log(`Analyzed ${result.reports} reports in ${path.resolve(outDir)}`);
}

module.exports = {
    analyzeExperimentDir,
    summarizeGroup,
    percentile
};
