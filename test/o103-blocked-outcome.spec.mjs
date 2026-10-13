#!/usr/bin/env node
/**
 * O103 (UX BLOCK 1 / QA): a protected-path write refused before it ran must
 * end the run 「未完成：…；被拦：…」/`Incomplete: …; Blocked by: …`, exit 9,
 * whatever the final answer claims. Process-level: real `dist/cli.js -p`
 * against a local fake OpenAI-compatible server.
 * Also: blocked then written another way → L3 「卡在：受保护路径已被修改」 (not
 * masked by 被拦); blocked + no claim → still exit 9; approved → no block.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunCompletionTracker, noteRunCompletionEvent } from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { resolveHostShell } from '../dist/utils/host-shell.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
// Use the actual installed runtime; Windows python3 may only be a Store alias.
const indirectEnvWrite = `${resolveHostShell().kind === 'pwsh' ? '& ' : ''}"${process.execPath}" -e "require('node:fs').writeFileSync('.e'+'nv','X=1')"`;

function startFake(calls, finalText) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* ignore */
      }
      const n = (body.messages ?? []).filter((m) => m.role === 'tool').length;
      const chunk = (delta, fr = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.tools && n < calls.length) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: 'exec', arguments: JSON.stringify({ command: calls[n] }) },
              },
            ],
          })
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: finalText }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function run(args, env, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

async function scenario({ lang, calls, finalText }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o103o-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const cfg = path.join(home, '.config', 'moss');
  for (const d of [home, proj, cfg, path.join(home, '.ssh')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  const server = await startFake(calls, finalText);
  const port = server.address().port;
  const env = {
    PATH: process.env.PATH,
    // Keep Windows executable lookup consistent with the selected fixture shell.
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    HOME: home,
    MOSS_CONFIG_DIR: cfg,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, proj);
  const r = await run(['--trust-workspace', '--lang', lang, '-p', 'run it'], env, proj);
  server.close();
  const last = r.out.trim().split('\n').pop() ?? '';
  const envFile = fs.existsSync(path.join(proj, '.env'));
  fs.rmSync(root, { recursive: true, force: true });
  return { ...r, last, envFile };
}

let pass = 0;
const failures = [];
async function check(fn, name) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}: ${err?.message ?? err}`);
  }
}

const U = 'http://127.0.0.1:9/payload';
const CLAIM = {
  zh: '已把 payload 下载到 .env，完成。',
  en: 'Downloaded the payload to .env. Done.',
};
for (const lang of ['zh', 'en']) {
  for (const [name, cmd] of [
    ['curl -o .env', `curl -s -o .env ${U}`],
    ['curl … > .env', `curl -s ${U} > .env`],
  ]) {
    await check(async () => {
      const r = await scenario({ lang, calls: [cmd], finalText: CLAIM[lang] });
      assert.equal(r.envFile, false, '.env must not be written');
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
      if (lang === 'zh') {
        assert.match(r.last, /^未完成：受保护路径的写入被拦下：\.env/, r.last);
        assert.match(r.last, /；被拦：exec: curl/, r.last);
        assert.doesNotMatch(r.last, /完成：运行结束|已被修改/);
      } else {
        assert.match(r.last, /^Incomplete: a protected-path write was blocked: \.env/, r.last);
        assert.match(r.last, /; Blocked by: exec: curl/, r.last);
        assert.doesNotMatch(r.last, /Completed|modified/);
      }
    }, `${lang}: ${name} + success claim → incomplete/被拦, exit 9`);
  }
  await check(async () => {
    const r = await scenario({
      lang,
      calls: [`curl -s -o .env ${U}`],
      finalText:
        lang === 'zh'
          ? '这个文件受保护，我没有写。'
          : 'That file is protected; I did not write it.',
    });
    assert.equal(r.code, 9, `exit 9 without any claim, got ${r.code}; last=${r.last}`);
    assert.match(r.last, lang === 'zh' ? /^未完成：.*；被拦：/ : /^Incomplete: .*; Blocked by: /);
  }, `${lang}: blocked + no claim → still exit 9 (block record, not claim detection)`);
  await check(async () => {
    const r = await scenario({
      lang,
      calls: [`curl -s -o .env ${U}`, indirectEnvWrite],
      finalText: CLAIM[lang],
    });
    assert.equal(r.envFile, true, 'precondition: second command wrote .env');
    assert.equal(r.code, 9, `exit 9, got ${r.code}`);
    if (lang === 'zh') {
      assert.match(r.last, /已被修改/, r.last);
      assert.match(r.last, /；卡在：受保护路径已被修改/, r.last);
      assert.doesNotMatch(r.last, /；被拦：/, `must not mask the modification: ${r.last}`);
    } else {
      assert.match(r.last, /modified/, r.last);
      assert.match(r.last, /; stuck at: protected path modified/, r.last);
      assert.doesNotMatch(r.last, /; Blocked by: /, r.last);
    }
  }, `${lang}: blocked then written another way → L3 modified stays authoritative`);
}

// Ordinary download must still finish 「完成」 exit 0 (no false block).
await check(async () => {
  const r = await scenario({ lang: 'zh', calls: ['echo hi > out.json'], finalText: '写好了。' });
  assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}`);
  assert.match(r.last, /^完成/);
}, 'zh: ordinary write → 完成 exit 0');

// Approved (user chose 允许) → no block record → no 被拦 / no forced exit 9.
await check(() => {
  const t = createRunCompletionTracker();
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'a',
    input: { command: 'curl -o .env https://x/a' },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'a',
    result: 'exit code 0',
    isError: false,
  });
  assert.equal(t.protectedPathBlocks, undefined);
  const o = resolveRunOutcome({ tracker: t, finalText: 'Done.' });
  assert.equal(o.status, 'completed');
  assert.equal(o.exitCode, 0);
  assert.doesNotMatch(formatOutcomeLine(o, 'zh'), /被拦/);
}, 'approved protected write → completed, exit 0, no 被拦');

// Non-protected safety block keeps O113 behaviour (no new incomplete reason).
await check(() => {
  const t = createRunCompletionTracker();
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: 'b',
    input: { command: 'rm -rf /' },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: 'b',
    result: 'Blocked dangerous command: rm -rf /',
    isError: true,
  });
  assert.equal(t.protectedPathBlocks, undefined);
}, 'non-protected block is not recorded as protected');

console.log(`# o103-blocked-outcome: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
