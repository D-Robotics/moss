import fs from 'node:fs';
import path from 'node:path';
import { isRgAvailable } from '../tools/search-tools.js';
import {
  auditResolvedCliConfig,
  hasTrustedToolWildcard,
  CONSERVATIVE_DEFAULT_UNPROBED,
} from './config.js';
import type { ResolvedCliConfig } from './config.js';
import { humanTokens } from './tui-utils.js';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, nodeVersionProblem } from './node-version-check.js';
import { errorMessage } from '../errors.js';
import {
  getRecentFailoverEvents,
  parseFallbackProvidersEnv,
} from '../provider/multi-provider-router.js';

interface DoctorOptions {
  config: ResolvedCliConfig;
  runtimeDir: string;
  currentVersion: string;
  safetyMode: string;
  detailMode: string;
}

async function checkSessionIntegrity(sessionsDir: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
      lines.push(ok('sessions', 'no saved sessions yet'));
      return lines;
    }

    let totalCorrupt = 0;
    let corruptFiles = 0;
    let totalFiles = 0;

    for (const file of jsonlFiles) {
      totalFiles++;
      const filePath = path.join(sessionsDir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const contentLines = raw.split('\n').filter((l) => l.trim());
        let fileCorrupt = 0;
        for (const line of contentLines) {
          try {
            JSON.parse(line.includes('\t') ? line.split('\t')[0] : line);
          } catch {
            fileCorrupt++;
          }
        }
        if (fileCorrupt > 0) {
          corruptFiles++;
          totalCorrupt += fileCorrupt;
        }
      } catch {}
    }

    if (corruptFiles === 0) {
      lines.push(ok('sessions', `${totalFiles} file(s), all healthy`));
    } else {
      lines.push(
        warn(
          'sessions',
          `${corruptFiles}/${totalFiles} file(s) have ${totalCorrupt} corrupt line(s). ` +
            `Run \`moss doctor\` again with \`--verbose\` for per-file details, ` +
            `or start fresh sessions with \`moss\` if corruption is severe.`
        )
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      lines.push(ok('sessions', 'no sessions directory yet'));
    } else {
      lines.push(warn('sessions', `could not scan: ${errorMessage(err)}`));
    }
  }
  return lines;
}

export function ok(label: string, detail: string): string {
  return `  ok    ${label}: ${detail}`;
}

export function warn(label: string, detail: string): string {
  return `  warn  ${label}: ${detail}`;
}

export function fail(label: string, detail: string): string {
  return `  fail  ${label}: ${detail}`;
}

export function cliDoctorHasFailure(report: string): boolean {
  return report.split('\n').some((line) => line.startsWith('  fail '));
}

export function renderNodeDoctorLine(version: string = process.version): string {
  return nodeVersionProblem(version)
    ? fail('node', `${version}; requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`)
    : ok('node', version);
}

/**
 * Search-backend line. rg powers search_code / search_files (fast + .gitignore-
 * aware). When absent, the agent falls back to a slower in-process walk that
 * uses a static ignore list — surface it so users debugging slow or noisy
 * search know to install ripgrep.
 */
