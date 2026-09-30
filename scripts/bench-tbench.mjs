#!/usr/bin/env node
/**
 * Terminal-Bench runner for moss (v0.16-S5).
 *
 * Per task: build the task's own docker image from the terminal-bench clone,
 * run moss headless inside it with the task instruction, then execute the
 * task's run-tests.sh — exit 0 means resolved. Task images build natively on
 * this host (arm64), so the injected node runtime is arm64.
 *
 * Env: MOSS_BENCH_API_KEY. Flags: --samples N --concurrency K --label L
 *        --filter substr --limit N --model M --base-url U
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  docker,
  execContainer,
  writeProviderConfig,
  cleanupContainer,
  ensureNodeTarballForArch,
  metricsFromStreamJson,
} from './lib/swebench-adapter.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const BOARDS = path.join(repoRoot, 'bench', 'boards', 'tbench-instances.json');
const TB_TASKS = path.join(repoRoot, 'bench', '.cache', 'tb-repo', 'original-tasks');
const RESULTS = path.join(repoRoot, 'bench', 'results');
const CACHE = path.join(repoRoot, 'bench', '.cache');

function parseArgs(argv) {
  const out = {
    samples: 1,
    concurrency: 1,
    label: null,
    filter: null,
    limit: null,
    model: null,
    baseUrl: null,
  };
  const next = () => {
    const v = argv.shift();
    if (v === undefined) throw new Error('missing flag value');
    return v;
  };
  while (argv.length) {
    const a = argv.shift();
    if (a === '--samples') out.samples = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--label') out.label = next();
    else if (a === '--filter') out.filter = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--model') out.model = next();
    else if (a === '--base-url') out.baseUrl = next();
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

function loadProvider(args) {
  let apiKey = process.env.MOSS_BENCH_API_KEY;
  let model = args.model;
  let baseUrl = args.baseUrl;
  if (!apiKey || !model || !baseUrl) {
    try {
      const settings = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.qoder-cn', 'settings.json'), 'utf8')
      );
      for (const entry of Object.values(settings.providers ?? {})) {
        const names = [entry.model, ...(entry.models ?? []).map((m) => m.model)].filter(Boolean);
        if (names.some((n) => String(n).toLowerCase().startsWith('deepseek'))) {
          apiKey = apiKey || entry.apiKey;
          model = model || names.find((n) => String(n).toLowerCase().startsWith('deepseek'));
          baseUrl = baseUrl || entry.baseUrl;
        }
      }
    } catch {
      /* env only */
    }
  }
  if (!apiKey || !model || !baseUrl) {
    console.error('[tb] missing provider config');
    process.exit(2);
  }
  return { apiKey, model, baseUrl };
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function buildTaskImage(task, tag) {
  const dir = path.join(TB_TASKS, task);
  const r = spawnSync('docker', ['build', '-q', '-t', tag, dir], {
    encoding: 'utf8',
    timeout: 15 * 60_000,
  });
  if (r.status !== 0) {
    return { ok: false, error: `${r.stderr ?? ''}`.slice(-400) };
  }
  return { ok: true };
}

