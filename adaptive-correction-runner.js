#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { BARCResearchSim } = require('./barc-sim-core');
const { scenarioSet } = require('./campaign-runner');

const STAGES = ['B-training', 'B-validation', 'C', 'D', 'E'];
const EXPECTED_COUNTS = {
    'B-training': 960,
    'B-validation': 480,
    C: 1200,
    D: 960,
    E: 120
};

function parseArgs(argv) {
    const args = {
        manifest: path.join(process.cwd(), 'campaign-manifest.json'),
        base: path.join(process.cwd(), 'results', 'campaigns', 'full'),
        out: path.join(process.cwd(), 'results', 'campaigns', 'adaptive-correction'),
        phase: 'all',
        maxWallClockMs: 30 * 60 * 1000,
        maxWallClockMsE: 60 * 60 * 1000,
        resume: false,
        mini: false
    };
    for (let i = 2; i < argv.length; i++) {
        const name = normalizeArgName(argv[i].replace(/^--/, ''));
        if (['resume', 'mini'].includes(name)) args[name] = true;
        else if (argv[i].startsWith('--')) args[name] = argv[++i];
    }
    return args;
}

function normalizeArgName(name) {
    const aliases = {
        'max-wall-clock-ms': 'maxWallClockMs',
        'max-wall-clock-ms-e': 'maxWallClockMsE'
    };
    return aliases[name] || name;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendCsv(filePath, csv) {
    const body = csv.split(/\r?\n/).slice(1).filter(Boolean).join('\n');
    if (body) fs.appendFileSync(filePath, `${body}\n`);
}

function initializeOutputs(outDir, resume) {
    const files = {
        reports: path.join(outDir, 'reports.jsonl'),
        scenarios: path.join(outDir, 'scenarios.jsonl'),
        summary: path.join(outDir, 'summary.csv'),
        hosts: path.join(outDir, 'hosts.csv'),
        interfaces: path.join(outDir, 'interfaces.csv'),
        adaptive: path.join(outDir, 'adaptive.csv')
    };
    if (!resume || !fs.existsSync(files.reports)) fs.writeFileSync(files.reports, '');
    if (!resume || !fs.existsSync(files.scenarios)) fs.writeFileSync(files.scenarios, '');
    if (!resume || !fs.existsSync(files.summary)) {
        fs.writeFileSync(files.summary, `${BARCResearchSim.reportToSummaryCsv([])}\n`);
    }
    if (!resume || !fs.existsSync(files.hosts)) {
        fs.writeFileSync(files.hosts, `${BARCResearchSim.reportToHostCsv([])}\n`);
    }
    if (!resume || !fs.existsSync(files.interfaces)) {
        fs.writeFileSync(files.interfaces, 'Scenario Name,Port,Drops,Link,Hot Ticks,Max Pct,Max Blocks\n');
    }
    if (!resume || !fs.existsSync(files.adaptive)) {
        fs.writeFileSync(files.adaptive,
            'Scenario Name,Mode,Feedback ID,Collective,Source Port,Created Tick,Root Tick,Update Tick,First Applied Tick,Last Applied Tick,Rate,Status\n');
    }
    return files;
}

function isCorrectedPolicy(phase, policy) {
    if (phase === 'B-training' || phase === 'B-validation') return /^adaptive-lhs-/.test(policy);
    if (phase === 'C') return policy === 'selected-adaptive-oracle';
    if (phase === 'D') return policy === 'selected-adaptive-oracle' || /^adaptive-feedback-d(1|4|8)$/.test(policy);
    if (phase === 'E') return /^adaptive-feedback-d(1|4|8)$/.test(policy);
    return false;
}

function correctedScenarios(manifest, phase, selections, mini) {
    return scenarioSet(manifest, phase, selections, mini)
        .filter(scenario => isCorrectedPolicy(phase, scenario.experiment.policy))
        .map(scenario => {
            scenario.losslessAdmissionControl = false;
            scenario.enableRecovery = true;
            scenario.experiment.correctionVersion = 'adaptive-v2-lossy-admission';
            scenario.experiment.admissionMode = 'lossy-fifo-with-selective-recovery';
            return scenario;
        });
}

function wallClockLimitForPhase(args, phase) {
    const value = phase === 'E' ? args.maxWallClockMsE : args.maxWallClockMs;
    if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'none') return null;
    return Math.max(1, Number(value) || 0);
}

