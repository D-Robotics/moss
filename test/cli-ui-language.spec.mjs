#!/usr/bin/env node
/**
 * UI language: flag > env > user config > system locale.
 * `--lang en` under a Chinese locale has no CJK in chrome; `--lang zh` under C
 * is Chinese. Device errors, credential hints, task cards, config warnings
 * (including unprobed), MCP logs, first-run setup screens, and provider errors
 * follow the same switch.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { trackTempDir } from './helpers/temp-home.mjs';

import { auditResolvedCliConfig, envBeforeDotenv, mergeConfigFiles } from '../dist/cli/config.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';
import {
  buildAnswerLanguageLayer,
  clearUiLanguage,
  resolveUiLanguage,
  shouldOfferEnglishUi,
} from '../dist/cli/cli-locale.js';
import { setTuiLocale } from '../dist/cli/tui/copy.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';
import { formatDeviceConnectError } from '../dist/device/device-connect-error.js';
import { SshDeviceConnection } from '../dist/device/ssh-device-connection.js';
import { formatMcpStartupLine } from '../dist/cli/rdk-docs-mcp.js';
import {
  describeToolCall,
  formatDeploymentLine,
  formatEvidenceCardLine,
  formatTaskSummaryLine,
} from '../dist/core/task-runtime/runtime.js';
import { renderFirstRunLines } from '../dist/cli/first-run.js';
import { classifyProviderError } from '../dist/provider/error-classify.js';

const HAN = /\p{Script=Han}/u;
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');

async function withUi(language, fn) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
  setTuiLocale(language === 'zh');
  try {
    return await fn();
  } finally {
    setTuiLocale(false);
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
  const unreachable = formatDeviceConnectError({
    kind: 'timeout',
    where: '10.0.0.8:22',
    host: '10.0.0.8',
    timeoutMs: 10_000,
  });
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
  assert.match(zh, /没有路由/);
  assert.match(zh, /失败：/);
  assert.match(zh, /达成/);
  const en = await withUi('en', surfaces);
  assertNoHan(en, 'en surfaces');
  assert.match(en, /No route to/);
  assert.match(en, /PLANNING/);
  assert.match(en, /default full mode has no deny/);
  assert.match(en, /○ rdk-docs — failed: exit 1/);
}

function firstRunScreens() {
  const provider = renderFirstRunLines({ step: 'provider', offers: [], cursor: 0 }).join('\n');
  const url = renderFirstRunLines({ step: 'url', offers: [], cursor: 0 }).join('\n');
  const failed = renderFirstRunLines({
    step: 'error',
    offers: [],
    cursor: 0,
    error: 'HTTP 401',
    failStep: 'key',
    pending: {
      type: 'probe',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'x',
    },
  }).join('\n');
  return [provider, url, failed].join('\n');
}

function providerErrors() {
  const gateway = classifyProviderError({
    status: 400,
    errorMessage:
      'OpenAI-compatible provider returned HTTP 400: Model Not Exist — this model name is not available on the gateway.',
  });
  const details = classifyProviderError({
    audience: 'setup',
    errorMessage: 'connect ETIMEDOUT 10.0.0.1:443',
  });
  return { gateway: gateway.userMessage, details: details.userMessage };
}

{
  const zh = await withUi('zh', firstRunScreens);
  assertHan(zh, 'zh first-run screens');
  for (const phrase of [
    'Moss setup',
    'About a minute',
    'Choose a provider',
    'Gateway URL',
    'save anyway',
  ]) {
    assert.equal(zh.includes(phrase), false, `zh first-run still has "${phrase}"`);
  }
  assert.match(zh, /Moss 设置/);
  assert.match(zh, /选择服务商/);
  assert.match(zh, /地瓜网关/);
  const en = await withUi('en', firstRunScreens);
  assertNoHan(en, 'en first-run screens');
  assert.match(en, /Moss setup/);
  assert.match(en, /Choose a provider/);
  assert.match(en, /D-Robotics gateway/);
}

{
  const zh = await withUi('zh', providerErrors);
  assert.match(zh.gateway, /网关原文：/);
  assert.equal(zh.gateway.includes('Gateway text'), false);
  assert.match(zh.details, /详细信息：/);
  assert.equal(zh.details.includes('Details:'), false);
  assertNoEnglishLeak(`${zh.gateway}\n${zh.details}`, 'zh provider errors');
  const en = await withUi('en', providerErrors);
  assert.match(en.gateway, /Gateway text: /);
  assert.equal(en.gateway.includes('网关原文'), false);
  assert.match(en.details, /Details: /);
  assert.equal(en.details.includes('详细信息'), false);
  assertNoHan(`${en.gateway}\n${en.details}`, 'en provider errors');
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
  assert.match(enMissing.message, /No credentials are configured for 10\.0\.0\.8:22/);
}

function runCli(args, extraEnv = {}) {
  const home = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-lang-')));
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
  assert.equal(zh.text.includes('(not set)'), false);
  assert.equal(zh.text.includes('(default)'), false);
}

{
  const zhGuide = runCli(['--lang', 'zh']);
  assert.notEqual(zhGuide.status, null, 'zh startup guidance timed out');
  assertHan(zhGuide.text, 'zh startup guidance');
  assert.equal(zhGuide.text.includes('Moss needs a model configuration'), false);
  assert.match(zhGuide.text, /需要先配好模型/);
  const enGuide = runCli(['--lang', 'en'], { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assertNoHan(enGuide.text, 'en startup guidance');
  assert.match(enGuide.text, /Moss needs a model configuration/);
}

{
  const zhModel = runCli(['--lang', 'zh', '/model'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(zhModel.text.includes('choose one of the models above'), false);
  assert.equal(zhModel.text.includes('Use:'), false);
  assert.match(zhModel.text, /用法：/);
  const enModel = runCli(['--lang', 'en', '/model'], {
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
  });
  assert.match(enModel.text, /choose one of the models above/);
  assertNoHan(enModel.text, 'en /model phrases');
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

{
  const badEnv = runCli(['--help'], { MOSS_LANG: 'fr', LANG: 'C', LC_ALL: 'C' });
  assert.equal(badEnv.status, 0, badEnv.text);
  assert.match(badEnv.text, /MOSS_LANG must be en\|zh/);
  assert.match(badEnv.text, /Most useful/);
  const override = runCli(['--lang', 'en', '--help'], {
    MOSS_LANG: 'fr',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
  });
  assert.equal(override.status, 0, override.text);
  assert.match(override.stderr ?? '', /MOSS_LANG/);
  assertNoHan(override.stdout ?? '', '--lang en overrides a bad MOSS_LANG');
  const badFlag = runCli(['--lang', 'fr', '--help'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(badFlag.status, 2, badFlag.text);
  const missing = runCli(['--lang'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(missing.status, 2, missing.text);
  assert.match(missing.text, /--lang requires a value/);
  const missingZh = runCli(['--lang'], { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' });
  assert.equal(missingZh.status, 2, missingZh.text);
  assert.match(missingZh.text, /--lang 需要一个值/);
  const badConfig = runCli(['--help'], {
    LANG: 'C',
    LC_ALL: 'C',
    config: '{"language":"fr"}\n',
  });
  assert.equal(badConfig.status, 0, badConfig.text);
  assert.match(badConfig.text, /config language "fr" is not auto\|en\|zh/);
}

const ALLOWED_EN = new Set(
  `moss setup doctor config auth update resume fork mcp device skill plugins migrate sessions tasks task web agent
help model status language lang permissions mode plan goal compact clear diff export init stop context usage agents review
en zh auto json http https api repl tui mcp node npm git github linux macos windows posix
deepseek openai anthropic qwen ripgrep path token baseurl url key env var
ok warn fail pass full manual plan stdio bash ssh id dir cwd true false yes no default
add list remove test show set unset validate create delete search export run status timeline resume view verify fork init
unprobed bing bocha brave exa npx ctrl tab esc enter home opt tmp boot etc
provider profile version workspace runtime search detail quiet verbose mock json
accept edits read only workspace write full access never prompt
info processes resources temperature robotics network cameras fleet
allow ask deny none enabled disabled
mit mit
skills soul commands agents persona
stdin stdout stderr tty pty
grep mkdir chmod printf
d robotics rdk docs
npx`
    .split(/\s+/)
    .map((word) => word.toLowerCase())
);
const GLUE = new Set(
  'the and for with from this that are not you your when will can has have was were into than then also only must should but its been they their about after before where which what how does did using used still every other same more without within under over once requires require missing found available install please press type enter choose saved'.split(
    ' '
  )
);

function stripAnsi(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x1b) {
      out += text[i];
      continue;
    }
    const end = text.indexOf('m', i);
    i = end === -1 ? text.length : end;
  }
  return out;
}

function englishSentences(text) {
  const hits = [];
  for (const rawLine of text.split('\n')) {
    const plain = stripAnsi(rawLine);
    if (/^\s*(\$ )?(moss\b|\/[a-z]|git\b|npm\b|npx\b|printf\b|echo\b|node\b)/i.test(plain))
      continue;
    const stripped = plain
      .replace(/`[^`]*`/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/--?[A-Za-z0-9][\w-]*/g, ' ')
      .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, ' ')
      .replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' ')
      .replace(/[~./][\w./~-]*/g, ' ')
      .replace(/[<>]/g, ' ');
    const words = stripped.match(/[A-Za-z][A-Za-z0-9_'-]{2,}/g) ?? [];
    const leftover = words.filter((word) => {
      const lower = word.toLowerCase();
      if (ALLOWED_EN.has(lower)) return false;
      if (/^[a-z]+[-_][a-z0-9_-]+$/i.test(word)) return false;
      return true;
    });
    const glue = leftover.filter((word) => GLUE.has(word.toLowerCase())).length;
    if (leftover.length >= 4 || (leftover.length >= 3 && glue >= 1) || glue >= 2) {
      hits.push(`${plain.trim()}  << ${leftover.join(' ')}`);
    }
  }
  return hits;
}

