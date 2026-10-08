#!/usr/bin/env node
/**
 * v0.26 W1a 模式引擎（T01）—— 四态派生表、token 解析、迁移读侧、新默认。
 *
 * 行为决策来源：PRD 2026-10-08 `docs/superpowers/plans/2026-10-08-v026-permission-model.md`
 * 与系统设计 `docs/superpowers/plans/2026-10-08-v026-architecture.md` §1.2 / §3.1 / §3.3 / §5 T01。
 * 先红后绿：本文件先于实现编写（红），实现后全绿。
 */
import assert from 'node:assert/strict';

import {
  deriveEngineQuantas,
  formatCliInteractionModeLabel,
  inferCliInteractionModeFromMessages,
  parseCliInteractionMode,
  setCliInteractionMode,
} from '../dist/cli/interaction-mode.js';
import {
  CLI_PROFILE_DEFAULTS,
  migrateLegacyPermissionConfig,
  resolveCliConfig,
} from '../dist/cli/config.js';

// ─── 1. deriveEngineQuantas：四态全表（设计 §1.2 派生表） ───────────────────

assert.deepEqual(
  deriveEngineQuantas('manual'),
  {
    safetyMode: 'workspace-write',
    approvalPolicy: 'prompt',
    deviceMutationPolicy: 'ask',
    acceptEditsEligible: false,
  },
  'manual = workspace-write + prompt + device:ask + acceptEditsEligible:false'
);
assert.deepEqual(
  deriveEngineQuantas('acceptEdits'),
  {
    safetyMode: 'workspace-write',
    approvalPolicy: 'prompt',
    deviceMutationPolicy: 'ask',
    acceptEditsEligible: true,
  },
  'acceptEdits 同 manual 派生量，但 acceptEditsEligible:true'
);
assert.deepEqual(
  deriveEngineQuantas('plan'),
  {
    safetyMode: 'workspace-write',
    approvalPolicy: 'prompt',
    deviceMutationPolicy: 'deny',
    acceptEditsEligible: false,
  },
  'plan 底座 workspace-write + deviceMutationPolicy:deny（类级拒绝，决策走 isAllowedDuringPlanMode）'
);
assert.deepEqual(
  deriveEngineQuantas('full'),
  {
    safetyMode: 'full-access',
    approvalPolicy: 'never',
    deviceMutationPolicy: 'allow',
    acceptEditsEligible: true,
  },
  'full = full-access + never + device:allow + eligible:true'
);

// 恢复全局单例状态（后续 spec 依赖默认态）。
setCliInteractionMode('manual');

// ─── 2. parseCliInteractionMode：新 token + 别名兼容 ────────────────────────

assert.equal(parseCliInteractionMode('full'), 'full', "'full' 解析为 full");
assert.equal(parseCliInteractionMode('bypass'), 'full', "'bypass' 是 full 的别名");
assert.equal(parseCliInteractionMode('自动'), 'full', "zh '自动' 是 full 的别名");
assert.equal(parseCliInteractionMode('全开'), 'full', "zh '全开' 是 full 的别名");
assert.equal(parseCliInteractionMode('default'), 'manual', "'default' 是 manual 的别名（兼容）");
assert.equal(parseCliInteractionMode('d'), 'manual', "'d' 别名保留");
assert.equal(parseCliInteractionMode('normal'), 'manual', "'normal' 别名保留");
assert.equal(parseCliInteractionMode('默认'), 'manual', "zh '默认' 别名保留");
assert.equal(parseCliInteractionMode('plan'), 'plan', "'plan' 保留");
assert.equal(parseCliInteractionMode('accept-edits'), 'acceptEdits', "'accept-edits' 保留");
assert.equal(parseCliInteractionMode('yolo'), null, '幽灵 /yolo 已删除，不新增别名');
assert.equal(parseCliInteractionMode('garbage'), null, '未知 token 返回 null');
assert.equal(parseCliInteractionMode(undefined), null, 'undefined 返回 null');

