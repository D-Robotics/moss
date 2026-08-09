#!/usr/bin/env node
import assert from 'node:assert/strict';
import { renderMarkdown } from '../dist/cli/tui-utils.js';

const rendered = renderMarkdown(
  [
    '| Path | Purpose |',
    '| --- | --- |',
    '| README.md | Documentation |',
    '',
    'Want me to open it?',
  ].join('\n')
);

assert.match(
  rendered,
  /Documentation\n\nWant me to open it\?/,
  'a Markdown table is separated from following prose'
);
assert.doesNotMatch(
  rendered,
  /---\s*\|\s*---/,
  'a rendered table must not expose the Markdown separator row'
);
assert.match(rendered, /─+┼─+/, 'a rendered table uses a terminal-friendly header divider');

const narrowWideTable = renderMarkdown(
  [
    '| 包 | 目录 | 发布入口 | 源码入口 |',
    '| --- | --- | --- | --- |',
    '| @rdk-moss/core | packages/moss | ./dist/index.js | packages/moss/src/index.ts |',
    '| @rdk-moss/agent | packages/moss-agent | ./dist/index.js | packages/moss-agent/src/index.ts |',
  ].join('\n'),
  { width: 80 }
);

assert.doesNotMatch(
  narrowWideTable,
  /─+┼─+/,
  'a many-column table does not become a crushed grid on a narrow terminal'
);
assert.match(narrowWideTable, /1\. @rdk-moss\/core/);
assert.match(narrowWideTable, /目录： packages\/moss/);
assert.match(narrowWideTable, /源码入口： packages\/moss\/src\/index\.ts/);
assert.match(narrowWideTable, /2\. @rdk-moss\/agent/);

const verboseThreeColumnTable = renderMarkdown(
  [
    '| 步骤 | 操作 | 结果 |',
    '| --- | --- | --- |',
    '| 启动 | 后台 shell 每秒输出 tick，并派生 sleep 600 子进程 | 成功启动并返回父子 PID |',
    '| 验证 | 用系统命令检查父子进程是否残留 | 两者均不存在 |',
  ].join('\n'),
  { width: 90 }
);
assert.doesNotMatch(
  verboseThreeColumnTable,
  /─+┼─+/,
  'verbose three-column tables stack at 90 columns'
);
assert.match(verboseThreeColumnTable, /操作： 后台 shell/);

console.log('[PASS] Markdown tables keep following prose readable');
