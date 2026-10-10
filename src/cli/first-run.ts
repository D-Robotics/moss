/**
 * Inline first-run setup. The view never carries a key. The host keeps the
 * secret and only sends it to the probe and to `saveUserModelConfig`.
 */
import {
  envBeforeDotenv,
  loadConfigFile,
  resolveConfigDir,
  resolveConfigPath,
  saveConfigFile,
  type ConfigFile,
} from './config.js';
import { isZhLocale, setupCopy } from './cli-locale.js';
import {
  credentialById,
  detectEnvCredentials,
  offerUsesOfficialHost,
  toPublicOffer,
  type PublicOffer,
} from './env-credentials.js';
import {
  fetchGatewayModels,
  probeModel,
  type ConnectionFailure,
  type ProbeResult,
} from './connection-probe.js';
import { PROVIDER_PRESETS, type CliProviderPreset } from '../provider/provider-presets.js';
import { cleanGatewayUrl, isHttpUrl } from '../provider/api-v1-url.js';

export interface SetupProviderChoice {
  key: string;
  id: CliProviderPreset;
  en: string;
  zh: string;
}

const SETUP_ORDER: readonly CliProviderPreset[] = [
  'd-robotics',
  'deepseek',
  'qwen',
  'openai',
  'anthropic',
  'openai-compatible',
];

const SETUP_LABELS: Record<CliProviderPreset, { en: string; zh: string }> = {
  deepseek: { en: 'DeepSeek', zh: 'DeepSeek' },
  qwen: { en: PROVIDER_PRESETS.qwen.displayName, zh: '阿里云 / 通义千问' },
  openai: { en: 'OpenAI', zh: 'OpenAI' },
  anthropic: { en: 'Anthropic', zh: 'Anthropic' },
  'openai-compatible': { en: 'OpenAI-compatible gateway', zh: 'OpenAI 兼容网关' },
  'd-robotics': { en: 'D-Robotics gateway', zh: 'D-Robotics 地瓜网关' },
};

export const SETUP_PROVIDERS: readonly SetupProviderChoice[] = SETUP_ORDER.map((id, index) => ({
  key: String(index + 1),
  id,
  en: SETUP_LABELS[id].en,
  zh: SETUP_LABELS[id].zh,
}));

const PROVIDER_ALIASES: Record<string, CliProviderPreset> = {
  ds: 'deepseek',
  aliyun: 'qwen',
  dashscope: 'qwen',
  claude: 'anthropic',
  compatible: 'openai-compatible',
  custom: 'openai-compatible',
  gateway: 'openai-compatible',
  drobotics: 'd-robotics',
  digua: 'd-robotics',
  地瓜: 'd-robotics',
};

export function isSaveAnywayAnswer(answer: string): boolean {
  const text = answer.trim();
  return text === '仍然保存' || /^save anyway$/i.test(text);
}

export type FirstRunStep = 'offer' | 'provider' | 'url' | 'key' | 'model' | 'working' | 'error';

export interface FirstRunJob {
  type: 'models' | 'probe';
  provider: CliProviderPreset;
  baseUrl: string;
  model?: string;
}

export interface FirstRunSaved {
  provider: CliProviderPreset;
  baseUrl: string;
  model: string;
  /** Set when the user accepted an env offer. The file stores the name only. */
  apiKeyEnv?: string;
}

export interface FirstRunView {
  step: FirstRunStep;
  offers: PublicOffer[];
  cursor: number;
  provider?: CliProviderPreset;
  baseUrl?: string;
  model?: string;
  models?: string[];
  error?: string;
  notice?: string;
  keyDots?: number;
  pending?: FirstRunJob;
  /** Where Esc on the error step goes. The hint names this same step. */
  failStep?: 'url' | 'key' | 'provider';
  /** Env-offer variable name. A pasted key clears this. */
  apiKeyEnv?: string;
  /** The next model name is saved without another probe ("仍然保存"). */
  commitOnModel?: boolean;
}

