#!/usr/bin/env node
/**
 * realboard-contract-regression — 真机(RDK X5)端到端契约验证回归。
 *
 * 用真机实跑抓取的 stdout fixture(BPU yolov5 推理 kite.jpg)验证契约谓词判定:
 *  - exit_code_zero: 真机 EXIT=0 → pass
 *  - stdout_matches: 真机输出含 bbox/score/name → pass(契约 pattern 含这些词)
 *  - 命令路由: python3 /app/pydev_demo/07_yolov5_sample/test_yolov5.py → rdk-model-zoo 契约
 *
 * 这是自进化真机端到端的第一条真实数据回归(非离线 fixture 想象):
 * 2026-07-29 在 RDK X5 (192.168.127.10) 跑 /app/pydev_demo/07_yolov5_sample/test_yolov5.py,
 * BPU 平台 1.3.6 soc info(x5),加载 yolov5 模型,输出 bbox/score/name kite+person,EXIT=0。
 */
import assert from 'node:assert/strict';
import { evaluatePredicate } from '../dist/acceptance/predicate-evaluator.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { SkillRegistry } from '../dist/skills/registry.js';

// 真机实跑的真实 stdout(从 SSH 抓取,2026-07-29 RDK X5)
const REAL_STDOUT = `[BPU_PLAT]BPU Platform Version(1.3.6)! soc info(x5)
[HBRT] set log level as 0. version = 3.15.55.0
[DNN] Runtime version = 1.24.5_(3.15.55 HBRT)
tensor type: NV12
data type: uint8
layout: NCHW
shape: (1, 3, 672, 672)
bbox: [593.949768, 80.819038, 672.215027, 147.131607], score: 0.856997, id: 33, name: kite
bbox: [215.716019, 696.537476, 273.653442, 855.298706], score: 0.852251, id: 0, name: person
bbox: [278.934448, 236.631256, 305.838867, 281.294922], score: 0.834647, id: 33, name: kite`;

// 真机实跑的真实命令
const REAL_COMMAND = 'python3 /app/pydev_demo/07_yolov5_sample/test_yolov5.py';

const reg = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: process.cwd() }).list());

// ─── 1. 真机命令命中 rdk-model-zoo 契约(经 expectedCommandPattern pydev_demo/yolov) ──
const hit = reg.findByTool('device_exec', { command: REAL_COMMAND });
assert.ok(hit, '真机命令应命中某契约');
assert.equal(hit.skillName, 'rdk-model-zoo', `真机命令应命中 rdk-model-zoo,实际=${hit.skillName}`);
console.log('✓ 真机命令命中 rdk-model-zoo 契约(expectedCommandPattern pydev_demo/yolov 锚定)');

// ─── 2. 该契约的 stdout_matches 谓词对真机输出判 pass ────────────────────────
const stdoutSpec = hit.postconditions.find((p) => p.name === 'stdout_matches');
assert.ok(stdoutSpec, 'rdk-model-zoo 契约应有 stdout_matches postcondition');
const r = await evaluatePredicate(stdoutSpec, {
  result: REAL_STDOUT,
  reportedIsError: false,
  input: {},
  workspaceDir: process.cwd(),
  deviceExecutor: null,
});
assert.equal(r.verdict, 'pass', `真机输出应判 pass(含 bbox/score/name),实际=${r.verdict} reason=${r.reasonCode}`);
console.log('✓ stdout_matches 谓词对真机 BPU 输出判 pass(bbox/score/name 命中)');

// ─── 3. exit_code_zero 谓词对真机 EXIT=0 判 pass ────────────────────────────
const exitSpec = hit.postconditions.find((p) => p.name === 'exit_code_zero');
assert.ok(exitSpec);
const re = await evaluatePredicate(exitSpec, {
  result: 'done; documentation mentions exit 9',
  exitCode: 0, // 真机工具运行时提供的结构化退出码
  reportedIsError: false,
  input: {},
  workspaceDir: process.cwd(),
  deviceExecutor: null,
});
assert.equal(re.verdict, 'pass', `真机 EXIT=0 应判 pass,实际=${re.verdict}`);

const untrustedText = await evaluatePredicate(exitSpec, {
  result: 'done (exit 0)',
  reportedIsError: false,
  input: {},
  workspaceDir: process.cwd(),
  deviceExecutor: null,
});
assert.equal(untrustedText.verdict, 'unknown', '自由文本里的 exit 0 不能冒充可信工具退出码');
console.log('✓ exit_code_zero 仅信任真机工具的结构化 EXIT=0');

console.log('\n✅ realboard-contract-regression: 真机 RDK X5 BPU yolov5 端到端契约验证通过(命令路由 + exit + stdout 三层)');
