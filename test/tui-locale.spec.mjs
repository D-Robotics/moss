#!/usr/bin/env node
/**
 * TUI chrome localization (v0.25, Part B).
 *
 * `src/cli/tui/copy.ts` is the single mapping from moss's own English chrome to
 * its zh rendering. Three promises this spec pins down:
 *
 *   1. English mode is BYTE-IDENTICAL to the pre-i18n concatenation — the whole
 *      existing spec suite runs with `LANG=C`, so `tui()` must reproduce the old
 *      string (including `{placeholder}` substitution) exactly.
 *   2. zh mode translates only moss's OWN wording — command names, keys, paths,
 *      model/skill/MCP/tool names, user input and raw output pass through.
 *   3. The mapping is a pure lookup that agrees with the render sites: the
 *      Chinese it returns is what the projections actually print.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ZH, isTuiZh, setTuiLocale, transientStatus, tui } from '../dist/cli/tui/copy.js';
import { rowsForSurface } from '../dist/cli/interactive-commands.js';
import { shellPaletteRows } from '../dist/cli/tui/app.js';
import { HELP_KEYS, HELP_PREFIXES } from '../dist/cli/tui/help.js';
import {
  renderApproval,
  composerPlaceholderText,
  renderComposer,
  renderHint,
  renderRunSummary,
  renderStatusRight,
} from '../dist/cli/tui/transcript.js';

// ─── 1. locale gating ─────────────────────────────────────────────────────

{
  setTuiLocale(false);
  assert.equal(isTuiZh(), false, 'default/EN locale reports EN');
  assert.equal(tui('Working'), 'Working', 'EN passes moss wording through untouched');
  assert.equal(tui('Usage'), 'Usage', 'EN /usage header stays Usage');

  setTuiLocale(true);
  assert.equal(isTuiZh(), true, 'zh locale reports zh');
  assert.equal(tui('Working'), '处理中', 'zh translates moss wording');
  assert.equal(tui('Usage'), '用量', 'zh /usage header comes from the copy dictionary');

  setTuiLocale(false); // leave the process in EN for the byte-identical checks
}

// ─── 2. EN is byte-identical, including placeholder substitution ──────────

{
  // The pre-i18n code built these by concatenation; `tui()` must reproduce the
  // byte sequence exactly, or every LANG=C spec breaks.
  assert.equal(tui('exit code {code}', { code: 3 }), 'exit code 3', 'EN substitutes numbers');
  assert.equal(
    tui('history {n}/{total} — ↑↓ to walk · type to edit', { n: 2, total: 5 }),
    'history 2/5 — ↑↓ to walk · type to edit',
    'EN substitutes several placeholders'
  );
  assert.equal(
    tui('{done}/{total} done', { done: 1, total: 4 }),
    '1/4 done',
    'EN todo counter is unchanged'
  );
  // No params: the raw template comes back.
  assert.equal(tui('Do you want to proceed?'), 'Do you want to proceed?', 'EN keeps literals');
  // A miss in zh is also the English text (moss does not own the string).
  setTuiLocale(true);
  assert.equal(
    tui('some model output the harness never wrote'),
    'some model output the harness never wrote',
    'zh passes unknown strings through'
  );
  setTuiLocale(false);
}

// ─── 3. placeholder substitution is literal (no `$` interpretation) ───────

{
  // A replacer function is used, so `$&`/`$1` in a VALUE must not be expanded —
  // a user-typed goal or a path could contain them.
  const nasty = "cost $& $1 $` $'";
  assert.equal(
    tui('deleted {what} — Ctrl+Y to paste back', { what: nasty }),
    `deleted ${nasty} — Ctrl+Y to paste back`,
    'EN inserts `$` sequences verbatim'
  );
  // An unknown placeholder is left in place rather than dropped to undefined.
  assert.equal(
    tui('exit code {code}', { other: 1 }),
    'exit code {code}',
    'a missing placeholder stays literal'
  );
  // Extra params are ignored.
  assert.equal(tui('ok', { unused: 'x' }), 'ok', 'single-word keys ignore params');
}

// ─── 4. zh values are never themselves EN keys (tui is idempotent) ────────

{
  const keys = Object.keys(ZH);
  const values = new Set(Object.values(ZH));
  const collisions = keys.filter((key) => values.has(key));
  assert.deepEqual(collisions, [], 'no zh value is also an English key');
  for (const [key, value] of Object.entries(ZH)) {
    assert.ok(value.length > 0, `value for ${JSON.stringify(key)} is non-empty`);
  }
  // Applying the mapping twice is a no-op — proves idempotency from the outside.
  setTuiLocale(true);
  for (const key of keys) {
    assert.equal(tui(tui(key)), tui(key), `tui is idempotent for ${JSON.stringify(key)}`);
  }
  setTuiLocale(false);
}

// ─── 5. only moss's own wording is translated ─────────────────────────────

{
  setTuiLocale(true);
  // Identifiers and raw output are NOT in the dictionary: they pass through.
  for (const raw of [
    '/task',
    '/model',
    'deepseek-flash',
    'src/cli/tui/copy.ts',
    'Device Exec',
    'mcp__rdk_docs__search_docs',
    'camera_fps',
    'READY',
  ]) {
    assert.equal(tui(raw), raw, `${raw} is left alone`);
  }
  setTuiLocale(false);
}

// ─── 6. transient status dismisser agrees with the producer, both locales ─

{
  // The producer sets these through tui(); the dismisser must recognize the
  // localized leading word too, or a real edit would fail to clear the note.
  setTuiLocale(false);
  assert.equal(transientStatus('history 2/5 — ↑↓ to walk · type to edit'), true, 'EN history note');
  assert.equal(transientStatus('deleted word — Ctrl+Y to paste back'), true, 'EN kill-ring note');
  assert.equal(
    transientStatus('nothing to paste — Ctrl+U / Ctrl+K / Ctrl+W delete into the kill ring'),
    true,
    'EN empty-kill-ring note'
  );
  assert.equal(transientStatus('some other status'), false, 'EN ordinary note is not transient');

  setTuiLocale(true);
  assert.equal(
    transientStatus(tui('history {n}/{total} — ↑↓ to walk · type to edit', { n: 2, total: 5 })),
    true,
    'zh history note is dismissed by its localized wording'
  );
  assert.equal(
    transientStatus(tui('deleted {what} — Ctrl+Y to paste back', { what: 'x' })),
    true,
    'zh kill-ring note'
  );
  assert.equal(transientStatus('无关的状态'), false, 'zh ordinary note is not transient');
  setTuiLocale(false);
}

// ─── 7. the render sites actually print the Chinese ───────────────────────

{
  const run = (fn, zh) => {
    setTuiLocale(zh);
    return fn();
  };

  // Status row: the running/waiting words and the ctx/out counters.
  const enStatus = run(
    () => renderStatusRight({ running: true, blocked: false, model: 'm', tokens: 0 }, 80).text,
    false
  );
  const zhStatus = run(
    () => renderStatusRight({ running: true, blocked: false, model: 'm', tokens: 0 }, 80).text,
    true
  );
  assert.ok(enStatus.includes('● running'), 'EN status says running');
  assert.ok(zhStatus.includes('● 运行中'), 'zh status says 运行中');
  assert.ok(zhStatus.includes('m'), 'the model name is not translated');

  // Hint row: mode label + the shortcuts affordance.
  const zhHint = run(() => renderHint({ mode: 'default' }, 80).text, true);
  assert.ok(zhHint.includes('? 查看快捷键'), 'zh hint advertises the key reference in zh');
  const enHint = run(() => renderHint({ mode: 'default' }, 80).text, false);
  assert.ok(enHint.includes('? for shortcuts'), 'EN hint is unchanged');

  // A non-default mode uses the locale-aware label vocabulary.
  const zhPlanHint = run(() => renderHint({ mode: 'plan' }, 80).text, true);
  assert.ok(zhPlanHint.includes('计划模式'), 'zh hint names the plan mode in zh');

  // Composer placeholder.
  const zhPh = run(() => renderComposer('', 80, true)[0].text, true);
  assert.ok(zhPh.includes('试试'), 'zh composer placeholder is translated');
  assert.ok(
    run(() => composerPlaceholderText(), true).includes('试试'),
    'the live composer uses the same localized placeholder'
  );

  // Run summary verb + done stamp.
  const zhSummary = run(() => renderRunSummary(5000, false, 80)[1].text, true);
  assert.ok(zhSummary.includes('完成于'), 'zh run summary stamps the finish time in zh');
  const enSummary = run(() => renderRunSummary(5000, false, 80)[1].text, false);
  assert.ok(enSummary.includes(' · done '), 'EN run summary is unchanged');

  // Approval options: the frozen EN defaults are translated at the render site.
  const zhApproval = run(
    () => renderApproval({ question: '', title: 'Write a file', subject: '/tmp/x', cursor: 0 }, 80),
    true
  ).map((l) => l.text);
  assert.ok(
    zhApproval.some((text) => text.includes('是否继续？')),
    'zh approval renders the fallback question in zh'
  );
  assert.ok(
    zhApproval.some((text) => /1\. 是/.test(text)),
    'zh approval renders its option labels in zh'
  );
  const enApproval = run(
    () => renderApproval({ question: '', title: 'Write a file', subject: '/tmp/x', cursor: 0 }, 80),
    false
  ).map((l) => l.text);
  assert.ok(
    enApproval.some((text) => text.includes('Do you want to proceed?')),
    'EN approval is unchanged'
  );
  setTuiLocale(false);
}

// ─── 8. the whole advertised command surface has zh descriptions ──────────

{
  setTuiLocale(true);
  const missing = rowsForSurface('tui')
    .map((row) => row.description)
    .filter((description) => tui(description) === description);
  assert.deepEqual(missing, [], 'every tui-surface command description is translated');

  // The `/` palette draws the SAME catalog as the `/help` overlay, so its
  // descriptions must localize too — the two surfaces can never disagree.
  const missingPalette = shellPaletteRows('')
    .map(([, description]) => description)
    .filter((description) => tui(description) === description);
  assert.deepEqual(missingPalette, [], 'every palette row description is translated');

  // Keys and prefixes documented by `?` are translated too.
  const missingHelp = [...HELP_KEYS, ...HELP_PREFIXES]
    .map(([, what]) => what)
    .filter((what) => tui(what) === what);
  assert.deepEqual(missingHelp, [], 'every help key/prefix row is translated');
  setTuiLocale(false);
}

{
  setTuiLocale(false);
  const view = {
    title: '毁灭性设备操作',
    question: '要执行吗？',
    cursor: 1,
    preview: ['选 a 将在本会话信任：reboot', 'Answering a trusts: reboot'],
    options: [
      { key: '1', answer: 'y', label: 'Yes' },
      { key: '2', answer: 'a', label: 'Trust' },
      { key: '3', answer: 'n', label: 'No' },
    ],
  };
  const text = renderApproval(view, 80)
    .map((entry) => entry.text)
    .join('\n');
  assert.match(text, /选 2/);
  assert.match(text, /Choosing 2/);
  assert.equal(text.includes('选 a'), false);
  assert.equal(text.includes('Answering a'), false);
}

{
  setTuiLocale(true);
  assert.equal(tui('ctrl+o to expand'), 'ctrl+o 展开');
  assert.notEqual(tui('ctrl+o to expand'), 'ctrl+o to expand');
  const collapsed = renderHint(
    { running: false, tokens: 0, taskCount: 0, queueLength: 0, collapsed: true },
    120
  ).text;
  assert.match(collapsed, /ctrl\+o 展开/);
  assert.equal(collapsed.includes('ctrl+o to expand'), false);
  const root = path.join(process.cwd(), 'src', 'cli', 'tui');
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  const missing = [];
  const callRe = /tui\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(callRe)) {
      const key = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      if (key.includes('${')) continue;
      if (!Object.prototype.hasOwnProperty.call(ZH, key)) {
        missing.push(`${path.relative(process.cwd(), file)}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'every TUI chrome tui() literal has a zh entry');
  assert.equal(tui('verbose transcript · ctrl+o to exit'), '详细对话记录 · ctrl+o 退出');
  assert.equal(tui('{count} skills', { count: 2 }), '2 个技能');
  assert.equal(
    tui('rejected — no single active run on this session'),
    '已拒绝 — 本会话没有单一活动运行'
  );
  assert.equal(
    tui('  … stream quiet for {seconds}s — the gateway may be stuck', { seconds: 20 }),
    '  … 流已静默 20 秒'
  );
  assert.equal(tui('✻ worked for {seconds}s{doneAt}', { seconds: 3, doneAt: '' }), '✻ 用时 3 秒');
  assert.equal(tui('answer: {value}', { value: 'y' }), '回答：y');
  for (const [key, value] of Object.entries(ZH)) {
    if (!/\p{Script=Han}/u.test(value)) continue;
    assert.equal(value.includes(':'), false, `half-width colon in ${JSON.stringify(key)}`);
    const prose = value.replace(/moss skill create/g, '');
    assert.equal(/\b(transcript|skills?)\b/i.test(prose), false, key);
    assert.equal(/\brun\b/i.test(prose), false, key);
    assert.equal(/\{seconds\}s/.test(value), false, key);
    assert.equal(value.includes('网关可能卡住'), false, key);
  }
  setTuiLocale(false);
}

console.log('OK tui-locale');
