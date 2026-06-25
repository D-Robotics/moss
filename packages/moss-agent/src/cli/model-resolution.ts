/**
 * Real-model resolution for the standalone Moss CLI host.
 *
 * The bundled zero-config gateway advertises a stable placeholder model name
 * ("Moss") so the shared backend can meter/bill usage centrally. That name is
 * not the actual language model — the real backing model (e.g. a DeepSeek or
 * Qwen variant) only appears in the top-level `model` field of an actual chat
 * completion response. This module resolves that real name **on demand** (only
 * when the user asks — via the `current_model` tool or the `/model` view) and
 * caches it locally so repeat reads and the status bar cost nothing.
 *
 * Non-bundled (user-configured) setups already carry a truthful model name, so
 * resolution is a no-op that returns the configured model without any request.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../core/llm/llm-provider.js';
import { resolveConfigDir } from './config.js';

/** Minimal config shape needed to resolve/display the real model. */
export interface RealModelConfigView {
  baseUrl?: string;
  model?: string;
  usingBundledDefault?: boolean;
}

interface CacheEntry {
  model: string;
  resolvedAt: number;
}

type CacheFile = Record<string, CacheEntry>;

const CACHE_FILE_NAME = 'real-model-cache.json';
/** Cache TTL: a gateway can swap its backing model, so don't pin forever. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), CACHE_FILE_NAME);
}

function readCacheFile(env: NodeJS.ProcessEnv): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(env), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as CacheFile;
  } catch {
    // Missing/corrupt cache is non-fatal — treat as empty.
  }
  return {};
}

function cacheKey(config: RealModelConfigView): string | null {
  return config.baseUrl ? config.baseUrl.replace(/\/+$/, '') : null;
}

function freshCachedModel(config: RealModelConfigView, env: NodeJS.ProcessEnv): string | null {
  const key = cacheKey(config);
  if (!key) return null;
  const entry = readCacheFile(env)[key];
  if (!entry || typeof entry.model !== 'string') return null;
  if (Date.now() - entry.resolvedAt > CACHE_TTL_MS) return null;
  return entry.model || null;
}

function writeCachedModel(config: RealModelConfigView, model: string, env: NodeJS.ProcessEnv): void {
  const key = cacheKey(config);
  if (!key || !model) return;
  try {
    const file = readCacheFile(env);
    file[key] = { model, resolvedAt: Date.now() };
    fs.mkdirSync(resolveConfigDir(env), { recursive: true });
    fs.writeFileSync(cachePath(env), JSON.stringify(file, null, 2));
  } catch {
    // A non-writable config dir must not break the answer — just skip caching.
  }
}

/**
 * Synchronous, request-free read of the cached real model for this gateway.
 * For render paths (status bar, onboarding) that must never block on the
 * network. Returns null when nothing has been resolved yet.
 * @public
 */
export function readCachedRealModel(
  config: RealModelConfigView,
  options: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  if (!config.usingBundledDefault) return config.model ?? null;
  return freshCachedModel(config, options.env ?? process.env);
}

/**
 * Resolve the real backing model name, sending at most one tiny probe request
 * and only when needed (bundled gateway + no fresh cache). Returns null if the
 * probe fails so callers can fall back to the existing "built-in gateway"
 * wording instead of asserting a model name they couldn't confirm.
 * @public
 */
export async function resolveRealModel(
  provider: Pick<LLMProvider, 'complete'>,
  config: RealModelConfigView,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  // User-configured providers already report a truthful model name; the
  // configured value is authoritative and needs no probe.
  if (!config.usingBundledDefault) return config.model ?? null;

  const env = options.env ?? process.env;
  const cached = freshCachedModel(config, env);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await provider.complete({
      model: config.model ?? 'Moss',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      abortSignal: controller.signal,
    });
    const real = response.model?.trim();
    if (real) {
      writeCachedModel(config, real, env);
      return real;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
