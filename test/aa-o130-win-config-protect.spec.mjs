// O130: Windows/PowerShell forms that write Moss's own config dir must be gated
// (Windows CI probe on ci/win-o94-probe showed them WRITTEN with exit 0).
// Platform-independent: `$env:` / `%VAR%` / process.env forms are expanded from ctx.env.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o130-'));
const profile = path.join(root, 'profile');
const appdata = path.join(profile, 'AppData', 'Roaming');
const cfg = path.join(appdata, 'moss');
const custom = path.join(root, 'custom-moss');
const ws = path.join(root, 'ws');
for (const d of [cfg, custom, ws]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const env = { USERPROFILE: profile, APPDATA: appdata, MOSS_CONFIG_DIR: custom };
const ctx = { cwd: ws, workspaceRoot: ws, configDirs: [cfg, custom], env, home: profile };
const cats = (cmd) => findShellProtectedWrites(cmd, ctx).map((h) => h.category);

const BLOCK = [
  `Set-Content -Path '${path.join(cfg, 'config.json')}' -Value PWN`,
  `Set-Content -Path '${path.join(cfg, 'credentials')}' -Value PWN`,
  `Add-Content ${path.join(custom, 'config.json')} PWN`,
  `Out-File -FilePath ${path.join(custom, 'credentials')}`,
  'echo PWN > "$env:APPDATA/moss/config.json"',
  'echo PWN > "$env:APPDATA/moss/credentials"',
  'echo PWN > "${env:APPDATA}/moss/config.json"',
  'echo PWN > "$env:MOSS_CONFIG_DIR/config.json"',
  'echo PWN > "$env:appdata/moss/config.json"',
  'echo PWN > %APPDATA%/moss/config.json',
  `node -e "require('fs').writeFileSync(process.env.APPDATA+'/moss/config.json','PWN')"`,
  `node -e "require('fs').writeFileSync(process.env['MOSS_CONFIG_DIR']+'/credentials','PWN')"`,
  `python -c "open(os.environ['APPDATA']+'/moss/config.json','w').write('x')"`,
];
for (const cmd of BLOCK) {
  test(`O130 gates: ${cmd}`, () => {
    assert.ok(cats(cmd).includes('moss-config'), `${cmd} -> ${JSON.stringify(cats(cmd))}`);
  });
}

const ALLOW = [
  'Get-Content "$env:APPDATA/moss/config.json"',
  'echo hi > out.txt',
  `Set-Content -Path '${path.join(ws, 'notes.txt')}' -Value x`,
  'echo PWN > "$env:APPDATA/other-app/config.json"',
];
for (const cmd of ALLOW) {
  test(`O130 does not gate: ${cmd}`, () => {
    assert.ok(!cats(cmd).includes('moss-config'), `${cmd} -> ${JSON.stringify(cats(cmd))}`);
  });
}