export type FirstRunCommand =
  | { type: 'char'; char: string }
  | { type: 'backspace' }
  | { type: 'enter'; draft: string }
  | { type: 'escape' }
  | { type: 'up' }
  | { type: 'down' };

export interface FirstRunReduction {
  view: FirstRunView;
  consume: boolean;
  secretOp?: 'append' | 'backspace' | 'clear';
  offerId?: string;
  job?: FirstRunJob;
  /** Set only after a passing check, or when the user typed "仍然保存". */
  saved?: FirstRunSaved;
}

function copy(
  locale: string | undefined,
  en: string,
  vars?: Record<string, string | number>
): string {
  return setupCopy(locale, en, vars);
}

/** User file names `apiKeyEnv` and neither provider nor base URL. */
export function pendingUserApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.MOSS_CONFIG_DIR && !env.HOME && !env.USERPROFILE) return undefined;
  try {
    const file = loadConfigFile(resolveConfigPath(resolveConfigDir(env), env));
    const named = typeof file.apiKeyEnv === 'string' ? file.apiKeyEnv.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(named)) return undefined;
    if (file.provider !== undefined || file.baseUrl !== undefined) return undefined;
    return named;
  } catch {
    return undefined;
  }
}

export function initialFirstRunView(env: NodeJS.ProcessEnv = envBeforeDotenv): FirstRunView {
  const offers = detectEnvCredentials(env).map(toPublicOffer);
  const pending = pendingUserApiKeyEnv(env);
  const apiKeyEnv = pending ? { apiKeyEnv: pending } : {};
  return offers.length > 0
    ? { step: 'offer', offers, cursor: 0, ...apiKeyEnv }
    : { step: 'provider', offers, cursor: 0, ...apiKeyEnv };
}

export function normalizeGatewayUrl(value: string): string {
  return cleanGatewayUrl(value);
}

function providerFromInput(text: string, cursor: number): CliProviderPreset | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return SETUP_PROVIDERS[cursor]?.id ?? 'd-robotics';
  const byKey = SETUP_PROVIDERS.find((item) => item.key === normalized || item.id === normalized);
  return byKey?.id ?? PROVIDER_ALIASES[normalized] ?? null;
}

function editDistance(leftRaw: string, rightRaw: string): number {
  const left = leftRaw.toLowerCase();
  const right = rightRaw.toLowerCase();
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const row = [...prev];
  for (let i = 1; i <= left.length; i++) {
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j < row.length; j++) prev[j] = row[j] ?? 0;
  }
  return prev[right.length] ?? 0;
}

export function closestModelName(input: string, models: readonly string[]): string | undefined {
  const text = input.trim();
  if (!text || models.length === 0) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const model of models) {
    const distance = editDistance(text, model);
    if (distance < bestDistance) {
      best = model;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > Math.max(2, Math.floor(text.length * 0.34))) return undefined;
  return best;
}

export function interpretModelInput(
  input: string,
  models: readonly string[],
  fallback: string,
  locale?: string
): { model: string; reject?: string; suggested?: string } {
  const text = input.trim();
  if (!text) return { model: fallback || models[0] || '' };
  if (/^\d+$/.test(text)) {
    const model = models[Number.parseInt(text, 10) - 1];
    if (model) return { model };
    if (models.length === 0) return { model: fallback || text };
    return { model: '', reject: copy(locale, 'That number is not in the list.') };
  }
  const exact = models.find((model) => model.toLowerCase() === text.toLowerCase());
  if (exact) return { model: exact };
  if (models.length === 0) return { model: text };
  const suggested = closestModelName(text, models);
  return {
    model: '',
    ...(suggested ? { suggested } : {}),
    reject: suggested
      ? copy(
          locale,
          '"{text}" is not in the list. Closest match: {suggested}. Type its number, or press Enter to use {suggested}.',
          { text, suggested }
        )
      : copy(locale, '"{text}" is not in the list. Pick one of the numbered models.', { text }),
  };
}

