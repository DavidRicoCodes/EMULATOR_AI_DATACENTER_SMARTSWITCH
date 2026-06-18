#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function percentile(values, pct) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct / 100) - 1)];
}

function mean(values) {
    const valid = values.filter(Number.isFinite);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
    return percentile(values, 50);
}

function formatNumber(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function runComplete(report) {
    return (report.collectives || []).filter(c => c.memberHosts.length > 0).every(c => c.complete);
}

function runCct(report) {
    const values = (report.collectives || [])
        .filter(c => c.memberHosts.length > 0 && c.complete)
        .map(c => c.cctTicks);
    return values.length ? Math.max(...values) : null;
}

function runFctP99(report) {
    const values = [];
    for (const host of report.hostStats || []) {
        for (const item of host.breakdown || []) {
            if (item.complete && Number.isFinite(item.fctTicks)) values.push(item.fctTicks);
        }
    }
    return percentile(values, 99);
}

function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function bootstrap(values, statistic, samples, seed) {
    if (!values.length) return [null, null];
    const rng = makeRng(seed);
    const estimates = [];
    for (let sample = 0; sample < samples; sample++) {
        const resampled = [];
        for (let i = 0; i < values.length; i++) {
            resampled.push(values[Math.floor(rng() * values.length)]);
        }
        estimates.push(statistic(resampled));
    }
    return [percentile(estimates, 2.5), percentile(estimates, 97.5)];
}

function wilson(successes, total, z) {
    if (!total) return [null, null];
    const p = successes / total;
    const denom = 1 + z * z / total;
    const center = (p + z * z / (2 * total)) / denom;
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denom;
    return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function pairedRows(reports) {
    const groups = new Map();
    for (const report of reports) {
        const pairedId = report.experiment && report.experiment.pairedScenarioId;
        if (!pairedId) continue;
        if (!groups.has(pairedId)) groups.set(pairedId, []);
        groups.get(pairedId).push(report);
    }

    const rows = [];
    for (const [pairedScenarioId, items] of groups.entries()) {
        const baseline = items.find(report => report.experiment.policy === 'advisor-exact-lossless');
        if (!baseline || !runComplete(baseline)) continue;
        const baselineCct = runCct(baseline);
        const baselineP99 = runFctP99(baseline);
        for (const report of items) {
            if (report === baseline) continue;
            const complete = runComplete(report);
            const cct = runCct(report);
            const p99 = runFctP99(report);
            rows.push({
                pairedScenarioId,
                phase: report.experiment.phase,
                policy: report.experiment.policy,
                placement: report.experiment.placement,
                profile: report.experiment.profile,
                payloadBlocks: report.experiment.payloadBlocks,
                capacity: report.experiment.capacity,
                bufferLimit: report.experiment.bufferLimit,
                seed: report.experiment.seed,
                complete,
                baselineCct,
                cct,
                deltaCct: complete ? cct - baselineCct : null,
                relativeDelta: complete ? (cct - baselineCct) / baselineCct : null,
                baselineFctP99: baselineP99,
                fctP99: p99,
                p99Regression: Number.isFinite(p99) && Number.isFinite(baselineP99)
                    ? (p99 - baselineP99) / baselineP99
                    : null
            });
        }
    }
    return rows;
}

function summarizePairs(rows, bootstrapSamples) {
    const samples = bootstrapSamples === undefined ? 10000 : bootstrapSamples;
    const groups = new Map();
    for (const row of rows) {
        const keys = [
            ['overall', row.policy],
            ['placement', `${row.policy}||${row.placement}`],
            ['profile', `${row.policy}||${row.profile}`],
            ['payload', `${row.policy}||${row.payloadBlocks}`],
            ['buffer', `${row.policy}||${row.bufferLimit}`],
            ['capacity', `${row.policy}||${row.capacity}`]
        ];
        for (const [dimension, key] of keys) {
            const fullKey = `${dimension}::${key}`;
            if (!groups.has(fullKey)) groups.set(fullKey, { dimension, key, rows: [] });
            groups.get(fullKey).rows.push(row);
        }
    }

    return Array.from(groups.values()).map(group => {
        const valid = group.rows.filter(row => row.complete && Number.isFinite(row.deltaCct));
        const deltas = valid.map(row => row.deltaCct);
        const relative = valid.map(row => row.relativeDelta);
        const wins = valid.filter(row => row.deltaCct < 0).length;
        const ties = valid.filter(row => row.deltaCct === 0).length;
        const losses = valid.filter(row => row.deltaCct > 0).length;
        const [wilsonLow, wilsonHigh] = wilson(wins, valid.length, 1.96);
        const [meanLow, meanHigh] = bootstrap(deltas, mean, samples, 20260618);
        const [medianLow, medianHigh] = bootstrap(deltas, median, samples, 20260619);
        const p99Ok = valid.every(row => !Number.isFinite(row.p99Regression) || row.p99Regression <= 0.1);
        const relevant = valid.length >= 10
            && valid.length === group.rows.length
            && median(relative) <= -0.05
            && meanHigh < 0
            && p99Ok;
        return {
            dimension: group.dimension,
            key: group.key,
            runs: group.rows.length,
            completeRuns: valid.length,
            wins,
            ties,
            losses,
            winRate: valid.length ? wins / valid.length : null,
            wilsonLow,
            wilsonHigh,
            meanDelta: mean(deltas),
            medianDelta: median(deltas),
            medianRelativeDelta: median(relative),
            meanBootstrapLow: meanLow,
            meanBootstrapHigh: meanHigh,
            medianBootstrapLow: medianLow,
            medianBootstrapHigh: medianHigh,
            p99WithinTenPercent: p99Ok,
            relevant
        };
    });
}

function selectPolicies(reports, existing) {
    const selections = Object.assign({}, existing || {});
    const byPhase = phase => reports.filter(report => report.experiment.phase === phase);
    const rank = (items, predicate) => {
        const groups = new Map();
        for (const report of items.filter(predicate)) {
            const key = report.experiment.policy;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(report);
        }
        return Array.from(groups.entries()).map(([policy, group]) => ({
            policy,
            completion: group.filter(runComplete).length / group.length,
            avgCct: mean(group.filter(runComplete).map(runCct))
        })).sort((a, b) => b.completion - a.completion || a.avgCct - b.avgCct);
    };

    const phaseA = rank(byPhase('A'), report => /^advisor-overdrive-a/.test(report.experiment.policy));
    if (phaseA.length) selections.bestFixedAlphaPolicy = phaseA[0].policy;

    const training = rank(byPhase('B-training'), report => /^adaptive-lhs-/.test(report.experiment.policy));
    if (training.length) selections.topAdaptiveTrainingPolicies = training.slice(0, 3).map(item => item.policy);

    const validation = rank(byPhase('B-validation'), report => /^adaptive-lhs-/.test(report.experiment.policy));
    if (validation.length) selections.bestAdaptiveOraclePolicy = validation[0].policy;

    const feedback = rank(byPhase('D'), report => /^adaptive-feedback-d/.test(report.experiment.policy));
    if (feedback.length) selections.bestAdaptiveFeedbackPolicy = feedback[0].policy;
    return selections;
}

function writeCsv(filePath, rows, columns) {
    const lines = [columns.join(',')];
    for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
    fs.writeFileSync(filePath, lines.join('\n'));
}

function analyzeCampaign(outDir, options) {
    const opts = options || {};
    const reports = readJsonl(path.join(outDir, 'reports.jsonl'));
    const pairs = pairedRows(reports);
    const summaries = summarizePairs(pairs, opts.bootstrapSamples);
    const selectionsPath = path.join(outDir, 'selections.json');
    const existing = fs.existsSync(selectionsPath) ? JSON.parse(fs.readFileSync(selectionsPath, 'utf8')) : {};
    const selections = selectPolicies(reports, existing);
    const violations = [];
    for (const report of reports) {
        const policy = report.experiment.policy;
        if (['advisor-exact-lossless', 'per-source-lossless'].includes(policy)
            && report.summary.totalDrops !== 0) {
            violations.push({ scenarioName: report.scenarioName, type: 'lossless-drop', value: report.summary.totalDrops });
        }
        if (policy !== 'no-recovery-max-rate' && !runComplete(report)) {
            violations.push({ scenarioName: report.scenarioName, type: 'recovery-incomplete', value: report.summary.activeAtEnd ? 'timeout' : 'incomplete' });
        }
    }
    const seedSets = {};
    for (const report of reports) {
        const phase = report.experiment.phase;
        if (!seedSets[phase]) seedSets[phase] = new Set();
        seedSets[phase].add(report.experiment.seed);
    }
    const disjointPairs = [['B-training', 'B-validation'], ['B-training', 'C'], ['B-validation', 'C'], ['C', 'E']];
    for (const [left, right] of disjointPairs) {
        const overlap = Array.from(seedSets[left] || []).filter(seed => (seedSets[right] || new Set()).has(seed));
        if (overlap.length) violations.push({ type: 'seed-overlap', phases: `${left}:${right}`, value: overlap.join('|') });
    }

    writeCsv(path.join(outDir, 'paired-comparisons.csv'), pairs, [
        'pairedScenarioId', 'phase', 'policy', 'placement', 'profile', 'payloadBlocks',
        'capacity', 'bufferLimit', 'seed', 'complete', 'baselineCct', 'cct', 'deltaCct',
        'relativeDelta', 'baselineFctP99', 'fctP99', 'p99Regression'
    ]);
    writeCsv(path.join(outDir, 'paired-summary.csv'), summaries, [
        'dimension', 'key', 'runs', 'completeRuns', 'wins', 'ties', 'losses', 'winRate',
        'wilsonLow', 'wilsonHigh', 'meanDelta', 'medianDelta', 'medianRelativeDelta',
        'meanBootstrapLow', 'meanBootstrapHigh', 'medianBootstrapLow', 'medianBootstrapHigh',
        'p99WithinTenPercent', 'relevant'
    ]);
    writeCsv(path.join(outDir, 'ranking.csv'), summaries.filter(item => item.dimension === 'overall'), [
        'dimension', 'key', 'runs', 'completeRuns', 'wins', 'ties', 'losses', 'winRate',
        'wilsonLow', 'wilsonHigh', 'meanDelta', 'medianDelta', 'medianRelativeDelta',
        'meanBootstrapLow', 'meanBootstrapHigh', 'medianBootstrapLow', 'medianBootstrapHigh',
        'p99WithinTenPercent', 'relevant'
    ]);
    fs.writeFileSync(selectionsPath, JSON.stringify(selections, null, 2));
    fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify({
        valid: violations.length === 0,
        violations
    }, null, 2));

    const overall = summaries.filter(item => item.dimension === 'overall')
        .sort((a, b) => b.completeRuns - a.completeRuns || a.meanDelta - b.meanDelta);
    const relevant = summaries.filter(item => item.relevant);
    const lines = [
        '# Campaign Analysis',
        '',
        `Reports: ${reports.length}`,
        `Paired comparisons: ${pairs.length}`,
        `Validation violations: ${violations.length}`,
        '',
        '## Policy Comparison',
        '',
        '| Policy | Complete | Win/Tie/Loss | Win Rate | Mean Delta CCT | Median Relative Delta |',
        '| --- | ---: | ---: | ---: | ---: | ---: |'
    ];
    for (const item of overall) {
        const policy = item.key;
        lines.push(`| ${policy} | ${item.completeRuns}/${item.runs} | ${item.wins}/${item.ties}/${item.losses} | ${formatNumber(100 * item.winRate, 2)}% | ${formatNumber(item.meanDelta, 2)} | ${formatNumber(100 * item.medianRelativeDelta, 2)}% |`);
    }
    lines.push('', '## Relevant Winning Strata', '');
    if (!relevant.length) lines.push('No stratum satisfies the predefined relevance criteria.');
    for (const item of relevant) lines.push(`- ${item.dimension}: ${item.key}`);
    lines.push('', '## Selections', '', '```json', JSON.stringify(selections, null, 2), '```');
    fs.writeFileSync(path.join(outDir, 'analysis.md'), lines.join('\n'));

    return { reports, pairs, summaries, selections };
}

if (require.main === module) {
    const outDir = path.resolve(process.argv[2] || '.');
    const result = analyzeCampaign(outDir);
    console.log(`Analyzed ${result.reports.length} campaign reports.`);
}

module.exports = { analyzeCampaign, pairedRows, summarizePairs, selectPolicies };
