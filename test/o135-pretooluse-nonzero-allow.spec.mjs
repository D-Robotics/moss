#!/usr/bin/env node
/**
 * O135 QA F1 + PM ruling (2026-10-18): a PreToolUse hook that exits non-zero
 * is denied in both moss and claude formats, whatever its output says —
 * `decision:"allow"`, `decision:"approve"` or
 * `hookSpecificOutput.permissionDecision:"allow"` are ignored (the output of a
 * process that failed is not trusted). Deliberately stricter than Claude Code.
 *
 * Process level: real `dist/cli.js -p` (o121 harness, fake model server); the
 * model runs an exec that overwrites notes.txt. Each blocked case asserts
 * exit 9, the 「被拦」/`Blocked by` last line, the hook named with its allow
 * ignored, and the sha256 of notes.txt identical before and after.
 * In-process: MossAgent + a real file-writing tool for the remaining paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const IS_WIN = process.platform === 'win32';

/** `node -e` body in double quotes, single quotes inside: same on cmd.exe and sh. */
const nodeHook = (js) => `node -e "${js}"`;
const ALLOWS = {
  allow: "console.log(JSON.stringify({decision:'allow'}))",
  approve: "console.log(JSON.stringify({decision:'approve'}))",
  'hookSpecificOutput.permissionDecision:allow':
    "console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow'}}))",
};

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function quiet(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = orig;
  }
}

/** One scripted turn: the model calls write_target, which overwrites out.txt. */
async function runWrite(hook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135f1-'));
  const target = path.join(dir, 'out.txt');
  fs.writeFileSync(target, 'original\n');
  const before = sha256(target);
  const cbs = createConfiguredHookCallbacks({ PreToolUse: [hook] }, { workspaceDir: dir });
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('o135', 'O135', [
      { toolCalls: [{ name: 'write_target', input: {} }] },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'o135',
    baseSystemPrompt: 'Write the file.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 4,
    hooks: { onBeforeToolExec: cbs.onBeforeToolExec },
  });
  let executed = false;
  agent.tools.register({
    name: 'write_target',
    description: 'Overwrite out.txt.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      executed = true;
      fs.writeFileSync(target, 'PWNED\n');
      return 'wrote out.txt';
    },
  });
  const results = [];
  await quiet(async () => {
    for await (const ev of agent.streamChat(`o135f1-${Date.now()}-${Math.random()}`, 'go')) {
      if (ev.type === 'tool_result' || ev.type === 'tool_end') results.push(ev);
    }
  });
  return { before, after: sha256(target), executed, resultText: JSON.stringify(results) };
}

function assertBlocked(r, label) {
  assert.equal(r.executed, false, `${label}: tool must not run`);
  assert.equal(r.after, r.before, `${label}: file hash must be unchanged`);
  assert.match(r.resultText, /Blocked by PreToolUse hook|PreToolUse/, `${label}: names PreToolUse`);
}

function assertAllowed(r, label) {
  assert.equal(r.executed, true, `${label}: tool must run`);
  assert.notEqual(r.after, r.before, `${label}: file must be written`);
}

test.beforeEach(() => {
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
});

// ── Process level: real CLI, exit code + file hash ───────────────────────────
const NOTES = 'original notes\n';
const WRITE_NOTES = {
  name: 'exec',
  args: { command: `node -e "require('fs').writeFileSync('notes.txt','PWNED')"` },
};
const shaOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function cli(hook, lang = 'en') {
  const r = await scenario({
    lang,
    hooks: { PreToolUse: [hook] },
    steps: [WRITE_NOTES],
    finalText: lang === 'zh' ? '全部完成，已经做好了。' : 'All done, everything is finished.',
    notesBody: NOTES,
  });
  return { ...r, unchanged: shaOf(r.notes) === shaOf(NOTES) };
}

function assertCliBlocked(r, hook, code, said, lang = 'en') {
  const ctx = `code=${r.code} last=${r.last}\n${r.err.slice(-600)}`;
  assert.equal(r.code, 9, `exit 9; ${ctx}`);
  assert.equal(r.unchanged, true, `notes.txt hash must be unchanged; ${ctx}`);
  assert.match(r.last, lang === 'zh' ? /被拦：钩子拦下/ : /Blocked by: hook blocked/, ctx);
  if (said) {
    const esc = hook.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const verdict =
      lang === 'zh'
        ? `工具使用前钩子以 exit ${code} 退出，已按拒绝处理（忽略其输出中的 ${said}）。钩子：`
        : `PreToolUse hook: exited with code ${code}; treated as deny \\(ignored the ${said} in its output\\)\\. Hook: `;
    assert.match(
      r.toolResults.join('\n'),
      new RegExp(`${verdict}\`${esc}\``),
      `tool result; ${ctx}`
    );
    // The terminal line may truncate a long command: require the verdict there.
    assert.match(r.err.replace(/\s+/g, ' '), new RegExp(verdict), `terminal; ${ctx}`);
  }
}

const SAID = {
  allow: 'allow',
  approve: 'approve',
  'hookSpecificOutput.permissionDecision:allow': 'allow',
};

