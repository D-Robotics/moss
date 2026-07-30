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
  let r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, exitCode: 0 });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.confidence, 'medium');

  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, exitCode: 1 });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'nonzero_exit');

  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_exit_code');

  r = await evaluatePredicate({ name: 'exit_code_zero', params: {} }, { ...baseInput, result: 'done (exit 0)' });
  assert.equal(r.verdict, 'unknown', 'exit code is never parsed from result text');
}
console.log('✓ exit_code_zero: structured 0→pass / 非零→fail / 无结构化退出码→unknown');

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

// ─── 5. 几何谓词实现见 5b/5c/5d/5e(force_below/pose/joint/video_fps)────────

// ─── 5b. force_below(current source)实现:读电机电流比阈值 ─────────────────
// 假只读执行器(按 readCommand 内容路由,模拟不同传感器读数)
const fakeDev = {
  async runReadOnly(command) {
    if (command.includes('no-match')) return { stdout: 'no number here', exitCode: 0 };
    if (command.includes('unreachable')) return null;
    if (command.includes('/pose')) return { stdout: 'error = 12.3 mm', exitCode: 0 };
    if (command.includes('/joint')) return { stdout: 'angle = 12.3 deg', exitCode: 0 };
    if (command.includes('/fps')) return { stdout: 'fps = 30', exitCode: 0 };
    return { stdout: 'motor current = 12.3 A', exitCode: 0 };
  },
};
{
  // 无 readCommand → unknown(不猜怎么读)
  let r = await evaluatePredicate({ name: 'force_below', params: { threshold_n: 50, source: 'current' } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_read_command');

  // 有 readCommand 但无 device → unknown
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 50, source: 'current', readCommand: 'cat /sys/x', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: null },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_device');

  // 有设备 + 电流 12.3 < 50 → pass
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 50, source: 'current', readCommand: 'cat /sys/x', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'force_below_threshold');
  assert.equal(r.evidence.current, 12.3);
  assert.equal(r.evidence.threshold_n, 50);

  // 电流 12.3 >= 10 → fail
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 10, source: 'current', readCommand: 'cat /sys/x', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'force_exceeds_threshold');

  // 设备返回 null → unknown
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 50, source: 'current', readCommand: 'unreachable', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'device_unreachable');

  // stdout 不匹配正则 → unknown(没测到电流,不猜)
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 50, source: 'current', readCommand: 'no-match', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'current_not_parsed');

  // force_sensor source 未实现 → unknown
  r = await evaluatePredicate(
    { name: 'force_below', params: { threshold_n: 50, source: 'force_sensor', readCommand: 'cat /sys/x', currentRegex: 'current = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'force_sensor_not_implemented');
}
console.log('✓ force_below(current):无 readCommand/无设备/返回 null/不匹配→unknown;电流比阈值 pass/fail');

// ─── 5c. pose_error_within(位姿误差比阈值,source=camera|encoder 跨信号对)────
{
  // 无 readCommand → unknown
  let r = await evaluatePredicate({ name: 'pose_error_within', params: { threshold_mm: 10, source: 'camera' } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_read_command');

  // 有设备 + 误差 12.3 < 15 → pass(camera 源)
  r = await evaluatePredicate(
    { name: 'pose_error_within', params: { threshold_mm: 15, source: 'camera', readCommand: 'cat /sys/pose', valueRegex: 'error = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'pose_within_threshold');
  assert.equal(r.evidence.measuredError, 12.3);

  // 误差 12.3 >= 10 → fail
  r = await evaluatePredicate(
    { name: 'pose_error_within', params: { threshold_mm: 10, source: 'encoder', readCommand: 'cat /sys/pose', valueRegex: 'error = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'pose_exceeds_threshold');

  // 无设备 → unknown
  r = await evaluatePredicate(
    { name: 'pose_error_within', params: { threshold_mm: 10, source: 'camera', readCommand: 'cat /sys/pose', valueRegex: 'error = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: null },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_device');

  // 不匹配 → unknown
  r = await evaluatePredicate(
    { name: 'pose_error_within', params: { threshold_mm: 10, source: 'camera', readCommand: 'no-match', valueRegex: 'error = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'value_not_parsed');
}
console.log('✓ pose_error_within:无 readCommand/无设备/不匹配→unknown;误差比阈值 pass/fail');

// ─── 5d. joint_at(关节角达目标,|val-target|<=tolerance)──────────────────────
{
  // 无 target → unknown
  let r = await evaluatePredicate({ name: 'joint_at', params: { readCommand: 'cat /sys/joint', valueRegex: 'angle = ([\\d.]+)' } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_target');

  // 角度 12.3,target 12,tol 2 → |0.3|<=2 → pass
  r = await evaluatePredicate(
    { name: 'joint_at', params: { target: 12, tolerance: 2, readCommand: 'cat /sys/joint', valueRegex: 'angle = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'joint_at_target');

  // 角度 12.3,target 90,tol 2 → |12.3-90|>2 → fail
  r = await evaluatePredicate(
    { name: 'joint_at', params: { target: 90, tolerance: 2, readCommand: 'cat /sys/joint', valueRegex: 'angle = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'joint_off_target');

  // 无 readCommand → unknown
  r = await evaluatePredicate({ name: 'joint_at', params: { target: 12, tolerance: 2 } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_read_command');

  // 无设备 → unknown
  r = await evaluatePredicate(
    { name: 'joint_at', params: { target: 12, tolerance: 2, readCommand: 'cat /sys/joint', valueRegex: 'angle = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: null },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_device');
}
console.log('✓ joint_at:无 target/readCommand/设备→unknown;|val-target|<=tol pass/fail');

// ─── 5e. video_fps_above(视频帧率超阈值,fps >= threshold_fps)──────────────
{
  // 无 threshold_fps → unknown
  let r = await evaluatePredicate({ name: 'video_fps_above', params: { readCommand: 'cat /sys/fps', valueRegex: 'fps = ([\\d.]+)' } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_threshold_fps');

  // fps 30 >= 15 → pass
  r = await evaluatePredicate(
    { name: 'video_fps_above', params: { threshold_fps: 15, readCommand: 'cat /sys/fps', valueRegex: 'fps = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'fps_above_threshold');
  assert.equal(r.evidence.fps, 30);

  // fps 30 < 35 → fail
  r = await evaluatePredicate(
    { name: 'video_fps_above', params: { threshold_fps: 35, readCommand: 'cat /sys/fps', valueRegex: 'fps = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasonCode, 'fps_below_threshold');

  // 无 readCommand → unknown
  r = await evaluatePredicate({ name: 'video_fps_above', params: { threshold_fps: 15 } }, baseInput);
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_read_command');

  // 无设备 → unknown
  r = await evaluatePredicate(
    { name: 'video_fps_above', params: { threshold_fps: 15, readCommand: 'cat /sys/fps', valueRegex: 'fps = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: null },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'no_device');

  // 不匹配 → unknown
  r = await evaluatePredicate(
    { name: 'video_fps_above', params: { threshold_fps: 15, readCommand: 'no-match', valueRegex: 'fps = ([\\d.]+)' } },
    { ...baseInput, deviceExecutor: fakeDev },
  );
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reasonCode, 'value_not_parsed');
}
console.log('✓ video_fps_above:无 threshold_fps/readCommand/设备/不匹配→unknown;fps>=阈值 pass/fail');

// ─── 6. evaluatePostconditions 聚合(AND 语义)───────────────────────────────
{
  const file = path.join(tmp, 'pc.txt');
  await fs.writeFile(file, 'x');
  const specs = [
    { name: 'exit_code_zero', params: {} },
    { name: 'file_exist', params: { path: file } },
  ];
  // 全 pass → pass
  let r = await evaluatePostconditions(specs, { ...baseInput, exitCode: 0 });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.reasonCode, 'all_postconditions_met');

  // 任一 fail → fail(AND)
  r = await evaluatePostconditions(specs, { ...baseInput, exitCode: 1 });
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
