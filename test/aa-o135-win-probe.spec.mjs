#!/usr/bin/env node
/**
 * TEMPORARY CI-ONLY PROBE — DO NOT MERGE (O135 / O137).
 * Runs only on win32 (skipped elsewhere). Logs results with a "PROBE:" prefix
 * and never fails: every case is wrapped in try/catch and asserts nothing.
 * No network calls; no environment values are printed or sent anywhere.
 * O137 writes a dummy credential into a temp HOME/USERPROFILE/APPDATA only;
 * icacls output is reduced to ACL lines with non-builtin principals redacted.
 */
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const M = 'moss_o135_missing_cmd';
const log = (k, v) => {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  console.log(`PROBE: ${k} = ${s}`);
};
const safe = async (name, fn) => {
  try { await fn(); } catch (e) { log(`${name} ERROR`, String(e?.message ?? e).slice(0, 300)); }
};

const KEEP = /^(NT AUTHORITY\\SYSTEM|SYSTEM|BUILTIN\\Administrators|Administrators|BUILTIN\\Users|Users|Everyone|NT AUTHORITY\\Authenticated Users|CREATOR OWNER)$/i;
function redactAcl(out, target) {
  const lines = [];
  for (let line of String(out).split(/\r?\n/)) {
    if (line.startsWith(target)) line = line.slice(target.length);
    line = line.trim();
    const m = /^(.+?):(\(.*)$/.exec(line);
    if (!m) continue; // only ACL lines (principal:(perms))
    const who = m[1].trim();
    lines.push(`${KEEP.test(who) ? who : '<user>'}:${m[2]}`);
  }
  return lines;
}

test('O135/O137 Windows probe (log-only, never fails)', { skip: !isWin && 'win32-only probe' }, async () => {
  const raw = (name, cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
    log(name, { status: r.status, signal: r.signal, error: r.error?.code, stderr: (r.stderr || '').slice(0, 200) });
  };
  await safe('raw cmd /d /s /c', () => raw('raw cmd /d /s /c "missing" (hook form)', 'cmd.exe', ['/d', '/s', '/c', `"${M}"`], { windowsVerbatimArguments: true }));
  await safe('raw cmd /c', () => raw('raw cmd /c missing', 'cmd.exe', ['/c', M]));
  await safe('raw pwsh', () => raw('raw pwsh -Command missing (exec form)', 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', M]));
  await safe('raw direct', () => raw('raw spawn missing directly', M, []));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o135-'));

  await safe('hooks', async () => {
    const { createConfiguredHookCallbacks, hookShell } = await import('../dist/cli/hooks.js');
    await safe('hookShell', () => log('hookShell(missing)', hookShell(M)));
    const req = { tool: { name: 'write_file' }, input: {}, sessionKey: 's', runId: 'r' };
    const exitCmd = (n) => `node -e "process.exit(${n})"`; // valid under cmd.exe (double quotes)
    const cases = {};
    for (const fmt of ['moss', 'claude']) {
      const f = fmt === 'claude' ? { format: 'claude' } : {};
      cases[`${fmt}/missing`] = { command: M, ...f };
      for (const n of [0, 1, 2]) cases[`${fmt}/exit${n} (control)`] = { command: exitCmd(n), ...f };
    }
    for (const [name, h] of Object.entries(cases)) {
      await safe(`hook ${name}`, async () => {
        const cbs = createConfiguredHookCallbacks({ PreToolUse: [h] }, { workspaceDir: dir });
        let out;
        try { out = await cbs.onBeforeToolExec(req); } catch (e) { out = { threw: String(e?.message ?? e).slice(0, 300) }; }
        log(`hook ${name}`, out ?? 'undefined (=> tool ALLOWED)');
      });
    }
  });

  await safe('exec', async () => {
    const { execTool } = await import('../dist/tools/builtin.js');
    const { executeOneToolCall } = await import('../dist/core/tools/execute-tool-call.js');
    const { classifyShellToolFailure } = await import('../dist/core/tools/tool-loop-guard.js');
    const deps = { toolsForRun: [execTool], toolCtx: { workspaceDir: dir, sessionKey: 'p' }, sessionKey: 'p',
      abortSignal: new AbortController().signal, toolTimeoutMs: 30000, enableHeartbeat: false,
      heartbeatIntervalMs: 60000, skipHeartbeatToolNames: new Set(['exec']), push() {} };
    for (const c of [M, `cmd /c ${M}`]) {
      await safe(`exec ${c}`, async () => {
        const o = await executeOneToolCall({ id: 'x', name: 'exec', input: { command: c } }, deps);
        const text = JSON.stringify(o).slice(0, 400);
        log(`exec ${c}`, text);
        const t = typeof o?.result === 'string' ? o.result : (o?.content ?? text);
        log(`exec ${c} classify`, classifyShellToolFailure(String(t)));
      });
    }
  });

  // O137: credentials ACL. Isolated temp home; env is built from scratch (no process.env copy).
  await safe('O137', async () => {
    const { saveUserModelConfig } = await import('../dist/cli/first-run.js');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'o137-home-'));
    const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    const p = saveUserModelConfig({ provider: 'openai-compatible', model: 'probe', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-probe-o137-dummy', env });
    log('O137 saved path (relative to temp home)', path.relative(home, p));
    log('O137 stat mode', (fs.statSync(p).mode & 0o777).toString(8));
    for (const [label, f] of [['file', p], ['dir', path.dirname(p)]]) {
      const r = spawnSync('icacls', [f], { encoding: 'utf8', timeout: 30000 });
      log(`O137 icacls ${label}`, { status: r.status, acl: redactAcl(r.stdout, f) });
    }
    log('O137 dir entries', fs.readdirSync(path.dirname(p)));
  });
});
