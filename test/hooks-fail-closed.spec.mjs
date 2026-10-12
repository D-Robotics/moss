#!/usr/bin/env node
/**
 * O88: a blocking hook that never gives a verdict (could not start / timed
 * out) must fail closed, with a reason the model and the user both see.
 *
 * End-to-end through MossAgent: a scripted model calls `write_target`, whose
 * execute() really writes a file. Blocked cases assert the file is absent and
 * the tool result is an error; allowed cases assert the file exists and the
 * terminal (stderr) names the hook and the reason (QA Q1/Q2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createConfiguredHookCallbacks,
  runStopHooks,
  setLifecycleHookRunner,
} from '../dist/cli/hooks.js';
import { resolveProjectCapabilities } from '../dist/cli/workspace-trust.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { ErrorCode } from '../dist/errors.js';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';
import { failedPreviewLimit, RESULT_PREVIEW_LINES } from '../dist/cli/tui/transcript.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const IS_WIN = process.platform === 'win32';
const MISSING = 'moss-o88-definitely-missing-cmd';
const SLEEP_5S = IS_WIN ? 'ping -n 6 127.0.0.1 >NUL' : 'sleep 5';
const CONFIG = '/tmp/o88/.moss/config.json';
/** O135: stderr + exit, same on cmd.exe and sh (`;` is not a cmd separator). */
const NODE_EXIT = (msg, code) => `node -e "console.error('${msg}');process.exit(${code})"`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o88-'));
}

function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}

/** Capture process.stderr while fn runs. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

/** Run one scripted turn: the model calls write_target once. */
async function runWrite(hooksConfig, { dir = tmp(), callbacks } = {}) {
  const target = path.join(dir, 'out.txt');
  const cbs = callbacks ?? createConfiguredHookCallbacks(hooksConfig, { workspaceDir: dir });
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('o88', 'O88', [
      { toolCalls: [{ name: 'write_target', input: {} }] },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'o88',
    baseSystemPrompt: 'Write the file.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
    hooks: { onBeforeToolExec: cbs.onBeforeToolExec },
  });
  agent.tools.register({
    name: 'write_target',
    description: 'Write out.txt.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      fs.writeFileSync(target, 'written\n');
      return 'wrote out.txt';
    },
  });
  const toolResults = [];
  const started = Date.now();
  const { stderr } = await captureStderr(async () => {
    for await (const ev of agent.streamChat(`o88-${Date.now()}`, 'write it')) {
      if (ev.type === 'tool_result' || ev.type === 'tool_end') toolResults.push(ev);
    }
  });
  const elapsedMs = Date.now() - started;
  const resultText = JSON.stringify(toolResults);
  return { written: fs.existsSync(target), stderr, resultText, toolResults, elapsedMs, dir };
}

/** O88 failure reason: next steps are only "fix the command" or `blocking: false`. */
function assertFailureReason(r) {
  assert.match(r.resultText, /blocking: false/, 'reason offers blocking: false as next step');
  assert.doesNotMatch(
    r.resultText,
    /full mode|--trust-workspace|trust/i,
    'never suggests trust/full'
  );
}

function assertBlocked(r, reasonRe) {
  assert.equal(r.written, false, 'blocked: target file must NOT exist');
  assert.match(
    r.resultText,
    /"is_?[eE]rror":true|"isError":true|"error"/,
    'tool result is an error'
  );
  assert.match(r.resultText, reasonRe, 'tool result carries the reason');
}

