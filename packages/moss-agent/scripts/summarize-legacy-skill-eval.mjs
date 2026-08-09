#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_RUN = 'D:/moss-eval/runs/skill-eval/skill-trial1';
const DEFAULT_TASKS = 'D:/moss-eval/harness/tasks-skill.mjs';
const DEFAULT_LEGACY_REGISTRY =
  'C:/Users/tongchun.zhao/nodejs-v22/node-v22.23.1-win-x64/node_modules/@rdk-moss/agent/dist/skills/registry.js';

const RDK_TASKS = [
  {
    id: 'RDK-01',
    kind: 'single',
    lang: 'zh',
    prompt: '介绍一下 RDK X5 开发板的硬件能力和板卡规格。',
    expectedSkills: ['rdk-hardware'],
  },
  {
    id: 'RDK-02',
    kind: 'single',
    lang: 'en',
    prompt:
      'Connect to the attached RDK board, identify the board model, and inspect its runtime status.',
    expectedSkills: ['rdk-board-knowledge'],
  },
  {
    id: 'RDK-03',
    kind: 'multi',
    lang: 'zh',
    prompt: '先识别并连接这块 RDK 开发板，然后检查 ROS 2 节点和话题是否正常。',
    expectedSkills: ['rdk-board-knowledge', 'rdk-device', 'rdk-ros'],
  },
  {
    id: 'RDK-04',
    kind: 'single',
    lang: 'en',
    prompt:
      'Find the official RDK documentation for deploying an LLM model and summarize the supported workflow.',
    expectedSkills: ['rdk-doc-finder'],
  },
  {
    id: 'RDK-05',
    kind: 'single',
    lang: 'zh',
    prompt: '用已连接的 RDK 摄像头拍一张照片并保存到工作目录。',
    expectedSkills: ['rdk-capture-photo'],
  },
  { id: 'RDK-R1', kind: 'reject', lang: 'zh', prompt: '2 加 3 等于多少？', expectedSkills: [] },
];

