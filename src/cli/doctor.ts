import fs from 'node:fs';
import path from 'node:path';
import { isRgAvailable } from '../tools/search-tools.js';
import {
  auditResolvedCliConfig,
  HOOK_EVENT_KEYS,
  loadConfigFile,
  resolveConfigDir,
  envBeforeDotenv,
  hasTrustedToolWildcard,
  CONSERVATIVE_DEFAULT_UNPROBED,
} from './config.js';
import type { ResolvedCliConfig } from './config.js';
import { deriveMaxOutputTokens } from './agent-runtime.js';
import { humanTokens } from './session-format.js';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, nodeVersionProblem } from './node-version-check.js';
import { errorMessage } from '../errors.js';
import { uiText } from '../utils/ui-language.js';
import {
  getRecentFailoverEvents,
  parseFallbackProvidersEnv,
} from '../provider/multi-provider-router.js';
import { isZhLocale, setupCopy } from './cli-locale.js';
import { glossConfigValue, localizeConfigSource } from './config-snapshot.js';
import { detectEnvCredentials } from './env-credentials.js';
import { collectMossRuntimeFacts, displayMossPath } from './moss-binary-path.js';
import { formatVersionLine, getPackageJsonPath, readBuildStamp } from './package-info.js';
import type { BuildStamp } from './package-info.js';
import { rdkDocsPinNote } from './rdk-docs-pin-check.js';
import type { RdkDocsPinNote } from './rdk-docs-pin-check.js';
import { renderBoardProxyDoctor } from './doctor-board-proxy.js';
import { renderRdkDepsDoctor } from './doctor-rdk-deps.js';
import { loadMcpConfigs } from './mcp-config.js';
import { isMossHookEventId } from './hook-event-names.js';
import { hookEntryWarnings } from './hooks-view.js';
import { builtinTools } from '../tools/builtin.js';
import { loadFileBasedTools } from '../tools/file-based-tools.js';
import { isFolderTrusted } from './folder-trust-store.js';

function doctorL(en: string, vars?: Record<string, string | number>): string {
  return setupCopy(undefined, en, vars);
}

function doctorParen(inner: string): string {
  return uiText(`(${inner})`, `（${localizeConfigSource(inner)}）`);
}

function detailModeLabel(mode: string): string {
  if (mode === 'quiet') return uiText('quiet', '安静');
  if (mode === 'verbose') return uiText('verbose', '详细');
  if (mode === 'progress') return uiText('progress', '进度');
  return mode;
}

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
      lines.push(
        ok(uiText('sessions', '会话'), uiText('no saved sessions yet', '还没有已保存的会话'))
      );
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
      lines.push(
        ok(
          uiText('sessions', '会话'),
          uiText(`${totalFiles} file(s), all healthy`, `${totalFiles} 个文件，全部正常`)
        )
      );
    } else {
      lines.push(
        warn(
          uiText('sessions', '会话'),
          uiText(
            `${corruptFiles}/${totalFiles} file(s) have ${totalCorrupt} corrupt line(s). ` +
              `Run \`moss doctor\` again with \`--verbose\` for per-file details, ` +
              `or start fresh sessions with \`moss\` if corruption is severe.`,
            `${corruptFiles}/${totalFiles} 个文件里有 ${totalCorrupt} 行损坏。再次运行 \`moss doctor --verbose\` 查看每个文件；损坏严重时用 \`moss\` 开新会话。`
          )
        )
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      lines.push(
        ok(uiText('sessions', '会话'), uiText('no sessions directory yet', '还没有会话目录'))
      );
    } else {
      lines.push(
        warn(
          uiText('sessions', '会话'),
          uiText(`could not scan: ${errorMessage(err)}`, `无法扫描：${errorMessage(err)}`)
        )
      );
    }
  }
  return lines;
}

function doctorSep(): string {
  return uiText(':', '：');
}

export function ok(label: string, detail: string): string {
  return `  ok    ${label}${doctorSep()} ${detail}`;
}

