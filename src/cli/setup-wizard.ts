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
import { loadModelChoicesForRuntime } from './model-catalog.js';

export async function probeSetupReachability(
  config: Partial<ResolvedCliConfig>,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string> {
  let result;
  try {
    result = await loadModelChoicesForRuntime(config, config.model ?? '', {
      timeoutMs: options.timeoutMs ?? 2500,
      fetchImpl: options.fetchImpl,
    });
  } catch {
    return 'Saved, but could not reach the gateway with this key — check baseUrl/key, then re-run `moss setup`.';
  }
  if (result.source === 'live') {
    return `Configured and reachable — ${result.choices.length} model(s) available from the gateway.`;
  }
  if (result.warning) {
    return 'Saved, but could not reach the gateway with this key — check baseUrl/key, then re-run `moss setup`.';
  }
  return `Key saved (${result.providerLabel} — skipping live reachability check).`;
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
    `Saved ${preset.displayName}${model ? ` · model ${model}` : ' · model not set — pick one inside moss with /model'} → ${resolveConfigPath()}`
  );
  if (probe) {
    print(await probeSetupReachability({ provider, model, baseUrl, apiKey }));
  }
  print('Security note: the API key is stored encrypted in the config file (file mode 600).');
  print('Avoid sharing or committing this file. Run `moss auth logout` to remove the key.');
  print('Try `moss "explain this project and how to run it"` or run `moss` for interactive mode.');
}

export async function runSetupWizard(): Promise<void> {
  const current = loadConfigFile();
  print('Moss model setup');
  print('');
  print('Choose provider:');
  print('  1. DeepSeek (recommended)');
  print('  2. Aliyun / Qwen');
  print('  3. OpenAI');
  print('  4. Anthropic');
  print('  5. OpenAI-compatible');

  const pipedAnswers = input.isTTY ? null : fs.readFileSync(0, 'utf-8').split(/\r?\n/);
  let answerIndex = 0;
  const nextPipedAnswer = () => (pipedAnswers ? (pipedAnswers[answerIndex++] ?? '').trim() : '');

  const rl = input.isTTY ? readline.createInterface({ input, output }) : null;
  const providerAnswer = rl ? await questionWith(rl, 'Provider [1]: ') : nextPipedAnswer();
  const provider = providerFromChoice(providerAnswer || '1');
  const preset = PROVIDER_PRESETS[provider];

  const defaultModel = current.model || preset.defaultModel;
  const defaultBaseUrl = current.baseUrl || preset.defaultBaseUrl;

  if (provider === 'openai-compatible') {
    const baseUrlPrompt = defaultBaseUrl ? `Gateway URL [${defaultBaseUrl}]: ` : 'Gateway URL: ';
    const baseUrlAnswer = rl ? await questionWith(rl, baseUrlPrompt) : nextPipedAnswer();
    const baseUrlInput = baseUrlAnswer || defaultBaseUrl;
    if (!isHttpUrl(baseUrlInput)) {
      rl?.close();
      print(`Setup cancelled: base URL must be a full http(s) URL, got: ${baseUrlInput}`);
      process.exitCode = 1;
      return;
    }
    const baseUrl = sanitizeBaseUrl(baseUrlInput);
    if (baseUrl !== baseUrlInput.trim().replace(/\/+$/, '')) {
      print('');
      print(
        `Note: base URL normalized to "${baseUrl}" (endpoint paths, query strings, and credentials stripped).`
      );
    }

    if (input.isTTY) rl?.close();
    const apiKey = input.isTTY ? await hiddenQuestion('API key (hidden): ') : nextPipedAnswer();
    if (!apiKey) {
      print('Setup cancelled: API key is required.');
      process.exitCode = 1;
      return;
    }

    let model = defaultModel;
    let skipPostProbe = false;
    if (input.isTTY) {
      print('');
      print('Checking available models on your gateway…');
      const liveModels = await (async () => {
        try {
          const res = await fetch(buildApiV1Url(baseUrl, 'models'), {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [];
          const json = (await res.json()) as { data?: { id?: string; name?: string }[] };
          return (json?.data ?? [])
            .flatMap((item) => {
              const id = item?.id ?? item?.name ?? '';
              return typeof id === 'string' && id.trim() ? [id.trim()] : [];
            })
            .slice(0, 30);
        } catch {
          return [];
        }
      })();
      const rl2 = readline.createInterface({ input, output });
      if (liveModels.length > 0) {
        skipPostProbe = true;
        print(`Found ${liveModels.length} model(s):`);
        liveModels.slice(0, 15).forEach((m, i) => print(`  ${i + 1}. ${m}`));
        const defaultChoice = defaultModel || liveModels[0]!;
        const ans = (await questionWith(rl2, `Choose model [${defaultChoice}]: `)).trim();
        if (/^\d+$/.test(ans)) {
          model = liveModels[parseInt(ans, 10) - 1] ?? defaultChoice;
        } else {
          model = ans || defaultChoice;
        }
      } else {
        print('Note: could not reach /v1/models — enter your model name manually.');
        const ans = (
          await questionWith(rl2, `Model name${defaultModel ? ` [${defaultModel}]` : ''}: `)
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
      `Using ${preset.displayName} defaults — model ${defaultModel}, base URL ${defaultBaseUrl}.`
    );
    print('(Change later with `moss config set model <name>` or `moss config set baseUrl <url>`.)');
  } else {
    const modelAnswer = rl
      ? await questionWith(rl, `Model [${defaultModel}]: `)
      : nextPipedAnswer();
    model = modelAnswer || defaultModel;
    const baseUrlAnswer = rl
      ? await questionWith(rl, `Base URL [${defaultBaseUrl}]: `)
      : nextPipedAnswer();
    baseUrlInput = baseUrlAnswer || defaultBaseUrl;
  }
  if (!isHttpUrl(baseUrlInput)) {
    rl?.close();
    print(`Setup cancelled: base URL must be a full http(s) URL, got: ${baseUrlInput}`);
    process.exitCode = 1;
    return;
  }
  const baseUrl = sanitizeBaseUrl(baseUrlInput);
  const wasNormalized = baseUrl !== baseUrlInput.trim().replace(/\/+$/, '');
  if (wasNormalized) {
    print('');
    print(`Note: the base URL was normalized from "${baseUrlInput.trim()}" to "${baseUrl}".`);
    print(
      'Endpoint paths (/v1/chat/completions, /v1), query strings (?foo=bar), and credentials were stripped.'
    );
    print('Moss appends /v1/chat/completions itself — the saved value above is your API root.');
  }
  let apiKey: string;
  if (input.isTTY) {
    rl?.close();
    apiKey = await hiddenQuestion('API key (hidden): ');
  } else {
    apiKey = nextPipedAnswer();
  }

  if (!apiKey) {
    print('Setup cancelled: API key is required.');
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
