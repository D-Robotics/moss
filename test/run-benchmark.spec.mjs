#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import * as benchmark from '../scripts/run-benchmark.mjs';

const { parseArgs } = benchmark;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(repoRoot, 'scripts', 'run-benchmark.mjs');

// Intercept non-task reads and stop before the synthetic provider config is
// written. Guard against child processes so no benchmark can be launched.
const providerProbe = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(process.argv[1]);
for (const key of ['MOSS_BENCH_API_KEY', 'MOSS_BENCH_MODEL', 'MOSS_BENCH_BASE_URL']) {
  if (Object.hasOwn(input.env, key)) process.env[key] = input.env[key];
  else delete process.env[key];
}
process.env.MOSS_BENCH_CLI = input.runner;
const originalRead = fs.readFileSync;
let unexpectedReads = 0;
fs.readFileSync = (file, ...options) => {
  const target = String(file);
  if (target.startsWith(input.tasksRoot + path.sep) && path.basename(target) === 'task.json') {
    return originalRead(file, ...options);
  }
  unexpectedReads += 1;
  return JSON.stringify({ providers: { synthetic: {
    model: 'deepseek-untrusted', baseUrl: 'https://untrusted.invalid/v1', apiKey: 'untrusted-key'
  } } });
};
fs.mkdirSync = () => undefined;
fs.mkdtempSync = () => '/synthetic-bench';
let config;
process.on('exit', () => console.log(JSON.stringify({ config, unexpectedReads })));
fs.writeFileSync = (_file, content) => {
  config = JSON.parse(content);
  process.exit(0);
};
childProcess.spawn = () => { throw new Error('unexpected child process'); };
childProcess.spawnSync = () => { throw new Error('unexpected child process'); };
syncBuiltinESMExports();
process.argv = [process.execPath, input.runner, '--task', 'single-edit', ...input.args];
await import(pathToFileURL(input.runner).href);
`;

function providerSetup(env, args = []) {
  const input = { env, args, runner, tasksRoot: path.join(repoRoot, 'bench', 'tasks') };
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', providerProbe, JSON.stringify(input)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );
}

function listTasks(args) {
  return spawnSync(process.execPath, [runner, ...args, '--list'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('temperature values preserve following task, model, and label options', () => {
  assert.equal(parseArgs([]).temperature, 0);
  for (const [temperature, expected] of [
    ['0', 0],
    ['0.35', 0.35],
    ['none', undefined],
    ['2', 2],
  ]) {
    for (const args of [
      ['--task', 'single-edit', '--model', 'synthetic-model', '--label', 'synthetic-label'],
      ['--model', 'synthetic-model', '--task', 'single-edit', '--label', 'synthetic-label'],
      ['--label', 'synthetic-label', '--model', 'synthetic-model', '--task', 'single-edit'],
    ]) {
      const fullArgs = ['--temperature', temperature, ...args];
      const parsed = parseArgs(fullArgs);
      assert.equal(parsed.temperature, expected);
      assert.deepEqual(parsed.taskFilters, ['single-edit']);
      assert.equal(parsed.model, 'synthetic-model');
      assert.equal(parsed.label, 'synthetic-label');
      const result = listTasks(fullArgs);
      assert.equal(result.status, 0, `${temperature}: ${result.stderr}`);
      assert.match(result.stdout, /^single-edit\s/m);
    }
  }
});

test('the RSI gate argument order retains its label, sample, and provider flags', () => {
  const args = [
    '--samples',
    '3',
    '--temperature',
    '0',
    '--label',
    'rsi-test',
    '--keep-artifacts',
    '--tasks',
    '15',
    '--seed',
    'synthetic-seed',
    '--model',
    'synthetic-model',
    '--base-url',
    'https://explicit.invalid/v1',
  ];
  const parsed = parseArgs(args);
  assert.equal(parsed.samples, 3);
  assert.equal(parsed.temperature, 0);
  assert.equal(parsed.label, 'rsi-test');
  assert.equal(parsed.keepArtifacts, true);
  assert.equal(parsed.tasks, 15);
  assert.equal(parsed.seed, 'synthetic-seed');
  assert.equal(parsed.model, 'synthetic-model');
  assert.equal(parsed.baseUrl, 'https://explicit.invalid/v1');
  const result = listTasks(args);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task sample n=15 seed=synthetic-seed/);
});

test('benchmark controls preserve A/B switches, unset values, and none temperature', () => {
  assert.equal(typeof benchmark.benchmarkChildOverrides, 'function');
  const parent = {
    MOSS_BEST_OF_N: '3',
    MOSS_REASONING_BUDGET: 'off',
    MOSS_PLAN_GATE: '1',
    MOSS_MODEL_CHEAP: 'cheap-model',
    MOSS_MODEL_BALANCED: '',
    MOSS_MODEL_STRONG: 'strong-model',
    MOSS_GOAL_VERIFY_LOOP: '0',
    MOSS_DISABLE_NUDGES: '',
    MOSS_BENCH_API_KEY: 'synthetic-key',
    UNRELATED_SECRET: 'synthetic-secret',
    TASK_SETTING: 'task-value',
  };
  const env = benchmark.benchmarkChildOverrides(parent, ['TASK_SETTING'], undefined);
  assert.deepEqual(env, {
    MOSS_TEMPERATURE: '',
    MOSS_BEST_OF_N: '3',
    MOSS_REASONING_BUDGET: 'off',
    MOSS_PLAN_GATE: '1',
    MOSS_MODEL_CHEAP: 'cheap-model',
    MOSS_MODEL_BALANCED: '',
    MOSS_MODEL_STRONG: 'strong-model',
    MOSS_GOAL_VERIFY_LOOP: '0',
    MOSS_DISABLE_NUDGES: '',
    TASK_SETTING: 'task-value',
  });
  assert.deepEqual(benchmark.benchmarkChildOverrides({}, [], 0.35), {
    MOSS_TEMPERATURE: '0.35',
  });
});

function isolatedSourceFunction(file, name, globals = {}) {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  assert.ok(declaration, `missing ${name} in ${file}`);
  const javascript = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = { exports: {}, ...globals };
  vm.runInNewContext(javascript, sandbox, { timeout: 1000 });
  return sandbox.exports[name];
}

function isolatedSourceMethod(file, name, globals = {}) {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements
    .filter(ts.isClassDeclaration)
    .flatMap((node) => [...node.members])
    .find((member) => ts.isMethodDeclaration(member) && member.name.getText(parsed) === name);
  assert.ok(declaration, `missing ${name} in ${file}`);
  const method = declaration.getText(parsed).replace(/^private\s+/, '');
  const javascript = ts.transpileModule(`exports.method = ({ ${method} }).${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const sandbox = { exports: {}, ...globals };
  vm.runInNewContext(javascript, sandbox, { timeout: 1000 });
  return sandbox.exports.method;
}