export function renderSearchDoctor(rgAvailable: boolean): string {
  return rgAvailable
    ? ok('search', 'ripgrep (rg) available — fast, .gitignore-aware')
    : warn(
        'search',
        'ripgrep (rg) not found on PATH — search_code uses a slower in-process walk; install rg for fast, .gitignore-aware search'
      );
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sourceLooksEnv(source: string): boolean {
  return source.startsWith('MOSS_');
}

function renderApprovalDoctor(config: ResolvedCliConfig): string[] {
  // Tolerate partial ResolvedCliConfig objects (spec fixtures may omit the
  // v0.26 permissions view).
  const permissionsView = config.permissions;
  const modeLine = permissionsView
    ? `default ${permissionsView.defaultMode} (${permissionsView.source})${
        permissionsView.readOnlyCeiling ? ' + read-only ceiling' : ''
      }`
    : 'default full (default)';
  const lines: string[] = [
    ok('approval', `${config.approvalPolicy} (${config.approvalPolicySource})`),
    ok('mode', modeLine),
  ];

  const auditWarnings = auditResolvedCliConfig(config);
  for (const auditWarning of auditWarnings) {
    const label = auditWarning.code.startsWith('trustedTools.')
      ? 'trustedTools'
      : auditWarning.code === 'approval.full_default_no_deny'
        ? 'full mode'
        : 'approval policy';
    lines.push(warn(label, auditWarning.message));
  }

  // v0.26 (T04): the read-side migration surfaced legacy keys — tell the
  // user which knobs are deprecated and what to move to.
  const legacyKeys = permissionsView?.legacyKeysUsed ?? [];
  if (legacyKeys.length > 0) {
    lines.push(
      warn(
        'deprecated keys',
        `${legacyKeys.join(', ')} migrated on read — prefer the permissions.* keys (defaultMode/allow/ask/deny)`
      )
    );
  }

  const hasBroadTrustedPattern = auditWarnings.some(
    (entry) => entry.code === 'trustedTools.broad_patterns'
  );
  if (config.trustedTools.length > 0 && hasTrustedToolWildcard(config) && !hasBroadTrustedPattern) {
    lines.push(
      ok(
        'trustedTools',
        `${config.trustedTools.length} configured (${config.trustedToolsSource}); wildcard patterns are narrow`
      )
    );
  } else {
    lines.push(
      ok(
        'trustedTools',
        `${config.trustedTools.length ? config.trustedTools.join(', ') : 'none'} (${config.trustedToolsSource})`
      )
    );
  }

  return lines;
}

function renderBaseUrlDoctor(config: ResolvedCliConfig): string {
  if (config.usingBundledDefault) {
    return ok('baseUrl', 'built-in default (hidden)');
  }
  return ok('baseUrl', `${config.baseUrl} (${config.baseUrlSource})`);
}

/** Keyless search-chain health (O1): which keyed backends are configured and
 * whether the keyless Bing entry point is reachable from this network. */
async function probeKeylessSearchReachability(
  timeoutMs = 2_500
): Promise<'ok' | 'http-error' | 'unreachable'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://www.bing.com/search?q=moss+agent', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; moss-doctor/1.0)' },
      signal: controller.signal,
    });
    return res.ok ? 'ok' : 'http-error';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

async function renderSearchBackendDoctor(): Promise<string[]> {
  const keyed = (
    [
      ['bocha', process.env.BOCHA_API_KEY],
      ['brave', process.env.BRAVE_API_KEY],
      ['exa', process.env.EXA_API_KEY],
    ] as Array<[string, string | undefined]>
  )
    .filter(([, key]) => Boolean(key))
    .map(([name]) => name);
  const lines: string[] = [
    keyed.length > 0
      ? ok('search keys', `${keyed.join(', ')} configured`)
      : warn(
          'search keys',
          'none — web_search relies on the keyless chain (BOCHA/BRAVE/EXA_API_KEY recommended for reliability)'
        ),
  ];
  const reachability = await probeKeylessSearchReachability();
  if (reachability === 'ok') {
    lines.push(ok('search egress', 'keyless chain entry (bing) reachable'));
  } else if (reachability === 'http-error') {
    lines.push(
      warn(
        'search egress',
        'bing answered with an HTTP error — keyless search may be degraded; configure a search API key'
      )
    );
  } else {
    lines.push(
      warn(
        'search egress',
        'keyless chain entry (bing) unreachable from this network — searches will depend on the remaining backends; configure a search API key for reliability'
      )
    );
  }
  return lines;
}

/** Provider failover decisions (O3): which provider served, which were
 * skipped and why — previously only visible in debug logs. */
function renderFailoverDoctor(): string[] {
  const events = getRecentFailoverEvents();
  const configured = parseFallbackProvidersEnv().length > 0;
  if (events.length === 0) {
    return [
      ok(
        'fallback',
        configured
          ? 'chain configured, no failovers recorded yet'
          : 'not configured (optional; set MOSS_FALLBACK_PROVIDERS for multi-provider failover)'
      ),
    ];
  }
  const recent = events.slice(-5);
  const lines = [
    warn('fallback', `${events.length} failover event(s) recorded (last ${recent.length}):`),
  ];
  for (const event of recent) {
    const time = new Date(event.ts).toLocaleTimeString();
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    lines.push(
      warn('', `  ${time} [${event.stage}] ${target} ${event.ok ? '✓' : '✗'} — ${event.reason}`)
    );
  }
  return lines;
}

