#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SKILLHUB_SOULS,
  createSoulFile,
  installSkillHubCli,
  installSkillHubSoul,
  resetWorkspaceSoul,
  renderSoulStatus,
  resolveSoulDisplay,
} from '../dist/cli/soul-command.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-soul-command-'));
const workspace = path.join(root, 'workspace');
const configDir = path.join(root, 'config');
fs.mkdirSync(workspace, { recursive: true });

try {
  const initial = resolveSoulDisplay({ workspace, configDir });
  assert.equal(initial.soul.source, 'default');
  assert.equal(initial.label, 'default Moss persona');
  assert.equal(SKILLHUB_SOULS.length, 16, 'the public SkillHub Soul catalog is available');
  assert.ok(SKILLHUB_SOULS.some((soul) => soul.code === 'YYDS'));

  const initialText = renderSoulStatus({ workspace, configDir });
  assert.ok(initialText.includes('Soul / persona'));
  assert.ok(initialText.includes(path.join(workspace, '.moss', 'soul.md')));
  assert.ok(initialText.includes('/soul init'));
  assert.ok(initialText.includes('mode: replace'));

  const created = createSoulFile({ workspace, configDir, target: 'workspace' });
  assert.equal(created.created, true);
  assert.equal(created.path, path.join(workspace, '.moss', 'soul.md'));
  const template = fs.readFileSync(created.path, 'utf8');
  assert.ok(template.includes('id: workspace-persona'));
  assert.ok(template.includes('mode: replace'));

  const workspaceSoul = resolveSoulDisplay({ workspace, configDir });
  assert.equal(workspaceSoul.soul.source, 'workspace-file');
  assert.equal(workspaceSoul.label, 'workspace persona');

  fs.writeFileSync(created.path, 'do not overwrite');
  const duplicate = createSoulFile({ workspace, configDir, target: 'workspace' });
  assert.equal(duplicate.created, false);
  assert.equal(fs.readFileSync(created.path, 'utf8'), 'do not overwrite');

  const globalCreated = createSoulFile({ workspace, configDir, target: 'global' });
  assert.equal(globalCreated.created, true);
  assert.equal(globalCreated.path, path.join(configDir, 'soul.md'));

  fs.rmSync(created.path, { force: true });
  fs.writeFileSync(path.join(workspace, '.moss', 'soul.md'), 'previous persona');
  const installed = await installSkillHubSoul({
    workspace,
    code: 'YYDS',
    run: async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ['soul', 'install', 'YYDS']);
      fs.writeFileSync(path.join(workspace, '.moss', 'SOUL.md'), 'skillhub persona');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  assert.equal(installed.ok, true);
  const installedSoul = fs.readFileSync(path.join(workspace, '.moss', 'SOUL.md'), 'utf8');
  assert.ok(installedSoul.includes('id: skillhub-YYDS'));
  assert.ok(installedSoul.endsWith('skillhub persona'));
  assert.ok(installed.backupPath && fs.existsSync(installed.backupPath));

  const reset = resetWorkspaceSoul({ workspace });
  assert.equal(reset.removed, true);
  assert.equal(fs.existsSync(path.join(workspace, '.moss', 'SOUL.md')), false);

  fs.rmSync(path.join(workspace, '.moss', 'soul.default'), { force: true });
  fs.writeFileSync(path.join(workspace, '.moss', 'soul.md'), 'persona to restore');
  const failed = await installSkillHubSoul({
    workspace,
    code: 'MIAO',
    run: async () => {
      fs.writeFileSync(path.join(workspace, '.moss', 'SOUL.md'), 'partial install');
      throw new Error('simulated install failure');
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(fs.readFileSync(path.join(workspace, '.moss', 'soul.md'), 'utf8'), 'persona to restore');
  assert.notEqual(fs.readFileSync(path.join(workspace, '.moss', 'SOUL.md'), 'utf8'), 'partial install');

  resetWorkspaceSoul({ workspace });
  const failedFromDefault = await installSkillHubSoul({
    workspace,
    code: 'WHY',
    run: async () => { throw new Error('simulated missing cli'); },
  });
  assert.equal(failedFromDefault.ok, false);
  assert.equal(fs.existsSync(path.join(workspace, '.moss', 'soul.default')), true);

  const binDir = path.join(root, 'bin');
  const skillhubPath = path.join(binDir, process.platform === 'win32' ? 'skillhub.exe' : 'skillhub');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(skillhubPath, '#!/bin/sh\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  try {
    const commands = [];
    const cliInstall = await installSkillHubCli({
      fetchKit: async (url) => {
        assert.ok(url.includes('skillhub-1388575217.cos.ap-guangzhou.myqcloud.com'));
        return Uint8Array.from([0x1f, 0x8b, 0x08]);
      },
      run: async (command, args) => {
        commands.push([command, args]);
        if (command === 'tar') {
          const targetDir = args[args.indexOf('-C') + 1];
          fs.mkdirSync(path.join(targetDir, 'cli'), { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'cli', 'install.sh'), '#!/bin/sh\n');
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    assert.equal(cliInstall.ok, true);
    assert.equal(cliInstall.command, skillhubPath);
    assert.equal(commands[0][0], 'tar');
    assert.equal(commands[1][0], 'bash');
    assert.equal(commands[1][1][1], '--cli-only');
  } finally {
    process.env.PATH = originalPath;
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('  [PASS] cli-soul-command: status, paths, template, non-overwrite init');
