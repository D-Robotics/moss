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
