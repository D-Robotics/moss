#!/usr/bin/env node
/**
 * workspace-write is a file-tool boundary, not an OS sandbox.
 * These strings are the user-facing contract. Behaviour is unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configSnapshotLines } from '../dist/cli/config-snapshot.js';
import { renderConfigEnv, renderConfigHelp } from '../dist/cli/config-commands.js';
import { formatFullModeNotice, setupCopy, wrapNoticeLines } from '../dist/cli/cli-locale.js';
import { briefHelpLines, fullHelpLines } from '../dist/cli/help.js';
import { renderCliPermissions, renderCliWelcome } from '../dist/cli/onboarding.js';
import { renderPermissionsPanel } from '../dist/cli/tui/permissions-panel.js';
import { setTuiLocale, tui } from '../dist/cli/tui/copy.js';
import {
  WORKSPACE_WRITE_LIMIT_EN,
  WORKSPACE_WRITE_LIMIT_ZH,
} from '../dist/cli/workspace-write-copy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = (s) => s;
const colors = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  blue: identity,
  cyan: identity,
  magenta: identity,
  gray: identity,
};

assert.equal(
  WORKSPACE_WRITE_LIMIT_EN,
  "workspace-write confines Moss's own file tools. Shell commands run normally without an OS sandbox."
);
assert.equal(
  WORKSPACE_WRITE_LIMIT_ZH,
  '`workspace-write` 只约束 Moss 自己的文件工具。终端命令照常运行，没有操作系统沙箱。'
);

const runtime = {
  workspace: '/tmp/project',
  config: {
    configPath: '/tmp/config.json',
    workspace: '/tmp/project',
    workspaceSource: 'cwd',
    profile: 'balanced',
    safetyMode: 'workspace-write',
    safetyModeSource: 'config',
    approvalPolicy: 'prompt',
    trustedTools: [],
    deniedTools: [],
    maxAgentTurns: 64,
    contextTokens: 128000,
    usingBundledDefault: true,
    provider: 'deepseek',
    apiKey: '',
    model: 'test-model',
  },
};

{
  const en = renderCliPermissions(runtime, { locale: 'en_US.UTF-8' });
  const zh = renderCliPermissions(runtime, { locale: 'zh_CN.UTF-8' });
  assert.ok(en.includes(WORKSPACE_WRITE_LIMIT_EN), '/permissions (en) states the limit');
  assert.ok(zh.includes(WORKSPACE_WRITE_LIMIT_ZH), '/permissions (zh) states the limit');
  const verbose = renderCliPermissions(runtime, { verbose: true, locale: 'en_US.UTF-8' });
  assert.ok(verbose.includes(WORKSPACE_WRITE_LIMIT_EN), '/permissions --verbose states the limit');
  assert.ok(
    !verbose.includes('sandboxed workspace'),
    '/permissions does not call file-tool edits an OS sandbox'
  );
}

{
  const shown = configSnapshotLines(
    { safetyMode: 'workspace-write', safetyModeSource: 'config' },
    ['safetyMode'],
    'plain'
  ).join('\n');
  assert.ok(shown.includes('workspace-write (config)'), 'config show still names the mode');
  assert.ok(shown.includes(WORKSPACE_WRITE_LIMIT_EN), 'config show glosses workspace-write');
  const fullAccess = configSnapshotLines(
    { safetyMode: 'full-access', safetyModeSource: 'derived:mode' },
    ['safetyMode'],
    'plain'
  ).join('\n');
  assert.ok(
    !fullAccess.includes(WORKSPACE_WRITE_LIMIT_EN),
    'the gloss is attached to the workspace-write value'
  );
  assert.ok(
    renderConfigHelp().includes(WORKSPACE_WRITE_LIMIT_EN),
    'config --help glosses the mode'
  );
  assert.ok(
    renderConfigEnv().includes(WORKSPACE_WRITE_LIMIT_EN),
    'config env glosses MOSS_SAFETY_MODE'
  );
}

{
  const zh = briefHelpLines(colors, '/tmp/moss-config.json', true).join('\n');
  const en = briefHelpLines(colors, '/tmp/moss-config.json', false).join('\n');
  assert.ok(zh.includes(WORKSPACE_WRITE_LIMIT_ZH), 'zh moss --help states the limit');
  assert.ok(en.includes(WORKSPACE_WRITE_LIMIT_EN), 'en moss --help states the limit');
  const all = fullHelpLines(colors, '/tmp/moss-config.json');
  assert.ok(
    all.join('\n').includes(WORKSPACE_WRITE_LIMIT_EN),
    'moss --help --all states the limit'
  );
  assert.ok(all.length <= 60, `--help --all keeps a 60-line budget (got ${all.length})`);
}

{
  assert.ok(
    formatFullModeNotice('en_US.UTF-8').includes(WORKSPACE_WRITE_LIMIT_EN),
    'startup notice (en) states the limit'
  );
  assert.ok(
    formatFullModeNotice('zh_CN.UTF-8').includes(WORKSPACE_WRITE_LIMIT_ZH),
    'startup notice (zh) states the limit'
  );
  const wrapped = wrapNoticeLines(formatFullModeNotice('C'), 60);
  assert.ok(wrapped.length > 1, 'a 60-column safety notice wraps');
  assert.ok(wrapped.join(' ').includes('This notice shows once'));
  assert.ok(
    wrapped.every((line) => line.length <= 60),
    `wrapped notice stays within 60 columns (${wrapped.map((line) => line.length).join(',')})`
  );
  assert.equal(
    setupCopy('en_US.UTF-8', WORKSPACE_WRITE_LIMIT_EN),
    WORKSPACE_WRITE_LIMIT_EN,
    'locale table keeps the English sentence'
  );
  assert.equal(
    setupCopy('zh_CN.UTF-8', WORKSPACE_WRITE_LIMIT_EN),
    WORKSPACE_WRITE_LIMIT_ZH,
    'locale table translates the sentence'
  );
  const savedLang = process.env.LANG;
  const savedLcAll = process.env.LC_ALL;
  process.env.LANG = 'en_US.UTF-8';
  process.env.LC_ALL = 'en_US.UTF-8';
  try {
    const welcome = renderCliWelcome(
      { config: { model: 'test-model' }, tools: { getNames: () => [] } },
      runtime
    );
    assert.ok(welcome.includes(WORKSPACE_WRITE_LIMIT_EN), 'REPL welcome states the limit');
  } finally {
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
    if (savedLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLcAll;
  }
}

{
  const lines = renderPermissionsPanel({
    width: 80,
    mode: 'manual',
    cursor: 0,
    rules: [],
  }).map((entry) => entry.text);
  const text = lines.join('\n');
  assert.ok(
    text.includes("workspace-write confines Moss's own file tools."),
    '/permissions panel names the file-tool limit'
  );
  assert.ok(
    text.includes('Shell commands run normally without an OS sandbox.'),
    '/permissions panel says shell has no OS sandbox'
  );
  setTuiLocale(true);
  try {
    const zhPanel = renderPermissionsPanel({
      width: 80,
      mode: 'manual',
      cursor: 0,
      rules: [],
    })
      .map((entry) => entry.text)
      .join('\n');
    assert.ok(
      zhPanel.includes('`workspace-write` 只约束 Moss 自己的文件工具。'),
      '/permissions panel localizes the file-tool limit'
    );
    assert.ok(
      zhPanel.includes('终端命令照常运行，没有操作系统沙箱。'),
      '/permissions panel localizes the shell limit'
    );
    assert.equal(
      tui("  workspace-write confines Moss's own file tools."),
      '  `workspace-write` 只约束 Moss 自己的文件工具。'
    );
    assert.equal(
      tui(WORKSPACE_WRITE_LIMIT_EN),
      WORKSPACE_WRITE_LIMIT_ZH,
      'TUI copy translates the sentence'
    );
  } finally {
    setTuiLocale(false);
  }
}

{
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes(WORKSPACE_WRITE_LIMIT_EN), 'README (en) states the limit');
  assert.ok(readme.includes(WORKSPACE_WRITE_LIMIT_ZH), 'README (zh) states the limit');
  assert.ok(
    readme.includes('docs/design/os-sandbox.md'),
    'README points at the opt-in sandbox design'
  );
  assert.ok(!readme.includes('sandboxed workspace'), 'README does not call edits sandboxed');
  const design = fs.readFileSync(path.join(root, 'docs/design/os-sandbox.md'), 'utf8');
  assert.ok(
    design.replace(/\s+/g, ' ').includes(WORKSPACE_WRITE_LIMIT_EN),
    'design doc repeats the current limit'
  );
  assert.ok(design.includes('bubblewrap'), 'design doc covers Linux bubblewrap');
  assert.ok(design.includes('Landlock'), 'design doc covers Landlock');
  assert.ok(
    design.includes('seatbelt') || design.includes('sandbox-exec'),
    'design doc covers macOS'
  );
  assert.ok(design.includes('device_exec'), 'design doc covers device SSH tools');
  assert.ok(/default stays \*\*off\*\*/i.test(design), 'design doc keeps the default off');
}

console.log('[PASS] workspace-write copy');
