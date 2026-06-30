#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const readline = require('readline');
const {
    correctedScenarios,
    EXPECTED_COUNTS,
    validateCorrection
} = require('./adaptive-correction-runner');

async function main() {
    const manifest = JSON.parse(fs.readFileSync('campaign-manifest.json', 'utf8'));
    const selections = JSON.parse(fs.readFileSync('results/campaigns/full/selections.json', 'utf8'));
    let generated = 0;
    for (const [phase, expected] of Object.entries(EXPECTED_COUNTS)) {
        const scenarios = correctedScenarios(manifest, phase, selections, false);
        assert.strictEqual(scenarios.length, expected, `${phase} corrected count`);
        assert.strictEqual(new Set(scenarios.map(item => item.scenarioName)).size, expected);
        assert(scenarios.every(item => item.losslessAdmissionControl === false));
        assert(scenarios.every(item => item.enableRecovery === true));
        generated += scenarios.length;
    }
    assert.strictEqual(generated, 3720);

    let affected = 0;
    const phaseCounts = {};
    const lines = readline.createInterface({
        input: fs.createReadStream('results/campaigns/full/reports.jsonl', { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    for await (const line of lines) {
        if (!line) continue;
        const report = JSON.parse(line);
        const policy = report.experiment.policy;
        const adaptive = policy === 'selected-adaptive-oracle'
            || /^adaptive-lhs-/.test(policy)
            || /^adaptive-feedback-d(1|4|8)$/.test(policy);
        if (adaptive && report.config.losslessAdmissionControl) {
            affected++;
            phaseCounts[report.experiment.phase] = (phaseCounts[report.experiment.phase] || 0) + 1;
        }
    }
    assert.strictEqual(affected, 3720);
    assert.deepStrictEqual(phaseCounts, EXPECTED_COUNTS);

    const miniPath = 'results/campaigns/adaptive-correction-mini/reports.jsonl';
    if (fs.existsSync(miniPath)) {
        const reports = fs.readFileSync(miniPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const validation = validateCorrection(reports, true);
        assert.strictEqual(validation.valid, true);
        assert.strictEqual(new Set(reports.map(item => item.scenarioName)).size, reports.length);
    }
    console.log('Research pipeline tests passed.');
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
