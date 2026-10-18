// O156 QA #149 F1: hook verdicts for an oversized first stderr token.
// Usage: node o156-hook-verdicts.mjs <distDir> <workDir>
// Off Windows, the win32 decision code is exercised by setting
// process.platform to win32 and COMSPEC to a /bin/sh stand-in for cmd.exe
// (`/d /s /c "<command> & exit /b"`). On Windows the real cmd.exe runs.
// Prints one JSON line: { rows: [{ format, exit, head, Stop, UPS, PreToolUse, PermReq }] }.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, work] = process.argv.slice(2);
if (process.platform !== 'win32') {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const fake = path.join(work, 'fakecmd.sh');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\nc="$4"; c="${c#\\"}"; c="${c% & exit /b\\"}"\nexec /bin/sh -c "$c"\n'
  );
  fs.chmodSync(fake, 0o755);
  process.env.COMSPEC = fake;
}
const hookJs = path.join(work, 'hook.mjs');
// argv: exitCode headLen headChar. allow on stdout; stderr = <char * len> + ' : policy says no'.
fs.writeFileSync(
  hookJs,
  `const [code, len, ch] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
process.stdout.write('{"decision":"approve"}\\n');
process.stderr.write((len ? ch.repeat(len) + ' : ' : '') + 'policy says no\\n', () => process.exit(code));
`
);
const { createConfiguredHookCallbacks, setLifecycleHookRunner, runStopHooks } = await import(
  pathToFileURL(path.join(dist, 'cli', 'hooks.js')).href
);
const quote = (s) => `"${s}"`;
const verdict = (p, blocked) =>
  p.then(
    (x) => (blocked(x) ? 'BLOCK' : 'ALLOW'),
    (e) => `THROW(${String(e?.message ?? e).slice(-40)})`
  );
const rows = [];
for (const format of ['claude', 'moss']) {
  for (const exit of [1, 2]) {
    for (const [len, ch] of [
      [0, 'A'],
      [40000, 'A'],
      [40000, '('],
      [200000, '.'],
    ]) {
      const hook = {
        command: `${quote(process.execPath)} ${quote(hookJs)} ${exit} ${len} ${ch === '(' ? 'P' : ch}`,
        ...(format === 'claude' ? { format: 'claude' } : {}),
      };
      // '(' is passed as P and mapped back so the shell never sees it.
      if (ch === '(') hook.command = hook.command.replace(/ P$/, ' "("');
      const cfg = {
        Stop: [hook],
        UserPromptSubmit: [hook],
        PreToolUse: [hook],
        PermissionRequest: [hook],
      };
      const cbs = createConfiguredHookCallbacks(cfg, { workspaceDir: work });
      setLifecycleHookRunner({
        runStop: (i) => cbs.runStop(i),
        runSubagentStop: async () => {},
        runNotification: async () => {},
      });
      rows.push({
        format,
        exit,
        head: len ? `${ch}*${len}` : 'none',
        Stop: await verdict(runStopHooks({ stopReason: 'end_turn' }), (x) => x.blocked),
        UPS: await verdict(cbs.runUserPromptSubmit('hi'), (x) => x.blocked),
        PreToolUse: await verdict(
          cbs.onBeforeToolExec({ tool: { name: 'exec' }, input: { command: 'x' } }),
          (x) => !x.approved
        ),
        PermReq: await verdict(
          cbs.runPermissionRequest({ toolName: 'exec', input: {} }),
          (x) => x.denied
        ),
      });
    }
  }
}
process.stdout.write(JSON.stringify({ rows }) + '\n');
