/**
 * Per-model token prices (USD or CNY per 1M tokens).
 *
 * Built-in rows are list prices copied from the vendor's own pricing page on
 * 2026-10-09. They apply only when the request base URL host is that vendor's
 * official API. A gateway (for example ai-api.d-robotics.cc) stays unpriced
 * until `pricing.models` sets a rate — gateway prices differ, and this module
 * never invents one.
 *
 * DeepSeek — https://api-docs.deepseek.com/quick_start/pricing
 *   Peak (standard) rates. Off-peak is half and is not used.
 *   `deepseek-flash` is omitted: gateways reuse that alias. The page still
 *   bills legacy `deepseek-v4-flash` at the flash price.
 *   `deepseek-chat` and `deepseek-reasoner` are not on the page.
 *
 * Qwen — https://www.alibabacloud.com/help/en/model-studio/model-pricing
 *   `qwen3.6-plus` ≤256K, non-thinking and thinking output are the same price.
 *   Beijing (`dashscope.aliyuncs.com`) and US (`dashscope-us.aliyuncs.com`)
 *   are $0.276 / $1.651. International (`dashscope-intl.aliyuncs.com`) is
 *   $0.50 / $3. Above 256K is not applied. `qwen-plus` is omitted (thinking
 *   output is a different price). `qwen-max` international is listed only as
 *   a batch discount, so it is omitted.
 *
 * OpenAI — https://developers.openai.com/api/docs/pricing
 *   Standard short-context rates (not Batch, Flex, or Fast). Long-context
 *   tiers, where the page lists them, are not applied.
 *
 * Anthropic — https://platform.claude.com/docs/en/about-claude/pricing
 *   Standard rates. Cache write is the 5-minute price. Haiku 5.5 is omitted
 *   (the page has two prompt-length tiers). Opus 4 is the retired list price
 *   on that page ($15 / $75), not the Opus 4.5 price.
 */

export type PriceCurrency = 'USD' | 'CNY';

/** Prices are per 1,000,000 tokens. Omitted cache rates bill at `input`. */
export interface ModelPrice {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  currency: PriceCurrency;
}

export interface PricingModelConfig {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  /** Alias of input / output / cached, still per 1M tokens. */
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedPerMillion?: number;
  currency?: string;
}

export interface PricingConfig {
  models?: Record<string, PricingModelConfig>;
}

