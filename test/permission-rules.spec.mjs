#!/usr/bin/env node
/**
 * v0.26 W2a 规则引擎（T03）—— 解析/匹配/合并/优先级/来源并集/决策序。
 *
 * 行为决策来源：PRD 2026-10-08 `docs/superpowers/plans/2026-10-08-v026-permission-model.md`
 * 与系统设计 `docs/superpowers/plans/2026-10-08-v026-architecture.md` §3.1 / §3.2 / §4。
 * 先红后绿：本文件先于实现编写（红），实现后全绿。
 */
import assert from 'node:assert/strict';

import {
  extractRuleOperand,
  matchPermissionRule,
  mergePermissionRuleSets,
  parsePermissionRuleSpec,
  resolvePermissionDecision,
} from '../dist/cli/permission-rules.js';

const rules = (list, sources = {}) => ({ rules: list, sources });
const noRules = () => rules([]);
const mkRule = (level, toolName, operandPattern, source = 'user') =>
  operandPattern === undefined
    ? { level, toolName, source }
    : { level, toolName, operandPattern, source };

// ─── 1. parsePermissionRuleSpec：正例 ───────────────────────────────────────

assert.deepEqual(
  parsePermissionRuleSpec('exec(npm run *)', 'user'),
  { level: 'allow', toolName: 'exec', operandPattern: 'npm run *', source: 'user' },
  "'exec(npm run *)' 切分出工具名与 operand pattern"
);
assert.deepEqual(
  parsePermissionRuleSpec('read_file(./.env)', 'workspace'),
  { level: 'allow', toolName: 'read_file', operandPattern: './.env', source: 'workspace' },
  'path 形式 operand'
);
assert.deepEqual(
  parsePermissionRuleSpec('edit_file', 'session'),
  { level: 'allow', toolName: 'edit_file', source: 'session' },
  '裸工具名 = 整工具规则，无 operandPattern'
);
assert.deepEqual(
  parsePermissionRuleSpec('device_exec(*)', 'user'),
  { level: 'allow', toolName: 'device_exec', operandPattern: '*', source: 'user' },
  '通配 operand'
);
assert.deepEqual(
  parsePermissionRuleSpec('  write_file( a.txt ) ', 'user'),
  { level: 'allow', toolName: 'write_file', operandPattern: 'a.txt', source: 'user' },
  'spec 前后空白被裁剪，operand 内部空白被裁剪'
);

// ─── 2. parsePermissionRuleSpec：负例（非法语法抛 MossError）──────────────

for (const bad of [
  '',
  '   ',
  '()',
  'exec()',
  'exec((x))',
  'exec(a)(b)',
  '(',
  'a(',
  'a)b',
  'e)c(',
]) {
  let threw = false;
  try {
    parsePermissionRuleSpec(bad, 'user');
  } catch (err) {
    threw = true;
    assert.equal(err.name, 'MossError', `非法 spec "${bad}" 抛 MossError`);
    assert.equal(err.code, 'USER_INPUT_INVALID', `"${bad}" 的错误码是 USER_INPUT_INVALID`);
  }
  assert.ok(threw, `非法 spec "${bad}" 必须抛错`);
}

// 空工具名
{
  let threw = false;
  try {
    parsePermissionRuleSpec('()x', 'user');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'malformed shape throws');
}

// ─── 3. extractRuleOperand：操作数提取表 ───────────────────────────────────

assert.equal(
  extractRuleOperand('exec', { command: 'npm run build' }),
  'npm run build',
  'exec → command'
);
assert.equal(
  extractRuleOperand('device_exec', { command: 'systemctl restart robot' }),
  'systemctl restart robot',
  'device_exec → command'
);
assert.equal(extractRuleOperand('read_file', { path: './.env' }), './.env', 'read_file → path');
assert.equal(extractRuleOperand('write_file', { path: 'a.txt' }), 'a.txt', 'write_file → path');
assert.equal(extractRuleOperand('edit_file', { path: 'a.txt' }), 'a.txt', 'edit_file → path');
assert.equal(
  extractRuleOperand('device_file_write', { path: '/etc/conf' }),
  '/etc/conf',
  'device_file_write → path'
);
assert.equal(
  extractRuleOperand('device_file_read', { path: '/var/log/x' }),
  '/var/log/x',
  'device_file_read → path'
);
assert.equal(
  extractRuleOperand('device_deploy', { remote_path: '/opt/app' }),
  '/opt/app',
  'device_deploy → remote_path'
);
assert.equal(
  extractRuleOperand('move_file', { source: 'a.txt', destination: 'b.txt' }),
  'a.txt',
  'move_file → source'
);
assert.equal(
  extractRuleOperand('unknown_tool', { path: 'x' }),
  undefined,
  '未列入提取表的工具 → undefined（只匹配工具名）'
);

