#!/usr/bin/env node
/**
 * CI gate for the deep workflow.
 *
 * A matrix job cannot be a branch-protection status: only a job that depends
 * on every leg can be. This script reads the needs results (the workflow pipes
 * `toJSON(needs)` into NEEDS_JSON), fails unless every leg is `success`, and
 * writes the same table to the job summary when GitHub provides one.
 */
import fs from 'node:fs';

const NEEDS = process.env.NEEDS_JSON;
if (!NEEDS) {
  console.error('[ci-gate] NEEDS_JSON is missing; the workflow must pass toJSON(needs)');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(NEEDS);
} catch (error) {
  console.error(
    `[ci-gate] NEEDS_JSON is not valid JSON: ${error instanceof Error ? error.message : error}`
  );
  process.exit(1);
}

const entries = Object.entries(parsed ?? {});
if (entries.length === 0) {
  console.error('[ci-gate] no dependent jobs were reported');
  process.exit(1);
}

const failures = entries.filter(([, job]) => job?.result !== 'success');
const lines = ['## Deep verification gate', '', '| job | result |', '| --- | --- |'];
for (const [name, job] of entries) {
  const result = job?.result ?? 'missing';
  console.log(`[ci-gate] ${name}: ${result}`);
  lines.push(`| ${name} | ${result} |`);
}

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  lines.push('', failures.length === 0 ? 'Result: **PASS**' : 'Result: **FAIL**');
  fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

if (failures.length > 0) {
  const names = failures.map(([name]) => name).join(', ');
  console.error(`[ci-gate] FAIL: not all legs succeeded (${names})`);
  process.exit(1);
}

console.log(`[ci-gate] PASS: all ${entries.length} legs succeeded`);
