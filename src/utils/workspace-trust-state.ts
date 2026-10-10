/**
 * Whether this workspace has an explicit trust grant.
 *
 * The grant is the same one workspace trust records (#25): `--trust-workspace`,
 * `MOSS_TRUST_WORKSPACE` from the environment captured before a project `.env`,
 * or `workspace-trust.json` in the user config dir. A project `.env` cannot
 * set the variable or move the config dir.
 *
 * Repo git config (`core.fsmonitor`, filters, hooks) is project code the trust
 * prompt does not list. A workspace with nothing to prompt about is not a
 * grant. Model shells harden git until one of those three grants is present.
 */
import os from 'node:os';
import path from 'node:path';
import { folderPathKey, readTrustStore, trustStoreCovers } from './folder-trust-store.js';
import { envBeforeDotenv, isStartupEnvCaptured } from './startup-env.js';

function trustEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.MOSS_TRUST_WORKSPACE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Same directory rules as CLI config resolution. `MOSS_CONFIG_DIR` stays live.
 * `HOME` / `XDG_CONFIG_HOME` / `APPDATA` / `USERPROFILE` come from the
 * pre-`.env` snapshot once the CLI has captured it.
 */
function configLocationEnv(): NodeJS.ProcessEnv {
  if (!isStartupEnvCaptured()) return process.env;
  const source: NodeJS.ProcessEnv = { ...envBeforeDotenv };
  const live = process.env.MOSS_CONFIG_DIR;
  if (live === undefined) delete source.MOSS_CONFIG_DIR;
  else source.MOSS_CONFIG_DIR = live;
  return source;
}

function homeFrom(env: NodeJS.ProcessEnv): string {
  const named =
    process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return os.homedir();
}

function userConfigDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.MOSS_CONFIG_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const home = homeFrom(env);
  const base =
    process.platform === 'win32'
      ? (typeof env.APPDATA === 'string' && env.APPDATA.trim()) ||
        path.join(home, 'AppData', 'Roaming')
      : (typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()) ||
        path.join(home, '.config');
  return path.join(base, 'moss');
}

function trustFlagOnArgv(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') break;
    if (arg === '--trust-workspace') return true;
  }
  return false;
}

export function workspaceTrustKey(workspaceDir: string): string {
  const target = workspaceDir.trim() ? workspaceDir : process.cwd();
  return folderPathKey(target);
}

/** True only for an explicit workspace-trust grant. Missing and `false` are not. */
export function isWorkspaceTrusted(workspaceDir: string): boolean {
  const env = configLocationEnv();
  if (trustFlagOnArgv(process.argv) || trustEnvEnabled(env)) return true;
  return trustStoreCovers(readTrustStore(userConfigDir(env)), workspaceTrustKey(workspaceDir));
}
