#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(fs.readFileSync('benchmarks/harbor/manifest.json', 'utf8'));
const checks = [];
const commandExists = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  return result.status === 0;
};
checks.push({ id: 'manifest-trials', ok: manifest.requiredTrials >= 5 });
checks.push({ id: 'manifest-timeout-policy', ok: manifest.timeoutMultiplier === 1 });
checks.push({ id: 'adapter', ok: fs.existsSync('benchmarks/harbor/moss_agent.py') });
checks.push({ id: 'docker', ok: commandExists('docker', ['info']) });
checks.push({ id: 'harbor', ok: commandExists('harbor', ['--help']) });
checks.push({ id: 'agent-version', ok: Boolean(process.env.MOSS_HARBOR_AGENT_VERSION) });
checks.push({ id: 'model', ok: Boolean(process.env.MOSS_MODEL) });
checks.push({ id: 'provider-key', ok: Boolean(process.env.OPENAI_API_KEY) });

const ready = checks.every(({ ok }) => ok);
const report = {
  benchmark: manifest.benchmark,
  dataset: manifest.dataset,
  submissionStatus: manifest.submissionStatus,
  executionStatus: ready ? 'ready' : 'blocked',
  checks,
  nextCommand: ready
    ? `harbor run -d ${manifest.dataset} --agent ${manifest.adapter} --agent-version "$MOSS_HARBOR_AGENT_VERSION" -m "openai/$MOSS_MODEL" -k ${manifest.requiredTrials}`
    : undefined,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.argv.includes('--require-ready') && !ready) process.exitCode = 2;
