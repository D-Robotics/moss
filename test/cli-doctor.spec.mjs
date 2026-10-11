#!/usr/bin/env node
/**
 * Doctor command — tested from the user's perspective:
 * what does the health check tell the user about their environment.
 */
import assert from 'node:assert/strict';

import {
  cliDoctorHasFailure,
  renderMossRuntimeDoctorLines,
  renderNodeDoctorLine,
  renderSearchDoctor,
} from '../dist/cli/doctor.js';
import { clearUiLanguage, installUiLanguage } from '../dist/utils/ui-language.js';

// ─── cliDoctorHasFailure — detects failures in the report ────────────────────

{
  // A passing report has no failures
  const passing = ['  ok  node  v22.0.0', '  ok  model  deepseek-v4-pro'].join('\n');
  assert.equal(cliDoctorHasFailure(passing), false, 'report with only "ok" lines has no failure');
}

{
  // A report with a fail line triggers failure detection
  const failing = [
    '  ok  node  v22.0.0',
    '  fail  model  no model configured — run /model to select one',
  ].join('\n');
  assert.equal(
    cliDoctorHasFailure(failing),
    true,
    'report with a "fail" line is detected as failing'
  );
}

{
  // Empty report is not a failure
  assert.equal(cliDoctorHasFailure(''), false, 'empty report has no failure');
}

{
  // "fail" in a description (not as a line marker) should not trigger
  const deceptive = '  ok  api  connection stable (fail-safe mode active)';
  assert.equal(
    cliDoctorHasFailure(deceptive),
    false,
    '"fail" in description text does not trigger failure detection'
  );
}

// ─── renderNodeDoctorLine — Node.js version display ──────────────────────────

{
  // A sufficiently new version passes the check
  const line = renderNodeDoctorLine('v22.16.0');
  assert.ok(line.includes('v22.16.0'), 'shows the Node version');
  assert.ok(line.includes('node'), 'labels it as node');
  assert.ok(line.includes('ok'), 'v22.16.0 passes the minimum requirement');
  assert.ok(!line.includes('fail'), 'v22.16.0 does not show fail');
}

{
  // Old Node versions should fail the check
  const line = renderNodeDoctorLine('v18.0.0');
  assert.ok(line.includes('v18.0.0'), 'shows the old version in the report');
  assert.ok(line.includes('fail'), 'v18.0.0 is below minimum and shows fail');
}

{
  // The default (current process version) renders without crashing
  const line = renderNodeDoctorLine();
  assert.ok(
    typeof line === 'string' && line.length > 0,
    'renders current Node version without crashing'
  );
  assert.ok(line.includes('node'), 'output is labeled as node');
}

// ─── renderSearchDoctor — search backend availability ───────────────────────

{
  // rg available → ok line, no failure
  const line = renderSearchDoctor(true);
  assert.ok(line.includes('search'), 'labels the line as search');
  assert.ok(line.includes('ok'), 'rg available renders as ok');
  assert.ok(!line.includes('warn'), 'available is not a warn');
  assert.equal(cliDoctorHasFailure(line), false, 'available is not a failure');
}

{
  // rg absent → warn line (not fail — search still works via the JS walk, just slower)
  const line = renderSearchDoctor(false);
  assert.ok(line.includes('search'), 'labels the line as search');
  assert.ok(
    line.includes('warn'),
    'rg absent renders as warn, not fail (search still works, just degraded)'
  );
  assert.ok(!line.includes('fail'), 'absent rg is a warn, not a hard failure');
  assert.ok(/install rg|ripgrep/.test(line), 'points the user at the fix (install rg)');
  assert.equal(cliDoctorHasFailure(line), false, 'warn is not a failure');
}

// ─── running moss: version stamp, entry path, package root ──────────────────

{
  const entry = '/usr/local/lib/node_modules/@rdk-moss/agent/bin/moss.cjs';
  const root = '/usr/local/lib/node_modules/@rdk-moss/agent';
  const lines = renderMossRuntimeDoctorLines({
    version: '0.26.0',
    stamp: { commit: 'abc1234', date: '2026-10-10', dirty: true },
    entryPath: entry,
    packageRoot: root,
    warning: null,
  });
  const text = lines.join('\n');
  assert.match(text, /ok\s+version:/);
  assert.match(text, /0\.26\.0 \(abc1234\+dirty, 2026-10-10\)/);
  assert.match(text, /ok\s+binary:/);
  assert.match(text, /moss\.cjs \(package \/usr\/local\/lib\/node_modules\/@rdk-moss\/agent\)/);
  assert.equal(cliDoctorHasFailure(text), false, 'version and binary lines are not failures');
}

{
  const lines = renderMossRuntimeDoctorLines({
    version: '0.26.0',
    stamp: null,
    entryPath: '/opt/a/bin/moss',
    packageRoot: '/opt/a',
    warning:
      '2 moss executables on PATH: /opt/a/bin/moss; /opt/b/bin/moss. /opt/a/bin/moss wins (first on PATH) and is the one currently running.',
  });
  const text = lines.join('\n');
  assert.match(text, /version: 0\.26\.0$/m, 'no stamp means the version number alone');
  assert.match(text, /binary: \/opt\/a\/bin\/moss \(package \/opt\/a\)/);
  assert.match(text, /warn\s+binaries:/);
  assert.match(text, /\/opt\/a\/bin\/moss wins/);
  assert.doesNotMatch(text, /^\s+fail\s/m);
  assert.equal(cliDoctorHasFailure(text), false, 'a PATH collision is a warning, not a failure');
}

{
  installUiLanguage({ language: 'zh', source: 'flag', setting: 'zh' });
  try {
    const lines = renderMossRuntimeDoctorLines({
      version: '0.26.0',
      stamp: { commit: 'beeface', date: '2026-10-10', dirty: true },
      entryPath: 'D:\\a\\moss\\moss\\dist\\cli.js',
      packageRoot: 'D:\\a\\moss\\moss',
      warning: null,
    });
    const text = lines.join('\n');
    assert.match(text, /版本： 0\.26\.0（beeface，有未提交改动，2026-10-10）/);
    assert.match(text, /程序： D:\/a\/moss\/moss\/dist\/cli\.js（安装根目录 D:\/a\/moss\/moss）/);
    assert.equal(text.includes('dirty'), false);
    assert.equal(text.includes('package'), false);
    assert.equal(text.includes('binary'), false);
    assert.equal(cliDoctorHasFailure(text), false);
  } finally {
    clearUiLanguage();
  }
}

console.log('[PASS] Doctor diagnostics');
