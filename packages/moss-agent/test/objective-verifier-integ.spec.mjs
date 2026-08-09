#!/usr/bin/env node
/**
 * objective-verifier integration — 验证 hook 经真实 ToolHookRegistry 调用链落盘。
 *
 * 这是 T1.1 的地基验证(比单测更接近真实):不直接调 hook.process,
 * 而是用 ToolHookRegistry.registerPost + runPostHooks(= execute-tool-call.ts:615
 * 的真实路径),确认:
 *  (1) hook 真被 registry 调用(不是单测里直接 process)
 *  (2) experiences.jsonl 真写到磁盘(端到端落盘)
 *  (3) runPostHooks 返回原 result 文本未改(副作用式)
 *  (4) hook 异常被 registry catch 不中断(工具层容错)
 * 不需 LLM、不需板子(纯 dist + 临时 dir)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolHookRegistry } from '../dist/core/tools/tool-hooks.js';
import { createObjectiveVerifierHook } from '../dist/core/tools/objective-verifier-hook.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verify-integ-'));
const log = new ExperienceLog({ baseDir: tmp });

// 真实 registry(= MossAgent 内部 this.toolHooks)
const registry = new ToolHookRegistry();
let counter = 0;
registry.registerPost(
  createObjectiveVerifierHook({
    experienceLog: log,
    deviceExecutor: { current: null }, // 无设备,fallback 本地
    genId: () => `integ_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  })
);

// 真实 ToolContext(= execute-tool-call 传给 runPostHooks 的那个)
const ctx = {
  workspaceDir: tmp,
  sessionKey: 'integ-sess',
  toolCallId: 'integ-tc-1',
  abortSignal: new AbortController().signal,
};

// ─── 1. 退出码经真实链落盘 ──────────────────────────────────────────────────
{
  const ret = await registry.runPostHooks({
    tool: { name: 'device_exec' },
    input: { command: 'ls' },
    result: 'Device command failed (exit 127): not found',
    isError: true,
    durationMs: 42,
    ctx,
    sessionId: 'integ-sess',
  });
  // 副作用式:返回原 result 未改
  assert.equal(ret, 'Device command failed (exit 127): not found');

  const all = await log.readAll();
  assert.equal(all.length, 1, 'experiences.jsonl 真落盘了 1 条');
  const e = all[0];
  assert.equal(e.verdict, 'fail');
  assert.equal(e.signalSource, 'exit_code');
  assert.equal(e.diagnostics.exitCode, 127);
  assert.equal(e.reportedIsError, true);
}
console.log('✓ 真实 registry.runPostHooks 链:device_exec 失败 → experiences.jsonl 落盘');

// ─── 2. 写工具经真实链落盘(本地文件)───────────────────────────────────────
{
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  const targetFile = path.join(tmp, 'wrote.txt');
  await fs.writeFile(targetFile, 'content');

  await registry.runPostHooks({
    tool: { name: 'write_file' },
    input: { path: targetFile },
    result: 'wrote 1 file',
    isError: false,
    durationMs: 5,
    ctx,
    sessionId: 'integ-sess',
  });
  const all = await log.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].verdict, 'pass');
  assert.equal(all[0].signalSource, 'file_exist');
}
console.log('✓ 真实链:write_file 落盘 → file_exist pass');

// ─── 3. hook 异常被 registry catch 不中断(工具层容错)──────────────────────
//    注册一个会抛的 hook + 我的 hook,确认我的 hook 不被坏 hook 影响
{
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  const registry2 = new ToolHookRegistry();
  // 先注册一个会抛的坏 hook
  registry2.registerPost({
    name: 'bad-hook',
    priority: 10,
    async process() {
      throw new Error('bad hook explodes');
    },
  });
  registry2.registerPost(
    createObjectiveVerifierHook({
      experienceLog: log,
      deviceExecutor: { current: null },
      genId: () => `integ_throw_${counter++}`,
      genTimestamp: () => '2026-07-28T00:00:00.000Z',
    })
  );

  // 坏 hook 抛了,但 runPostHooks 应 catch 并继续(我的 hook 仍跑、仍落盘)
  const ret = await registry2.runPostHooks({
    tool: { name: 'exec' },
    input: {},
    result: 'exit_code: 0\ndone',
    isError: false,
    durationMs: 1,
    ctx,
    sessionId: 'integ-sess',
  });
  assert.equal(ret, 'exit_code: 0\ndone', '坏 hook 不污染返回值');
  const all = await log.readAll();
  assert.equal(all.length, 1, '我的 hook 仍落盘(坏 hook 被 catch)');
  assert.equal(all[0].verdict, 'pass');
}
console.log('✓ 工具层容错: 坏 hook 抛错被 registry catch, 我的 hook 不受影响');

// ─── 4. 多次调用累积 append(append-only)──────────────────────────────────
{
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  for (let i = 0; i < 5; i++) {
    await registry.runPostHooks({
      tool: { name: 'exec' },
      input: {},
      result: i % 2 === 0 ? 'exit_code: 0\ndone' : 'Device command failed (exit 1): failed',
      isError: i % 2 === 1,
      durationMs: i,
      ctx,
      sessionId: 'integ-sess',
    });
  }
  const all = await log.readAll();
  assert.equal(all.length, 5, '5 次调用累积 5 条(append-only 不覆盖)');
  assert.deepEqual(
    all.map((e) => e.verdict),
    ['pass', 'fail', 'pass', 'fail', 'pass']
  );
}
console.log('✓ 多次调用累积 append: 5 条按序保留');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ objective-verifier 集成测试全部通过(4/4)— 地基验证 OK');