export interface UsageSlice {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface PricingOptions {
  overrides?: Readonly<Record<string, ModelPrice>>;
  env?: NodeJS.ProcessEnv;
  /** Used when a slice does not name a model. */
  fallbackModel?: string;
  /** Request base URL. Built-in rows require the vendor's official host. */
  baseUrl?: string;
}

export type PriceSource = 'builtin' | 'config' | 'env' | 'mixed';

export interface RateNote {
  en: string;
  zh: string;
}

export interface CostQuote {
  /** Single-currency total. Null when any slice is unpriced or currencies differ. */
  amount: number | null;
  currency: PriceCurrency | null;
  /** USD total. Null unless every slice is priced in USD. */
  totalUsd: number | null;
  unknownModel?: string;
  /** Set when every priced slice shares one source. */
  source?: PriceSource;
  /** Built-in rate clause, when every slice shares one. */
  rateNote?: RateNote;
}

/** Date the built-in table was checked against the vendor pages. */
export const BUILTIN_PRICE_CHECKED = '2026-10-09';

type Vendor = 'deepseek' | 'openai' | 'anthropic' | 'qwen';

interface BuiltinEntry {
  id: string;
  price: ModelPrice;
  vendor: Vendor;
  /** Exact hostname. Qwen regions do not share a price. */
  host?: string;
  /** Dated snapshots (`-YYYYMMDD` or `-YYYY-MM-DD`) share this row. */
  snapshots: boolean;
  rate: RateNote;
}

const PEAK: RateNote = {
  en: 'DeepSeek peak (standard, not off-peak)',
  zh: 'DeepSeek 高峰标准价（非错峰）',
};
const SHORT: RateNote = { en: 'standard short-context', zh: '标准短上下文' };
const LIST: RateNote = { en: 'standard list price', zh: '标准标价' };
const QWEN_CN: RateNote = {
  en: 'DashScope Beijing list price, ≤256K',
  zh: 'DashScope 北京标价，≤256K',
};
const QWEN_INTL: RateNote = {
  en: 'DashScope international list price, ≤256K',
  zh: 'DashScope 国际标价，≤256K',
};
const QWEN_US: RateNote = {
  en: 'DashScope US list price, ≤256K',
  zh: 'DashScope 美国标价，≤256K',
};

function usd(input: number, output: number, cached?: number, cacheWrite?: number): ModelPrice {
  return {
    input,
    output,
    currency: 'USD',
    ...(cached !== undefined ? { cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function entry(
  id: string,
  vendor: Vendor,
  price: ModelPrice,
  rate: RateNote,
  snapshots = true,
  host?: string
): BuiltinEntry {
  return { id, vendor, price, rate, snapshots, ...(host ? { host } : {}) };
}

const BUILTIN: readonly BuiltinEntry[] = [
  entry('deepseek-v4-flash', 'deepseek', usd(0.3, 1.2, 0.006), PEAK),
  entry('deepseek-v4-pro', 'deepseek', usd(1.32, 3.96, 0.044), PEAK),
  entry('qwen3.6-plus', 'qwen', usd(0.276, 1.651), QWEN_CN, true, 'dashscope.aliyuncs.com'),
  entry('qwen3.6-plus', 'qwen', usd(0.5, 3), QWEN_INTL, true, 'dashscope-intl.aliyuncs.com'),
  entry('qwen3.6-plus', 'qwen', usd(0.276, 1.651), QWEN_US, true, 'dashscope-us.aliyuncs.com'),
  entry('gpt-4o', 'openai', usd(2.5, 10, 1.25), SHORT),
  entry('gpt-4o-mini', 'openai', usd(0.15, 0.6, 0.075), SHORT),
  entry('gpt-4o-2024-05-13', 'openai', usd(5, 15), SHORT, false),
  entry('gpt-4.1', 'openai', usd(2, 8, 0.5), SHORT),
  entry('gpt-4.1-mini', 'openai', usd(0.4, 1.6, 0.1), SHORT),
  entry('gpt-4.1-nano', 'openai', usd(0.1, 0.4, 0.025), SHORT),
  entry('gpt-5', 'openai', usd(1.25, 10, 0.125), SHORT),
  entry('gpt-5-mini', 'openai', usd(0.25, 2, 0.025), SHORT),
  entry('gpt-5-nano', 'openai', usd(0.05, 0.4, 0.005), SHORT),
  entry('gpt-5.4', 'openai', usd(2.5, 15, 0.25), {
    en: 'standard short-context (<272K)',
    zh: '标准短上下文（<272K）',
  }),
  entry('gpt-5.2', 'openai', usd(1.75, 14, 0.175), SHORT),
  entry('gpt-5.1', 'openai', usd(1.25, 10, 0.125), SHORT),
  entry('o3', 'openai', usd(2, 8, 0.5), SHORT),
  entry('o3-mini', 'openai', usd(1.1, 4.4, 0.55), SHORT),
  entry('o4-mini', 'openai', usd(1.1, 4.4, 0.275), SHORT),
  entry('gpt-4-turbo-2024-04-09', 'openai', usd(10, 30), SHORT, false),
  entry('gpt-3.5-turbo', 'openai', usd(0.5, 1.5), SHORT, false),
  entry('gpt-3.5-turbo-0125', 'openai', usd(0.5, 1.5), SHORT, false),
  entry('claude-opus-4', 'anthropic', usd(15, 75, 1.5, 18.75), LIST),
  entry('claude-opus-4-5', 'anthropic', usd(5, 25, 0.5, 6.25), LIST),
  entry('claude-opus-4-6', 'anthropic', usd(5, 25, 0.5, 6.25), LIST),
  entry('claude-opus-4-7', 'anthropic', usd(5, 25, 0.5, 6.25), LIST),
  entry('claude-opus-4-8', 'anthropic', usd(5, 25, 0.5, 6.25), LIST),
  entry('claude-opus-5', 'anthropic', usd(5, 25, 0.5, 6.25), LIST),
  entry('claude-opus-5-5', 'anthropic', usd(4, 20, 0.2, 5), LIST),
  entry('claude-sonnet-4', 'anthropic', usd(3, 15, 0.3, 3.75), LIST),
  entry('claude-sonnet-4-5', 'anthropic', usd(3, 15, 0.3, 3.75), LIST),
  entry('claude-sonnet-4-6', 'anthropic', usd(3, 15, 0.3, 3.75), LIST),
  entry('claude-sonnet-5', 'anthropic', usd(2, 10, 0.2, 2.5), LIST),
  entry('claude-sonnet-5-5', 'anthropic', usd(2, 10, 0.1, 2.5), LIST),
  entry('claude-haiku-4-5', 'anthropic', usd(1, 5, 0.1, 1.25), LIST),
  entry('claude-haiku-3-5', 'anthropic', usd(0.8, 4, 0.08, 1), LIST),
  entry('claude-3-5-haiku', 'anthropic', usd(0.8, 4, 0.08, 1), LIST),
  entry('claude-fable-5', 'anthropic', usd(10, 50, 1, 12.5), LIST),
  entry('claude-fable-5-1', 'anthropic', usd(10, 50, 0.25, 12.5), LIST),
];

function normalizeId(model: string): string {
  return model.trim().toLowerCase();
}

function hostnameOf(baseUrl: string | undefined): string | null {
  const raw = baseUrl?.trim();
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function officialHost(entry: BuiltinEntry, host: string): boolean {
  if (entry.host) return host === entry.host;
  if (entry.vendor === 'deepseek') return host === 'api.deepseek.com';
  if (entry.vendor === 'openai') return host === 'api.openai.com';
  if (entry.vendor === 'anthropic') return host === 'api.anthropic.com';
  return false;
}

function isDateSnapshot(id: string, key: string): boolean {
  if (!id.startsWith(key) || id.length === key.length || id[key.length] !== '-') return false;
  const rest = id.slice(key.length);
  return /^-\d{8}$/.test(rest) || /^-\d{4}-\d{2}-\d{2}$/.test(rest);
}

function matchBuiltin(id: string, baseUrl: string | undefined): BuiltinEntry | null {
  const host = hostnameOf(baseUrl);
  if (!host) return null;
  let exact: BuiltinEntry | undefined;
  let snapshot: { len: number; entry: BuiltinEntry } | undefined;
  for (const entry of BUILTIN) {
    if (!officialHost(entry, host)) continue;
    const key = normalizeId(entry.id);
    if (key === id) {
      exact = entry;
      continue;
    }
    if (entry.snapshots && isDateSnapshot(id, key) && (!snapshot || key.length > snapshot.len)) {
      snapshot = { len: key.length, entry };
    }
  }
  return exact ?? snapshot?.entry ?? null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCurrency(value: unknown): PriceCurrency | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toUpperCase();
  if (raw === 'USD' || raw === 'CNY') return raw;
  return undefined;
}

/** Drop invalid rows. Config prices replace built-in rows for the same id. */
export function pricingOverridesFromConfig(
  pricing: PricingConfig | undefined
): Record<string, ModelPrice> {
  const models = pricing?.models;
  if (!models || typeof models !== 'object') return {};
  const out: Record<string, ModelPrice> = {};
  for (const [rawId, row] of Object.entries(models)) {
    const id = rawId.trim();
    if (!id || !row || typeof row !== 'object') continue;
    const input = finiteNonNegative(row.input ?? row.inputPerMillion);
    const output = finiteNonNegative(row.output ?? row.outputPerMillion);
    if (input === undefined || output === undefined) continue;
    const currency = parseCurrency(row.currency) ?? 'USD';
    const cached = finiteNonNegative(row.cached ?? row.cachedPerMillion);
    const cacheWrite = finiteNonNegative(row.cacheWrite);
    out[id] = {
      input,
      output,
      currency,
      ...(cached !== undefined ? { cached } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }
  return out;
}

function envPrice(env: NodeJS.ProcessEnv | undefined): ModelPrice | null {
  if (!env) return null;
  const input = Number(env.MOSS_PRICE_IN);
  const output = Number(env.MOSS_PRICE_OUT);
  if (!(Number.isFinite(input) && input > 0 && Number.isFinite(output) && output > 0)) return null;
  // Cache reads bill at the input rate. A separate cache price belongs in
  // pricing.models, not a third env var.
  return { input, output, currency: 'USD' };
}

function matchOverride(
  id: string,
  table: Readonly<Record<string, ModelPrice>> | undefined
): ModelPrice | null {
  if (!table) return null;
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table)) {
    const norm = normalizeId(key);
    if (norm === id) return price;
    if (
      id.startsWith(norm) &&
      id.length > norm.length &&
      (id[norm.length] === '-' || id[norm.length] === '@' || id[norm.length] === '/') &&
      (!best || norm.length > best.len)
    ) {
      best = { len: norm.length, price };
    }
  }
  return best?.price ?? null;
}

export function lookupModelPrice(model: string, options: PricingOptions = {}): ModelPrice | null {
  const id = normalizeId(model);
  if (!id) return null;
  return matchOverride(id, options.overrides) ?? matchBuiltin(id, options.baseUrl)?.price ?? null;
}

/** Live base URL: the agent config wins over the runtime snapshot. */
export function configuredBaseUrl(
  config: { baseUrl?: string } | undefined,
  runtime?: { baseUrl?: string }
): string | undefined {
  const fromConfig = config?.baseUrl?.trim();
  if (fromConfig) return fromConfig;
  const fromRuntime = runtime?.baseUrl?.trim();
  return fromRuntime || undefined;
}

interface PricedSlice {
  price: ModelPrice;
  source: PriceSource;
  rateNote?: RateNote;
}

function priceForSlice(slice: UsageSlice, options: PricingOptions): PricedSlice | null {
  const named = slice.model?.trim() || options.fallbackModel?.trim();
  if (named) {
    const id = normalizeId(named);
    const override = matchOverride(id, options.overrides);
    if (override) return { price: override, source: 'config' };
    const builtin = matchBuiltin(id, options.baseUrl);
    if (builtin) return { price: builtin.price, source: 'builtin', rateNote: builtin.rate };
  }
  const env = envPrice(options.env);
  return env ? { price: env, source: 'env' } : null;
}

function roundMoney(amount: number): number {
  return Math.round(amount * 1e8) / 1e8;
}

function sliceAmount(slice: UsageSlice, price: ModelPrice): number {
  const cachedRate = price.cached ?? price.input;
  const writeRate = price.cacheWrite ?? price.input;
  const tokens =
    slice.inputTokens * price.input +
    slice.outputTokens * price.output +
    (slice.cacheReadTokens ?? 0) * cachedRate +
    (slice.cacheCreationTokens ?? 0) * writeRate;
  return tokens / 1_000_000;
}

export function quoteUsage(slices: readonly UsageSlice[], options: PricingOptions = {}): CostQuote {
  if (slices.length === 0) return { amount: null, currency: null, totalUsd: null };
  let amount = 0;
  let currency: PriceCurrency | undefined;
  let source: PriceSource | undefined;
  let rateNote: RateNote | undefined;
  for (const slice of slices) {
    const priced = priceForSlice(slice, options);
    if (!priced) {
      const named = slice.model?.trim() || options.fallbackModel?.trim();
      return {
        amount: null,
        currency: null,
        totalUsd: null,
        ...(named ? { unknownModel: named } : { unknownModel: '<model>' }),
      };
    }
    if (currency && currency !== priced.price.currency) {
      return { amount: null, currency: null, totalUsd: null };
    }
    if (!source) {
      source = priced.source;
      rateNote = priced.rateNote;
    } else if (source !== priced.source || source === 'mixed') {
      source = 'mixed';
      rateNote = undefined;
    } else if (
      rateNote &&
      priced.rateNote &&
      (rateNote.en !== priced.rateNote.en || rateNote.zh !== priced.rateNote.zh)
    ) {
      rateNote = undefined;
    }
    currency = priced.price.currency;
    amount += sliceAmount(slice, priced.price);
  }
  const rounded = roundMoney(amount);
  return {
    amount: rounded,
    currency: currency ?? null,
    totalUsd: currency === 'USD' ? rounded : null,
    ...(source ? { source } : {}),
    ...(source === 'builtin' && rateNote ? { rateNote } : {}),
  };
}

export function formatCostAmount(amount: number, currency: PriceCurrency): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  const abs = Math.abs(amount);
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  let body = amount.toFixed(digits);
  if (digits > 2) {
    body = body.replace(/0+$/, '').replace(/\.$/, '');
    const fraction = body.split('.')[1] ?? '';
    if (fraction.length < 2) body = amount.toFixed(2);
  }
  return `${symbol}${body}`;
}

/** User-visible estimate. zh uses 约 for CNY and ~ for USD. */
export function formatCostEstimate(amount: number, currency: PriceCurrency, zh = false): string {
  const body = formatCostAmount(amount, currency);
  if (!zh) return `~${body} (est.)`;
  return currency === 'CNY' ? `约 ${body} (估算)` : `~${body} (估算)`;
}

export function priceSourceLine(quote: CostQuote, zh = false): string | null {
  if (quote.amount === null || !quote.source) return null;
  if (quote.source === 'config') {
    return zh
      ? '价格来源    你的配置（pricing.models）'
      : 'price source  your config (pricing.models)';
  }
  if (quote.source === 'env') {
    return zh
      ? '价格来源    MOSS_PRICE_IN / MOSS_PRICE_OUT'
      : 'price source  MOSS_PRICE_IN / MOSS_PRICE_OUT';
  }
  if (quote.source === 'mixed') {
    return zh
      ? '价格来源    内置标价与你的配置'
      : 'price source  built-in list price and your config';
  }
  const note = zh ? quote.rateNote?.zh : quote.rateNote?.en;
  const checked = zh ? `核对日期 ${BUILTIN_PRICE_CHECKED}` : `checked ${BUILTIN_PRICE_CHECKED}`;
  const detail = note ? `${note}; ${checked}` : checked;
  return zh ? `价格来源    内置标价（${detail}）` : `price source  built-in list price (${detail})`;
}

export function unknownPriceMessage(model: string | undefined, zh = false): string {
  const id = model?.trim() || '<model>';
  return zh
    ? `价格未知，请在 moss 配置里设置 pricing.models["${id}"]（input、output、cached 为每百万 token 的价格，currency 为 USD 或 CNY）`
    : `price unknown, set it with pricing.models["${id}"] in the moss config (input, output, and cached per 1M tokens; currency USD or CNY)`;
}

let unknownNoted = false;

/** Unsolicited notice. `/usage` may repeat the same sentence; this fires once. */
export function takeUnknownPriceNotice(model: string | undefined, zh = false): string | null {
  if (unknownNoted) return null;
  unknownNoted = true;
  return unknownPriceMessage(model, zh);
}

export function resetUnknownPriceNoticeForTests(): void {
  unknownNoted = false;
}