export function warn(label: string, detail: string): string {
  return `  warn  ${label}${doctorSep()} ${detail}`;
}

export function fail(label: string, detail: string): string {
  return `  fail  ${label}${doctorSep()} ${detail}`;
}

export function cliDoctorHasFailure(report: string): boolean {
  return report.split('\n').some((line) => line.startsWith('  fail '));
}

/**
 * Version label for doctor. Same stamp as `moss --version` when a commit was
 * recorded. Chinese avoids the English word `dirty` and keeps the commit in
 * the same token as the version digits.
 */
export function formatDoctorVersion(version: string, stamp: BuildStamp | null): string {
  if (!version || version === 'unknown') return uiText('unknown', '未知');
  const formatted = formatVersionLine(version, stamp);
  const marked = `moss v${version}`;
  const en =
    formatted.startsWith(marked) && formatted.length > marked.length
      ? `${version}${formatted.slice(marked.length)}`
      : version;
  const commit = stamp?.commit;
  if (!commit) return uiText(en, version);
  const dirtyNote = stamp?.dirty ? '，有未提交改动' : '';
  const dateNote = stamp?.date ? `，${stamp.date}` : '';
  return uiText(en, `${version}（${commit}${dirtyNote}${dateNote}）`);
}

/** Version (with build stamp), running entry, package root, and a PATH collision warning. */
export function renderMossRuntimeDoctorLines(input: {
  version: string;
  stamp: BuildStamp | null;
  entryPath: string;
  packageRoot: string;
  warning: string | null;
}): string[] {
  const entry = displayMossPath(input.entryPath);
  const root = displayMossPath(input.packageRoot);
  const lines = [
    ok(uiText('version', '版本'), formatDoctorVersion(input.version, input.stamp)),
    ok(
      uiText('binary', '程序'),
      uiText(`${entry} (package ${root})`, `${entry}（安装根目录 ${root}）`)
    ),
  ];
  if (input.warning) lines.push(warn(uiText('binaries', '可执行文件'), input.warning));
  return lines;
}

/**
 * Facts for the running install. Stat and realpath only. On any failure this
 * still returns a version line, and never a `fail` line.
 */
function mossRuntimeDoctorLines(version: string): string[] {
  try {
    const facts = collectMossRuntimeFacts({
      pathEnv: process.env.PATH,
      pathExt: process.env.PATHEXT,
      platform: process.platform,
      fs: {
        statSync(filePath: string) {
          return fs.statSync(filePath);
        },
        realpathSync(filePath: string) {
          return fs.realpathSync(filePath);
        },
      },
      argv1: process.argv[1],
      packageJsonPath: getPackageJsonPath(),
    });
    return renderMossRuntimeDoctorLines({
      version,
      stamp: readBuildStamp(),
      entryPath: facts.entryPath,
      packageRoot: facts.packageRoot,
      warning: facts.scan.warning,
    });
  } catch {
    return [ok(uiText('version', '版本'), version || uiText('unknown', '未知'))];
  }
}

/** Informational. A newer npm release is a warning, never a `fail` line. */
export function renderRdkDocsPinDoctorLine(note: RdkDocsPinNote): string {
  if (note.kind === 'latest-newer') {
    return warn(
      'rdk-docs',
      uiText(
        `pinned ${note.pinned}; npm latest is ${note.latest}`,
        `钉在 ${note.pinned}；npm latest 是 ${note.latest}`
      )
    );
  }
  if (note.kind === 'unchecked') {
    return warn(
      'rdk-docs',
      uiText(
        `pinned ${note.pinned}; npm latest was not checked (${note.reason})`,
        `钉在 ${note.pinned}；没有核对 npm latest（${note.reason}）`
      )
    );
  }
  return ok(
    'rdk-docs',
    uiText(
      `pinned ${note.pinned}; npm latest is ${note.latest}`,
      `钉在 ${note.pinned}；npm latest 是 ${note.latest}`
    )
  );
}

