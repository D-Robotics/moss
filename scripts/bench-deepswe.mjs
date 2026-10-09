#!/usr/bin/env node
/**
 * Same-model harness comparison on DeepSWE v1.1.
 *
 * The published scores live in bench/boards/deepswe-v1.1-harness.json.
 * This command runs Moss through Pier on that task set, so the verifier is
 * the one the other harnesses used. Official comparison is 8 samples,
 * temperature 1.0, top_p 0.95. Defaults here are a single sample so a host
 * can prove the path; pass --samples 8 for the published protocol.
 *
 *   node scripts/bench-deepswe.mjs --tasks /path/to/deep-swe/tasks --n-tasks 1
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const out = {
    tasks: process.env.MOSS_DEEPSWE_TASKS ?? '',
    samples: 1,
    nTasks: null,
    concurrency: 1,
    memoryMb: Number(process.env.MOSS_DEEPSWE_MEMORY_MB ?? 8192),
    jobName: 'moss-deepswe',
    pier: process.env.MOSS_PIER ?? 'pier',
  };
  const next = () => {
    const value = argv.shift();
    if (value === undefined) throw new Error('missing flag value');
    return value;
  };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--tasks') out.tasks = next();
    else if (arg === '--samples') out.samples = Number(next());
    else if (arg === '--n-tasks') out.nTasks = Number(next());
    else if (arg === '--concurrency') out.concurrency = Number(next());
    else if (arg === '--memory-mb') out.memoryMb = Number(next());
    else if (arg === '--job-name') out.jobName = next();
    else if (arg === '--pier') out.pier = next();
    else throw new Error(`unknown flag ${arg}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const board = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bench/boards/deepswe-v1.1-harness.json'), 'utf8')
  );
  console.log(
    `[deepswe] model=${board.model} published protocol samples=${board.protocol.samplesPerTask} temperature=${board.protocol.temperature} top_p=${board.protocol.topP}`
  );
  for (const [harness, score] of Object.entries(board.resolvedPercent)) {
    console.log(`[deepswe] reference ${harness.padEnd(14)} ${score}`);
  }
  if (!args.tasks) {
    console.error('[deepswe] pass --tasks /path/to/deep-swe/tasks (clone datacurve-ai/deep-swe)');
    process.exit(2);
  }
  const env = {
    ...process.env,
    PYTHONPATH: path.join(repoRoot, 'bench/deepswe'),
    MOSS_TEMPERATURE: process.env.MOSS_TEMPERATURE ?? '1',
    MOSS_TOP_P: process.env.MOSS_TOP_P ?? '0.95',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? process.env.MOSS_BENCH_API_KEY ?? '',
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? process.env.MOSS_BENCH_BASE_URL ?? '',
  };
  const cmd = [
    args.pier,
    'run',
    '-p',
    args.tasks,
    '--agent-import-path',
    'moss_agent:MossHarnessAgent',
    '--model',
    process.env.MOSS_BENCH_MODEL ?? 'deepseek-flash',
    '-n',
    String(args.concurrency),
    '-k',
    String(args.samples),
    '--override-memory-mb',
    String(args.memoryMb),
    '--job-name',
    args.jobName,
    '-y',
  ];
  if (args.nTasks) cmd.push('--n-tasks', String(args.nTasks));
  if (args.samples !== board.protocol.samplesPerTask) {
    console.log(
      `[deepswe] this run uses ${args.samples} sample(s); the published table uses ${board.protocol.samplesPerTask}`
    );
  }
  const child = spawnSync(cmd[0], cmd.slice(1), { cwd: repoRoot, env, stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

main();
