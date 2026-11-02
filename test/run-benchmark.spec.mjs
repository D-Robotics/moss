#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../scripts/run-benchmark.mjs';

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
    ['-0.5', -0.5],
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

test('non-finite temperature values fail before listing tasks', () => {
  assert.throws(() => parseArgs(['--temperature']), /--temperature requires a value/);
  for (const temperature of ['NaN', 'Infinity', '-Infinity', '1e309', 'not-a-number']) {
    const result = listTasks(['--temperature', temperature, '--task', 'single-edit']);
    assert.equal(result.status, 2, `${temperature}: ${result.stdout}`);
    assert.match(result.stderr, /--temperature.*finite/);
    assert.doesNotMatch(result.stdout, /^single-edit\s/m);
  }
});
