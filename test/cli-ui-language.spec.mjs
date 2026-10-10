#!/usr/bin/env node
/**
 * UI language: flag > env > user config > system locale.
 * `--lang en` under a Chinese locale has no CJK in chrome; `--lang zh` under C
 * is Chinese. Device errors, credential hints, task cards, config warnings
 * (including unprobed), and MCP logs follow the same switch.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditResolvedCliConfig, mergeConfigFiles } from '../dist/cli/config.js';
import {
  buildAnswerLanguageLayer,
  clearUiLanguage,
  resolveUiLanguage,
  shouldOfferEnglishUi,
} from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import {
  deviceUnreachableCopy,
  SshDeviceConnection,
} from '../dist/device/ssh-device-connection.js';
import { formatMcpStartupLine } from '../dist/cli/rdk-docs-mcp.js';
import {
  describeToolCall,
  formatDeploymentLine,
  formatEvidenceCardLine,
  formatTaskSummaryLine,
} from '../dist/core/task-runtime/runtime.js';

const HAN = /\p{Script=Han}/u;
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

async function withUi(language, fn) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
  try {
    return await fn();
  } finally {
    clearUiLanguage();
  }
}

function assertNoHan(text, label) {
  assert.equal(HAN.test(text), false, `${label} leaked CJK:\n${text}`);
}

function assertHan(text, label) {
  assert.equal(HAN.test(text), true, `${label} has no Chinese:\n${text}`);
}

function assertNoEnglishLeak(text, label) {
  const banned = [
    'Cannot reach',
    'powered on',
    'No credentials for device',
    'never stored in the device target',
    'defining task',
    'reasoning about the goal',
    'upload ok',
    '(want ',
    '(unprobed)',
    'default full mode has no deny',
    'RDK manual lookup is off',
    'server "rdk-docs" unavailable',
    'missing evidence',
    'not yet probed',
  ];
  for (const phrase of banned) {
    assert.equal(text.includes(phrase), false, `${label} still has English "${phrase}"`);
  }
}

{
  assert.equal(resolveUiLanguage({ systemLocale: 'C' }).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'POSIX' }).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'C.UTF-8' }).language, 'en');
  assert.equal(resolveUiLanguage({}).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'zh_CN.UTF-8' }).language, 'zh');
  const flagged = resolveUiLanguage({
    flag: 'en',
    envLang: 'zh',
    configLanguage: 'zh',
    systemLocale: 'zh_CN.UTF-8',
  });
  assert.equal(flagged.language, 'en');
  assert.equal(flagged.source, 'flag');
  assert.equal(
    resolveUiLanguage({ envLang: 'zh', configLanguage: 'en', systemLocale: 'C' }).source,
    'env'
  );
  assert.equal(resolveUiLanguage({ configLanguage: 'zh', systemLocale: 'C' }).source, 'config');
  assert.throws(() => resolveUiLanguage({ flag: 'fr' }), /--lang must be en\|zh/);
  assert.throws(() => resolveUiLanguage({ envLang: 'chinese' }), /MOSS_LANG must be en\|zh/);
  assert.equal(
    mergeConfigFiles({ language: 'zh', model: 'from-project' }, { language: 'en' }).language,
    'en'
  );
  assert.equal(mergeConfigFiles({ language: 'zh' }, {}).language, undefined);
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    true
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'en_US.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    false
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: false,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    false
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: 'auto',
      source: 'locale',
    }),
    false
  );
}

{
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  process.env.LC_MESSAGES = 'zh_CN.UTF-8';
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
  try {
    const layer = buildAnswerLanguageLayer();
    assert.match(
      layer,
      /简体中文/,
      'answer language follows the system locale, not the UI language'
    );
  } finally {
    clearUiLanguage();
    process.env.LANG = 'C';
    process.env.LC_ALL = 'C';
    process.env.LC_MESSAGES = 'C';
    assert.equal(buildAnswerLanguageLayer(), '');
    for (const key of ['LANG', 'LC_ALL', 'LC_MESSAGES']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function surfaces() {
  const unreachable = deviceUnreachableCopy(
    { deviceId: 'board-1', kind: 'rdk', host: '10.0.0.8', port: 22 },
    10_000
  );
  const card = formatTaskSummaryLine({
    taskId: 'task_1',
    goal: 'keep the camera up',
    kind: 'camera',
    state: 'PLANNING',
    criteriaMet: 0,
    criteriaTotal: 2,
    updatedAt: 1,
    blockedReason: 'board',
  });
  const evidence = formatEvidenceCardLine({
    result: 'fail',
    metric: 'fps',
    observed: '10',
    expected: '30',
  });
  const deploy = formatDeploymentLine({
    status: 'uploaded',
    deviceId: 'rdk-01',
    remotePath: '/opt/app',
    artifactPath: '/tmp/app',
    startedAt: 1,
    steps: [],
  });
  const warnings = auditResolvedCliConfig({
    approvalPolicy: 'never',
    approvalPolicySource: 'default',
    safetyMode: 'workspace-write',
    safetyModeSource: 'default',
    trustedTools: [],
    trustedToolsSource: 'default',
    deniedTools: [],
    deniedToolsSource: 'default',
    permissions: {
      defaultMode: 'full',
      readOnlyCeiling: false,
      allow: [],
      ask: [],
      deny: [],
      deviceTrust: 'gated',
      trustedDevices: [],
      legacyKeysUsed: [],
      source: 'default',
    },
  })
    .map((warning) => warning.message)
    .join('\n');
  const mcp = formatMcpStartupLine(
    { name: 'rdk-docs', state: 'failed', error: 'exit 1' },
    'normal'
  );
  const action = describeToolCall('device_info', {});
  return [
    unreachable.message,
    unreachable.hint,
    card,
    evidence,
    deploy,
    warnings,
    mcp,
    action,
  ].join('\n');
}

{
  const zh = await withUi('zh', surfaces);
  assertHan(zh, 'zh surfaces');
  assertNoEnglishLeak(zh, 'zh surfaces');
  assert.match(zh, /规划中/);
  assert.match(zh, /没有拒绝规则/);
  assert.match(zh, /无法在/);
  assert.match(zh, /无法连接/);
  assert.match(zh, /达成/);
  const en = await withUi('en', surfaces);
  assertNoHan(en, 'en surfaces');
  assert.match(en, /Cannot reach/);
  assert.match(en, /PLANNING/);
  assert.match(en, /default full mode has no deny/);
  assert.match(en, /RDK manual lookup is off/);
}

{
  const missing = await withUi('zh', () => {
    const conn = new SshDeviceConnection({
      deviceId: 'board-1',
      kind: 'rdk',
      host: '10.0.0.8',
      auth: { method: 'password', passwordEnvVar: 'MOSS_LANG_TEST_UNSET_PASSWORD' },
    });
    return conn.connect().then(
      () => {
        throw new Error('connect should fail without credentials');
      },
      (err) => err
    );
  });
  assertHan(missing.message, 'credential error');
  assertHan(missing.hint, 'credential hint');
  assert.equal(missing.message.includes('No credentials'), false);
  assert.equal(missing.hint.includes('never stored'), false);
  const enMissing = await withUi('en', () => {
    const conn = new SshDeviceConnection({
      deviceId: 'board-1',
      kind: 'rdk',
      host: '10.0.0.8',
      auth: { method: 'password', passwordEnvVar: 'MOSS_LANG_TEST_UNSET_PASSWORD' },
    });
    return conn.connect().then(
      () => {
        throw new Error('connect should fail without credentials');
      },
      (err) => err
    );
  });
  assertNoHan(`${enMissing.message}\n${enMissing.hint}`, 'en credential copy');
  assert.match(enMissing.message, /No credentials for device board-1/);
}

function runCli(args, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-lang-'));
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const workspace = path.join(home, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  if (extraEnv.config) {
    fs.writeFileSync(path.join(configDir, 'config.json'), extraEnv.config);
  }
  if (extraEnv.dotenv) {
    fs.writeFileSync(path.join(workspace, '.env'), extraEnv.dotenv);
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_BUNDLED_DEFAULT: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    LANG: extraEnv.LANG ?? 'C',
    LC_ALL: extraEnv.LC_ALL ?? extraEnv.LANG ?? 'C',
    LC_MESSAGES: extraEnv.LC_MESSAGES ?? extraEnv.LANG ?? 'C',
  };
  delete env.MOSS_LANG;
  if (extraEnv.MOSS_LANG) env.MOSS_LANG = extraEnv.MOSS_LANG;
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: extraEnv.cwd ?? workspace,
    env,
  });
  return { ...result, text: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, home, workspace };
}

const enSurfaces = [
  ['--help'],
  ['setup', '--help'],
  ['/model'],
  ['config', 'show'],
  ['--not-a-flag'],
];
for (const args of enSurfaces) {
  const flagged = ['--lang', 'en', ...args];
  const shown = runCli(flagged, { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assert.notEqual(shown.status, null, `${flagged.join(' ')} timed out`);
  assertNoHan(shown.text, `en ${flagged.join(' ')}`);
}

const zhSurfaces = [
  ['--help'],
  ['setup', '--help'],
  ['/model'],
  ['config', 'show'],
  ['--not-a-flag'],
];
for (const args of zhSurfaces) {
  const shown = runCli(['--lang', 'zh', ...args], { LANG: 'C', LC_ALL: 'C' });
  assert.notEqual(shown.status, null, `${args.join(' ')} timed out`);
  assertHan(shown.text, `zh ${args.join(' ')}`);
  assertNoEnglishLeak(shown.text, `zh ${args.join(' ')}`);
}

{
  const shown = runCli(['config', 'show'], { LANG: 'C', LC_ALL: 'C' });
  assert.match(shown.text, /\(unprobed\)/);
  assert.match(shown.text, /default full mode has no deny/);
  assertNoHan(shown.text, 'config show under C');
  const zh = runCli(['--lang', 'zh', 'config', 'show'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(zh.text.includes('(unprobed)'), false);
  assert.match(zh.text, /未探测/);
  assert.match(zh.text, /没有拒绝规则/);
}

{
  const projectEnv = runCli(['--help'], { LANG: 'C', LC_ALL: 'C', dotenv: 'MOSS_LANG=zh\n' });
  assert.equal(projectEnv.status, 0, projectEnv.stderr);
  assertNoHan(projectEnv.text, 'project .env must not switch the UI language');
  assert.match(projectEnv.text, /Most useful/);
}

{
  const fromConfig = runCli(['--help'], {
    LANG: 'C',
    LC_ALL: 'C',
    config: '{"language":"zh"}\n',
  });
  assert.equal(fromConfig.status, 0, fromConfig.stderr);
  assert.match(fromConfig.text, /最常用/);
  const override = runCli(['--lang', 'en', '--help'], {
    LANG: 'C',
    LC_ALL: 'C',
    config: '{"language":"zh"}\n',
  });
  assertNoHan(override.text, '--lang en overrides user config');
}

{
  const rejected = runCli(['config', 'set', '--project', 'language', 'zh'], {
    LANG: 'C',
    LC_ALL: 'C',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.text, /user setting|用户配置/);
  const projectFile = path.join(rejected.workspace, '.moss', 'config.json');
  assert.equal(fs.existsSync(projectFile), false);
}

console.log('[PASS] cli ui language');
