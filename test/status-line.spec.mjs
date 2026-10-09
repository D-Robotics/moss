#!/usr/bin/env node
/**
 * Status line fields, zh/en labels, and the user command timeout.
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_STATUS_LINE_FIELDS,
  formatStatusLine,
  parseStatusLineConfig,
  runStatusLineCommand,
} from '../dist/cli/status-line.js';
import { renderStatusRight } from '../dist/cli/tui/transcript.js';
import { setTuiLocale } from '../dist/cli/tui/copy.js';

{
  const defaults = parseStatusLineConfig(undefined);
  assert.deepEqual(defaults.fields, [...DEFAULT_STATUS_LINE_FIELDS]);
  assert.equal(defaults.command, undefined);
  assert.equal(defaults.timeoutMs, 1000);
  const custom = parseStatusLineConfig({
    fields: ['model', 'branch', 'nope', 'cost', 'context%'],
    command: '  printf hi  ',
    timeoutMs: 50,
  });
  assert.deepEqual(custom.fields, ['model', 'cwd', 'cost', 'context']);
  assert.equal(custom.command, 'printf hi');
  assert.equal(custom.timeoutMs, 100, 'timeout is clamped to at least 100ms');
  assert.deepEqual(
    parseStatusLineConfig({ fields: [] }).fields,
    [],
    'an empty list shows no fields'
  );
}

{
  const line = formatStatusLine(
    {
      model: 'deepseek-v4-flash',
      cwd: '~/ws',
      branch: 'main',
      tokensIn: 1500,
      tokensOut: 20,
      costLabel: '$0.15',
      contextPct: 12,
      device: 'rdk',
      task: 'EXECUTING',
    },
    ['model', 'cwd', 'tokens', 'cost', 'context', 'device', 'task']
  );
  assert.equal(
    line,
    'deepseek-v4-flash · ~/ws (main) · 1.5k in / 20 out · $0.15 · 12% ctx · device rdk · task executing'
  );
  const zh = formatStatusLine(
    {
      model: 'qwen3.6-plus',
      cwd: '~/ws',
      tokensIn: 100,
      tokensOut: 5,
      costLabel: '¥1.00',
      contextPct: 80,
      device: 'board',
      task: 'BLOCKED',
      zh: true,
    },
    ['tokens', 'cost', 'context', 'device', 'task']
  );
  assert.equal(zh, '100 入 / 5 出 · ¥1.00 · 80% 上下文 · 设备 board · 任务 受阻');
  assert.equal(
    formatStatusLine({ model: 'm', costLabel: '$1.00', tokensIn: 10, tokensOut: 1 }, ['model']),
    'm',
    'omitted fields stay off the line'
  );
}

{
  setTuiLocale(false);
  const shown = renderStatusRight(
    {
      running: false,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      statusFields: ['model', 'cost', 'tokens'],
      model: 'gpt-4o-mini',
      costLabel: '$0.15',
      sessionIn: 1000,
      sessionOut: 10,
    },
    80
  );
  assert.match(shown.text, /gpt-4o-mini/);
  assert.match(shown.text, /\$0\.15/);
  assert.match(shown.text, /1k in \/ 10 out/);
  const hidden = renderStatusRight(
    {
      running: true,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      statusFields: ['model'],
      model: 'gpt-4o-mini',
      costLabel: '$9.99',
      sessionIn: 1000,
      sessionOut: 10,
    },
    80
  );
  assert.match(hidden.text, /● running/);
  assert.doesNotMatch(hidden.text, /\$9\.99/);
  assert.doesNotMatch(hidden.text, / in \//);
  const commanded = renderStatusRight(
    {
      running: true,
      tokens: 0,
      taskCount: 0,
      queueLength: 0,
      commandText: 'custom status',
      model: 'should-hide',
    },
    40
  );
  assert.match(commanded.text, /custom status/);
  assert.doesNotMatch(commanded.text, /should-hide/);
  setTuiLocale(false);
}

{
  const ok = await runStatusLineCommand({
    command: 'printf "hello-status\\nignored"',
    cwd: process.cwd(),
    timeoutMs: 1000,
    payload: { model: 'm' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'hello-status');

  const echoed = await runStatusLineCommand({
    command: `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).model))"`,
    cwd: process.cwd(),
    timeoutMs: 2000,
    payload: { model: 'from-stdin' },
  });
  assert.equal(echoed.ok, true, echoed.reason);
  assert.equal(echoed.text, 'from-stdin');

  const failed = await runStatusLineCommand({
    command: 'exit 3',
    cwd: process.cwd(),
    timeoutMs: 1000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'exit');

  const started = Date.now();
  const timedOut = await runStatusLineCommand({
    command: 'sleep 5',
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  const elapsed = Date.now() - started;
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');
  assert.ok(elapsed < 2000, `timeout returned in ${elapsed}ms`);
}

console.log('[PASS] status line');
