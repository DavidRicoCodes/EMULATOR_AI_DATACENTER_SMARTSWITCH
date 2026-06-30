#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { analyzeCampaign } = require('./campaign-analysis');

function parseArgs(argv) {
    const args = {
        base: path.join(process.cwd(), 'results', 'campaigns', 'full'),
        correction: path.join(process.cwd(), 'results', 'campaigns', 'adaptive-correction'),
        out: path.join(process.cwd(), 'results', 'campaigns', 'final-corrected')
    };
    for (let i = 2; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        args[argv[i].slice(2)] = argv[++i];
    }
    return args;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonlMap(filePath) {
    const result = new Map();
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        const item = JSON.parse(line);
        if (result.has(item.scenarioName)) throw new Error(`Duplicate correction row: ${item.scenarioName}`);
        result.set(item.scenarioName, item);
    }
    return result;
}

function isAdaptivePolicy(policy) {
    return policy === 'adaptive-advisor-overdrive'
        || policy === 'selected-adaptive-oracle'
        || /^adaptive-lhs-/.test(policy)
        || /^adaptive-feedback-d(1|4|8)$/.test(policy);
}

async function rebuildJsonl(basePath, outPath, removedNames, additions) {
    const output = fs.createWriteStream(outPath, { encoding: 'utf8' });
    const preservedNames = new Set();
    let removed = 0;
    let rows = 0;
    const lines = readline.createInterface({
        input: fs.createReadStream(basePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    for await (const line of lines) {
        if (!line) continue;
        const item = JSON.parse(line);
        if (removedNames.has(item.scenarioName)) {
            removed++;
            continue;
        }
        if (preservedNames.has(item.scenarioName)) {
            throw new Error(`Duplicate preserved row: ${item.scenarioName}`);
        }
        preservedNames.add(item.scenarioName);
        output.write(`${JSON.stringify(item)}\n`);
        rows++;
    }
    for (const [scenarioName, item] of additions.entries()) {
        if (preservedNames.has(scenarioName)) {
            throw new Error(`Corrected row collides with a valid preserved row: ${scenarioName}`);
        }
        output.write(`${JSON.stringify(item)}\n`);
        rows++;
    }
    await new Promise(resolve => output.end(resolve));
    return { rows, removed, preserved: preservedNames.size, added: additions.size };
}

async function replaceCsv(basePath, correctionPath, outPath, replacementNames) {
    const output = fs.createWriteStream(outPath, { encoding: 'utf8' });
    const baseLines = readline.createInterface({
        input: fs.createReadStream(basePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    let first = true;
    let kept = 0;
    for await (const line of baseLines) {
        if (first) {
            output.write(`${line}\n`);
            first = false;
            continue;
        }
        if (!line) continue;
        const scenarioName = line.split(',', 1)[0].replace(/^"|"$/g, '');
        if (replacementNames.has(scenarioName)) continue;
        output.write(`${line}\n`);
        kept++;
    }
    if (fs.existsSync(correctionPath)) {
        const correctionLines = readline.createInterface({
            input: fs.createReadStream(correctionPath, { encoding: 'utf8' }),
            crlfDelay: Infinity
        });
        let correctionFirst = true;
        for await (const line of correctionLines) {
            if (correctionFirst) {
                correctionFirst = false;
                continue;
            }
            if (line) output.write(`${line}\n`);
        }
    }
    await new Promise(resolve => output.end(resolve));
    return kept;
}

async function invalidBaseNames(filePath) {
    const names = new Set();
    const lines = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    for await (const line of lines) {
        if (!line) continue;
        const report = JSON.parse(line);
        if (isAdaptivePolicy(report.experiment.policy) && report.config.losslessAdmissionControl) {
            names.add(report.scenarioName);
        }
    }
    return names;
}

async function validateCanonical(filePath, correctionNames, removedBaseNames) {
    const names = new Set();
    const replacedSeen = new Set();
    const removedStillPresent = new Set();
    const phaseCounts = {};
    const violations = [];
    let rows = 0;
    const lines = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });
    for await (const line of lines) {
        if (!line) continue;
        const report = JSON.parse(line);
        rows++;
        if (names.has(report.scenarioName)) {
            violations.push({ type: 'duplicate-scenario', scenarioName: report.scenarioName });
        }
        names.add(report.scenarioName);
        if (correctionNames.has(report.scenarioName)) replacedSeen.add(report.scenarioName);
        if (removedBaseNames.has(report.scenarioName)
            && !correctionNames.has(report.scenarioName)) {
            removedStillPresent.add(report.scenarioName);
        }
        const phase = report.experiment.phase;
        phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
        if (isAdaptivePolicy(report.experiment.policy) && report.config.losslessAdmissionControl) {
            violations.push({
                type: 'adaptive-lossless-admission-enabled',
                scenarioName: report.scenarioName
            });
        }
        if (['advisor-exact-lossless', 'per-source-lossless'].includes(report.experiment.policy)) {
            if (!report.config.losslessAdmissionControl) {
                violations.push({ type: 'lossless-admission-disabled', scenarioName: report.scenarioName });
            }
            if (report.summary.totalDrops !== 0) {
                violations.push({ type: 'lossless-drop', scenarioName: report.scenarioName });
            }
        }
    }
    if (rows !== 13600) violations.push({ type: 'report-count', expected: 13600, actual: rows });
    if (names.size !== 13600) violations.push({ type: 'unique-report-count', expected: 13600, actual: names.size });
    if (correctionNames.size !== 3720) {
        violations.push({ type: 'correction-count', expected: 3720, actual: correctionNames.size });
    }
    if (replacedSeen.size !== correctionNames.size) {
        violations.push({ type: 'replacement-coverage', expected: correctionNames.size, actual: replacedSeen.size });
    }
    if (removedStillPresent.size) {
        violations.push({ type: 'superseded-report-present', actual: removedStillPresent.size });
    }
    return {
        valid: violations.length === 0,
        reports: rows,
        uniqueReports: names.size,
        replacedReports: replacedSeen.size,
        removedSupersededReports: removedBaseNames.size,
        phaseCounts,
        violations
    };
}

async function run(args) {
    const baseDir = path.resolve(args.base);
    const correctionDir = path.resolve(args.correction);
    const outDir = path.resolve(args.out);
    ensureDir(outDir);

    const correctionValidation = readJson(path.join(correctionDir, 'validation.json'));
    if (!correctionValidation.valid) {
        throw new Error('Correction dataset is not valid. Inspect adaptive-correction/validation.json.');
    }
    const reportReplacements = readJsonlMap(path.join(correctionDir, 'reports.jsonl'));
    const scenarioReplacements = readJsonlMap(path.join(correctionDir, 'scenarios.jsonl'));
    if (reportReplacements.size !== 3720 || scenarioReplacements.size !== 3720) {
        throw new Error(`Expected 3720 corrected reports and scenarios; got ${reportReplacements.size}/${scenarioReplacements.size}`);
    }

    const removedNames = await invalidBaseNames(path.join(baseDir, 'reports.jsonl'));
    if (removedNames.size !== 3720) {
        throw new Error(`Expected 3720 superseded base reports; found ${removedNames.size}`);
    }
    const reportsResult = await rebuildJsonl(
        path.join(baseDir, 'reports.jsonl'),
        path.join(outDir, 'reports.jsonl'),
        removedNames,
        reportReplacements
    );
    const scenariosResult = await rebuildJsonl(
        path.join(baseDir, 'scenarios.jsonl'),
        path.join(outDir, 'scenarios.jsonl'),
        removedNames,
        scenarioReplacements
    );
    if (reportsResult.removed !== 3720 || scenariosResult.removed !== 3720) {
        throw new Error(`Removal coverage mismatch: reports=${reportsResult.removed}, scenarios=${scenariosResult.removed}`);
    }

    for (const fileName of ['summary.csv', 'hosts.csv', 'interfaces.csv', 'adaptive.csv']) {
        await replaceCsv(
            path.join(baseDir, fileName),
            path.join(correctionDir, fileName),
            path.join(outDir, fileName),
            removedNames
        );
    }

    const selections = readJson(path.join(correctionDir, 'selections.json'));
    fs.writeFileSync(path.join(outDir, 'selections.json'), JSON.stringify(selections, null, 2));
    const baseManifest = readJson(path.join(baseDir, 'manifest.json'));
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 'barc-canonical-corrected-v1',
        generatedAt: new Date().toISOString(),
        sourceCampaign: baseDir,
        correctionCampaign: correctionDir,
        correctedAdaptiveRuns: 3720,
        baseCampaign: baseManifest,
        selections
    }, null, 2));

    const canonicalValidation = await validateCanonical(
        path.join(outDir, 'reports.jsonl'),
        reportReplacements,
        removedNames
    );
    fs.writeFileSync(path.join(outDir, 'canonical-validation.json'),
        JSON.stringify(canonicalValidation, null, 2));
    if (!canonicalValidation.valid) {
        throw new Error('Canonical validation failed. Inspect canonical-validation.json.');
    }

    analyzeCampaign(outDir, { bootstrapSamples: 10000 });
    const analysisValidation = readJson(path.join(outDir, 'validation.json'));
    const finalValidation = {
        valid: canonicalValidation.valid && analysisValidation.valid,
        canonical: canonicalValidation,
        analysis: analysisValidation
    };
    fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify(finalValidation, null, 2));
    console.log(`Canonical corrected dataset: ${outDir}`);
    return finalValidation;
}

if (require.main === module) {
    run(parseArgs(process.argv)).catch(error => {
        console.error(error.stack || error);
        process.exit(1);
    });
}

module.exports = { run, validateCanonical, isAdaptivePolicy };
