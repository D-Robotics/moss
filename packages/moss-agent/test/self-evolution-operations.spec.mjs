import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEVICE_ENVIRONMENT_IDENTITY_PROBE,
  parseDeviceEnvironmentFacts,
  probeDeviceEnvironmentFacts,
  trustedEnvironmentIdentity,
} from '../dist/memory/environment-fingerprint.js';
import { loadEvolutionConfig } from '../dist/memory/evolution-config.js';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { PatchExperimentLog } from '../dist/memory/patch-experiment-log.js';
import {
  readSelfEvolutionSnapshot,
  formatSelfEvolutionStatus,
  formatSelfEvolutionExperiments,
  formatSelfEvolutionPatch,
} from '../dist/memory/self-evolution-report.js';
import { verifyTaskTerminal } from '../dist/acceptance/task-terminal-verifier.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evolution-ops-'));
const memoryDir = path.join(root, '.moss', 'memory');

const localA = trustedEnvironmentIdentity({ workspaceDir: root, runtimeMode: 'local' });
const localB = trustedEnvironmentIdentity({ workspaceDir: root, runtimeMode: 'local' });
assert.equal(localA.completeness, 'complete');
assert.equal(localA.fingerprint, localB.fingerprint);
assert.match(localA.fingerprint, /^sha256:v1:/);

const incomplete = trustedEnvironmentIdentity({ workspaceDir: root, runtimeMode: 'device', device: { kernelVersion: '6.1' } });
assert.equal(incomplete.fingerprint, 'unknown');
assert.equal(incomplete.reasonCode, 'missing_board_model');
const boardA = trustedEnvironmentIdentity({
  workspaceDir: root, runtimeMode: 'device',
  device: { boardModel: 'RDK X5', osVersion: 'Ubuntu 22.04', kernelVersion: '6.1-a', firmwareVersion: '1.0' },
});
const boardB = trustedEnvironmentIdentity({
  workspaceDir: root, runtimeMode: 'device',
  device: { boardModel: 'RDK X5', osVersion: 'Ubuntu 22.04', kernelVersion: '6.1-a', firmwareVersion: '1.1' },
});
assert.equal(boardA.completeness, 'complete');
assert.notEqual(boardA.fingerprint, boardB.fingerprint, 'firmware changes isolate evidence');

let observedCommand = '';
const facts = await probeDeviceEnvironmentFacts({
  async run(command) {
    observedCommand = command;
    return { stdout: 'boardModel=RDK X5\nosVersion=Ubuntu 22.04\nkernelVersion=6.1\nfirmwareVersion=1.2\narchitecture=aarch64\n' };
  },
});
assert.deepEqual(facts, parseDeviceEnvironmentFacts('boardModel=RDK X5\nosVersion=Ubuntu 22.04\nkernelVersion=6.1\nfirmwareVersion=1.2\narchitecture=aarch64\n'));
assert.equal(observedCommand, DEVICE_ENVIRONMENT_IDENTITY_PROBE);
assert.doesNotMatch(observedCommand, /host|username|password|192\.168/);

await fs.mkdir(path.join(root, '.moss'), { recursive: true });
await fs.writeFile(path.join(root, '.moss', 'evolution.json'), JSON.stringify({
  experiment: { minSamplesPerArm: 4, wilsonZ: 2, maxCostRatio: 0.1, maxRetryIncrease: 'bad', unexpected: 9 },
}), 'utf8');
const config = await loadEvolutionConfig(root);
assert.equal(config.source, 'workspace');
assert.equal(config.thresholds.minSamplesPerArm, 4);
assert.equal(config.thresholds.wilsonZ, 2);
assert.equal(config.thresholds.maxCostRatio, 1.2, 'unsafe cost ratio falls back to default');
assert.equal(config.thresholds.maxRetryIncrease, 0.25);
assert.ok(config.diagnostics.includes('unknown_field:unexpected'));

