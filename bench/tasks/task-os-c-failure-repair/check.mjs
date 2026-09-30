#!/usr/bin/env node
/**
 * task-os-c-failure-repair acceptance — the crown-jewel proof of the Task OS:
 * the run must contain a REAL failure→diagnosis→repair→reverify→accept cycle,
 * evidenced by lifecycle events and records, ending with the oracle actually
 * passing. False success (pass without a preceding fail) is rejected.
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

// 1. Oracle untouched and passing now (real post-condition).
const oracle = spawnSync(process.execPath, ['verify.mjs'], {
  encoding: 'utf8',
  cwd: process.cwd(),
});
if (oracle.status !== 0) {
  problems.push(
    `oracle still failing (exit ${oracle.status}): ${oracle.stdout.trim()} ${oracle.stderr.trim()}`
  );
}
const oracleSource = fs.readFileSync(path.join(process.cwd(), 'verify.mjs'), 'utf8');
if (!oracleSource.includes('Math.max(40, depth * 8)')) {
  problems.push('verify.mjs was modified — the oracle is off-limits');
}

// 2. The unified runtime saw the whole repair cycle.
const tasks = readJsonl('.moss/tasks.jsonl');
const events = readJsonl('.moss/task-events.jsonl');
const failures = readJsonl('.moss/task-failures.jsonl');
const repairs = readJsonl('.moss/task-repairs.jsonl');
const evidence = readJsonl('.moss/evidence.jsonl');
const verdicts = readJsonl('.moss/acceptance.jsonl');

if (tasks.length === 0) {
  problems.push('no task contract defined');
  console.error(`task-os-c-failure-repair FAIL:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
const latest = tasks[tasks.length - 1];
const types = events.filter((e) => e.taskId === latest.taskId).map((e) => e.type);

const firstFail = types.indexOf('acceptance_fail');
const firstPass = types.indexOf('acceptance_pass');
if (firstFail === -1) {
  problems.push(
    'no acceptance_fail lifecycle event — the initial failure was never honestly verified'
  );
} else if (firstPass !== -1 && firstPass < firstFail) {
  problems.push('FALSE SUCCESS: acceptance_pass appears before the first acceptance_fail');
}
if (!types.includes('acceptance_pass')) {
  problems.push('no acceptance_pass lifecycle event');
}

// A repair must sit between the first fail and the final pass.
const between = types.slice(firstFail === -1 ? 0 : firstFail);
if (!between.includes('repair_applied') && !between.includes('evidence_recorded')) {
  problems.push('no repair/evidence activity after the first failed verification');
}

if (failures.filter((f) => f.taskId === latest.taskId).length === 0) {
  problems.push('no FailureRecord — record_failure was skipped');
}
if (repairs.filter((r) => r.taskId === latest.taskId).length === 0) {
  problems.push('no RepairRecord — record_repair was skipped');
}

const taskEvidence = evidence.filter((e) => e.taskId === latest.taskId);
for (const metric of ['verify_exit_code', 'sla_cases_pass']) {
  if (!taskEvidence.some((e) => e.metric === metric && e.result === 'pass')) {
    problems.push(`no PASS evidence for ${metric}`);
  }
}
if (latest.status !== 'accepted') {
  problems.push(`latest contract status ${latest.status}, expected accepted`);
}
if (!verdicts.some((v) => v.taskId === latest.taskId && v.verdict === 'pass')) {
  problems.push('no PASS acceptance verdict');
}

if (problems.length > 0) {
  console.error(`task-os-c-failure-repair FAIL:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const attemptCount = types.filter((t) => t === 'verification_started').length;
console.log(
  `task-os-c-failure-repair PASS: failure→diagnosis→repair→reverify→accept all evidenced (${attemptCount} verification attempts, ${failures.length} failure records, ${repairs.length} repair records)`
);