// ─── 3. formatCliInteractionModeLabel：增 full 标签 ─────────────────────────

assert.equal(formatCliInteractionModeLabel('full'), 'full', "full 的 en 标签是 'full'");
assert.equal(formatCliInteractionModeLabel('full', true), '全开', "full 的 zh 标签是 '全开'");
assert.equal(formatCliInteractionModeLabel('manual', true), '手动', 'manual 的 zh 标签');
assert.equal(formatCliInteractionModeLabel('manual'), 'manual', 'manual 的 en 标签');

// ─── 4. inferCliInteractionModeFromMessages：老会话 default 语义 → manual ──

assert.equal(
  inferCliInteractionModeFromMessages([{ role: 'assistant', content: 'Left plan mode → default' }]),
  'manual',
  '历史文本 "Left plan mode → default" 推断为 manual（老会话的 default 语义即 manual）'
);
assert.equal(
  inferCliInteractionModeFromMessages([{ role: 'user', content: '/mode default' }]),
  'manual',
  '历史 /mode default 推断为 manual'
);
assert.equal(
  inferCliInteractionModeFromMessages([{ role: 'user', content: '/mode plan' }]),
  'plan',
  '历史 /mode plan 推断为 plan'
);
assert.equal(
  inferCliInteractionModeFromMessages([{ role: 'user', content: 'hello' }]),
  null,
  '无信号返回 null'
);

// ─── 5. migrateLegacyPermissionConfig：旧键迁移映射（PRD §数据与接口边界） ──

{
  const migrated = migrateLegacyPermissionConfig({ profile: 'cautious' });
  assert.equal(migrated.defaultMode, 'manual', 'profile: cautious → manual');
  assert.equal(migrated.ceiling, 'read-only', 'profile: cautious 保留 read-only ceiling');
  assert.deepEqual(migrated.legacyKeysUsed, ['profile'], 'legacyKeysUsed 列出 profile');
}
{
  const migrated = migrateLegacyPermissionConfig({ profile: 'balanced' });
  assert.equal(migrated.defaultMode, 'manual', 'profile: balanced → manual');
  assert.equal(migrated.ceiling, undefined, 'balanced 无 ceiling');
  assert.deepEqual(migrated.legacyKeysUsed, ['profile']);
}
{
  const migrated = migrateLegacyPermissionConfig({ profile: 'autonomous' });
  assert.equal(migrated.defaultMode, 'full', 'profile: autonomous → full');
  assert.deepEqual(migrated.legacyKeysUsed, ['profile']);
}
{
  const migrated = migrateLegacyPermissionConfig({
    safetyMode: 'full-access',
    approvalPolicy: 'never',
  });
  assert.equal(
    migrated.defaultMode,
    'full',
    'safetyMode full-access + approvalPolicy never → full'
  );
  assert.deepEqual(
    [...migrated.legacyKeysUsed].sort(),
    ['approvalPolicy', 'safetyMode'],
    '两个旧键都被记入 legacyKeysUsed'
  );
}
{
  const migrated = migrateLegacyPermissionConfig({ safetyMode: 'read-only' });
  assert.equal(migrated.defaultMode, 'manual', '旧 safetyMode read-only → manual');
  assert.equal(migrated.ceiling, 'read-only', '旧 safetyMode read-only 保留 ceiling');
}
{
  const migrated = migrateLegacyPermissionConfig({ safetyMode: 'workspace-write' });
  assert.equal(
    migrated.defaultMode,
    'manual',
    '旧 safetyMode workspace-write → manual（无 ceiling）'
  );
  assert.equal(migrated.ceiling, undefined);
}
{
  const migrated = migrateLegacyPermissionConfig({ approvalPolicy: 'never' });
  assert.equal(migrated.defaultMode, 'manual', '单独 approvalPolicy never → manual（不推 full）');
}
{
  const migrated = migrateLegacyPermissionConfig({ profile: 'unknown-junk' });
  assert.equal(migrated.defaultMode, undefined, '未知 profile 不产生 defaultMode（不迁移）');
  assert.equal(migrated.ceiling, undefined);
}
{
  const migrated = migrateLegacyPermissionConfig({});
  assert.equal(migrated.defaultMode, undefined, '空输入不迁移');
  assert.deepEqual(migrated.legacyKeysUsed, []);
}
{
  const migrated = migrateLegacyPermissionConfig({
    trustedTools: ['exec', 'apply_patch'],
  });
  assert.equal(migrated.defaultMode, undefined, 'trustedTools 不改 defaultMode');
  assert.deepEqual(
    migrated.allowRules,
    ['exec', 'apply_patch'],
    'trustedTools → allow 规则（整工具）'
  );
  assert.deepEqual(migrated.legacyKeysUsed, ['trustedTools']);
}
{
  const migrated = migrateLegacyPermissionConfig({
    deniedTools: ['device_exec'],
  });
  assert.deepEqual(migrated.denyRules, ['device_exec'], 'deniedTools → deny 规则（整工具）');
  assert.deepEqual(migrated.legacyKeysUsed, ['deniedTools']);
}

