/**
 * One HTTP probe shared by setup, the wizard, and /doctor's reachability check.
 * Success is JSON with a non-empty `choices` or `content` array. Failures go
 * through classifyProviderError only.
 */
import { buildApiV1Url } from '../provider/api-v1-url.js';
import { classifyProviderError, type ProviderErrorCategory } from '../provider/error-classify.js';
import type { CliProviderPreset } from '../provider/provider-presets.js';
import { setupCopy } from './cli-locale.js';
import { redactSecrets } from './env-credentials.js';

export type ConnectionFailureKind =
  | 'auth'
  | 'model'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'rate_limit'
  | 'balance'
  | 'region'
  | 'unknown';

export interface ConnectionFailure {
  kind: ConnectionFailureKind;
  status?: number;
  message: string;
}

export type ProbeResult =
  | { ok: true; latencyMs: number; message: string }
  | ({ ok: false; latencyMs: number } & ConnectionFailure);

export interface GatewayModelList {
  ok: true;
  models: string[];
}

const KIND: Partial<Record<ProviderErrorCategory, ConnectionFailureKind>> = {
  auth: 'auth',
  model_not_found: 'model',
  timeout: 'timeout',
  rate_limit: 'rate_limit',
  quota_exceeded: 'balance',
  region: 'region',
  network: 'network',
};

function failure(
  body: string | undefined,
  secrets: readonly string[],
  extra: {
    status?: number;
    code?: string;
    name?: string;
    locale?: string;
    abortReason?: 'timeout';
  }
): ConnectionFailure {
  let message: unknown = body;
  let code = extra.code;
  try {
    const parsed = JSON.parse(body ?? '') as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
      code?: unknown;
      type?: unknown;
    };
    message = parsed.error?.message ?? parsed.message;
    const parsedCode = parsed.error?.code ?? parsed.code;
    const parsedType = parsed.error?.type ?? parsed.type;
    if (typeof parsedCode === 'string') code = parsedCode;
    if (typeof parsedType === 'string' && parsedType && parsedType !== code) {
      code = code ? `${code} ${parsedType}` : parsedType;
    }
  } catch {
    message = body;
  }
  const raw = redactSecrets(
    [code, extra.name, typeof message === 'string' ? message : body].filter(Boolean).join(' '),
    secrets
  );
  const surface = classifyProviderError({
    errorMessage: raw,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(code ? { code } : {}),
    ...(extra.locale ? { locale: extra.locale } : {}),
    ...(extra.abortReason ? { abortReason: extra.abortReason } : {}),
    audience: 'setup',
  });
  const text = redactSecrets(surface.userMessage, secrets);
  return {
    kind: /certificate|证书/.test(text) ? 'tls' : (KIND[surface.category] ?? 'unknown'),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    message: text,
  };
}

function thrown(
  err: unknown,
  locale: string | undefined,
  secrets: readonly string[]
): ConnectionFailure {
  const error = err as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const message = [error.message, error.cause?.message].filter(Boolean).join(' ');
  const name = error.name ?? '';
  return failure(message, secrets, {
    code: error.code || error.cause?.code || '',
    name,
    locale,
    ...(name === 'TimeoutError' || /timeout/i.test(message)
      ? { abortReason: 'timeout' as const }
      : {}),
  });
}

function noReply(locale: string | undefined, status: number): string {
  return setupCopy(
    locale,
    'The gateway returned HTTP {status} without a model reply. Check the base URL.',
    { status }
  );
}

function replied(body: string, anthropic: boolean): boolean {
  try {
    const parsed = JSON.parse(body) as { choices?: unknown; content?: unknown };
    const list = anthropic ? parsed.content : parsed.choices;
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

async function readBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 8000);
  } catch {
    return '';
  }
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch | undefined,
  secrets: readonly string[],
  locale?: string
): Promise<{ res: Response; body: string } | { failure: ConnectionFailure }> {
  try {
    const res = await (fetchImpl ?? fetch)(url, init);
    return { res, body: await readBody(res) };
  } catch (err) {
    return { failure: thrown(err, locale, secrets) };
  }
}

/** One-token completion. A non-empty `choices` or `content` array is success. */
export async function probeModel(input: {
  provider: CliProviderPreset;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  locale?: string;
  now?: () => number;
}): Promise<ProbeResult> {
  const secrets = [input.apiKey];
  const now = input.now ?? Date.now;
  const started = now();
  const anthropic = input.provider === 'anthropic';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${input.apiKey}`;
  const hit = await request(
    buildApiV1Url(input.baseUrl, anthropic ? 'messages' : 'chat/completions'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
    },
    input.fetchImpl,
    secrets,
    input.locale
  );
  const latencyMs = Math.max(0, now() - started);
  if ('failure' in hit) return { ok: false, latencyMs, ...hit.failure };
  if (hit.res.ok && replied(hit.body, anthropic)) {
    return {
      ok: true,
      latencyMs,
      message: setupCopy(input.locale, 'Connected — {model} replied in {latencyMs}ms.', {
        model: input.model,
        latencyMs,
      }),
    };
  }
  if (hit.res.ok) {
    return {
      ok: false,
      latencyMs,
      kind: 'unknown',
      status: hit.res.status,
      message: noReply(input.locale, hit.res.status),
    };
  }
  return {
    ok: false,
    latencyMs,
    ...failure(hit.body, secrets, { status: hit.res.status, locale: input.locale }),
  };
}

export async function fetchGatewayModels(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  locale?: string;
}): Promise<GatewayModelList | ({ ok: false } & ConnectionFailure)> {
  const secrets = [input.apiKey];
  const hit = await request(
    buildApiV1Url(input.baseUrl, 'models'),
    {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
    },
    input.fetchImpl,
    secrets,
    input.locale
  );
  if ('failure' in hit) return { ok: false, ...hit.failure };
  if (!hit.res.ok) {
    return {
      ok: false,
      ...failure(hit.body, secrets, { status: hit.res.status, locale: input.locale }),
    };
  }
  try {
    const data = (JSON.parse(hit.body) as { data?: { id?: string; name?: string }[] }).data ?? [];
    const models = [
      ...new Set(data.map((item) => (item?.id ?? item?.name ?? '').trim()).filter(Boolean)),
    ];
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      kind: 'unknown',
      status: hit.res.status,
      message: noReply(input.locale, hit.res.status),
    };
  }
}
