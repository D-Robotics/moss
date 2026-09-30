#!/usr/bin/env node
/**
 * device-deploy-verify acceptance: the agent deployed an artifact to the real
 * device, started it, health-checked it, and closed the loop with recorded
 * evidence + a PASS acceptance verdict. Proven by .moss artifacts only.
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
const deployments = readJsonl('.moss/deployments.jsonl');
const evidence = readJsonl('.moss/evidence.jsonl');
const tasks = readJsonl('.moss/tasks.jsonl');
const verdicts = readJsonl('.moss/acceptance.jsonl');

const succeeded = deployments.filter(
  (d) => d.status === 'running' && d.remotePath && d.remotePath.startsWith('/tmp/')
);
if (succeeded.length === 0) {
  problems.push(
    `expected a RUNNING deployment to /tmp/, found: ${deployments.map((d) => `${d.status}:${d.remotePath}`).join(',') || 'none'}`
  );
} else {
  const dep = succeeded[succeeded.length - 1];
  if (!dep.healthCheck || dep.healthCheck.passed !== true) {
    problems.push(`deployment health check not passed: ${JSON.stringify(dep.healthCheck)}`);
  }
  const steps = dep.steps ?? [];
  for (const stepName of ['prepare-dir', 'upload', 'start', 'health-check']) {
    const step = steps.find((s) => s.step === stepName);
    if (!step || step.status !== 'ok') {
      problems.push(`deployment step ${stepName} not ok: ${JSON.stringify(step ?? null)}`);
    }
  }
}

for (const metric of ['deployment_status', 'proof_file_matches']) {
  const records = evidence.filter((e) => e.metric === metric);
  if (records.length === 0) {
    problems.push(`no evidence recorded for metric ${metric}`);
  } else if (
    !records.some(
      (e) => e.result === 'pass' && typeof e.taskId === 'string' && e.taskId.startsWith('task_')
    )
  ) {
    problems.push(`metric ${metric} has no PASS evidence linked to a task contract`);
  }
}

if (tasks.length === 0) {
  problems.push('no task contract defined');
} else if (tasks[tasks.length - 1].status !== 'accepted') {
  problems.push(`latest task status is ${tasks[tasks.length - 1].status}, expected accepted`);
}

if (!verdicts.some((v) => v.verdict === 'pass')) {
  problems.push(
    `no PASS acceptance verdict (verdicts: ${verdicts.map((v) => v.verdict).join(',') || 'none'})`
  );
}

if (problems.length > 0) {
  console.error(`device-deploy-verify FAIL:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log('device-deploy-verify PASS: deployed, started, health-checked, accepted with evidence');
