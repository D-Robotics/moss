#!/usr/bin/env node
/**
 * predicate-evaluator — T3.1 谓词执行器验证。
 * 各谓词的判定 + 几何谓词返回 unknown(本切片未实现,不猜)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { evaluatePredicate, evaluatePostconditions } from '../dist/acceptance/predicate-evaluator.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-pred-'));
const baseInput = {
  result: '',
  reportedIsError: false,
  input: {},
  workspaceDir: tmp,
  deviceExecutor: null,
};

// ─── 1. exit_code_zero ──────────────────────────────────────────────────────
{
  let r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, result: 'done (exit 0)' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.confidence, 'medium');

  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, result: '(exit 1)', reportedIsError: true });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'nonzero_exit');

  // 解析不出退出码 + isError=false → pass low(视作执行层正常)
  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, result: 'no exit code here' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.confidence, 'low');

  // 解析不出 + isError=true → unknown(不自证)
  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, result: 'err', reportedIsError: true });
  assert.equal(r.verdict, 'unknown');
}
console.log('✓ exit_code_zero: 0→pass / 非零→fail / 无码无err→pass low / 无码有err→unknown');

// ─── 2. file_exist(本地 fallback)─────────────────────────────────────────────
{
  const file = path.join(tmp, 'exists.txt');
  await fs.writeFile(file, 'x');
  let r = await evaluatePredicate({ name: 'file_exist', params: { path: file } }, baseInput);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.confidence, 'medium');

  r = await evaluatePredicate({ name: 'file_exist', params: { path: path.join(tmp, 'nope.txt') } }, baseInput);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.confidence, 'high', '文件不存在 = 高可信失败');
}
console.log('✓ file_exist: 存在→pass / 不存在→fail high');

// ─── 3. stdout_matches ─────────────────────────────────────────────────────
{
  let r = await evaluatePredicate({ name: 'stdout_matches', params: { pattern: 'model.*bin' } }, { ...baseInput, result: 'model.bin loaded' });
  assert.equal(r.verdict, 'pass');

  r = await evaluatePredicate({ name: 'stdout_matches', params: { pattern: 'model.*bin' } }, { ...baseInput, result: 'no match here' });
  assert.equal(r.verdict, 'fail');

  r = await evaluatePredicate({ name: 'stdout_matches', params: { pattern: '(' } }, baseInput); // 坏正则
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'bad_regex');
}
console.log('✓ stdout_matches: 匹配→pass / 不匹配→fail / 坏正则→unknown');

// ─── 4. process_running(需设备,无设备→unknown)─────────────────────────────
{
  const r = await evaluatePredicate({ name: 'process_running', params: { pattern: 'hbmitools' } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_device');
}
console.log('✓ process_running: 无设备→unknown(不猜)');

// ─── 5. 几何谓词本切片返回 unknown(待设备信号接入)─────────────────────────
for (const name of ['pose_error_within', 'force_below', 'joint_at', 'video_fps_above']) {
  const r = await evaluatePredicate({ name, params: { threshold_mm: 5 } }, baseInput);
  assert.equal(r.verdict, 'unknown', `${name} 本切片 unknown`);
  assert.equal(r.reasonCode, 'geometric_predicate_not_implemented');
}
console.log('✓ 几何谓词(pose/force/joint/fps)本切片 unknown,不猜');

// ─── 6. evaluatePostconditions 聚合(AND 语义)───────────────────────────────
{
  const file = path.join(tmp, 'pc.txt');
  await fs.writeFile(file, 'x');
  const specs = [
    { name: 'exit_code_zero', params: {} },
    { name: 'file_exist', params: { path: file } },
  ];
  // 全 pass → pass
  let r = await evaluatePostconditions(specs, { ...baseInput, result: '(exit 0)' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'all_postconditions_met');

  // 任一 fail → fail(AND)
  r = await evaluatePostconditions(specs, { ...baseInput, result: '(exit 1)', reportedIsError: true });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'nonzero_exit');

  // 有 unknown 无 fail → unknown(不武断 pass)
  r = await evaluatePostconditions(
    [{ name: 'exit_code_zero', params: {} }, { name: 'force_below', params: { threshold_n: 5 } }],
    { ...baseInput, result: '(exit 0)' },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'partial_unknown');
}
console.log('✓ evaluatePostconditions: AND 语义(任一fail→fail,有unknown→unknown,全pass→pass)');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ predicate-evaluator T3.1 全部通过(6/6)');
