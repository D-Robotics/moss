import fs from 'node:fs';
import * as readline from 'node:readline';
import { stdin as input, stderr as output } from 'node:process';
import { buildApiV1Url, isHttpUrl, stripEndpointSuffix } from '../provider/api-v1-url.js';
import {
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
import { isZhLocale } from './cli-locale.js';
import { loadModelChoicesForRuntime } from './model-catalog.js';

function L(en: string, zh: string, locale?: string): string {
  return isZhLocale(locale) ? zh : en;
}

/** The provider menu `moss setup` prints. Localized when the locale is Chinese. */
export function setupMenuLines(locale?: string): string[] {
  return [
    L('Moss model setup', 'Moss 模型配置', locale),
    '',
    L('Choose provider:', '选择提供方：', locale),
    L('  1. DeepSeek (recommended)', '  1. DeepSeek（推荐）', locale),
    L('  2. Aliyun / Qwen', '  2. 阿里云 / Qwen', locale),
    '  3. OpenAI',
    '  4. Anthropic',
    L('  5. OpenAI-compatible', '  5. OpenAI 兼容', locale),
  ];
}

export async function probeSetupReachability(
  config: Partial<ResolvedCliConfig>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; locale?: string } = {}
): Promise<string> {
  const locale = options.locale;
  let result;
  try {
    result = await loadModelChoicesForRuntime(config, config.model ?? '', {
      timeoutMs: options.timeoutMs ?? 2500,
      fetchImpl: options.fetchImpl,
    });
  } catch {
    return L(
      'Saved, but could not reach the gateway with this key — check baseUrl/key, then re-run `moss setup`.',
      '已保存，但用这把密钥连不上网关 — 请检查 baseUrl/密钥，然后重新运行 `moss setup`。',
      locale
    );
  }
  if (result.source === 'live') {
    const count = result.choices.length;
    return L(
      `Configured and reachable — ${count} model(s) available from the gateway.`,
      `已配置且可连通 — 网关提供 ${count} 个模型。`,
      locale
    );
  }
  if (result.warning) {
    return L(
      'Saved, but could not reach the gateway with this key — check baseUrl/key, then re-run `moss setup`.',
      '已保存，但用这把密钥连不上网关 — 请检查 baseUrl/密钥，然后重新运行 `moss setup`。',
      locale
    );
  }
  return L(
    `Key saved (${result.providerLabel} — skipping live reachability check).`,
    `密钥已保存（${result.providerLabel} — 跳过实时连通性检查）。`,
    locale
  );
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
      ? `Found ${total} model(s), showing ${choices.length} of ${total}:`
      : `Found ${choices.length} model(s):`;
  return {
    heading,
    choices,
    lines: choices.map((name, index) => `  ${index + 1}. ${name}`),
  };
}

export function renderSetupHelp(): string {
  return [
    'Usage:',
    '  moss setup',
    '',
    'Configure the provider, model, and API key and save them to the moss config file.',
    'The API key is read from a hidden prompt and is never printed.',
    '',
    'Providers (enter the number or the name):',
    '  1  deepseek            DeepSeek',
    '  2  qwen                Aliyun / Qwen',
    '  3  openai              OpenAI',
    '  4  anthropic           Anthropic',
    '  5  openai-compatible   gateway URL, then the models that gateway lists',
    '',
    'OpenAI-compatible lists models from /v1/models. The "Found N model(s)" count',
    'matches the list; a longer catalog says how many rows are shown.',
    'Answer with a number or a model name. A base URL is stored as the API root:',
    '/v1, /chat/completions, query strings, and credentials are stripped.',
    '',
    'Non-interactive: pipe one answer per line (provider, then each prompt).',
    'Change a saved value later with `moss config` (`moss config --help`).',
    '',
    'Examples:',
    '  moss setup',
    "  printf '5\\nhttps://gateway.example\\nYOUR_KEY\\nmy-model\\n' | moss setup",
  ].join('\n');
}

