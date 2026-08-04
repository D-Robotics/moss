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
assert.equal(parseExitCode('Command failed (exit 127): not found'), 127);
assert.equal(parseExitCode('exit_code: 1\nbuild failed'), 1);
assert.equal(parseExitCode('build OK'), null);
assert.equal(parseExitCode('build OK; docs mention exit 9'), null, '不解析任意结果正文里的 exit 文本');
assert.equal(parseExitCode('normal stdout\nDevice command failed (exit 9): quoted text'), null, '不解析 stdout 正文中的失败格式');
assert.equal(parseExitCode('done (exit 0)'), null, '不解析无 Moss 结构化前缀的 exit 文本');
assert.equal(parseExitCode('Device command failed (exit 9): stdout text', false), null, '成功工具的 stdout 即使以失败文本开头也不解析');
assert.equal(parseExitCode('exit_code: 0\ndone', false), 0, '成功工具仍接受结构化退出码');
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
  await callHook(hook, { toolName: 'exec', result: 'exit_code: 0\ndone', isError: false });
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
  await callHook(hook, { toolName: 'exec', result: 'exit_code: 5\nfailed', isError: true });
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
  await callHook(hook, { toolName: 'exec', result: 'exit_code: 0\ndone', isError: false });
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
  const ret = await callHook(hook, { toolName: 'exec', result: 'exit_code: 0\ndone', isError: false });
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

// ─── 11. U7 设备路径走 readonly executor(test -f)而非本地 fs ───────────────
{
  // mock deviceExecutor:模拟板子上的文件存在性
  const deviceFiles = new Set(['/userdata/model.bin']);
  const mockExec = {
    runReadOnly: async (cmd) => {
      const m = /^test -f '([^']+)' && echo yes/.exec(cmd);
      if (!m) return null;
      return deviceFiles.has(m[1]) ? { stdout: 'yes', exitCode: 0 } : { stdout: 'no', exitCode: 1 };
    },
  };
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    deviceExecutor: { current: mockExec },
    genId: () => `exp_dev_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');

  // 设备上存在的文件 → pass
  await callHook(hook, {
    toolName: 'write_file',
    input: { path: '/userdata/model.bin' },
    result: 'wrote',
    isError: false,
  });
  let e = await lastEntry();
  assert.equal(e.verdict, 'pass', '设备上存在的文件 → pass(经 readonly executor)');
  assert.equal(e.signalSource, 'file_exist');

  // 设备上不存在的文件 → fail high
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'write_file',
    input: { path: '/userdata/missing.bin' },
    result: 'wrote',
    isError: false,
  });
  e = await lastEntry();
  assert.equal(e.verdict, 'fail');
  assert.equal(e.reasonCode, 'file_missing_after_write');
  assert.equal(e.confidence, 'high');
}
console.log('✓ U7: 设备绝对路径走 readonly executor(test -f),不碰本地 fs');

// ─── 12. deviceExecutor.current=null 时 fallback 本地 fs ─────────────────────
{
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    deviceExecutor: { current: null }, // 无设备
    genId: () => `exp_local_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  // 本地真实文件(相对 tmp workspaceDir)
  const localFile = path.join(tmp, 'local.txt');
  await fs.writeFile(localFile, 'x');
  await callHook(hook, {
    toolName: 'write_file',
    input: { path: localFile },
    result: 'wrote',
    isError: false,
  });
  const e = await lastEntry();
  assert.equal(e.verdict, 'pass', '无设备时 fallback 本地 fs.access');
  assert.equal(e.signalSource, 'file_exist');
}
console.log('✓ deviceExecutor.current=null → fallback 本地 fs');

// ─── 13. readonly 返回 null(设备断连)视作文件不存在(fail high)────────────
{
  const mockExec = { runReadOnly: async () => null }; // 设备不可达
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    deviceExecutor: { current: mockExec },
    genId: () => `exp_null_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'write_file',
    input: { path: '/userdata/x.bin' },
    result: 'wrote',
    isError: false,
  });
  const e = await lastEntry();
  assert.equal(e.verdict, 'fail', '设备断连 → 文件视作不存在 → fail');
  assert.equal(e.confidence, 'high', '写完却查不到 = 高可信失败');
}
console.log('✓ readonly 返回 null(设备断连)→ fail high');

// ─── 14. 有契约覆盖 exec → 走契约 L1 判定(D4 层1 主判据)─────────────
{
  const { ContractRegistry } = await import('../dist/acceptance/contract-registry.js');
  // 构造一个覆盖 exec 的契约:postconditions = exit_code_zero
  const contract = {
    skillName: 'test-skill',
    sourcePath: 'test',
    expectedTools: ['exec'],
    postconditions: [{ name: 'exit_code_zero', params: {} }],
    version: '1',
  };
  const contractRegistry = new ContractRegistry(new Map([['test-skill', contract]]));
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    contractRegistry,
    deviceExecutor: { current: null },
    genId: () => `exp_contract_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');

  // 契约判定:exec 成功结果不含 exit_code 文本,仍用工具运行时的可信 isError=false → L1 pass
  await callHook(hook, {
    toolName: 'exec',
    result: 'build complete; fixture documentation mentions exit 9',
    isError: false,
  });
  let e = await lastEntry();
  assert.equal(e.verdict, 'pass', '契约 postconditions(exit_code_zero) → L1 pass');
  assert.equal(e.verdictLevel, 'L1', '有契约时 verdictLevel=L1');
  assert.equal(e.diagnostics.contractSkill, 'test-skill');
  assert.equal(e.diagnostics.exitCode, 0, '记录从可信工具状态派生的结构化退出码');

  // 契约判定:exec 失败格式带结构化退出码 → L1 fail
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, { toolName: 'exec', result: 'Command failed (exit 1):\nbuild failed', isError: true });
  e = await lastEntry();
  assert.equal(e.verdict, 'fail');
  assert.equal(e.verdictLevel, 'L1');
  assert.equal(e.reasonCode, 'nonzero_exit');
}
console.log('✓ 有契约(exec)→ 走 postconditions 产 L1 判定');

