#!/usr/bin/env node
/**
 * O121: every safety / approval refusal is written into the run's block record
 * and ends the run 「未完成：…；被拦：<what>」/`Incomplete: …; Blocked by: <what>`
 * with exit 9 — whatever the final answer claims. Process-level: real
 * `dist/cli.js -p` against a local fake OpenAI-compatible server.
 *
 * One case per refusal source (dangerous command, O94 protected path, O97
 * partial-read edit, O88 hook block, loop-guard, -p approval auto-deny), plus
 * negatives (approved, pure Q&A, ordinary lint/test non-zero, partial read
 * recovered by a full read + edit) and stdout/stderr/JSON consistency.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const IS_WIN = process.platform === 'win32';

/** steps: [{ name, args }] — one tool call per model turn, then finalText. */
function startFake(steps, finalText, stall = false) {
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
      if (body.tools && body.messages) server.lastMessages = body.messages;
      const chunk = (delta, fr = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (stall && body.messages) {
        // mid-stream stall: one delta, then silence (O114 inter-event idle)
        res.write(chunk({ role: 'assistant', content: 'Working' }));
        return;
      }
      if (body.tools && n < steps.length) {
        const s = steps[n];
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: s.name, arguments: JSON.stringify(s.args) },
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

function run(args, env, cwd, timeoutMs = 90000) {
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

export async function scenario({
  lang,
  steps,
  finalText,
  flags = [],
  hooks,
  json = false,
  extraEnv = {},
  stall = false,
  notesBody,
}) {
  const fmt = json === true ? 'json' : json || undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o121-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const cfg = path.join(home, '.config', 'moss');
  for (const d of [home, proj, cfg]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  fs.writeFileSync(
    path.join(proj, 'notes.txt'),
    notesBody ?? Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  );
  if (hooks) {
    fs.mkdirSync(path.join(proj, '.moss'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.moss', 'config.json'), JSON.stringify({ hooks }));
  }
  const server = await startFake(steps, finalText, stall);
  const port = server.address().port;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    MOSS_CONFIG_DIR: cfg,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnv,
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, proj);
  const r = await run(
    [
      '--trust-workspace',
      '--lang',
      lang,
      ...flags,
      ...(fmt ? ['--output-format', fmt] : []),
      '-p',
      'run it',
    ],
    env,
    proj
  );
  server.closeAllConnections?.();
  server.close();
  const last = r.out.trim().split('\n').pop() ?? '';
  const notes = fs.readFileSync(path.join(proj, 'notes.txt'), 'utf8');
  fs.rmSync(root, { recursive: true, force: true });
  const toolResults = (server.lastMessages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  return { ...r, last, notes, toolResults };
}

const CLAIM = { zh: '全部完成，已经做好了。', en: 'All done, everything is finished.' };
const exec = (command) => ({ name: 'exec', args: { command } });
const MISSING = 'moss-o121-no-such-cmd-xyz';

/** Refusal sources. `want` = the main cause the last line must name. */
export const CASES = [
  {
    id: 'dangerous',
    steps: [exec('rm -rf /')],
    want: { zh: /被拦：危险命令 `rm -rf \/`/, en: /Blocked by: dangerous command `rm -rf \/`/ },
  },
  {
    id: 'protected',
    steps: [exec('echo SECRET=1 > .env')],
    want: { zh: /被拦：.*\.env/, en: /Blocked by: .*\.env/ },
  },
  {
    id: 'partial-read',
    steps: [
      { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } },
      {
        name: 'edit_file',
        args: { path: 'notes.txt', old_string: 'line 30', new_string: 'LINE 30' },
      },
    ],
    want: {
      zh: /^未完成：`notes\.txt` 还没改（先完整读取再编辑）/,
      en: /^Incomplete: `notes\.txt` not changed \(read in full first, then edit\)/,
    },
    noBlockedBy: true,
  },
  {
    id: 'hook',
    hooks: { PreToolUse: [{ command: MISSING }] },
    steps: [exec('echo hi')],
    want: { zh: /被拦：钩子拦下 `exec: echo hi`/, en: /Blocked by: hook blocked `exec: echo hi`/ },
  },
  // O135 (UX 3): claude-format PreToolUse — missing command / exit 1 / exit 2
  // with no decision all end the same 「被拦：钩子拦下」, exit 9.
  ...[
    ['hook-claude-missing', MISSING],
    ['hook-claude-exit1', 'node -e "process.exit(1)"'],
    ['hook-claude-exit2', 'node -e "process.exit(2)"'],
    ['hook-moss-exit7', 'node -e "process.exit(7)"', 'moss'],
  ].map(([id, command, format = 'claude']) => ({
    id,
    hooks: { PreToolUse: [{ command, ...(format === 'claude' ? { format } : {}) }] },
    steps: [exec('echo hi')],
    want: { zh: /被拦：钩子拦下 `exec: echo hi`/, en: /Blocked by: hook blocked `exec: echo hi`/ },
  })),
  {
    id: 'approval',
    flags: ['--accept-edits'],
    steps: [exec('echo hi')],
    want: {
      zh: /被拦：需要确认但无法询问 `exec: echo hi`/,
      en: /Blocked by: needs approval \(could not ask\) `exec: echo hi`/,
    },
  },
];

/** PM ruling: loop-guard is NOT a block — non-zero, 卡在/stuck at, never 被拦. */
export const LOOP_GUARD = {
  id: 'loop-guard',
  steps: [exec(MISSING), exec(MISSING), exec(MISSING), exec(MISSING)],
};

export const NEGATIVES = [
  // user-approved (full-access auto-approves the same -p command the
  // approval case denies) → not a block
  { id: 'approved', flags: ['--full-access'], steps: [exec('echo hi')] },
  { id: 'qa', steps: [] },
  // ordinary lint/test non-zero is a failure, not a block
  { id: 'lint-nonzero', steps: [exec('node -e "process.exit(1)"')], honest: true },
  // partial read refused, then full read + edit succeeds → recovered
  {
    id: 'partial-recovered',
    steps: [
      { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } },
      {
        name: 'edit_file',
        args: { path: 'notes.txt', old_string: 'line 30', new_string: 'LINE 30' },
      },
      { name: 'read_file', args: { path: 'notes.txt' } },
      {
        name: 'edit_file',
        args: { path: 'notes.txt', old_string: 'line 30\n', new_string: 'LINE 30\n' },
      },
    ],
  },
];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.env.O121_MEASURE) {
  // Measurement mode: print the tip matrix, assert nothing.
  for (const c of [...CASES, LOOP_GUARD, ...NEGATIVES]) {
    for (const lang of ['zh', 'en']) {
      const r = await scenario({ lang, ...c, finalText: CLAIM[lang] });
      console.log(`${c.id}\t${lang}\texit=${r.code}\t${r.last}`);
    }
  }
  process.exit(0);
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

if (isMain) {
  for (const c of CASES) {
    if (IS_WIN && c.id === 'dangerous') continue; // rm -rf / guard is posix-shaped
    for (const lang of ['zh', 'en']) {
      await check(async () => {
        const r = await scenario({ lang, ...c, finalText: CLAIM[lang] });
        assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}\n${r.err.slice(-600)}`);
        assert.match(r.last, lang === 'zh' ? /^未完成/ : /^Incomplete/, r.last);
        assert.match(r.last, c.want[lang], r.last);
        assert.doesNotMatch(r.last, /已被修改|was modified|未知|unknown/i, r.last);
        if (c.noBlockedBy) assert.doesNotMatch(r.last, /被拦|Blocked by/, r.last);
        // O103 protected wording keeps the step (the reason already names the path).
        if (c.id !== 'protected')
          assert.doesNotMatch(r.last, /被拦：exec:|Blocked by: exec:/, 'not a bare exec: step');
        if (c.id === 'partial-read') assert.match(r.notes, /^line 30$/m, 'file untouched');
      }, `[${lang}] ${c.id}: refused + claimed done → exit 9`);
    }
  }

  for (const lang of ['zh', 'en']) {
    await check(async () => {
      const r = await scenario({
        lang,
        steps: [exec('rm -rf /'), exec('echo SECRET=1 > .env')],
        finalText: CLAIM[lang],
      });
      assert.equal(r.code, 9);
      assert.match(r.last, lang === 'zh' ? /（另有 1 处）/ : /\(\+1 more\)/, r.last);
      assert.equal((r.last.match(lang === 'zh' ? /被拦：/g : /Blocked by:/g) ?? []).length, 1);
    }, `[${lang}] two refusals → one main cause + (1 more)`);

    await check(async () => {
      const r = await scenario({
        lang,
        steps: [exec('rm -rf /')],
        finalText: lang === 'zh' ? '根目录是 /。' : 'The root directory is /.',
      });
      assert.equal(r.code, 9, r.last);
      assert.match(r.last, lang === 'zh' ? /被拦：危险命令/ : /Blocked by: dangerous command/);
    }, `[${lang}] refused + only answered (no claim) → still exit 9`);

    await check(async () => {
      const r = await scenario({
        lang,
        steps: [exec('rm -rf /')],
        finalText: CLAIM[lang],
        json: true,
      });
      assert.equal(r.code, 9);
      const j = JSON.parse(
        r.out
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .pop()
      );
      const text = JSON.stringify(j);
      assert.match(text, /dangerous command|危险命令/, text.slice(0, 400));
      assert.match(text, /"recoverable":false/, text.slice(0, 600));
      assert.match(r.err, lang === 'zh' ? /危险命令 `rm -rf \/`/ : /dangerous command `rm -rf \/`/);
    }, `[${lang}] JSON + stderr agree on the block`);

    // O135 (UX 1/3): claude-format PreToolUse hook that cannot start — exit 9,
    // json error_during_execution + recoverable:false, stderr names the hook.
    await check(async () => {
      const r = await scenario({
        lang,
        hooks: { PreToolUse: [{ command: MISSING, format: 'claude' }] },
        steps: [exec('echo hi')],
        finalText: CLAIM[lang],
        json: true,
      });
      assert.equal(r.code, 9, `exit 9, got ${r.code}\n${r.err.slice(-600)}`);
      const j = JSON.parse(
        r.out
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .pop()
      );
      const text = JSON.stringify(j);
      assert.match(text, /error_during_execution/, text.slice(0, 600));
      assert.match(text, /"recoverable":false/, text.slice(0, 600));
      assert.match(
        r.err,
        lang === 'zh'
          ? new RegExp(`已拦截：工具使用前钩子 \`${MISSING}\` 未能启动，已按拒绝处理。`)
          : new RegExp(
              `Blocked: PreToolUse hook \`${MISSING}\` failed to start; treated as deny\\.`
            ),
        r.err.slice(-600)
      );
    }, `[${lang}] O135 claude hook missing → exit 9 + json error_during_execution + stderr`);
  }

  for (const lang of ['zh', 'en']) {
    await check(async () => {
      const r = await scenario({ lang, ...LOOP_GUARD, finalText: 'Done.' });
      assert.notEqual(r.code, 0, r.last);
      assert.equal(r.code, 9, r.last);
      assert.match(
        r.last,
        lang === 'zh'
          ? /^未完成.*；卡在：exec 未能启动（找不到命令 `moss-o121-no-such-cmd-xyz`）$/
          : /^Incomplete.*; stuck at: exec failed to start \(command `moss-o121-no-such-cmd-xyz` not found\)$/,
        r.last
      );
      // tool line: loop-guard copy says 已停止重试 / Stopped retrying, not 已拦截
      assert.match(r.out + r.err, lang === 'zh' ? /已停止重试：exec/ : /Stopped retrying: exec/);
      assert.doesNotMatch(r.out + r.err, /已拦截：exec 未能启动|Blocked: exec failed to start/);
      assert.doesNotMatch(r.last, /被拦|Blocked by/, r.last);
    }, `[${lang}] loop-guard: not a block — non-zero, stuck at, no Blocked by`);
  }

  // win32 9009 (O106) → same loop-guard stop → 「卡在：exec 未能启动…」, never 被拦.
  // In-process through the real guard + tracker + outcome (9009 only comes
  // from cmd.exe, so the platform is injected as in O106).
  {
    const g = await import('../dist/core/tools/tool-loop-guard.js');
    const rc = await import('../dist/cli/run-completion.js');
    const ro = await import('../dist/cli/run-outcome.js');
    for (const [label, output, want] of [
      [
        'named',
        'exit_code: 9009\nsh: nosuchcmd-x: not found\n',
        {
          zh: /；卡在：exec 未能启动（找不到命令 `nosuchcmd-x`）$/,
          en: /; stuck at: exec failed to start \(command `nosuchcmd-x` not found\)$/,
        },
      ],
      [
        'cmd.exe',
        "exit_code: 9009\n'nosuchcmd-x' is not recognized as an internal or external command,\n",
        {
          zh: /；卡在：exec 未能启动（找不到命令 `nosuchcmd-x`）$/,
          en: /; stuck at: exec failed to start \(command `nosuchcmd-x` not found\)$/,
        },
      ],
    ]) {
      await check(async () => {
        const state = g.createToolLoopGuardState();
        const t = rc.createRunCompletionTracker();
        for (let i = 0; i < 3; i++) {
          g.recordToolLoopOutcome(
            state,
            'exec',
            true,
            output,
            { command: 'nosuchcmd-x x' },
            'win32'
          );
          rc.noteRunCompletionEvent(t, {
            type: 'tool_start',
            toolName: 'exec',
            toolCallId: `c${i}`,
            input: { command: 'nosuchcmd-x x' },
          });
          rc.noteRunCompletionEvent(t, {
            type: 'tool_end',
            toolName: 'exec',
            toolCallId: `c${i}`,
            result: output,
            isError: true,
            outcome: 'error',
          });
        }
        const reason = g.shouldShortCircuitToolCall(state, 'exec', { command: 'nosuchcmd-x x' });
        assert.ok(reason, 'guard must stop after 3 win32 9009s');
        const msg = g.formatToolLoopGuardMessage(reason, 'exec');
        assert.match(msg, /^已停止重试：exec 未能启动/);
        assert.match(msg, /Stopped retrying: exec failed to start/);
        rc.noteRunCompletionEvent(t, {
          type: 'tool_start',
          toolName: 'exec',
          toolCallId: 'c9',
          input: { command: 'nosuchcmd-x x' },
        });
        rc.noteRunCompletionEvent(t, {
          type: 'tool_end',
          toolName: 'exec',
          toolCallId: 'c9',
          result: msg,
          isError: true,
          outcome: 'blocked',
        });
        const o = ro.resolveRunOutcome({ tracker: t, finalText: 'Done.' });
        assert.equal(o.exitCode, 9);
        for (const lang of ['zh', 'en']) {
          const line = ro.formatOutcomeLine(o, lang);
          assert.match(line, lang === 'zh' ? /^未完成/ : /^Incomplete/, line);
          assert.match(line, want[lang], line);
          assert.doesNotMatch(line, /被拦|Blocked by/, line);
        }
      }, `win32 9009 (${label}) x3 + 'Done.' → stuck at exec 未能启动, exit 9, not Blocked`);
    }
  }

  // UX BLOCK (#118): loop-guard stop in json / stream-json must agree with
  // the text last line: exit 9, error_during_execution, 卡在 (not 被拦).
  for (const fmt of ['json', 'stream-json']) {
    for (const lang of ['zh', 'en']) {
      await check(async () => {
        const r = await scenario({ lang, ...LOOP_GUARD, finalText: 'Done.', json: fmt });
        assert.equal(r.code, 9, `exit 9, got ${r.code}`);
        const lines = r.out
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('{'));
        const res = lines
          .map((l) => JSON.parse(l))
          .filter((e) => e.type === 'result')
          .pop();
        assert.ok(res, 'result event present');
        assert.equal(res.subtype, 'error_during_execution');
        assert.equal(res.is_error, true);
        assert.equal(res.recoverable, false);
        assert.match(
          res.error ?? '',
          lang === 'zh'
            ? /^未完成.*；卡在：exec 未能启动（找不到命令 `moss-o121-no-such-cmd-xyz`）$/
            : /^Incomplete.*; stuck at: exec failed to start \(command `moss-o121-no-such-cmd-xyz` not found\)$/,
          res.error
        );
        assert.doesNotMatch(res.error, /被拦|Blocked by/);
      }, `[${lang}] ${fmt} loop-guard → exit 9, error_during_execution, stuck at (not Blocked)`);
    }
  }

  // QA (#118): non-safety unfinished outcomes in json mode stay honest errors
  // (budget exhausted — O111/O116; upstream stream stall — O114).
  const resultOf = (r) =>
    r.out
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'result')
      .pop();
  for (const fmt of ['json', 'stream-json']) {
    await check(async () => {
      const r = await scenario({
        lang: 'en',
        steps: [exec('echo a'), exec('echo b'), exec('echo c')],
        finalText: 'All done.',
        json: fmt,
        extraEnv: { MOSS_BUDGET_MAX_TOOL_CALLS: '1' },
      });
      const res = resultOf(r);
      assert.ok(res, 'result event');
      assert.notEqual(r.code, 0, `non-zero exit, got ${r.code}`);
      assert.equal(res.is_error, true, JSON.stringify(res).slice(0, 300));
      assert.notEqual(res.subtype, 'success');
      assert.doesNotMatch(res.error ?? '', /Blocked by/);
    }, `${fmt} budget exhausted → is_error, non-zero, not success`);
    await check(async () => {
      const r = await scenario({
        lang: 'en',
        steps: [],
        finalText: 'x',
        json: fmt,
        stall: true,
        extraEnv: { MOSS_PI_AI_INTER_EVENT_TIMEOUT_MS: '300', MOSS_FALLBACK_MAX_RETRIES: '0' },
      });
      const res = resultOf(r);
      assert.ok(res, `result event; err=${r.err.slice(-300)}`);
      assert.notEqual(r.code, 0, `non-zero exit, got ${r.code}`);
      assert.equal(res.is_error, true, JSON.stringify(res).slice(0, 300));
      assert.notEqual(res.subtype, 'success');
      assert.equal(res.recoverable, false, JSON.stringify(res).slice(0, 400));
    }, `${fmt} upstream stream stall → is_error, recoverable:false, non-zero`);
  }

  for (const c of NEGATIVES) {
    for (const lang of ['zh', 'en']) {
      await check(async () => {
        const fin = c.honest
          ? lang === 'zh'
            ? '命令失败了（exit 1），没有完成。'
            : 'The command failed (exit 1); not done.'
          : CLAIM[lang];
        const r = await scenario({ lang, ...c, finalText: fin });
        assert.doesNotMatch(r.last, /被拦|Blocked by/, r.last);
        if (!c.honest) assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}`);
        if (c.id === 'partial-recovered') assert.match(r.notes, /^LINE 30$/m, 'edit applied');
      }, `[${lang}] negative ${c.id}: not a block`);
    }
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}
