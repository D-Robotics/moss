import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../dist/tools/search-tools.js', import.meta.url).href;
for (const kind of ['files', 'code']) {
  for (const mode of [
    'empty-error',
    'partial-error',
    'empty-timeout',
    'partial-timeout',
    'unbounded-error',
  ]) {
    test(
      `${kind}: rg ${mode} keeps the correct fallback decision`,
      {
        skip:
          process.platform === 'win32'
            ? 'POSIX executable fixture; Windows retains its real search integration suite'
            : false,
      },
      async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rg-bound-'));
        try {
          const bin = path.join(root, 'bin');
          const cwd = path.join(root, 'work');
          const search = path.join(root, 'search');
          await Promise.all([bin, cwd, search].map((p) => fs.mkdir(p)));
          const file = path.join(search, 'needle.txt');
          await fs.writeFile(file, 'needle\n');
          const output = kind === 'files' ? file + '\n' : file + ':1:needle\n';
          await fs.writeFile(
            path.join(bin, 'rg'),
            `#!${process.execPath}\n${mode.startsWith('partial') ? `process.stdout.write(${JSON.stringify(output)});` : ''}\n${mode.endsWith('timeout') ? 'setInterval(()=>{},1000);' : 'process.exitCode=2;'}\n`,
            { mode: 0o700 }
          );
          const depth = mode === 'unbounded-error' ? 'undefined' : '2';
          const code = `const m=await import(${JSON.stringify(moduleUrl)}); let incomplete=false; const onIncomplete=()=>{incomplete=true}; const bounded=${kind === 'files' ? `await m.filesWithRg(${JSON.stringify(search)},'*.txt',40,1000,${depth},onIncomplete)` : `await m.grepWithRg({searchDir:${JSON.stringify(search)},pattern:'needle',extensions:null,maxDepth:${depth},limit:40,timeoutMs:1000,displayRoot:${JSON.stringify(search)},caseSensitive:true,contextLines:0,outputMode:'content',onIncomplete})`}; const message=${!mode.endsWith('timeout') && mode !== 'unbounded-error' ? `await m.${kind === 'files' ? 'searchFilesTool' : 'searchCodeTool'}.execute({pattern:'needle',path:'/'},{workspaceDir:${JSON.stringify(cwd)}})` : 'null'}; console.log(JSON.stringify({matches:bounded,incomplete,message}));`;
          const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
          const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.equal(result.status, 0, result.stderr);
          const { matches, incomplete, message } = JSON.parse(result.stdout);
          assert.equal(incomplete, mode !== 'unbounded-error');
          if (message !== null) {
            assert.match(message, /Incomplete bounded search/);
            assert.doesNotMatch(message, /No files found|No matches found/);
          }
          if (mode === 'unbounded-error') assert.equal(matches, null);
          else {
            assert.ok(Array.isArray(matches), 'null starts another walk and renews the budget');
            assert.equal(matches.length, mode.startsWith('partial') ? 1 : 0);
          }
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    );
  }
}
