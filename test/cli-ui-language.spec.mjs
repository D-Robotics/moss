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

import { auditResolvedCliConfig, envBeforeDotenv, mergeConfigFiles } from '../dist/cli/config.js';
import { KNOWN_COMMANDS } from '../dist/cli/args.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';
import { buildApprovalDetailLines } from '../dist/cli/approval-detail.js';
import {
  SETUP_ZH,
  buildAnswerLanguageLayer,
  clearUiLanguage,
  resolveUiLanguage,
  shouldOfferEnglishUi,
} from '../dist/cli/cli-locale.js';
import { setupMenuLines } from '../dist/cli/setup-wizard.js';
import { formatTaskStatus } from '../dist/cli/task-run.js';
import { ZH, setTuiLocale, tui } from '../dist/cli/tui/copy.js';
import { renderApproval, renderTranscriptRows } from '../dist/cli/tui/transcript.js';
import { localizeTaskDetail } from '../dist/core/task/task-store.js';
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
import { renderFirstRunLines } from '../dist/cli/first-run.js';
import { classifyProviderError } from '../dist/provider/error-classify.js';
import { requirePyLayout } from './helpers/require-pyte.mjs';

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
  assert.throws(() => resolveUiLanguage({ envLang: 'chinese' }), /MOSS_LANG must be auto\|en\|zh/);
  assert.equal(
    resolveUiLanguage({ envLang: 'auto', configLanguage: 'zh', systemLocale: 'C' }).source,
    'config'
  );
  assert.equal(resolveUiLanguage({ envLang: 'AUTO', systemLocale: 'zh_CN.UTF-8' }).language, 'zh');
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
  assert.match(badEnv.text, /MOSS_LANG must be auto\|en\|zh/);
  const autoEnv = runCli(['--help'], { MOSS_LANG: 'auto', LANG: 'C', LC_ALL: 'C' });
  assert.equal(autoEnv.status, 0, autoEnv.text);
  assert.doesNotMatch(autoEnv.text, /MOSS_LANG must be/);
  assert.match(badEnv.text, /Most useful/);
  const override = runCli(['--lang', 'en', '--help'], {
    MOSS_LANG: 'fr',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
  });
  assert.equal(override.status, 0, override.text);
  assert.match(override.stderr ?? '', /MOSS_LANG must be auto\|en\|zh/);
  assertNoHan(override.stderr ?? '', 'warning follows --lang en, not the system locale');
  assertNoHan(override.stdout ?? '', '--lang en overrides a bad MOSS_LANG');
  const flagZh = runCli(['--lang', 'zh', '--help'], { MOSS_LANG: 'fr', LANG: 'C', LC_ALL: 'C' });
  assert.equal(flagZh.status, 0, flagZh.text);
  assert.match(flagZh.stderr ?? '', /MOSS_LANG 只能是 auto、en 或 zh/);
  assert.match(flagZh.stdout ?? '', /最常用/);
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
  const validated = runCli(['config', 'validate'], {
    LANG: 'C',
    LC_ALL: 'C',
    config: '{"language":"fr"}\n',
  });
  assert.match(validated.text, /language\.invalid/);
  assert.match(validated.text, /language "fr" is not auto\|en\|zh/);
  const strict = runCli(['config', 'validate', '--strict'], {
    LANG: 'C',
    LC_ALL: 'C',
    config: '{"language":"fr"}\n',
  });
  assert.equal(strict.status, 1, strict.text);
}

// Whole tokens only: a command, flag, path, or product name. Never a class that
// also eats the words around the token. enter/home/end/pass/fail/english are
// not tokens — a sentence made of them must still be caught. `auto`/`en`/`zh`
// stay because they are the language setting the user types.
const LITERAL_TOKENS = new Set(
  `moss mcp rdk api ssh url json jsonl repl tui pty tty npm npx git github linux macos windows posix
powershell deepseek openai anthropic qwen openai-compatible d-robotics http https mit stdin stdout stderr
ripgrep xclip finder bash bing markdown node js eexist esc tab ctrl shift alt opt cmd
list search delete export create logout show env validate init set unset status add remove serve
evidence deployments acceptance run cd ci clone pull install uninstall sudo chmod prepare help version
save clear plan goal diff model provider config doctor key name id file text host path dir
baseurl apikey apikeyenv profile workspace safetymode approvalpolicy trustedtools deniedtools
permissions defaultmode allow ask deny devicetrust trusteddevices rdkdocs enabled package
promptcache promptcachedebug guardrails input output blockpatterns redactpatterns agent
maxturns contexttokens compaction reservetokens keeprecenttokens language
task_define record_evidence device_deploy search_code workspace-write
balanced cautious autonomous manual acceptedits full never prompt
moss_lang moss_config_dir moss_config_file moss_no_bundled_default editor
wl-paste xclip echo printf rg grep test timeline stdio rdk-docs full-access
fleet info processes resources temperature robotics network cameras partial
all-fail devices description view history failures verify false`
    .split(/\s+/)
    .filter((word) => word.length > 0)
);
for (const command of KNOWN_COMMANDS) LITERAL_TOKENS.add(command);

