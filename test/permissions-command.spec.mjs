#!/usr/bin/env node
/**
 * v0.26 W2b /permissions rule manager (T04) — default view, add/remove
 * runtime effect, persist, invalid specs, zh/en surfaces.
 *
 * Behavior decisions from PRD 2026-10-08
 * (docs/superpowers/plans/2026-10-08-v026-permission-model.md) W2 and design
 * §3.2/§5-T04 (docs/superpowers/plans/2026-10-08-v026-architecture.md).
 * Red first: this file was written before the /permissions manager landed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runRegistryCommand } from '../dist/cli/commands/registry.js';
import { PermissionRuleRegistry } from '../dist/cli/permission-rules.js';
import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { parsePermissionRuleSpec } from '../dist/cli/permission-rules.js';
import { setCliInteractionMode } from '../dist/cli/interaction-mode.js';

// ── test harness: a CommandContext with a real registry + live getter ──────

const mkRegistry = () => new PermissionRuleRegistry();

const mkCtx = (options = {}) => {
  const { registry = mkRegistry(), startupRules = [], locale = 'en', zh = false } = options;
  const said = [];
  const runtime = {
    permissionRuleRegistry: registry,
    permissionsRules: () => ({
      rules: [...startupRules, ...registry.list()],
      sources: {
        userPath: '/home/test/.config/moss/config.json',
        workspacePath: '/tmp/ws/.moss/config.json',
      },
    }),
  };
  const ctx = {
    agent: { config: { model: 'test-model' }, tools: { getAll: () => [], size: 0 } },
    runtime,
    sessionKey: 'permissions-command-spec',
    workspace: '/tmp/ws',
    locale: zh ? 'zh-CN' : locale,
    surface: 'repl',
    say: (kind, text) => said.push({ kind, text }),
    prefillInput: () => {},
  };
  return { ctx, said, registry, runtime };
};

const run = async (ctx, input) => runRegistryCommand(input, ctx);

// ─── 1. default view: defaultMode + 3-level counts + sources ───────────────

{
  const { ctx, said, registry } = mkCtx({
    startupRules: [
      parsePermissionRuleSpec('read_file(./.env)', 'user', 'deny'),
      parsePermissionRuleSpec('exec(npm run *)', 'workspace', 'allow'),
    ],
  });
  registry.addSpec('exec(rm *)', 'ask');
  assert.equal(await run(ctx, '/permissions'), true, '/permissions handled');
  const text = said.map((entry) => entry.text).join('\n');
  assert.match(text, /default mode/, 'the view names the default mode');
  assert.match(text, /full/, 'the factory default mode is full');
  assert.match(text, /allow 1 · ask 1 · deny 1/, 'all three levels are counted');
  assert.match(
    text,
    /user \(\/home\/test\/\.config\/moss\/config\.json\)/,
    'user-level source shows its path'
  );
  assert.match(
    text,
    /workspace \(\/tmp\/ws\/\.moss\/config\.json\)/,
    'workspace-level source shows its path'
  );
  assert.match(text, /session \(this session only\)/, 'session source is labeled');
  assert.match(text, /read_file\(\.\/\.env\)/, 'rules print in Tool(pattern) form');
}

// ─── 2. verbose view: full table + guidance ────────────────────────────────

{
  const { ctx, said } = mkCtx({
    startupRules: [parsePermissionRuleSpec('device_exec', 'user', 'allow')],
  });
  await run(ctx, '/permissions --verbose');
  const text = said.map((entry) => entry.text).join('\n');
  assert.match(text, /Rule table:/, 'verbose view lists the rule table');
  assert.match(text, /allow\s+device_exec/, 'rules print with their level');
  assert.match(text, /\/permissions add deny/, 'the help shows the add syntax');
}

// ─── 3. add: session layer, effective on the next call ─────────────────────

{
  const { ctx, said, registry } = mkCtx();
  assert.equal(await run(ctx, '/permissions add deny "read_file(./.env)"'), true);
  assert.match(
    said.at(-1).text,
    /Session deny rule added: read_file\(\.\/\.env\)/,
    'add confirms the session rule'
  );
  assert.equal(registry.list().length, 1, 'the registry holds the rule');
  assert.equal(registry.list()[0].level, 'deny');
  assert.equal(registry.list()[0].source, 'session');

  // Runtime effect: the live rule table denies the next tool call — even in
  // full mode (PRD: deny wins in any mode).
  setCliInteractionMode('full');
  const hook = createCliToolApprovalHook(
    'full-access',
    {},
    {
      workspaceDir: process.cwd(),
      permissionRules: () => ({
        rules: [...registry.list()],
        sources: {},
      }),
    }
  );
  const decision = await hook({
    tool: {
      name: 'read_file',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      metadata: { sideEffectClass: 'readonly' },
      execute: async () => 'ok',
    },
    input: { path: './.env' },
    sessionKey: 'permissions-add-effect',
  });
  assert.equal(decision.approved, false, 'the added deny rule blocks the next call (full mode)');
  assert.match(decision.reason, /deny rule/i);
  setCliInteractionMode('manual');
}

// ─── 4. remove: session layer; honest boundary for config-level rules ──────

{
  const { ctx, said, registry } = mkCtx();
  registry.addSpec('exec(rm *)', 'ask');
  assert.equal(await run(ctx, '/permissions remove "exec(rm *)"'), true);
  assert.match(said.at(-1).text, /Session rule removed: exec\(rm \*\)/, 'remove confirms');
  assert.equal(registry.list().length, 0, 'the rule is gone from the registry');

  // Removing by index.
  registry.addSpec('device_exec', 'allow');
  assert.equal(await run(ctx, '/permissions remove 0'), true);
  assert.equal(registry.list().length, 0, 'index removal works');

  // A config-level rule cannot be removed in-session — the honest boundary.
  const { ctx: ctx2, said: said2 } = mkCtx({
    startupRules: [parsePermissionRuleSpec('read_file(./.env)', 'user', 'deny')],
  });
  assert.equal(await run(ctx2, '/permissions remove "read_file(./.env)"'), true);
  assert.match(
    said2.at(-1).text,
    /user-level rule and cannot be removed in-session/,
    'config-level removal gets the honest boundary message'
  );
  assert.match(said2.at(-1).text, /permissions\.deny/, 'the message names the config list');

  // No match at all.
  const { ctx: ctx3, said: said3 } = mkCtx();
  await run(ctx3, '/permissions remove "nonexistent_rule"');
  assert.match(said3.at(-1).text, /No session rule matched: nonexistent_rule/);
}

// ─── 5. add with invalid spec → MossError surfaced, nothing added ──────────

{
  const { ctx, said, registry } = mkCtx();
  assert.equal(await run(ctx, '/permissions add deny "exec()"'), true);
  assert.equal(said.at(-1).kind, 'error', 'the invalid spec is an error');
  assert.match(said.at(-1).text, /Invalid permission rule spec/i, 'the MossError message shows');
  assert.match(said.at(-1).text, /put a pattern in parentheses/, 'the hint shows the syntax');
  assert.equal(registry.list().length, 0, 'nothing was added');

  // Bad level token.
  assert.equal(await run(ctx, '/permissions add maybe "exec"'), true);
  assert.match(said.at(-1).text, /Usage: \/permissions add <allow\|ask\|deny>/);
}

// ─── 6. persist: writes the user config permissions.<level> ────────────────

{
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-perms-persist-'));
  const prevConfigDir = process.env.MOSS_CONFIG_DIR;
  process.env.MOSS_CONFIG_DIR = configDir;
  try {
    const { ctx, said } = mkCtx();
    assert.equal(await run(ctx, '/permissions persist deny "read_file(./.env)"'), true);
    assert.match(said.at(-1).text, /User-level deny rule saved: read_file\(\.\/\.env\)/);
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.deepEqual(
      written.permissions.deny,
      ['read_file(./.env)'],
      'persist writes permissions.deny in the user config'
    );
    // Idempotent persist (dedup).
    const { ctx: ctx2 } = mkCtx();
    await run(ctx2, '/permissions persist deny "read_file(./.env)"');
    const rewritten = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.equal(rewritten.permissions.deny.length, 1, 'persist dedupes');
  } finally {
    if (prevConfigDir === undefined) delete process.env.MOSS_CONFIG_DIR;
    else process.env.MOSS_CONFIG_DIR = prevConfigDir;
  }
}

// ─── 7. zh surface: at least one full-flow assertion ───────────────────────

{
  const { ctx, said, registry } = mkCtx({ zh: true });
  assert.equal(await run(ctx, '/permissions add deny "read_file(./.env)"'), true);
  assert.match(
    said.at(-1).text,
    /已添加会话级 deny 规则：read_file\(\.\/\.env\)——下一次工具调用即生效/,
    'zh: add 确认文案（会话级 + 下次调用生效）'
  );
  await run(ctx, '/permissions remove "read_file(./.env)"');
  assert.match(said.at(-1).text, /已移除会话规则/, 'zh: remove 确认文案');
  assert.equal(registry.list().length, 0);

  // zh default view — renderCliPermissions follows the process locale
  // (same as /status); pin LANG for this block.
  const prevLang = process.env.LANG;
  process.env.LANG = 'zh_CN.UTF-8';
  try {
    const { ctx: zhCtx, said: zhSaid } = mkCtx({ zh: true });
    await run(zhCtx, '/permissions');
    const zhText = zhSaid.map((entry) => entry.text).join('\n');
    assert.match(zhText, /默认模式/, 'zh: 默认模式标签');
    assert.match(zhText, /全开|full/, 'zh: full 模式名');
    assert.match(zhText, /规则/, 'zh: 规则计数行');
    assert.match(zhText, /增删规则：\/permissions add\|remove\|persist/, 'zh: 管理指引');
  } finally {
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
  }
}

// ─── 8. view lists rule counts with zero rules ─────────────────────────────

{
  const { ctx, said } = mkCtx();
  await run(ctx, '/permissions');
  const text = said.map((entry) => entry.text).join('\n');
  assert.match(text, /rules:?\s+none/, 'zero rules render as none');
  assert.match(text, /\/permissions add\|remove\|persist/, 'the manage hint is present');
}

console.log('[PASS] permissions-command: 规则管理器视图/增删/persist/zh-en/诚实边界');