// PM acceptance matrix: moss/claude × exit 1/2/3 × three allow outputs = 18.
for (const format of ['moss', 'claude']) {
  for (const code of [1, 2, 3]) {
    for (const [name, print] of Object.entries(ALLOWS)) {
      test(`F1 CLI ${format}: exit ${code} + ${name} → exit 9, file unchanged`, async () => {
        const hook = {
          command: nodeHook(`${print};process.exit(${code})`),
          ...(format === 'claude' ? { format } : {}),
        };
        assertCliBlocked(await cli(hook), hook, code, SAID[name]);
      });
    }
  }
}

// PM acceptance also lists 无输出: non-zero with no output blocks at CLI level.
for (const format of ['moss', 'claude']) {
  for (const code of [1, 2, 3]) {
    test(`F1 CLI ${format}: exit ${code} + no output → exit 9, file unchanged`, async () => {
      const hook = {
        command: nodeHook(`process.exit(${code})`),
        ...(format === 'claude' ? { format } : {}),
      };
      assertCliBlocked(await cli(hook), hook, code, undefined);
    });
  }
}

for (const format of ['moss', 'claude']) {
  for (const name of ['allow', 'approve']) {
    test(`F1 CLI ${format}: prints ${name} then crashes → exit 9, file unchanged`, async () => {
      const hook = {
        command: nodeHook(`${ALLOWS[name]};throw new Error('policy check crashed')`),
        ...(format === 'claude' ? { format } : {}),
      };
      assertCliBlocked(await cli(hook), hook, 1, name);
    });
  }
}

test('F1 CLI zh copy: claude exit 1 + allow names the hook and the ignored allow', async () => {
  const hook = { command: nodeHook(`${ALLOWS.allow};process.exit(1)`), format: 'claude' };
  assertCliBlocked(await cli(hook, 'zh'), hook, 1, 'allow', 'zh');
});

for (const format of ['moss', 'claude']) {
  const fmt = format === 'claude' ? { format } : {};
  test(`CLI ${format}: exit 0 + allow still allows (exit 0, file written)`, async () => {
    const r = await cli({ command: nodeHook(`${ALLOWS.allow};process.exit(0)`), ...fmt });
    assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
    assert.equal(r.unchanged, false, 'file written');
  });
  test(`CLI ${format}: exit 0 + deny still blocks (exit 9, file unchanged)`, async () => {
    const hook = {
      command: nodeHook(
        "console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}}));process.exit(0)"
      ),
      ...fmt,
    };
    assertCliBlocked(await cli(hook), hook, 0, undefined);
  });
}

// ── In-process (MossAgent, real write): every non-zero blocks ─────────────────
const OUTPUTS = { ...ALLOWS, 'no output': '' };
for (const format of ['moss', 'claude']) {
  const fmt = format === 'claude' ? { format } : {};
  for (const code of [1, 2, 3, 7]) {
    for (const [name, print] of Object.entries(OUTPUTS)) {
      test(`F1 ${format}: exit ${code} + ${name} blocks; file hash unchanged`, async () => {
        const js = print ? `${print};process.exit(${code})` : `process.exit(${code})`;
        const r = await runWrite({ command: nodeHook(js), ...fmt });
        assertBlocked(r, `${format} exit ${code} + ${name}`);
      });
    }
  }
}

// ── Must stay as before (no over-blocking, fail-closed paths intact) ─────────
for (const format of ['moss', 'claude']) {
  const fmt = format === 'claude' ? { format: 'claude' } : {};
  test(`${format} format: exit 0 + allow still allows`, async () => {
    const r = await runWrite({ command: nodeHook(`${ALLOWS.allow};process.exit(0)`), ...fmt });
    assertAllowed(r, `${format} exit 0 + allow`);
  });
  test(`${format} format: exit 0 + empty output still allows`, async () => {
    const r = await runWrite({ command: nodeHook('process.exit(0)'), ...fmt });
    assertAllowed(r, `${format} exit 0 empty`);
  });
  test(`${format} format: missing command blocks`, async () => {
    const r = await runWrite({ command: 'moss-o135f1-definitely-missing-cmd', ...fmt });
    assertBlocked(r, `${format} missing`);
  });
  test(`${format} format: exit 1 + malformed JSON blocks`, async () => {
    const r = await runWrite({ command: nodeHook("console.log('{bad');process.exit(1)"), ...fmt });
    assertBlocked(r, `${format} malformed`);
  });
  test(`${format} format: timeout blocks`, async () => {
    const r = await runWrite({
      command: nodeHook('setTimeout(()=>{},60000)'),
      timeoutMs: 1000,
      ...fmt,
    });
    assertBlocked(r, `${format} timeout`);
  });
  test(
    `${format} format: not executable (126) blocks`,
    { skip: IS_WIN && 'POSIX mode bits' },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o135f1-x-'));
      const script = path.join(dir, 'noexec.sh');
      fs.writeFileSync(script, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(script, 0o644);
      const r = await runWrite({ command: script, ...fmt });
      assertBlocked(r, `${format} 126`);
    }
  );
  test(
    `${format} format: killed by signal blocks`,
    { skip: IS_WIN && 'POSIX signals' },
    async () => {
      const r = await runWrite({
        command: nodeHook("process.kill(process.pid,'SIGKILL')"),
        ...fmt,
      });
      assertBlocked(r, `${format} SIGKILL`);
    }
  );
}