function completedNames(reports) {
    return new Set(reports.map(report => report.scenarioName));
}

function compactReport(report) {
    const copy = Object.assign({}, report);
    copy.eventLog = [];
    copy.linkUtilizationByTick = [];
    copy.dropLedger = [];
    copy.controlLedger = [];
    copy.repairLedger = [];
    copy.recoveryLatencies = [];
    copy.feedbackLedger = [];
    copy.adaptiveRateHistory = [];
    return copy;
}

function writeInterfaces(filePath, report) {
    const rows = [];
    for (const [portKey, drops] of Object.entries(report.dropsByInterface || {})) {
        rows.push([report.scenarioName, portKey, drops, '', '', '', ''].map(csvCell).join(','));
    }
    for (const [linkId, item] of Object.entries(report.hotLinks || {})) {
        rows.push([report.scenarioName, '', '', linkId, item.hotTicks, item.maxPct, item.maxBlocks]
            .map(csvCell).join(','));
    }
    if (rows.length) fs.appendFileSync(filePath, `${rows.join('\n')}\n`);
}

function writeAdaptive(filePath, report) {
    const rows = [];
    for (const item of report.feedbackLedger || []) {
        rows.push([
            report.scenarioName, 'feedback', item.feedbackId, item.collectiveId, item.sourcePortKey,
            item.createdTick, item.arrivedRootTick, item.rateUpdateTick, item.firstAppliedTick,
            item.lastAppliedTick, item.newRate, item.status
        ].map(csvCell).join(','));
    }
    for (const item of report.adaptiveRateHistory || []) {
        rows.push([
            report.scenarioName, 'oracle', '', '', '', item.tick, '', '', '', '',
            (item.rates || []).join('|'), item.reason
        ].map(csvCell).join(','));
    }
    if (rows.length) fs.appendFileSync(filePath, `${rows.join('\n')}\n`);
}

function runComplete(report) {
    return (report.collectives || []).filter(item => item.memberHosts.length > 0)
        .every(item => item.complete);
}

function runCct(report) {
    const values = (report.collectives || [])
        .filter(item => item.memberHosts.length > 0 && item.complete)
        .map(item => item.cctTicks);
    return values.length ? Math.max(...values) : null;
}

function mean(values) {
    const valid = values.filter(Number.isFinite);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : Infinity;
}

async function loadExactBaselines(baseDir) {
    const baselines = new Map();
    const stream = fs.createReadStream(path.join(baseDir, 'reports.jsonl'), { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line) continue;
        const report = JSON.parse(line);
        if (report.experiment.policy === 'advisor-exact-lossless') {
            baselines.set(report.experiment.pairedScenarioId, report);
        }
    }
    return baselines;
}

function rankPolicies(reports, phase, baselineByPair, predicate) {
    const groups = new Map();
    for (const report of reports) {
        if (report.experiment.phase !== phase || !predicate(report.experiment.policy)) continue;
        if (!groups.has(report.experiment.policy)) groups.set(report.experiment.policy, []);
        groups.get(report.experiment.policy).push(report);
    }
    return Array.from(groups.entries()).map(([policy, items]) => {
        const complete = items.filter(runComplete);
        const deltas = complete.map(report => {
            const baseline = baselineByPair.get(report.experiment.pairedScenarioId);
            return baseline ? runCct(report) - runCct(baseline) : null;
        });
        return {
            policy,
            runs: items.length,
            completeRuns: complete.length,
            completion: complete.length / items.length,
            meanPairedDeltaCct: mean(deltas),
            meanCct: mean(complete.map(runCct))
        };
    }).sort((left, right) =>
        right.completion - left.completion
        || left.meanPairedDeltaCct - right.meanPairedDeltaCct
        || left.meanCct - right.meanCct
        || left.policy.localeCompare(right.policy));
}

