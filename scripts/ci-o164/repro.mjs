// CI-only: O164 attack repro against whatever src was built (old main or fix).
// win32: .env SystemRoot=<WS>\fake with Moss started without SystemRoot, cmd host
// shell, background exec → does <WS>\fake\System32\WindowsPowerShell\v1.0\powershell.exe run?
// posix: PATH=. / "" / "::" → how many times do workspace git/node/sh/ls/npx run?
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scenario } from '../../test/o121-safety-block-outcome.spec.mjs';

const marks = (d) => fs.readdirSync(d).filter((f) => f.startsWith('MARK-'));
const count = (d) =>
  marks(d).reduce((n, f) => n + fs.readFileSync(path.join(d, f), 'utf8').split(/\r?\n/).filter(Boolean).length, 0);

if (process.platform === 'win32') {
  const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o164r-mark-'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o164r-fake-')), 'fake.exe');
  const code = `using System; using System.IO;
public class Fake { public static int Main(string[] a) {
 File.AppendAllText(Path.Combine(${JSON.stringify(markDir)}, "MARK-powershell.txt"), Environment.CommandLine + "\\r\\n");
 Console.WriteLine("FAKE-POWERSHELL-RAN"); return 0; } }`;
  const lit = (v) => `'${v.replaceAll("'", "''")}'`;
  const script = `Add-Type -TypeDefinition ${lit(code)} -OutputAssembly ${lit(out)} -OutputType ConsoleApplication`;
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const preload = path.join(markDir, 'strip.cjs');
  const log = path.join(markDir, 'preload.log');
  fs.writeFileSync(preload, `for (const k of Object.keys(process.env)) if (/^(systemroot|windir)$/i.test(k)) delete process.env[k];
require('node:fs').appendFileSync(${JSON.stringify(log)}, 'SystemRoot=' + String(process.env.SystemRoot) + '\\n');\n`);
  const noPwsh = (process.env.PATH ?? '').split(';').filter((d) => !(d && fs.existsSync(path.join(d, 'pwsh.exe')))).join(';');
  const r = await scenario({
    lang: 'en', json: true,
    steps: [
      { name: 'exec', args: { command: 'echo o164-bg-ok> bg-ok.txt', run_in_background: true } },
      { name: 'exec', args: { command: 'for /L %i in (1,1,60) do @if exist bg-ok.txt (type bg-ok.txt & echo found-at-poll-%i & exit 0) else ping -n 2 127.0.0.1 >NUL', timeout_ms: 70000 } },
    ],
    finalText: 'Done.',
    extraEnv: { PATH: noPwsh, NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` },
    prepare: ({ proj }) => {
      const dir = path.join(proj, 'fake', 'System32', 'WindowsPowerShell', 'v1.0');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(out, path.join(dir, 'powershell.exe'));
      fs.writeFileSync(path.join(proj, '.env'), `SystemRoot=${path.join(proj, 'fake')}\nwindir=${path.join(proj, 'fake')}\n`);
    },
  });
  const tr = r.toolResults.join('\n');
  if (!fs.existsSync(log)) console.log(r.err.slice(-1500));
  console.log(`preload: ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n')[0] : 'NOT RUN'}`);
  console.log(`fake powershell runs: ${count(markDir)}`);
  for (const f of marks(markDir)) console.log(`  ${f}: ${fs.readFileSync(path.join(markDir, f), 'utf8').trim().slice(0, 300)}`);
  console.log(`bg file read back: ${/o164-bg-ok/.test(tr)} ${(tr.match(/found-at-poll-\d+/) ?? ['(not found)'])[0]}`);
  console.log(`O164 ITEM1 VERDICT: ${count(markDir) > 0 ? 'REPRODUCED (fake powershell ran)' : 'NOT REPRODUCED'}`);
} else {
  let total = 0;
  for (const PATH of ['.', '', '::']) {
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o164r-mark-'));
    await scenario({
      lang: 'en', json: true,
      hooks: { PreToolUse: [{ command: 'git --version' }] },
      steps: [{ name: 'exec', args: { command: 'git status; node -v; ls' } }],
      finalText: 'Done.',
      extraEnv: { PATH },
      prepare: ({ proj }) => {
        for (const n of ['git', 'node', 'sh', 'ls', 'npx']) {
          const f = path.join(proj, n);
          fs.writeFileSync(f, `#!/bin/sh\necho "ran $*" >> ${JSON.stringify(path.join(markDir, `MARK-${n}`))}\necho FAKE\n`);
          fs.chmodSync(f, 0o755);
        }
      },
    });
    const n = count(markDir);
    total += n;
    console.log(`PATH=${JSON.stringify(PATH)}: workspace programs ran ${n} time(s) ${marks(markDir).join(' ')}`);
  }
  console.log(`O164 ITEM2 VERDICT: ${total > 0 ? `REPRODUCED (${total} workspace runs)` : 'NOT REPRODUCED'}`);
}
