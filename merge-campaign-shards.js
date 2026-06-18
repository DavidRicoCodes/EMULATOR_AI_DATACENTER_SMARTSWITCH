#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeCampaign } = require('./campaign-analysis');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function mergeJsonl(inputs, fileName, keyName) {
    const items = new Map();
    for (const input of inputs) {
        const filePath = path.join(input, fileName);
        if (!fs.existsSync(filePath)) continue;
        for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
            const item = JSON.parse(line);
            items.set(item[keyName], item);
        }
    }
    return Array.from(items.values());
}

function mergeCsv(inputs, fileName) {
    let header = null;
    const rows = new Set();
    for (const input of inputs) {
        const filePath = path.join(input, fileName);
        if (!fs.existsSync(filePath)) continue;
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
        if (!header && lines.length) header = lines[0];
        for (const line of lines.slice(1)) rows.add(line);
    }
    return header ? [header].concat(Array.from(rows)).join('\n') + '\n' : '';
}

function run(argv) {
    const outIndex = argv.indexOf('--out');
    if (outIndex < 0 || !argv[outIndex + 1]) {
        throw new Error('Usage: node merge-campaign-shards.js --out <dir> <shard-dir>...');
    }
    const outDir = path.resolve(argv[outIndex + 1]);
    const inputs = argv.slice(2).filter((value, index, values) =>
        value !== '--out' && values[index - 1] !== '--out'
    ).map(value => path.resolve(value));
    ensureDir(outDir);

    const reports = mergeJsonl(inputs, 'reports.jsonl', 'scenarioName');
    const scenarios = mergeJsonl(inputs, 'scenarios.jsonl', 'scenarioName');
    fs.writeFileSync(path.join(outDir, 'reports.jsonl'), reports.map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'scenarios.jsonl'), scenarios.map(JSON.stringify).join('\n') + '\n');
    for (const fileName of ['summary.csv', 'hosts.csv', 'interfaces.csv', 'adaptive.csv']) {
        fs.writeFileSync(path.join(outDir, fileName), mergeCsv(inputs, fileName));
    }
    const selections = inputs.map(input => path.join(input, 'selections.json'))
        .find(filePath => fs.existsSync(filePath));
    if (selections) fs.copyFileSync(selections, path.join(outDir, 'selections.json'));
    analyzeCampaign(outDir, { bootstrapSamples: 10000 });
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 'barc-campaign-merged-v1',
        mergedAt: new Date().toISOString(),
        inputs,
        reports: reports.length,
        scenarios: scenarios.length
    }, null, 2));
    console.log(`Merged ${reports.length} reports into ${outDir}`);
}

if (require.main === module) {
    try {
        run(process.argv);
    } catch (error) {
        console.error(error.stack || error);
        process.exit(1);
    }
}
