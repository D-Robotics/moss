#!/usr/bin/env node
/**
 * task-os-a-coding acceptance: a plain coding task completed through the
 * unified task discipline — real implementation + recorded evidence +
 * acceptance PASS + lifecycle events. Prose is not proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function readJsonl(relativePath) {
  const file = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const problems = [];

// 1. Real behavior: the implementation must satisfy the normative examples.
const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `
  import { pathToFileURL } from 'node:url';
  const m = await import(pathToFileURL('utils.js').href);
  const f = m.slugify;
  if (typeof f !== 'function') { console.error('slugify missing'); process.exit(1); }
  const cases = [
    ['Hello, Task OS!', 'hello-task-os'],
    ['  --Multilingual--résumé? ', 'multilingual-r-sum'],
    ['', ''],
  ];
  for (const [input, expected] of cases) {
    const got = f(input);
    if (got !== expected) { console.error('slugify(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ', expected ' + JSON.stringify(expected)); process.exit(1); }
  }
`,
  ],
  { encoding: 'utf8', cwd: process.cwd() }
);
if (probe.status !== 0) {
  problems.push(`slugify implementation wrong: ${probe.stderr.trim()}`);
}

// 2. Task discipline: contract accepted, both criteria have PASS evidence.
const tasks = readJsonl('.moss/tasks.jsonl');
const evidence = readJsonl('.moss/evidence.jsonl');
const verdicts = readJsonl('.moss/acceptance.jsonl');
const events = readJsonl('.moss/task-events.jsonl');

if (tasks.length === 0) {
  problems.push('no task contract defined');
} else {
  const latest = tasks[tasks.length - 1];
  if (latest.status !== 'accepted') {
    problems.push(`latest contract status ${latest.status}, expected accepted`);
  }
  const taskEvidence = evidence.filter((e) => e.taskId === latest.taskId);
  for (const metric of ['slugify_basic', 'slugify_verified']) {
    if (!taskEvidence.some((e) => e.metric === metric && e.result === 'pass')) {
      problems.push(`no PASS evidence for ${metric} linked to task ${latest.taskId}`);
    }
  }
  if (!verdicts.some((v) => v.taskId === latest.taskId && v.verdict === 'pass')) {
    problems.push('no PASS acceptance verdict for the task');
  }
  const types = events.filter((e) => e.taskId === latest.taskId).map((e) => e.type);
  if (!types.includes('acceptance_pass')) {
    problems.push('no acceptance_pass lifecycle event');
  }
}

if (problems.length > 0) {
  console.error(`task-os-a-coding FAIL:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('task-os-a-coding PASS: implementation + evidence + acceptance + lifecycle all real');