export function renderNodeDoctorLine(version: string = process.version): string {
  return nodeVersionProblem(version)
    ? fail(
        uiText('node', '运行时'),
        uiText(
          `${version}; requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`,
          `${version}；需要 >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`
        )
      )
    : ok(uiText('node', '运行时'), version);
}

/**
 * Search-backend line. rg powers search_code / search_files (fast + .gitignore-
 * aware). When absent, the agent falls back to a slower in-process walk that
 * uses a static ignore list — surface it so users debugging slow or noisy
 * search know to install ripgrep.
 */
export function renderSearchDoctor(rgAvailable: boolean): string {
  return rgAvailable
    ? ok(
        uiText('search', '搜索'),
        uiText(
          'ripgrep (rg) available — fast, .gitignore-aware',
          'ripgrep（`rg`）可用 — 更快，并识别 .gitignore'
        )
      )
    : warn(
        uiText('search', '搜索'),
        uiText(
          'ripgrep (rg) not found on PATH — search_code uses a slower in-process walk; install rg for fast, .gitignore-aware search',
          'PATH 上没有 ripgrep（`rg`）— `search_code` 会走较慢的进程内扫描；安装 `rg` 可获得更快、识别 .gitignore 的搜索'
        )
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
    ? uiText(
        `default ${permissionsView.defaultMode} (${permissionsView.source})${
          permissionsView.readOnlyCeiling ? ' + read-only ceiling' : ''
        }`,
        `默认 ${glossConfigValue(permissionsView.defaultMode)}（${localizeConfigSource(permissionsView.source)}）${
          permissionsView.readOnlyCeiling ? ' + 只读上限' : ''
        }`
      )
    : uiText('default full (default)', '默认完全访问（默认）');
  const lines: string[] = [
    ok(
      uiText('approval', '审批'),
      `${isZhLocale() ? glossConfigValue(config.approvalPolicy) : config.approvalPolicy} ${doctorParen(config.approvalPolicySource)}`
    ),
    ok(uiText('mode', '模式'), modeLine),
  ];

  const auditWarnings = auditResolvedCliConfig(config);
  for (const auditWarning of auditWarnings) {
    const label = auditWarning.code.startsWith('trustedTools.')
      ? 'trustedTools'
      : auditWarning.code === 'approval.full_default_no_deny'
        ? uiText('full mode', '完全访问模式')
        : auditWarning.code === 'permissions.broad_allow_pattern'
          ? uiText('allow rules', 'allow 规则')
          : uiText('approval policy', '审批策略');
    lines.push(warn(label, auditWarning.message));
  }

  // v0.26 (T04): the read-side migration surfaced legacy keys — tell the
  // user which knobs are deprecated and what to move to.
  const legacyKeys = permissionsView?.legacyKeysUsed ?? [];
  if (legacyKeys.length > 0) {
    lines.push(
      warn(
        uiText('deprecated keys', '已弃用的键'),
        uiText(
          `${legacyKeys.join(', ')} migrated on read — prefer the permissions.* keys (defaultMode/allow/ask/deny)`,
          `${legacyKeys.join(', ')} 已在读取时迁移 — 请改用 permissions.*（defaultMode/allow/ask/deny）`
        )
      )
    );
  }

  const hasBroadTrustedPattern = auditWarnings.some(
    (entry) => entry.code === 'trustedTools.broad_patterns'
  );
  if (config.trustedTools.length > 0 && hasTrustedToolWildcard(config) && !hasBroadTrustedPattern) {
    lines.push(
      ok(
        uiText('trustedTools', '信任工具'),
        uiText(
          `${config.trustedTools.length} configured (${config.trustedToolsSource}); wildcard patterns are narrow`,
          `已配置 ${config.trustedTools.length} 项（${localizeConfigSource(config.trustedToolsSource)}）；通配较窄`
        )
      )
    );
  } else {
    lines.push(
      ok(
        uiText('trustedTools', '信任工具'),
        uiText(
          `${config.trustedTools.length ? config.trustedTools.join(', ') : 'none'} (${config.trustedToolsSource})`,
          `${config.trustedTools.length ? config.trustedTools.join('、') : '无'}（${localizeConfigSource(config.trustedToolsSource)}）`
        )
      )
    );
  }

  return lines;
}

/**
 * Behavior switches that are invisible unless asked for: whether the endpoint
 * accepts images, whether review_changes must run, whether the L1 completion
 * gate blocks a run. `moss config show` reports them (B56); the diagnostic view
 * should not disagree with it.
 */
function renderBehaviorDoctor(config: ResolvedCliConfig): string[] {
  const images =
    config.supportsImages === false
      ? uiText('text-only (agent.supportsImages=false)', '仅文本（agent.supportsImages=false）')
      : uiText('image input allowed', '允许图片输入');
  const reviewMode = config.reviewMode ?? 'manual';
  const gate = config.verificationGate === false ? uiText('off', '关闭') : uiText('on', '开启');
  return [
    ok(
      uiText('images', '图片输入'),
      `${images} ${doctorParen(config.supportsImagesSource ?? 'default')}`
    ),
    ok(
      uiText('review mode', '评审模式'),
      isZhLocale()
        ? `${reviewMode}（${config.reviewMode ? '配置或环境变量' : '默认'}）`
        : `${reviewMode} (${config.reviewMode ? 'config or env' : 'default'})`
    ),
    ok(
      uiText('verification gate', '验证门'),
      `${gate} ${doctorParen(config.verificationGateSource ?? 'default')}`
    ),
  ];
}

function renderBaseUrlDoctor(config: ResolvedCliConfig): string {
  if (config.usingBundledDefault) {
    return ok(uiText('baseUrl', '地址'), uiText('built-in default (hidden)', '内置默认（不显示）'));
  }
  if (!config.baseUrl) {
    return fail(
      uiText('baseUrl', '地址'),
      doctorL('missing. Fix: run `moss setup`, or `moss config set baseUrl https://host`.')
    );
  }
  return ok(uiText('baseUrl', '地址'), `${config.baseUrl} ${doctorParen(config.baseUrlSource)}`);
}

/** Keyless search-chain health (O1): which keyed backends are configured and
 * whether the keyless Bing entry point is reachable from this network. */
async function probeKeylessSearchReachability(
  timeoutMs = 2_500
): Promise<'ok' | 'http-error' | 'unreachable'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetch('https://www.bing.com/search?q=moss+agent', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; moss-doctor/1.0)' },
      signal: controller.signal,
    });
    return response.ok ? 'ok' : 'http-error';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
    controller.abort();
    await response?.body?.cancel().catch(() => {});
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
      ? ok(
          uiText('search keys', '搜索密钥'),
          uiText(`${keyed.join(', ')} configured`, `已配置 ${keyed.join(', ')}`)
        )
      : warn(
          uiText('search keys', '搜索密钥'),
          uiText(
            'none — web_search relies on the keyless chain (BOCHA/BRAVE/EXA_API_KEY recommended for reliability)',
            '无 — `web_search` 依赖免密钥链路（建议配置 BOCHA/BRAVE/EXA_API_KEY，更稳）'
          )
        ),
  ];
  const reachability = await probeKeylessSearchReachability();
  if (reachability === 'ok') {
    lines.push(
      ok(
        uiText('search egress', '搜索出口'),
        uiText('keyless chain entry (bing) reachable', '免密钥入口（bing）可达')
      )
    );
  } else if (reachability === 'http-error') {
    lines.push(
      warn(
        uiText('search egress', '搜索出口'),
        uiText(
          'bing answered with an HTTP error — keyless search may be degraded; configure a search API key',
          'bing 返回了 HTTP 错误 — 免密钥搜索可能变差；请配置搜索 API key'
        )
      )
    );
  } else {
    lines.push(
      warn(
        uiText('search egress', '搜索出口'),
        uiText(
          'keyless chain entry (bing) unreachable from this network — searches will depend on the remaining backends; configure a search API key for reliability',
          '当前网络到不了免密钥入口（bing）— 搜索会依赖其余后端；请配置搜索 API key'
        )
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
        uiText('fallback', '回退'),
        configured
          ? uiText('chain configured, no failovers recorded yet', '链路已配置，还没有回退记录')
          : uiText('not configured', '未配置')
      ),
    ];
  }
  const recent = events.slice(-5);
  const lines = [
    warn(
      uiText('fallback', '回退'),
      uiText(
        `${events.length} failover event(s) recorded (last ${recent.length}):`,
        `已记录 ${events.length} 次回退（最近 ${recent.length} 次）：`
      )
    ),
  ];
  for (const event of recent) {
    const time = new Date(event.ts).toLocaleTimeString();
    const target = event.model ? `${event.provider}/${event.model}` : event.provider;
    lines.push(
      warn(
        uiText('event', '事件'),
        `${time} [${event.stage}] ${target} ${event.ok ? '✓' : '✗'} — ${event.reason}`
      )
    );
  }
  return lines;
}

