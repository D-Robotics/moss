#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  RulesSkillComposer,
  SkillRegistry,
  normalizeSkillComposerConfig,
  resolveDefaultSkillRoots,
} from '../dist/skills/index.js';
import {
  buildSkillCompositionEvalReport,
  buildSkillCompositionShadowComparison,
  evaluateSkillCompositionPromotion,
} from '../dist/eval/index.js';

const DEFAULT_TASKS = 'D:/moss-eval/harness/tasks-skill.mjs';
const DEFAULT_WORKSPACE = 'D:/moss-eval/fixtures/skill-eval/sample-lib';

function parseArgs(argv) {
  const options = {
    tasks: DEFAULT_TASKS,
    workspace: DEFAULT_WORKSPACE,
    output: path.resolve('artifacts/skill-composer-eval'),
    rounds: 3,
  };
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--tasks') options.tasks = argv[++index];
    else if (key === '--workspace') options.workspace = argv[++index];
    else if (key === '--output') options.output = path.resolve(argv[++index]);
    else if (key === '--rounds') options.rounds = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(options.rounds) || options.rounds < 3) {
    throw new Error('--rounds must be an integer >= 3');
  }
  return options;
}

function taskSplit(id) {
  if (/^SK-(?:0[1-9]|10)$/.test(id) || /^SK-M[1-6]$/.test(id) || /^SK-R[1-6]$/.test(id)) {
    return 'train';
  }
  if (/^SK-(?:11|12|13|14)$/.test(id) || /^SK-M[78]$/.test(id) || /^SK-R[78]$/.test(id)) {
    return 'validation';
  }
  return 'heldout';
}

const RDK_TASKS = [
  {
    id: 'RDK-01', kind: 'single', lang: 'zh', split: 'board', boardConnected: false,
    prompt: '介绍一下 RDK X5 开发板的硬件能力和系统架构。',
    expectedSkills: ['rdk-hardware'],
  },
  {
    id: 'RDK-02', kind: 'single', lang: 'en', split: 'board', boardConnected: true,
    prompt: 'Connect to the attached RDK board, identify the board model, and inspect its runtime status.',
    expectedSkills: ['rdk-board-knowledge'],
  },
  {
    id: 'RDK-03', kind: 'multi', lang: 'zh', split: 'board', boardConnected: true,
    prompt: '先识别并连接这块 RDK 开发板，然后检查 ROS 2 节点和话题是否正常。',
    expectedSkills: ['rdk-board-knowledge', 'rdk-device', 'rdk-ros'],
  },
  {
    id: 'RDK-04', kind: 'single', lang: 'en', split: 'board', boardConnected: false,
    prompt: 'Find the official RDK documentation for deploying an LLM model and summarize the supported workflow.',
    expectedSkills: ['rdk-doc-finder'],
  },
  {
    id: 'RDK-05', kind: 'single', lang: 'zh', split: 'board', boardConnected: true,
    prompt: '用已连接的 RDK 摄像头拍一张照片并保存到工作目录。',
    expectedSkills: ['rdk-capture-photo'],
  },
  {
    id: 'RDK-R1', kind: 'reject', lang: 'zh', split: 'board', boardConnected: false,
    prompt: '2 加 3 等于多少？', expectedSkills: [],
  },
];

function normalizeTask(task) {
  return {
    id: task.id,
    kind: task.kind,
    lang: task.lang,
    split: task.split ?? taskSplit(task.id),
    boardConnected: task.boardConnected ?? false,
    prompt: task.prompt,
    expectedSkills: [...(task.expectedSkills ?? [])],
  };
}

function environmentFor(task) {
  const board = task.split === 'board';
  return {
    deployment: board ? 'board' : 'host',
    hasBoard: task.boardConnected,
    networkAllowed: !board,
    availablePermissions: board
      ? ['workspace_read', 'workspace_write', 'device_exec']
      : ['workspace_read', 'workspace_write', 'network'],
    platform: board ? 'linux-arm64' : process.platform,
  };
}

