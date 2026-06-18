#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BARCResearchSim, COLOR_NAMES } = require('./barc-sim-core');
const { analyzeExperimentDir } = require('./analyze-results');

const POLICIES = [
    'advisor-exact-lossless',
    'advisor-overdrive-a1.05',
    'advisor-overdrive-a1.10',
    'advisor-overdrive-a1.20',
    'advisor-overdrive-a1.35',
    'advisor-overdrive-a1.50',
    'advisor-overdrive-a2.00',
    'per-source-lossless',
    'adaptive-advisor-overdrive',
    'max-rate-recovery',
    'member-formula-rate',
    'no-recovery-max-rate',
];

const DETERMINISTIC_PLACEMENTS = [
    'rack-compact',
    'pod-compact',
    'pod-spread',
    'global-spread',
    'adversarial-shared-uplink'
];

const ALL_PLACEMENTS = DETERMINISTIC_PLACEMENTS.concat(['random-balanced']);

const HOSTS = Array.from({ length: 16 }, (_, index) => {
    const pod = Math.floor(index / 4);
    const hostIndexInPod = index % 4;
    return {
        index,
        id: `H_${pod}_${hostIndexInPod}`,
        pod,
        rack: hostIndexInPod < 2 ? 0 : 1,
        hostInRack: hostIndexInPod % 2
    };
});

function parseArgs(argv) {
    const args = {
        suite: 'smoke',
        capacity: 10,
        maxTicks: 50000,
        outRoot: path.join(process.cwd(), 'results', 'experiments'),
        includeTemporal: false,
        includeEventLog: false,
        includeLedgersInReports: false
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (key === 'includeTemporal' || key === 'includeEventLog' || key === 'includeLedgersInReports') {
            args[key] = true;
        } else if (next !== undefined) {
            args[key] = next;
            i++;
        }
    }
    args.capacity = Number(args.capacity);
    args.maxTicks = Number(args.maxTicks);
    return args;
}

