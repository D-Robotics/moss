#!/usr/bin/env node
/**
 * device-observe-evidence acceptance: the agent must have driven the whole
 * robotics loop — real device probe → task contract → recorded evidence →
 * acceptance PASS. The .moss artifacts are the proof; prose is not.
 */
import fs from 'node:fs';
import path from 'node:path';

function readJsonl(relativePath) {
  const file = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const evidence = readJsonl('.moss/evidence.jsonl');
const tasks = readJsonl('.moss/tasks.jsonl');
const verdicts = readJsonl('.moss/acceptance.jsonl');

const problems = [];

if (evidence.length < 2) {
  problems.push(`expected >=2 evidence records, found ${evidence.length}`);
}
const passEvidence = evidence.filter((e) => e.result === 'pass');
if (passEvidence.length < 2) {
  problems.push(`expected >=2 PASS evidence records, found ${passEvidence.length}`);
}
for (const metric of ['device_reachable', 'hostname_reported']) {
  const records = evidence.filter((e) => e.metric === metric);
  if (records.length === 0) {
    problems.push(`no evidence recorded for metric ${metric}`);
  } else if (!records.some((e) => e.result === 'pass')) {
    problems.push(`metric ${metric} has no PASS evidence`);
  }
  const withTask = records.filter(
    (e) => typeof e.taskId === 'string' && e.taskId.startsWith('task_')
  );
  if (withTask.length === 0) {
    problems.push(`metric ${metric} evidence is not linked to a task contract (missing task_id)`);
  }
}

if (tasks.length === 0) {
  problems.push('no task contract defined (tasks.jsonl empty)');
} else {
  const latest = tasks[tasks.length - 1];
  if (!Array.isArray(latest.acceptanceCriteria) || latest.acceptanceCriteria.length < 2) {
    problems.push('task contract does not carry the two required acceptance criteria');
  }
  if (latest.status !== 'accepted') {
    problems.push(`latest task contract status is ${latest.status}, expected accepted`);
  }
}

const passVerdicts = verdicts.filter((v) => v.verdict === 'pass');
if (passVerdicts.length === 0) {
  problems.push(
    `no PASS acceptance verdict recorded (verdicts: ${verdicts.map((v) => v.verdict).join(',') || 'none'})`
  );
} else {
  const last = passVerdicts[passVerdicts.length - 1];
  const unmet = (last.criteriaResults ?? []).filter((c) => c.result !== 'pass');
  if (unmet.length > 0) {
    problems.push(`PASS verdict still has unmet criteria: ${unmet.map((c) => c.metric).join(',')}`);
  }
}

if (problems.length > 0) {
  console.error(`device-observe-evidence FAIL:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('device-observe-evidence PASS: contract accepted with device-sourced evidence');
