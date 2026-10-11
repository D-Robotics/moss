#!/usr/bin/env node
/** A timed-out exec says it timed out. A signal kill does not say "exit null". */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';

import { execTool } from '../dist/tools/builtin.js';
import { ProcessError, runProcess } from '../dist/utils/run-process.js';
import { resolveHostShell } from '../dist/utils/host-shell.js';

{
  let caught;
  try {
    await runProcess('sleep', { args: ['2'], timeout: 200 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProcessError);
  assert.equal(caught.timedOut, true);
  assert.match(caught.message, /^timed out after 200ms$/);
}

{
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-timeout-'));
  const text = await execTool.execute(
    { command: 'sleep 2', timeout_ms: 200 },
    { workspaceDir, sessionKey: 'timeout', abortSignal: new AbortController().signal }
  );
  assert.match(text, /timed out after 200ms \(raise timeout_ms or use exec_background\)/);
  assert.doesNotMatch(text, /exit 1/);
  assert.doesNotMatch(text, /Command failed/);
  assert.doesNotMatch(text, /exit null/);
}

if (process.platform !== 'win32') {
  let caught;
  try {
    await runProcess(process.execPath, {
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProcessError);
  assert.equal(caught.signal, 'SIGTERM');
  assert.equal(caught.exitCode, null);
  assert.match(caught.message, /killed by SIGTERM/);
  assert.doesNotMatch(caught.message, /exit null/);
}

if (process.platform !== 'win32') {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-signal-'));
  const text = await execTool.execute(
    { command: 'kill -TERM $$' },
    { workspaceDir, sessionKey: 'signal', abortSignal: new AbortController().signal }
  );
  assert.match(text, /killed by SIGTERM/);
  assert.doesNotMatch(text, /exit null/);
  assert.doesNotMatch(text, /Command failed \(exit/);
}

if (process.platform === 'win32') {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-native-'));
  const script = path.join(workspaceDir, "self terminate ü's.cjs");
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const [mode,nonce,marker]=process.argv.slice(2);fs.writeSync(1,JSON.stringify({nonce,pid:process.pid,mode})+'\\n');if(mode==='signal'){process.kill(process.pid,'SIGTERM');fs.writeFileSync(marker,'unreachable');}else if(mode==='kill-exception'){process.kill(process.pid,'MOSS_UNKNOWN_SIGNAL');fs.writeFileSync(marker,'unreachable');}else if(mode==='write'){fs.writeFileSync(marker,'positive');process.exit(0);}else{process.exit(Number(mode));}`
  );
  const originalSpawn = cp.spawn;
  let nativeChild;
  cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    if (args[0] === process.execPath && args[1]?.[0] === script) nativeChild = child;
    return child;
  };
  syncBuiltinESMExports();
  const assertIdentity = (stdout, nonce, mode, marker, actualPid) => {
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith('{"nonce":'));
    const identity = JSON.parse(line);
    assert.equal(identity.nonce, nonce);
    assert.equal(identity.mode, mode);
    assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
    if (actualPid !== undefined) assert.equal(identity.pid, actualPid);
    assert.throws(
      () => process.kill(identity.pid, 0),
      (error) => error.code === 'ESRCH'
    );
    if (mode === 'write') assert.equal(fs.readFileSync(marker, 'utf8'), 'positive');
    else
      assert.equal(
        fs.existsSync(marker),
        false,
        'termination must prevent the unreachable mutation'
      );
    return line;
  };
  try {
    // Actual Node22/24 native probes establish exit1/null for Windows self-SIGTERM.
    // Exact outcomes plus live-PID/nonce checks must not accept a launch failure.
    for (const mode of ['0', '7', 'signal', 'write']) {
      const nonce = randomUUID();
      const marker = path.join(workspaceDir, `${nonce}.txt`);
      nativeChild = undefined;
      let result;
      try {
        result = await runProcess(process.execPath, { args: [script, mode, nonce, marker] });
        assert.ok(mode === '0' || mode === 'write', 'a real failing child must reject');
        assert.equal(result.exitCode, 0);
      } catch (error) {
        assert.ok(error instanceof ProcessError);
        assert.ok(mode === '7' || mode === 'signal');
        assert.equal(error.exitCode, mode === '7' ? 7 : 1);
        assert.equal(error.signal, null);
        assert.equal(error.timedOut, false);
        assert.equal(error.message, `Process exited with code ${error.exitCode}`);
        assert.doesNotMatch(error.message, /exit null|timed out|killed by/);
        result = error;
      }
      assert.ok(nativeChild?.pid, 'the observed real native spawn must have a PID');
      assert.equal(result.stderr, '', 'a JS/launch exception must not masquerade as self-SIGTERM');
      assertIdentity(result.stdout, nonce, mode, marker, nativeChild.pid);
    }
    const exceptionNonce = randomUUID();
    const exceptionMarker = path.join(workspaceDir, `${exceptionNonce}.txt`);
    await assert.rejects(
      runProcess(process.execPath, {
        args: [script, 'kill-exception', exceptionNonce, exceptionMarker],
      }),
      (error) => {
        assert.ok(error instanceof ProcessError);
        assert.equal(error.exitCode, 1);
        assert.equal(error.signal, null);
        assert.match(error.stderr, /ERR_UNKNOWN_SIGNAL/);
        assertIdentity(
          error.stdout,
          exceptionNonce,
          'kill-exception',
          exceptionMarker,
          nativeChild.pid
        );
        assert.throws(() => assert.equal(error.stderr, ''), { code: 'ERR_ASSERTION' });
        return true;
      }
    );
    await assert.rejects(
      runProcess(path.join(workspaceDir, 'missing-native.exe'), { args: [] }),
      (error) => error.code === 'ENOENT' && !(error instanceof ProcessError)
    );

    const shell = resolveHostShell();
    for (const mode of ['0', '7', 'signal']) {
      const nonce = randomUUID();
      const marker = path.join(workspaceDir, `${nonce}.txt`);
      const command = `${shell.kind === 'pwsh' ? '& ' : ''}"${process.execPath}" "${script}" ${mode} "${nonce}" "${marker}"${shell.kind === 'pwsh' ? '; exit $LASTEXITCODE' : ''}`;
      const text = await execTool.execute(
        { command },
        { workspaceDir, sessionKey: 'native-signal', abortSignal: new AbortController().signal }
      );
      if (mode === '0') assert.doesNotMatch(text, /Command failed/);
      else assert.match(text, new RegExp(`^Command failed \\(exit ${mode === '7' ? 7 : 1}\\):`));
      assert.doesNotMatch(text, /exit null|timed out|killed by SIGTERM/);
      const identityLine = assertIdentity(text, nonce, mode, marker);
      assert.equal(
        text,
        mode === '0'
          ? identityLine
          : `Command failed (exit ${mode === '7' ? 7 : 1}):\n${identityLine}`,
        'a shell/JS exception or launcher output must not masquerade as self-SIGTERM'
      );
    }
  } finally {
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    assert.equal(path.dirname(path.resolve(workspaceDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspaceDir).startsWith('moss-exec-native-'));
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

console.log('[PASS] exec timeout');