export async function renderCliDoctor(options: DoctorOptions): Promise<string> {
  const lines = ['[doctor] Moss'];
  lines.push(renderNodeDoctorLine());
  lines.push(ok('version', options.currentVersion));
  const authDetail =
    options.config.apiKeySource === 'built-in'
      ? 'built-in, shared gateway key'
      : `${options.config.apiKeySource}, ${options.config.apiKeyEncrypted ? 'encrypted' : 'plain text'}`;
  lines.push(
    options.config.apiKey
      ? ok('auth', `configured (${authDetail})`)
      : fail('auth', 'missing API key; run moss setup')
  );

  if (options.config.usingBundledDefault) {
    lines.push(ok('built-in model', 'active (no API key needed)'));
  } else if (options.config.bundledDefaultSuppressedBy) {
    lines.push(
      ok('built-in model', `available but shadowed by ${options.config.bundledDefaultSuppressedBy}`)
    );
  }
  lines.push(ok('provider', `${options.config.provider} (${options.config.providerSource})`));

  if (!options.config.model) {
    lines.push(
      warn(
        'model',
        'no default model set; pick one at runtime with `/model`, or set a default via `moss config set model=<name>`'
      )
    );
  } else {
    lines.push(ok('model', `${options.config.model} (${options.config.modelSource})`));
    // Show the actual probed/configured context window. If it wasn't probed
    // yet (source === 'unprobed'), surface a warn so the user knows compaction
    // thresholds are using a conservative default, and guide them to fix it.
    {
      const src = options.config.contextTokensSource;
      const tokens = options.config.contextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED;
      if (src === 'unprobed') {
        lines.push(
          warn(
            'context window',
            `not yet probed — using conservative default of ${humanTokens(tokens)} tokens`
          )
        );
        lines.push(
          warn('', '  Run /model to auto-probe, or set agent.contextTokens in moss config')
        );
      } else if (src === 'provider-api') {
        lines.push(ok('context window', `${humanTokens(tokens)} tokens (provider-api)`));
      } else {
        // 'cli' | 'MOSS_CONTEXT_TOKENS' | 'config'
        lines.push(ok('context window', `${humanTokens(tokens)} tokens (pinned via ${src})`));
      }
    }
    // Max output tokens: show the user-pinned value, or the derived default.
    {
      const pinned = options.config.maxOutputTokens;
      if (pinned !== undefined) {
        lines.push(ok('max output', `${humanTokens(pinned)} tokens (pinned via config)`));
      } else {
        const derived = Math.max(
          2_048,
          Math.min(
            Math.floor((options.config.contextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED) / 4),
            8_192
          )
        );
        lines.push(
          ok(
            'max output',
            `${humanTokens(derived)} tokens (derived from context window — contextTokens/4, cap 8k)`
          )
        );
      }
    }
  }
  lines.push(renderBaseUrlDoctor(options.config));
  lines.push(...renderFailoverDoctor());
  lines.push(
    canWriteDir(options.config.workspace)
      ? ok('workspace', `${options.config.workspace} (${options.config.workspaceSource})`)
      : fail('workspace', `${options.config.workspace} is not writable`)
  );
  lines.push(
    canWriteDir(options.runtimeDir)
      ? ok('runtime', options.runtimeDir)
      : fail('runtime', `${options.runtimeDir} is not writable`)
  );
  lines.push(ok('config', options.config.configPath));

  // search backend — rg powers search_code / search_files (fast + .gitignore-
  // aware). When rg is absent the agent falls back to an in-process walk that
  // is slower on large repos and uses a static ignore list instead of
  // .gitignore. Surface this so users debugging slow or noisy search know to
  // install ripgrep.
  lines.push(renderSearchDoctor(await isRgAvailable()));
  lines.push(...(await renderSearchBackendDoctor()));

  lines.push(...renderApprovalDoctor(options.config));
  lines.push(ok('detail', options.detailMode));

  const sessionsDir = path.join(options.runtimeDir, 'sessions');
  const sessionLines = await checkSessionIntegrity(sessionsDir);
  lines.push(...sessionLines);

  const envSources = [options.config.workspaceSource].filter(sourceLooksEnv);
  if (envSources.length > 0) {
    lines.push(warn('env overrides', [...new Set(envSources)].join(', ')));
  }

  if (options.config.ignoredModelEnvVars.length > 0) {
    const guidance = options.config.apiKey
      ? 'your moss config is already in use — these env vars are intentionally ignored'
      : 'run moss setup or moss config set to configure a model';
    lines.push(
      warn(
        'env ignored',
        `${options.config.ignoredModelEnvVars.join(', ')} — model settings come only from moss config; ${guidance}`
      )
    );
  }

  return lines.join('\n');
}