/** Exact next step for a missing or unused key. The value is never included. */
export function renderAuthDoctorLine(
  config: Pick<
    ResolvedCliConfig,
    'apiKey' | 'apiKeySource' | 'apiKeyEncrypted' | 'usingBundledDefault'
  >,
  env: NodeJS.ProcessEnv = envBeforeDotenv
): string {
  if (config.usingBundledDefault && !config.apiKey) {
    return ok(uiText('auth', '认证'), doctorL('built-in gateway (no API key needed)'));
  }
  const offers = detectEnvCredentials(env);
  const names = offers.map((offer) => offer.keyVar);
  if (config.apiKey) {
    const authDetail =
      config.apiKeySource === 'built-in'
        ? doctorL('built-in, shared gateway key')
        : config.apiKeySource.startsWith('env:')
          ? doctorL('from {name} (not stored)', { name: config.apiKeySource.slice(4) })
          : uiText(
              `${config.apiKeySource}, ${
                config.apiKeyEncrypted
                  ? doctorL('stored in config file (0600)')
                  : doctorL('plain text')
              }`,
              `${localizeConfigSource(config.apiKeySource)}，${
                config.apiKeyEncrypted
                  ? doctorL('stored in config file (0600)')
                  : doctorL('plain text')
              }`
            );
    return ok(uiText('auth', '认证'), doctorL('configured ({detail})', { detail: authDetail }));
  }
  if (names.length > 0) {
    return fail(
      uiText('auth', '认证'),
      doctorL(
        'missing API key. Fix: run `moss` and press Enter to use {names} (the value is not printed).',
        { names: names.join(setupCopy(undefined, ' or ')) }
      )
    );
  }
  return fail(
    uiText('auth', '认证'),
    doctorL('missing API key. Fix: run `moss` and finish setup, or run `moss setup`.')
  );
}