function makeRng(seed) {
    let state = (seed >>> 0) || 1;
    return function rng() {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function shuffle(items, seed) {
    const rng = makeRng(seed);
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
    }
    return copy;
}

function orderHosts(placement, seed) {
    if (placement === 'random-balanced') return shuffle(HOSTS.map(h => h.index), seed);

    if (placement === 'rack-compact') {
        return HOSTS.slice()
            .sort((a, b) => a.pod - b.pod || a.rack - b.rack || a.hostInRack - b.hostInRack)
            .map(h => h.index);
    }

    if (placement === 'pod-compact') {
        return HOSTS.slice()
            .sort((a, b) => a.pod - b.pod || a.hostIndexInPod - b.hostIndexInPod)
            .map(h => h.index);
    }

    if (placement === 'pod-spread') {
        const ordered = [];
        for (let hostIndexInPod = 0; hostIndexInPod < 4; hostIndexInPod++) {
            for (let pod = 0; pod < 4; pod++) ordered.push(pod * 4 + hostIndexInPod);
        }
        return ordered;
    }

    if (placement === 'global-spread') {
        return [0, 5, 10, 15, 3, 6, 9, 12, 1, 4, 11, 14, 2, 7, 8, 13];
    }

    if (placement === 'adversarial-shared-uplink') {
        return [0, 1, 4, 5, 8, 9, 12, 13, 2, 3, 6, 7, 10, 11, 14, 15];
    }

    throw new Error(`Unknown placement: ${placement}`);
}

function buildHostColors(placement, groupSize, collectiveCount, seed) {
    if (groupSize * collectiveCount > HOSTS.length) return null;
    const hostColors = Array(16).fill(null);
    const ordered = orderHosts(placement, seed);
    let cursor = 0;
    for (let color = 0; color < collectiveCount; color++) {
        for (let i = 0; i < groupSize; i++) {
            const hostIndex = ordered[cursor++];
            hostColors[hostIndex] = color;
        }
    }
    return hostColors;
}

function applyHostColorsForAdvisor(sim, hostColors) {
    sim.resetSetup();
    for (let i = 0; i < hostColors.length; i++) {
        if (hostColors[i] !== null && hostColors[i] !== undefined) sim.hosts[i].colorIndex = Number(hostColors[i]);
    }
    sim.computeForwardingState();
}

function buildAdvisor(hostColors, capacity, bufferLimit, seed) {
    const sim = new BARCResearchSim({
        capacity,
        bufferLimit,
        seed,
        enableEventLog: false
    });
    applyHostColorsForAdvisor(sim, hostColors);
    return {
        rateAdvisor: sim.buildRateAdvisor(),
        spineHeatmapAdvisor: sim.buildSpineHeatmapAdvisor()
    };
}

function ratesObject(rateByColor) {
    const rates = {};
    for (let i = 0; i < COLOR_NAMES.length; i++) rates[COLOR_NAMES[i]] = rateByColor[i] || 0;
    return rates;
}

function activeColorCount(hostColors) {
    return new Set(hostColors.filter(v => v !== null && v !== undefined)).size;
}

function buildPhaseOffsets(hostColors, advisor) {
    const byColor = {};
    const recommended = (advisor.spineHeatmapAdvisor && advisor.spineHeatmapAdvisor.recommendedPhaseOffsets) || {};
    for (let color = 0; color < COLOR_NAMES.length; color++) {
        const collectiveId = COLOR_NAMES[color];
        byColor[color] = Math.min(5, Math.max(0, Number(recommended[collectiveId]) || 0));
    }

    const membersByColor = {};
    for (let i = 0; i < hostColors.length; i++) {
        const color = hostColors[i];
        if (color === null || color === undefined) continue;
        if (!membersByColor[color]) membersByColor[color] = [];
        membersByColor[color].push(i);
    }

    const offsets = {};
    for (const colorKey of Object.keys(membersByColor)) {
        const color = Number(colorKey);
        const members = membersByColor[color].slice().sort((a, b) => a - b);
        for (let pos = 0; pos < members.length; pos++) {
            const hostId = HOSTS[members[pos]].id;
            offsets[hostId] = Math.min(5, byColor[color] + (pos % 3));
        }
    }
    return offsets;
}

function buildPolicyScenario(base, policy, advisor) {
    const capacity = base.capacity;
    const activeColors = activeColorCount(base.hostColors);
    const rateByColor = Array(4).fill(0);
    const losslessRate = advisor.rateAdvisor.combinedRecommendedUniformRate || capacity;
    const memberFormulaRate = capacity / Math.max(1, base.groupSize - 1);

    let enableRecovery = true;
    let injectionMode = 'all_at_once';
    let startOffsetTicks = {};
    let selectedRate = capacity;
    let overdriveAlpha = null;
    let hostRates = {};
    let adaptiveRateControl = null;
    let losslessAdmissionControl = false;

    if (policy === 'no-recovery-max-rate') {
        enableRecovery = false;
        selectedRate = capacity;
    } else if (policy === 'max-rate-recovery') {
        selectedRate = capacity;
    } else if (policy === 'advisor-exact-lossless') {
        selectedRate = losslessRate;
        losslessAdmissionControl = true;
    } else if (policy.startsWith('advisor-overdrive-a')) {
        overdriveAlpha = Number(policy.slice('advisor-overdrive-a'.length));
        selectedRate = Math.min(capacity, losslessRate * overdriveAlpha);
    } else if (policy === 'per-source-lossless') {
        selectedRate = losslessRate;
        hostRates = Object.assign({}, advisor.rateAdvisor.perSourceRecommendedRates || {});
        losslessAdmissionControl = true;
    } else if (policy === 'adaptive-advisor-overdrive') {
        selectedRate = losslessRate;
        overdriveAlpha = 1.2;
        adaptiveRateControl = {
            enabled: true,
            initialMultiplier: overdriveAlpha,
            minMultiplier: 1,
            maxMultiplier: overdriveAlpha,
            decreaseFactor: 0.8,
            increaseStep: 0.02,
            increaseEveryTicks: 4,
            queueHighWatermark: 0.75
        };
    } else if (policy === 'member-formula-rate') {
        selectedRate = memberFormulaRate;
    } else {
        throw new Error(`Unknown policy: ${policy}`);
    }

    for (let color = 0; color < activeColors; color++) rateByColor[color] = selectedRate;

    const scenarioName = [
        base.suite,
        policy,
        base.placement,
        `g${base.groupSize}`,
        `c${base.collectiveCount}`,
        `p${base.payloadBlocks}`,
        `b${base.bufferLimit}`,
        `s${base.seed}`
    ].join('__');

    return {
        scenarioName,
        seed: base.seed,
        capacity,
        bufferLimit: base.bufferLimit,
        payloadBlocks: base.payloadBlocks,
        maxTicks: base.maxTicks,
        hostColors: base.hostColors,
        rates: ratesObject(rateByColor),
        hostRates,
        adaptiveRateControl,
        losslessAdmissionControl,
        enableRecovery,
        injectionMode,
        startOffsetTicks,
        controlPacketBlocks: 0.05,
        maxRepairAttempts: null,
        dropReportRetryBaseTicks: 8,
        dropReportRetryMaxTicks: 128,
        experiment: {
            suite: base.suite,
            policy,
            placement: base.placement,
            groupSize: base.groupSize,
            collectiveCount: base.collectiveCount,
            payloadBlocks: base.payloadBlocks,
            bufferLimit: base.bufferLimit,
            capacity,
            seed: base.seed,
            selectedRate,
            losslessRate,
            memberFormulaRate,
            overdriveAlpha,
            rateMode: policy === 'per-source-lossless' ? 'per-source' : 'uniform',
            activeColors
        },
        advisor
    };
}

function suiteMatrix(suite) {
    if (suite === 'smoke') {
        return {
            groupSizes: [4, 8],
            collectiveCounts: [1, 2],
            payloads: [100],
            buffers: [16],
            deterministicPlacements: ['rack-compact', 'global-spread'],
            randomSeeds: [1],
            includeRandom: true
        };
    }

    if (suite === 'research') {
        return {
            groupSizes: [2, 4, 8, 12, 16],
            collectiveCounts: [1, 2, 4],
            payloads: [100, 1000],
            buffers: [16, 32, 64],
            deterministicPlacements: DETERMINISTIC_PLACEMENTS,
            randomSeeds: Array.from({ length: 30 }, (_, i) => i + 1),
            includeRandom: true,
            randomSubsetOnly: true
        };
    }

    if (suite === 'exhaustive') {
        return {
            groupSizes: [2, 4, 8, 12, 16],
            collectiveCounts: [1, 2, 4],
            payloads: [100, 1000],
            buffers: [16, 32, 64],
            deterministicPlacements: DETERMINISTIC_PLACEMENTS,
            randomSeeds: Array.from({ length: 30 }, (_, i) => i + 1),
            includeRandom: true
        };
    }

    throw new Error(`Unknown suite: ${suite}`);
}

function shouldIncludeRandomCombo(matrix, groupSize, collectiveCount, payloadBlocks, bufferLimit) {
    if (!matrix.randomSubsetOnly) return true;
    return [4, 8].includes(groupSize)
        && [1, 2].includes(collectiveCount)
        && payloadBlocks === 1000
        && bufferLimit === 32;
}

function generateScenarios(args) {
    const matrix = suiteMatrix(args.suite);
    const scenarios = [];
    const skipped = [];

    function addCombos(placement, seeds, randomPlacement) {
        for (const groupSize of matrix.groupSizes) {
            for (const collectiveCount of matrix.collectiveCounts) {
                if (groupSize * collectiveCount > 16) {
                    skipped.push({ placement, groupSize, collectiveCount, reason: 'not_enough_hosts' });
                    continue;
                }
                for (const payloadBlocks of matrix.payloads) {
                    for (const bufferLimit of matrix.buffers) {
                        if (randomPlacement && !shouldIncludeRandomCombo(matrix, groupSize, collectiveCount, payloadBlocks, bufferLimit)) continue;
                        for (const seed of seeds) {
                            const hostColors = buildHostColors(placement, groupSize, collectiveCount, seed);
                            if (!hostColors) continue;
                            const advisor = buildAdvisor(hostColors, args.capacity, bufferLimit, seed);
                            const base = {
                                suite: args.suite,
                                placement,
                                groupSize,
                                collectiveCount,
                                payloadBlocks,
                                bufferLimit,
                                capacity: args.capacity,
                                seed,
                                maxTicks: args.maxTicks,
                                hostColors
                            };
                            for (const policy of POLICIES) {
                                scenarios.push(buildPolicyScenario(base, policy, advisor));
                            }
                        }
                    }
                }
            }
        }
    }

    for (const placement of matrix.deterministicPlacements) addCombos(placement, [1], false);
    if (matrix.includeRandom) addCombos('random-balanced', matrix.randomSeeds, true);
    return { scenarios, skipped, matrix };
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function compactReport(report, args) {
    const copy = Object.assign({}, report);
    if (!args.includeEventLog) copy.eventLog = [];
    if (!args.includeTemporal) {
        copy.linkUtilizationByTick = [];
        const history = copy.adaptiveRateHistory || [];
        copy.adaptiveRateSummary = {
            changes: history.length,
            dropResponses: history.filter(item => item.reason === 'drop').length,
            queueResponses: history.filter(item => item.reason === 'queue').length,
            increases: history.filter(item => item.reason === 'increase').length
        };
        copy.adaptiveRateHistory = [];
    }
    if (!args.includeLedgersInReports) {
        const recoveryTicks = (copy.recoveryLatencies || []).map(x => x.totalRecoveryTicks).filter(Number.isFinite);
        copy.recoveryLatencySummary = {
            count: recoveryTicks.length,
            p95RecoveryTicks: percentile(recoveryTicks, 95)
        };
        copy.dropLedger = [];
        copy.controlLedger = [];
        copy.repairLedger = [];
        copy.recoveryLatencies = [];
    }
    return copy;
}

function writeJsonl(filePath, items) {
    fs.writeFileSync(filePath, items.map(item => JSON.stringify(item)).join('\n') + '\n');
}

function percentile(values, pct) {
    const nums = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((pct / 100) * nums.length) - 1));
    return nums[idx];
}

