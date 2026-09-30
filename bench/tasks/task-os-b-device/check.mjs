#!/usr/bin/env node
/**
 * task-os-b-device acceptance: the robotics closed loop driven through the
 * unified task runtime — live device probe → contract with device target →
 * evidence from real probes → acceptance PASS → lifecycle events. Without a
 * device this task never runs (requiresEnv), so inside this check the device
 * must have been real.
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

const problems = [];
const tasks = readJsonl('.moss/tasks.jsonl');
const evidence = readJsonl('.moss/evidence.jsonl');
const verdicts = readJsonl('.moss/acceptance.jsonl');
const events = readJsonl('.moss/task-events.jsonl');

if (tasks.length === 0) {
  problems.push('no task contract defined');
} else {
  const latest = tasks[tasks.length - 1];
  if (!latest.targetDeviceId) {
    problems.push('contract has no target device');
  }
  if (latest.status !== 'accepted') {
    problems.push(`latest contract status ${latest.status}, expected accepted`);
  }
  const taskEvidence = evidence.filter((e) => e.taskId === latest.taskId);
  for (const metric of ['device_reachable', 'runtime_healthy']) {
    const records = taskEvidence.filter((e) => e.metric === metric);
    if (records.length === 0) {
      problems.push(`no evidence for ${metric}`);
    } else if (!records.some((e) => e.result === 'pass')) {
      problems.push(`metric ${metric} has no PASS evidence`);
    } else if (!records.some((e) => e.deviceId)) {
      problems.push(`metric ${metric} evidence lacks device linkage`);
    }
  }
  if (!verdicts.some((v) => v.taskId === latest.taskId && v.verdict === 'pass')) {
    problems.push('no PASS acceptance verdict');
  }
  const types = events.filter((e) => e.taskId === latest.taskId).map((e) => e.type);
  if (!types.includes('acceptance_pass')) {
    problems.push('no acceptance_pass lifecycle event');
  }
}

if (problems.length > 0) {
  console.error(`task-os-b-device FAIL:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'task-os-b-device PASS: live device → contract → evidence → acceptance, all through the unified runtime'
);
