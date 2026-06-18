#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { BARCResearchSim } = require('./barc-sim-core');
const { generateScenarios } = require('./experiment-runner');

const scenarios = generateScenarios({
    suite: 'smoke',
    capacity: 10,
    maxTicks: 50000
}).scenarios;

function runScenario(name) {
    const scenario = scenarios.find(item => item.scenarioName === name);
    assert(scenario, `Missing generated scenario: ${name}`);
    return new BARCResearchSim({ enableEventLog: false }).runScenario(scenario);
}

function activeCollectives(report) {
    return report.collectives.filter(item => item.memberHosts.length > 0);
}

function assertComplete(report) {
    assert(
        activeCollectives(report).every(item => item.complete),
        `${report.scenarioName} did not reach collective completion`
    );
    assert.strictEqual(report.summary.pendingDropReports, 0);
    assert.strictEqual(report.summary.pendingSourceRepairs, 0);
    assert.strictEqual(report.summary.activeAtEnd, false);
}

const fractional = runScenario(
    'smoke__advisor-exact-lossless__global-spread__g8__c2__p100__b16__s1'
);
assertComplete(fractional);
assert.strictEqual(fractional.summary.totalDrops, 0);
assert.strictEqual(fractional.summary.totalRepairsInjected, 0);
assert(fractional.config.tenantRates[0] > 0 && fractional.config.tenantRates[0] < 1);

const recovered = runScenario(
    'smoke__max-rate-recovery__global-spread__g8__c2__p100__b16__s1'
);
assertComplete(recovered);
assert(recovered.summary.totalDrops > 0);
assert(recovered.summary.totalRepairsInjected > 0);
assert(recovered.summary.retransmittedDropReports > 0);
assert.strictEqual(recovered.summary.unrecoveredPackets, 0);

const overdrive = runScenario(
    'smoke__advisor-overdrive-a1.10__global-spread__g8__c2__p100__b16__s1'
);
assertComplete(overdrive);
assert(overdrive.summary.totalDrops > 0);
assert(overdrive.summary.originalTxCompleteTick < fractional.summary.originalTxCompleteTick);

const perSource = runScenario(
    'smoke__per-source-lossless__random-balanced__g8__c2__p100__b16__s1'
);
assertComplete(perSource);
assert.strictEqual(perSource.summary.totalDrops, 0);
assert(Object.keys(perSource.config.hostRateOverrides).length > 0);

const adaptive = runScenario(
    'smoke__adaptive-advisor-overdrive__global-spread__g8__c2__p100__b16__s1'
);
assertComplete(adaptive);
assert(adaptive.adaptiveRateHistory.length > 0);
assert(adaptive.summary.totalDrops < overdrive.summary.totalDrops);

const noRecovery = runScenario(
    'smoke__no-recovery-max-rate__rack-compact__g4__c1__p100__b16__s1'
);
assert(activeCollectives(noRecovery).some(item => !item.complete));
assert.strictEqual(noRecovery.summary.totalRepairsInjected, 0);
assert.strictEqual(noRecovery.summary.totalControlReports, 0);

console.log('BARC simulation tests passed.');
