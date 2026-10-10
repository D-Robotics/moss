/**
 * Process environment captured before a project `.env` is applied.
 * `config.ts` fills this immediately before `loadEnvFromAncestors`.
 * Child processes use it to tell a variable the user set from one a
 * project file added afterwards.
 */
export const envBeforeDotenv: NodeJS.ProcessEnv = {};
let captured = false;

export function captureEnvBeforeDotenv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(envBeforeDotenv)) delete envBeforeDotenv[key];
  Object.assign(envBeforeDotenv, env);
  captured = true;
}

/** Which `.env` file supplied a variable, and whether that file is the user's own. */
const dotenvOrigin = new Map<string, { file: string; userSource: boolean }>();

export function recordDotenvOrigin(key: string, file: string, userSource: boolean): void {
  dotenvOrigin.set(key, { file, userSource });
}

export function dotenvOriginOf(key: string): { file: string; userSource: boolean } | undefined {
  return dotenvOrigin.get(key);
}

export function isStartupEnvCaptured(): boolean {
  return captured;
}