export function resolveSetupModelChoice(
  input: string,
  models: readonly string[],
  fallback: string
): string {
  const picked = interpretModelInput(input, models, fallback);
  return picked.reject ? '' : picked.model || fallback || input.trim();
}

function go(
  view: FirstRunView,
  patch: Partial<FirstRunView> = {},
  extra: Partial<FirstRunReduction> = {}
): FirstRunReduction {
  const { consume, ...rest } = extra;
  return { ...rest, view: { ...view, ...patch }, consume: consume ?? true };
}

function savedConfig(
  view: FirstRunView,
  provider: CliProviderPreset,
  baseUrl: string,
  model: string
): FirstRunSaved {
  return { provider, baseUrl, model, ...(view.apiKeyEnv ? { apiKeyEnv: view.apiKeyEnv } : {}) };
}

function afterProvider(
  view: FirstRunView,
  provider: CliProviderPreset,
  secret: string
): FirstRunReduction {
  const preset = PROVIDER_PRESETS[provider];
  const base = {
    provider,
    cursor: 0,
    error: undefined,
    notice: undefined,
    apiKeyEnv: view.apiKeyEnv,
  };
  if (provider === 'openai-compatible') return go(view, { ...base, step: 'url' });
  const fields = {
    ...base,
    baseUrl: preset.defaultBaseUrl,
    model: preset.defaultModel,
    keyDots: 0,
  };
  if (view.apiKeyEnv && secret.trim()) {
    const job: FirstRunJob = {
      type: 'probe',
      provider,
      baseUrl: preset.defaultBaseUrl,
      model: preset.defaultModel,
    };
    return go(view, { ...fields, step: 'working', pending: job }, { job });
  }
  return go(view, { ...fields, step: 'key' }, { secretOp: 'clear' });
}

function jobForKey(view: FirstRunView): FirstRunJob {
  const provider = view.provider ?? 'deepseek';
  const baseUrl = view.baseUrl ?? '';
  return provider === 'openai-compatible' || !view.model
    ? { type: 'models', provider, baseUrl }
    : { type: 'probe', provider, baseUrl, model: view.model };
}

function moveCursor(view: FirstRunView, delta: number): FirstRunReduction {
  const count =
    view.step === 'offer'
      ? view.offers.length
      : view.step === 'provider'
        ? SETUP_PROVIDERS.length
        : view.step === 'model'
          ? (view.models?.length ?? 0)
          : 0;
  if (count === 0) return go(view);
  return go(view, { cursor: Math.max(0, Math.min(count - 1, view.cursor + delta)) });
}

export function reduceFirstRun(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string,
  locale?: string
): FirstRunReduction {
  if (view.step === 'working') return go(view);
  if (command.type === 'up' || command.type === 'down') {
    return moveCursor(view, command.type === 'up' ? -1 : 1);
  }
  if (view.step === 'offer') return reduceOffer(view, command);
  if (view.step === 'provider') return reduceProvider(view, command, secret, locale);
  if (view.step === 'url') return reduceUrl(view, command, secret, locale);
  if (view.step === 'key') return reduceKey(view, command, secret, locale);
  if (view.step === 'model') return reduceModel(view, command, secret, locale);
  if (view.step === 'error') return reduceError(view, command, secret);
  return go(view);
}

