#!/usr/bin/env node
/**
 * `npm run bench:device` — board-task success rate.
 *
 *   npm run bench:device -- --dry
 *   npm run bench:device -- --target sim --model <id> --base-url <url>
 *   npm run bench:device -- --target real
 *
 * --dry needs no model key and no device. It still drives Moss's task engine
 * and command verdict. Results land in bench/results/ (not committed).
 */
import { formatMissing, loadDeviceTasks, runDeviceBench } from './lib/device-bench.mjs';

function usage() {
  return [
    'Usage: npm run bench:device -- [flags]',
    '',
    'Flags:',
    '  --dry                 scripted oracle, no model, no SSH (default without MOSS_DEVICE_HOST)',
    '  --target <dry|sim|real>',
    '  --task <substr>       only tasks whose id contains <substr> (repeatable)',
    '  --repeat <n>          run the suite n times and report mean and spread',
    '  --label <name>        result directory name under bench/results/',
    '  --keep-artifacts      copy each task workspace .moss/ to <label>/<task>-NN.moss/',
    '  --approval <mode>     full (default) | inherit | manual',
    '  --sim-camera          treat a simulated camera as present',
    '  --sim-ros             put the simulated ros2 on PATH',
    '  --model <id>          live provider model (with MOSS_BENCH_API_KEY)',
    '  --base-url <url>      live provider base URL',
    '  --list                list tasks and exit',
    '  --help                show this help',
    '',
    'Model: the moss config file (MOSS_CONFIG_DIR / MOSS_CONFIG_FILE /',
    '~/.config/moss/config.json) plus --model and --base-url. MOSS_API_KEY is ignored.',
    'Real board: MOSS_DEVICE_HOST/PORT/USER/KIND and RDK_S600_PASSWORD',
    '(or MOSS_DEVICE_PASSWORD or MOSS_DEVICE_KEY). The password is never printed.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { filters: [], simCamera: false, simRos: false, repeat: 1, keepArtifacts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--dry') out.mode = 'dry';
    else if (arg === '--target') out.mode = next();
    else if (arg === '--task') out.filters.push(next());
    else if (arg === '--label') out.label = next();
    else if (arg === '--repeat') out.repeat = Number(next());
    else if (arg === '--approval') out.approval = next();
    else if (arg === '--model') out.model = next();
    else if (arg === '--base-url') out.baseUrl = next();
    else if (arg === '--sim-camera') out.simCamera = true;
    else if (arg === '--sim-ros') out.simRos = true;
    else if (arg === '--keep-artifacts') out.keepArtifacts = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isInteger(args.repeat) || args.repeat < 1) {
  console.error('--repeat requires a positive integer');
  process.exit(2);
}
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (args.list) {
  const tasks = loadDeviceTasks();
  for (const task of tasks) {
    if (args.filters.length > 0 && !args.filters.some((filter) => task.id.includes(filter)))
      continue;
    console.log(`${task.id.padEnd(22)} ${task.sideEffect.padEnd(10)} ${task.title}`);
  }
  process.exit(0);
}

let result;
try {
  result = await runDeviceBench({
    ...(args.mode ? { mode: args.mode } : {}),
    filters: args.filters,
    ...(args.label ? { label: args.label } : {}),
    repeat: args.repeat,
    ...(args.approval ? { approval: args.approval } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    simCamera: args.simCamera,
    simRos: args.simRos,
    keepArtifacts: args.keepArtifacts,
    onLine: (line) => console.log(line),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(2);
}

if (result.exitCode === 2) {
  console.error(formatMissing(result.missing ?? ['provider']));
  process.exit(2);
}
if (result.summary) {
  const rate =
    result.summary.successRate == null
      ? 'n/a'
      : `${(result.summary.successRate * 100).toFixed(1)}%`;
  console.log(
    `[device-bench] success ${result.summary.passed}/${result.summary.scored} = ${rate} skipped=${result.summary.skipped} falseSuccess=${result.summary.falseSuccess}`
  );
  console.log(`[device-bench] wrote ${result.summaryPath}`);
}
process.exit(result.exitCode);
