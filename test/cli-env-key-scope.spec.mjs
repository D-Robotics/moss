#!/usr/bin/env node
/**
 * An env key is sent only to its own provider's official preset URL, or when
 * the user file names apiKeyEnv. A project file never triggers a read.
 * Real runs use a clean env (no inherited keys) and a temp HOME.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackTempDir } from './helpers/temp-home.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

const { loadCliConfigFile, resolveCliConfig } = await import('../dist/cli/config.js');

const DEEPSEEK = 'sk-scope-deepseek-0001';
const OPENAI = 'sk-scope-openai-0002';
const CI_PAT = 'ci-scope-token-0003';
const GATEWAY = 'sk-scope-gateway-0004';

function tempDir(prefix) {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    LC_ALL: 'C',
    TERM: 'dumb',
    MOSS_CONFIG_DIR: path.join(home, 'config'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

function resolveAt(env, workspace) {
  const loaded = loadCliConfigFile(env, [], workspace);
  return { loaded, resolved: resolveCliConfig(env, loaded.config, {}, loaded) };
}

function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content: 'STUB_SCOPE_OK' },
            finish_reason: 'stop',
          },
        ],
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        seen,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runMoss(env, workspace) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', 'hi', '-C', workspace], {
      cwd: workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.stdin.end();
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const stub = await startStub();
try {
  // A–D: an env key is not sent. A custom user URL, a project endpoint, a
  // project apiKeyEnv, and a project baseUrl-only file all stay silent.
  const blocked = [
    {
      id: 'A',
      where: 'user',
      file: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: stub.baseUrl },
      envKey: ['DEEPSEEK_API_KEY', DEEPSEEK],
      secret: DEEPSEEK,
    },
    {
      id: 'B',
      where: 'project',
      file: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: stub.baseUrl },
      envKey: ['OPENAI_API_KEY', OPENAI],
      secret: OPENAI,
    },
    {
      id: 'C',
      where: 'project',
      file: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: stub.baseUrl,
        apiKeyEnv: 'MY_CI_PAT',
      },
      envKey: ['MY_CI_PAT', CI_PAT],
      secret: CI_PAT,
      dropApiKeyEnv: true,
    },
    {
      id: 'D',
      where: 'project',
      file: { baseUrl: stub.baseUrl },
      envKey: ['DEEPSEEK_API_KEY', DEEPSEEK],
      secret: DEEPSEEK,
    },
  ];
  for (const row of blocked) {
    const home = tempDir(`moss-scope-${row.id}-`);
    const workspace = tempDir(`moss-scope-${row.id}-ws-`);
    const file =
      row.where === 'user'
        ? path.join(home, 'config', 'config.json')
        : path.join(workspace, '.moss', 'config.json');
    writeJson(file, row.file);
    const env = cleanEnv(home, { [row.envKey[0]]: row.envKey[1] });
    const { loaded, resolved } = resolveAt(env, workspace);
    assert.equal(resolved.apiKey, '', row.id);
    if (row.dropApiKeyEnv) assert.equal(loaded.config.apiKeyEnv, undefined, row.id);
    if (row.id === 'A') assert.notEqual(resolved.apiKeySource, 'env:DEEPSEEK_API_KEY');
    stub.seen.length = 0;
    const ran = await runMoss(env, workspace);
    assert.equal(ran.status, 3, `${row.id}\n${ran.stdout}\n${ran.stderr}`);
    assert.equal(stub.seen.length, 0, row.id);
    assert.equal(`${ran.stdout}${ran.stderr}`.includes(row.secret), false, row.id);
  }

  // Official preset still reads that provider's own env key.
  {
    const home = tempDir('moss-scope-official-');
    const workspace = tempDir('moss-scope-official-ws-');
    writeJson(path.join(home, 'config', 'config.json'), {
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
    });
    const { resolved } = resolveAt(cleanEnv(home, { DEEPSEEK_API_KEY: DEEPSEEK }), workspace);
    assert.equal(resolved.apiKey, DEEPSEEK);
    assert.equal(resolved.apiKeySource, 'env:DEEPSEEK_API_KEY');
    const wrong = resolveAt(cleanEnv(home, { OPENAI_API_KEY: OPENAI }), workspace).resolved;
    assert.equal(wrong.apiKey, '');
  }

  // A blank user file does not auto-send the only key present.
  {
    const home = tempDir('moss-scope-blank-');
    const workspace = tempDir('moss-scope-blank-ws-');
    const { resolved } = resolveAt(cleanEnv(home, { DEEPSEEK_API_KEY: DEEPSEEK }), workspace);
    assert.equal(resolved.apiKey, '');
  }

  // User-level apiKeyEnv is the only way a custom base URL reads an env var.
  {
    const home = tempDir('moss-scope-named-');
    const workspace = tempDir('moss-scope-named-ws-');
    writeJson(path.join(home, 'config', 'config.json'), {
      provider: 'openai-compatible',
      model: 'stub-alpha',
      baseUrl: stub.baseUrl,
      apiKeyEnv: 'MY_GATEWAY_KEY',
    });
    const env = cleanEnv(home, { MY_GATEWAY_KEY: GATEWAY });
    const { resolved } = resolveAt(env, workspace);
    assert.equal(resolved.apiKey, GATEWAY);
    assert.equal(resolved.apiKeySource, 'env:MY_GATEWAY_KEY');
    stub.seen.length = 0;
    const ran = await runMoss(env, workspace);
    assert.equal(
      stub.seen.some((header) => header === `Bearer ${GATEWAY}`),
      true,
      `status=${ran.status} seen=${JSON.stringify(stub.seen)} err=${ran.stderr?.slice(-500)}`
    );
    assert.equal(`${ran.stdout}${ran.stderr}`.includes(GATEWAY), false);
  }

  // apiKeyEnv with no provider is not a configured endpoint.
  {
    const home = tempDir('moss-scope-named-only-');
    const workspace = tempDir('moss-scope-named-only-ws-');
    writeJson(path.join(home, 'config', 'config.json'), { apiKeyEnv: 'MY_GATEWAY_KEY' });
    const env = cleanEnv(home, { MY_GATEWAY_KEY: GATEWAY });
    const { resolved } = resolveAt(env, workspace);
    assert.equal(resolved.apiKey, '');
    assert.equal(resolved.apiKeySource, 'missing');
    assert.equal(resolved.providerSource, 'unconfigured');
    assert.equal(resolved.baseUrl, '');
    assert.notEqual(resolved.baseUrl, 'https://api.deepseek.com');
    stub.seen.length = 0;
    const ran = await runMoss(env, workspace);
    assert.equal(ran.status, 3, `${ran.stdout}\n${ran.stderr}`);
    assert.equal(stub.seen.length, 0);
    assert.equal(`${ran.stdout}${ran.stderr}`.includes(GATEWAY), false);
    assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /api\.deepseek\.com/);
  }
} finally {
  await stub.close();
}

console.log('[PASS] env key scope');
