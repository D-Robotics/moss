#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import {
  RulesSkillComposer,
  SkillRegistry,
  normalizeSkillComposerConfig,
} from '../dist/skills/index.js';

const processStartedAt = performance.now();
const iterationsArg = process.argv.indexOf('--iterations');
const iterations = iterationsArg >= 0 ? Number(process.argv[iterationsArg + 1]) : 2_000;
if (!Number.isInteger(iterations) || iterations < 100) throw new Error('--iterations must be >= 100');

const prompts = [
  '介绍一下 RDK X5 开发板的硬件能力和板卡规格。',
  'Connect to the attached RDK board, identify it, and inspect runtime status.',
  '先识别并连接开发板，然后检查 ROS 2 节点和话题。',
  '用已连接的 RDK 摄像头拍一张照片。',
  'Please review this code for correctness and security issues.',
  'What is 2 plus 3?',
];

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function rssMb() {
  return process.memoryUsage().rss / 1024 / 1024;
}

const workspaceDir = process.cwd();
const beforeRegistryMb = rssMb();
const registry = new SkillRegistry({
  workspaceDir,
  extraDirs: [],
  includeBuiltin: true,
  includeBundledRdkSkills: true,
});
const snapshotStartedAt = performance.now();
const snapshot = registry.snapshot();
const snapshotMs = performance.now() - snapshotStartedAt;
const afterRegistryMb = rssMb();
const config = normalizeSkillComposerConfig({
  enabled: true,
  mode: 'rules',
  minScore: 0.08,
  minConfidence: 0,
  maxSkills: 4,
  candidateLimit: 12,
  deadlineMs: 750,
  localModelEnabled: false,
  remoteModelEnabled: false,
}, 'board');
const composer = new RulesSkillComposer(config);
const input = (task) => ({
  task,
  environment: {
    deployment: 'board',
    hasBoard: true,
    networkAllowed: false,
    availablePermissions: ['workspace_read', 'workspace_write', 'device_exec'],
    platform: 'linux-arm64',
  },
  skills: snapshot.skills,
  maxSkills: config.maxSkills,
  registryDigest: snapshot.digest,
});

const firstStartedAt = performance.now();
const firstPlan = await composer.compose(input(prompts[0]));
const firstComposeMs = performance.now() - firstStartedAt;
const coldStartMs = performance.now() - processStartedAt;
for (let index = 0; index < 50; index++) await composer.compose(input(prompts[index % prompts.length]));
const afterWarmupMb = rssMb();
const latencies = [];
for (let index = 0; index < iterations; index++) {
  const startedAt = performance.now();
  await composer.compose(input(prompts[index % prompts.length]));
  latencies.push(performance.now() - startedAt);
}
globalThis.gc?.();
const afterSteadyMb = rssMb();
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const suspiciousArtifacts = [];
for (const name of fs.readdirSync(packageRoot, { withFileTypes: true })) {
  if (/model|onnx|gguf|safetensor|checkpoint/i.test(name.name)) suspiciousArtifacts.push(name.name);
}

console.log(JSON.stringify({
  schemaVersion: 1,
  board: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hostname: process.env.HOSTNAME ?? null,
  },
  offlineRulesMode: config.mode === 'rules' && !config.localModelEnabled && !config.remoteModelEnabled,
  registry: {
    skillCount: snapshot.skills.length,
    digest: snapshot.digest,
    diagnostics: snapshot.diagnostics.length,
    snapshotMs,
  },
  coldStartMs,
  firstComposeMs,
  firstPlan: firstPlan.skills.map((skill) => skill.name),
  iterations,
  latencyMs: {
    mean: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: Math.max(...latencies),
  },
  memoryMb: {
    beforeRegistry: beforeRegistryMb,
    afterRegistry: afterRegistryMb,
    afterWarmup: afterWarmupMb,
    afterSteady: afterSteadyMb,
    steadyDelta: afterSteadyMb - beforeRegistryMb,
  },
  optionalModelArtifactsAtPackageRoot: suspiciousArtifacts,
}, null, 2));
