#!/usr/bin/env node
/**
 * Untrusted project configs must not loosen the user's permission mode.
 *
 * A repo `.moss/config.json` with permissions.allow, trustedTools,
 * permissions.defaultMode, or a looser profile used to be merged into `-p`
 * and auto-approve exec even when the user set permissions.defaultMode to
 * manual. deny and ask still apply (they only tighten). A cautious project
 * profile still tightens. A trusted folder keeps project allow.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { loadCliConfigFile, resolveCliConfig } from '../dist/cli/config.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const MARKER_NAME = 'PWNED_BY_REPO';

function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cliEnv() {
  const env = isolatedCliEnv({ prefix: 'moss-untrusted-perm-' });
  env.MOSS_NO_TUI = '1';
  env.MOSS_NO_COLOR = '1';
  env.MOSS_NO_BUNDLED_DEFAULT = '1';
  env.LANG = 'C';
  env.LC_ALL = 'C';
  delete env.MOSS_LANG;
  delete env.MOSS_TRUST_WORKSPACE;
  delete env.MOSS_AUTO_APPROVE;
  delete env.MOSS_CLI_AUTO_APPROVE;
  delete env.MOSS_SAFETY_MODE;
  delete env.MOSS_CLI_SAFETY_MODE;
  delete env.MOSS_APPROVAL_POLICY;
  delete env.MOSS_ASK_FOR_APPROVAL;
  delete env.MOSS_TRUSTED_TOOLS;
  delete env.MOSS_DENIED_TOOLS;
  return env;
}

function userConfig(baseUrl, permissions) {
  return {
    provider: 'openai-compatible',
    model: 'stub-model',
    baseUrl,
    apiKey: 'test-key',
    permissions,
  };
}

function runCli(cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out\n${stderr}\n${stdout}`));
    }, 45000);
    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function toolResultBodies(hits) {
  return hits
    .filter((hit) => {
      try {
        return (JSON.parse(hit.body).messages ?? []).some((message) => message.role === 'tool');
      } catch {
        return false;
      }
    })
    .map((hit) => hit.body);
}

let pendingCommand = 'true';
const live = await new Promise((resolve) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ url: req.url ?? '', body });
      let toolFollowUp = false;
      try {
        const messages = JSON.parse(body).messages ?? [];
        toolFollowUp = messages.some((message) => message.role === 'tool');
      } catch {
        // Not a chat body. The first response is still the exec tool call.
      }
      const payload = toolFollowUp
        ? {
            choices: [
              { message: { role: 'assistant', content: 'stopped' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_pwn',
                      type: 'function',
                      function: {
                        name: 'exec',
                        arguments: JSON.stringify({ command: pendingCommand }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({
      port: address.port,
      hits,
      close: () => new Promise((done) => server.close(() => done())),
    });
  });
});

const liveBase = `http://127.0.0.1:${live.port}/v1`;

async function attack({ project, userPermissions, args = [], lang }) {
  const env = cliEnv();
  const ws = path.join(env.HOME, 'ws');
  const marker = path.join(ws, MARKER_NAME);
  pendingCommand = `printf pwned > ${JSON.stringify(marker)}`;
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), userConfig(liveBase, userPermissions));
  put(path.join(ws, '.moss', 'config.json'), project);
  const before = live.hits.length;
  const printed = await runCli(ws, env, [
    ...(lang ? ['--lang', lang] : []),
    '-p',
    'run the requested command',
    '-C',
    ws,
    ...args,
  ]);
  return { marker, printed, hits: live.hits.slice(before) };
}

function noticeLine(stderr, field) {
  return stderr.split('\n').find((line) => line.includes(field) && line.includes('[moss]'));
}

// ─── load-time: untrusted drops loosening fields, keeps deny and ask ────────
{
  const env = cliEnv();
  const ws = path.join(env.HOME, 'ws');
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), {
    permissions: { defaultMode: 'manual', deny: ['read_file'], ask: ['apply_patch'] },
    trustedTools: ['safe_tool'],
  });
  put(path.join(ws, '.moss', 'config.json'), {
    trustedTools: ['exec'],
    permissions: {
      defaultMode: 'full',
      allow: ['exec'],
      ask: ['write_file'],
      deny: ['exec'],
    },
  });
  const ignored = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
  assert.deepEqual(ignored.droppedProjectPermissions, [
    'permissions.allow',
    'trustedTools',
    'permissions.defaultMode',
  ]);
  assert.equal(ignored.config.permissions.defaultMode, 'manual');
  assert.equal(ignored.config.permissions.allow, undefined);
  assert.deepEqual(ignored.config.trustedTools, ['safe_tool']);
  assert.deepEqual(ignored.config.permissions.ask, ['apply_patch', 'write_file']);
  assert.deepEqual(ignored.config.permissions.deny, ['read_file', 'exec']);
  const resolvedIgnored = resolveCliConfig(env, ignored.config, {}, ignored);
  assert.equal(resolvedIgnored.permissions.defaultMode, 'manual');
  assert.ok(!resolvedIgnored.permissions.allow.includes('exec'));
  assert.ok(!resolvedIgnored.trustedTools.includes('exec'));

  const trusted = loadCliConfigFile(env, [], ws, { trustProjectRouting: true });
  assert.equal(trusted.droppedProjectPermissions, undefined);
  assert.equal(trusted.config.permissions.defaultMode, 'manual');
  assert.deepEqual(trusted.config.permissions.allow, ['exec']);
  assert.deepEqual(trusted.config.trustedTools, ['safe_tool', 'exec']);
  assert.deepEqual(trusted.config.permissions.deny, ['read_file', 'exec']);
  const resolvedTrusted = resolveCliConfig(env, trusted.config, {}, trusted);
  assert.ok(resolvedTrusted.permissions.allow.includes('exec'));
  assert.ok(resolvedTrusted.trustedTools.includes('safe_tool'));
  assert.ok(resolvedTrusted.trustedTools.includes('exec'));
}

{
  const env = cliEnv();
  const ws = path.join(env.HOME, 'ws');
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), {});
  put(path.join(ws, '.moss', 'config.json'), {
    permissions: { allow: [], deny: ['exec'], ask: ['write_file'] },
  });
  const ignored = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
  assert.equal(ignored.droppedProjectPermissions, undefined);
  assert.deepEqual(ignored.config.permissions.deny, ['exec']);
  assert.deepEqual(ignored.config.permissions.ask, ['write_file']);
  assert.deepEqual(ignored.config.permissions.allow ?? [], []);
}

{
  const env = cliEnv();
  const ws = path.join(env.HOME, 'ws');
  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), {
    profile: 'cautious',
    permissions: { defaultMode: 'manual' },
  });
  put(path.join(ws, '.moss', 'config.json'), { profile: 'autonomous' });
  const ignored = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
  assert.ok(ignored.droppedProjectPermissions.includes('profile'));
  assert.equal(ignored.config.profile, 'cautious');
  const resolved = resolveCliConfig(env, ignored.config, {}, ignored);
  assert.equal(resolved.permissions.readOnlyCeiling, true);
  assert.ok(!resolved.trustedTools.includes('exec'));

  put(path.join(env.MOSS_CONFIG_DIR, 'config.json'), {});
  put(path.join(ws, '.moss', 'config.json'), { profile: 'cautious' });
  const tightened = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
  assert.equal(tightened.droppedProjectPermissions, undefined);
  assert.equal(tightened.config.profile, 'cautious');
  assert.equal(
    resolveCliConfig(env, tightened.config, {}, tightened).permissions.readOnlyCeiling,
    true
  );
}

// ─── -p: untrusted allow / exec(*) / trustedTools must not run exec ─────────
{
  const cases = [
    {
      label: 'allow exec',
      project: { permissions: { allow: ['exec'] } },
      field: 'permissions.allow',
    },
    {
      label: 'allow exec(*)',
      project: { permissions: { allow: ['exec(*)'] } },
      field: 'permissions.allow',
    },
    {
      label: 'trustedTools exec',
      project: { trustedTools: ['exec'] },
      field: 'trustedTools',
    },
    {
      label: 'profile autonomous',
      project: { profile: 'autonomous' },
      field: 'profile',
    },
  ];
  for (const item of cases) {
    const result = await attack({
      project: item.project,
      userPermissions: { defaultMode: 'manual' },
    });
    assert.equal(
      fs.existsSync(result.marker),
      false,
      `${item.label}: marker exists\n${result.printed.stderr}`
    );
    const notice = noticeLine(result.printed.stderr, item.field);
    assert.ok(notice, `${item.label}: no notice\n${result.printed.stderr}`);
    assert.match(notice, /Untrusted folder — ignored project settings:/);
    assert.match(notice, new RegExp(item.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(notice, /[\u4e00-\u9fff]/);
    assert.ok(
      result.hits.some((hit) => hit.url.includes('chat')),
      `${item.label}: model was not called\n${result.printed.stderr}`
    );
  }
}

{
  const result = await attack({
    project: { permissions: { allow: ['exec'] } },
    userPermissions: { defaultMode: 'manual' },
    lang: 'zh',
  });
  assert.equal(fs.existsSync(result.marker), false, result.printed.stderr);
  const notice = noticeLine(result.printed.stderr, 'permissions.allow');
  assert.ok(notice, result.printed.stderr);
  assert.match(notice, /文件夹未信任 — 已忽略项目设置：/);
  assert.match(notice, /permissions\.allow/);
  assert.doesNotMatch(notice, /Untrusted folder/);
  assert.doesNotMatch(notice, /ignored project settings/);
}

// ─── untrusted deny still blocks exec when the user mode would allow it ────
{
  const result = await attack({
    project: { permissions: { deny: ['exec'] } },
    userPermissions: { defaultMode: 'full' },
  });
  assert.equal(fs.existsSync(result.marker), false, result.printed.stderr);
  assert.doesNotMatch(result.printed.stderr, /permissions\.deny/);
  const followUps = toolResultBodies(result.hits);
  assert.ok(followUps.length > 0, `no tool result\n${result.printed.stderr}`);
  assert.match(followUps.join('\n'), /blocked by deny rule/);
}

// ─── trusted project allow still auto-approves exec ─────────────────────────
{
  const result = await attack({
    project: { permissions: { allow: ['exec'] } },
    userPermissions: { defaultMode: 'manual' },
    args: ['--trust-workspace'],
  });
  assert.equal(
    fs.existsSync(result.marker),
    true,
    `trusted allow did not run exec\n${result.printed.stderr}`
  );
  assert.doesNotMatch(result.printed.stderr, /Untrusted folder/);
  assert.doesNotMatch(result.printed.stderr, /文件夹未信任/);
}

await live.close();
console.log('[PASS] cli-config-untrusted-permissions');
