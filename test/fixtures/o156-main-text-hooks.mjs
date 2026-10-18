// O156 QA #149 R2-F1: hook verdicts for English "not recognized" texts that
// main's detector accepted (no space after the colon, no article).
// Usage: node o156-main-text-hooks.mjs <distDir> <workDir>
// Off Windows, the win32 decision code is exercised by setting
// process.platform to win32 and COMSPEC to a /bin/sh stand-in for cmd.exe
// (`/d /s /c "<command> & exit /b"`). On Windows the real cmd.exe runs.
// Prints one JSON line: { rows: [{ format, variant, Stop, StopHooks, UPS, PreToolUse, PermReq, reasons }] }.
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
const X = 'moss-o156-missing-cmd';
const TAIL = 'cmdlet, function, script file, or executable program.\r\n';
const VARIANTS = {
  // pwsh 7 as it really prints it (control).
  real: `${X}: The term '${X}' is not recognized as a name of a ${TAIL}`,
  nospace: `${X}:The term '${X}' is not recognized as a name of a ${TAIL}`,
  noarticle: `${X}: The term '${X}' is not recognized as name of a ${TAIL}`,
  'nospace+noarticle': `${X}:The term '${X}' is not recognized as name of a ${TAIL}`,
  'nospace+the': `${X}:The term '${X}' is not recognized as the name of a ${TAIL}`,
};
const hookJs = path.join(work, 'hook.mjs');
// argv: variant exitCode. allow on stdout; stderr = the variant text.
fs.writeFileSync(
  hookJs,
  `const VARIANTS = ${JSON.stringify(VARIANTS)};
const [v, code] = [process.argv[2], Number(process.argv[3])];
process.stdout.write('{"decision":"approve"}\\n', () =>
  process.stderr.write(VARIANTS[v], () => process.exit(code)));
`
);
const { createConfiguredHookCallbacks, setLifecycleHookRunner, runStopHooks } = await import(
  pathToFileURL(path.join(dist, 'cli', 'hooks.js')).href
);
const quote = (s) => `"${s}"`;
const settle = (p, blocked) =>
  p.then(
    (x) => [blocked(x) ? 'BLOCK' : 'ALLOW', String(x?.reason ?? '')],
    (e) => [`THROW(${String(e?.message ?? e).slice(-40)})`, '']
  );
const rows = [];
for (const format of ['claude', 'moss']) {
  for (const variant of Object.keys(VARIANTS)) {
    const hook = {
      command: `${quote(process.execPath)} ${quote(hookJs)} ${variant} 1`,
      ...(format === 'claude' ? { format: 'claude' } : {}),
    };
    const cbs = createConfiguredHookCallbacks(
      { Stop: [hook], UserPromptSubmit: [hook], PreToolUse: [hook], PermissionRequest: [hook] },
      { workspaceDir: work }
    );
    setLifecycleHookRunner({
      runStop: (i) => cbs.runStop(i),
      runSubagentStop: async () => {},
      runNotification: async () => {},
    });
    const r = {
      Stop: await settle(cbs.runStop({ stopReason: 'end_turn' }), (x) => x.blocked),
      StopHooks: await settle(runStopHooks({ stopReason: 'end_turn' }), (x) => x.blocked),
      UPS: await settle(cbs.runUserPromptSubmit('hi'), (x) => x.blocked),
      PreToolUse: await settle(
        cbs.onBeforeToolExec({ tool: { name: 'exec' }, input: { command: 'x' } }),
        (x) => !x.approved
      ),
      PermReq: await settle(
        cbs.runPermissionRequest({ toolName: 'exec', input: {} }),
        (x) => x.denied
      ),
    };
    const row = { format, variant, reasons: {} };
    for (const [k, [verdict, reason]] of Object.entries(r)) {
      row[k] = verdict;
      row.reasons[k] = reason.slice(0, 300);
    }
    rows.push(row);
  }
}
process.stdout.write(JSON.stringify({ rows }) + '\n');