// ─── 6. CLI_PROFILE_DEFAULTS：balanced 档翻为 full 等价（PRD W1） ───────────

assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.safetyMode,
  'full-access',
  'balanced 档（默认 profile）翻为 full-access 等价 — v0.26 默认全开（PRD 2026-10-08 W1）'
);
assert.equal(
  CLI_PROFILE_DEFAULTS.balanced.approvalPolicy,
  'never',
  'balanced 档 approvalPolicy 翻为 never — 字段语义让位 permissions.defaultMode，保留字段名避免 SDK 面 diff'
);

// ─── 7. resolveCliConfig：新解析链（overrides > env > permissions > 迁移 > full） ─

{
  // 7a. 无任何配置 → defaultMode=full（新默认）。
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, {});
  assert.equal(
    resolved.permissions.defaultMode,
    'full',
    'v0.26 新默认：无任何权限配置时 defaultMode=full（PRD W1 默认翻转）'
  );
  assert.equal(
    resolved.safetyMode,
    'full-access',
    '无配置时派生 safetyMode=full-access（derived:mode）'
  );
  assert.equal(resolved.approvalPolicy, 'never', '无配置时派生 approvalPolicy=never');
  assert.equal(resolved.safetyModeSource, 'derived:mode', 'safetyModeSource 标 derived:mode');
  assert.equal(
    resolved.approvalPolicySource,
    'derived:mode',
    'approvalPolicySource 标 derived:mode'
  );
}
{
  // 7b. permissions 块读入。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    { permissions: { defaultMode: 'manual' } }
  );
  assert.equal(resolved.permissions.defaultMode, 'manual', 'permissions.defaultMode 读入');
  assert.equal(resolved.safetyMode, 'workspace-write', 'manual 模式派生 workspace-write');
  assert.equal(resolved.approvalPolicy, 'prompt');
  assert.equal(resolved.safetyModeSource, 'derived:mode');
}
{
  // 7c. 旧键 profile: balanced → 迁移为 manual（迁移语义，非旧断言的 workspace-write）。
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, { profile: 'balanced' });
  assert.equal(
    resolved.permissions.defaultMode,
    'manual',
    '旧 profile: balanced 键读入 → 迁移为 manual（PRD 迁移映射表）'
  );
  assert.equal(resolved.safetyMode, 'workspace-write');
  assert.equal(resolved.approvalPolicy, 'prompt');
  assert.ok(
    resolved.permissions.legacyKeysUsed.includes('profile'),
    'resolved.permissions.legacyKeysUsed 含 profile'
  );
}
{
  // 7d. 旧键 profile: cautious → manual + ceiling。
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, { profile: 'cautious' });
  assert.equal(resolved.permissions.defaultMode, 'manual');
  assert.equal(resolved.permissions.readOnlyCeiling, true, 'cautious → readOnlyCeiling 激活');
}
{
  // 7e. 旧键 profile: autonomous → full。
  const resolved = resolveCliConfig({ MOSS_NO_BUNDLED_DEFAULT: '1' }, { profile: 'autonomous' });
  assert.equal(resolved.permissions.defaultMode, 'full', '旧 autonomous 键迁移为 full');
  assert.equal(resolved.safetyMode, 'full-access');
}
{
  // 7f. env 兼容键压过 config permissions（MOSS_SAFETY_MODE=read-only → manual+ceiling）。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1', MOSS_SAFETY_MODE: 'read-only' },
    { permissions: { defaultMode: 'full' } }
  );
  assert.equal(
    resolved.permissions.defaultMode,
    'manual',
    'MOSS_SAFETY_MODE=read-only 压过 permissions.defaultMode → manual'
  );
  assert.equal(resolved.permissions.readOnlyCeiling, true, 'env read-only 激活 ceiling');
}
{
  // 7g. env MOSS_APPROVAL_POLICY=never → mode 覆盖 full。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1', MOSS_APPROVAL_POLICY: 'never' },
    { permissions: { defaultMode: 'manual' } }
  );
  assert.equal(
    resolved.permissions.defaultMode,
    'full',
    'MOSS_APPROVAL_POLICY=never 是 mode 覆盖 → full（§3.3 映射表）'
  );
}
{
  // 7h. 旧 trustedTools/deniedTools 迁移为规则数组。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    { trustedTools: ['exec'], deniedTools: ['device_exec'] }
  );
  assert.deepEqual(resolved.trustedTools, ['exec'], 'trustedTools 字段保留（嵌入兼容）');
  assert.deepEqual(resolved.deniedTools, ['device_exec'], 'deniedTools 字段保留');
  assert.ok(resolved.permissions.legacyKeysUsed.includes('trustedTools'));
  assert.ok(resolved.permissions.legacyKeysUsed.includes('deniedTools'));
}
{
  // 7i. permissions 块的 allow/ask/deny 数组读入。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    {
      permissions: {
        defaultMode: 'manual',
        allow: ['exec(npm run *)'],
        ask: ['exec(rm *)'],
        deny: ['read_file(./.env)'],
      },
    }
  );
  assert.deepEqual(resolved.permissions.allow, ['exec(npm run *)']);
  assert.deepEqual(resolved.permissions.ask, ['exec(rm *)']);
  assert.deepEqual(resolved.permissions.deny, ['read_file(./.env)']);
  assert.equal(resolved.permissions.legacyKeysUsed.length, 0, '纯新键无 legacy');
}
{
  // 7j. overrides（CLI flags 语义）压过一切。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    { permissions: { defaultMode: 'full' } },
    { safetyMode: 'read-only' }
  );
  assert.equal(
    resolved.permissions.defaultMode,
    'manual',
    'overrides.safetyMode=read-only（--read-only flag）压过 config → manual+ceiling'
  );
  assert.equal(resolved.permissions.readOnlyCeiling, true);
}
{
  // 7k. 旧 safetyMode+approvalPolicy 组合：full-access+never → full。
  const resolved = resolveCliConfig(
    { MOSS_NO_BUNDLED_DEFAULT: '1' },
    { safetyMode: 'full-access', approvalPolicy: 'never' }
  );
  assert.equal(resolved.permissions.defaultMode, 'full');
  assert.equal(resolved.safetyMode, 'full-access');
  assert.equal(resolved.approvalPolicy, 'never');
}