function reduceOffer(view: FirstRunView, command: FirstRunCommand): FirstRunReduction {
  if (command.type === 'escape' || (command.type === 'char' && /^[nN]$/.test(command.char))) {
    return go(view, { step: 'provider', cursor: 0, error: undefined });
  }
  if (command.type !== 'enter' && !(command.type === 'char' && /^[1-9]$/.test(command.char))) {
    return go(view);
  }
  const index = command.type === 'char' ? Number.parseInt(command.char, 10) - 1 : view.cursor;
  const offer = view.offers[index];
  if (!offer) return go(view);
  if (command.type === 'enter' && !offerUsesOfficialHost(offer)) {
    return go(view, { step: 'provider', cursor: 0, error: undefined });
  }
  const pending: FirstRunJob = offer.needsModelList
    ? { type: 'models', provider: offer.provider, baseUrl: offer.baseUrl }
    : { type: 'probe', provider: offer.provider, baseUrl: offer.baseUrl, model: offer.model };
  return go(
    view,
    {
      provider: offer.provider,
      baseUrl: offer.baseUrl,
      model: offer.model,
      apiKeyEnv: offer.keyVar,
      cursor: 0,
      error: undefined,
      step: 'working',
      pending,
    },
    { offerId: offer.id, job: pending }
  );
}

function reduceProvider(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string,
  locale?: string
): FirstRunReduction {
  if (command.type === 'escape' && view.offers.length > 0) {
    return go(view, { step: 'offer', cursor: 0 });
  }
  if (command.type === 'enter') {
    const provider = providerFromInput(command.draft, view.cursor);
    if (!provider) return go(view, { error: copy(locale, 'Pick 1–6 or a provider name.') });
    return afterProvider(view, provider, secret);
  }
  if (command.type === 'char' && /^[1-6]$/.test(command.char)) {
    const provider = providerFromInput(command.char, 0);
    return provider ? afterProvider(view, provider, secret) : go(view);
  }
  return go(view, {}, { consume: false });
}

function reduceUrl(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string,
  locale?: string
): FirstRunReduction {
  if (command.type === 'escape') {
    const cursor = Math.max(
      0,
      SETUP_PROVIDERS.findIndex((item) => item.id === 'openai-compatible')
    );
    return go(view, { step: 'provider', cursor, error: undefined });
  }
  if (command.type !== 'enter') return go(view, {}, { consume: false });
  if (isSaveAnywayAnswer(command.draft) && secret.trim() && view.baseUrl) {
    const provider = view.provider ?? 'openai-compatible';
    const model = view.model || PROVIDER_PRESETS[provider].defaultModel;
    if (model) return go(view, {}, { saved: savedConfig(view, provider, view.baseUrl, model) });
  }
  const raw = command.draft.trim() || view.baseUrl || '';
  if (!isHttpUrl(raw))
    return go(view, { error: copy(locale, 'Base URL must be a full http(s) URL.') });
  const baseUrl = normalizeGatewayUrl(raw);
  const notice =
    baseUrl !== raw.replace(/\/+$/, '')
      ? copy(locale, 'Base URL saved as {baseUrl} (/v1 and extra paths removed).', { baseUrl })
      : undefined;
  if (secret.trim()) {
    const job: FirstRunJob = {
      type: 'models',
      provider: view.provider ?? 'openai-compatible',
      baseUrl,
    };
    return go(view, { step: 'working', baseUrl, notice, error: undefined, pending: job }, { job });
  }
  return go(
    view,
    { step: 'key', baseUrl, keyDots: 0, notice, error: undefined },
    { secretOp: 'clear' }
  );
}

function reduceKey(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string,
  locale?: string
): FirstRunReduction {
  if (command.type === 'escape') {
    const back = view.provider === 'openai-compatible' ? 'url' : 'provider';
    return go(view, { step: back, error: undefined, keyDots: 0 }, { secretOp: 'clear' });
  }
  if (command.type === 'backspace') {
    return go(view, { keyDots: Math.max(0, (view.keyDots ?? 0) - 1) }, { secretOp: 'backspace' });
  }
  if (command.type === 'char') {
    return go(
      view,
      { apiKeyEnv: undefined, keyDots: (view.keyDots ?? 0) + command.char.length },
      { secretOp: 'append' }
    );
  }
  if (command.type === 'enter') {
    if (!secret.trim()) return go(view, { error: copy(locale, 'An API key is required.') });
    const job = jobForKey(view);
    return go(view, { step: 'working', pending: job, error: undefined }, { job });
  }
  return go(view);
}

