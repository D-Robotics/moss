import fs from 'node:fs';
import * as readline from 'node:readline';
import { stdin as input, stderr as output } from 'node:process';
import { cleanGatewayUrl } from '../provider/api-v1-url.js';
import { isZhLocale, setupCopy } from './cli-locale.js';
import { WORKSPACE_WRITE_LIMIT_EN } from './workspace-write-copy.js';
import {
  envBeforeDotenv,
  loadCliConfigFile,
  loadConfigFile,
  PROVIDER_PRESETS,
  resolveCliConfig,
  resolveConfigPath,
  saveConfigFile,
  type CliConfigOverrides,
  type CliProviderPreset,
  type ConfigFile,
  type ResolvedCliConfig,
} from './config.js';
import { configSnapshotLines } from './config-snapshot.js';
import {
  ENGLISH_UI_OFFER,
  formatUiLanguageLine,
  setSessionUiLanguage,
  shouldOfferEnglishUi,
  systemLocale,
  uiLanguageResolution,
  uiText,
  writeUserLanguageSetting,
} from './cli-locale.js';
import { setTuiLocale } from './tui/copy.js';
import { probeModel } from './connection-probe.js';
import {
  isSaveAnywayAnswer,
  pendingUserApiKeyEnv,
  reduceFirstRun,
  renderFirstRunLines,
  saveUserModelConfig,
  settleFirstRunJob,
  SETUP_PROVIDERS,
  type FirstRunSaved,
  type FirstRunView,
} from './first-run.js';

function L(en: string, locale?: string, vars?: Record<string, string | number>): string {
  return setupCopy(locale, en, vars);
}

/** The provider menu `moss setup` prints. Localized when the locale is Chinese. */
export function setupMenuLines(locale?: string): string[] {
  return [
    L('Moss model setup', locale),
    '',
    L('Choose provider:', locale),
    ...SETUP_PROVIDERS.map((item) => {
      const label = isZhLocale(locale) ? item.zh : item.en;
      const extra = item.id === 'd-robotics' ? L(' (recommended)', locale) : '';
      return `  ${item.key}. ${label}${extra}`;
    }),
  ];
}

