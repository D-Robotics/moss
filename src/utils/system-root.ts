import { envForSystemPaths } from './startup-env.js';

/** Used when the env has no usable SystemRoot / windir. */
export const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';

/**
 * O164: the Windows directory (`C:\\Windows`) for building paths to system
 * programs such as `System32\\WindowsPowerShell\\v1.0\\powershell.exe`.
 * Read from the env before a project `.env` was applied (a repo `.env` that
 * sets `SystemRoot=<workspace>\\fake` must not choose the program), and only
 * a drive-absolute value counts: a UNC share or a relative value falls back
 * to the default.
 */
export function windowsSystemRoot(
  env: Record<string, string | undefined> = envForSystemPaths()
): string {
  for (const name of ['SystemRoot', 'windir']) {
    const key =
      env[name] !== undefined
        ? name
        : Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    const value = key === undefined ? undefined : env[key]?.trim();
    if (value && /^[A-Za-z]:[\\/]/.test(value)) return value;
  }
  return DEFAULT_WINDOWS_SYSTEM_ROOT;
}

/**
 * O164: a Windows child env with no SystemRoot (the user's startup env had
 * none, and a value a project `.env` added is stripped) gets the trusted one;
 * Windows PowerShell and many system programs do not start without it.
 * Other platforms, and envs that already carry SystemRoot, are returned as is.
 */
export function withWindowsSystemRoot<T extends Record<string, string | undefined>>(
  env: T,
  platform: NodeJS.Platform = process.platform
): T {
  if (platform !== 'win32') return env;
  if (Object.keys(env).some((k) => k.toUpperCase() === 'SYSTEMROOT' && env[k])) return env;
  return { ...env, SystemRoot: windowsSystemRoot() };
}