function deriveSelections(reports, baseSelections, baselineByPair) {
    const selections = Object.assign({}, baseSelections);
    const training = rankPolicies(reports, 'B-training', baselineByPair,
        policy => /^adaptive-lhs-/.test(policy));
    if (training.length) selections.topAdaptiveTrainingPolicies = training.slice(0, 3).map(item => item.policy);
    const validation = rankPolicies(reports, 'B-validation', baselineByPair,
        policy => /^adaptive-lhs-/.test(policy));
    if (validation.length) selections.bestAdaptiveOraclePolicy = validation[0].policy;
    const feedback = rankPolicies(reports, 'D', baselineByPair,
        policy => /^adaptive-feedback-d(1|4|8)$/.test(policy));
    if (feedback.length) selections.bestAdaptiveFeedbackPolicy = feedback[0].policy;
    return { selections, rankings: { training, validation, feedback } };
}

function validateCorrection(reports, mini) {
    const violations = [];
    const names = new Set();
    for (const report of reports) {
        if (names.has(report.scenarioName)) {
            violations.push({ type: 'duplicate-scenario', scenarioName: report.scenarioName });
        }
        names.add(report.scenarioName);
        if (report.config.losslessAdmissionControl !== false) {
            violations.push({ type: 'adaptive-lossless-admission-enabled', scenarioName: report.scenarioName });
        }
        if (!report.config.enableRecovery) {
            violations.push({ type: 'adaptive-recovery-disabled', scenarioName: report.scenarioName });
        }
        if (!runComplete(report) && !report.summary.activeAtEnd) {
            violations.push({ type: 'adaptive-incomplete-without-timeout', scenarioName: report.scenarioName });
        }
    }
    for (const report of reports.filter(item => /^adaptive-feedback-d(1|4|8)$/.test(item.experiment.policy))) {
        const expectedDelay = Number(report.experiment.feedbackDelayTicks);
        const minTicks = report.feedbackLatencySummary && report.feedbackLatencySummary.minTicks;
        if (Number.isFinite(expectedDelay)
            && Number.isFinite(minTicks)
            && minTicks < expectedDelay) {
            violations.push({
                type: 'feedback-delay-too-short',
                scenarioName: report.scenarioName,
                expectedAtLeast: expectedDelay,
                actual: minTicks
            });
        }
    }
    const stageCounts = Object.fromEntries(STAGES.map(phase => [
        phase, reports.filter(report => report.experiment.phase === phase).length
    ]));
    if (!mini) {
        for (const [phase, expected] of Object.entries(EXPECTED_COUNTS)) {
            if (stageCounts[phase] !== expected) {
                violations.push({ type: 'stage-count', phase, expected, actual: stageCounts[phase] });
            }
        }
        if (reports.length !== 3720) {
            violations.push({ type: 'total-count', expected: 3720, actual: reports.length });
        }
    }
    return { valid: violations.length === 0, reports: reports.length, stageCounts, violations };
}

