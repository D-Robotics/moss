#!/usr/bin/env node
/**
 * O162: a hook whose stdout or stderr is cut at the capture limit
 * (HOOK_OUTPUT_LIMIT_BYTES, 10 MiB per stream) has no trustworthy verdict —
 * the JSON decision line is usually after the cut. Before the fix every
 * blocking gate read only the cut text: a moss `block` and a claude
 * `permissionDecision: deny` printed after 12 MiB of junk were invisible, and
 * even a moss `allow` was unverifiable; the run exited 0 and the write went
 * through. Now any cut stream makes the outcome `output_too_large` and every
 * blocking event (PreToolUse, UserPromptSubmit, PermissionRequest, Stop)
 * fails closed, whatever the exit code said.
 *
 * The cut flag is exact (run-process sets it only when a chunk was actually
 * discarded), so multi-byte output that still fits the capture limit in
 * characters is never a false positive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_MAX_BUFFER, ProcessError, runProcess } from '../dist/utils/run-process.js';
import {
  createConfiguredHookCallbacks,
  formatHookFailure,
  HOOK_OUTPUT_LIMIT_BYTES,
} from '../dist/cli/hooks.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const NODE = process.execPath;
/** `node -e` body in double quotes, single quotes inside: same on cmd.exe and sh. */
const nodeHook = (js) => `node -e "${js}"`;

/** Flood body: `mb` MiB of 'x' in paced 1 MiB chunks (separate data events). */
const floodBody = (stream, mb) =>
  `const c='x'.repeat(1048576);for(let i=0;i<${mb};i++){process.${stream}.write(c);await new Promise(r=>setImmediate(r));}`;

const verdict = (obj) => `process.stdout.write('\\n');console.log(JSON.stringify(${obj}))`;
/**
 * Flood the stream, THEN print the verdict (one awaited async body — a bare
 * IIFE without await would print the verdict before the junk finished).
 */
const floodThen = (mb, obj, stream = 'stdout') =>
  nodeHook(`(async()=>{${floodBody(stream, mb)};${verdict(obj)}})()`);

test.beforeEach(() => {
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
});

// ── runProcess: the cut flag is exact ────────────────────────────────────────

async function runNode(js, opts = {}) {
  return runProcess(NODE, { args: ['-e', js], ...opts });
}

// Writes are sized so the reader must see several data events (one pipe read
// is at most 64 KiB): with maxBuffer 1024 the second event onward is dropped.
const CHUNKS =
  "const c='y'.repeat(131072);for(let i=0;i<8;i++){process.STREAM.write(c);await new Promise(r=>setImmediate(r));}";
const stdoutChunks = CHUNKS.replaceAll('STREAM', 'stdout');
const stderrChunks = CHUNKS.replaceAll('STREAM', 'stderr');

