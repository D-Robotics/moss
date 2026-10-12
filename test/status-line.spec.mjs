#!/usr/bin/env node
/**
 * Status line fields, zh/en labels, and the user command timeout.
 */
import assert from 'node:assert/strict';

import { unknownPriceMessage } from '../dist/cli/model-pricing.js';
import {
  DEFAULT_STATUS_LINE_FIELDS,
  formatStatusLine,
  parseStatusLineConfig,
  runStatusLineCommand,
} from '../dist/cli/status-line.js';
import { displayWidth } from '../dist/cli/terminal-text.js';
import { setTuiLocale, tui } from '../dist/cli/tui/copy.js';
import { usageBlock } from '../dist/cli/tui/render-bridge.js';
import { renderStatusRight } from '../dist/cli/tui/transcript.js';

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
    command: `node -e "process.stdout.write('hello-status'+String.fromCharCode(10)+'ignored')"`,
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
    command: 'node -e "setTimeout(()=>{},5000)"',
    cwd: process.cwd(),
    timeoutMs: 200,
  });
  const elapsed = Date.now() - started;
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'timeout');
  assert.ok(elapsed < 2000, `timeout returned in ${elapsed}ms`);
}

{
  setTuiLocale(false);
  const path = '~/workspace/moss/projects/robot';
  const view = {
    running: false,
    tokens: 0,
    taskCount: 0,
    queueLength: 0,
    statusFields: ['model', 'cwd', 'tokens', 'cost', 'context'],
    model: 'deepseek-v4-flash',
    cwd: path,
    branch: 'main',
    costLabel: '~$0.15 (est.)',
    sessionIn: 1500,
    sessionOut: 20,
    contextUsed: 12,
    contextTotal: 100,
  };
  const at = (width) => renderStatusRight(view, width).text;
  const fullPath = `${path} (main)`;
  for (const width of [40, 60, 80, 120]) {
    const text = at(width);
    assert.ok(displayWidth(text) <= width, `${width} cols overflow: ${displayWidth(text)}`);
    assert.match(text, /deepseek-v4-flash/, `${width} keeps the model`);
    assert.match(text, /1\.5k in \/ 20 out/, `${width} keeps the token count`);
  }
  assert.match(at(120), new RegExp(fullPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(at(120), /~\$0\.15 \(est\.\)/);
  assert.match(at(120), /12% ctx/);
  assert.match(at(80), /…/, '80 cols shortens the path before dropping the model');
  assert.doesNotMatch(at(80), /projects\/robot \(main\)/);
  assert.match(at(80), /deepseek-v4-flash/);
  assert.match(at(80), /1\.5k in \/ 20 out/);
  assert.doesNotMatch(at(60), /workspace/, '60 cols drops the path before the model and tokens');
  assert.match(at(60), /~\$0\.15 \(est\.\)/);
  assert.doesNotMatch(at(40), /workspace/);
  assert.doesNotMatch(at(40), /\$0\.15/, '40 cols keeps tokens ahead of cost when both cannot fit');
  assert.match(at(40), /deepseek-v4-flash · 1\.5k in \/ 20 out/);

  const unknown = { ...view, costLabel: 'price unknown' };
  const unknownAt = (width) => renderStatusRight(unknown, width).text;
  assert.match(unknownAt(120), /price unknown/, '120 cols keeps the short unknown-price field');
  assert.match(unknownAt(120), /deepseek-v4-flash/);
  assert.doesNotMatch(unknownAt(120), /set it with/);
  assert.doesNotMatch(unknownAt(40), /price unknown/, '40 cols drops price unknown like cost');
  assert.match(unknownAt(40), /deepseek-v4-flash · 1\.5k in \/ 20 out/);
  for (const width of [40, 60, 80, 120]) {
    assert.ok(displayWidth(unknownAt(width)) <= width, `${width} cols overflow`);
  }
  setTuiLocale(true);
  assert.equal(tui('price unknown'), '价格未知');
  const zhAt = (width) =>
    renderStatusRight({ ...view, costLabel: tui('price unknown') }, width).text;
  assert.match(zhAt(120), /价格未知/);
  assert.doesNotMatch(zhAt(40), /价格未知/);
  setTuiLocale(false);

  const usage = usageBlock(
    {
      tokensIn: 100,
      tokensOut: 10,
      cacheReadTokens: 0,
      runs: 1,
      apiMs: 0,
      ttftSamples: [],
      compactions: 0,
      slices: [{ model: 'deepseek-flash', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }],
      lastModel: 'deepseek-flash',
      sessionModel: 'deepseek-flash',
    },
    {}
  );
  assert.ok(
    usage.some((line) => line === unknownPriceMessage('deepseek-flash')),
    '/usage prints the full how-to-set-a-price sentence'
  );
}

console.log('[PASS] status line');