for (const lang of ['en', 'zh']) {
  // O135 (UX): blocked spawn failure names the hook and says treated as deny.
  const notStarted = lang === 'zh' ? /未能启动，已按拒绝处理/ : /failed to start; treated as deny/;
  const timedOut = lang === 'zh' ? /超时/ : /timed out/;

  test(`[${lang}] moss format + missing command blocks the write`, async () => {
    useLang(lang);
    const r = await runWrite({ PreToolUse: [{ command: MISSING, source: CONFIG }] });
    assertBlocked(r, notStarted);
    assertFailureReason(r);
    assert.match(r.resultText, new RegExp(MISSING), 'reason names the hook command');
    assert.match(r.resultText, /\/tmp\/o88\/\.moss\/config\.json/, 'reason names the config file');
    assert.match(r.stderr, notStarted, 'terminal shows the same reason');
    if (lang === 'zh') {
      assert.match(
        r.resultText,
        /已拦截：工具使用前钩子 `moss-o88-definitely-missing-cmd` 未能启动，已按拒绝处理。/,
        'zh O135 wording names the command and treated-as-deny'
      );
      assert.match(r.resultText, /给这个钩子加上 blocking: false/, 'zh next step');
      assert.doesNotMatch(
        r.resultText,
        /PreToolUse|\bhook\b/,
        'no leftover English event/hook word'
      );
    }
  });

  test(`[${lang}] claude format + missing command blocks the write`, async () => {
    useLang(lang);
    const r = await runWrite({ PreToolUse: [{ command: MISSING, format: 'claude' }] });
    assertBlocked(r, notStarted);
  });

  for (const format of [undefined, 'claude']) {
    test(`[${lang}] ${format ?? 'moss'} format + timeout blocks, fast, child killed`, async () => {
      useLang(lang);
      const dir = tmp();
      const pidFile = path.join(dir, 'hook.pid');
      const command = IS_WIN ? SLEEP_5S : `echo $$ > ${JSON.stringify(pidFile)}; ${SLEEP_5S}`;
      const r = await runWrite(
        // timeoutFor() floors timeoutMs at 1000ms, so 300 here really means 1s.
        { PreToolUse: [{ command, timeoutMs: 300, ...(format ? { format } : {}) }] },
        { dir }
      );
      assertBlocked(r, timedOut);
      assertFailureReason(r);
      // Hook sleeps 5s; the 1s floor must cut it off well before that.
      assert.ok(r.elapsedMs >= 900, `waited for the 1s floor (took ${r.elapsedMs}ms)`);
      assert.ok(r.elapsedMs < 3000, `blocked within 3s (took ${r.elapsedMs}ms)`);
      if (!IS_WIN && fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try {
            process.kill(pid, 0);
            await new Promise((res) => setTimeout(res, 10));
          } catch {
            alive = false;
          }
        }
        assert.equal(alive, false, 'timed-out hook process is gone');
      }
    });
  }
}

// O135: PreToolUse non-zero without an explicit allow decision fails closed
// in both formats (not only exit 2). Cross-platform node -e (cmd ignores `;`).
test('claude format + exit 1 blocks the write (PreToolUse fail-closed)', async () => {
  useLang('en');
  const r = await runWrite({
    PreToolUse: [{ command: NODE_EXIT('oops', 1), format: 'claude', source: CONFIG }],
  });
  assertBlocked(r, /oops/);
  assert.match(r.resultText, /Blocked by PreToolUse hook/, 'blocked reason names PreToolUse');
});

test('claude format + exit 2 still blocks (regression)', async () => {
  useLang('en');
  const r = await runWrite({
    PreToolUse: [{ command: NODE_EXIT('nope', 2), format: 'claude' }],
  });
  assertBlocked(r, /nope/);
});

test('native hook verdicts retain quoted argv/stdin/cwd, explicit exits and real command recovery', async () => {
  useLang('en');
  const dir = tmp();
  const script = path.join(dir, "hook space ' 中文.mjs");
  const output = path.join(dir, 'native-hook.json');
  const argument = "literal & ( ) ' 中文";
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[2],JSON.stringify({payload:JSON.parse(data),cwd:process.cwd(),argument:process.argv[3]}));process.exit(Number(process.argv[4]));});`
  );
  const quote = (value) => (IS_WIN ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`);
  const command = (code) =>
    [process.execPath, script, output, argument, String(code)].map(quote).join(' ');
  for (const [code, allowed] of [
    [0, true],
    // O135: PreToolUse is a safety gate — any non-zero without an explicit
    // allow decision fails closed in claude format too (not only exit 2).
    [1, false],
    [2, false],
    [7, false],
  ]) {
    const r = await runWrite(
      { PreToolUse: [{ command: command(code), format: 'claude' }] },
      { dir: tmp() }
    );
    assert.equal(r.written, allowed, `real explicit exit ${code}`);
    const observed = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(observed.argument, argument);
    assert.equal(observed.payload.event, 'PreToolUse');
    assert.equal(fs.realpathSync.native(observed.cwd), fs.realpathSync.native(r.dir));
    if (code !== 0 && allowed) assert.match(r.stderr, new RegExp(`exited with code ${code}`));
    if (!allowed) assertBlocked(r, new RegExp(`hook exited ${code}`));
  }
  // A real successful command clears the missing command's ERRORLEVEL. A cmd
  // echo does not: it cannot turn a missing hook into an affirmative verdict.
  const recovered = await runWrite({
    PreToolUse: [{ command: `${MISSING} ${IS_WIN ? '&' : ';'} ${command(0)}`, format: 'claude' }],
  });
  assert.equal(recovered.written, true);
  if (IS_WIN) {
    const masked = await runWrite({
      PreToolUse: [{ command: `${MISSING} & echo not-an-exit-verdict`, format: 'claude' }],
    });
    assertBlocked(masked, /failed to start; treated as deny/);
    const conditional = await runWrite({
      PreToolUse: [{ command: `(${MISSING}) && echo forbidden`, format: 'claude' }],
    });
    assertBlocked(conditional, /failed to start; treated as deny/);
    const explicit = await runWrite({
      PreToolUse: [{ command: `${MISSING} & exit /b 0`, format: 'claude' }],
    });
    assert.equal(explicit.written, true);
    const comment = await runWrite({
      PreToolUse: [{ command: 'rem harmless comment', format: 'claude' }],
    });
    assert.equal(comment.written, true);
    const escaped = await runWrite({
      PreToolUse: [{ command: 'echo literal ^& ^( ^) & exit /b 0', format: 'claude' }],
    });
    assert.equal(escaped.written, true);
  }
});