function csvWithoutHeader(csv) {
    const lines = csv.split(/\r?\n/);
    return lines.slice(1).filter(Boolean).join('\n');
}

function appendCsvBlock(filePath, csv) {
    const body = csvWithoutHeader(csv);
    if (body) fs.appendFileSync(filePath, body + '\n');
}

function reportToAdvisorRows(report) {
    const rows = [];
    const exp = report.experiment || {};
    const advisor = report.rateAdvisor || {};
    const spine = report.spineHeatmapAdvisor || {};
    const offsets = report.config ? report.config.hostStartOffsets || {} : {};
    for (const item of advisor.perCollective || []) {
        const spineLoad = spine.bySpine && item.rootId && spine.bySpine[item.rootId] ? spine.bySpine[item.rootId].estimatedBlocks : '';
        rows.push({
            scenarioName: report.scenarioName,
            policy: exp.policy,
            placement: exp.placement,
            groupSize: exp.groupSize,
            collectiveCount: exp.collectiveCount,
            payloadBlocks: exp.payloadBlocks,
            bufferLimit: exp.bufferLimit,
            seed: exp.seed,
            collectiveId: item.collectiveId,
            members: item.members,
            maxLoadFactor: item.maxLoadFactor,
            recommendedLosslessRate: item.recommendedLosslessRate,
            combinedMaxLoadFactor: advisor.combinedMaxLoadFactor,
            combinedRecommendedUniformRate: advisor.combinedRecommendedUniformRate,
            perSourceRecommendedRates: Object.keys(advisor.perSourceRecommendedRates || {})
                .sort()
                .map(hostId => `${hostId}:${advisor.perSourceRecommendedRates[hostId]}`)
                .join('|'),
            overdriveAlpha: exp.overdriveAlpha,
            bottleneckLinks: (item.bottleneckLinks || []).map(b => b.linkId).join('|'),
            rootId: item.rootId || '',
            estimatedSpineBlocks: spineLoad,
            appliedHostOffsets: Object.keys(offsets).map(k => `${k}:${offsets[k]}`).join('|')
        });
    }
    return rows;
}