export async function probeSetupReachability(
  config: Partial<ResolvedCliConfig>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string> {
  if (!config.provider || !config.baseUrl || !config.apiKey || !config.model) {
    return L('Saved. Pick a model with /model before the first prompt.');
  }
  const result = await probeModel({
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (result.ok) return result.message;
  return `${result.message} ${L('The config was saved. Fix this, then run moss.')}`;
}

/** How many gateway models `moss setup` prints before it says "showing N of M". */
export const SETUP_MODEL_LIST_CAP = 30;

/**
 * The heading count and the printed rows describe the same set.
 * A catalog longer than the cap says how many rows are shown.
 */
export function formatDiscoveredModels(
  ids: readonly string[],
  listCap = SETUP_MODEL_LIST_CAP
): { heading: string; lines: string[]; choices: string[] } {
  const choices: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const name = id.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (choices.length < listCap) choices.push(name);
  }
  const total = seen.size;
  const heading =
    total > choices.length
      ? uiText(
          `Found ${total} model(s), showing ${choices.length} of ${total}:`,
          `找到 ${total} 个模型，显示其中 ${choices.length} 个：`
        )
      : uiText(`Found ${choices.length} model(s):`, `找到 ${choices.length} 个模型：`);
  return {
    heading,
    choices,
    lines: choices.map((name, index) => `  ${index + 1}. ${name}`),
  };
}

export function renderSetupHelp(zh: boolean = isZhLocale()): string {
  return [
    zh ? '用法：' : 'Usage:',
    '  moss setup',
    '',
    zh
      ? '配置服务商、模型和 API key，并保存到 moss 配置文件。'
      : 'Configure the provider, model, and API key and save them to the moss config file.',
    zh
      ? 'API key 从隐藏输入读取，不会被打印。'
      : 'The API key is read from a hidden prompt and is never printed.',
    '',
    zh ? '服务商（输入序号或名字）：' : 'Providers (enter the number or the name):',
    ...SETUP_PROVIDERS.map((item) => {
      if (item.id === 'openai-compatible') {
        return zh
          ? `  ${item.key}  openai-compatible   网关地址，然后选择网关列出的模型`
          : `  ${item.key}  openai-compatible   gateway URL, then the models that gateway lists`;
      }
      if (item.id === 'd-robotics') {
        return zh
          ? `  ${item.key}  d-robotics          D-Robotics 地瓜网关（只问密钥）`
          : `  ${item.key}  d-robotics          D-Robotics gateway (asks only for the key)`;
      }
      return `  ${item.key}  ${item.id}`;
    }),
    '',
    zh
      ? '连接测试失败时不会写入配置。认证失败后回到隐藏的 API key；仍然保存是单独的 y/N，不会回显密钥。'
      : 'A failed connection check does not write the config. After an auth error the next prompt is the hidden API key. Save anyway is a separate y/N and never echoes a key.',
    zh ? '以后用 `moss config` 修改。' : 'Change a saved value later with `moss config`.',
    '',
    zh ? '选项：' : 'Options:',
    zh
      ? '  --config-file <path>   读写这个配置文件，而不是默认路径'
      : '  --config-file <path>   read and write this file instead of the default config',
    '',
    zh ? '示例：' : 'Examples:',
    '  moss setup',
    zh
      ? "  `printf 'openai-compatible\\nhttps://gateway.example\\nYOUR_KEY\\nmy-model\\n' | moss setup`"
      : "  printf 'openai-compatible\\nhttps://gateway.example\\nYOUR_KEY\\nmy-model\\n' | moss setup",
  ].join('\n');
}

export function print(line = ''): void {
  output.write(`${line}\n`);
}

type EchoMode = 'hidden' | 'guard' | 'choice';

const CHOICE_CHARS = new Set(['y', 'Y', 'n', 'N', '1', '2']);

/** `sk-…` or a long token. Visible prompts must not echo this. */
export function looksLikeApiKey(value: string): boolean {
  const text = value.trim();
  if (/^sk[-_]/i.test(text)) return true;
  return text.length >= 20 && !/\s/.test(text) && /^[A-Za-z0-9_\-./+=]+$/.test(text);
}

function echoingQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readRaw(prompt: string, mode: EchoMode): Promise<string> {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write(prompt);
    let value = '';
    let echoed = '';

    function paint(next: string) {
      if (next === echoed) return;
      if (echoed.length > 0) output.write('\b \b'.repeat(echoed.length));
      if (next.length > 0) output.write(next);
      echoed = next;
    }

    function visibleEcho(): string {
      if (mode === 'hidden' || looksLikeApiKey(value)) return '';
      if (mode === 'choice') return value.length === 1 && CHOICE_CHARS.has(value) ? value : '';
      return value;
    }

    function cleanup() {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      output.write('\n');
      resolve(value.trim());
    }

    function onKeypress(str: string, key: readline.Key) {
      if (key.ctrl && key.name === 'c') {
        output.write('\n');
        process.exit(130);
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        paint(visibleEcho());
        return;
      }
      if (!key.ctrl && !key.meta && str && str !== '\r' && str !== '\n') {
        value += str;
        paint(visibleEcho());
      }
    }

    input.on('keypress', onKeypress);
  });
}

export function question(prompt: string): Promise<string> {
  if (!input.isTTY) return echoingQuestion(prompt);
  return readRaw(prompt, 'guard');
}

function hiddenQuestion(prompt: string): Promise<string> {
  if (!input.isTTY) return echoingQuestion(prompt);
  return readRaw(prompt, 'hidden');
}

function choiceQuestion(prompt: string): Promise<string> {
  if (!input.isTTY) return echoingQuestion(prompt);
  return readRaw(prompt, 'choice');
}

