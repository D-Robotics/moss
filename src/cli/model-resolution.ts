import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../core/llm/llm-provider.js';
import { resolveConfigDir } from './config.js';

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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), CACHE_FILE_NAME);
}

function readCacheFile(env: NodeJS.ProcessEnv): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(env), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as CacheFile;
  } catch {}
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

function writeCachedModel(
  config: RealModelConfigView,
  model: string,
  env: NodeJS.ProcessEnv
): void {
  const key = cacheKey(config);
  if (!key || !model) return;
  try {
    const file = readCacheFile(env);
    file[key] = { model, resolvedAt: Date.now() };
    fs.mkdirSync(resolveConfigDir(env), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath(env), JSON.stringify(file, null, 2));
  } catch {}
}

const DATED_SNAPSHOT = /(?:-\d{4}-\d{2}-\d{2}|-\d{8})$/;

/** Leaf id with one vendor prefix and one snapshot date removed. */
function canonicalModelId(id: string): string {
  const slash = id.lastIndexOf('/');
  const leaf = slash >= 0 ? id.slice(slash + 1) : id;
  return leaf.replace(DATED_SNAPSHOT, '');
}

/**
 * True when the gateway id is the configured model, or the same id plus a
 * vendor prefix (`vendor/x`) and/or a snapshot date (`-YYYY-MM-DD` or `-YYYYMMDD`).
 */
export function reportedModelMatchesConfigured(configured: string, reported: string): boolean {
  if (configured === reported) return true;
  const left = canonicalModelId(configured);
  const right = canonicalModelId(reported);
  return left.length > 0 && left === right;
}

export function readCachedRealModel(
  config: RealModelConfigView,
  options: { env?: NodeJS.ProcessEnv } = {}
): string | null {
  if (!config.usingBundledDefault) return config.model ?? null;
  return freshCachedModel(config, options.env ?? process.env);
}

export async function resolveRealModel(
  provider: Pick<LLMProvider, 'complete'>,
  config: RealModelConfigView,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<string | null> {
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