function csvCell(value) {
    const str = String(value === null || value === undefined ? '' : value);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}

function writeAdvisorCsv(outDir, reports) {
    const rows = [[
        'Scenario Name', 'Policy', 'Placement', 'Group Size', 'Collective Count',
        'Payload Blocks', 'Buffer Limit', 'Seed', 'Collective', 'Members',
        'Max Load Factor', 'Recommended Lossless Rate',
        'Combined Max Load Factor', 'Combined Recommended Uniform Rate',
        'Per Source Recommended Rates', 'Overdrive Alpha',
        'Bottleneck Links', 'Root Spine', 'Estimated Spine Blocks', 'Applied Host Offsets'
    ].join(',')];
    for (const report of reports) {
        for (const row of reportToAdvisorRows(report)) {
            rows.push([
                csvCell(row.scenarioName),
                row.policy,
                row.placement,
                row.groupSize,
                row.collectiveCount,
                row.payloadBlocks,
                row.bufferLimit,
                row.seed,
                row.collectiveId,
                row.members,
                row.maxLoadFactor,
                row.recommendedLosslessRate,
                row.combinedMaxLoadFactor,
                row.combinedRecommendedUniformRate,
                csvCell(row.perSourceRecommendedRates),
                row.overdriveAlpha === null || row.overdriveAlpha === undefined ? '' : row.overdriveAlpha,
                csvCell(row.bottleneckLinks),
                row.rootId,
                row.estimatedSpineBlocks,
                csvCell(row.appliedHostOffsets)
            ].join(','));
        }
    }
    fs.writeFileSync(path.join(outDir, 'advisors.csv'), rows.join('\n'));
}