function sourceOf(skill) {
  const normalized = skill.sourcePath.replaceAll('\\', '/').toLowerCase();
  if (normalized.startsWith('builtin://')) return 'builtin';
  if (normalized.includes('/rdk-knowledge/skills/')) return 'rdk';
  if (normalized.includes('/.moss/skills/') || normalized.includes('/.agents/skills/')) return 'workspace';
  return 'global';
}

async function injectedChars(plan, byId) {
  let total = 0;
  for (const planned of plan.skills) {
    const skill = byId.get(planned.stableId);
    if (!skill) continue;
    total += skill.description.length;
    if (skill.body) total += skill.body.length;
    else if (!skill.sourcePath.startsWith('builtin://')) {
      try { total += (await fs.readFile(skill.sourcePath, 'utf8')).length; } catch {}
    }
  }
  return total;
}

function expectedSources(task, byName) {
  return [...new Set(task.expectedSkills.map((name) => sourceOf(byName.get(name))).filter(Boolean))].join('+') || 'none';
}

async function composeSample(task, round, snapshot, config, byId, byName) {
  const composer = new RulesSkillComposer(config);
  const startedAt = performance.now();
  const plan = await composer.compose({
    task: task.prompt,
    environment: environmentFor(task),
    skills: snapshot.skills,
    maxSkills: config.maxSkills,
    registryDigest: snapshot.digest,
  });
  const measuredLatencyMs = performance.now() - startedAt;
  const candidates = plan.diagnostics?.candidateScores ?? [];
  return {
    id: `${task.id}#${round}`,
    taskId: task.id,
    split: task.split,
    provider: plan.provider,
    expectedSkillIds: task.expectedSkills,
    composedSkillIds: plan.skills.map((skill) => skill.name),
    candidateSkillIds: candidates.map((candidate) => candidate.name),
    dependencyViolations: (plan.diagnostics?.warnings ?? []).filter((warning) => /dependency|cycle|requires/i.test(warning)).length,
    latencyMs: measuredLatencyMs,
    fallback: Boolean(plan.diagnostics?.fallbackReason),
    injectedChars: await injectedChars(plan, byId),
    language: task.lang,
    deploymentMode: task.split === 'board' ? 'board' : 'host',
    skillSource: expectedSources(task, byName),
    taskClass: task.kind === 'reject' ? 'none' : task.kind,
    environment: task.split === 'board' ? 'board' : 'host',
    diagnostics: plan.diagnostics,
  };
}

async function legacySample(task, round, registry, byId, byName) {
  const startedAt = performance.now();
  const matched = registry.matchByText(task.prompt);
  const measuredLatencyMs = performance.now() - startedAt;
  const plan = {
    skills: matched.map((skill) => ({ stableId: skill.stableId, name: skill.name })),
  };
  return {
    id: `${task.id}#${round}`,
    taskId: task.id,
    split: task.split,
    provider: 'legacy',
    expectedSkillIds: task.expectedSkills,
    composedSkillIds: matched.map((skill) => skill.name),
    candidateSkillIds: matched.map((skill) => skill.name),
    dependencyViolations: 0,
    latencyMs: measuredLatencyMs,
    fallback: false,
    injectedChars: await injectedChars(plan, byId),
    language: task.lang,
    deploymentMode: task.split === 'board' ? 'board' : 'host',
    skillSource: expectedSources(task, byName),
    taskClass: task.kind === 'reject' ? 'none' : task.kind,
    environment: task.split === 'board' ? 'board' : 'host',
  };
}

async function evaluateLegacy(tasks, rounds, registry, byId, byName) {
  const samples = [];
  for (const task of tasks) {
    for (let round = 1; round <= rounds; round++) {
      samples.push(await legacySample(task, round, registry, byId, byName));
    }
  }
  return samples;
}

function metricScore(metrics) {
  return metrics.setF1 * 4
    + metrics.setExactMatch * 2
    + metrics.rejectionAccuracy * 2
    + metrics.recallAt5
    - metrics.cardinalityError
    - metrics.dependencyViolationRate * 2;
}

async function evaluateTasks(tasks, rounds, snapshot, config, byId, byName) {
  const samples = [];
  for (const task of tasks) {
    for (let round = 1; round <= rounds; round++) {
      samples.push(await composeSample(task, round, snapshot, config, byId, byName));
    }
  }
  return samples;
}

