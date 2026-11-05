#!/usr/bin/env node
/**
 * D14 opt-in OS sandbox probe.
 *
 * Deterministic parts: the opt-in resolution, the refusal matrix (win32, Linux
 * without bwrap), and the config/env plumbing. When the host backend exists
 * (macOS sandbox-exec here) the probe also runs the REAL acceptance from the
 * design doc: a python/node write outside the workspace must fail, a write
 * inside must succeed, `.git/hooks` stays write-denied, and both exec and
 * background exec report the sandbox label.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const sandboxModule = await import(
  pathToFileURL(path.join(root, 'dist/safety/os-sandbox.js')).href
);
const procModule = await import(pathToFileURL(path.join(root, 'dist/utils/run-process.js')).href);
const builtin = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);
const configModule = await import(pathToFileURL(path.join(root, 'dist/cli/config.js')).href);
const configCommands = await import(
  pathToFileURL(path.join(root, 'dist/cli/config-commands.js')).href
);

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 1. Opt-in resolution ───────────────────────────────────────────────────

await check('opt-in comes from the config flag or MOSS_OS_SANDBOX only', async () => {
  assert.equal(sandboxModule.osSandboxRequested(undefined, {}), false);
  assert.equal(sandboxModule.osSandboxRequested(false, {}), false);
  assert.equal(sandboxModule.osSandboxRequested(true, {}), true);
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
    assert.equal(sandboxModule.osSandboxRequested(false, { MOSS_OS_SANDBOX: value }), true);
  }
  assert.equal(sandboxModule.osSandboxRequested(undefined, { MOSS_OS_SANDBOX: '0' }), false);
});

await check('resolved config exposes permissions.osSandbox and its source', async () => {
  const fromConfig = configModule.resolveCliConfig({}, { permissions: { osSandbox: true } }, {});
  assert.equal(fromConfig.permissions.osSandbox, true);
  assert.match(fromConfig.permissions.osSandboxSource, /permissions\.osSandbox|config/);
  const fromEnv = configModule.resolveCliConfig({ MOSS_OS_SANDBOX: '1' }, {}, {});
  assert.equal(fromEnv.permissions.osSandbox, true);
  assert.equal(fromEnv.permissions.osSandboxSource, 'MOSS_OS_SANDBOX');
  const off = configModule.resolveCliConfig({}, {}, {});
  assert.equal(off.permissions.osSandbox, false);
  assert.equal(off.permissions.osSandboxSource, 'default');
});

await check('config show surfaces the opt-in boundary (human + json)', async () => {
  const settings = { permissions: { osSandbox: true } };
  const { renderAuthStatus } = await import(
    pathToFileURL(path.join(root, 'dist/cli/setup-wizard.js')).href
  );
  const human = renderAuthStatus(settings, {}, root, {}, '[config]');
  assert.match(human, /[Oo][Ss] [Ss]andbox|OS 沙箱/);
  assert.match(human, /full-access|完全访问/);
  const json = JSON.parse(configCommands.renderConfigJson(settings, {}, root, {}));
  assert.equal(json.permissions.osSandbox, true);
  assert.equal(json.permissions.osSandboxSource, 'config');
});

// ── 2. Refusal matrix: no silent unsandboxed fallback ─────────────────────

await check('win32 refuses exec and names WSL2 + the config key', async () => {
  const original = process.platform;
  const resolution = sandboxModule.buildOsSandboxPlan({
    command: 'cmd.exe',
    args: ['/c', 'echo hi'],
    workspaceRoot: root,
    platform: 'win32',
  });
  assert.ok(resolution.refusal, 'win32 must refuse, not plan');
  assert.match(resolution.refusal, /WSL2/);
  assert.match(resolution.refusal, /permissions\.osSandbox|MOSS_OS_SANDBOX/);
  assert.match(resolution.refusal, /NOT run/);
  assert.equal(process.platform, original);
});

await check('linux without bwrap refuses instead of running unsandboxed', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-sandbox-empty-path-'));
  const resolution = sandboxModule.buildOsSandboxPlan({
    command: '/bin/sh',
    args: ['-c', 'true'],
    workspaceRoot: empty,
    platform: 'linux',
    env: { PATH: empty },
  });
  assert.ok(resolution.refusal, 'missing bwrap must refuse');
  assert.match(resolution.refusal, /bubblewrap/);
  assert.match(resolution.refusal, /NOT run/);
  fs.rmSync(empty, { recursive: true, force: true });
});

// ── 3. Real backend acceptance (skipped when the host has no backend) ─────

const hasSeatbelt = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

if (!hasSeatbelt) {
  checks.push('SKIP real sandbox run (no sandbox-exec/bwrap backend on this host)');
} else {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-os-sandbox-'));
  const escapePath = path.join(os.tmpdir(), `moss-sandbox-escape-${process.pid}.txt`);

  await check(
    'profile denies network and .git internals while allowing workspace writes',
    async () => {
      const profile = sandboxModule.seatbeltProfile(workspace);
      assert.match(profile, /\(deny network\*\)/);
      assert.match(profile, /\(deny default\)/);
      assert.ok(profile.includes('.git/hooks'));
    }
  );

  await check('a write outside the workspace is blocked by the kernel', async () => {
    const resolution = sandboxModule.buildOsSandboxPlan({
      command: '/bin/sh',
      args: ['-c', `node -e "require('fs').writeFileSync(${JSON.stringify(escapePath)}, 'x')"`],
      workspaceRoot: workspace,
    });
    assert.ok(resolution.plan, 'expected a seatbelt plan');
    try {
      await procModule.runProcess(resolution.plan.command, {
        args: resolution.plan.args,
        cwd: workspace,
        timeout: 20_000,
      });
      // If it exited 0 the sandbox did not enforce the boundary.
      assert.fail('the escape write must fail inside the sandbox');
    } catch {
      // expected: EPERM from seatbelt
    }
    assert.equal(fs.existsSync(escapePath), false, 'the escape file must not exist');
  });

  await check('a workspace write succeeds and .git/hooks stays write-denied', async () => {
    fs.mkdirSync(path.join(workspace, '.git/hooks'), { recursive: true });
    const resolution = sandboxModule.buildOsSandboxPlan({
      command: '/bin/sh',
      args: [
        '-c',
        'printf ok > inside.txt; printf hook > .git/hooks/x.sh; printf nested > .git/config; exit 7',
      ],
      workspaceRoot: workspace,
    });
    try {
      await procModule.runProcess(resolution.plan.command, {
        args: resolution.plan.args,
        cwd: workspace,
        timeout: 20_000,
      });
    } catch {
      // exit 7 means at least one protected write failed below; inspected next
    }
    assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'ok');
    assert.equal(fs.existsSync(path.join(workspace, '.git/hooks/x.sh')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.git/config')), false);
  });

  const execTool = builtin.builtinTools.find((tool) => tool.name === 'exec');
  const bgTool = builtin.builtinTools.find((tool) => tool.name === 'exec_background');
  assert.ok(execTool, 'exec must be registered');
  assert.ok(bgTool, 'exec_background must be registered');

  await check('the exec tool runs inside the sandbox and reports its backend', async () => {
    const text = await execTool.execute(
      { command: 'printf from-sandbox > exec-inside.txt; node -e "1"' },
      {
        workspaceDir: workspace,
        sessionKey: 'os-sandbox-probe',
        osSandbox: true,
        onToolOutput: () => {},
      }
    );
    assert.match(String(text), /\[os-sandbox\] seatbelt/);
    assert.equal(fs.readFileSync(path.join(workspace, 'exec-inside.txt'), 'utf8'), 'from-sandbox');
  });

  await check('the exec tool refuses when the backend binary is missing', async () => {
    const saved = process.env.MOSS_SANDBOX_EXEC_PATH;
    process.env.MOSS_SANDBOX_EXEC_PATH = '/nonexistent/sandbox-exec';
    try {
      const text = await execTool.execute(
        { command: 'printf never > refused.txt' },
        {
          workspaceDir: workspace,
          sessionKey: 'os-sandbox-probe',
          osSandbox: true,
          onToolOutput: () => {},
        }
      );
      assert.match(String(text), /Command blocked: OS sandbox is on/);
      assert.match(String(text), /NOT run unsandboxed/);
      assert.equal(fs.existsSync(path.join(workspace, 'refused.txt')), false);
    } finally {
      if (saved === undefined) delete process.env.MOSS_SANDBOX_EXEC_PATH;
      else process.env.MOSS_SANDBOX_EXEC_PATH = saved;
    }
  });

  await check('background exec also runs sandboxed', async () => {
    const text = await bgTool.execute(
      { command: 'printf bg-ok > bg-inside.txt', settle_ms: 300 },
      {
        workspaceDir: workspace,
        sessionKey: 'os-sandbox-probe',
        osSandbox: true,
        onToolOutput: () => {},
      }
    );
    assert.match(String(text), /\[os-sandbox\] seatbelt/);
    assert.equal(fs.readFileSync(path.join(workspace, 'bg-inside.txt'), 'utf8'), 'bg-ok');
  });

  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(escapePath, { force: true });
}

for (const line of checks) console.log(`[os-sandbox] ${line}`);
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[os-sandbox] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[os-sandbox] ${checks.length} checks passed`);
