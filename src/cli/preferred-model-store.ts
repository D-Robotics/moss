import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigDir } from './config.js';

const STORE_FILE = 'preferred-model.json';

function storePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveConfigDir(env), STORE_FILE);
}

function gatewayKey(baseUrl: string | undefined): string | null {
  return baseUrl ? baseUrl.replace(/\/+$/, '') : null;
}

function readStore(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(env), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {}
  return {};
}

export function readPreferredModel(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const key = gatewayKey(baseUrl);
  if (!key) return null;
  const model = readStore(env)[key];
  return typeof model === 'string' && model ? model : null;
}

export function writePreferredModel(
  baseUrl: string | undefined,
  model: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const key = gatewayKey(baseUrl);
  if (!key || !model) return;
  try {
    const store = readStore(env);
    if (store[key] === model) return;
    store[key] = model;
    fs.mkdirSync(resolveConfigDir(env), { recursive: true });
    fs.writeFileSync(storePath(env), JSON.stringify(store, null, 2));
  } catch {}
}