function compactMetrics(samples) {
  return buildSkillCompositionEvalReport(samples, [
    'provider', 'language', 'deploymentMode', 'skillSource', 'taskClass', 'environment',
  ]);
}

function consistency(samples) {
  const byTask = new Map();
  for (const sample of samples) {
    const plans = byTask.get(sample.taskId) ?? new Set();
    plans.add(JSON.stringify(sample.composedSkillIds));
    byTask.set(sample.taskId, plans);
  }
  const unstable = [...byTask].filter(([, plans]) => plans.size !== 1).map(([taskId]) => taskId);
  return { repeatableTasks: byTask.size - unstable.length, totalTasks: byTask.size, unstable };
}

function sampleF1(sample) {
  const expected = new Set(sample.expectedSkillIds);
  const actual = new Set(sample.composedSkillIds);
  if (expected.size === 0 && actual.size === 0) return 1;
  const hits = [...expected].filter((name) => actual.has(name)).length;
  return hits === 0 ? 0 : (2 * hits) / (expected.size + actual.size);
}

function abWins(legacySamples, rulesSamples) {
  const rulesById = new Map(rulesSamples.map((sample) => [sample.id, sample]));
  const result = {
    rulesWins: 0, legacyWins: 0, ties: 0,
    rulesWinTasks: [], legacyWinTasks: [], tieTasks: [], regressions: [],
  };
  const seenTasks = new Set();
  for (const legacy of legacySamples) {
    const rules = rulesById.get(legacy.id);
    if (!rules) continue;
    const delta = sampleF1(rules) - sampleF1(legacy);
    if (delta > 1e-9) result.rulesWins++;
    else if (delta < -1e-9) result.legacyWins++;
    else result.ties++;
    if (seenTasks.has(legacy.taskId)) continue;
    seenTasks.add(legacy.taskId);
    if (delta > 1e-9) result.rulesWinTasks.push(legacy.taskId);
    else if (delta < -1e-9) {
      result.legacyWinTasks.push(legacy.taskId);
      result.regressions.push({
        taskId: legacy.taskId,
        expected: legacy.expectedSkillIds,
        legacy: legacy.composedSkillIds,
        rules: rules.composedSkillIds,
      });
    } else result.tieTasks.push(legacy.taskId);
  }
  return result;
}