/**
 * Static MCP config audit. `moss doctor` cannot connect (that is the runtime's
 * job and `/doctor` reports live states), but a typo in mcp.json — a stdio
 * server without `command`, an entry that is not an object — is invisible until
 * the first model turn needs that server. The project file is only read when the
 * folder is trusted, because an untrusted folder's mcp.json is ignored at
 * runtime too; saying so is more useful than silently listing its servers.
 */
function renderMcpConfigDoctor(config: ResolvedCliConfig): string[] {
  const configDir = resolveConfigDir();
  const projectFile = path.join(config.workspace, '.moss', 'mcp.json');
  const projectExists = fs.existsSync(projectFile);
  const trusted = isFolderTrusted(configDir, config.workspace);
  const warnings: string[] = [];
  const servers = loadMcpConfigs(
    config.workspace,
    configDir,
    process.env,
    (message) => warnings.push(message),
    { projectServers: projectExists && trusted }
  );
  if (!projectExists && servers.length === 0 && warnings.length === 0) return [];
  const lines: string[] = [];
  const label = uiText('MCP config', 'MCP 配置');
  if (servers.length === 0) {
    lines.push(
      ok(
        label,
        warnings.length > 0
          ? uiText('no valid servers (see below)', '没有可用的服务器（见下方）')
          : uiText('no servers configured', '未配置服务器')
      )
    );
  } else {
    lines.push(
      ok(
        label,
        uiText(
          `${servers.length} server${servers.length === 1 ? '' : 's'}: ${servers
            .map((server) => server.name)
            .join(', ')}`,
          `${servers.length} 个服务器：${servers.map((server) => server.name).join('、')}`
        )
      )
    );
  }
  for (const warning of warnings) lines.push(warn(label, warning));
  if (projectExists && !trusted) {
    lines.push(
      warn(
        label,
        uiText(
          'project .moss/mcp.json is ignored until this folder is trusted — run /trust (or the folder-trust prompt) to enable it',
          '项目 .moss/mcp.json 在信任该文件夹前会被忽略——运行 /trust（或接受文件夹信任提示）后才会生效'
        )
      )
    );
  }
  return lines;
}

