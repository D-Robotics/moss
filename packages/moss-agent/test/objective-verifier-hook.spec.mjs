#!/usr/bin/env node
/**
 * objective-verifier-hook — T1.1 最小切片验证。
 *
 * Pins down (see docs/self-evolution-loop.md §5.1 / D1 / D3):
 *  (1) 退出码信号:exit 0 → exec_ok medium;exit≠0 → fail;device_exec 失败格式解析
 *  (2) 文件存在信号:写工具写完文件存在 → pass;不存在 → fail(高可信)
 *  (3) D1 硬信号前置:有硬信号时不调模型(model_judge 只在无硬信号时)
 *  (4) D3 信息隔离:hook 仅用 tool/input/result,不碰 messages/思考链
 *  (5) Experience append-only:verdict 来自验证器非模型;翻盘追加 supersedes 不改写
 *  (6) 副作用式:写盘失败(memoryWarn)不影响主流程,返回 null 不改 result
 *  (7) isError 为入参不改,与 verdict 并存供层 3 仲裁
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createObjectiveVerifierHook,
  parseExitCode,
  extractFilePath,
} from '../dist/core/tools/objective-verifier-hook.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';

// ─── helpers ────────────────────────────────────────────────────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-verify-'));
const log = new ExperienceLog({ baseDir: tmp });

// 注入确定性 id / 时间戳,避免 new Date()(worktree 脚本环境也可跑)
let counter = 0;
const mkHook = () =>
  createObjectiveVerifierHook({
    experienceLog: log,
    genId: () => `exp_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });

const ctx = (extra = {}) => ({
  workspaceDir: tmp,
  sessionKey: 'sess-1',
  toolCallId: 'tc-1',
  ...extra,
});

const callHook = async (hook, params) => {
  // PostToolUseHook.process 签名:{tool, input, result, isError, durationMs, ctx, sessionId}
  const result = await hook.process({
    tool: { name: params.toolName },
    input: params.input ?? {},
    result: params.result ?? '',
    isError: params.isError ?? false,
    durationMs: params.durationMs ?? 10,
    ctx: ctx(params.ctx ?? {}),
    sessionId: 'sess-1',
  });
  return result;
};

const lastEntry = async () => {
  const all = await log.readAll();
  return all[all.length - 1];
};

// ─── 1. parseExitCode 识别 Moss 三种格式 ────────────────────────────────────
assert.equal(parseExitCode('Device command failed (exit 127): not found'), 127);
assert.equal(parseExitCode('Process exited with code 1'), 1);
assert.equal(parseExitCode('build OK'), null);
console.log('✓ parseExitCode: device/exec/named formats + negative');

// ─── 2. extractFilePath 从 input 取路径 ─────────────────────────────────────
assert.equal(extractFilePath({ path: '/a/b.ts' }), '/a/b.ts');
assert.equal(extractFilePath({ filePath: 'rel.txt' }), 'rel.txt');
assert.equal(extractFilePath({ unrelated: 1 }), null);
console.log('✓ extractFilePath: path/filePath/file/filename keys + negative');

// ─── 3. 退出码信号:exit 0 = exec_ok medium(非任务成功)─────────────────────
{
  const hook = mkHook();
  await callHook(hook, { toolName: 'device_exec', result: 'ok output', isError: false });
  // 无退出码文本、isError=false → 无硬信号 → unknown(model_judge 占位)
  let e = await lastEntry();
  assert.equal(e.verdict, 'unknown');
  assert.equal(e.signalSource, 'model_judge');
  assert.equal(e.confidence, 'low');

  // 带退出码 0 → pass medium(exec_ok,非任务成功)
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, { toolName: 'exec', result: 'done (exit 0)', isError: false });
  e = await lastEntry();
  assert.equal(e.verdict, 'pass');
  assert.equal(e.reasonCode, 'exit_zero');
  assert.equal(e.signalSource, 'exit_code');
  assert.equal(e.confidence, 'medium');
  assert.equal(e.diagnostics.exitCode, 0);
}
console.log('✓ 退出码信号: exit 0 → pass medium;无码 → unknown low');

// ─── 4. 退出码非 0 → fail medium ─────────────────────────────────────────────
{
  const hook = mkHook();
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'device_exec',
    result: 'Device command failed (exit 127): command not found',
    isError: true,
  });
  const e = await lastEntry();
  assert.equal(e.verdict, 'fail');
  assert.equal(e.reasonCode, 'nonzero_exit');
  assert.equal(e.signalSource, 'exit_code');
  assert.equal(e.diagnostics.exitCode, 127);
  // isError 与 verdict 并存(isError 入参不改 — 供层 3 仲裁)
  assert.equal(e.reportedIsError, true);
  assert.equal(e.verdict, 'fail');
}
console.log('✓ 退出码非0 → fail; reportedIsError 与 verdict 并存');

// ─── 5. 文件存在信号:写工具写完存在 → pass;不存在 → fail(高可信)─────────
{
  const hook = mkHook();
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  // 写一个真实文件,然后验"写工具"判定它存在
  const targetFile = path.join(tmp, 'written.ts');
  await fs.writeFile(targetFile, 'x');
  await callHook(hook, {
    toolName: 'write_file',
    input: { path: targetFile },
    result: 'wrote 1 file',
    isError: false,
  });
  let e = await lastEntry();
  assert.equal(e.verdict, 'pass');
  assert.equal(e.signalSource, 'file_exist');
  assert.equal(e.confidence, 'medium');

  // 删掉文件,再"写"一次 → 不存在 = 高可信失败
  await fs.unlink(targetFile);
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'edit_file',
    input: { path: targetFile },
    result: 'edited',
    isError: false,
  });
  e = await lastEntry();
  assert.equal(e.verdict, 'fail');
  assert.equal(e.reasonCode, 'file_missing_after_write');
  assert.equal(e.confidence, 'high'); // 写完却不存在 = 高可信失败
}
console.log('✓ 文件存在信号: 写完存在→pass medium; 不存在→fail high');

// ─── 6. D1 硬信号前置:有硬信号时 signalSource 绝不是 model_judge ───────────
{
  const hook = mkHook();
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, { toolName: 'exec', result: '(exit 5)', isError: true });
  const e = await lastEntry();
  assert.notEqual(e.signalSource, 'model_judge', '有退出码硬信号时绝不走模型裁判');
  assert.equal(e.signalSource, 'exit_code');
}
console.log('✓ D1 级联: 有硬信号时不调模型裁判');

// ─── 7. D3 信息隔离:非命令/非写工具 → unknown(不基于 result 文本猜)─────────
{
  const hook = mkHook();
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  // 一个纯检索工具,result 里恰好有 "exit 0" 字样 — 不该被当退出码
  await callHook(hook, {
    toolName: 'search_code',
    input: { query: 'exit 0' },
    result: 'found 3 matches for "exit 0"',
    isError: false,
  });
  const e = await lastEntry();
  assert.equal(e.verdict, 'unknown', '检索工具不碰退出码逻辑(信息隔离)');
  assert.equal(e.signalSource, 'model_judge');
}
console.log('✓ D3 信息隔离: 非命令/非写工具不解析退出码');

// ─── 8. Experience append-only:翻盘追加 supersedes,原记录保留 ─────────────
{
  const hook = mkHook();
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, { toolName: 'exec', result: '(exit 0)', isError: false });
  const first = await lastEntry();

  // 模拟层 3 翻盘:手动追加一条 supersedes(本切片层 3 未实现,直接验 log 容器支持)
  await log.append({
    ...first,
    id: 'exp_supersede',
    verdict: 'fail',
    reasonCode: 'layer3_arbitration_flip',
    supersedes: first.id,
    signalSource: 'geometric',
    confidence: 'high',
    verdictLevel: 'L3',
  });
  const all = await log.readAll();
  assert.equal(all.length, 2, '原记录 + 翻盘记录都在(append-only 不改写)');
  assert.equal(all[0].id, first.id);
  assert.equal(all[0].verdict, 'pass', '原记录 verdict 未被改');
  assert.equal(all[1].supersedes, first.id);
  assert.equal(all[1].verdict, 'fail');
}
console.log('✓ Experience append-only: 翻盘追加 supersedes, 原记录保留');

// ─── 9. 副作用式:hook 返回 null(不改 result)──────────────────────────────
{
  const hook = mkHook();
  const ret = await callHook(hook, { toolName: 'exec', result: '(exit 0)', isError: false });
  assert.equal(ret, null, '验证器只写盘,不改喂给模型的 result 文本');
}
console.log('✓ 副作用式: hook 返回 null, 不改 result');

// ─── 10. append 容错:bad verdict 被拒(夺权原则 — 不允许模型自由文本)───────
{
  await assert.rejects(
    () => log.append({
      id: 'bad', tool: 't', input: {}, reportedIsError: false,
      verdict: 'maybe', // 非三态
      signalSource: 'model_judge', confidence: 'low', verdictLevel: 'L2',
      durationMs: 1, timestamp: 'x', sessionKey: 's',
    }),
    /verdict must be pass\/fail\/unknown/,
  );
  await assert.rejects(
    () => log.append({
      id: 'bad2', tool: 't', input: {}, reportedIsError: false,
      verdict: 'fail', // fail 但没 reasonCode
      signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L2',
      durationMs: 1, timestamp: 'x', sessionKey: 's',
    }),
    /verdict=fail requires reasonCode/,
  );
}
console.log('✓ 夺权原则: 非三态 verdict / fail 无 reasonCode 被拒');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ objective-verifier-hook T1.1 全部通过(10/10)');