export function print(line = ''): void {
  output.write(`${line}\n`);
}

export function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function questionWith(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function hiddenQuestion(prompt: string): Promise<string> {
  if (!input.isTTY) return question(prompt);

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write(prompt);
    let value = '';

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
        return;
      }
      if (!key.ctrl && !key.meta && str) {
        value += str;
      }
    }

    input.on('keypress', onKeypress);
  });
}

function providerFromChoice(choice: string): CliProviderPreset {
  const normalized = choice.trim().toLowerCase();
  if (normalized === '1' || normalized === 'deepseek' || normalized === 'ds') return 'deepseek';
  if (normalized === '2' || normalized === 'qwen' || normalized === 'aliyun') return 'qwen';
  if (normalized === '3' || normalized === 'openai') return 'openai';
  if (normalized === '4' || normalized === 'anthropic' || normalized === 'claude')
    return 'anthropic';
  if (normalized === '5' || normalized === 'compatible' || normalized === 'openai-compatible')
    return 'openai-compatible';
  return 'deepseek';
}

export function sanitizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return stripEndpointSuffix(url.toString());
  } catch {
    return stripEndpointSuffix(trimmed);
  }
}

const MODEL_SIGNATURES: Record<CliProviderPreset, { prefixes: string[]; names: string[] }> = {
  deepseek: {
    prefixes: ['deepseek-'],
    names: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
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
        'warnings',
        'configPath',
        'projectConfig',
      ],
      'plain'
    ),
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
  print(
    L(
      `Saved ${preset.displayName}${model ? ` · model ${model}` : ' · model not set — pick one inside moss with /model'} → ${resolveConfigPath()}`,
      `已保存 ${preset.displayName}${model ? ` · 模型 ${model}` : ' · 尚未选择模型 — 在 moss 里用 /model 选择'} → ${resolveConfigPath()}`
    )
  );
  if (probe) {
    print(await probeSetupReachability({ provider, model, baseUrl, apiKey }));
  }
  print(
    L(
      'Security note: the API key is stored encrypted in the config file (file mode 600).',
      '安全说明：API 密钥以加密形式存在配置文件中（文件权限 600）。'
    )
  );
  print(
    L(
      'Avoid sharing or committing this file. Run `moss auth logout` to remove the key.',
      '不要分享或提交这个文件。运行 `moss auth logout` 可删除密钥。'
    )
  );
  print(
    L(
      'Try `moss "explain this project and how to run it"` or run `moss` for interactive mode.',
      '试试 `moss "explain this project and how to run it"`，或直接运行 `moss` 进入交互模式。'
    )
  );
}