function writeReadme(outDir, manifest) {
    const lines = [];
    lines.push('# BARC Multicast Experiment Batch');
    lines.push('');
    lines.push(`Suite: ${manifest.suite}`);
    lines.push(`Generated: ${manifest.generatedAt}`);
    lines.push(`Scenarios: ${manifest.scenarioCount}`);
    lines.push('');
    lines.push('## Files');
    lines.push('');
    lines.push('- `manifest.json`: run configuration and assumptions.');
    lines.push('- `scenarios.jsonl`: exact scenario inputs.');
    lines.push('- `reports.jsonl`: per-run reports, compacted according to manifest storage flags.');
    lines.push('- `summary.csv`: one row per scenario.');
    lines.push('- `hosts.csv`: per-host CCT/FCT breakdown, including waiting offset ticks.');
    lines.push('- `drops.csv`: per-drop ledger.');
    lines.push('- `recovery.csv`: drop-report-repair latency ledger.');
    lines.push('- `advisors.csv`: rate advisor and bottleneck estimates.');
    lines.push('- `ranking.csv`: grouped analysis rankings.');
    lines.push('- `analysis.md`: human-readable first-pass interpretation.');
    lines.push('');
    lines.push('Completion metrics start at tick 0, when data is assumed available. Any `startOffsetTicks` is deliberate waiting and is counted in FCT/CCT.');
    fs.writeFileSync(path.join(outDir, 'README.md'), lines.join('\n'));
}