// apply_patch：patch 文件清单（多路径任一命中即算）
{
  const patch =
    '*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n@@\n*** Delete File: src/c.ts\n';
  assert.equal(
    extractRuleOperand('apply_patch', { patch }),
    'src/a.ts',
    'apply_patch → 首个 patch 文件（多路径任一命中即算的主操作数）'
  );
}

// ─── 4. matchPermissionRule：工具名 + operand 匹配 ─────────────────────────

assert.ok(
  matchPermissionRule(mkRule('allow', 'exec', 'npm run *'), 'exec', 'npm run build'),
  "'npm run *' 匹配 'npm run build'（前缀通配）"
);
assert.ok(
  !matchPermissionRule(mkRule('allow', 'exec', 'npm run *'), 'exec', 'npmx run build'),
  "'npm run *' 不匹配 'npmx run build'"
);
assert.ok(
  matchPermissionRule(mkRule('deny', 'read_file', './.env'), 'read_file', './.env'),
  'operand 精确匹配'
);
assert.ok(
  !matchPermissionRule(mkRule('deny', 'read_file', './.env'), 'read_file', './other'),
  'operand 不匹配时规则不命中'
);
assert.ok(
  matchPermissionRule(mkRule('allow', 'device_*'), 'device_exec'),
  "工具名通配 'device_*' 匹配 device_exec"
);
assert.ok(
  !matchPermissionRule(mkRule('allow', 'device_*'), 'exec'),
  "工具名通配 'device_*' 不匹配 exec"
);
// 裸规则（无 operandPattern）→ 只匹配工具名，任何 operand 不影响
assert.ok(
  matchPermissionRule(mkRule('allow', 'exec'), 'exec', 'rm -rf /'),
  '裸 exec 规则匹配工具名'
);
assert.ok(
  !matchPermissionRule(mkRule('allow', 'exec'), 'exec2', 'x'),
  '裸规则工具名必须相等/glob 匹配'
);
// 有 operandPattern 但 operand 缺失 → 不命中
assert.ok(
  !matchPermissionRule(mkRule('allow', 'exec', 'npm *'), 'exec', undefined),
  'operand 缺失时带 pattern 的规则不命中'
);

// ─── 5. mergePermissionRuleSets：deny 跨层级并集 + user-wins ───────────────

{
  const userRules = [
    mkRule('deny', 'read_file', './.env', 'user'),
    mkRule('allow', 'exec', 'npm run *', 'user'),
  ];
  const workspaceRules = [
    mkRule('deny', 'device_exec', undefined, 'workspace'),
    mkRule('allow', 'rm_tool', undefined, 'workspace'),
  ];
  const merged = mergePermissionRuleSets(userRules, workspaceRules);
  // deny 并集：两个层级各一条
  const denies = merged.filter((r) => r.level === 'deny');
  assert.equal(denies.length, 2, 'deny 规则跨层级取并集');
  assert.ok(
    denies.some((r) => r.toolName === 'read_file' && r.operandPattern === './.env'),
    'user deny 保留'
  );
  assert.ok(
    denies.some((r) => r.toolName === 'device_exec'),
    'workspace deny 并入'
  );
  // allow 同级合并
  const allows = merged.filter((r) => r.level === 'allow');
  assert.equal(allows.length, 2, 'allow 同级去重合并');
}
{
  // allow 不能解除另一层 deny：合并后 deny 恒在（匹配期 deny 恒优先）
  const merged = mergePermissionRuleSets(
    [mkRule('allow', 'exec', 'npm *', 'user')],
    [mkRule('deny', 'exec', 'npm *', 'workspace')]
  );
  assert.equal(merged.length, 2, 'allow 与 deny 并存（deny 优先在匹配期裁决）');
}
{
  // 同层级同 spec 去重
  const merged = mergePermissionRuleSets(
    [mkRule('allow', 'exec', 'npm *', 'user'), mkRule('allow', 'exec', 'npm *', 'user')],
    []
  );
  assert.equal(merged.length, 1, '同 spec 重复规则去重');
}