function parseArgs(argv) {
  const result = {
    run: DEFAULT_RUN,
    tasks: DEFAULT_TASKS,
    legacyRegistry: DEFAULT_LEGACY_REGISTRY,
    output: path.resolve('artifacts/skill-composer-legacy-baseline'),
  };
  for (let index = 2; index < argv.length; index++) {
    if (argv[index] === '--run') result.run = argv[++index];
    else if (argv[index] === '--tasks') result.tasks = argv[++index];
    else if (argv[index] === '--legacy-registry') result.legacyRegistry = argv[++index];
    else if (argv[index] === '--output') result.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readEvents(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function toolCalls(events) {
  return events.flatMap((event) =>
    event.type === 'assistant' && Array.isArray(event.message?.content)
      ? event.message.content.filter((block) => block.type === 'tool_use')
      : []
  );
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main() {
  const options = parseArgs(process.argv);
  const { SKILL_TASKS } = await import(pathToFileURL(path.resolve(options.tasks)).href);
  const allTasks = [
    ...SKILL_TASKS.map((task) => ({ ...task, suite: 'historical' })),
    ...RDK_TASKS.map((task) => ({ ...task, suite: 'rdk-replay' })),
  ];
  const { SkillRegistry } = await import(pathToFileURL(path.resolve(options.legacyRegistry)).href);
  const registry = new SkillRegistry({
    workspaceDir: path.resolve('D:/moss-eval/fixtures/skill-eval/sample-lib'),
  });
  const taskRows = [];
  const matchLatencies = [];
  for (const task of allTasks) {
    const taskDir = path.join(options.run, task.id, 'moss', 'round-1');
    const status = await readJson(path.join(taskDir, 'status.json'));
    const events = await readEvents(path.join(taskDir, 'stream.jsonl'));
    const calls = toolCalls(events);
    const loads = calls.filter((call) => call.name === 'load_skill');
    const namedLoads = loads
      .map((call) => call.input?.name)
      .filter((name) => typeof name === 'string');
    let matched = [];
    const start = process.hrtime.bigint();
    for (let iteration = 0; iteration < 100; iteration++)
      matched = registry.matchByText(task.prompt);
    matchLatencies.push(Number(process.hrtime.bigint() - start) / 1e6 / 100);
    taskRows.push({
      id: task.id,
      suite: task.suite,
      kind: task.kind,
      language: task.lang,
      expectedSkills: task.expectedSkills,
      legacyMatchedSkills: matched.map((skill) => skill.name),
      injectedCharsEstimate: matched.reduce(
        (sum, skill) => sum + (skill.body?.length ?? skill.description?.length ?? 0),
        0
      ),
      explicitLoadSkillCalls: loads.length,
      explicitNamedLoads: namedLoads,
      terminalReason: status?.terminalReason ?? 'missing',
      durationMs: status?.durationMs ?? null,
      downstreamProxyPassed: status ? status.terminalReason === 'completed' : undefined,
      parsedEvents: events.length,
    });
  }
  const groups = (predicate) => taskRows.filter(predicate);
  const correct = (row) => {
    const expected = new Set(row.expectedSkills);
    const actual = new Set(row.legacyMatchedSkills);
    return expected.size === actual.size && [...expected].every((name) => actual.has(name));
  };
  const accuracy = (rows) => (rows.length ? rows.filter(correct).length / rows.length : 0);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRun: path.resolve(options.run),
    sourceDigest: crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          taskRows.map((row) => ({
            id: row.id,
            terminalReason: row.terminalReason,
            durationMs: row.durationMs,
          }))
        )
      )
      .digest('hex'),
    caveats: [
      'downstreamProxyPassed means the historical agent process completed; the old suite did not persist a task-specific downstream verifier result',
      'injectedCharsEstimate replays the legacy matcher against the installed 0.6.0 registry because the historical stream did not emit injected context size',
      'named load_skill calls are separated from catalog/list queries',
    ],
    metrics: {
      taskCount: taskRows.length,
      historicalTaskCount: groups((row) => row.suite === 'historical').length,
      rdkReplayTaskCount: groups((row) => row.suite === 'rdk-replay').length,
      singleExactMatch: accuracy(
        groups((row) => row.suite === 'historical' && row.kind === 'single')
      ),
      multiExactMatch: accuracy(
        groups((row) => row.suite === 'historical' && row.kind === 'multi')
      ),
      rejectionAccuracy: accuracy(
        groups((row) => row.suite === 'historical' && row.kind === 'reject')
      ),
      chineseExactMatch: accuracy(
        groups((row) => row.suite === 'historical' && row.language === 'zh')
      ),
      englishExactMatch: accuracy(
        groups((row) => row.suite === 'historical' && row.language === 'en')
      ),
      rdkExactMatch: accuracy(groups((row) => row.suite === 'rdk-replay')),
      averageMatcherLatencyMs: mean(matchLatencies),
      p95MatcherLatencyMs:
        [...matchLatencies].sort((a, b) => a - b)[Math.floor(matchLatencies.length * 0.95)] ?? 0,
      injectedCharsEstimate: taskRows.reduce((sum, row) => sum + row.injectedCharsEstimate, 0),
      explicitLoadSkillCalls: taskRows.reduce((sum, row) => sum + row.explicitLoadSkillCalls, 0),
      explicitNamedLoads: taskRows.reduce((sum, row) => sum + row.explicitNamedLoads.length, 0),
      downstreamProxyPassRate: mean(
        taskRows
          .filter((row) => row.downstreamProxyPassed !== undefined)
          .map((row) => (row.downstreamProxyPassed ? 1 : 0))
      ),
      averageEndToEndDurationMs: mean(
        taskRows.map((row) => row.durationMs).filter((value) => typeof value === 'number')
      ),
      terminalReasons: Object.fromEntries(
        [...new Set(taskRows.map((row) => row.terminalReason))].map((reason) => [
          reason,
          taskRows.filter((row) => row.terminalReason === reason).length,
        ])
      ),
    },
    tasks: taskRows,
  };
  await fs.mkdir(options.output, { recursive: true });
  await fs.writeFile(path.join(options.output, 'baseline.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(
    path.join(options.output, 'summary.md'),
    `# Legacy skill baseline\n\nGenerated: ${result.generatedAt}\n\nSource: \`${result.sourceRun}\`\n\n\`downstreamProxyPassed\` is historical process completion, not a persisted semantic verifier result.\n\n\`\`\`json\n${JSON.stringify(result.metrics, null, 2)}\n\`\`\`\n`
  );
  console.log(JSON.stringify(result.metrics, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