function run(args) {
    const generatedAt = new Date().toISOString();
    const outDir = path.resolve(args.out || path.join(args.outRoot, `${timestamp()}-${args.suite}`));
    ensureDir(outDir);

    const generated = generateScenarios(args);
    const scenarios = generated.scenarios;
    const reports = [];
    const reportJsonlPath = path.join(outDir, 'reports.jsonl');
    const summaryCsvPath = path.join(outDir, 'summary.csv');
    const hostsCsvPath = path.join(outDir, 'hosts.csv');
    const dropsCsvPath = path.join(outDir, 'drops.csv');
    const recoveryCsvPath = path.join(outDir, 'recovery.csv');
    fs.writeFileSync(reportJsonlPath, '');
    fs.writeFileSync(summaryCsvPath, BARCResearchSim.reportToSummaryCsv([]) + '\n');
    fs.writeFileSync(hostsCsvPath, BARCResearchSim.reportToHostCsv([]) + '\n');
    fs.writeFileSync(dropsCsvPath, BARCResearchSim.reportToDropCsv([]) + '\n');
    fs.writeFileSync(recoveryCsvPath, BARCResearchSim.reportToRecoveryCsv([]) + '\n');

    const sim = new BARCResearchSim({
        capacity: args.capacity,
        seed: 1,
        enableEventLog: args.includeEventLog
    });

    for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        const report = sim.runScenario(scenario);
        report.experiment = scenario.experiment;
        const storedReport = compactReport(report, args);
        reports.push(storedReport);
        fs.appendFileSync(reportJsonlPath, JSON.stringify(storedReport) + '\n');
        appendCsvBlock(summaryCsvPath, BARCResearchSim.reportToSummaryCsv([report]));
        appendCsvBlock(hostsCsvPath, BARCResearchSim.reportToHostCsv([report]));
        appendCsvBlock(dropsCsvPath, BARCResearchSim.reportToDropCsv([report]));
        appendCsvBlock(recoveryCsvPath, BARCResearchSim.reportToRecoveryCsv([report]));
        if ((i + 1) % 25 === 0 || i + 1 === scenarios.length) {
            console.log(`[${i + 1}/${scenarios.length}] ${scenario.scenarioName}`);
        }
    }

    const manifest = {
        schemaVersion: 'barc-experiment-suite-v1',
        generatedAt,
        suite: args.suite,
        scenarioCount: scenarios.length,
        skippedCount: generated.skipped.length,
        capacity: args.capacity,
        maxTicks: args.maxTicks,
        policies: POLICIES,
        placements: ALL_PLACEMENTS,
        matrix: generated.matrix,
        storage: {
            includeTemporal: args.includeTemporal,
            includeEventLog: args.includeEventLog,
            includeLedgersInReports: args.includeLedgersInReports
        },
        assumptions: [
            'BARC control plane is preconfigured before tick 0.',
            'Data availability is tick 0 for every source host.',
            'startOffsetTicks delays injection but is counted in FCT/CCT.',
            'All packet classes share a single per-port queue.',
            'Drop reports are 0.05 blocks; data and repair packets are 1 block.',
            'Fractional host rates are implemented as deterministic packet pacing.',
            'Per-source lossless rates use max-min progressive filling over advisor-traced links.',
            'Adaptive overdrive uses idealized fabric drop and queue telemetry.',
            'A repair arriving back at the dropping switch is the implicit acknowledgement for its report.',
            'Unacknowledged drop reports are retransmitted with bounded exponential backoff.'
        ],
        skipped: generated.skipped
    };

    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeJsonl(path.join(outDir, 'scenarios.jsonl'), scenarios.map(s => {
        const copy = Object.assign({}, s);
        delete copy.advisor;
        return copy;
    }));
    writeAdvisorCsv(outDir, reports);
    writeReadme(outDir, manifest);
    analyzeExperimentDir(outDir);

    console.log(`Wrote ${scenarios.length} scenarios to ${outDir}`);
    return outDir;
}

if (require.main === module) {
    try {
        run(parseArgs(process.argv));
    } catch (err) {
        console.error(err && err.stack ? err.stack : err);
        process.exit(1);
    }
}

module.exports = {
    run,
    generateScenarios,
    buildHostColors,
    buildPolicyScenario,
    buildAdvisor,
    orderHosts,
    ratesObject,
    HOSTS,
    POLICIES,
    DETERMINISTIC_PLACEMENTS
};