const LANGUAGE_SETTINGS = new Set(['auto', 'en', 'zh']);
const EXACT_PHRASES = ['api key', 'node.js', 'task os'];
const MUTATION_SENTENCE = 'No model provider set, run setup or add a key.';

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
  for (const rawLine of stripAnsi(text).split('\n')) {
    // `!` before Han is the shell prefix. `中文!` and `中文;` still count.
    if (/[\u4e00-\u9fff]\s*[,:;!()]|[,:;()]\s*[\u4e00-\u9fff]/.test(rawLine)) {
      hits.push(`${rawLine.trim()}  << punctuation`);
    }
    let line = rawLine;
    for (const phrase of EXACT_PHRASES) {
      line = line.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    }
    line = line.replace(/https?:\/\/\S+/g, ' ');
    // A flag token, including an attached =value. The next word stays.
    line = line.replace(/(^|[^\w-])(--?[A-Za-z0-9][\w-]*)(?:=[^\s,，。；;)]*)?/g, '$1 ');
    const kept = [];
    for (const token of line.split(/\s+/)) {
      if (!token) continue;
      if (/^\/[A-Za-z][\w-]*$/.test(token)) continue;
      if (/^[~.]/.test(token) || token.includes('/')) continue;
      if (/\d/.test(token)) continue;
      // An identifier or env reference is one token. The words around it stay.
      if (token.includes('_') || token.includes('$')) continue;
      kept.push(token);
    }
    let body = kept.join(' ');
    body = body.replace(/^\s*(?:ok|warn|fail)\b/i, ' ');
    const words = body.match(/[A-Za-z][A-Za-z0-9_'-]*/g) ?? [];
    const leftover = words.filter((word) => {
      if (word.length < 2) return false;
      if (word.includes('_')) return false;
      const lower = word.toLowerCase();
      return !LITERAL_TOKENS.has(lower) && !LANGUAGE_SETTINGS.has(lower);
    });
    if (leftover.length > 0) hits.push(`${rawLine.trim()}  << ${leftover.join(' ')}`);
  }
  return hits;
}

function spliceEnglish(text, extra) {
  const lines = text.split('\n');
  const idx = lines.findIndex((line) => HAN.test(stripAnsi(line)));
  if (idx < 0) return `${text}\n${extra}`;
  lines[idx] = `${lines[idx]} ${extra}`;
  return lines.join('\n');
}

/** Each form used to hide an English sentence. All of them must be caught. */
const EXEMPTION_MUTATIONS = [
  (text) => spliceEnglish(text, MUTATION_SENTENCE),
  (text) => spliceEnglish(text, `\`${MUTATION_SENTENCE}\``),
  (text) => spliceEnglish(text, `<${MUTATION_SENTENCE}>`),
  (text) => spliceEnglish(text, '运行 moss setup to fix it'),
  (text) => spliceEnglish(text, `--lang ${MUTATION_SENTENCE}`),
  (text) => spliceEnglish(text, MUTATION_SENTENCE.replace(/ /g, '.')),
  (text) => spliceEnglish(text, `[${MUTATION_SENTENCE}]`),
  (text) => spliceEnglish(text, MUTATION_SENTENCE.replace(/ /g, '|')),
  (text) => spliceEnglish(text, `note=${MUTATION_SENTENCE.split(' ').slice(0, 3).join('-')}`),
  (text) => spliceEnglish(text, 'Note:run-setup'),
  (text) => spliceEnglish(text, 'and / or'),
  (text) => spliceEnglish(text, MUTATION_SENTENCE.toUpperCase()),
  (text) => spliceEnglish(text, 'enter home end pass fail auto english'),
  (text) => spliceEnglish(text, '中文;'),
  (text) => spliceEnglish(text, '中文!'),
];

function zhScreenArgs() {
  const screens = [
    ['--help'],
    ['--help', '--all'],
    ['config', 'env'],
    ['config', 'show'],
    ['config', 'validate'],
    ['doctor'],
    ['sessions', 'list'],
    ['sessions', 'search', 'moss'],
    ['tasks'],
    ['resume', '--last'],
    ['config', 'set', 'not-a-real-key', 'x'],
    ['config', 'init'],
  ];
  for (const command of KNOWN_COMMANDS) screens.push([command, '--help']);
  return screens;
}