function reduceModel(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string,
  locale?: string
): FirstRunReduction {
  if (command.type === 'escape') {
    return go(view, {
      step: 'key',
      error: undefined,
      keyDots: secret.length,
      commitOnModel: undefined,
    });
  }
  if (command.type !== 'enter') return go(view, {}, { consume: false });
  const models = view.models ?? [];
  const fallback = models[view.cursor] || view.model || '';
  const picked = interpretModelInput(command.draft, models, fallback, locale);
  if (picked.reject) {
    const suggestedIndex = picked.suggested ? models.indexOf(picked.suggested) : -1;
    return go(view, {
      error: picked.reject,
      ...(suggestedIndex >= 0 ? { cursor: suggestedIndex } : {}),
    });
  }
  const model = picked.model;
  if (!model) return go(view, { error: copy(locale, 'Type a model name or its number.') });
  const provider = view.provider ?? 'openai-compatible';
  const baseUrl = view.baseUrl ?? '';
  if (view.commitOnModel) {
    return go(
      view,
      { step: 'working', model, error: undefined, commitOnModel: undefined },
      { saved: savedConfig(view, provider, baseUrl, model) }
    );
  }
  // A successful /v1/models response already proved the key and the URL.
  if (models.length > 0) {
    return go(
      view,
      { step: 'working', model, error: undefined },
      { saved: savedConfig(view, provider, baseUrl, model) }
    );
  }
  const job: FirstRunJob = { type: 'probe', provider, baseUrl, model };
  return go(view, { step: 'working', model, pending: job, error: undefined }, { job });
}

function saveAnyway(view: FirstRunView, secret: string): FirstRunReduction {
  const provider = view.provider ?? 'openai-compatible';
  const baseUrl = view.baseUrl ?? '';
  const model = (
    view.model ||
    view.models?.[view.cursor] ||
    PROVIDER_PRESETS[provider].defaultModel
  ).trim();
  if (!secret.trim() || !baseUrl) return go(view);
  if (!model) {
    return go(view, { step: 'model', error: undefined, commitOnModel: true });
  }
  return go(
    view,
    { commitOnModel: undefined },
    { saved: savedConfig(view, provider, baseUrl, model) }
  );
}

function reduceError(
  view: FirstRunView,
  command: FirstRunCommand,
  secret: string
): FirstRunReduction {
  const back = view.failStep ?? 'provider';
  const backTo = (): FirstRunReduction =>
    go(
      view,
      { step: back, error: undefined, keyDots: 0 },
      back === 'key' ? { secretOp: 'clear' } : {}
    );
  if (command.type === 'escape') return backTo();
  if (command.type === 'enter' && command.draft.trim() === '' && !view.pending) return backTo();
  if (
    (command.type === 'enter' && isSaveAnywayAnswer(command.draft)) ||
    (command.type === 'char' && command.char === '1')
  ) {
    return saveAnyway(view, secret);
  }
  if (command.type === 'enter' && view.pending && command.draft.trim() === '') {
    return go(view, { step: 'working', error: undefined }, { job: view.pending });
  }
  return go(view, {}, { consume: false });
}

