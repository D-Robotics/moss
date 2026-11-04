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
import { configLocationEnv, userConfigDir } from './config-location.js';
import { folderPathKey, readTrustStore, trustStoreCovers } from './folder-trust-store.js';

function trustEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.MOSS_TRUST_WORKSPACE ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
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