const zhSurfacesAll = zhScreenArgs();
const surfaceHits = [];
const scanned = [];
for (const args of zhSurfacesAll) {
  const shown = runCli(['--lang', 'zh', ...args], { LANG: 'C', LC_ALL: 'C' });
  assert.notEqual(shown.status, null, `${args.join(' ')} timed out`);
  const name = args.join(' ');
  scanned.push({ name, text: shown.text });
  const hits = englishSentences(shown.text);
  if (hits.length > 0) surfaceHits.push(`-- ${name}\n${hits.join('\n')}`);
}
assert.deepEqual(surfaceHits, [], `zh surfaces still have English:\n${surfaceHits.join('\n')}`);

function catalogKeyParity() {
  const missing = [];
  const srcDir = path.join(repoRoot, 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(srcDir);
  const literal = (raw) => raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repoRoot, file);
    for (const match of source.matchAll(/\b(?:tui|chrome)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = literal(match[2]);
      if (key.includes('${')) continue;
      if (!(key in ZH)) missing.push(`${rel} tui/chrome ${JSON.stringify(key)}`);
    }
    for (const match of source.matchAll(/\bdoctorL\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = literal(match[2]);
      if (key.includes('${')) continue;
      if (!(key in SETUP_ZH)) missing.push(`${rel} doctorL ${JSON.stringify(key)}`);
    }
    for (const match of source.matchAll(/\bsetupCopy\(\s*[^,]+,\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = literal(match[2]);
      if (key.includes('${')) continue;
      if (!(key in SETUP_ZH)) missing.push(`${rel} setupCopy ${JSON.stringify(key)}`);
    }
  }
  for (const [key, value] of Object.entries(ZH)) {
    if (value.length === 0) missing.push(`ZH empty ${JSON.stringify(key)}`);
    if (value === key && /[A-Za-z]{4,}/.test(key))
      missing.push(`ZH untranslated ${JSON.stringify(key)}`);
  }
  for (const [key, value] of Object.entries(SETUP_ZH)) {
    if (value.length === 0) missing.push(`SETUP_ZH empty ${JSON.stringify(key)}`);
    if (value === key && /[A-Za-z]{4,}/.test(key)) {
      missing.push(`SETUP_ZH untranslated ${JSON.stringify(key)}`);
    }
  }
  assert.deepEqual(missing, [], `catalog key parity:\n${missing.join('\n')}`);
}
catalogKeyParity();

function cardSurfaces() {
  installUiLanguage({ language: 'zh', source: 'config', setting: 'zh' });
  setTuiLocale(true);
  const menu = setupMenuLines('zh').join('\n');
  const approvalLines = renderApproval(
    {
      title: 'Create file',
      question: 'Do you want to create ./笔记.txt?',
      subject: './笔记.txt',
      cursor: 0,
      preview: buildApprovalDetailLines(
        'write_file',
        'local_write',
        { path: './笔记.txt', content: '你好\n' },
        { workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'moss-approval-')) }
      ),
    },
    80
  ).map((row) => row.text);
  const taskCard = formatTaskStatus(
    {
      taskId: 'task_1',
      goal: '写一个文件',
      phase: 'verifying',
      statusView: 'verifying',
      attempt: 1,
      repairs: [],
      failures: [],
      evidenceCount: 0,
      plan: [],
      lastVerdict: { verdict: 'fail', unmetRequired: 1 },
    },
    `12:00:00 开始验证 — ${localizeTaskDetail('evaluating acceptance')}`,
    true
  );
  const errorCard = renderTranscriptRows(
    [{ id: 1, kind: 'error', text: tui('git diff failed: {error}', { error: '退出码 2' }) }],
    80
  )
    .map((row) => row.text)
    .join('\n');
  clearUiLanguage();
  setTuiLocale(false);
  return [
    { name: 'setup wizard', text: menu },
    { name: 'approval card', text: approvalLines.join('\n') },
    { name: 'task card', text: taskCard },
    { name: 'error card', text: errorCard },
  ];
}

const cards = cardSurfaces();
for (const card of cards) {
  const hits = englishSentences(card.text);
  if (hits.length > 0) surfaceHits.push(`-- ${card.name}\n${hits.join('\n')}`);
  scanned.push(card);
}
assert.deepEqual(surfaceHits, [], `zh cards still have English:\n${surfaceHits.join('\n')}`);

let mutationAttempts = 0;
let mutationCaught = 0;
const mutationMisses = [];
for (const surface of scanned) {
  for (const mutate of EXEMPTION_MUTATIONS) {
    mutationAttempts += 1;
    const hits = englishSentences(mutate(surface.text));
    if (hits.length > 0) mutationCaught += 1;
    else mutationMisses.push(surface.name);
  }
}
assert.equal(
  mutationCaught,
  mutationAttempts,
  `mutation catch rate ${mutationCaught}/${mutationAttempts}; missed ${mutationMisses.join(', ')}`
);
console.log(`[PASS] mutation catch rate ${mutationCaught}/${mutationAttempts}`);

{
  const unknown = runCli(['help', 'nope'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(unknown.status, 2, unknown.text);
  assert.match(unknown.stderr ?? '', /unknown command 'nope'/);
  assert.equal((unknown.stdout ?? '').trim(), '', unknown.stdout);
  const unknownZh = runCli(['--lang', 'zh', 'help', 'notacommand'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(unknownZh.status, 2, unknownZh.text);
  assert.match(unknownZh.stderr ?? '', /未知命令「notacommand」/);
  const known = runCli(['help', 'config'], { LANG: 'C', LC_ALL: 'C' });
  assert.equal(known.status, 0, known.text);
  assert.match(known.stdout ?? '', /Usage:/);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-lang-save-'));
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
    assert.match(english.join('\n'), /UI language: English/);
    assert.match(english.join('\n'), /MOSS_LANG=zh will override this on the next start/);
    assert.match(english.join('\n'), /--lang=en overrides the saved setting/);
    assert.match(
      english.join('\n'),
      /next start uses the saved setting unless --lang or MOSS_LANG is set/
    );

    envBeforeDotenv.MOSS_LANG = 'en';
    installUiLanguage({ language: 'zh', source: 'flag', setting: 'zh' });
    const chinese = [];
    await runRegistryCommand('/language zh save', {
      say: (_kind, text) => chinese.push(text),
    });
    assert.match(chinese.join('\n'), /下次启动时 MOSS_LANG=en 会覆盖它/);
    assert.match(chinese.join('\n'), /--lang=zh 会覆盖已保存的设置/);
    assert.match(chinese.join('\n'), /下次启动若不带 --lang、也不设 MOSS_LANG，则使用已保存的值/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.language, 'zh');

    delete envBeforeDotenv.MOSS_LANG;
    installUiLanguage({ language: 'zh', source: 'config', setting: 'zh' });
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

if (requirePyLayout('cli-ui-language')) {
  const shot = spawnSync(
    'python3',
    [path.join(repoRoot, 'test', 'fixtures', 'tui-ui-language.py')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, HOME: process.env.HOME },
    }
  );
  const shotText = `${shot.stdout ?? ''}${shot.stderr ?? ''}`;
  assert.equal(shot.status, 0, shotText);
  assert.match(shotText, /\[PASS\] zh TUI/);
  const screens = [];
  for (const match of shotText.matchAll(/===SCREEN ([a-z]+)===([\s\S]*?)===END===/g)) {
    screens.push({ name: match[1], text: match[2] ?? '' });
  }
  const wanted = ['welcome', 'language', 'status', 'help', 'doctor'];
  const tuiHits = [];
  const tuiScreens = [];
  for (const name of wanted) {
    const screen = screens.find((entry) => entry.name === name);
    assert.ok(screen, `missing TUI screen ${name}\n${shotText}`);
    tuiScreens.push(screen);
    const hits = englishSentences(screen.text);
    if (hits.length > 0) tuiHits.push(`-- ${name}\n${hits.join('\n')}`);
  }
  const language = tuiScreens.find((screen) => screen.name === 'language');
  assert.match(language.text, /只切换本会话/);
  assert.match(language.text, /记到用户配置/);
  assert.match(language.text, /界面语言：中文/);
  const doctor = tuiScreens.find((screen) => screen.name === 'doctor');
  assert.match(doctor.text, /诊断/);
  assert.match(doctor.text, /模型/);
  assert.match(doctor.text, /版本/);
  assert.deepEqual(tuiHits, [], `zh TUI screens still have English:\n${tuiHits.join('\n')}`);
  let tuiAttempts = 0;
  let tuiCaught = 0;
  const tuiMisses = [];
  for (const screen of tuiScreens) {
    for (const mutate of EXEMPTION_MUTATIONS) {
      tuiAttempts += 1;
      if (englishSentences(mutate(screen.text)).length > 0) tuiCaught += 1;
      else tuiMisses.push(screen.name);
    }
  }
  assert.equal(
    tuiCaught,
    tuiAttempts,
    `TUI mutation catch rate ${tuiCaught}/${tuiAttempts}; missed ${tuiMisses.join(', ')}`
  );
  const totalCaught = mutationCaught + tuiCaught;
  const totalAttempts = mutationAttempts + tuiAttempts;
  console.log(`[PASS] mutation catch rate ${totalCaught}/${totalAttempts}`);
}

console.log('[PASS] cli ui language');
