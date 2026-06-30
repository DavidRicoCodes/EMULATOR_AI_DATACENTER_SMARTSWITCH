#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const QUOTAS = [
    ['best-fixed-overdrive', 8],
    ['worst-fixed-overdrive', 8],
    ['best-corrected-feedback', 6],
    ['worst-corrected-feedback', 6],
    ['near-tie', 4],
    ['extreme-recovery-tail', 4],
    ['per-source-divergence', 2],
    ['no-recovery-control', 2]
];

function parseArgs(argv) {
    const args = {
        campaign: path.join(process.cwd(), 'results', 'campaigns', 'final-corrected'),
        count: 80,
        out: null
    };
    for (let i = 2; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        args[argv[i].slice(2)] = argv[++i];
    }
    args.count = Number(args.count);
    if (!args.out) args.out = path.join(args.campaign, 'forensic-80.jsonl');
    return args;
}

function readJsonl(filePath) {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function runComplete(report) {
    return report.collectives.filter(item => item.memberHosts.length > 0).every(item => item.complete);
}

function runCct(report) {
    const values = report.collectives
        .filter(item => item.memberHosts.length > 0 && item.complete)
        .map(item => item.cctTicks);
    return values.length ? Math.max(...values) : null;
}

function buildCandidates(reports) {
    const groups = new Map();
    for (const report of reports) {
        const id = report.experiment.pairedScenarioId;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(report);
    }
    const candidates = [];
    for (const [pairedScenarioId, items] of groups.entries()) {
        const baseline = items.find(item => item.experiment.policy === 'advisor-exact-lossless');
        if (!baseline || !runComplete(baseline)) continue;
        const baselineCct = runCct(baseline);
        for (const report of items) {
            if (report === baseline) continue;
            if (!['C', 'D', 'E'].includes(report.experiment.phase)) continue;
            const complete = runComplete(report);
            const cct = runCct(report);
            candidates.push({
                pairedScenarioId,
                scenarioName: report.scenarioName,
                baselineScenarioName: baseline.scenarioName,
                policy: report.experiment.policy,
                phase: report.experiment.phase,
                placement: report.experiment.placement,
                profile: report.experiment.profile,
                payloadBlocks: report.experiment.payloadBlocks,
                capacity: report.experiment.capacity,
                bufferLimit: report.experiment.bufferLimit,
                complete,
                cct,
                baselineCct,
                deltaCct: complete ? cct - baselineCct : Infinity,
                relativeDelta: complete ? (cct - baselineCct) / baselineCct : Infinity,
                recoveryTailTicks: report.summary.recoveryTailTicks || 0,
                drops: report.summary.totalDrops || 0,
                repairs: report.summary.totalRepairsInjected || 0
            });
        }
    }
    return candidates;
}

function isFixed(candidate) {
    return candidate.policy === 'advisor-overdrive-a1.05';
}

function isFeedback(candidate) {
    return /^adaptive-feedback-d(1|4|8)$/.test(candidate.policy);
}

function sortCandidates(category, candidates) {
    const filtered = candidates.filter(candidate => {
        if (!candidate.complete && category !== 'no-recovery-control') return false;
        if (category === 'best-fixed-overdrive' || category === 'worst-fixed-overdrive') return isFixed(candidate);
        if (category === 'best-corrected-feedback' || category === 'worst-corrected-feedback') return isFeedback(candidate);
        if (category === 'near-tie') return isFixed(candidate) || isFeedback(candidate);
        if (category === 'extreme-recovery-tail') return candidate.recoveryTailTicks > 0
            && candidate.policy !== 'no-recovery-max-rate';
        if (category === 'per-source-divergence') return candidate.policy === 'per-source-lossless';
        if (category === 'no-recovery-control') return candidate.policy === 'no-recovery-max-rate';
        return false;
    });
    const score = candidate => {
        if (category.startsWith('best-')) return candidate.deltaCct;
        if (category.startsWith('worst-')) return -candidate.deltaCct;
        if (category === 'near-tie') return Math.abs(candidate.deltaCct);
        if (category === 'extreme-recovery-tail') return -candidate.recoveryTailTicks;
        if (category === 'per-source-divergence') return -Math.abs(candidate.deltaCct);
        return -candidate.drops;
    };
    return filtered.sort((left, right) =>
        score(left) - score(right)
        || left.payloadBlocks - right.payloadBlocks
        || left.capacity - right.capacity
        || left.bufferLimit - right.bufferLimit
        || left.scenarioName.localeCompare(right.scenarioName));
}

function selectCases(candidates) {
    const selected = [];
    const usedPairs = new Set();
    const counts = Object.fromEntries(QUOTAS.map(([category]) => [category, 0]));
    let longPairs = 0;

    const addCandidate = (category, candidate) => {
        if (!candidate || usedPairs.has(candidate.pairedScenarioId)) return false;
        const quota = QUOTAS.find(item => item[0] === category)[1];
        if (counts[category] >= quota) return false;
        if (candidate.payloadBlocks === 10000 && longPairs >= 4) return false;
        usedPairs.add(candidate.pairedScenarioId);
        if (candidate.payloadBlocks === 10000) longPairs++;
        selected.push(Object.assign({ category }, candidate));
        counts[category]++;
        return true;
    };

    const naturalCategory = candidate => {
        if (isFixed(candidate)) {
            return candidate.deltaCct <= 0 ? 'best-fixed-overdrive' : 'worst-fixed-overdrive';
        }
        if (isFeedback(candidate)) {
            return candidate.deltaCct <= 0 ? 'best-corrected-feedback' : 'worst-corrected-feedback';
        }
        return null;
    };

    const addCoverageCandidate = candidate => {
        const preferred = naturalCategory(candidate);
        if (!preferred) return false;
        if (addCandidate(preferred, candidate)) return true;
        const alternate = preferred.startsWith('best-')
            ? preferred.replace('best-', 'worst-')
            : preferred.replace('worst-', 'best-');
        return addCandidate(alternate, candidate);
    };

    for (const category of [
        'best-fixed-overdrive',
        'worst-fixed-overdrive',
        'best-corrected-feedback',
        'worst-corrected-feedback'
    ]) {
        const longCandidate = sortCandidates(category, candidates)
            .find(candidate => candidate.phase === 'E' && !usedPairs.has(candidate.pairedScenarioId));
        addCandidate(category, longCandidate);
    }

    const coveragePool = candidates.filter(candidate =>
        candidate.complete && (isFixed(candidate) || isFeedback(candidate))
        && candidate.payloadBlocks !== 10000);
    const coverDimension = (field, values) => {
        for (const value of values) {
            if (selected.some(item => item[field] === value)) continue;
            const candidate = coveragePool
                .filter(item => item[field] === value && !usedPairs.has(item.pairedScenarioId))
                .sort((left, right) =>
                    Math.abs(left.deltaCct) - Math.abs(right.deltaCct)
                    || left.scenarioName.localeCompare(right.scenarioName))[0];
            if (!addCoverageCandidate(candidate)) {
                throw new Error(`Unable to cover forensic ${field}=${value}`);
            }
        }
    };

    coverDimension('placement', Array.from(new Set(coveragePool.map(item => item.placement))).sort());
    coverDimension('capacity', Array.from(new Set(coveragePool.map(item => item.capacity))).sort((a, b) => a - b));
    coverDimension('bufferLimit', Array.from(new Set(coveragePool.map(item => item.bufferLimit))).sort((a, b) => a - b));

    for (const [category, quota] of QUOTAS) {
        const ordered = sortCandidates(category, candidates);
        while (counts[category] < quota) {
            const candidate = ordered.shift();
            if (!candidate) break;
            addCandidate(category, candidate);
        }
    }

    if (selected.length !== 40) {
        throw new Error(`Forensic selector produced ${selected.length} focal cases; expected 40.`);
    }
    if (longPairs < 4) throw new Error(`Forensic selector produced ${longPairs} long-payload pairs; expected 4.`);
    const coveredPlacements = new Set(selected.map(item => item.placement));
    const coveredCapacities = new Set(selected.map(item => item.capacity));
    const coveredBuffers = new Set(selected.map(item => item.bufferLimit));
    for (const value of new Set(coveragePool.map(item => item.placement))) {
        if (!coveredPlacements.has(value)) throw new Error(`Missing forensic placement coverage: ${value}`);
    }
    for (const value of new Set(coveragePool.map(item => item.capacity))) {
        if (!coveredCapacities.has(value)) throw new Error(`Missing forensic capacity coverage: ${value}`);
    }
    for (const value of new Set(coveragePool.map(item => item.bufferLimit))) {
        if (!coveredBuffers.has(value)) throw new Error(`Missing forensic buffer coverage: ${value}`);
    }
    return selected;
}

function cloneForensicScenario(scenario, metadata) {
    const copy = JSON.parse(JSON.stringify(scenario));
    copy.storageMode = 'full';
    copy.maxWallClockMs = copy.experiment && copy.experiment.payloadBlocks >= 10000
        ? 60 * 60 * 1000
        : 30 * 60 * 1000;
    copy.experiment = Object.assign({}, copy.experiment, metadata);
    return copy;
}

function run(args) {
    if (args.count !== 80) throw new Error('This research design requires exactly 80 forensic runs.');
    const campaignDir = path.resolve(args.campaign);
    const reports = readJsonl(path.join(campaignDir, 'reports.jsonl'));
    const scenarios = new Map(readJsonl(path.join(campaignDir, 'scenarios.jsonl'))
        .map(scenario => [scenario.scenarioName, scenario]));
    const focal = selectCases(buildCandidates(reports));
    const output = [];
    for (let index = 0; index < focal.length; index++) {
        const item = focal[index];
        const caseId = `case-${String(index + 1).padStart(2, '0')}`;
        const focalScenario = scenarios.get(item.scenarioName);
        const baselineScenario = scenarios.get(item.baselineScenarioName);
        if (!focalScenario || !baselineScenario) {
            throw new Error(`Missing scenario definition for forensic pair ${item.pairedScenarioId}`);
        }
        output.push(cloneForensicScenario(focalScenario, {
            forensicCaseId: caseId,
            forensicRole: 'focal',
            forensicCategory: item.category
        }));
        output.push(cloneForensicScenario(baselineScenario, {
            forensicCaseId: caseId,
            forensicRole: 'exact-lossless-baseline',
            forensicCategory: item.category
        }));
    }
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${output.map(JSON.stringify).join('\n')}\n`);
    const coverage = {
        focalCases: focal.length,
        totalRuns: output.length,
        longPayloadFocalCases: focal.filter(item => item.payloadBlocks === 10000).length,
        categories: Object.fromEntries(QUOTAS.map(([category]) => [
            category, focal.filter(item => item.category === category).length
        ])),
        capacities: Array.from(new Set(focal.map(item => item.capacity))).sort((a, b) => a - b),
        buffers: Array.from(new Set(focal.map(item => item.bufferLimit))).sort((a, b) => a - b),
        placements: Array.from(new Set(focal.map(item => item.placement))).sort(),
        profiles: Array.from(new Set(focal.map(item => item.profile))).sort(),
        cases: focal
    };
    fs.writeFileSync(outPath.replace(/\.jsonl$/, '-selection.json'), JSON.stringify(coverage, null, 2));
    console.log(`Selected ${output.length} forensic runs (${focal.length} paired cases): ${outPath}`);
    return coverage;
}

if (require.main === module) {
    try {
        run(parseArgs(process.argv));
    } catch (error) {
        console.error(error.stack || error);
        process.exit(1);
    }
}

module.exports = { run, buildCandidates, selectCases };