// ─── 6. resolvePermissionDecision：决策序矩阵 ──────────────────────────────

const decision = (input, r = noRules()) => resolvePermissionDecision(input, r);
const input = (over) => ({
  toolName: 'exec',
  sideEffect: 'local_write',
  operand: 'npm run build',
  requiresApproval: true,
  mode: 'manual',
  readOnlyCeiling: false,
  boardMode: false,
  ...over,
});

// 6a. deny 规则 > 一切（含 full）
{
  const r = rules([mkRule('deny', 'exec', 'npm *', 'user')]);
  assert.equal(
    decision(input({ mode: 'full' }), r).decision,
    'deny',
    '决策序：deny 规则在 full 模式下仍然赢'
  );
  assert.equal(decision(input(), r).decision, 'deny', 'deny 在 manual 下也赢');
  const matched = decision(input(), r);
  assert.ok(matched.matchedRule, 'deny 结果带 matchedRule');
}
// 6b. read_file(.env) deny 在 full 下仍拦（PRD 验收 7b）
{
  const r = rules([mkRule('deny', 'read_file', './.env', 'user')]);
  const out = resolvePermissionDecision(
    {
      toolName: 'read_file',
      sideEffect: 'readonly',
      operand: './.env',
      requiresApproval: false,
      mode: 'full',
      readOnlyCeiling: false,
      boardMode: false,
    },
    r
  );
  assert.equal(
    out.decision,
    'deny',
    'readonly 工具（read_file）在 needsApproval 短路之前先过 deny 匹配——full 也拦'
  );
}
// 6c. readonly 工具无规则 → 短路放行（no-approval-needed）
{
  const out = resolvePermissionDecision(
    {
      toolName: 'read_file',
      sideEffect: 'readonly',
      operand: 'x.txt',
      requiresApproval: false,
      mode: 'manual',
      readOnlyCeiling: false,
      boardMode: false,
    },
    noRules()
  );
  assert.equal(out.decision, 'allow', 'readonly 无规则命中时短路放行（requiresApproval=false）');
  assert.equal(out.reason, 'no-approval-needed', 'readonly 放行 reason=no-approval-needed');
}
// 6d. readOnlyCeiling → block（拦一切非 readonly 含 runtime_state）
{
  const blockOut = resolvePermissionDecision(
    input({ sideEffect: 'runtime_state', requiresApproval: false, readOnlyCeiling: true }),
    noRules()
  );
  assert.equal(blockOut.decision, 'block', 'read-only ceiling 拦 runtime_state（比 plan 更严）');
  const planOut = resolvePermissionDecision(
    input({ sideEffect: 'runtime_state', requiresApproval: false, readOnlyCeiling: true }),
    noRules()
  );
  assert.equal(
    planOut.decision,
    'block',
    'ceiling 对 readonly 副作用之外的一切 block（含 runtime_state）'
  );
  const roOut = resolvePermissionDecision(
    {
      toolName: 'read_file',
      sideEffect: 'readonly',
      requiresApproval: false,
      readOnlyCeiling: true,
      mode: 'full',
      boardMode: false,
      operand: 'x',
    },
    noRules()
  );
  assert.equal(roOut.decision, 'allow', 'ceiling 之下 readonly 仍放行');
}
// 6e. plan 类级 ceiling：device_mutation 拒 / readonly 放 / planMode allow 放
//     （plan 决策走 isAllowedDuringPlanMode 类级语义）
{
  const planInput = (over) => input({ mode: 'plan', ...over });
  assert.equal(
    decision(planInput({ sideEffect: 'device_mutation' })).decision,
    'block',
    'plan 类级拒绝 device_mutation'
  );
  assert.equal(
    decision(planInput({ sideEffect: 'readonly', requiresApproval: false })).decision,
    'allow',
    'plan 放行 readonly'
  );
  // plan 模式的 local_write block
  assert.equal(
    decision(planInput({ sideEffect: 'local_write' })).decision,
    'block',
    'plan block 普通写'
  );
}
// 6f. ask 规则：manual → ask-rule；full 跳过（PRD 决策 3）
{
  const r = rules([mkRule('ask', 'exec', 'rm *', 'user')]);
  assert.equal(
    decision(input({ operand: 'rm -rf /tmp/x' }), r).decision,
    'ask-rule',
    'manual 模式下 ask 规则命中 → 询问'
  );
  assert.equal(
    decision(input({ operand: 'rm -rf /tmp/x', mode: 'full' }), r).decision,
    'allow',
    'full 模式跳过 ask 规则（只有 deny 能拦）'
  );
  // manual 模式 ask 赢过 allow
  const r2 = rules([
    mkRule('ask', 'exec', 'rm *', 'user'),
    mkRule('allow', 'exec', 'rm *', 'user'),
  ]);
  assert.equal(
    decision(input({ operand: 'rm x' }), r2).decision,
    'ask-rule',
    'ask 优先于 allow（PRD 决策 3：manual 下 ask 赢过 allow）'
  );
}
// 6g. allow 规则 → allow（reason: 'rule'）
{
  const r = rules([mkRule('allow', 'exec', 'npm run *', 'user')]);
  const out = decision(input(), r);
  assert.equal(out.decision, 'allow', 'allow 规则命中 → 放行');
  assert.equal(out.reason, 'rule', 'allow 放行 reason=rule');
  assert.ok(out.matchedRule, 'allow 结果带 matchedRule');
}
// 6h. 模式默认：full → allow(mode)；acceptEditsEligible → accept-edits
{
  assert.equal(
    decision(input({ mode: 'full' })).decision,
    'allow',
    'full 模式无规则 → allow(mode)'
  );
  assert.equal(decision(input({ mode: 'full' })).reason, 'mode', 'full 默认放行 reason=mode');
  // acceptEdits 模式对 workspace 文件编辑（sideEffect local_write 且 acceptEditsEligible 由
  // hook 传入——决策序内以 input.acceptEditsEligible 表示）
  assert.equal(
    resolvePermissionDecision(
      input({ mode: 'acceptEdits', sideEffect: 'local_write', acceptEditsEligible: true }),
      noRules()
    ).decision,
    'allow',
    'acceptEdits + acceptEditsEligible → allow(accept-edits)'
  );
}
// 6i. boardMode：board 域副作用在规则/模式之后放行
{
  const out = resolvePermissionDecision(
    input({ mode: 'manual', sideEffect: 'device_mutation', boardMode: true }),
    noRules()
  );
  assert.equal(out.decision, 'allow', 'board 模式下 board 域副作用放行');
  assert.equal(out.reason, 'board', 'board 放行 reason=board');
  // 但 deny 规则仍赢 board
  const r = rules([mkRule('deny', 'exec')]);
  assert.equal(decision(input({ boardMode: true }), r).decision, 'deny', 'deny 优先于 board 放行');
}
// 6j. 兜底 ask（交互询问；headless 拒批）
{
  assert.equal(decision(input()).decision, 'ask', '无规则无模式豁免 → ask');
}
// 6k. device_mutation 在 manual 模式：无 allow 规则 → ask（T01 语义放宽，决策序落到兜底询问）
{
  const out = resolvePermissionDecision(
    input({ sideEffect: 'device_mutation', mode: 'manual' }),
    noRules()
  );
  assert.equal(
    out.decision,
    'ask',
    'manual 模式 device_mutation 无规则 → 进询问（非 ceiling 硬拦）'
  );
  // allow 规则可豁免询问
  const r = rules([mkRule('allow', 'device_exec', '*', 'user')]);
  assert.equal(
    resolvePermissionDecision(
      input({ toolName: 'device_exec', sideEffect: 'device_mutation', mode: 'manual' }),
      r
    ).decision,
    'allow',
    'allow 规则在 manual 模式豁免 device_mutation 询问'
  );
}
// 6l. full 模式 + requiresApproval=false 的非 readonly → allow (full 默认)
{
  const out = resolvePermissionDecision(
    input({ mode: 'full', requiresApproval: false, sideEffect: 'local_write' }),
    noRules()
  );
  assert.equal(out.decision, 'allow', 'full 模式非 readonly 无审批需求 → allow');
}

// ─── 7. ResolvedPermissionRules 类型形状（sources 携带路径）────────────────

{
  const r = {
    rules: [mkRule('deny', 'exec', 'rm *', 'workspace')],
    sources: {
      userPath: '/home/u/.config/moss/config.json',
      workspacePath: '/ws/.moss/config.json',
    },
  };
  assert.equal(r.rules.length, 1);
  assert.equal(r.sources.workspacePath, '/ws/.moss/config.json');
}

console.log('[PASS] permission-rules: 解析/匹配/合并/决策序矩阵/来源并集');