/**
 * Static hooks audit. Hooks can only fire on a known event, and an unknown key
 * is dropped by mergeHooksConfig() without a word — a hook written for a typo'd
 * or Claude-only event name looks configured and never runs. `moss doctor` is
 * where that is cheap to catch (the interactive `/doctor` reports live hooks).
 */
function renderHookConfigDoctor(config: ResolvedCliConfig): string[] {
  const label = uiText('hooks', 'hooks');
  const files: Array<{ path: string; scope: string }> = [];
  files.push({ path: config.configPath, scope: uiText('user', '用户') });
  const projectPath = config.projectConfigPath;
  if (projectPath && isFolderTrusted(resolveConfigDir(), config.workspace)) {
    files.push({ path: projectPath, scope: uiText('project', '项目') });
  }
  const lines: string[] = [];
  const zh = isZhLocale();
  // Registered tool names the matcher/if checks compare against: builtins plus
  // this workspace's file-based custom tools. MCP tools cannot be known here
  // (they register after the handshake) and hookEntryWarnings skips `mcp__…`.
  const knownToolNames = [
    ...builtinTools.map((tool) => tool.name),
    ...loadFileBasedTools(config.workspace).map((tool) => tool.name),
  ];
  let total = 0;
  let eventCount = 0;
  for (const file of files) {
    let hooks: Record<string, unknown> | undefined;
    try {
      hooks = loadConfigFile(file.path).hooks as Record<string, unknown> | undefined;
    } catch {
      continue; // Unreadable/invalid config is auditResolvedCliConfig's report.
    }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, entries] of Object.entries(hooks)) {
      const list = Array.isArray(entries) ? entries : [];
      if (!isMossHookEventId(event)) {
        if (list.length === 0) continue;
        lines.push(
          warn(
            label,
            uiText(
              `${file.scope} config has ${list.length} hook(s) on "${event}", which is not a Moss event — they never fire (events: ${HOOK_EVENT_KEYS.join(', ')})`,
              `${file.scope}配置里有 ${list.length} 条 hook 挂在 "${event}" 上，这不是 Moss 事件——永远不会触发（可用事件：${HOOK_EVENT_KEYS.join('、')}）`
            )
          )
        );
        continue;
      }
      if (list.length === 0) continue;
      total += list.length;
      eventCount += 1;
      for (const entry of list) {
        const hook = entry as Parameters<typeof hookEntryWarnings>[1];
        for (const message of hookEntryWarnings(event, hook, { zh, knownToolNames })) {
          lines.push(warn(label, `${file.scope}: ${message}`));
        }
      }
    }
  }
  if (total > 0) {
    lines.push(
      ok(
        label,
        uiText(
          `${total} hook${total === 1 ? '' : 's'} on ${eventCount} event${eventCount === 1 ? '' : 's'} (config files)`,
          `${total} 条，${eventCount} 个事件（来自配置文件）`
        )
      )
    );
  }
  return lines;
}