// ─── 15. 无契约覆盖的工具 → 退回 L2 通用判定 ──────────────────────────────
{
  const { ContractRegistry } = await import('../dist/acceptance/contract-registry.js');
  // 空 registry(无契约)
  const contractRegistry = new ContractRegistry(new Map());
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    contractRegistry,
    deviceExecutor: { current: null },
    genId: () => `exp_nocont_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, { toolName: 'device_exec', result: 'exit_code: 0\ndone', isError: false });
  const e = await lastEntry();
  assert.equal(e.verdict, 'pass');
  assert.equal(e.verdictLevel, 'L2', '无契约 → 退回 L2 通用判定');
}
console.log('✓ 无契约 → 退回 L2 通用判定');

// ─── 16. 多覆盖:device_exec 跑 hb_mapper 命中 rdk-device 契约(端到端)─────────
{
  const { ContractRegistry } = await import('../dist/acceptance/contract-registry.js');
  // 两个契约都覆盖 device_exec,按 command pattern 区分
  const reg = new ContractRegistry(new Map([
    ['rdk-board-knowledge', {
      skillName: 'rdk-board-knowledge', sourcePath: 'bk', expectedTools: ['device_exec'],
      expectedCommandPattern: undefined, // 兜底
      postconditions: [{ name: 'exit_code_zero', params: {} }], version: '1',
    }],
    ['rdk-device', {
      skillName: 'rdk-device', sourcePath: 'dv', expectedTools: ['device_exec'],
      expectedCommandPattern: 'hb_mapper|onnx2bin',
      postconditions: [{ name: 'exit_code_zero', params: {} }], version: '1',
    }],
  ]));
  const hook = createObjectiveVerifierHook({
    experienceLog: log, contractRegistry: reg, deviceExecutor: { current: null },
    genId: () => `exp_mc_${counter++}`, genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');

  // command=hb_mapper → 命中 rdk-device 契约(L1,diagnostics.contractSkill=rdk-device)
  await callHook(hook, {
    toolName: 'device_exec',
    input: { command: 'hb_mapper onnx2bin model.onnx' },
    result: 'exit_code: 0\ndone', isError: false,
  });
  let e = await lastEntry();
  assert.equal(e.verdictLevel, 'L1');
  assert.equal(e.diagnostics.contractSkill, 'rdk-device', 'command=hb_mapper → rdk-device 契约生效');

  // command=xburn → 无 pattern 匹配 → 兜底 rdk-board-knowledge
  counter = 0;
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'device_exec',
    input: { command: 'xburn --flash img.bin' },
    result: 'exit_code: 0\ndone', isError: false,
  });
  e = await lastEntry();
  assert.equal(e.diagnostics.contractSkill, 'rdk-board-knowledge', 'command=xburn → 兜底 board-knowledge');
}
console.log('✓ 多覆盖端到端: device_exec 按 command 命中不同契约(rdk-device / 兜底 board-knowledge)');

// ─── 17. 解 A:有 plan + step.expectedAccept → 按 skill 名查契约(优先于解 C)──────
{
  const { ContractRegistry } = await import('../dist/acceptance/contract-registry.js');
  // 两个契约:rdk-device(覆盖 device_exec,pattern hb_mapper)+ rdk-ros(覆盖 device_exec,pattern ros2)
  const reg = new ContractRegistry(new Map([
    ['rdk-device', {
      skillName: 'rdk-device', sourcePath: 'dv', expectedTools: ['device_exec'],
      expectedCommandPattern: 'hb_mapper',
      postconditions: [{ name: 'exit_code_zero', params: {} }], version: '1',
    }],
    ['rdk-ros', {
      skillName: 'rdk-ros', sourcePath: 'rs', expectedTools: ['device_exec'],
      expectedCommandPattern: 'ros2',
      postconditions: [{ name: 'exit_code_zero', params: {} }], version: '1',
    }],
  ]));
  // mock plan:currentStep=2,该 step.expectedAccept=['rdk-ros']
  // 关键:command=hb_mapper(按解 C 该命中 rdk-device),但解 A 优先 → 命中 rdk-ros
  const mockPlan = {
    id: 'p1', goal: 'g', status: 'executing', version: 1,
    steps: [
      { step: 1, description: 's1', status: 'completed' },
      { step: 2, description: 's2', status: 'in_progress', expectedAccept: ['rdk-ros'] },
    ],
    currentStep: 2,
    createdAt: '', updatedAt: '',
  };
  const planProvider = { get: () => mockPlan };
  const hook = createObjectiveVerifierHook({
    experienceLog: log, contractRegistry: reg, planProvider,
    deviceExecutor: { current: null },
    genId: () => `exp_plan_${counter++}`, genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');

  // command=hb_mapper 但 step.expectedAccept=rdk-ros → 解 A 优先,命中 rdk-ros
  await callHook(hook, {
    toolName: 'device_exec',
    input: { command: 'hb_mapper onnx2bin' },
    result: 'exit_code: 0\ndone', isError: false,
    ctx: { runId: 'run-plan', toolCallId: 'tool-plan' },
  });
  const e = await lastEntry();
  assert.equal(e.verdictLevel, 'L1');
  assert.equal(e.diagnostics.contractSkill, 'rdk-ros', '解 A 优先:step.expectedAccept=rdk-ros 胜过解 C 的 hb_mapper→rdk-device');
  assert.equal(e.diagnostics.planStep, 2, 'diagnostics 记录 planStep');
  assert.equal(e.schemaVersion, 2);
  assert.equal(e.taskId, 'p1');
  assert.equal(e.runId, 'run-plan');
  assert.equal(e.stepId, 'p1:step:2');
  assert.equal(e.toolCallId, 'tool-plan');
  assert.equal(e.attemptId, 'run-plan:tool-plan');
  assert.equal(e.evidenceId, 'tool-plan');
  assert.equal(e.contractSkill, 'rdk-ros');
  assert.equal(e.contractVersion, '1');
  assert.match(e.environmentFingerprint, /^sha256:/);
}
console.log('✓ 解 A: 有 plan + step.expectedAccept → 按 skill 名查契约(优先于解 C)');

// ─── 18. 有 plan 但 step 无 expectedAccept → 退回解 C(tool+command)────────────
{
  const { ContractRegistry } = await import('../dist/acceptance/contract-registry.js');
  const reg = new ContractRegistry(new Map([
    ['rdk-device', {
      skillName: 'rdk-device', sourcePath: 'dv', expectedTools: ['device_exec'],
      expectedCommandPattern: 'hb_mapper',
      postconditions: [{ name: 'exit_code_zero', params: {} }], version: '1',
    }],
  ]));
  // plan 有,但 currentStep 无 expectedAccept
  const mockPlan = {
    id: 'p2', goal: 'g', status: 'executing', version: 1,
    steps: [{ step: 1, description: 's1', status: 'in_progress' }], // 无 expectedAccept
    currentStep: 1, createdAt: '', updatedAt: '',
  };
  const hook = createObjectiveVerifierHook({
    experienceLog: log, contractRegistry: reg, planProvider: { get: () => mockPlan },
    deviceExecutor: { current: null },
    genId: () => `exp_nostep_${counter++}`, genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'device_exec',
    input: { command: 'hb_mapper onnx2bin' },
    result: 'exit_code: 0\ndone', isError: false,
  });
  const e = await lastEntry();
  assert.equal(e.diagnostics.contractSkill, 'rdk-device', 'step 无 expectedAccept → 退回解 C(hb_mapper→rdk-device)');
}
console.log('✓ 有 plan 但 step 无 expectedAccept → 退回解 C');

// Board mode transparently routes the public `exec` tool over SSH. The
// trusted ToolContext domain must therefore override name-based inference.
{
  let observedMode;
  const hook = createObjectiveVerifierHook({
    experienceLog: log,
    environmentIdentityProvider: (_sessionKey, runtimeMode) => {
      observedMode = runtimeMode;
      return {
        schemaVersion: 1,
        fingerprint: 'sha256:v1:real-board',
        completeness: 'complete',
        runtimeMode,
        reasonCode: 'complete',
      };
    },
    genId: () => `exp_board_exec_${counter++}`,
    genTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await callHook(hook, {
    toolName: 'exec',
    input: { command: 'uname -m' },
    result: 'exit_code: 0\naarch64',
    ctx: { executionDomain: 'real', runId: 'run-board', toolCallId: 'tool-board' },
  });
  const e = await lastEntry();
  assert.equal(observedMode, 'device');
  assert.equal(e.executionDomain, 'real');
  assert.equal(e.realEvidenceEligible, true);
  assert.equal(e.environmentFingerprint, 'sha256:v1:real-board');
}
console.log('ok board-routed exec preserves real-device trust boundary');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ objective-verifier-hook T1.1+U7+T3.1 全部通过(18/18)');