test('claude format + exit 1 with explicit allow decision still allows', async () => {
  useLang('en');
  const command = `node -e "process.stdout.write(JSON.stringify({decision:'allow'}));process.exit(1)"`;
  const r = await runWrite({
    PreToolUse: [{ command, format: 'claude', source: CONFIG }],
  });
  assert.equal(r.written, true, 'explicit allow must still permit the write');
});

test('blocking:false + missing command allows the write and shows the reason', async () => {
  useLang('en');
  const r = await runWrite({ PreToolUse: [{ command: MISSING, blocking: false, source: CONFIG }] });
  assert.equal(r.written, true, 'allowed: file must exist');
  assert.match(r.stderr, /PreToolUse hook could not start; not blocking/);
  assert.match(r.stderr, new RegExp(MISSING));
});

test('repeated failures in one turn print one terminal notice', async () => {
  useLang('en');
  const dir = tmp();
  const cbs = createConfiguredHookCallbacks(
    { PreToolUse: [{ command: MISSING, blocking: false }] },
    { workspaceDir: dir }
  );
  const req = { tool: { name: 'write_target' }, input: {}, sessionKey: 's', runId: 'r' };
  const { stderr } = await captureStderr(async () => {
    await cbs.onBeforeToolExec(req);
    await cbs.onBeforeToolExec(req);
    await cbs.onBeforeToolExec(req);
  });
  assert.equal(stderr.match(/could not start/g)?.length, 1);
});

// Q4: every blocking event fails closed when its hook cannot start.
test('UserPromptSubmit / Stop / PermissionRequest fail closed on a missing command', async () => {
  useLang('en');
  const dir = tmp();
  const cbs = createConfiguredHookCallbacks(
    {
      UserPromptSubmit: [{ command: MISSING, format: 'claude' }],
      Stop: [{ command: MISSING, format: 'claude' }],
      PermissionRequest: [{ command: MISSING, format: 'claude' }],
    },
    { workspaceDir: dir }
  );
  await captureStderr(async () => {
    const ups = await cbs.runUserPromptSubmit('hi');
    assert.equal(ups.blocked, true);
    assert.match(ups.reason, /failed to start; treated as deny/);
    const stop = await cbs.runStop({ stopReason: 'end_turn' });
    assert.equal(stop.blocked, true);
    assert.match(stop.reason, /failed to start; treated as deny/);
    const perm = await cbs.runPermissionRequest({ toolName: 'write_file', input: {} });
    assert.equal(perm.denied, true);
    assert.match(perm.reason, /failed to start; treated as deny/);
  });
});