function routeFailure(
  view: FirstRunView,
  result: ConnectionFailure,
  source: 'models' | 'probe'
): { view: FirstRunView; clearSecret?: boolean } {
  const provider = view.provider ?? view.pending?.provider ?? 'openai-compatible';
  const baseUrl = view.baseUrl ?? view.pending?.baseUrl ?? '';
  const model = view.model ?? view.pending?.model ?? '';
  if (result.kind === 'auth') {
    return {
      view: {
        ...view,
        step: 'error',
        failStep: 'key',
        keyDots: 0,
        error: result.message,
        pending: undefined,
      },
    };
  }
  if (result.kind === 'model') {
    return {
      view: {
        ...view,
        step: 'model',
        error: result.message,
        pending: undefined,
        ...(source === 'models' ? { models: [], cursor: 0 } : {}),
      },
    };
  }
  const transport = result.kind === 'network' || result.kind === 'tls' || result.kind === 'timeout';
  if (transport && provider === 'openai-compatible') {
    return {
      view: {
        ...view,
        step: 'url',
        error: result.message,
        pending: undefined,
        failStep: 'url',
        ...(source === 'models' ? { notice: undefined } : {}),
      },
    };
  }
  const pending =
    view.pending ??
    (source === 'models'
      ? { type: 'models' as const, provider, baseUrl }
      : { type: 'probe' as const, provider, baseUrl, model });
  return {
    view: {
      ...view,
      step: 'error',
      error: result.message,
      pending,
      ...(source === 'models' ? { notice: undefined } : {}),
      ...(source === 'probe' ? { failStep: 'provider' as const } : {}),
    },
  };
}

export function applyModelsResult(
  view: FirstRunView,
  result: { ok: true; models: string[] } | ({ ok: false } & ConnectionFailure),
  locale?: string
): FirstRunView {
  if (!result.ok) return routeFailure(view, result, 'models').view;
  return {
    ...view,
    step: 'model',
    models: result.models,
    cursor: 0,
    model: result.models[0] ?? view.model,
    error: undefined,
    notice:
      result.models.length === 0
        ? copy(locale, 'No models were listed. Type the model name.')
        : undefined,
    pending: undefined,
  };
}

export function applyProbeResult(
  view: FirstRunView,
  result: ProbeResult
): { view: FirstRunView; saved?: FirstRunSaved; clearSecret?: boolean } {
  const provider = view.provider ?? view.pending?.provider ?? 'openai-compatible';
  const baseUrl = view.baseUrl ?? view.pending?.baseUrl ?? '';
  const model = view.model ?? view.pending?.model ?? '';
  if (result.ok) {
    return {
      view: { ...view, step: 'working', error: undefined, model, provider, baseUrl },
      saved: savedConfig(view, provider, baseUrl, model),
    };
  }
  return routeFailure(view, result, 'probe');
}

/** Shared by the TUI and the readline wizard. */
export async function settleFirstRunJob(
  view: FirstRunView,
  job: FirstRunJob,
  apiKey: string,
  locale?: string
): Promise<{ view: FirstRunView; saved?: FirstRunSaved; clearSecret?: boolean; message?: string }> {
  if (job.type === 'models') {
    const listed = await fetchGatewayModels({ baseUrl: job.baseUrl, apiKey, locale });
    return {
      view: applyModelsResult(
        { ...view, pending: job, provider: job.provider, baseUrl: job.baseUrl },
        listed,
        locale
      ),
    };
  }
  const probed = await probeModel({
    provider: job.provider,
    baseUrl: job.baseUrl,
    apiKey,
    model: job.model ?? view.model ?? '',
    locale,
  });
  const applied = applyProbeResult(
    {
      ...view,
      pending: job,
      provider: job.provider,
      baseUrl: job.baseUrl,
      model: job.model ?? view.model,
    },
    probed
  );
  return probed.ok ? { ...applied, message: probed.message } : applied;
}

