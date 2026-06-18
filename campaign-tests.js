#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const {
    scenarioSet,
    latinHypercube,
    buildProfileColors,
    parseShard
} = require('./campaign-runner');
const { BARCResearchSim } = require('./barc-sim-core');

const manifest = JSON.parse(fs.readFileSync('campaign-manifest.json', 'utf8'));
const selections = {
    bestFixedAlphaPolicy: 'advisor-overdrive-a1.05',
    topAdaptiveTrainingPolicies: ['adaptive-lhs-01', 'adaptive-lhs-02', 'adaptive-lhs-03'],
    bestAdaptiveOraclePolicy: 'adaptive-lhs-01',
    bestAdaptiveFeedbackPolicy: 'adaptive-feedback-d1'
};

for (const [phase, config] of Object.entries(manifest.phases)) {
    const scenarios = scenarioSet(manifest, phase, selections, false);
    assert.strictEqual(scenarios.length, config.targetRuns, `${phase} count mismatch`);
}

const lhsA = latinHypercube(manifest);
const lhsB = latinHypercube(manifest);
assert.deepStrictEqual(lhsA, lhsB);
assert.strictEqual(lhsA.length, 12);

const heterogeneous = buildProfileColors('global-spread', [2, 6, 8], 1);
assert.strictEqual(heterogeneous.filter(value => value === 0).length, 2);
assert.strictEqual(heterogeneous.filter(value => value === 1).length, 6);
assert.strictEqual(heterogeneous.filter(value => value === 2).length, 8);

const paired = scenarioSet(manifest, 'A', selections, true);
assert.strictEqual(new Set(paired.map(item => item.experiment.pairedScenarioId)).size, 1);
assert.strictEqual(new Set(paired.map(item => item.scenarioName)).size, paired.length);

const shard = parseShard('2/4');
assert.deepStrictEqual(shard, { index: 1, total: 4 });
const shardUnion = new Set();
for (let index = 0; index < 4; index++) {
    paired.forEach((scenario, scenarioIndex) => {
        if (scenarioIndex % 4 === index) shardUnion.add(scenario.scenarioName);
    });
}
assert.strictEqual(shardUnion.size, paired.length);

const feedbackScenarios = scenarioSet(manifest, 'D', selections, true);
const appliedDelays = {};
for (const policy of ['adaptive-feedback-d1', 'adaptive-feedback-d4', 'adaptive-feedback-d8']) {
    const scenario = feedbackScenarios.find(item => item.experiment.policy === policy);
    scenario.payloadBlocks = 100;
    scenario.maxTicks = 50000;
    scenario.storageMode = 'aggregate';
    const report = new BARCResearchSim({ enableEventLog: false }).runScenario(scenario);
    assert(report.collectives.filter(c => c.memberHosts.length > 0).every(c => c.complete));
    assert(report.summary.totalFeedbackReports > 0);
    assert(report.summary.totalRateUpdates > 0);
    assert(report.summary.totalAdaptiveControlBlocks > 0);
    const delays = report.feedbackLedger
        .map(item => item.firstAppliedTick - item.createdTick)
        .filter(Number.isFinite);
    appliedDelays[policy] = Math.min(...delays);
}
assert(appliedDelays['adaptive-feedback-d8'] >= appliedDelays['adaptive-feedback-d4']);
assert(appliedDelays['adaptive-feedback-d4'] >= appliedDelays['adaptive-feedback-d1']);

const recoveryScenario = paired.find(item => item.experiment.policy === 'max-rate-recovery');
recoveryScenario.payloadBlocks = 50;
recoveryScenario.maxTicks = 50000;
const fullScenario = JSON.parse(JSON.stringify(recoveryScenario));
fullScenario.storageMode = 'full';
const aggregateScenario = JSON.parse(JSON.stringify(recoveryScenario));
aggregateScenario.storageMode = 'aggregate';
const fullReport = new BARCResearchSim({ enableEventLog: false }).runScenario(fullScenario);
const aggregateReport = new BARCResearchSim({ enableEventLog: false }).runScenario(aggregateScenario);
assert.strictEqual(aggregateReport.summary.ticks, fullReport.summary.ticks);
assert.strictEqual(aggregateReport.summary.totalDrops, fullReport.summary.totalDrops);
assert.strictEqual(aggregateReport.summary.totalRepairsInjected, fullReport.summary.totalRepairsInjected);
assert.strictEqual(aggregateReport.dropLedger.length, 0);
assert.strictEqual(aggregateReport.repairLedger.length, 0);
assert.strictEqual(aggregateReport.controlLedger.length, 0);

console.log('Campaign tests passed.');