const zhSurfacesAll = [
  ['--help'],
  ['--help', '--all'],
  ['config', '--help'],
  ['config', 'env'],
  ['config', 'show'],
  ['doctor'],
  ['setup', '--help'],
  ['auth', '--help'],
  ['update', '--help'],
  ['resume', '--help'],
  ['fork', '--help'],
  ['mcp', '--help'],
  ['device', '--help'],
  ['skill', '--help'],
  ['plugins', '--help'],
  ['migrate', '--help'],
  ['tasks', '--help'],
  ['task', '--help'],
  ['sessions', '--help'],
  ['web', '--help'],
  ['agent', '--help'],
];
for (const args of zhSurfacesAll) {
  const shown = runCli(['--lang', 'zh', ...args], { LANG: 'C', LC_ALL: 'C' });
  assert.notEqual(shown.status, null, `${args.join(' ')} timed out`);
  const hits = englishSentences(shown.text);
  assert.deepEqual(hits, [], `--lang zh ${args.join(' ')} still has English:\n${hits.join('\n')}`);
}

{
  const dir = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-lang-save-')));
  const prevConfig = process.env.MOSS_CONFIG_DIR;
  const prevEnvLang = envBeforeDotenv.MOSS_LANG;
  process.env.MOSS_CONFIG_DIR = dir;
  clearUiLanguage();
  try {
    envBeforeDotenv.MOSS_LANG = 'zh';
    installUiLanguage({ language: 'en', source: 'flag', setting: 'en' });
    const english = [];
    assert.equal(
      await runRegistryCommand('/language en save', {
        say: (_kind, text) => english.push(text),
      }),
      true
    );
    assert.match(english.join('\n'), /MOSS_LANG=zh will override this on the next start/);

    envBeforeDotenv.MOSS_LANG = 'en';
    installUiLanguage({ language: 'zh', source: 'flag', setting: 'zh' });
    const chinese = [];
    await runRegistryCommand('/language zh save', {
      say: (_kind, text) => chinese.push(text),
    });
    assert.match(chinese.join('\n'), /下次启动时 MOSS_LANG=en 会覆盖它/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.language, 'zh');

    delete envBeforeDotenv.MOSS_LANG;
    const quiet = [];
    await runRegistryCommand('/language zh save', {
      say: (_kind, text) => quiet.push(text),
    });
    assert.equal(quiet.join('\n').includes('会覆盖'), false);
    assert.equal(quiet.join('\n').includes('will override'), false);
  } finally {
    if (prevEnvLang === undefined) delete envBeforeDotenv.MOSS_LANG;
    else envBeforeDotenv.MOSS_LANG = prevEnvLang;
    if (prevConfig === undefined) delete process.env.MOSS_CONFIG_DIR;
    else process.env.MOSS_CONFIG_DIR = prevConfig;
    clearUiLanguage();
    setTuiLocale(false);
  }
}

console.log('[PASS] cli ui language');