export function renderFirstRunLines(
  view: FirstRunView,
  locale?: string,
  audience: 'tui' | 'readline' = 'tui'
): string[] {
  const lines = [
    copy(locale, 'Moss setup'),
    copy(
      locale,
      'About a minute. A pasted key is stored in the config file (mode 0600). Set apiKeyEnv to a variable name to keep the key out of that file.'
    ),
  ];
  const tuiChrome = audience === 'tui';
  if (view.error) for (const part of view.error.split('\n')) if (part.trim()) lines.push(part);
  if (view.notice) lines.push(view.notice);
  if (view.step === 'offer') {
    const selected = view.offers[view.cursor];
    lines.push(
      copy(
        locale,
        selected && offerUsesOfficialHost(selected)
          ? 'A key is already in the environment. Press Enter to use it (the value is not shown).'
          : 'A key is already in the environment. Press its number to use that host (the value is not shown). Enter chooses a provider.'
      )
    );
    view.offers.forEach((offer, index) => {
      lines.push(`${index === view.cursor ? '>' : ' '} ${index + 1}  ${offer.label}`);
    });
    lines.push(copy(locale, 'n  choose a provider instead'));
  } else if (view.step === 'provider') {
    lines.push(copy(locale, 'Choose a provider. Press its number.'));
    SETUP_PROVIDERS.forEach((item, index) => {
      lines.push(
        `${index === view.cursor ? '>' : ' '} ${item.key}  ${isZhLocale(locale) ? item.zh : item.en}`
      );
    });
  } else if (view.step === 'url') {
    lines.push(copy(locale, 'Gateway URL (https://host). A trailing /v1 is removed.'));
    if (tuiChrome) lines.push(copy(locale, 'Esc returns to the provider list.'));
  } else if (view.step === 'key') {
    const dots = '•'.repeat(Math.min(view.keyDots ?? 0, 24));
    lines.push(copy(locale, 'API key (hidden): {dots}', { dots }));
    if (tuiChrome) lines.push(copy(locale, 'Esc goes back one step.'));
  } else if (view.step === 'model') {
    const models = view.models ?? [];
    if (models.length === 0) lines.push(copy(locale, 'Type the model name, then Enter.'));
    else {
      lines.push(
        copy(locale, 'Pick a model by number or name ({count} listed).', { count: models.length })
      );
      models.slice(0, 30).forEach((model, index) => {
        lines.push(`${index === view.cursor ? '>' : ' '} ${index + 1}  ${model}`);
      });
    }
  } else if (view.step === 'working') {
    lines.push(
      copy(
        locale,
        view.pending?.type === 'models'
          ? 'Fetching the model list…'
          : 'Testing the connection (1 token)…'
      )
    );
  } else if (view.step === 'error' && tuiChrome) {
    const back =
      view.failStep === 'url'
        ? copy(locale, 'Esc returns to the URL.')
        : view.failStep === 'key'
          ? copy(locale, 'Esc returns to the key.')
          : copy(locale, 'Esc picks a provider again.');
    lines.push(
      view.pending
        ? copy(
            locale,
            'Enter retries. {back} Type "save anyway" or press 1 to write this config.',
            { back }
          )
        : copy(
            locale,
            '{back} Type "save anyway" or press 1 to write this config. Enter goes back.',
            { back }
          )
    );
    lines.push(`${view.cursor === 0 ? '>' : ' '} 1  ${copy(locale, 'save anyway')}`);
  }
  return lines;
}

export function lookupOfferSecret(
  offerId: string,
  env: NodeJS.ProcessEnv = envBeforeDotenv
): string {
  return credentialById(offerId, env)?.apiKey ?? '';
}

/** Write provider/model/url. An env offer stores `apiKeyEnv` only; a paste stores the key. */
export function saveUserModelConfig(input: {
  provider?: CliProviderPreset;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = input.env ?? process.env;
  const dir = resolveConfigDir(env);
  const current = loadConfigFile(resolveConfigPath(dir));
  const next: ConfigFile = {
    ...current,
    model: input.model,
    promptCache: current.promptCache ?? { enabled: true, debug: false },
  };
  if (input.provider) next.provider = input.provider;
  if (input.baseUrl) next.baseUrl = input.baseUrl;
  if (input.apiKeyEnv) {
    next.apiKeyEnv = input.apiKeyEnv;
    delete next.apiKey;
  } else if (input.apiKey) {
    next.apiKey = input.apiKey;
    delete next.apiKeyEnv;
  }
  saveConfigFile(next, dir);
  return resolveConfigPath(dir);
}