// ─── 8. T03 决策序矩阵扩展（hook 装配层走 resolvePermissionDecision） ──────

{
  const { createCliToolApprovalHook } = await import('../dist/cli/approval.js');
  const { parsePermissionRuleSpec } = await import('../dist/cli/permission-rules.js');
  const { setCliInteractionMode } = await import('../dist/cli/interaction-mode.js');
  const mkTool = (name, sideEffectClass, planMode) => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass, ...(planMode ? { planMode } : {}) },
    execute: async () => 'ok',
  });
  const rule = (spec, level, source = 'user') => parsePermissionRuleSpec(spec, source, level);
  const withRules = (rules) => ({ rules, sources: {} });

  // 8a. deny 规则（read_file(./.env)）在 full 模式下仍拦（PRD 验收 7b）。
  {
    setCliInteractionMode('full');
    const hook = createCliToolApprovalHook(
      'full-access',
      {},
      {
        workspaceDir: process.cwd(),
        permissionRules: () => withRules([rule('read_file(./.env)', 'deny')]),
      }
    );
    const decision = await hook({
      tool: mkTool('read_file', 'readonly'),
      input: { path: './.env' },
      sessionKey: 'matrix-deny-readonly-full',
    });
    assert.equal(decision.approved, false, 'deny 规则在 full 模式下拦 readonly 工具');
    assert.match(decision.reason, /deny rule/i);
    setCliInteractionMode('manual');
  }

  // 8b. manual 模式 device_mutation 无规则 → 询问（headless 拒批）而非 ceiling 硬拦。
  {
    setCliInteractionMode('manual');
    const hook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
      }
    );
    const decision = await hook({
      tool: mkTool('device_exec', 'device_mutation'),
      input: { command: 'systemctl restart robot' },
      sessionKey: 'matrix-device-ask',
    });
    assert.equal(
      decision.approved,
      false,
      'manual 模式 device_mutation 进询问（headless 无 asker 拒批）——语义放宽自 ceiling 硬拦（PRD 量化表）'
    );
    assert.match(decision.reason, /non-interactively|requires approval/i);
  }

  // 8c. manual 模式 device_mutation + allow 规则 → 放行（allow 可豁免询问）。
  {
    setCliInteractionMode('manual');
    const hook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
        permissionRules: () => withRules([rule('device_exec(systemctl *)', 'allow')]),
      }
    );
    const decision = await hook({
      tool: mkTool('device_exec', 'device_mutation'),
      input: { command: 'systemctl restart robot' },
      sessionKey: 'matrix-device-allow',
    });
    assert.equal(decision.approved, true, 'allow 规则在 manual 模式豁免 device_mutation 询问');
  }

  // 8d. read-only ceiling 压过 full：runtime_state 类也被拦。
  {
    setCliInteractionMode('full');
    const hook = createCliToolApprovalHook(
      'full-access',
      {},
      {
        workspaceDir: process.cwd(),
        readOnlyCeiling: true,
      }
    );
    const decision = await hook({
      tool: mkTool('todo_write', 'runtime_state', 'allow'),
      input: { todos: [] },
      sessionKey: 'matrix-ceiling-full',
    });
    assert.equal(
      decision.approved,
      false,
      'read-only ceiling 压过 full 模式（拦 runtime_state——比 plan 更严，PRD 决策 2）'
    );
    setCliInteractionMode('manual');
  }

  // 8e. 运行中生效：'a' 写 session allow 规则后，下一个调用即放行（live getter）。
  {
    setCliInteractionMode('manual');
    const answers = ['a', ''];
    const { setCliApprovalAsker } = await import('../dist/cli/approval.js');
    setCliApprovalAsker(async () => answers.shift() ?? '');
    const hook = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: process.cwd(),
      }
    );
    const first = await hook({
      tool: mkTool('exec', 'local_write'),
      input: { command: 'touch /tmp/moss-matrix-a' },
      sessionKey: 'matrix-live-rule',
    });
    assert.equal(first.approved, true, "first call approved via 'a'");
    const second = await hook({
      tool: mkTool('exec', 'local_write'),
      input: { command: 'touch /tmp/moss-matrix-b' },
      sessionKey: 'matrix-live-rule',
    });
    assert.equal(
      second.approved,
      true,
      "'a' 写 session allow 规则 → 下一个工具调用即生效（不再询问）"
    );
    setCliApprovalAsker(null);
  }
}

console.log('[PASS] cli-permission-mode-engine: 模式引擎四态派生 + 迁移读侧 + 新默认 full');
