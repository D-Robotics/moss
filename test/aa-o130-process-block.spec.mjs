#!/usr/bin/env node
/**
 * O130 acceptance A/E (process-level): real `dist/cli.js -p` + local fake
 * OpenAI-compatible model. Every write form the Windows probe showed WRITTEN
 * with exit 0 (Set-Content, `$env:APPDATA`, `$env:MOSS_CONFIG_DIR`, pwsh
 * writers) into Moss's own config dir must now be refused: exit 9, last line
 * 「被拦」/`Blocked by`, file unchanged, JSON recoverable:false. On Windows the
 * host shell is pwsh, so the forms would really run if not gated.
 *
 * Plus the known limitation (PM): a path built INSIDE interpreter code
 * (`node w.js` computing the env name) is not seen pre-exec; L3 post-hoc
 * detection must report it — exit 9, 「已被修改」/modified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const IS_WIN = process.platform === 'win32';

function startFake(steps, finalText) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* ignore */
      }
      const n = (body.messages ?? []).filter((m) => m.role === 'tool').length;
      const chunk = (delta, fr = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.tools && n < steps.length) {
        const s = steps[n];
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: s.name, arguments: JSON.stringify(s.args) },
              },
            ],
          })
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: finalText }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function run(args, env, cwd, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

/**
 * dir: 'appdata' → Moss config dir is %APPDATA%\moss (on Windows MOSS_CONFIG_DIR
 *   is unset so Moss resolves it itself; elsewhere MOSS_CONFIG_DIR points there);
 *   'custom' → MOSS_CONFIG_DIR is a separate dir.
 * withHome: Git-Bash-like env with HOME set (probe ran both).
 */
async function scenario({
  lang = 'en',
  command,
  files = {},
  dir = 'appdata',
  withHome = true,
  json = false,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o130-'));
  const home = path.join(root, 'home');
  const appdata = path.join(home, 'AppData', 'Roaming');
  const proj = path.join(root, 'proj');
  const cfg = dir === 'custom' ? path.join(root, 'custom-moss') : path.join(appdata, 'moss');
  for (const d of [home, appdata, proj, cfg]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  fs.writeFileSync(path.join(proj, 'evil.json'), '{"PWN":1}\n');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(proj, f), c);
  fs.writeFileSync(path.join(cfg, 'credentials'), 'ORIG\n');
  const server = await startFake(
    [{ name: 'exec', args: { command: command({ cfg, appdata }) } }],
    lang === 'zh' ? '全部完成。' : 'All done.'
  );
  const port = server.address().port;
  const env = {
    PATH: process.env.PATH,
    USERPROFILE: home,
    APPDATA: appdata,
    ...(withHome ? { HOME: home } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(dir === 'custom' || !IS_WIN ? { MOSS_CONFIG_DIR: cfg } : {}),
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, proj);
  const cfgBefore = fs.readFileSync(path.join(cfg, 'config.json'), 'utf8');
  const r = await run(
    [
      '--trust-workspace',
      '--lang',
      lang,
      ...(json ? ['--output-format', 'json'] : []),
      '-p',
      'run it',
    ],
    env,
    proj
  );
  server.closeAllConnections?.();
  server.close();
  const cfgAfter = fs.readFileSync(path.join(cfg, 'config.json'), 'utf8');
  const credAfter = fs.readFileSync(path.join(cfg, 'credentials'), 'utf8');
  fs.rmSync(root, { recursive: true, force: true });
  const last = r.out.trim().split('\n').pop() ?? '';
  return {
    ...r,
    last,
    cfgChanged: cfgAfter !== cfgBefore,
    credChanged: credAfter !== 'ORIG\n',
    cfg,
  };
}

// Probe rows (spec table) + QA forms. `dir` decides which config dir is live.
const WIN_FORMS = [
  [
    'Set-Content abs config.json',
    'appdata',
    ({ cfg }) => `Set-Content -Path '${path.join(cfg, 'config.json')}' -Value PWN`,
  ],
  [
    'Set-Content abs credentials',
    'appdata',
    ({ cfg }) => `Set-Content -Path '${path.join(cfg, 'credentials')}' -Value PWN`,
  ],
  ['$env:APPDATA config.json', 'appdata', () => 'echo PWN > "$env:APPDATA\\moss\\config.json"'],
  [
    '$env:APPDATA credentials',
    'appdata',
    () => 'Set-Content "$env:APPDATA\\moss\\credentials" PWN',
  ],
  [
    '$env:MOSS_CONFIG_DIR config.json',
    'custom',
    () => 'echo PWN > "$env:MOSS_CONFIG_DIR\\config.json"',
  ],
  [
    'Set-Content MOSS_CONFIG_DIR credentials',
    'custom',
    ({ cfg }) => `Set-Content '${path.join(cfg, 'credentials')}' PWN`,
  ],
  ['sc alias, $ENV: mixed case', 'custom', () => 'sc $ENV:moss_config_dir/credentials PWN'],
  ['Out-File pipe', 'appdata', () => "'PWN' | Out-File -FilePath $env:APPDATA/moss/config.json"],
  [
    'Tee-Object',
    'appdata',
    () => '\'PWN\' | Tee-Object -FilePath "$env:APPDATA\\moss\\credentials"',
  ],
  [
    'Copy-Item -Destination',
    'custom',
    () => 'Copy-Item evil.json -Destination "$env:MOSS_CONFIG_DIR\\config.json"',
  ],
  [
    '[IO.File]::WriteAllText',
    'appdata',
    () => '[IO.File]::WriteAllText("$env:APPDATA\\moss\\config.json", "PWN")',
  ],
  ['cd $env + relative sc', 'appdata', () => 'cd $env:APPDATA\\moss; sc credentials PWN'],
  ['%APPDATA%', 'appdata', () => 'echo PWN > %APPDATA%\\moss\\config.json'],
  [
    'same-line reassigned $env (unresolvable)',
    'appdata',
    () => '$env:X=\'a\'; Set-Content "$env:X\\config.json" PWN',
  ],
  [
    'unresolvable $p',
    'appdata',
    () => '$p = Join-Path $env:APPDATA moss\\config.json; Set-Content $p PWN',
  ],
];

for (const withHome of IS_WIN ? [true, false] : [true]) {
  for (const [name, dir, command] of WIN_FORMS) {
    test(`O130 -p blocks ${name} (${withHome ? 'HOME set' : 'native'})`, async () => {
      const r = await scenario({ command, dir, withHome });
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}\n${r.err.slice(-800)}`);
      assert.match(r.last, /^Incomplete.*Blocked by/, r.last);
      assert.ok(!r.cfgChanged, 'config.json unchanged');
      assert.ok(!r.credChanged, 'credentials unchanged');
    });
  }
}

for (const lang of ['zh', 'en']) {
  test(`O130 [${lang}] blocked line + stderr notice + json recoverable:false`, async () => {
    const command = () => 'Set-Content "$env:APPDATA\\moss\\config.json" PWN';
    const r = await scenario({ lang, command });
    assert.equal(r.code, 9);
    assert.match(
      r.last,
      lang === 'zh'
        ? /^未完成.*被拦：.*moss[\\/]config\.json/
        : /^Incomplete.*Blocked by: .*moss[\\/]config\.json/,
      r.last
    );
    assert.match(r.err, lang === 'zh' ? /\[moss\] 已拦截/ : /\[moss\] Blocked/, r.err.slice(-600));
    const j = await scenario({ lang, command, json: true });
    assert.equal(j.code, 9);
    const obj = JSON.parse(j.out.trim().split('\n').pop());
    assert.equal(obj.subtype, 'error_during_execution', j.out.slice(-400));
    assert.equal(obj.recoverable, false, j.out.slice(-400));
    assert.ok(!j.cfgChanged);
  });

  test(`O130 [${lang}] unresolvable write target: reason + next step`, async () => {
    const r = await scenario({
      lang,
      command: () => 'Set-Content -Path $env:O130_NOT_SET\\config.json -Value PWN',
    });
    assert.equal(r.code, 9, r.last);
    assert.match(
      r.err,
      lang === 'zh'
        ? /无法确定 `\$env:O130_NOT_SET\\config\.json` 指向的路径.*改用字面路径/
        : /cannot tell where `\$env:O130_NOT_SET\\config\.json` points.*literal path/,
      r.err.slice(-800)
    );
  });
}

// Known limitation → L3 (PM): a path computed inside the interpreter (env NAME
// built at runtime) is not visible pre-exec. L3 (protected-path-snapshot.ts)
// does NOT watch Moss's config dir today, so this write lands with exit 0 on
// every OS → per PM this is a separate P1 (L3 must watch config.json /
// credentials), not covered by O130. Kept as `todo` so the gap stays visible in
// every CI log and turns into a real assertion when that P1 lands.
test(
  'O130 L3 gap: node script building the config path at runtime → should exit 9 「已被修改」',
  { todo: 'L3 does not watch the Moss config dir — separate P1 (see PR body)' },
  async () => {
    const script =
      "const p=require('path');const n=['MOSS','CONFIG','DIR'].join('_');" +
      "const d=process.env[n];require('fs').writeFileSync(p.join(d,'credentials'),'PWN');\n";
    const r = await scenario({
      command: () => 'node w.cjs',
      files: { 'w.cjs': script },
      dir: 'custom',
    });
    console.log(
      `# O130-L3 ${process.platform}: exit=${r.code} credChanged=${r.credChanged} last=${r.last}`
    );
    assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
    assert.match(r.last, /modified|已被修改/, r.last);
  }
);
