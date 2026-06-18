#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BARCResearchSim, COLOR_NAMES } = require('./barc-sim-core');
const {
    buildPolicyScenario,
    buildAdvisor,
    orderHosts,
    HOSTS,
    POLICIES,
    DETERMINISTIC_PLACEMENTS
} = require('./experiment-runner');
const { analyzeCampaign } = require('./campaign-analysis');

const ALL_PROFILES = [
    [2], [4], [8], [12], [16], [2, 2], [4, 4], [8, 8], [2, 2, 2, 2], [4, 4, 4, 4],
    [2, 4], [4, 8], [2, 6, 8], [2, 4, 10], [2, 2, 4, 8], [2, 4, 4, 6]
];

function parseArgs(argv) {
    const args = {
        manifest: path.join(process.cwd(), 'campaign-manifest.json'),
        phase: 'all',
        out: path.join(process.cwd(), 'results', 'campaigns', 'multicast-adaptive-2026'),
        shard: '1/1',
        resume: false,
        storageMode: 'aggregate',
        includeTemporal: false,
        includeEventLog: false,
        includeLedgersInReports: false
    };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        if (!key.startsWith('--')) continue;
        const name = key.slice(2);
        if (['resume', 'includeTemporal', 'includeEventLog', 'includeLedgersInReports', 'mini'].includes(name)) {
            args[name] = true;
        } else {
            const normalized = {
                'scenario-file': 'scenarioFile',
                'storage-mode': 'storageMode'
            }[name] || name;
            args[normalized] = argv[++i];
        }
    }
    return args;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function profileId(profile) {
    return profile.join('-');
}

function makeRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function shuffle(values, seed) {
    const out = values.slice();
    const rng = makeRng(seed);
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function buildProfileColors(placement, profile, seed) {
    if (profile.reduce((sum, value) => sum + value, 0) > HOSTS.length) return null;
    const colors = Array(HOSTS.length).fill(null);
    const ordered = orderHosts(placement, seed);
    let cursor = 0;
    for (let color = 0; color < profile.length; color++) {
        for (let member = 0; member < profile[color]; member++) {
            colors[ordered[cursor++]] = color;
        }
    }
    return colors;
}

function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function stratifiedValue(values, key) {
    return values[hashText(key) % values.length];
}

function latinHypercube(manifest) {
    const search = manifest.adaptiveSearch;
    const names = Object.keys(search.ranges);
    const permutations = {};
    for (let index = 0; index < names.length; index++) {
        permutations[names[index]] = shuffle(
            Array.from({ length: search.samples }, (_, item) => item),
            search.latinHypercubeSeed + index * 101
        );
    }
    return Array.from({ length: search.samples }, (_, sample) => {
        const config = {};
        for (const name of names) {
            const [low, high] = search.ranges[name];
            const bucket = permutations[name][sample];
            const fraction = (bucket + 0.5) / search.samples;
            config[name] = low + fraction * (high - low);
        }
        config.increaseEveryTicks = 4;
        config.minMultiplier = 1;
        config.maxMultiplier = config.initialMultiplier;
        config.enabled = true;
        return { id: `adaptive-lhs-${String(sample + 1).padStart(2, '0')}`, config };
    });
}

function baseInput(manifest, phase, placement, profile, seed, payloadBlocks, capacity, bufferLimit) {
    const hostColors = buildProfileColors(placement, profile, seed);
    const pairedScenarioId = [
        phase, placement, `profile-${profileId(profile)}`, `seed-${seed}`,
        `payload-${payloadBlocks}`, `capacity-${capacity}`, `buffer-${bufferLimit}`
    ].join('__');
    return {
        suite: `campaign-${phase}`,
        phase,
        placement,
        profile: profileId(profile),
        groupSize: Math.max(...profile),
        collectiveCount: profile.length,
        payloadBlocks,
        bufferLimit,
        capacity,
        seed,
        maxTicks: manifest.maxTicks,
        hostColors,
        pairedScenarioId
    };
}

function renamePolicyScenario(scenario, base, policy) {
    scenario.scenarioName = `${base.pairedScenarioId}__policy-${policy}`;
    scenario.storageMode = 'aggregate';
    scenario.experiment = Object.assign({}, scenario.experiment, {
        phase: base.phase,
        policy,
        profile: base.profile,
        pairedScenarioId: base.pairedScenarioId,
        placement: base.placement,
        seed: base.seed,
        payloadBlocks: base.payloadBlocks,
        capacity: base.capacity,
        bufferLimit: base.bufferLimit
    });
    return scenario;
}

function makePolicyScenario(manifest, base, advisor, policy, adaptiveConfigs) {
    if (POLICIES.includes(policy)) {
        return renamePolicyScenario(buildPolicyScenario(base, policy, advisor), base, policy);
    }

    const exact = renamePolicyScenario(
        buildPolicyScenario(base, 'advisor-exact-lossless', advisor),
        base,
        policy
    );
    const adaptive = adaptiveConfigs.find(item => item.id === policy);
    if (adaptive) {
        exact.adaptiveRateControl = Object.assign({}, adaptive.config);
        exact.experiment.adaptiveConfig = Object.assign({}, adaptive.config);
        return exact;
    }

    const feedbackMatch = /^adaptive-feedback-d(1|4|8)$/.exec(policy);
    if (feedbackMatch) {
        const oracle = adaptiveConfigs.find(item => item.id === 'selected-adaptive-oracle');
        const cfg = oracle ? oracle.config : {
            initialMultiplier: 1.2,
            minMultiplier: 1,
            maxMultiplier: 1.2,
            decreaseFactor: 0.8,
            increaseStep: 0.02,
            increaseEveryTicks: 4,
            queueHighWatermark: 0.75
        };
        exact.adaptiveFeedback = {
            enabled: true,
            processingDelayTicks: Number(feedbackMatch[1]),
            initialMultiplier: cfg.initialMultiplier,
            minMultiplier: cfg.minMultiplier,
            maxMultiplier: cfg.maxMultiplier,
            decreaseFactor: cfg.decreaseFactor,
            increaseStep: cfg.increaseStep,
            increaseEveryTicks: cfg.increaseEveryTicks,
            highWatermark: cfg.queueHighWatermark,
            lowWatermark: Math.max(0.1, cfg.queueHighWatermark - 0.2),
            coalesceTicks: 8
        };
        exact.experiment.feedbackDelayTicks = Number(feedbackMatch[1]);
        return exact;
    }
    throw new Error(`Unknown campaign policy: ${policy}`);
}

function scenarioSet(manifest, phase, selections, mini) {
    const adaptiveSamples = latinHypercube(manifest);
    const adaptiveMap = new Map(adaptiveSamples.map(item => [item.id, item]));
    const selectedOracleId = selections.bestAdaptiveOraclePolicy || adaptiveSamples[0].id;
    const selectedOracle = adaptiveMap.get(selectedOracleId) || adaptiveSamples[0];
    adaptiveSamples.push({ id: 'selected-adaptive-oracle', config: selectedOracle.config });
    const bestFixed = selections.bestFixedAlphaPolicy || 'advisor-overdrive-a1.05';
    const bestFeedback = selections.bestAdaptiveFeedbackPolicy || 'adaptive-feedback-d1';
    const scenarios = [];

    const add = (base, policies) => {
        const advisor = buildAdvisor(base.hostColors, base.capacity, base.bufferLimit, base.seed);
        for (const policy of policies) {
            let resolved = policy;
            if (policy === 'selected-fixed-alpha') resolved = bestFixed;
            if (policy === 'selected-adaptive-oracle') resolved = 'selected-adaptive-oracle';
            if (policy === 'selected-adaptive-feedback') resolved = bestFeedback;
            scenarios.push(makePolicyScenario(manifest, base, advisor, resolved, adaptiveSamples));
        }
    };

    const cap = values => mini ? values.slice(0, 1) : values;
    if (phase === 'A') {
        const environments = [
            ...manifest.placements.map(placement => ({ placement, seed: 1 })),
            ...[1, 2, 3, 4, 5].map(seed => ({ placement: 'random-balanced', seed }))
        ];
        for (const env of cap(environments)) {
            for (const profile of cap(manifest.profiles.screening)) {
                for (const buffer of cap([8, 16, 64])) {
                    const base = baseInput(manifest, phase, env.placement, profile, env.seed, 100, 10, buffer);
                    add(base, POLICIES);
                }
            }
        }
    } else if (phase === 'B-training') {
        for (const seed of cap(Array.from({ length: 10 }, (_, i) => i + 6))) {
            for (const profile of cap(manifest.profiles.screening)) {
                const base = baseInput(manifest, phase, 'random-balanced', profile, seed, 100, 10, 16);
                add(base, adaptiveSamples.slice(0, 12).map(item => item.id)
                    .concat(['advisor-exact-lossless', 'per-source-lossless']));
            }
        }
    } else if (phase === 'B-validation') {
        const top = selections.topAdaptiveTrainingPolicies || adaptiveSamples.slice(0, 3).map(item => item.id);
        const profiles = manifest.profiles.equal.concat(manifest.profiles.heterogeneous);
        for (const seed of cap(Array.from({ length: 10 }, (_, i) => i + 16))) {
            for (const profile of cap(profiles)) {
                const base = baseInput(manifest, phase, 'random-balanced', profile, seed, 100, 10, 16);
                add(base, top.concat(['advisor-exact-lossless', 'per-source-lossless', 'selected-fixed-alpha']));
            }
        }
    } else if (phase === 'C') {
        const profiles = manifest.profiles.equal.concat(manifest.profiles.heterogeneous);
        for (const seed of cap(Array.from({ length: 30 }, (_, i) => i + 26))) {
            for (let index = 0; index < cap(profiles).length; index++) {
                const profile = cap(profiles)[index];
                const key = `${seed}:${profileId(profile)}`;
                const capacity = stratifiedValue(manifest.capacities, key);
                const buffer = stratifiedValue(manifest.buffers, `${key}:buffer`);
                add(baseInput(manifest, phase, 'random-balanced', profile, seed, 100, capacity, buffer), [
                    'advisor-exact-lossless', 'per-source-lossless', 'selected-adaptive-oracle',
                    'selected-fixed-alpha', 'max-rate-recovery', 'member-formula-rate', 'no-recovery-max-rate'
                ]);
                add(baseInput(manifest, phase, 'random-balanced', profile, seed, 1000, capacity, buffer), [
                    'advisor-exact-lossless', 'per-source-lossless', 'selected-adaptive-oracle',
                    'selected-fixed-alpha', 'member-formula-rate'
                ]);
            }
        }
        for (const placement of cap(manifest.placements)) {
            for (const profile of cap(profiles)) {
                for (const capacity of cap(manifest.capacities)) {
                    const buffer = stratifiedValue(manifest.buffers, `${placement}:${profileId(profile)}:${capacity}`);
                    add(baseInput(manifest, phase, placement, profile, 1, 1000, capacity, buffer), [
                        'advisor-exact-lossless', 'per-source-lossless', 'selected-adaptive-oracle',
                        'selected-fixed-alpha', 'member-formula-rate'
                    ]);
                }
            }
        }
    } else if (phase === 'D') {
        for (const seed of cap(Array.from({ length: 30 }, (_, i) => i + 26))) {
            for (const profile of cap(manifest.profiles.stress)) {
                const key = `${seed}:${profileId(profile)}:feedback`;
                const capacity = stratifiedValue(manifest.capacities, key);
                const buffer = stratifiedValue(manifest.buffers, `${key}:buffer`);
                add(baseInput(manifest, phase, 'random-balanced', profile, seed, 1000, capacity, buffer), [
                    'advisor-exact-lossless', 'selected-adaptive-oracle',
                    'adaptive-feedback-d1', 'adaptive-feedback-d4', 'adaptive-feedback-d8'
                ]);
            }
        }
    } else if (phase === 'E') {
        for (const seed of cap(Array.from({ length: 10 }, (_, i) => i + 56))) {
            for (const profile of cap(manifest.profiles.long)) {
                const key = `${seed}:${profileId(profile)}:long`;
                const capacity = stratifiedValue(manifest.capacities, key);
                const buffer = stratifiedValue(manifest.buffers, `${key}:buffer`);
                add(baseInput(manifest, phase, 'random-balanced', profile, seed, 10000, capacity, buffer), [
                    'advisor-exact-lossless', 'per-source-lossless',
                    'selected-fixed-alpha', 'selected-adaptive-feedback'
                ]);
            }
        }
    } else {
        throw new Error(`Unknown campaign phase: ${phase}`);
    }
    return scenarios;
}

function parseShard(value) {
    const match = /^(\d+)\/(\d+)$/.exec(value);
    if (!match) throw new Error(`Invalid shard "${value}", expected i/n`);
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (index < 1 || index > total) throw new Error(`Shard index must be between 1 and ${total}`);
    return { index: index - 1, total };
}

function compactReport(report, args) {
    const copy = Object.assign({}, report);
    if (!args.includeEventLog) copy.eventLog = [];
    if (!args.includeTemporal) copy.linkUtilizationByTick = [];
    if (!args.includeLedgersInReports) {
        copy.dropLedger = [];
        copy.controlLedger = [];
        copy.repairLedger = [];
        copy.recoveryLatencies = [];
        copy.feedbackLedger = [];
        copy.adaptiveRateHistory = [];
    }
    return copy;
}

function csvWithoutHeader(csv) {
    return csv.split(/\r?\n/).slice(1).filter(Boolean).join('\n');
}

function appendCsv(filePath, csv) {
    const body = csvWithoutHeader(csv);
    if (body) fs.appendFileSync(filePath, `${body}\n`);
}

function csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeInterfaces(filePath, report) {
    const rows = [];
    for (const [portKey, drops] of Object.entries(report.dropsByInterface || {})) {
        rows.push([report.scenarioName, portKey, drops, '', '', '', ''].map(csvCell).join(','));
    }
    for (const [linkId, item] of Object.entries(report.hotLinks || {})) {
        rows.push([report.scenarioName, '', '', linkId, item.hotTicks, item.maxPct, item.maxBlocks].map(csvCell).join(','));
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

function initializeOutputs(outDir, resume) {
    const files = {
        reports: path.join(outDir, 'reports.jsonl'),
        summary: path.join(outDir, 'summary.csv'),
        hosts: path.join(outDir, 'hosts.csv'),
        interfaces: path.join(outDir, 'interfaces.csv'),
        adaptive: path.join(outDir, 'adaptive.csv')
    };
    if (!resume || !fs.existsSync(files.reports)) fs.writeFileSync(files.reports, '');
    if (!resume || !fs.existsSync(files.summary)) fs.writeFileSync(files.summary, `${BARCResearchSim.reportToSummaryCsv([])}\n`);
    if (!resume || !fs.existsSync(files.hosts)) fs.writeFileSync(files.hosts, `${BARCResearchSim.reportToHostCsv([])}\n`);
    if (!resume || !fs.existsSync(files.interfaces)) fs.writeFileSync(files.interfaces, 'Scenario Name,Port,Drops,Link,Hot Ticks,Max Pct,Max Blocks\n');
    if (!resume || !fs.existsSync(files.adaptive)) fs.writeFileSync(files.adaptive, 'Scenario Name,Mode,Feedback ID,Collective,Source Port,Created Tick,Root Tick,Update Tick,First Applied Tick,Last Applied Tick,Rate,Status\n');
    return files;
}

function completedScenarioNames(filePath) {
    if (!fs.existsSync(filePath)) return new Set();
    const names = new Set();
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        names.add(JSON.parse(line).scenarioName);
    }
    return names;
}

function runPhase(manifest, phase, selections, args, scenarioOverride) {
    const outDir = path.resolve(args.out);
    ensureDir(outDir);
    const shard = parseShard(args.shard);
    const allScenarios = scenarioOverride || scenarioSet(manifest, phase, selections, args.mini);
    const expected = manifest.phases[phase] && manifest.phases[phase].targetRuns;
    if (!scenarioOverride && !args.mini && expected !== undefined && allScenarios.length !== expected) {
        throw new Error(`${phase} generated ${allScenarios.length} scenarios, expected ${expected}`);
    }
    const scenarios = allScenarios.filter((_, index) => index % shard.total === shard.index);
    const files = initializeOutputs(outDir, args.resume || fs.existsSync(path.join(outDir, 'reports.jsonl')));
    const completed = completedScenarioNames(files.reports);
    fs.writeFileSync(path.join(outDir, `scenarios-${phase}-shard-${shard.index + 1}-of-${shard.total}.jsonl`),
        scenarios.map(scenario => JSON.stringify(Object.assign({}, scenario, { advisor: undefined }))).join('\n') + '\n');

    const sim = new BARCResearchSim({ enableEventLog: args.includeEventLog });
    let executed = 0;
    for (const scenario of scenarios) {
        if (completed.has(scenario.scenarioName)) continue;
        scenario.storageMode = args.storageMode;
        const report = sim.runScenario(scenario);
        report.experiment = scenario.experiment;
        report.experiment.timeout = report.summary.activeAtEnd;
        writeInterfaces(files.interfaces, report);
        writeAdaptive(files.adaptive, report);
        appendCsv(files.summary, BARCResearchSim.reportToSummaryCsv([report]));
        appendCsv(files.hosts, BARCResearchSim.reportToHostCsv([report]));
        fs.appendFileSync(files.reports, `${JSON.stringify(compactReport(report, args))}\n`);
        executed++;
        if (executed % 25 === 0) console.log(`[${phase}] executed ${executed}/${scenarios.length}`);
    }
    return { generated: allScenarios.length, shardScenarios: scenarios.length, executed };
}

function forensicScenarioSelection(outDir) {
    const reports = fs.readFileSync(path.join(outDir, 'reports.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const scenarioFiles = fs.readdirSync(outDir).filter(name => /^scenarios-.*\.jsonl$/.test(name));
    const scenarios = new Map();
    for (const file of scenarioFiles) {
        for (const line of fs.readFileSync(path.join(outDir, file), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const scenario = JSON.parse(line);
            scenarios.set(scenario.scenarioName, scenario);
        }
    }
    const selected = new Set();
    for (const report of reports) {
        if (report.summary.activeAtEnd || report.collectives.some(c => c.memberHosts.length > 0 && !c.complete)) {
            selected.add(report.scenarioName);
        }
    }
    const pairsPath = path.join(outDir, 'paired-comparisons.csv');
    if (fs.existsSync(pairsPath)) {
        const lines = fs.readFileSync(pairsPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
        const rows = lines.map(line => {
            const parts = line.split(',');
            return { pairedId: parts[0], policy: parts[2], delta: Number(parts[12]) };
        }).filter(row => Number.isFinite(row.delta));
        rows.sort((a, b) => a.delta - b.delta);
        const count = Math.max(1, Math.ceil(rows.length * 0.01));
        for (const row of rows.slice(0, count).concat(rows.slice(-count))) {
            const report = reports.find(item => item.experiment.pairedScenarioId === row.pairedId && item.experiment.policy === row.policy);
            if (report) selected.add(report.scenarioName);
        }
        for (const row of rows.slice().sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta)).slice(0, 10)) {
            const report = reports.find(item => item.experiment.pairedScenarioId === row.pairedId && item.experiment.policy === row.policy);
            if (report) selected.add(report.scenarioName);
        }
    }
    const representative = new Set();
    for (const report of reports) {
        const key = `${report.experiment.profile}:${report.experiment.policy}`;
        if (!representative.has(key)) {
            representative.add(key);
            selected.add(report.scenarioName);
        }
    }
    const output = Array.from(selected).map(name => scenarios.get(name)).filter(Boolean);
    fs.writeFileSync(path.join(outDir, 'forensic-scenarios.jsonl'), output.map(JSON.stringify).join('\n') + '\n');
    return output.length;
}

function consolidateScenarioFiles(outDir) {
    const files = fs.readdirSync(outDir).filter(name => /^scenarios-.*\.jsonl$/.test(name));
    const scenarios = new Map();
    for (const file of files) {
        for (const line of fs.readFileSync(path.join(outDir, file), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const scenario = JSON.parse(line);
            scenarios.set(scenario.scenarioName, scenario);
        }
    }
    fs.writeFileSync(path.join(outDir, 'scenarios.jsonl'),
        Array.from(scenarios.values()).map(JSON.stringify).join('\n') + (scenarios.size ? '\n' : ''));
    return scenarios.size;
}

function run(args) {
    const manifest = readJson(path.resolve(args.manifest));
    const outDir = path.resolve(args.out);
    ensureDir(outDir);
    if (args.scenarioFile) {
        const scenarios = fs.readFileSync(path.resolve(args.scenarioFile), 'utf8')
            .split(/\r?\n/).filter(Boolean).map(JSON.parse);
        args.storageMode = 'full';
        args.includeTemporal = true;
        args.includeLedgersInReports = true;
        const result = runPhase(manifest, 'forensic', {}, args, scenarios);
        analyzeCampaign(outDir, { bootstrapSamples: 10000 });
        return { forensic: result };
    }
    const phases = args.phase === 'all'
        ? ['A', 'B-training', 'B-validation', 'C', 'D', 'E']
        : args.phase.split(',');
    let selections = fs.existsSync(path.join(outDir, 'selections.json'))
        ? readJson(path.join(outDir, 'selections.json'))
        : {};
    const results = {};
    for (const phase of phases) {
        results[phase] = runPhase(manifest, phase, selections, args);
        if (parseShard(args.shard).total === 1) {
            selections = analyzeCampaign(outDir, { bootstrapSamples: 500 }).selections;
        }
    }
    if (parseShard(args.shard).total === 1) {
        analyzeCampaign(outDir, { bootstrapSamples: 10000 });
        forensicScenarioSelection(outDir);
    }
    const consolidatedScenarios = consolidateScenarioFiles(outDir);
    const runManifest = {
        schemaVersion: 'barc-campaign-run-v1',
        campaign: manifest,
        generatedAt: new Date().toISOString(),
        phases,
        shard: args.shard,
        storageMode: args.storageMode,
        results,
        selections
    };
    runManifest.consolidatedScenarios = consolidatedScenarios;
    fs.writeFileSync(path.join(outDir, `run-manifest-${args.shard.replace('/', '-of-')}.json`), JSON.stringify(runManifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(runManifest, null, 2));
    console.log(`Campaign output: ${outDir}`);
    return results;
}

if (require.main === module) {
    try {
        run(parseArgs(process.argv));
    } catch (error) {
        console.error(error.stack || error);
        process.exit(1);
    }
}

module.exports = {
    run,
    scenarioSet,
    latinHypercube,
    buildProfileColors,
    parseShard
};
