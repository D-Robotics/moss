#!/usr/bin/env node
import assert from 'node:assert/strict';
import { focusedInspectionRunOptions, oneShotToolFilterForMessage } from '../dist/cli/oneshot.js';

const tool = (name) => ({ name, description: '', inputSchema: { type: 'object', properties: {} } });

{
  const allow = oneShotToolFilterForMessage('Fix the failing unit tests in this local project');
  for (const name of ['read_file', 'edit_file', 'exec', 'run_tests']) {
    assert.equal(allow(tool(name)), true, `${name} remains available for local coding`);
  }
  // web_search is gated unless the prompt needs online search
  assert.equal(allow(tool('web_search')), false, 'web_search hidden without web signal');
  for (const name of [
    'web_browser_agent',
    'vision_analyze',
    'fleet_batch',
    'fan_out_subagents',
    'exec_background',
    'plan',
    'plan_step',
    'eval',
    'skillhub_search',
  ]) {
    assert.equal(
      allow(tool(name)),
      false,
      `${name} is omitted when the request has no matching capability signal`
    );
  }
  assert.equal(allow(tool('custom_company_tool')), true, 'unknown/custom tools are never hidden');
}

{
  const allow = oneShotToolFilterForMessage('Reply with exactly: PONG');
  for (const name of ['read_file', 'exec', 'web_search', 'todo_write', 'load_skill']) {
    assert.equal(allow(tool(name)), false, `pure chat hides ${name}`);
  }
}

{
  const allow = oneShotToolFilterForMessage('search the web for D-Robotics RDK news');
  assert.equal(allow(tool('web_search')), true, 'web signal enables web_search');
  assert.equal(allow(tool('read_file')), true, 'coding tools still available with web signal');
}

{
  // Time-sensitive / current-events phrasing without an explicit "web" keyword
  // must still enable web tools — otherwise moss refuses with "no web tools"
  // instead of searching for current events.
  for (const prompt of [
    '今天机器人相关的大事件呢',
    '最近有什么具身智能的新进展？',
    '最新的 ROS 2 版本是什么',
    '现在当前发生了什么',
    "what are today's robotics events",
    'any recent humanoid robot news',
  ]) {
    const allow = oneShotToolFilterForMessage(prompt);
    assert.equal(
      allow(tool('web_search')),
      true,
      `time-sensitive prompt enables web_search: ${prompt}`
    );
    assert.equal(
      allow(tool('web_fetch')),
      true,
      `time-sensitive prompt enables web_fetch: ${prompt}`
    );
  }
}

{
  // Coding-adjacent lookup (find a solution / look up docs / latest API / how-to)
  // also needs web — coding often needs live docs/examples, not training memory.
  for (const prompt of [
    '怎么用 fastify 写一个 websocket 接口',
    '如何实现 OAuth2 PKCE 流程',
    '查一下 Astro 的 latest API 怎么定义 collection',
    'find how to configure vite for SSR',
    '这个报错 TypeError: Cannot read properties of undefined 怎么办',
    'React 19 的 use() hook 怎么用',
  ]) {
    const allow = oneShotToolFilterForMessage(prompt);
    assert.equal(
      allow(tool('web_search')),
      true,
      `coding-lookup prompt enables web_search: ${prompt}`
    );
    assert.equal(
      allow(tool('web_fetch')),
      true,
      `coding-lookup prompt enables web_fetch: ${prompt}`
    );
    // Coding tools stay available too (these are still coding prompts).
    assert.equal(allow(tool('read_file')), true, `coding-lookup keeps read_file: ${prompt}`);
  }
}

{
  // Browser tools gated behind browser signals — over-narrowing fix: login
  // flows + JS-rendered/dynamic pages + scraping must trigger browser tools,
  // not only the literal word "browser".
  for (const prompt of [
    '登录这个网站抓数据',
    '登陆后台导出订单',
    '抓取这个 JS 渲染的页面内容',
    '这个动态网站需要点击按钮才加载数据',
    'scrape the single-page app for product info',
  ]) {
    const allow = oneShotToolFilterForMessage(prompt);
    assert.equal(
      allow(tool('web_browser_agent')),
      true,
      `browser-use prompt enables browser tools: ${prompt}`
    );
  }
}

{
  const allow = oneShotToolFilterForMessage('不要调用任何工具，只根据现有上下文简短回答。');
  for (const toolName of ['read_file', 'exec', 'web_search', 'write_file']) {
    assert.equal(allow({ name: toolName }), false, `explicit no-tool request hides ${toolName}`);
  }
}

// Non-ops coding should keep device schemas out of prefill.
{
  const allow = oneShotToolFilterForMessage('Fix the failing unit tests in this local project');
  assert.equal(allow(tool('device_exec')), false, 'device_exec hidden without board/ops signal');
  assert.equal(allow(tool('fleet_batch')), false, 'fleet_batch hidden without board/ops signal');
}

for (const [prompt, expected] of [
  [
    'Open the browser, fill the login form, and take a screenshot',
    ['web_browser_control', 'screenshot_capture'],
  ],
  ['Analyze this image and explain the UI', ['vision_analyze']],
  ['Run the dev server in the background and inspect logs', ['exec_background', 'exec_logs']],
  ['Ask several subagents to review this in parallel', ['fan_out_subagents', 'subagent_status']],
  [
    'How is the codebase organized? Explore the architecture overview.',
    ['create_subagent', 'fan_out_subagents'],
  ],
  [
    'Fix the login and session bugs in parallel with multi-angle review',
    ['fan_out_subagents', 'create_subagent'],
  ],
  [
    'Search skillhub and load the coding skill from skillhub',
    ['skillhub_search', 'skillhub_install'],
  ],
  [
    'Run a background subagent to fix the auth bug',
    ['create_subagent', 'subagent_status', 'subagent_stop'],
  ],
  [
    'Connect to the RDK board and inspect ROS topics',
    ['fleet_batch', 'device_exec', 'device_info', 'device_robotics_status'],
  ],
  ['Create a plan and run the evaluation suite', ['plan', 'plan_step', 'eval']],
]) {
  const allow = oneShotToolFilterForMessage(prompt);
  for (const name of expected)
    assert.equal(allow(tool(name)), true, `${name} enabled for: ${prompt}`);
}

console.log('[PASS] one-shot tool routing keeps explicit capabilities discoverable');

{
  const focused = focusedInspectionRunOptions(
    '这是一个有未提交改动的 monorepo。请只读分析：指出真实 CLI 入口、core 与 agent 两个包的主入口、针对 moss-agent 单包最窄的测试命令，并说明你查看了哪些文件。不要修改任何文件，也不要反复打印目录树。'
  );
  assert.deepEqual(
    { maxTurns: focused?.maxTurns, maxToolCalls: focused?.maxToolCalls },
    { maxTurns: 4, maxToolCalls: 8 },
    'bounded read-only repository questions get a focused run budget'
  );
  assert.match(focused?.extraContext ?? '', /do not list that directory/i);
  assert.match(focused?.extraContext ?? '', /answer only the requested fields/i);
}

assert.equal(
  focusedInspectionRunOptions('修复整个仓库的测试并验证所有改动'),
  undefined,
  'implementation tasks remain unrestricted'
);