// Q5: untrusted project hooks never run, so they cannot "fail to start".
test('untrusted dir: project hook does not run; user hook still applies', async () => {
  useLang('en');
  const root = tmp();
  const ws = path.join(root, 'ws');
  const configDir = path.join(root, 'cfg');
  const projectConfigPath = path.join(ws, '.moss', 'config.json');
  const marker = path.join(root, 'user-hook-ran');
  fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    projectConfigPath,
    JSON.stringify({ hooks: { PreToolUse: [{ command: MISSING }] } })
  );
  const userCmd = IS_WIN ? `type nul > "${marker}"` : `touch ${JSON.stringify(marker)}`;
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ command: userCmd }] } })
  );
  const caps = await resolveProjectCapabilities({
    interactive: false,
    headlessUntrusted: true,
    trustFlag: false,
    env: {},
    zh: false,
    workspaceDir: ws,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    projectConfigPath,
  });
  const callbacks = createConfiguredHookCallbacks(caps.hooks, { workspaceDir: ws });
  const r = await runWrite(undefined, { dir: ws, callbacks });
  assert.equal(r.written, true, 'write succeeds');
  assert.doesNotMatch(r.stderr + r.resultText, /could not start|未能启动/);
  assert.equal(fs.existsSync(marker), true, 'user-level hook still ran');
});

// Windows: cmd.exe reports an unknown command as exit 9009.
test(
  'win32: missing command via cmd.exe blocks (claude format)',
  { skip: !IS_WIN && 'platform mismatch (not win32)' },
  async () => {
    useLang('en');
    const r = await runWrite({ PreToolUse: [{ command: MISSING, format: 'claude' }] });
    assertBlocked(r, /failed to start; treated as deny/);
  }
);

// QA follow-up: Stop goes through the runStopHooks outer wrapper, not only runStop.
test('runStopHooks wrapper: missing Stop command blocks', async () => {
  useLang('en');
  const cbs = createConfiguredHookCallbacks(
    { Stop: [{ command: MISSING, format: 'claude' }] },
    { workspaceDir: tmp() }
  );
  setLifecycleHookRunner(cbs);
  try {
    const { value } = await captureStderr(() => runStopHooks({ stopReason: 'end_turn' }));
    assert.equal(value.blocked, true);
    assert.match(value.reason, /failed to start; treated as deny/);
  } finally {
    setLifecycleHookRunner(undefined);
  }
});

test('runStopHooks wrapper: internal error stays fail-open but is visible', async () => {
  setLifecycleHookRunner({
    runStop: async () => {
      throw new Error('o88-internal-boom');
    },
  });
  try {
    const { value, stderr } = await captureStderr(() => runStopHooks({ stopReason: 'end_turn' }));
    assert.deepEqual(value, { blocked: false });
    assert.match(stderr, /\[hooks\] Stop hook failed: .*o88-internal-boom/);
  } finally {
    setLifecycleHookRunner(undefined);
  }
});

// ── PR #88 UX items 5 / 2 / next-step ─────────────────────────────────────

/** Approval refused with `reason`; returns the raw ExecuteToolCallOutcome. */
async function deniedOutcome(reason) {
  let executed = false;
  const ac = new AbortController();
  const outcome = await executeOneToolCall(
    { id: 'denied-1', name: 'write_target', input: {} },
    {
      toolsForRun: [
        {
          name: 'write_target',
          description: 'w',
          inputSchema: { type: 'object', properties: {}, required: [] },
          async execute() {
            executed = true;
            return 'wrote';
          },
        },
      ],
      toolCtx: { workspaceDir: tmp(), sessionKey: 'o88-denied' },
      sessionKey: 'o88-denied',
      abortSignal: ac.signal,
      toolTimeoutMs: 1000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1000,
      skipHeartbeatToolNames: new Set(),
      push() {},
      checkToolApproval: async () => ({
        approved: false,
        decision: 'deny',
        ...(reason ? { reason } : {}),
      }),
    }
  );
  return { outcome, executed };
}

test('[zh] hook-blocked result starts with 已拦截, no English denied prefix, kind stays denied', async () => {
  useLang('zh');
  const r = await runWrite({ PreToolUse: [{ command: MISSING, source: CONFIG }] });
  const ends = r.toolResults.filter((e) => e.type === 'tool_end' || e.type === 'tool_result');
  assert.ok(ends.length > 0);
  assert.doesNotMatch(r.resultText, /Tool execution denied/);
  const { outcome, executed } = await deniedOutcome(
    '已拦截：工具使用前钩子 `x` 未能启动，已按拒绝处理。'
  );
  assert.equal(executed, false);
  assert.equal(outcome.kind, 'denied');
  assert.equal(outcome.error.code, ErrorCode.TOOL_NOT_ALLOWED);
  assert.ok(
    outcome.text.startsWith('已拦截：工具使用前钩子 `x` 未能启动，已按拒绝处理。'),
    outcome.text
  );
  assert.doesNotMatch(outcome.text, /Tool execution denied/);
});

