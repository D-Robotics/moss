import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backgroundShellInvocation } from '../dist/tools/windows-background-job.js';
import { hostShellInvocation, resolveHostShell } from '../dist/utils/host-shell.js';
import { killProc } from '../dist/core/tools/background-process-registry.js';

const shell = resolveHostShell();
if (process.platform !== 'win32') {
  const actual = backgroundShellInvocation('printf owned', shell);
  assert.deepEqual(actual, {
    ...hostShellInvocation('printf owned', shell),
    windowsVerbatimArguments: false,
    windowsJobOwner: false,
  });
  console.log('[PASS] POSIX original invocation remains exact');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '.moss-job-contract-'));
  const node = process.execPath,
    script = path.join(root, "owned ü's job.cjs");
  fs.writeFileSync(
    script,
    `const fs=require('node:fs'),cp=require('node:child_process');const [mode,marker,nonce,code]=process.argv.slice(2);if(mode==='io'){fs.writeFileSync(marker,nonce);console.log(JSON.stringify({nonce,pid:process.pid,cwd:process.cwd(),env:process.env.MOSS_JOB_TEST_SENTINEL,stdin:fs.readFileSync(0,'utf8')}));console.error('owned stderr');process.exit(Number(code));}else{console.log(JSON.stringify({nonce,pid:process.pid,mode}));if(mode==='parent')cp.spawn(process.execPath,[__filename,'leaf',marker,nonce],{stdio:'inherit'});else setTimeout(()=>fs.writeFileSync(marker,nonce),350);setInterval(()=>{},1000);}`
  );
  const cmd = {
    kind: 'cmd',
    executable: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
    argsFor: (c) => ['/d', '/s', '/c', `"${c}"`],
  };
  const env = { ...process.env, MOSS_JOB_TEST_SENTINEL: randomUUID() };
  const launches = [];
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      assert.equal(e.code, 'ESRCH');
      return false;
    }
  };
  const until = async (predicate, budget, label) => {
    const start = Date.now();
    while (!predicate()) {
      assert.ok(Date.now() - start < budget, `${label} exceeded original ${budget}ms`);
      await pause(10);
    }
  };
  const command = (s, mode, marker, nonce, code = 0) =>
    `${s.kind === 'pwsh' ? '& ' : ''}"${node}" "${script}" ${mode} "${marker}" "${nonce}" ${code}${s.kind === 'pwsh' ? '; exit $LASTEXITCODE' : ''}`;
  // O161: every Job invocation launches Windows PowerShell 5.1, which compiles a
  // dynamic assembly before running the command. Slow CI runners exceeded the old
  // 3000ms process deadline (ETIMEDOUT). This is only a hang guard for the test
  // harness; it is not a product bound and no assertion depends on it.
  const PS_SPAWN_TIMEOUT_MS = 30000;
  const sync = (inv) =>
    cp.spawnSync(inv.executable, inv.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
      timeout: PS_SPAWN_TIMEOUT_MS,
    });
  const checkFailure = (result, label) => {
    assert.equal(result.error, undefined, label);
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, '', label);
    assert.ok(result.stderr.length > 0, label);
  };
  try {
    // Real PS5/cmd without pwsh7 PATH; stdout/stderr/cwd/env/NUL stdin and 0+7 are exact.
    const noPwshEnv = {
      ...env,
      PATH: [path.dirname(node), path.join(process.env.SystemRoot, 'System32')].join(
        path.delimiter
      ),
    };
    const absent = cp.spawnSync(path.join(process.env.SystemRoot, 'System32/where.exe'), ['pwsh'], {
      env: noPwshEnv,
      timeout: 3000,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(absent.error, undefined);
    assert.equal(absent.status, 1);
    assert.equal(absent.stdout, '');
    for (const actualShell of shell.kind === 'pwsh' ? [cmd, shell] : [cmd])
      for (const code of [0, 7]) {
        const nonce = randomUUID(),
          marker = path.join(root, `io-${actualShell.kind}-${code}`),
          inv = backgroundShellInvocation(
            command(actualShell, 'io', marker, nonce, code),
            actualShell,
            root
          );
        const r = cp.spawnSync(inv.executable, inv.args, {
          cwd: root,
          env: actualShell.kind === 'cmd' ? noPwshEnv : env,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: inv.windowsVerbatimArguments,
          timeout: PS_SPAWN_TIMEOUT_MS,
        });
        assert.equal(r.error, undefined);
        assert.equal(r.status, code);
        assert.equal(r.stderr, 'owned stderr\n');
        const identity = JSON.parse(r.stdout);
        assert.equal(identity.nonce, nonce);
        assert.equal(fs.realpathSync.native(identity.cwd), fs.realpathSync.native(root));
        assert.equal(identity.env, env.MOSS_JOB_TEST_SENTINEL);
        assert.equal(identity.stdin, '');
        assert.equal(fs.readFileSync(marker, 'utf8'), nonce);
        assert.equal(alive(identity.pid), false);
      }
    if (shell.kind === 'pwsh') {
      const preference = sync(
        backgroundShellInvocation(
          '[Console]::Out.Write($ErrorActionPreference.ToString()); exit 0',
          shell,
          root
        )
      );
      assert.equal(preference.error, undefined);
      assert.equal(preference.status, 0);
      assert.equal(preference.stdout, 'Continue');
      assert.equal(preference.stderr, '');
    }
    const faultMarker = path.join(root, 'init-never.txt'),
      faultNonce = randomUUID(),
      normal = backgroundShellInvocation(command(cmd, 'io', faultMarker, faultNonce), cmd, root);
    for (const [name, from, to] of [
      [
        'create',
        '$mossOwnedJob = $mossNative::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)',
        "$mossInvalidName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('moss\\invalid\\name')\ntry { $mossOwnedJob = $mossNative::CreateJobObjectW([IntPtr]::Zero,$mossInvalidName) } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($mossInvalidName) }",
      ],
      [
        'limit',
        'SetInformationJobObject($mossOwnedJob, 9,',
        'SetInformationJobObject($mossOwnedJob, 999,',
      ],
      [
        'assign',
        'AssignProcessToJobObject($mossOwnedJob, $mossSelf.Handle)',
        'AssignProcessToJobObject($mossOwnedJob, [IntPtr]::Zero)',
      ],
    ]) {
      assert.ok(normal.args.at(-1).includes(from));
      const inv = { ...normal, args: normal.args.map((x) => x.replace(from, to)) };
      const r = sync(inv);
      checkFailure(r, name);
      assert.match(
        r.stderr,
        new RegExp(
          `${{ create: 'CreateJobObjectW', limit: 'SetInformationJobObject', assign: 'AssignProcessToJobObject' }[name]} failed`
        )
      );
      assert.equal(fs.existsSync(faultMarker), false);
    }
    const missing = { ...cmd, executable: path.join(root, 'missing-cmd.exe') };
    checkFailure(
      sync(backgroundShellInvocation(command(cmd, 'io', faultMarker, faultNonce), missing, root)),
      'actual missing shell'
    );
    assert.equal(fs.existsSync(faultMarker), false);
    // A real pump exception after launch is a failure; last-handle closure kills any child.
    const pumpMarker = path.join(root, 'pump-no-late-write'),
      pump = backgroundShellInvocation(command(cmd, 'leaf', pumpMarker, randomUUID()), cmd, root);
    const needle =
      '$mossCommand.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())';
    assert.ok(pump.args.at(-1).includes(needle));
    const pumpResult = sync({
      ...pump,
      args: pump.args.map((x) =>
        x.replace(
          needle,
          '$mossCommand.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null.Dispose())'
        )
      ),
    });
    assert.equal(pumpResult.error, undefined);
    assert.equal(pumpResult.status, 1);
    assert.ok(pumpResult.stderr.length > 0);
    await pause(350);
    assert.equal(fs.existsSync(pumpMarker), false);
    function start(name) {
      const marker = path.join(root, name),
        nonce = randomUUID(),
        inv = backgroundShellInvocation(command(cmd, 'parent', marker, nonce), cmd, root);
      const child = cp.spawn(inv.executable, inv.args, {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
      });
      const value = {
        child,
        marker,
        nonce,
        windowsJobOwner: inv.windowsJobOwner,
        out: '',
        err: '',
        closed: false,
      };
      child.stdout.on('data', (x) => (value.out += x));
      child.stderr.on('data', (x) => (value.err += x));
      child.on('close', () => (value.closed = true));
      child.on('error', (e) => (value.error = e));
      launches.push(value);
      return value;
    }
    // Fixed spawn+50ms remains independent of readiness and keeps taskkill's 2s limit.
    const early = start('early-never');
    await pause(50);
    assert.equal(early.windowsJobOwner, true);
    killProc(early);
    await pause(350);
    assert.equal(fs.existsSync(early.marker), false);
    await until(() => early.closed && !alive(early.child.pid), 5000, 'fixed50 close');
    for (const identity of early.out.trim() ? early.out.trim().split('\n').map(JSON.parse) : []) {
      assert.equal(identity.nonce, early.nonce);
      assert.equal(alive(identity.pid), false);
    }
    // Supplemental membership proof, not a readiness replacement for fixed50 above.
    const member = start('member-never');
    await until(
      () => member.out.split('\n').filter(Boolean).length === 2,
      3000,
      'membership ready'
    );
    const identities = member.out.trim().split('\n').map(JSON.parse);
    assert.deepEqual(identities.map((x) => x.mode).sort(), ['leaf', 'parent']);
    for (const i of identities) {
      assert.equal(i.nonce, member.nonce);
      assert.ok(alive(i.pid));
    }
    assert.equal(member.err, '');
    assert.equal(fs.existsSync(member.marker), false);
    assert.equal(member.child.kill(), true);
    await until(
      () => member.closed && identities.every((x) => !alive(x.pid)),
      5000,
      'owner-only Job descendants and stdio close'
    );
    await pause(350);
    assert.equal(fs.existsSync(member.marker), false);
    console.log(
      '[PASS] real Job IO 0+7, native init faults, missing shell/pump failure, fixed50 cancel, owner-only membership; original bounds'
    );
  } finally {
    for (const v of launches) if (!v.closed) v.child.kill();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('.moss-job-contract-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