function abMarkdown(result) {
  const a = result.ab.legacy.overall;
  const b = result.ab.rules.overall;
  const d = result.ab.comparison.delta;
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const signed = (value, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
  return `# Legacy vs Rules Composer A/B\n\n` +
    `Same live registry, same ${result.consistency.totalTasks} tasks, ${result.rounds} attempts per task (${result.ab.legacy.overall.sampleCount} paired samples).\n\n` +
    `| Metric | A: legacy matchByText | B: Rules Composer | B - A |\n| --- | ---: | ---: | ---: |\n` +
    `| Set F1 | ${pct(a.setF1)} | ${pct(b.setF1)} | ${signed(d.setF1 * 100)} pp |\n` +
    `| Set Exact Match | ${pct(a.setExactMatch)} | ${pct(b.setExactMatch)} | ${signed(d.setExactMatch * 100)} pp |\n` +
    `| Rejection accuracy | ${pct(a.rejectionAccuracy)} | ${pct(b.rejectionAccuracy)} | ${signed(d.rejectionAccuracy * 100)} pp |\n` +
    `| Recall@5 | ${pct(a.recallAt5)} | ${pct(b.recallAt5)} | ${signed(d.recallAt5 * 100)} pp |\n` +
    `| Cardinality error | ${a.cardinalityError.toFixed(3)} | ${b.cardinalityError.toFixed(3)} | ${signed(d.cardinalityError, 3)} |\n` +
    `| Mean selection latency | ${a.averageLatencyMs.toFixed(3)} ms | ${b.averageLatencyMs.toFixed(3)} ms | ${signed(d.averageLatencyMs, 3)} ms |\n` +
    `| Injected token estimate | ${a.injectedTokenEstimate} | ${b.injectedTokenEstimate} | ${signed(d.injectedTokenEstimate, 0)} |\n\n` +
    `Per-sample Set F1: Rules wins ${result.ab.wins.rulesWins}, legacy wins ${result.ab.wins.legacyWins}, ties ${result.ab.wins.ties}. ` +
    `By unique task: Rules wins ${result.ab.wins.rulesWinTasks.length}, legacy wins ${result.ab.wins.legacyWinTasks.length}, ties ${result.ab.wins.tieTasks.length}.\n\n` +
    `Regression cases: ${result.ab.wins.regressions.length ? result.ab.wins.regressions.map((item) => `\`${item.taskId}\` expected ${JSON.stringify(item.expected)}, legacy ${JSON.stringify(item.legacy)}, rules ${JSON.stringify(item.rules)}`).join('; ') : 'none'}.\n\n` +
    `This is a selector/injection A/B. It deliberately excludes LLM response variance and does not claim a semantic downstream-task improvement.\n`;
}

function markdownSummary(result) {
  const m = result.shadow.overall;
  const h = result.heldout.overall;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  return `# Skill Composer evaluation\n\n` +
    `Generated: ${result.generatedAt}\n\n` +
    `Registry: ${result.registry.skillCount} skills, digest \`${result.registry.digest}\`.\n\n` +
    `Frozen parameters: minScore=${result.frozenConfig.minScore}, minConfidence=${result.frozenConfig.minConfidence}, maxSkills=${result.frozenConfig.maxSkills}, candidateLimit=${result.frozenConfig.candidateLimit}.\n\n` +
    `## Held-out (frozen before evaluation)\n\n` +
    `- Set F1: ${percent(h.setF1)}\n- Set Exact Match: ${percent(h.setExactMatch)}\n- Rejection accuracy: ${percent(h.rejectionAccuracy)}\n- Recall@5: ${percent(h.recallAt5)}\n- Cardinality error: ${h.cardinalityError.toFixed(3)}\n- Average latency: ${h.averageLatencyMs.toFixed(3)} ms\n\n` +
    `## Full shadow suite (${result.rounds} attempts/task)\n\n` +
    `- Set F1: ${percent(m.setF1)}\n- Set Exact Match: ${percent(m.setExactMatch)}\n- Rejection accuracy: ${percent(m.rejectionAccuracy)}\n- Recall@5: ${percent(m.recallAt5)}\n- MRR: ${m.mrr.toFixed(3)}\n- nDCG@5: ${m.ndcgAt5.toFixed(3)}\n- Cardinality error: ${m.cardinalityError.toFixed(3)}\n- Dependency violation rate: ${percent(m.dependencyViolationRate)}\n- Average latency: ${m.averageLatencyMs.toFixed(3)} ms\n- Fallback rate: ${percent(m.fallbackRate)}\n- Injected token estimate: ${m.injectedTokenEstimate}\n- Repeatability: ${result.consistency.repeatableTasks}/${result.consistency.totalTasks} tasks\n\n` +
    `## Promotion gate review\n\n` +
    `Eligible for explicit review: ${result.promotionReview.eligibleForReview}. Automatic promotion: never.\n` +
    (result.promotionReview.failures.length ? `Failures: ${result.promotionReview.failures.join('; ')}\n` : 'Failures: none.\n');
}