test('none blocks a synthetic dotenv temperature and resolves as unset', () => {
  const env = benchmark.benchmarkChildOverrides({}, [], undefined);
  const loadEnvFile = isolatedSourceFunction('src/cli/config.ts', 'loadEnvFile', {
    fs: { readFileSync: () => 'MOSS_TEMPERATURE=1.5\n' },
    process: { env },
    ENV_FILE_IGNORED_KEYS: new Set(),
    isDotenvSafetyEnvKey: () => false,
    isDotenvDeniedEnvKey: () => false,
  });
  loadEnvFile('synthetic.env');
  assert.equal(env.MOSS_TEMPERATURE, '');
  const resolve = isolatedSourceFunction('src/cli/oneshot.ts', 'resolveTemperatureFromEnv');
  const temperature = resolve(env);
  assert.equal(temperature, undefined);
  const buildOptions = isolatedSourceMethod('src/provider/pi-ai-adapter.ts', 'buildPiOptions', {
    envPreferMoss: () => undefined,
  });
  const options = buildOptions.call({ apiKey: 'synthetic-key' }, { temperature });
  assert.equal(Object.hasOwn(options, 'temperature'), false);
});

test('explicit provider setup never reads other application configuration', () => {
  const result = providerSetup({ MOSS_BENCH_API_KEY: 'synthetic-key' }, [
    '--model',
    'synthetic-model',
    '--base-url',
    'https://explicit.invalid/v1',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const { config, unexpectedReads } = JSON.parse(result.stdout);
  assert.equal(unexpectedReads, 0);
  assert.equal(config.apiKey, 'synthetic-key');
  assert.equal(config.model, 'synthetic-model');
  assert.equal(config.baseUrl, 'https://explicit.invalid/v1');
});

test('provider model and base URL can come from environment with flag overrides', () => {
  const env = {
    MOSS_BENCH_API_KEY: 'synthetic-key',
    MOSS_BENCH_MODEL: 'environment-model',
    MOSS_BENCH_BASE_URL: 'https://environment.invalid/v1',
  };
  for (const [args, model, baseUrl] of [
    [[], 'environment-model', 'https://environment.invalid/v1'],
    [['--model', 'flag-model'], 'flag-model', 'https://environment.invalid/v1'],
    [['--base-url', 'https://flag.invalid/v1'], 'environment-model', 'https://flag.invalid/v1'],
    [
      ['--base-url', 'https://flag.invalid/custom/path?api-version=2024-01'],
      'environment-model',
      'https://flag.invalid/custom/path?api-version=2024-01',
    ],
    [
      ['--model', 'flag-model', '--base-url', 'https://flag.invalid/v1'],
      'flag-model',
      'https://flag.invalid/v1',
    ],
  ]) {
    const result = providerSetup(env, args);
    assert.equal(result.status, 0, result.stderr);
    const { config, unexpectedReads } = JSON.parse(result.stdout);
    assert.equal(unexpectedReads, 0);
    assert.equal(config.apiKey, 'synthetic-key');
    assert.equal(config.model, model);
    assert.equal(config.baseUrl, baseUrl);
  }
});

test('missing provider fields fail without using another application or a default endpoint', () => {
  const complete = {
    MOSS_BENCH_API_KEY: 'synthetic-key',
    MOSS_BENCH_MODEL: 'environment-model',
    MOSS_BENCH_BASE_URL: 'https://environment.invalid/v1',
  };
  for (const field of Object.keys(complete)) {
    const env = { ...complete };
    delete env[field];
    const result = providerSetup(env);
    assert.equal(result.status, 2, `${field}: ${result.stderr}`);
    assert.match(result.stderr, /MOSS_BENCH_API_KEY/);
    assert.match(result.stderr, /MOSS_BENCH_MODEL.*--model/);
    assert.match(result.stderr, /MOSS_BENCH_BASE_URL.*--base-url/);
    const { config, unexpectedReads } = JSON.parse(result.stdout);
    assert.equal(unexpectedReads, 0);
    assert.equal(config, undefined);
  }
});

test('empty provider values do not fall back to another endpoint or key', () => {
  const complete = {
    MOSS_BENCH_API_KEY: 'synthetic-key',
    MOSS_BENCH_MODEL: 'environment-model',
    MOSS_BENCH_BASE_URL: 'https://environment.invalid/v1',
  };
  for (const [env, args] of [
    [{ ...complete, MOSS_BENCH_API_KEY: ' ' }, []],
    [complete, ['--model', '']],
    [complete, ['--model', ' ']],
    [complete, ['--base-url', '']],
    [complete, ['--base-url', ' ']],
  ]) {
    const result = providerSetup(env, args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no provider config/);
    const { config, unexpectedReads } = JSON.parse(result.stdout);
    assert.equal(unexpectedReads, 0);
    assert.equal(config, undefined);
  }
});

test('provider URLs with userinfo are rejected without logging it', () => {
  const env = {
    MOSS_BENCH_API_KEY: 'synthetic-key',
    MOSS_BENCH_MODEL: 'environment-model',
    MOSS_BENCH_BASE_URL: 'https://environment.invalid/v1',
  };
  for (const url of [
    'https://synthetic-user:synthetic-password@example.invalid/v1',
    'https://synthetic-user@example.invalid/v1',
  ]) {
    const result = providerSetup(env, ['--base-url', url]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /base-url.*userinfo/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /synthetic-user|synthetic-password/);
    const { config, unexpectedReads } = JSON.parse(result.stdout);
    assert.equal(unexpectedReads, 0);
    assert.equal(config, undefined);
  }
});

test('help explains the explicit provider settings', () => {
  const result = spawnSync(process.execPath, [runner, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MOSS_BENCH_API_KEY/);
  assert.match(result.stdout, /MOSS_BENCH_MODEL/);
  assert.match(result.stdout, /MOSS_BENCH_BASE_URL/);
  assert.doesNotMatch(result.stdout, /qoder/i);
});

test('missing option values do not consume the next flag', () => {
  for (const flag of ['--label', '--task', '--temperature', '--model', '--base-url']) {
    assert.throws(() => parseArgs([flag, '--list']), new RegExp(`${flag} requires a value`));
    assert.throws(() => parseArgs([flag, '-h']), new RegExp(`${flag} requires a value`));
  }
});

test('invalid and out-of-range temperatures fail before listing tasks', () => {
  assert.throws(() => parseArgs(['--temperature']), /--temperature requires a value/);
  for (const temperature of [
    'NaN',
    'Infinity',
    '-Infinity',
    '1e309',
    'not-a-number',
    '-0.5',
    '2.5',
    '',
    ' ',
  ]) {
    const result = listTasks(['--temperature', temperature, '--task', 'single-edit']);
    assert.equal(result.status, 2, `${temperature}: ${result.stdout}`);
    assert.match(result.stderr, /--temperature.*(?:finite|0.*2)/);
    assert.doesNotMatch(result.stdout, /^single-edit\s/m);
  }
});