export function sanitizeBaseUrl(value: string): string {
  return cleanGatewayUrl(value);
}

const MODEL_SIGNATURES: Record<CliProviderPreset, { prefixes: string[]; names: string[] }> = {
  deepseek: { prefixes: ['deepseek-'], names: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  qwen: {
    prefixes: ['qwen-', 'qwen3', 'qvq-', 'qwq-'],
    names: ['qwen3.6-plus', 'qwen3.7-max', 'qwen3.6-flash', 'qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  openai: {
    prefixes: ['gpt-', 'o1-', 'o3-', 'o4-', 'davinci-'],
    names: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'o1',
      'o1-mini',
      'o3-mini',
      'o4-mini',
    ],
  },
  anthropic: {
    prefixes: ['claude-'],
    names: [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
    ],
  },
  'openai-compatible': { prefixes: [], names: [] },
  'd-robotics': { prefixes: [], names: ['deepseek-flash'] },
};

export function guessModelProvider(model: string): CliProviderPreset | null {
  const lower = model.toLowerCase().trim();
  for (const [provider, sig] of Object.entries(MODEL_SIGNATURES)) {
    if (provider === 'openai-compatible') continue;
    if (sig.prefixes.some((p) => lower.startsWith(p))) return provider as CliProviderPreset;
    if (sig.names.some((n) => lower === n)) return provider as CliProviderPreset;
  }
  return null;
}

export function renderAuthStatus(
  config?: ConfigFile,
  env: NodeJS.ProcessEnv = process.env,
  startDir = process.cwd(),
  overrides: CliConfigOverrides = {},
  heading = '[auth]'
): string {
  const loaded =
    config === undefined ? loadCliConfigFile(env, process.argv.slice(2), startDir) : undefined;
  const resolved = resolveCliConfig(env, config ?? loaded?.config, overrides, loaded);
  return [
    heading,
    ...configSnapshotLines(
      resolved,
      [
        'provider',
        'profile',
        'model',
        'baseUrl',
        'apiKey',
        'safetyMode',
        'approvalPolicy',
        'trustedTools',
        'deniedTools',
        'promptCache',
        'promptCacheDebug',
        'guardrails',
        'maxTurns',
        'contextTokens',
        'compaction',
        'modelTiers',
        'warnings',
        'configPath',
        'projectConfig',
      ],
      'plain'
    ),
    formatUiLanguageLine(),
  ].join('\n');
}

interface SetupSuccessInfo {
  preset: { displayName: string };
  model: string;
  baseUrl: string;
  provider: CliProviderPreset;
  apiKey: string;
  probe: boolean;
}

/** One success printer for both wizard branches — the saved line, a real
 * reachability probe when interactive, the security note, and the next step. */
async function printSetupSuccess({
  preset,
  model,
  baseUrl,
  provider,
  apiKey,
  probe,
}: SetupSuccessInfo): Promise<void> {
  print('');
  const path = resolveConfigPath();
  const saved = model
    ? L('Saved {name} · model {model} → {path}', undefined, {
        name: preset.displayName,
        model,
        path,
      })
    : L('Saved {name} · model not set — pick one inside moss with /model → {path}', undefined, {
        name: preset.displayName,
        path,
      });
  print(saved);
  if (probe) {
    print(await probeSetupReachability({ provider, model, baseUrl, apiKey }));
  }
  print(
    L(
      'Security note: a pasted key is stored in the config file (mode 0600). Set apiKeyEnv to a variable name to keep the key out of that file.'
    )
  );
  print(L('Avoid sharing or committing this file. Run `moss auth logout` to remove the key.'));
  print(L('Next: ask moss to look around this folder (`moss` or `moss "explain this project"`).'));
  print(L(WORKSPACE_WRITE_LIMIT_EN));
}

function readOneKey(prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve('');
  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    try {
      input.setRawMode(true);
    } catch {
      resolve('');
      return;
    }
    input.resume();
    output.write(prompt);
    function finish(value: string): void {
      input.off('keypress', onKeypress);
      try {
        if (wasRaw !== undefined) input.setRawMode(wasRaw);
      } catch {
        /* the terminal is already going away */
      }
      output.write('\n');
      resolve(value);
    }
    function onKeypress(str: string, key: readline.Key) {
      if (key.ctrl && key.name === 'c') {
        output.write('\n');
        process.exit(130);
      }
      finish(str ?? '');
    }
    input.on('keypress', onKeypress);
  });
}

