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

export function isStartupEnvCaptured(): boolean {
  return captured;
}
