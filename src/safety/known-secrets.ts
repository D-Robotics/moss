/**
 * Exact-value redaction for secrets the process already knows: env vars whose
 * names look like keys, tokens, secrets, or passwords; the configured provider
 * API key; and Moss's own stored credential fields. Pattern redaction cannot
 * see a key that was dumped byte by byte and typed back out in prose.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD)/i;
const STORED_FIELD = /(?:api[_-]?key|token|secret|password|passwd|credential)/i;
const MIN_SECRET_LENGTH = 8;

const noted = new Set<string>();
let storedCache: { key: string; values: string[] } | null = null;

/** Remember a secret the host already resolved, such as the provider API key. */
export function noteKnownSecret(value: string | undefined): void {
  if (!isUsableSecret(value)) return;
  noted.add(value);
  storedCache = null;
}

/**
 * If the text ends with a proper prefix of a known secret, return the index
 * where that prefix starts so the caller can keep it off screen until the
 * value is complete. A full secret is left in place for exact-match redaction.
 */
export function knownSecretPrefixCut(text: string, env: NodeJS.ProcessEnv = process.env): number {
  let cut = text.length;
  for (const secret of collectKnownSecretValues(env)) {
    const max = Math.min(text.length, secret.length - 1);
    for (let len = max; len >= 4; len -= 1) {
      if (secret.startsWith(text.slice(text.length - len))) {
        cut = Math.min(cut, text.length - len);
        break;
      }
    }
  }
  return cut;
}

export function redactKnownSecretValues(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!text) return text;
  let out = text;
  for (const secret of collectKnownSecretValues(env)) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) out = out.split(escaped).join('[REDACTED]');
  }
  return out;
}

function collectKnownSecretValues(env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>(noted);
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !isUsableSecret(value)) continue;
    found.add(value);
  }
  for (const value of mossStoredSecrets(env)) found.add(value);
  return [...found].sort((a, b) => b.length - a.length);
}

function isUsableSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= MIN_SECRET_LENGTH && !value.includes('\0'));
}

function mossStoredSecrets(env: NodeJS.ProcessEnv): string[] {
  const key = [
    env.HOME ?? '',
    env.USERPROFILE ?? '',
    env.XDG_CONFIG_HOME ?? '',
    env.MOSS_CONFIG_DIR ?? '',
    process.cwd(),
  ].join('|');
  if (storedCache?.key === key) return storedCache.values;
  const values: string[] = [];
  for (const file of storedConfigPaths(env)) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      collectStoredStrings(JSON.parse(raw) as unknown, values, 0);
    } catch {
      // A non-JSON credential file is not scanned as a document.
    }
  }
  storedCache = { key, values };
  return values;
}

function storedConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const home = (env.HOME || env.USERPROFILE || os.homedir()).trim() || os.homedir();
  const paths = [
    path.join(home, '.moss', 'config.json'),
    path.join(home, '.config', 'moss', 'config.json'),
    path.join(process.cwd(), '.moss', 'config.json'),
  ];
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) paths.push(path.join(xdg, 'moss', 'config.json'));
  const explicit = (env.MOSS_CONFIG_DIR || '').trim();
  if (explicit) paths.push(path.join(explicit, 'config.json'));
  return paths;
}

function collectStoredStrings(value: unknown, out: string[], depth: number): void {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStoredStrings(entry, out, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && STORED_FIELD.test(key) && isUsableSecret(entry)) {
      out.push(entry);
    } else if (entry && typeof entry === 'object') {
      collectStoredStrings(entry, out, depth + 1);
    }
  }
}