test('[zh] denied without reason is Chinese and still says blocked', async () => {
  useLang('zh');
  const { outcome } = await deniedOutcome(undefined);
  assert.equal(outcome.kind, 'denied');
  assert.equal(outcome.error.code, ErrorCode.TOOL_NOT_ALLOWED);
  assert.ok(outcome.text.startsWith('已拦截'), outcome.text);
  assert.doesNotMatch(outcome.text, /Tool execution denied/);
  // a non-hook reason is wrapped, not left bare
  const other = await deniedOutcome('policy says no');
  assert.ok(other.outcome.text.startsWith('已拦截：'), other.outcome.text);
});

test('[en] denied result keeps explicit blocked/denied wording, kind stays denied', async () => {
  useLang('en');
  for (const reason of [
    'Blocked: PreToolUse hook `x` failed to start; treated as deny.',
    'policy says no',
    undefined,
  ]) {
    const { outcome, executed } = await deniedOutcome(reason);
    assert.equal(executed, false);
    assert.equal(outcome.kind, 'denied');
    assert.equal(outcome.error.code, ErrorCode.TOOL_NOT_ALLOWED);
    assert.match(outcome.text, /^(Blocked\b|Tool execution denied\b)/, outcome.text);
    assert.doesNotMatch(outcome.text, /denied: Blocked/, 'no doubled prefix');
  }
});

test('TUI mode: blocked hook prints no [hooks] stderr line; headless (-p/piped) still does', async () => {
  useLang('en');
  const hooksConfig = { PreToolUse: [{ command: MISSING, source: CONFIG }] };
  const tuiDir = tmp();
  const tuiCbs = createConfiguredHookCallbacks(hooksConfig, { workspaceDir: tuiDir });
  tuiCbs.setTuiMode(true);
  const tuiRun = await runWrite(hooksConfig, { dir: tuiDir, callbacks: tuiCbs });
  assert.equal(tuiRun.written, false);
  assert.doesNotMatch(tuiRun.stderr, /\[hooks\]/, 'TUI: no stderr notice');
  assert.match(
    tuiRun.resultText,
    /failed to start; treated as deny/,
    'TUI: reason still in tool result'
  );

  const headlessDir = tmp();
  const headlessCbs = createConfiguredHookCallbacks(hooksConfig, { workspaceDir: headlessDir });
  headlessCbs.setTuiMode(false);
  const headless = await runWrite(hooksConfig, { dir: headlessDir, callbacks: headlessCbs });
  assert.equal(headless.written, false);
  assert.match(
    headless.stderr,
    /\[hooks\] Blocked: PreToolUse hook `.+` failed to start; treated as deny/
  );
});

test('blocked tool row shows the Next / 下一步 line without ctrl+o', () => {
  const en = [
    'Blocked: PreToolUse hook `x` failed to start; treated as deny.',
    'Command: x',
    'Config: /c.json',
    'stderr: not found',
    'Next: fix the command, or set blocking: false on this hook in that config file.',
  ];
  assert.equal(failedPreviewLimit(true, en, RESULT_PREVIEW_LINES), 5);
  const zh = [
    '已拦截：工具使用前钩子 `x` 未能启动，已按拒绝处理。',
    '命令：x',
    '配置文件：/c',
    '错误输出：x',
    '下一步：…',
  ];
  assert.equal(failedPreviewLimit(true, zh, RESULT_PREVIEW_LINES), 5);
  assert.equal(failedPreviewLimit(false, en, RESULT_PREVIEW_LINES), RESULT_PREVIEW_LINES);
});

for (const event of ['UserPromptSubmit', 'Stop']) {
  test(`TUI mode: ${event} hook that cannot start still prints the [hooks] reason`, async () => {
    useLang('en');
    const cbs = createConfiguredHookCallbacks(
      { [event]: [{ command: MISSING, source: CONFIG }] },
      { workspaceDir: tmp() }
    );
    cbs.setTuiMode(true);
    const { value, stderr } = await captureStderr(() =>
      event === 'Stop' ? cbs.runStop({ stopReason: 'end_turn' }) : cbs.runUserPromptSubmit('hi')
    );
    assert.equal(value.blocked, true);
    assert.match(
      stderr,
      new RegExp(`\\[hooks\\] Blocked: ${event} hook .+ failed to start; treated as deny`)
    );
    assert.match(stderr, new RegExp(MISSING), 'stderr names the hook command');
  });
}
