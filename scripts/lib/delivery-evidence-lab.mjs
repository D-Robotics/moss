import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REQUIRED_SCENARIOS = new Set([
  'small-bug',
  'ambiguous-cross-module-feature',
  'restart-recovery',
  'four-node-parallel-implementation',
  'reviewer-injected-integration-defect',
  'acceptance-revision',
  'external-workspace-conflict',
]);

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function validateDeliveryEvidenceManifest(manifest) {
  if (manifest.repeats !== 5) throw new Error('delivery evidence lab requires exactly five runs');
  if (
    !Array.isArray(manifest.runner) ||
    !manifest.runner.every((part) => typeof part === 'string')
  ) {
    throw new Error('delivery evidence lab runner must be a command array');
  }
  const ids = new Set((manifest.scenarios ?? []).map((scenario) => scenario.id));
  for (const id of REQUIRED_SCENARIOS) {
    if (!ids.has(id)) throw new Error(`delivery evidence lab is missing scenario "${id}"`);
  }
  for (const scenario of manifest.scenarios) {
    if (!scenario.task || !scenario.environment || !scenario.model || !scenario.budget) {
      throw new Error(`scenario "${scenario.id}" must lock task, environment, model, and budget`);
    }
  }
}

export async function executeEvidenceRunner(runner, context) {
  const startedAt = Date.now();
  const [command, ...args] = runner;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        MOSS_EVIDENCE_SCENARIO: context.scenario.id,
        MOSS_EVIDENCE_VARIANT: context.variant,
        MOSS_EVIDENCE_RUN: String(context.run),
        MOSS_EVIDENCE_MODEL: context.scenario.model,
        MOSS_EVIDENCE_BUDGET: JSON.stringify(context.scenario.budget),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 5_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 5_000_000) child.kill('SIGTERM');
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
  const lines = result.stdout.trim().split('\n');
  const metrics = (() => {
    try {
      return JSON.parse(lines.at(-1) ?? '{}');
    } catch {
      return { success: false, failureClass: 'invalid_runner_output' };
    }
  })();
  return {
    ...metrics,
    exitCode: result.exitCode,
    signal: result.signal,
    wallTimeMs: Date.now() - startedAt,
    stdoutDigest: digest(result.stdout),
    stderrDigest: digest(result.stderr),
    raw: { stdout: result.stdout, stderr: result.stderr },
  };
}

export async function runDeliveryEvidenceLab(manifest, options = {}) {
  validateDeliveryEvidenceManifest(manifest);
  const execute = options.execute ?? ((context) => executeEvidenceRunner(manifest.runner, context));
  const runs = [];
  for (const scenario of manifest.scenarios) {
    for (const variant of ['control', 'treatment']) {
      for (let run = 1; run <= manifest.repeats; run++) {
        const result = await execute({ scenario, variant, run });
        runs.push({
          scenarioId: scenario.id,
          variant,
          run,
          model: scenario.model,
          budget: scenario.budget,
          environment: scenario.environment,
          ...result,
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: manifest.commit,
    repeats: manifest.repeats,
    runs,
  };
}
