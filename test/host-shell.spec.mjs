#!/usr/bin/env node
/**
 * exec uses pwsh only at version 7+. Windows PowerShell 5.1 stays off the path.
 * Hooks, the status line, and acceptance commands stay on cmd.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  acceptanceShell,
  loginShellPath,
  runAcceptanceCommand,
} from '../dist/core/task/acceptance-command.js';
import { execToolDescription } from '../dist/tools/builtin.js';
import { resolveHostShell } from '../dist/utils/host-shell.js';

const absent = () => null;

{
  const shell = resolveHostShell({ platform: 'linux' });
  assert.equal(shell.kind, 'sh');
  assert.deepEqual(shell.argsFor('echo hi'), ['-c', 'echo hi']);
  assert.equal(shell.description, '');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
    lookup: absent,
    pwshMajor: () => null,
  });
  assert.equal(shell.kind, 'cmd');
  assert.equal(shell.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(shell.argsFor('echo hi'), ['/d', '/s', '/c', '"echo hi"']);
  assert.match(shell.description, /cmd\.exe/);
  assert.match(shell.description, /&&/);
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    pwshMajor: () => 5,
  });
  assert.equal(shell.kind, 'cmd', 'PowerShell 5.1 must not become the exec shell');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) =>
      name === 'powershell'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : null,
    pwshMajor: () => 7,
  });
  assert.equal(shell.kind, 'cmd', 'powershell.exe is not pwsh');
}

{
  const shell = resolveHostShell({
    platform: 'win32',
    lookup: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    pwshMajor: () => 7,
  });
  assert.equal(shell.kind, 'pwsh');
  assert.match(shell.executable, /pwsh\.exe$/);
  assert.deepEqual(shell.argsFor('echo hi && echo there'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'echo hi && echo there',
  ]);
  assert.match(execToolDescription(shell), /PowerShell 7/);
  assert.match(execToolDescription(shell), /Chain with &&/);
}

{
  const cmd = acceptanceShell('echo hi && echo there', 'win32');
  assert.match(cmd.cmd, /cmd\.exe|COMSPEC/i);
  assert.ok(cmd.args.includes('/c'));
  assert.equal(
    cmd.args.some((arg) => /pwsh|powershell/i.test(arg)),
    false
  );
}

if (process.platform === 'win32') {
  const live = resolveHostShell();
  const { runProcessSync } = await import('../dist/utils/run-process.js');
  const probe = runProcessSync(
    'pwsh',
    ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
    }
  );
  const major = Number.parseInt(String(probe.stdout ?? '').trim(), 10);
  if (probe.status === 0 && major >= 7) {
    assert.equal(live.kind, 'pwsh');
  } else {
    assert.equal(live.kind, 'cmd');
  }
  assert.doesNotMatch(live.executable, /WindowsPowerShell/i);
}

const syntheticEnv = {
  MOSS_DEVICE_HOST: 'synthetic',
  MOSS_DEVICE_PASSWORD: 'synthetic',
  moss_device_port: 'synthetic',
  MoSs_DeViCe_UsEr: 'synthetic',
  MOSS_BENCH_API_KEY: 'synthetic',
  OPENAI_API_KEY: 'synthetic',
  AWS_ACCESS_KEY_ID: 'synthetic',
  MOSS_SYNTHETIC_ORDINARY: 'synthetic',
  AUTH: 'synthetic',
  MOSS_ACCEPT_LOGIN_PATH: '0',
};

async function withSyntheticEnv(fn) {
  const previous = new Map(Object.keys(syntheticEnv).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, syntheticEnv);
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const presenceSource = `
const presence = {
  device: Boolean(process.env.MOSS_DEVICE_HOST),
  devicePassword: Boolean(process.env.MOSS_DEVICE_PASSWORD),
  devicePort: Boolean(process.env.moss_device_port),
  deviceUser: Boolean(process.env.MoSs_DeViCe_UsEr),
  benchmarkKey: Boolean(process.env.MOSS_BENCH_API_KEY),
  apiKey: Boolean(process.env.OPENAI_API_KEY),
  accessKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
  ordinary: process.env.MOSS_SYNTHETIC_ORDINARY === 'synthetic',
  path: Boolean(process.env.PATH || process.env.Path),
  auth: Boolean(process.env.AUTH)
};
`;

function assertPresence(result, label, expectedDevice = false) {
  const { auth, ...visible } = result;
  console.error(`custom AUTH visible to ${label} child: ${auth}`);
  assert.equal(typeof auth, 'boolean');
  assert.deepEqual(visible, {
    device: expectedDevice,
    devicePassword: false,
    devicePort: false,
    deviceUser: false,
    benchmarkKey: false,
    apiKey: false,
    accessKey: false,
    ordinary: true,
    path: true,
  });
}

test('acceptance shell filters synthetic credentials and preserves ordinary environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-accept-env-'));
  try {
    const probe = path.join(dir, 'presence.cjs');
    fs.writeFileSync(probe, `${presenceSource}\nprocess.stdout.write(JSON.stringify(presence));\n`);
    await withSyntheticEnv(async () => {
      const command = `"${process.execPath}" "${probe}"`;
      const result = await runAcceptanceCommand({ command, workspaceDir: dir });
      assert.equal(result.passed, true, result.tail);
      assertPresence(JSON.parse(result.tail), 'acceptance');
      const explicit =
        process.platform === 'win32'
          ? `set "MOSS_DEVICE_HOST=synthetic" && ${command}`
          : `MOSS_DEVICE_HOST=synthetic ${command}`;
      const override = await runAcceptanceCommand({ command: explicit, workspaceDir: dir });
      assert.equal(override.passed, true, override.tail);
      assertPresence(JSON.parse(override.tail), 'acceptance explicit override', true);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'login shell lookup filters synthetic credentials',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-login-env-'));
    try {
      const shell = path.join(dir, 'bash');
      const record = path.join(dir, 'presence.json');
      fs.writeFileSync(
        shell,
        `#!/usr/bin/env node\n${presenceSource}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(presence));\nprocess.stdout.write(JSON.stringify(presence));\n`,
        { mode: 0o755 }
      );
      await withSyntheticEnv(async () => {
        // This synthetic executable does not read any shell profile.
        assert.equal(await loginShellPath({ SHELL: shell }), '');
        assertPresence(JSON.parse(fs.readFileSync(record, 'utf8')), 'login shell');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('device benchmark blocks live modes before configuration or target setup', async () => {
  const { runDeviceBench } = await import('../scripts/lib/device-bench.mjs');
  const readDir = fs.readdirSync;
  let setupStarted = false;
  fs.readdirSync = () => {
    setupStarted = true;
    return [];
  };
  try {
    for (const mode of ['sim', 'real']) {
      const options = {
        mode,
        get tasks() {
          throw new Error('device benchmark setup started');
        },
      };
      await assert.rejects(runDeviceBench(options), /device benchmark.*disabled/i);
      assert.equal(setupStarted, false);
    }
  } finally {
    fs.readdirSync = readDir;
  }
});

console.log('[PASS] host shell');