async function runTask(task, sample, provider, ctx) {
  const name = `moss-tb-${task}-${sample}`.toLowerCase();
  const jobDir = path.join(ctx.runDir, 'samples', `${task}-${sample}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const t0 = Date.now();
  const image = `moss-tb-${task}:latest`;
  try {
    if (!ctx.imagesBuilt.has(image)) {
      const build = buildTaskImage(task, image);
      if (!build.ok) throw new Error(`docker build failed: ${build.error}`);
      ctx.imagesBuilt.add(image);
    }
    const run = await docker([
      'run',
      '-d',
      '--name',
      name,
      '--memory',
      '4g',
      image,
      'sleep',
      'infinity',
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.err || run.out}`);
    await execContainer(name, 'mkdir -p /opt/node /opt/moss /root/.config/moss');
    await docker(['cp', ctx.nodeTar, `${name}:/tmp/node.tar.gz`]);
    await docker(['cp', `${ctx.distDir}/.`, `${name}:/opt/moss/`]);
    await docker(['cp', `${repoRoot}/node_modules`, `${name}:/opt/moss/node_modules`]);
    const setup = await execContainer(
      name,
      'tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 && chmod +x /opt/moss/cli.js'
    );
    if (setup.code !== 0) throw new Error(`setup failed: ${setup.err}`);
    await writeProviderConfig(name, provider);

    const promptFile = '/tmp/tb-prompt.txt';
    const prompt = [
      'You are working in this container. Complete the task below.',
      'Use the shell and file tools; verify your work before finishing.',
      'Do not modify or delete the tests directory or run-tests.sh.',
      '',
      'TASK:',
      task.instruction ?? '',
    ].join('\n');
    const write = await execContainer(
      name,
      `cat > ${promptFile} <<'TBEOF'\n${prompt.replace(/TBEOF/g, 'TBEOF_')}\nTBEOF`
    );
    if (write.code !== 0) throw new Error(`prompt write failed: ${write.err}`);

    const mossCmd = [
      'export PATH=/opt/node/bin:$PATH',
      'cd /app 2>/dev/null || cd /',
      'export MOSS_CONFIG_DIR=/root/.config/moss',
      'export MOSS_RUN_ID=tb/' + task.task,
      'export MOSS_SAFETY_MODE=full-access',
      'export MOSS_APPROVAL_POLICY=never',
      'export MOSS_NO_COLOR=1',
      `node /opt/moss/cli.js -p --output-format stream-json --ask-for-approval never --model ${JSON.stringify(
        provider.model
      )} --base-url ${JSON.stringify(provider.baseUrl)} --max-turns ${ctx.maxTurns} "$(cat ${promptFile})"`,
    ].join('\n');
    const run2 = await docker(['exec', name, 'bash', '-lc', mossCmd], {
      timeoutMs: (task.maxAgentTimeoutSec ?? 900) * 1000,
    });
    fs.writeFileSync(path.join(jobDir, 'run.jsonl'), run2.out || '');
    if (run2.err) fs.writeFileSync(path.join(jobDir, 'run.stderr.log'), run2.err);
    const metrics = metricsFromStreamJson(run2.out || '');

    // Official grading: the task's own run-tests.sh (pytest parser).
    const test = await docker(
      [
        'exec',
        name,
        'bash',
        '-lc',
        'cd /app 2>/dev/null || cd /; bash run-tests.sh 2>&1 | tail -20',
      ],
      { timeoutMs: (task.maxTestTimeoutSec ?? 180) * 1000 + 30_000 }
    );
    fs.writeFileSync(path.join(jobDir, 'tests.log'), test.out || '');
    const record = {
      task: task.task,
      sample,
      agentExit: run2.code,
      testsExit: test.code,
      resolved: test.code === 0,
      wallMs: Date.now() - t0,
      ...metrics,
    };
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(record, null, 2));
    return record;
  } catch (err) {
    const record = {
      task: task.task,
      sample,
      error: String(err?.message ?? err).slice(0, 400),
      resolved: false,
      wallMs: Date.now() - t0,
    };
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(record, null, 2));
    return record;
  } finally {
    await cleanupContainer(name);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider = loadProvider(args);
  const board = JSON.parse(fs.readFileSync(BOARDS, 'utf8'));
  let tasks = board.tasks;
  if (args.filter) tasks = tasks.filter((t) => t.task.includes(args.filter));
  if (args.limit) tasks = tasks.slice(0, args.limit);
  const label = args.label ?? `tb-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}`;
  const runDir = path.join(RESULTS, label);
  fs.mkdirSync(runDir, { recursive: true });

  const distDir = path.join(repoRoot, 'dist');
  if (!fs.existsSync(path.join(distDir, 'cli.js'))) {
    console.error('[tb] dist/cli.js missing — build first');
    process.exit(2);
  }
  const nodeTar = await ensureNodeTarballForArch(
    CACHE,
    process.platform === 'darwin' ? 'arm64' : 'x64'
  );
  const ctx = {
    runDir,
    distDir,
    nodeTar,
    imagesBuilt: new Set(),
    maxTurns: 40,
  };

  console.log(
    `[tb] label=${label} tasks=${tasks.length} samples=${args.samples} model=${provider.model} sha=${gitSha()}`
  );
  const results = [];
  let cursor = 0;
  const jobs = [];
  for (const t of tasks) for (let s = 1; s <= args.samples; s += 1) jobs.push({ t, s });
  async function worker(wid) {
    while (cursor < jobs.length) {
      const { t, s } = jobs[cursor++];
      const record = await runTask(t, s, provider, ctx);
      results.push(record);
      console.log(
        `[tb] w${wid} ${t.task}#${s} resolved=${record.resolved} ${((record.wallMs ?? 0) / 60000).toFixed(1)}m${record.error ? ' ERR=' + record.error.slice(0, 120) : ''}`
      );
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, (_, i) => worker(i + 1)));

  const resolved = results.filter((r) => r.resolved).length;
  const uniqueResolved = new Set(results.filter((r) => r.resolved).map((r) => r.task)).size;
  const summary = {
    label,
    sha: gitSha(),
    model: provider.model,
    tasks: tasks.length,
    samples: args.samples,
    runs: results.length,
    resolvedRuns: resolved,
    resolvedTasks: uniqueResolved,
    resolvedPct: tasks.length ? Math.round((uniqueResolved / tasks.length) * 1000) / 10 : 0,
    errors: results.filter((r) => r.error).length,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('[tb] complete', JSON.stringify(summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