export async function runSetupWizard(): Promise<void> {
  const current = loadConfigFile();
  for (const menuLine of setupMenuLines()) print(menuLine);

  const pipedAnswers = input.isTTY ? null : fs.readFileSync(0, 'utf-8').split(/\r?\n/);
  let answerIndex = 0;
  const nextPipedAnswer = () => (pipedAnswers ? (pipedAnswers[answerIndex++] ?? '').trim() : '');

  const rl = input.isTTY ? readline.createInterface({ input, output }) : null;
  const providerAnswer = rl
    ? await questionWith(rl, L('Provider [1]: ', '提供方 [1]：'))
    : nextPipedAnswer();
  const provider = providerFromChoice(providerAnswer || '1');
  const preset = PROVIDER_PRESETS[provider];

  const defaultModel = current.model || preset.defaultModel;
  const defaultBaseUrl = current.baseUrl || preset.defaultBaseUrl;

  if (provider === 'openai-compatible') {
    const baseUrlPrompt = defaultBaseUrl
      ? L(`Gateway URL [${defaultBaseUrl}]: `, `网关 URL [${defaultBaseUrl}]：`)
      : L('Gateway URL: ', '网关 URL：');
    const baseUrlAnswer = rl ? await questionWith(rl, baseUrlPrompt) : nextPipedAnswer();
    const baseUrlInput = baseUrlAnswer || defaultBaseUrl;
    if (!isHttpUrl(baseUrlInput)) {
      rl?.close();
      print(
        L(
          `Setup cancelled: base URL must be a full http(s) URL, got: ${baseUrlInput}`,
          `配置已取消：base URL 必须是完整的 http(s) URL，收到：${baseUrlInput}`
        )
      );
      process.exitCode = 1;
      return;
    }
    const baseUrl = sanitizeBaseUrl(baseUrlInput);
    if (baseUrl !== baseUrlInput.trim().replace(/\/+$/, '')) {
      print('');
      print(
        L(
          `Note: base URL normalized to "${baseUrl}" (endpoint paths, query strings, and credentials stripped).`,
          `注意：base URL 已规范为 "${baseUrl}"（已去掉端点路径、查询串和凭据）。`
        )
      );
    }

    if (input.isTTY) rl?.close();
    const apiKey = input.isTTY
      ? await hiddenQuestion(L('API key (hidden): ', 'API 密钥（隐藏）：'))
      : nextPipedAnswer();
    if (!apiKey) {
      print(L('Setup cancelled: API key is required.', '配置已取消：必须填写 API 密钥。'));
      process.exitCode = 1;
      return;
    }

    let model = defaultModel;
    let skipPostProbe = false;
    if (input.isTTY) {
      print('');
      print(L('Checking available models on your gateway…', '正在查询网关上的可用模型…'));
      const liveModels = await (async () => {
        try {
          const res = await fetch(buildApiV1Url(baseUrl, 'models'), {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [];
          const json = (await res.json()) as { data?: { id?: string; name?: string }[] };
          return (json?.data ?? []).flatMap((item) => {
            const id = item?.id ?? item?.name ?? '';
            return typeof id === 'string' && id.trim() ? [id.trim()] : [];
          });
        } catch {
          return [];
        }
      })();
      const listed = formatDiscoveredModels(liveModels);
      const rl2 = readline.createInterface({ input, output });
      if (listed.choices.length > 0) {
        skipPostProbe = true;
        const shown = listed.choices.length;
        const total = Number(/^Found (\d+) model/.exec(listed.heading)?.[1] ?? shown);
        print(
          L(
            listed.heading,
            total > shown
              ? `找到 ${total} 个模型，显示其中 ${shown} 个：`
              : `找到 ${shown} 个模型：`
          )
        );
        for (const line of listed.lines) print(line);
        const defaultChoice = defaultModel || listed.choices[0]!;
        const ans = (
          await questionWith(
            rl2,
            L(`Choose model [${defaultChoice}]: `, `选择模型 [${defaultChoice}]：`)
          )
        ).trim();
        if (/^\d+$/.test(ans)) {
          model = listed.choices[parseInt(ans, 10) - 1] ?? defaultChoice;
        } else {
          model = ans || defaultChoice;
        }
      } else {
        print(
          L(
            'Note: could not reach /v1/models — enter your model name manually.',
            '注意：无法访问 /v1/models — 请手动输入模型名。'
          )
        );
        const ans = (
          await questionWith(
            rl2,
            L(
              `Model name${defaultModel ? ` [${defaultModel}]` : ''}: `,
              `模型名${defaultModel ? ` [${defaultModel}]` : ''}：`
            )
          )
        ).trim();
        model = ans || defaultModel;
      }
      rl2.close();
    } else {
      const ans = nextPipedAnswer();
      model = ans || defaultModel;
    }

    const next: ConfigFile = {
      ...current,
      provider,
      baseUrl,
      apiKey,
      promptCache: current.promptCache ?? { enabled: true, debug: false },
      ...(model ? { model } : {}),
    };
    saveConfigFile(next);
    await printSetupSuccess({
      preset,
      model,
      baseUrl,
      provider,
      apiKey,
      probe: !skipPostProbe && input.isTTY,
    });
    return;
  }

  const fastPath = Boolean(rl);
  let model: string;
  let baseUrlInput: string;
  if (fastPath) {
    model = defaultModel;
    baseUrlInput = defaultBaseUrl;
    print(
      L(
        `Using ${preset.displayName} defaults — model ${defaultModel}, base URL ${defaultBaseUrl}.`,
        `使用 ${preset.displayName} 的默认值 — 模型 ${defaultModel}，base URL ${defaultBaseUrl}。`
      )
    );
    print(
      L(
        '(Change later with `moss config set model <name>` or `moss config set baseUrl <url>`.)',
        '（之后可用 `moss config set model <name>` 或 `moss config set baseUrl <url>` 修改。）'
      )
    );
  } else {
    const modelAnswer = rl
      ? await questionWith(rl, L(`Model [${defaultModel}]: `, `模型 [${defaultModel}]：`))
      : nextPipedAnswer();
    model = modelAnswer || defaultModel;
    const baseUrlAnswer = rl
      ? await questionWith(
          rl,
          L(`Base URL [${defaultBaseUrl}]: `, `Base URL [${defaultBaseUrl}]：`)
        )
      : nextPipedAnswer();
    baseUrlInput = baseUrlAnswer || defaultBaseUrl;
  }
  if (!isHttpUrl(baseUrlInput)) {
    rl?.close();
    print(
      L(
        `Setup cancelled: base URL must be a full http(s) URL, got: ${baseUrlInput}`,
        `配置已取消：base URL 必须是完整的 http(s) URL，收到：${baseUrlInput}`
      )
    );
    process.exitCode = 1;
    return;
  }
  const baseUrl = sanitizeBaseUrl(baseUrlInput);
  const wasNormalized = baseUrl !== baseUrlInput.trim().replace(/\/+$/, '');
  if (wasNormalized) {
    print('');
    print(
      L(
        `Note: the base URL was normalized from "${baseUrlInput.trim()}" to "${baseUrl}".`,
        `注意：base URL 已从 "${baseUrlInput.trim()}" 规范为 "${baseUrl}"。`
      )
    );
    print(
      L(
        'Endpoint paths (/v1/chat/completions, /v1), query strings (?foo=bar), and credentials were stripped.',
        '已去掉端点路径（/v1/chat/completions、/v1）、查询串（?foo=bar）和凭据。'
      )
    );
    print(
      L(
        'Moss appends /v1/chat/completions itself — the saved value above is your API root.',
        'Moss 会自己追加 /v1/chat/completions — 上面保存的值是 API 根地址。'
      )
    );
  }
  let apiKey: string;
  if (input.isTTY) {
    rl?.close();
    apiKey = await hiddenQuestion(L('API key (hidden): ', 'API 密钥（隐藏）：'));
  } else {
    apiKey = nextPipedAnswer();
  }

  if (!apiKey) {
    print(L('Setup cancelled: API key is required.', '配置已取消：必须填写 API 密钥。'));
    process.exitCode = 1;
    return;
  }

  const next: ConfigFile = {
    ...current,
    provider,
    model,
    baseUrl,
    apiKey,
    promptCache: current.promptCache ?? { enabled: true, debug: false },
  };
  saveConfigFile(next);
  await printSetupSuccess({
    preset,
    model,
    baseUrl,
    provider,
    apiKey,
    probe: input.isTTY,
  });
}

export async function runAuthLogout(): Promise<void> {
  const current = loadConfigFile();
  if (!current.apiKey) {
    print('[auth] No API key is stored.');
    return;
  }
  const answer = await question('Remove stored API key from Moss config? [y/N] ');
  if (!/^y(es)?$/i.test(answer)) {
    print('[auth] Cancelled.');
    return;
  }
  const next = { ...current };
  delete next.apiKey;
  saveConfigFile(next);
  print('[auth] Stored API key removed. Model and baseUrl were preserved.');
}
