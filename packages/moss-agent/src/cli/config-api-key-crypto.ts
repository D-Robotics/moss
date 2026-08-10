import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../errors.js';
import type { ConfigFile } from './config.js';
import { CliConfigFileError } from './config-errors.js';

const APIKEY_CIPHER_PREFIX = 'enc:';

type DirectorySyncOperations = Pick<typeof fs, 'openSync' | 'fsyncSync' | 'closeSync'>;

function directorySyncUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM'))
  );
}

/** Persist a directory entry; only explicit platform non-support is ignorable. */
export function syncConfigDirectory(
  directoryPath: string,
  operations: DirectorySyncOperations = fs
): void {
  let directoryFd: number | undefined;
  try {
    directoryFd = operations.openSync(directoryPath, 'r');
    operations.fsyncSync(directoryFd);
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    if (directoryFd !== undefined) operations.closeSync(directoryFd);
  }
}

/** Create missing config-directory levels and persist each parent entry. */
export function ensureConfigDirectoryDurably(directoryPath: string): void {
  const missing: string[] = [];
  let existing = path.resolve(directoryPath);
  while (!fs.existsSync(existing)) {
    missing.push(existing);
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No existing parent for ${directoryPath}`);
    existing = parent;
  }
  for (const next of missing.reverse()) {
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    syncConfigDirectory(next);
    syncConfigDirectory(path.dirname(next));
  }
}

function validateEncryptionKey(key: Buffer, configPath: string): Buffer {
  if (key.length !== 32) {
    throw new CliConfigFileError(
      configPath,
      'API key encryption key is invalid; restore .apikey-key or run moss setup again'
    );
  }
  return key;
}

function ensureEncryptionKey(configDir: string, configPath: string): Buffer {
  const keyPath = path.join(configDir, '.apikey-key');
  if (fs.existsSync(keyPath)) {
    const existing = validateEncryptionKey(fs.readFileSync(keyPath), configPath);
    syncConfigDirectory(configDir);
    return existing;
  }
  const key = crypto.randomBytes(32);
  ensureConfigDirectoryDurably(configDir);
  const candidatePath = path.join(
    configDir,
    `.apikey-key.${process.pid}.${crypto.randomUUID()}.candidate`
  );
  let candidateFd: number | undefined;
  try {
    candidateFd = fs.openSync(candidatePath, 'wx', 0o600);
    fs.writeFileSync(candidateFd, key);
    fs.fsyncSync(candidateFd);
    fs.closeSync(candidateFd);
    candidateFd = undefined;
    // linkSync is atomic and fails with EEXIST, so every process either
    // publishes one fully durable key or reads the winner. Creating keyPath
    // directly exposed an empty/partial file window and allowed split-brain
    // encryption keys across concurrent first-run config writes.
    try {
      fs.linkSync(candidatePath, keyPath);
      syncConfigDirectory(configDir);
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const winner = validateEncryptionKey(fs.readFileSync(keyPath), configPath);
      syncConfigDirectory(configDir);
      return winner;
    }
  } catch (err) {
    if (err instanceof CliConfigFileError) throw err;
    throw new CliConfigFileError(
      configPath,
      `cannot create API key encryption key: ${errorMessage(err)}`
    );
  } finally {
    if (candidateFd !== undefined) {
      try {
        fs.closeSync(candidateFd);
      } catch {}
    }
    try {
      fs.rmSync(candidatePath, { force: true });
    } catch {}
  }
}

function readEncryptionKey(configDir: string, configPath: string): Buffer {
  const keyPath = path.join(configDir, '.apikey-key');
  if (!fs.existsSync(keyPath)) {
    throw new CliConfigFileError(
      configPath,
      'API key encryption key is missing; restore .apikey-key or run moss setup again'
    );
  }
  try {
    return validateEncryptionKey(fs.readFileSync(keyPath), configPath);
  } catch (err) {
    if (err instanceof CliConfigFileError) throw err;
    throw new CliConfigFileError(
      configPath,
      `cannot read API key encryption key: ${errorMessage(err)}`
    );
  }
}

function encryptApiKey(apiKey: string, configDir: string, configPath: string): string {
  const key = ensureEncryptionKey(configDir, configPath);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, 'utf-8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  return `${APIKEY_CIPHER_PREFIX}${payload}`;
}

function decryptApiKey(encryptedApiKey: string, configDir: string, configPath: string): string {
  try {
    const payload = Buffer.from(encryptedApiKey.slice(APIKEY_CIPHER_PREFIX.length), 'base64');
    if (payload.length <= 32) {
      throw new CliConfigFileError(configPath, 'encrypted API key payload is invalid');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      readEncryptionKey(configDir, configPath),
      payload.subarray(0, 16)
    );
    decipher.setAuthTag(payload.subarray(16, 32));
    return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]).toString(
      'utf-8'
    );
  } catch (err) {
    if (err instanceof CliConfigFileError) throw err;
    throw new CliConfigFileError(
      configPath,
      'encrypted API key cannot be decrypted; restore .apikey-key or run moss setup again'
    );
  }
}

export function maybeEncryptApiKeyInConfig(
  config: ConfigFile,
  configDir: string,
  configPath = path.join(configDir, 'config.json')
): ConfigFile {
  if (!config.apiKey || config.apiKey.startsWith(APIKEY_CIPHER_PREFIX)) return config;
  return { ...config, apiKey: encryptApiKey(config.apiKey, configDir, configPath) };
}

export function maybeDecryptApiKeyInConfig(
  config: ConfigFile,
  configDir: string,
  configPath = path.join(configDir, 'config.json')
): ConfigFile {
  if (!config.apiKey || !config.apiKey.startsWith(APIKEY_CIPHER_PREFIX)) return config;
  return {
    ...config,
    apiKey: decryptApiKey(config.apiKey, configDir, configPath),
    _apiKeyEncrypted: true,
  };
}
