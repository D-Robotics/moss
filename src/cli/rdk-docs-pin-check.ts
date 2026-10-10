/**
 * Opt-in comparison of the pinned rdk-docs-mcp release with npm latest.
 * Off unless MOSS_RDK_DOCS_PIN_CHECK is set, so startup and `npm run verify`
 * never contact the registry.
 */
import { ProcessError, runProcess } from '../utils/run-process.js';
import {
  DEFAULT_RDK_DOCS_MCP_PACKAGE,
  rdkDocsPinDrift,
  rdkDocsPinnedNpmVersion,
} from '../core/mcp/rdk-docs.js';

const PACKAGE_NAME = 'rdk-docs-mcp';

export type RdkDocsPinNote =
  | { kind: 'current' | 'latest-newer' | 'pin-newer'; pinned: string; latest: string }
  | { kind: 'unchecked'; pinned: string; reason: string };

export function rdkDocsPinCheckEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.MOSS_RDK_DOCS_PIN_CHECK ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function errorText(err: unknown): string {
  if (err instanceof ProcessError) {
    const detail = (err.timedOut ? 'timed out' : err.stderr || err.stdout || err.message).trim();
    return detail.split('\n')[0]?.slice(0, 180) || 'npm view failed';
  }
  if (err instanceof Error) return err.message.split('\n')[0]?.slice(0, 180) || 'npm view failed';
  return 'npm view failed';
}

/** `npm view rdk-docs-mcp version`. Caller must already have decided to use the network. */
export async function lookupNpmLatestVersion(
  name: string = PACKAGE_NAME
): Promise<{ version?: string; error?: string }> {
  try {
    const result = await runProcess('npm', {
      args: ['view', name, 'version', '--json'],
      timeout: 8_000,
    });
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== 'string') return { error: 'unexpected npm view output' };
    const version = /^(\d+\.\d+\.\d+)/.exec(parsed)?.[1];
    if (!version) return { error: 'unexpected npm view output' };
    return { version };
  } catch (err) {
    return { error: errorText(err) };
  }
}

/**
 * Undefined when the check is off — no process is spawned. A newer npm latest
 * is a note, not a failure.
 */
export async function rdkDocsPinNote(
  env: NodeJS.ProcessEnv,
  lookup: (name: string) => Promise<{ version?: string; error?: string }> = lookupNpmLatestVersion
): Promise<RdkDocsPinNote | undefined> {
  if (!rdkDocsPinCheckEnabled(env)) return undefined;
  const pinned = DEFAULT_RDK_DOCS_MCP_PACKAGE;
  const pinnedVersion = rdkDocsPinnedNpmVersion(pinned);
  if (!pinnedVersion) return { kind: 'unchecked', pinned, reason: 'pin is not an npm version' };
  let looked: { version?: string; error?: string };
  try {
    looked = await lookup(PACKAGE_NAME);
  } catch (err) {
    return { kind: 'unchecked', pinned, reason: errorText(err) };
  }
  if (!looked.version) {
    return { kind: 'unchecked', pinned, reason: looked.error ?? 'no version' };
  }
  const drift = rdkDocsPinDrift(pinnedVersion, looked.version);
  if (drift === 'unparsed') return { kind: 'unchecked', pinned, reason: 'latest is not semver' };
  if (drift === 'latest-newer') return { kind: 'latest-newer', pinned, latest: looked.version };
  if (drift === 'pin-newer') return { kind: 'pin-newer', pinned, latest: looked.version };
  return { kind: 'current', pinned, latest: looked.version };
}