function runStage(manifest, phase, selections, args, files) {
    const existingReports = readJsonl(files.reports);
    const completed = completedNames(existingReports);
    const scenarios = correctedScenarios(manifest, phase, selections, args.mini);
    if (!args.mini && scenarios.length !== EXPECTED_COUNTS[phase]) {
        throw new Error(`${phase} correction generated ${scenarios.length}; expected ${EXPECTED_COUNTS[phase]}`);
    }
    const sim = new BARCResearchSim({ enableEventLog: false });
    let executed = 0;
    const wallClockLimitMs = wallClockLimitForPhase(args, phase);
    for (const scenario of scenarios) {
        if (completed.has(scenario.scenarioName)) continue;
        scenario.storageMode = 'aggregate';
        scenario.maxWallClockMs = wallClockLimitMs;
        console.log(`[correction:${phase}] starting ${executed + 1}/${scenarios.length}: ${scenario.scenarioName}`);
        const report = sim.runScenario(scenario);
        report.experiment = scenario.experiment;
        report.experiment.timeout = report.summary.activeAtEnd;
        const feedbackLatencies = (report.feedbackLedger || [])
            .map(item => item.firstAppliedTick - item.createdTick)
            .filter(Number.isFinite);
        report.feedbackLatencySummary = {
            count: feedbackLatencies.length,
            minTicks: feedbackLatencies.length ? Math.min(...feedbackLatencies) : null,
            meanTicks: feedbackLatencies.length
                ? feedbackLatencies.reduce((sum, value) => sum + value, 0) / feedbackLatencies.length
                : null,
            maxTicks: feedbackLatencies.length ? Math.max(...feedbackLatencies) : null
        };
        if (report.config.losslessAdmissionControl !== false) {
            throw new Error(`Corrected adaptive report retained lossless admission: ${report.scenarioName}`);
        }
        writeInterfaces(files.interfaces, report);
        writeAdaptive(files.adaptive, report);
        appendCsv(files.summary, BARCResearchSim.reportToSummaryCsv([report]));
        appendCsv(files.hosts, BARCResearchSim.reportToHostCsv([report]));
        fs.appendFileSync(files.reports, `${JSON.stringify(compactReport(report))}\n`);
        fs.appendFileSync(files.scenarios, `${JSON.stringify(Object.assign({}, scenario, { advisor: undefined }))}\n`);
        executed++;
        if (report.summary.timeoutReason) {
            console.warn(`[correction:${phase}] timeout ${report.summary.timeoutReason}: ${scenario.scenarioName}`);
        }
        if (executed % 25 === 0) console.log(`[correction:${phase}] executed ${executed}/${scenarios.length}`);
    }
    return { generated: scenarios.length, executed };
}

async function run(args) {
    const manifest = readJson(path.resolve(args.manifest));
    const baseDir = path.resolve(args.base);
    const outDir = path.resolve(args.out);
    ensureDir(outDir);
    const files = initializeOutputs(outDir, args.resume);
    const baseSelections = readJson(path.join(baseDir, 'selections.json'));
    const baselineByPair = await loadExactBaselines(baseDir);
    let reports = readJsonl(files.reports);
    let derived = deriveSelections(reports, baseSelections, baselineByPair);
    let selections = derived.selections;
    const phases = args.phase === 'all' ? STAGES : args.phase.split(',').map(item => item.trim());
    const results = {};

    for (const phase of STAGES) {
        if (!phases.includes(phase)) continue;
        results[phase] = runStage(manifest, phase, selections, args, files);
        reports = readJsonl(files.reports);
        derived = deriveSelections(reports, baseSelections, baselineByPair);
        selections = derived.selections;
        fs.writeFileSync(path.join(outDir, 'selections.json'), JSON.stringify(selections, null, 2));
        fs.writeFileSync(path.join(outDir, 'selection-rankings.json'),
            JSON.stringify(derived.rankings, null, 2));
    }

    reports = readJsonl(files.reports);
    const validation = validateCorrection(reports, args.mini);
    fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify(validation, null, 2));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 'barc-adaptive-correction-v1',
        generatedAt: new Date().toISOString(),
        sourceCampaign: baseDir,
        correction: 'Adaptive oracle and feedback use lossy FIFO admission with selective recovery.',
        phases,
        wallClockLimits: {
            defaultMs: wallClockLimitForPhase(args, 'C'),
            phaseEMs: wallClockLimitForPhase(args, 'E')
        },
        expectedFullRunCount: 3720,
        results,
        selections
    }, null, 2));
    console.log(`Adaptive correction output: ${outDir}`);
    return { validation, selections, results };
}

if (require.main === module) {
    run(parseArgs(process.argv)).catch(error => {
        console.error(error.stack || error);
        process.exit(1);
    });
}

module.exports = {
    run,
    correctedScenarios,
    deriveSelections,
    isCorrectedPolicy,
    validateCorrection,
    EXPECTED_COUNTS
};
