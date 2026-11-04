/**
 * Where the user Moss config dir is, and which env decides it.
 *
 * Shared by workspace trust and the built-in diff stand-in: both resolve the
 * same directory and must not let a project `.env` move it.
 */
import os from 'node:os';
import path from 'node:path';
import { envBeforeDotenv, isStartupEnvCaptured } from './startup-env.js';

/**
 * Env for config-dir resolution. `MOSS_CONFIG_DIR` stays live; `HOME` /
 * `XDG_CONFIG_HOME` / `APPDATA` / `USERPROFILE` come from the pre-`.env`
 * snapshot once the CLI has captured it, so a project `.env` cannot redirect
 * them.
 */
export function configLocationEnv(): NodeJS.ProcessEnv {
  if (!isStartupEnvCaptured()) return process.env;
  const source: NodeJS.ProcessEnv = { ...envBeforeDotenv };
  const live = process.env.MOSS_CONFIG_DIR;
  if (live === undefined) delete source.MOSS_CONFIG_DIR;
  else source.MOSS_CONFIG_DIR = live;
  return source;
}

export function homeFrom(env: NodeJS.ProcessEnv): string {
  const named =
    process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return os.homedir();
}

/** Same directory rules as CLI config resolution. */
export function userConfigDir(env: NodeJS.ProcessEnv): string {
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
