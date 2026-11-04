#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateInstallToolsNudge } from '../dist/core/loop/nudges/install-tools-nudge.js';

const originalData1 =
  'QA1102-DATA1：这是合成CSV只读分析测试，不是实机测量。只用文件读取工具实际读取当前项目根目录qa-readings-1102.csv，不根据文件名或其他对话猜数据。先按status等于ok筛选，再统计其中latency_ms非空数值；合法0必须计入，缺失值不能当0，status非ok排除。只输出一个有效JSON，不用Markdown，字段为sourcePath（实际绝对路径）、dataRows（不含表头）、okRows、numericRows、sumMs、avgMs、minMs、maxMs、missingReadingIds、excludedStatusIds、syntheticOnly。不要修改任何文件，不执行命令，不安装依赖，不连接设备，不访问外网；无法实际读取时明确说明，不能编造结果。';
const syntheticS01 =
  'QA_LIVE-S01：请仅生成Spec，不实施。实施时只新增output/spec-only.txt，UTF-8无BOM，内容严格为SPEC_QA1102_731加一个末尾LF，共16字节。只用文件工具，保留其它文件，不执行命令、不安装依赖、不连接设备。请列出需求及可独立核对的验收标准。';
const originalS02 =
  'QA1102-S02：现在按本对话刚批准的Spec实施并逐项验收。只新增output/spec-only.txt，内容严格为SPEC_QA1102_731加一个末尾LF换行。只用文件工具，保留所有其它文件，不执行任何命令、不安装依赖、不连接设备；读回核对后如实报告。';
const originalAcc2 =
  'QA1102-ACC2：只回复ACCEPT_QA1102_163。禁止调用任何工具，禁止读写文件、运行命令、安装依赖、连接设备或访问外网，不向任何消息渠道发送通知。';
const afterRead = { toolCallsByName: { read: 1 }, totalToolCalls: 1, attempts: 0 };
for (const userText of [
  syntheticS01,
  originalData1,
  originalS02,
  originalAcc2,
  '读取文件，不安装依赖。',
  '只读检查。不要安装依赖。',
  '请勿装依赖。',
  '禁止执行命令、安装依赖、联网。',
  '不执行命令、不安装依赖、不连接设备。',
  '不执行命令、请不要安装依赖。',
  '不要执行命令、不要安装依赖、不要联网。',
  '禁止执行命令和禁止安装依赖。',
  '请勿装依赖或请勿联网。',
  '不要运行npm install。',
  'Do not install dependencies.',
  'Do not install the dependencies.',
  'Do not install deps.',
  'Please do not run npm install.',
  'Do not run commands, install dependencies or access the device.',
  'Do not run commands, do not install dependencies or do not access the device.',
  'Do not run commands, and do not install dependencies.',
  "Do not run commands and don't install dependencies.",
  'Never run commands or never install deps.',
]) {
  assert.equal(
    evaluateInstallToolsNudge({ ...afterRead, userText }).fire,
    false,
    `prohibition is not install authority: ${userText}`
  );
}
for (const userText of [
  '请安装依赖。',
  'Install dependencies.',
  '不要安装依赖，然后安装依赖。',
  '不要安装依赖然后安装依赖。',
  'Do not install dependencies, then run npm install.',
  'Do not install dependencies then run npm install.',
  '不安装依赖，除非我确认。',
  'Do not install dependencies unless I confirm.',
  '不要不安装依赖。',
  'Do not not install dependencies.',
  'Do not never install dependencies.',
  '如果缺失则安装依赖。',
  '不安装依赖，但请运行npm install。',
  '不执行命令、请安装依赖。',
  '不要执行命令、不要不安装依赖。',
  '不执行命令、不安装依赖，除非我确认。',
  'Do not run commands, then install dependencies.',
  'Do not run commands, and please install dependencies.',
  'Do not run commands and do not not install dependencies.',
  'Do not run commands, do not install dependencies unless I confirm.',
]) {
  assert.equal(
    evaluateInstallToolsNudge({ ...afterRead, userText }).fire,
    true,
    `retain real or ambiguous install intent: ${userText}`
  );
}

// No tools yet
{
  const r = evaluateInstallToolsNudge({
    userText: 'install the dependencies with npm install',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Install ask + tools without install exec → fire
{
  const r = evaluateInstallToolsNudge({
    userText: 'install the dependencies with npm install',
    toolCallsByName: { read_file: 1 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'read_file', input: { path: 'package.json' } },
        ],
      },
    ],
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /npm|pnpm|yarn|install/i);
}

// Install exec already present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'i1',
          name: 'exec',
          input: { command: 'npm install' },
        },
      ],
    },
  ];
  const r = evaluateInstallToolsNudge({
    userText: 'install deps',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateInstallToolsNudge({
    userText: 'pnpm install please',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

// Explicit no-install constraints must never become an install instruction.
for (const userText of [
  '创建 slug.mjs，不要安装依赖、访问网络或修改 README。',
  '请修复问题，禁止运行 npm install。',
  'Implement the change; do not install dependencies.',
  "Inspect the code; don't run npm install.",
]) {
  const result = evaluateInstallToolsNudge({
    userText,
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(result.fire, false, userText);
}

// A negative constraint must not hide a separate affirmative installation request.
for (const userText of [
  '不要运行 npm install，而是执行 pnpm install。',
  "Don't run npm install; install the dependencies with pnpm install.",
]) {
  const result = evaluateInstallToolsNudge({
    userText,
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(result.fire, true, userText);
}

console.log('[PASS] install-tools-nudge');