test('runProcess: a discarded stdout chunk sets stdoutOverflow', async () => {
  const r = await runNode(`(async()=>{${stdoutChunks}})()`, { maxBuffer: 1024 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutOverflow, true, 'chunks after the cap were dropped');
  assert.equal(r.stderrOverflow, undefined);
});

test('runProcess: output under the cap sets no flags', async () => {
  const r = await runNode("process.stdout.write('z'.repeat(900))", { maxBuffer: 1024 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutOverflow, undefined);
  assert.equal(r.stderrOverflow, undefined);
});

test('runProcess: multi-byte output that fits the cap is not a false positive', async () => {
  // 3000 CJK chars = 9000 UTF-8 bytes but 3000 UTF-16 units < the 4096 cap:
  // nothing was discarded, so the text is complete and must not be flagged.
  const r = await runNode("process.stdout.write('汉'.repeat(3000))", { maxBuffer: 4096 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutOverflow, undefined, 'nothing was dropped');
  assert.equal(r.stdout.length, 3000);
});

test('runProcess: stderr and both streams', async () => {
  const r = await runNode(`(async()=>{${stderrChunks}})()`, { maxBuffer: 1024 });
  assert.equal(r.stderrOverflow, true);
  assert.equal(r.stdoutOverflow, undefined);

  const bothJs = `(async()=>{const c='y'.repeat(131072);for(let i=0;i<8;i++){process.stdout.write(c);process.stderr.write(c);await new Promise(r=>setImmediate(r));}})()`;
  const r2 = await runNode(bothJs, { maxBuffer: 1024 });
  assert.equal(r2.stdoutOverflow, true);
  assert.equal(r2.stderrOverflow, true);
});

test('runProcess: a non-zero exit carries the flags on ProcessError', async () => {
  const js = `(async()=>{${stdoutChunks};process.exit(3);})()`;
  await assert.rejects(runNode(js, { maxBuffer: 1024 }), (err) => {
    assert.ok(err instanceof ProcessError);
    assert.equal(err.exitCode, 3);
    assert.equal(err.stdoutOverflow, true);
    return true;
  });
});

test('HOOK_OUTPUT_LIMIT_BYTES is the runProcess default capture limit', () => {
  assert.equal(HOOK_OUTPUT_LIMIT_BYTES, DEFAULT_MAX_BUFFER);
  assert.equal(HOOK_OUTPUT_LIMIT_BYTES, 10 * 1024 * 1024);
});

// ── hook layer: every blocking event fails closed on a cut stream ───────────

async function withHooks(hooks, fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'o162-'));
  const callbacks = createConfiguredHookCallbacks(hooks, { workspaceDir: workspace });
  const origWrite = process.stderr.write;
  const errs = [];
  process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
  try {
    return { value: await fn(callbacks), errs };
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const EXEC_REQUEST = { tool: { name: 'exec' }, input: { command: 'true' } };

test('PreToolUse: 12 MiB junk then a block verdict → blocked by the limit, not the verdict', async () => {
  const { value } = await withHooks(
    { PreToolUse: [{ command: floodThen(12, "{decision:'block',reason:'o162 real reason'}") }] },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, false);
  assert.match(value.reason, /output exceeded the limit \(10 MiB, stdout\)/);
  // The verdict itself is unreadable; only its echo inside the command line
  // may appear — never as the hook's own "Blocked by … <reason>" decision.
  assert.doesNotMatch(value.reason, /Blocked by PreToolUse hook: o162 real reason/);
});

test('PreToolUse: 12 MiB junk then an allow verdict → still blocked (unverifiable)', async () => {
  const { value } = await withHooks(
    { PreToolUse: [{ command: floodThen(12, "{decision:'allow'}") }] },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, false);
  assert.match(value.reason, /output exceeded the limit/);
});

test('PreToolUse: claude deny after 12 MiB junk → blocked', async () => {
  const { value } = await withHooks(
    {
      PreToolUse: [
        {
          command: floodThen(
            12,
            "{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'o162 claude deny'}}"
          ),
          format: 'claude',
        },
      ],
    },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, false);
  assert.match(value.reason, /output exceeded the limit/);
});

test('PreToolUse: stderr-only cut → blocked and the copy names stderr', async () => {
  const { value } = await withHooks(
    {
      PreToolUse: [{ command: floodThen(12, "{decision:'block',reason:'r'}", 'stderr') }],
    },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, false);
  assert.match(value.reason, /output exceeded the limit \(10 MiB, stderr\)/);
});

test('PreToolUse: control, small output — allow runs and block uses the real reason', async () => {
  const allow = await withHooks(
    { PreToolUse: [{ command: nodeHook(verdict("{decision:'allow'}")) }] },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(allow.value.approved, true);

  const block = await withHooks(
    {
      PreToolUse: [{ command: nodeHook(verdict("{decision:'block',reason:'o162 small block'}")) }],
    },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(block.value.approved, false);
  assert.match(block.value.reason, /o162 small block/);
  assert.doesNotMatch(block.value.reason, /exceeded the limit/);
});

test('PreToolUse: just under the limit — the verdict itself decides (block honored)', async () => {
  const { value } = await withHooks(
    {
      PreToolUse: [{ command: floodThen(8, "{decision:'block',reason:'o162 under-limit block'}") }],
    },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, false);
  assert.match(value.reason, /o162 under-limit block/);
  assert.doesNotMatch(value.reason, /exceeded the limit/);
});

test('PreToolUse: blocking:false cannot restrict, even over the limit', async () => {
  const { value } = await withHooks(
    { PreToolUse: [{ command: floodThen(12, "{decision:'block'}"), blocking: false }] },
    (c) => c.onBeforeToolExec(EXEC_REQUEST)
  );
  assert.equal(value.approved, true);
});

test('UserPromptSubmit / PermissionRequest / Stop also fail closed', async () => {
  const flood12 = { command: floodThen(12, "{decision:'block'}") };

  const ups = await withHooks({ UserPromptSubmit: [flood12] }, (c) =>
    c.runUserPromptSubmit('hello')
  );
  assert.equal(ups.value.blocked, true);
  assert.match(ups.value.reason, /output exceeded the limit/);

  const perm = await withHooks({ PermissionRequest: [flood12] }, (c) =>
    c.runPermissionRequest({ toolName: 'exec', input: { command: 'true' } })
  );
  assert.equal(perm.value.denied, true);
  assert.match(perm.value.reason, /output exceeded the limit/);

  const stop = await withHooks({ Stop: [flood12] }, (c) =>
    c.runStop({ sessionKey: 'o162', stopReason: 'end_turn' })
  );
  assert.equal(stop.value.blocked, true);
  assert.match(stop.value.reason, /output exceeded the limit/);
});

test('formatHookFailure: output_too_large copy in zh and en', () => {
  const hook = { command: 'noisy.sh', source: '/tmp/cfg.json' };
  const r = {
    outcome: 'output_too_large',
    exitCode: 0,
    stdout: '',
    stderr: '',
    overflow: 'stdout',
  };
  const en = formatHookFailure('PreToolUse', hook, r, true, false);
  assert.match(
    en,
    /Blocked: PreToolUse hook `noisy\.sh` output exceeded the limit \(10 MiB, stdout\); its decision cannot be read, treated as deny\./
  );
  assert.match(en, /Config: \/tmp\/cfg\.json/);

  const zh = formatHookFailure('PreToolUse', hook, r, true, true);
  assert.match(
    zh,
    /已拦截：工具使用前钩子 `noisy\.sh` 输出超过上限（10 MiB，stdout），无法解析决定，已按拒绝处理。/
  );
  assert.match(zh, /配置文件：\/tmp\/cfg\.json/);
});

// ── Process level: real CLI -p, fake model, file must stay untouched ────────

const NOTES = 'original notes\n';
const WRITE_NOTES = {
  name: 'exec',
  args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
};
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function cli(hooks, lang = 'en') {
  const r = await scenario({
    lang,
    hooks: { PreToolUse: hooks },
    steps: [WRITE_NOTES],
    finalText: lang === 'zh' ? '全部完成，已经做好了。' : 'All done, everything is finished.',
    notesBody: NOTES,
  });
  return { ...r, unchanged: sha(r.notes) === sha(NOTES) };
}

function assertBlocked(r, lang = 'en') {
  const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(-600)}`;
  assert.equal(r.code, 9, `exit 9; ${ctx}`);
  assert.equal(r.unchanged, true, `notes.txt must be unchanged; ${ctx}`);
  assert.match(r.last, lang === 'zh' ? /被拦：钩子拦下/ : /Blocked by: hook blocked/, ctx);
  const limit =
    lang === 'zh'
      ? /输出超过上限（10 MiB，stdout）/
      : /output exceeded the limit \(10 MiB, stdout\)/;
  assert.match(r.toolResults.join('\n'), limit, `tool result; ${ctx}`);
}

test('-p moss: 12 MiB junk then decision:block → exit 9 被拦, file unchanged', async () => {
  assertBlocked(
    await cli([{ command: floodThen(12, "{decision:'block',reason:'o162 must block'}") }])
  );
});

test('-p claude: 12 MiB junk then permissionDecision:deny → exit 9 被拦, file unchanged', async () => {
  assertBlocked(
    await cli([
      {
        command: floodThen(
          12,
          "{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'o162 claude deny'}}"
        ),
        format: 'claude',
      },
    ])
  );
});

test('-p moss: 12 MiB junk then decision:allow → exit 9 被拦 (the allow is unverifiable)', async () => {
  assertBlocked(await cli([{ command: floodThen(12, "{decision:'allow'}") }]));
});

test('-p zh copy: 输出超过上限（10 MiB，stdout）', async () => {
  assertBlocked(
    await cli([{ command: floodThen(12, "{decision:'block',reason:'r'}") }], 'zh'),
    'zh'
  );
});

test('-p control: small-output allow still writes (exit 0)', async () => {
  const r = await cli([{ command: nodeHook(verdict("{decision:'allow'}")) }]);
  assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
  assert.equal(r.unchanged, false, 'file written');
});

test('-p just under the limit: the real block verdict is honored, not the limit', async () => {
  const r = await cli([
    { command: floodThen(8, "{decision:'block',reason:'o162 under-limit block'}") },
  ]);
  assert.equal(r.code, 9, `${r.last}\n${r.err.slice(-400)}`);
  assert.equal(r.unchanged, true);
  assert.match(r.toolResults.join('\n'), /o162 under-limit block/);
  assert.doesNotMatch(r.toolResults.join('\n'), /exceeded the limit/);
});