/** One keypress on a Chinese system locale: `e` switches the UI to English. */
export async function offerEnglishUiIfNeeded(): Promise<void> {
  let configLanguage: string | undefined;
  try {
    const stored = loadConfigFile();
    if (typeof stored.language === 'string') configLanguage = stored.language;
  } catch {
    configLanguage = undefined;
  }
  const resolution = uiLanguageResolution();
  if (
    !shouldOfferEnglishUi({
      tty: input.isTTY === true,
      systemLocale: systemLocale(envBeforeDotenv),
      configLanguage,
      source: resolution?.source,
    })
  ) {
    return;
  }
  const key = await readOneKey(ENGLISH_UI_OFFER);
  if (key === 'e' || key === 'E') {
    writeUserLanguageSetting('en');
    setSessionUiLanguage('en');
    setTuiLocale(false);
    print(uiText('UI language: English.', '界面语言：英语。'));
    return;
  }
  writeUserLanguageSetting('auto');
}

/** Readline driver over `reduceFirstRun`. Prompts are the state machine's lines. */
export async function runSetupWizard(): Promise<void> {
  await offerEnglishUiIfNeeded();
  const piped = input.isTTY ? null : fs.readFileSync(0, 'utf8').split(/\r?\n/);
  let lineNo = 0;
  const readAnswer = async (prompt: string, hidden = false): Promise<string> => {
    if (piped) return (piped[lineNo++] ?? '').trim();
    return hidden ? hiddenQuestion(prompt) : question(prompt);
  };

  const pendingEnv = pendingUserApiKeyEnv();
  let view: FirstRunView = {
    step: 'provider',
    offers: [],
    cursor: 0,
    ...(pendingEnv ? { apiKeyEnv: pendingEnv } : {}),
  };
  let secret = pendingEnv ? (process.env[pendingEnv] ?? '').trim() : '';

  const acceptKey = (value: string): void => {
    secret = value;
    view = reduceFirstRun(
      { ...view, step: 'key', apiKeyEnv: undefined, error: undefined },
      { type: 'enter', draft: '' },
      secret
    ).view;
  };

  const commit = async (saved: FirstRunSaved): Promise<void> => {
    saveUserModelConfig({
      provider: saved.provider,
      model: saved.model,
      baseUrl: saved.baseUrl,
      ...(saved.apiKeyEnv ? { apiKeyEnv: saved.apiKeyEnv } : { apiKey: secret }),
    });
    await printSetupSuccess({
      preset: PROVIDER_PRESETS[saved.provider],
      model: saved.model,
      baseUrl: saved.baseUrl,
      provider: saved.provider,
      apiKey: secret,
      probe: false,
    });
  };

  const commitAnyway = async (): Promise<'saved' | 'continue' | 'abort'> => {
    let model = view.model ?? '';
    if (!model) {
      const typed = await readAnswer(L('Model name: '));
      if (looksLikeApiKey(typed)) {
        acceptKey(typed);
        return 'continue';
      }
      model = typed;
    }
    const provider = view.provider ?? 'openai-compatible';
    const baseUrl = view.baseUrl ?? '';
    if (!secret.trim() || !baseUrl || !model) {
      print(L('An API key is required.'));
      process.exitCode = 1;
      return 'abort';
    }
    await commit({
      provider,
      baseUrl,
      model,
      ...(view.apiKeyEnv ? { apiKeyEnv: view.apiKeyEnv } : {}),
    });
    return 'saved';
  };

  const readExplicitChoice = async (
    prompt: string
  ): Promise<{ kind: 'yes' } | { kind: 'no' } | { kind: 'key'; value: string }> => {
    const answer = piped ? await readAnswer(prompt) : await choiceQuestion(prompt);
    if (looksLikeApiKey(answer)) return { kind: 'key', value: answer };
    if (isSaveAnywayAnswer(answer) || /^y(es)?$/i.test(answer) || answer === '2') {
      return { kind: 'yes' };
    }
    return { kind: 'no' };
  };

  const applyChoice = async (
    choice: { kind: 'yes' } | { kind: 'no' } | { kind: 'key'; value: string }
  ): Promise<'saved' | 'continue' | 'abort'> => {
    if (choice.kind === 'key') {
      acceptKey(choice.value);
      return 'continue';
    }
    if (choice.kind === 'yes') return commitAnyway();
    if (view.step === 'error') {
      const reduced = reduceFirstRun(view, { type: 'escape' }, secret);
      if (reduced.secretOp === 'clear') secret = '';
      view = reduced.view;
    } else view = { ...view, error: undefined };
    return 'continue';
  };

  for (let guard = 0; guard < 24; guard += 1) {
    if (view.step === 'working' && view.pending) {
      const applied = await settleFirstRunJob(view, view.pending, secret);
      if (applied.message) print(applied.message);
      if (applied.saved) {
        await commit(applied.saved);
        return;
      }
      view = applied.view;
      continue;
    }
    const keyPrompt = L('API key (hidden): {dots}', undefined, { dots: '' });
    for (const row of renderFirstRunLines(view, undefined, 'readline')) {
      if (view.step === 'key' && (row === keyPrompt || row.startsWith(keyPrompt))) continue;
      print(row);
    }
    if (view.step === 'error' || (view.error && view.step !== 'key')) {
      if (view.step === 'error' && view.failStep === 'key') {
        const pasted = await readAnswer(keyPrompt, true);
        if (pasted) {
          acceptKey(pasted);
          continue;
        }
      }
      const outcome = await applyChoice(
        await readExplicitChoice(L('Save this config anyway? [y/N] '))
      );
      if (outcome !== 'continue') return;
      continue;
    }
    const hidden = view.step === 'key';
    const answer = await readAnswer(hidden ? keyPrompt : '', hidden);
    if (!hidden && looksLikeApiKey(answer)) {
      acceptKey(answer);
      continue;
    }
    if (hidden) {
      secret = answer;
      view = reduceFirstRun(
        { ...view, apiKeyEnv: undefined },
        { type: 'enter', draft: '' },
        secret
      ).view;
      continue;
    }
    const reduced = reduceFirstRun(view, { type: 'enter', draft: answer }, secret);
    if (reduced.saved) {
      await commit(reduced.saved);
      return;
    }
    view = reduced.view;
  }
  process.exitCode = 1;
}

export async function runAuthLogout(): Promise<void> {
  const current = loadConfigFile();
  if (!current.apiKey) {
    print(uiText('[auth] No API key is stored.', '[auth] 没有已保存的 API 密钥。'));
    return;
  }
  const answer = await question(
    uiText(
      'Remove stored API key from Moss config? [y/N] ',
      '从 Moss 配置中删除已保存的 API 密钥？[y/N] '
    )
  );
  if (!/^y(es)?$/i.test(answer)) {
    print(uiText('[auth] Cancelled.', '[auth] 已取消。'));
    return;
  }
  const next = { ...current };
  delete next.apiKey;
  saveConfigFile(next);
  print(
    uiText(
      '[auth] Stored API key removed. Model and baseUrl were preserved.',
      '[auth] 已删除保存的 API 密钥。模型和 baseUrl 保留。'
    )
  );
}