const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
const patch = {
  schemaVersion: 1, id: 'patch-demo', revision: 1, kind: 'skill-guidance', state: 'published',
  skill: 'rdk-demo', environmentFingerprint: boardA.fingerprint, environmentIdentityVersion: 1,
  environmentCompleteness: 'complete', failureClass: 'acceptance_failure', sourceEventIds: ['event-1'],
  toolSequences: [['device_exec']], reasonCode: 'trusted_recovery_threshold_met', timestamp: new Date().toISOString(),
};
await patchLog.append(patch);
const emptyArm = {
  total: 1, passed: 1, failed: 0, unknown: 0, successRate: 1, wilsonLow: 0.2, wilsonHigh: 1,
  averageRetries: 0, averageCorrections: 0, averageToolCalls: 1, averageDurationMs: 25,
  averageInputTokens: 10, averageOutputTokens: 2, averageCostUsd: 0.001,
  safetyFailures: 0, failureClasses: {},
};
await experimentLog.append({
  schemaVersion: 1, kind: 'assignment', id: 'assignment-1', patchId: patch.id, patchRevision: 1,
  skill: patch.skill, environmentFingerprint: boardA.fingerprint, timestamp: new Date().toISOString(),
  sessionKey: 'session-redacted', runId: 'run-1', taskSignature: 'hash-only', variant: 'treatment', exposed: true,
});
await experimentLog.append({
  schemaVersion: 1, kind: 'decision', id: 'decision-1', patchId: patch.id, patchRevision: 1,
  skill: patch.skill, environmentFingerprint: boardA.fingerprint, timestamp: new Date().toISOString(),
  revision: 1, state: 'shadow', reasonCode: 'insufficient_samples', control: { ...emptyArm, total: 0, passed: 0, successRate: 0 },
  treatment: emptyArm, sourceOutcomeIds: [],
});

const snapshot = await readSelfEvolutionSnapshot(root);
assert.match(formatSelfEvolutionStatus(snapshot), /patches: 1/);
assert.match(formatSelfEvolutionExperiments(snapshot), /patch-demo/);
const report = formatSelfEvolutionPatch(snapshot, 'patch-demo');
assert.match(report, /CI=\[/);
assert.match(report, /corrections=/);
assert.equal(formatSelfEvolutionPatch(snapshot, 'missing'), null);
assert.doesNotMatch(report, /Ubuntu|RDK X5|192\.168|password/);

const beforeCandidates = await fs.readFile(patchLog.path, 'utf8');
const beforeExperiments = await fs.readFile(experimentLog.path, 'utf8');
const messages = [];
const handled = await runRegistryCommand('/evolution patch missing', {
  agent: {}, runtime: undefined, sessionKey: 's', workspace: root, locale: 'zh-CN', surface: 'repl',
  say(kind, text) { messages.push({ kind, text }); }, prefillInput() {},
});
assert.equal(handled, true);
assert.equal(messages.at(-1).kind, 'error');
assert.equal(await fs.readFile(patchLog.path, 'utf8'), beforeCandidates);
assert.equal(await fs.readFile(experimentLog.path, 'utf8'), beforeExperiments);

const terminal = await verifyTaskTerminal({
  plan: {
    id: 'p', version: 1, title: 'safe', description: '', status: 'executing', currentStep: 1,
    steps: [], createdAt: '', updatedAt: '', terminalAccept: [
      { name: 'file_exist', params: { path: 'missing.file' }, safetyCritical: true },
    ],
  },
  workspaceDir: root, deviceExecutor: null, finalResponse: '',
});
assert.equal(terminal.verdict, 'fail');
assert.equal(terminal.safetyFailed, true);
assert.equal(terminal.safetyReasonCode, 'safety_predicate_failed:file_exist');

await fs.rm(root, { recursive: true, force: true });
console.log('self-evolution-operations: identity, config, reports, read-only CLI and structured safety ok');