export async function renderCliDoctor(options: DoctorOptions): Promise<string> {
  const lines = [uiText('[doctor] Moss', '[诊断] Moss')];
  lines.push(renderNodeDoctorLine());
  lines.push(...mossRuntimeDoctorLines(options.currentVersion));
  const pinNote = await rdkDocsPinNote(process.env);
  if (pinNote) lines.push(renderRdkDocsPinDoctorLine(pinNote));
  lines.push(renderAuthDoctorLine(options.config));
  const usedEnvVar = options.config.apiKeySource.startsWith('env:')
    ? options.config.apiKeySource.slice('env:'.length)
    : '';
  const unusedEnvKeys = options.config.apiKey
    ? detectEnvCredentials(envBeforeDotenv)
        .map((offer) => offer.keyVar)
        .filter((name) => name !== usedEnvVar)
    : [];
  if (unusedEnvKeys.length > 0) {
    lines.push(
      warn(
        uiText('env key', '环境变量密钥'),
        doctorL(
          '{names} is set and was not applied. Fix: the saved moss config is in use — run `moss setup` to switch.',
          { names: unusedEnvKeys.join(', ') }
        )
      )
    );
  }

  if (options.config.usingBundledDefault) {
    lines.push(
      ok(
        uiText('built-in model', '内置模型'),
        uiText('active (no API key needed)', '已启用（不需要 API key）')
      )
    );
  } else if (options.config.bundledDefaultSuppressedBy) {
    lines.push(
      ok(
        uiText('built-in model', '内置模型'),
        uiText(
          `available but shadowed by ${options.config.bundledDefaultSuppressedBy}`,
          `可用，但被 ${options.config.bundledDefaultSuppressedBy} 挡住`
        )
      )
    );
  }
  lines.push(
    ok(
      uiText('provider', '服务商'),
      `${options.config.provider} ${doctorParen(options.config.providerSource)}`
    )
  );

  if (!options.config.model) {
    lines.push(
      warn(
        uiText('model', '模型'),
        doctorL('no default model. Fix: run `/model`, highlight one, and press d to save it.')
      )
    );
  } else {
    lines.push(
      ok(
        uiText('model', '模型'),
        `${options.config.model} ${doctorParen(options.config.modelSource)}`
      )
    );
    // Show the actual probed/configured context window. If it wasn't probed
    // yet (source === 'unprobed'), surface a warn so the user knows compaction
    // thresholds are using a conservative default, and guide them to fix it.
    {
      const src = options.config.contextTokensSource;
      const tokens = options.config.contextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED;
      if (src === 'unprobed') {
        lines.push(
          warn(
            uiText('context window', '上下文窗口'),
            uiText(
              `not yet probed — using conservative default of ${humanTokens(tokens)} tokens. Run /model to auto-probe, or set agent.contextTokens in moss config`,
              `尚未探测 — 正在使用保守默认值 ${humanTokens(tokens)} 词元。运行 /model 自动探测，或在 moss 配置里设置 \`agent.contextTokens\``
            )
          )
        );
      } else if (src === 'provider-api') {
        lines.push(
          ok(
            uiText('context window', '上下文窗口'),
            uiText(
              `${humanTokens(tokens)} tokens (provider-api)`,
              `${humanTokens(tokens)} 词元（${localizeConfigSource('provider-api')}）`
            )
          )
        );
      } else {
        // 'cli' | 'MOSS_CONTEXT_TOKENS' | 'config'
        lines.push(
          ok(
            uiText('context window', '上下文窗口'),
            uiText(
              `${humanTokens(tokens)} tokens (pinned via ${src})`,
              `${humanTokens(tokens)} 词元（由 ${localizeConfigSource(src)} 固定）`
            )
          )
        );
      }
    }
    // Max output tokens: show the user-pinned value, or the derived default.
    {
      const pinned = options.config.maxOutputTokens;
      if (pinned !== undefined) {
        lines.push(
          ok(
            uiText('max output', '最大输出'),
            uiText(
              `${humanTokens(pinned)} tokens (pinned via config)`,
              `${humanTokens(pinned)} 词元（由配置固定）`
            )
          )
        );
      } else {
        const derived = deriveMaxOutputTokens(
          options.config.contextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED,
          options.config.model
        );
        lines.push(
          ok(
            uiText('max output', '最大输出'),
            uiText(
              `${humanTokens(derived ?? 0)} tokens (derived from the model and context window)`,
              `${humanTokens(derived ?? 0)} 词元（由模型和上下文窗口推算）`
            )
          )
        );
      }
    }
  }
  lines.push(renderBaseUrlDoctor(options.config));
  lines.push(...renderFailoverDoctor());
  lines.push(
    canWriteDir(options.config.workspace)
      ? ok(
          uiText('workspace', '工作区'),
          `${options.config.workspace} ${doctorParen(options.config.workspaceSource)}`
        )
      : fail(
          uiText('workspace', '工作区'),
          doctorL(
            '{path} is not writable. Fix: run `moss -C <existing-dir>` or `chmod u+w {path}`.',
            { path: options.config.workspace }
          )
        )
  );
  lines.push(
    canWriteDir(options.runtimeDir)
      ? ok(uiText('runtime', '运行时'), options.runtimeDir)
      : fail(
          uiText('runtime', '运行时'),
          doctorL(
            '{path} is not writable. Fix: `mkdir -p {path}` or pick another workspace with `moss -C`.',
            { path: options.runtimeDir }
          )
        )
  );
  lines.push(ok(uiText('config', '配置'), options.config.configPath));

  // search backend — rg powers search_code / search_files (fast + .gitignore-
  // aware). When rg is absent the agent falls back to an in-process walk that
  // is slower on large repos and uses a static ignore list instead of
  // .gitignore. Surface this so users debugging slow or noisy search know to
  // install ripgrep.
  lines.push(renderSearchDoctor(await isRgAvailable()));
  lines.push(...(await renderSearchBackendDoctor()));
  // O66: proxy env + gateway reachability hints (no NODE_USE_ENV_PROXY).
  lines.push(
    ...(await renderBoardProxyDoctor({
      baseUrl: options.config.baseUrl,
    }))
  );
  // O85: deprecated RDK pip indexes + optional verified whl probe.
  lines.push(...(await renderRdkDepsDoctor()));

  lines.push(...renderApprovalDoctor(options.config));
  lines.push(...renderBehaviorDoctor(options.config));
  lines.push(...renderMcpConfigDoctor(options.config));
  lines.push(...renderHookConfigDoctor(options.config));
  lines.push(ok(uiText('detail', '详细程度'), detailModeLabel(options.detailMode)));

  const sessionsDir = path.join(options.runtimeDir, 'sessions');
  const sessionLines = await checkSessionIntegrity(sessionsDir);
  lines.push(...sessionLines);

  const envSources = [options.config.workspaceSource].filter(sourceLooksEnv);
  if (envSources.length > 0) {
    lines.push(warn(uiText('env overrides', '环境变量覆盖'), [...new Set(envSources)].join(', ')));
  }

  if (options.config.ignoredModelEnvVars.length > 0) {
    const names = options.config.ignoredModelEnvVars.join(', ');
    lines.push(
      warn(
        uiText('env ignored', '已忽略的环境变量'),
        doctorL(
          '{names} is not read. Fix: `moss config set provider <name>`, `moss config set model <name>`, or `moss config set baseUrl <url>`.',
          { names }
        )
      )
    );
  }

  return lines.join('\n');
}