async function main() {
  const options = parseArgs(process.argv);
  const taskModule = await import(pathToFileURL(path.resolve(options.tasks)).href);
  const legacyTasks = taskModule.SKILL_TASKS.map(normalizeTask);
  const tasks = [...legacyTasks, ...RDK_TASKS.map(normalizeTask)];
  const registry = new SkillRegistry({
    workspaceDir: path.resolve(options.workspace),
    extraDirs: resolveDefaultSkillRoots(),
    includeBuiltin: true,
    includeBundledRdkSkills: true,
  });
  const snapshot = registry.snapshot();
  const byId = new Map(snapshot.skills.map((skill) => [skill.stableId, skill]));
  const byName = new Map(snapshot.skills.map((skill) => [skill.name, skill]));
  const missingExpected = [...new Set(tasks.flatMap((task) => task.expectedSkills))]
    .filter((name) => !byName.has(name));
  if (missingExpected.length) throw new Error(`Expected skills missing from registry: ${missingExpected.join(', ')}`);

  const train = tasks.filter((task) => task.split === 'train');
  const validation = tasks.filter((task) => task.split === 'validation');
  const heldout = tasks.filter((task) => task.split === 'heldout');
  const tuningResults = [];
  for (const minScore of [0.08, 0.12, 0.16, 0.20, 0.24]) {
    for (const minConfidence of [0, 0.20, 0.28, 0.35]) {
      for (const maxSkills of [3, 4, 5]) {
        const config = normalizeSkillComposerConfig({
          enabled: true, mode: 'rules', minScore, minConfidence, maxSkills,
          candidateLimit: 12, deadlineMs: 750,
        });
        const trainSamples = await evaluateTasks(train, 1, snapshot, config, byId, byName);
        const validationSamples = await evaluateTasks(validation, 1, snapshot, config, byId, byName);
        const trainMetrics = compactMetrics(trainSamples).overall;
        const validationMetrics = compactMetrics(validationSamples).overall;
        tuningResults.push({
          config, trainMetrics, validationMetrics,
          score: metricScore(validationMetrics),
        });
      }
    }
  }
  tuningResults.sort((left, right) => right.score - left.score
    || right.trainMetrics.setF1 - left.trainMetrics.setF1
    || left.config.minScore - right.config.minScore
    || left.config.minConfidence - right.config.minConfidence
    || left.config.maxSkills - right.config.maxSkills);
  const frozenConfig = tuningResults[0].config;

  // Held-out prompts are first evaluated only after the selected parameters are frozen.
  const heldoutSamples = await evaluateTasks(heldout, options.rounds, snapshot, frozenConfig, byId, byName);
  const shadowSamples = await evaluateTasks(tasks, options.rounds, snapshot, frozenConfig, byId, byName);
  const legacySamples = await evaluateLegacy(tasks, options.rounds, registry, byId, byName);
  const legacyReport = compactMetrics(legacySamples);
  const rulesReport = compactMetrics(shadowSamples);
  const taskDigest = crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length },
    rounds: options.rounds,
    taskSource: path.resolve(options.tasks),
    taskDigest,
    splits: { train: train.map((task) => task.id), validation: validation.map((task) => task.id), heldout: heldout.map((task) => task.id), board: RDK_TASKS.map((task) => task.id) },
    registry: { digest: snapshot.digest, skillCount: snapshot.skills.length, diagnostics: snapshot.diagnostics },
    tuning: { candidates: tuningResults.length, bestFive: tuningResults.slice(0, 5) },
    frozenConfig,
    heldout: compactMetrics(heldoutSamples),
    shadow: rulesReport,
    ab: {
      legacy: legacyReport,
      rules: rulesReport,
      comparison: buildSkillCompositionShadowComparison(legacySamples, shadowSamples),
      wins: abWins(legacySamples, shadowSamples),
      legacySamples,
    },
    consistency: consistency(shadowSamples),
    promotionReview: evaluateSkillCompositionPromotion(compactMetrics(shadowSamples).overall, {
      minimumSetF1: 0.75,
      minimumRejectionAccuracy: 0.90,
      maximumAverageLatencyMs: 25,
      maximumDependencyViolationRate: 0,
    }),
    samples: shadowSamples,
  };
  await fs.mkdir(options.output, { recursive: true });
  await fs.writeFile(path.join(options.output, 'frozen-config.json'), JSON.stringify({
    generatedAt: result.generatedAt,
    taskDigest,
    registryDigest: snapshot.digest,
    config: frozenConfig,
  }, null, 2));
  await fs.writeFile(path.join(options.output, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(options.output, 'summary.md'), markdownSummary(result));
  await fs.writeFile(path.join(options.output, 'ab-summary.md'), abMarkdown(result));
  console.log(JSON.stringify({
    output: options.output,
    frozenConfig,
    heldout: result.heldout.overall,
    shadow: result.shadow.overall,
    ab: {
      legacy: result.ab.legacy.overall,
      rules: result.ab.rules.overall,
      delta: result.ab.comparison.delta,
      wins: result.ab.wins,
    },
    consistency: result.consistency,
    promotionReview: result.promotionReview,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
