import path from 'node:path';
import { normalizeApprovalPolicyConfig, normalizeConfigProfile, normalizeSafetyModeConfig, parseConfigBoolean, parseTrustedTools, safeProcessCwd, type CliConfigOverrides } from './config.js';
import type { CliSafetyMode } from './approval.js';

export type CliCommand = 'chat' | 'setup' | 'auth' | 'config' | 'doctor' | 'update' | 'resume' | 'fork' | 'mcp' | 'migrate';
export type ApprovalPolicy = 'prompt' | 'never';

export interface ParsedCliArgs {
  command: CliCommand;
  commandArgs: string[];
  prompt: string;
  configOverrides: CliConfigOverrides;
  safetyModeOverride?: CliSafetyMode;
  approvalPolicy: ApprovalPolicy;
  sessionKey?: string;
  sessionLast: boolean;
  /** `--continue`: auto-resume the most recent session on the default chat command. */
  continueLast: boolean;
  forkSource?: string;
  detailMode?: 'quiet' | 'progress' | 'verbose';
  mesh: boolean;
  help: boolean;
  helpAll: boolean;
  version: boolean;
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  maxTurns?: number;
  /**
   * Set when a bare single-token invocation looks like a mistyped subcommand
   * (e.g. `moss confgi`). The caller must surface "unknown command, did you
   * mean …?" and exit non-zero instead of starting a billable chat one-shot.
   */
  unknownCommand?: { token: string; suggestion: string };
  /**
   * Set when a bare token names an in-session ("/slash") command that has no CLI
   * subcommand (e.g. `moss quickstart`). The caller points the user at "start
   * moss, then /<cmd>" instead of billing it as a chat prompt.
   */
  interactiveOnlyCommand?: string;
  /**
   * Set when a dash-prefixed token matched no known flag (e.g. `--hepl`,
   * `doctor --frobnicate`). The caller surfaces "unknown option" and exits
   * non-zero instead of billing it as a prompt or silently ignoring it.
   */
  unknownOption?: string;
  rawArgv: string[];
}

function readValue(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const current = argv[index];
  const eqIdx = current.indexOf('=');
  if (eqIdx !== -1) return { value: current.slice(eqIdx + 1), nextIndex: index };
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function normalizeConfigKey(key: string): keyof CliConfigOverrides | null {
  const raw = key.trim().replace(/[-_]/g, '').toLowerCase();
  if (raw === 'profile') return 'profile';
  if (raw === 'model') return 'model';
  if (raw === 'provider') return 'provider';
  if (raw === 'baseurl') return 'baseUrl';
  if (raw === 'workspace' || raw === 'cwd' || raw === 'cd') return 'workspace';
  if (raw === 'safetymode' || raw === 'safety') return 'safetyMode';
  if (raw === 'approvalpolicy' || raw === 'approval') return 'approvalPolicy';
  if (raw === 'trustedtools' || raw === 'trusttools') return 'trustedTools';
  if (raw === 'deniedtools' || raw === 'denytools') return 'deniedTools';
  if (raw === 'promptcache' || raw === 'promptcacheenabled') return 'promptCacheEnabled';
  if (raw === 'promptcachedebug' || raw === 'promptprefixdebug') return 'promptCacheDebug';
  if (raw === 'imageinput' || raw === 'vision' || raw === 'visioninput') return 'imageInput';
  if (raw === 'maxagentturns' || raw === 'maxturns') return 'maxAgentTurns';
  if (raw === 'contexttokens' || raw === 'contextwindow') return 'contextTokens';
  return null;
}

function applyConfigOverride(target: CliConfigOverrides, pair: string): void {
  const eqIdx = pair.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`--config expects key=value, got "${pair}"`);
  }
  const key = normalizeConfigKey(pair.slice(0, eqIdx));
  if (!key) {
    throw new Error(`Unsupported --config key "${pair.slice(0, eqIdx)}"`);
  }
  const value = pair.slice(eqIdx + 1);
  if (key === 'profile') {
    const normalized = normalizeConfigProfile(value);
    if (!normalized) throw new Error(`Unsupported profile "${value}"`);
    target.profile = normalized;
    return;
  }
  if (key === 'safetyMode') {
    const normalized = normalizeSafetyModeConfig(value);
    if (!normalized) throw new Error(`Unsupported safetyMode "${value}"`);
    target.safetyMode = normalized;
    return;
  }
  if (key === 'approvalPolicy') {
    const normalized = normalizeApprovalPolicyConfig(value);
    if (!normalized) throw new Error(`Unsupported approvalPolicy "${value}"`);
    target.approvalPolicy = normalized;
    return;
  }
  if (key === 'promptCacheEnabled') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported promptCache value "${value}"`);
    target.promptCacheEnabled = parsed;
    return;
  }
  if (key === 'trustedTools') {
    if (value.trim() === '') {
      throw new Error(`Unsupported --config key "trustedTools"; empty value not allowed (omit to use defaults)`);
    }
    target.trustedTools = parseTrustedTools(value) ?? [];
    return;
  }
  if (key === 'deniedTools') {
    if (value.trim() === '') {
      throw new Error(`Unsupported --config key "deniedTools"; empty value not allowed (omit to use defaults)`);
    }
    target.deniedTools = parseTrustedTools(value) ?? [];
    return;
  }
  if (key === 'promptCacheDebug') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported promptCacheDebug value "${value}"`);
    target.promptCacheDebug = parsed;
    return;
  }
  if (key === 'imageInput') {
    const parsed = parseConfigBoolean(value);
    if (parsed === null) throw new Error(`Unsupported imageInput value "${value}"`);
    target.imageInput = parsed;
    return;
  }
  if (key === 'maxAgentTurns' || key === 'contextTokens') {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Unsupported ${key} value "${value}"`);
    target[key] = parsed;
    return;
  }
  if (key === 'model' || key === 'provider' || key === 'baseUrl') {
    if (!value.trim()) {
      throw new Error(`Unsupported --config key "${key}"; empty value not allowed`);
    }
    target[key] = value;
  }
  if (key === 'workspace') {
    if (!value.trim()) {
      throw new Error(`Unsupported --config key "workspace"; empty value not allowed (use -C with a path)`);
    }
    target[key] = value;
  }
}

function normalizeSafetyMode(value: string): CliSafetyMode | null {
  return normalizeSafetyModeConfig(value);
}

function resolveWorkspaceArg(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(safeProcessCwd(), value);
}

function normalizeDetail(value: string): ParsedCliArgs['detailMode'] {
  const raw = value.toLowerCase().trim();
  if (raw === 'quiet' || raw === 'progress' || raw === 'verbose') return raw;
  throw new Error(`Unsupported detail mode "${value}"`);
}

const KNOWN_COMMANDS: readonly CliCommand[] = [
  'setup',
  'auth',
  'config',
  'doctor',
  'update',
  'resume',
  'fork',
  'mcp',
  'migrate',
];

function asCommand(value: string | undefined): CliCommand | null {
  return value && (KNOWN_COMMANDS as readonly string[]).includes(value) ? (value as CliCommand) : null;
}

/**
 * Bare single-token words that are NOT subcommands but that users coming from
 * the interactive surface (or other CLIs) commonly type as `moss <word>` — they
 * are in-session /slash commands (`/status`) or top-level flags (`--help`).
 * Mapped to the right form so they produce a helpful redirect instead of being
 * billed as a chat one-shot. Lowercase keys.
 */
const COMMAND_LIKE_REDIRECTS: Record<string, string> = {
  status: 'doctor',
  help: '--help',
  version: '--version',
};

/**
 * In-session ("/slash") commands that have NO top-level CLI subcommand. A
 * beginner who types `moss quickstart` (a documented in-TUI command) should be
 * pointed at "start moss, then /quickstart" — NOT charged for an LLM turn that
 * treats the word as a prompt. Lowercase, bare-single-token only.
 */
const INTERACTIVE_ONLY_COMMANDS = new Set<string>([
  'quickstart', 'examples', 'tools', 'models', 'memory', 'skills', 'cost',
  'context', 'permissions', 'review', 'compact', 'goal', 'diff', 'rewind',
  'attach', 'subagents', 'thinking', 'queue', 'yolo', 'clear',
]);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Closest known subcommand within edit distance 2, or null. Used to turn a
 * mistyped `moss confgi` into a "did you mean 'config'?" error instead of a
 * silent billable chat one-shot. Deliberately conservative: an exact command
 * match is handled earlier, and legitimate one-word prompts (`moss hi`) sit far
 * outside distance 2 from every command so they keep flowing to chat.
 * @public
 */
export function closestKnownCommand(token: string): string | null {
  const candidate = token.toLowerCase().trim();
  if (!candidate || (KNOWN_COMMANDS as readonly string[]).includes(candidate)) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const command of KNOWN_COMMANDS) {
    const distance = levenshtein(candidate, command);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = command;
    }
  }
  return bestDistance <= 2 ? best : null;
}

function flagConsumesNext(arg: string): boolean {
  return arg === '-m' ||
    arg === '--model' ||
    arg === '-C' ||
    arg === '--cd' ||
    arg === '-c' ||
    arg === '--config' ||
    arg === '--config-file' ||
    arg === '--provider' ||
    arg === '--base-url' ||
    arg === '--ask-for-approval' ||
    arg === '--session' ||
    arg === '--fork-from' ||
    arg === '--detail' ||
    arg === '--output-format' ||
    arg === '--max-turns' ||
    arg === '--log-level';
}

function findCommand(argv: string[]): { command: CliCommand; index: number } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    const command = asCommand(arg);
    if (command) return { command, index: i };
    if (flagConsumesNext(arg)) i++;
  }
  return { command: 'chat', index: -1 };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const foundCommand = findCommand(argv);
  const command = foundCommand.command;
  const commandArgs: string[] = [];
  const promptParts: string[] = [];
  const configOverrides: CliConfigOverrides = {};
  let safetyModeOverride: CliSafetyMode | undefined;
  let safetyFlag: string | undefined;
  let approvalPolicy: ApprovalPolicy = 'prompt';
  let sessionKey: string | undefined;
  let sessionLast = false;
  let continueLast = false;
  let forkSource: string | undefined;
  let detailMode: ParsedCliArgs['detailMode'];
  let mesh = false;
  let help = false;
  let helpAll = false;
  let version = false;
  let print = false;
  let outputFormat: ParsedCliArgs['outputFormat'] = 'text';
  let maxTurns: number | undefined;
  let promptOnly = false;
  // A dash-prefixed token that matches no known flag (set once, reported by the
  // caller as an exit-1 "unknown option" instead of being billed as a prompt or
  // silently ignored on a subcommand).
  let unknownOption: string | undefined;

  // The safety-scope flags (--read-only / --workspace-write / --full-access, and
  // --ask-for-approval's safety values) are mutually exclusive. Requesting two
  // DIFFERENT modes is a mistake — never silently let the last one win, since
  // that can escalate `--read-only` (intended as a guard) to --full-access.
  const requestSafety = (mode: CliSafetyMode, flag: string): void => {
    if (safetyModeOverride !== undefined && safetyModeOverride !== mode) {
      throw new Error(
        `${safetyFlag} and ${flag} conflict — --read-only / --workspace-write / --full-access are mutually exclusive; pick one`,
      );
    }
    safetyModeOverride = mode;
    safetyFlag = flag;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === foundCommand.index) continue;
    if (promptOnly) {
      promptParts.push(arg);
      continue;
    }
    if (arg === '--') {
      promptOnly = true;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--all') {
      helpAll = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }
    if (arg === '--mesh') {
      mesh = true;
      continue;
    }
    if (arg === '--debug' || arg === '--json' || arg === '--no-color' || arg === '--setup') {
      continue;
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--output-format' || arg.startsWith('--output-format=')) {
      const parsed = readValue(argv, i, arg);
      const fmt = parsed.value.trim();
      if (fmt !== 'text' && fmt !== 'json' && fmt !== 'stream-json') {
        throw new Error(`--output-format must be text|json|stream-json, got "${fmt}"`);
      }
      outputFormat = fmt;
      print = true;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--max-turns' || arg.startsWith('--max-turns=')) {
      const parsed = readValue(argv, i, arg);
      const n = Number(parsed.value.trim());
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--max-turns must be a positive integer, got "${parsed.value}"`);
      }
      maxTurns = n;
      configOverrides.maxAgentTurns = n;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const parsed = readValue(argv, i, arg);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--read-only') {
      requestSafety('read-only', '--read-only');
      continue;
    }
    if (arg === '--workspace-write') {
      requestSafety('workspace-write', '--workspace-write');
      continue;
    }
    if (arg === '--full-access') {
      requestSafety('full-access', '--full-access');
      continue;
    }
    if (arg === '--quiet') {
      detailMode = 'quiet';
      continue;
    }

    if (arg === '-m' || arg === '--model' || arg.startsWith('--model=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.model = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '-C' || arg === '--cd' || arg.startsWith('--cd=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.workspace = resolveWorkspaceArg(parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '-c' || arg === '--config' || arg.startsWith('--config=')) {
      const parsed = readValue(argv, i, arg);
      applyConfigOverride(configOverrides, parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--config-file' || arg.startsWith('--config-file=')) {
      const parsed = readValue(argv, i, arg);
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--provider' || arg.startsWith('--provider=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.provider = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const parsed = readValue(argv, i, arg);
      configOverrides.baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--ask-for-approval' || arg.startsWith('--ask-for-approval=')) {
      const parsed = readValue(argv, i, arg);
      const raw = parsed.value.toLowerCase().trim();
      const approval = normalizeApprovalPolicyConfig(raw);
      const safety = normalizeSafetyMode(raw);
      if (!approval && !safety) {
        // Silently dropping unknown values let `--ask-for-approval yolo` look
        // accepted while changing nothing; reject so the user sees the typo.
        throw new Error(
          `--ask-for-approval must be never|prompt|on-request|read-only|workspace-write|full-access, got "${parsed.value}"`,
        );
      }
      if (approval === 'never') {
        approvalPolicy = 'never';
        configOverrides.approvalPolicy = 'never';
      }
      // Only apply a *pure* safety token (read-only/workspace-write/full-access) as a safety
      // override. Tokens that resolve to an approval policy (prompt/never/on-request) must NOT
      // also mutate safetyMode — otherwise `--ask-for-approval on-request` silently escalates to
      // workspace-write, and `--read-only --ask-for-approval on-request` throws a bogus conflict.
      if (safety && !approval) requestSafety(safety, '--ask-for-approval');
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--session' || arg.startsWith('--session=')) {
      const parsed = readValue(argv, i, arg);
      sessionKey = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--last') {
      sessionLast = true;
      continue;
    }
    if (arg === '--continue') {
      // Auto-resume the most recent session for the cwd on a bare `moss` (parity
      // with Claude Code's `claude --continue`). `-c` is already `--config`.
      continueLast = true;
      continue;
    }
    if (arg === '--fork-from' || arg.startsWith('--fork-from=')) {
      const parsed = readValue(argv, i, arg);
      forkSource = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === '--detail' || arg.startsWith('--detail=')) {
      const parsed = readValue(argv, i, arg);
      detailMode = normalizeDetail(parsed.value);
      i = parsed.nextIndex;
      continue;
    }

    // A dash-prefixed token on the default CHAT command matched no known global
    // flag — reject it (`moss --hepl`) instead of billing it as a prompt. Do NOT
    // apply this to subcommands: their own flags (`config init --force`,
    // `auth login --manual`, `config validate --strict`, …) ride in commandArgs
    // and are validated by each subcommand. A literal dash-leading chat prompt
    // goes through `--` or `moss chat "<text>"`.
    if (command === 'chat' && arg.startsWith('-') && arg !== '-') {
      if (unknownOption === undefined) unknownOption = arg;
      continue;
    }
    if (arg.startsWith('-') && command !== 'chat') {
      commandArgs.push(arg);
      continue;
    }
    if (command === 'chat' || command === 'resume' || command === 'fork') {
      promptParts.push(arg);
    } else {
      commandArgs.push(arg);
    }
  }

  // Catch a mistyped subcommand BEFORE it becomes a billable chat one-shot.
  // Only a bare single-token invocation (`moss confgi`) with no flags qualifies;
  // multi-word prose prompts and flag-bearing invocations are never intercepted.
  let unknownCommand: ParsedCliArgs['unknownCommand'];
  let interactiveOnlyCommand: string | undefined;
  if (
    command === 'chat' &&
    commandArgs.length === 0 &&
    promptParts.length === 1 &&
    !argv.includes('--') &&
    !argv.some((token) => token.startsWith('-'))
  ) {
    // Bare words that LOOK like commands but are interactive /slash commands or
    // flags: guide instead of running a billable chat one-shot (e.g. a user who
    // knows `/status` types `moss status`). Checked before the edit-distance
    // fallback. The user can still force a prompt via `moss chat "<word>"`.
    const token = promptParts[0];
    const lower = token.toLowerCase();
    if (INTERACTIVE_ONLY_COMMANDS.has(lower)) {
      interactiveOnlyCommand = lower;
    } else {
      const suggestion = COMMAND_LIKE_REDIRECTS[lower] ?? closestKnownCommand(token);
      if (suggestion) unknownCommand = { token, suggestion };
    }
  }

  return {
    command,
    commandArgs,
    prompt: promptParts.join(' ').trim(),
    configOverrides,
    safetyModeOverride,
    approvalPolicy,
    sessionKey,
    sessionLast,
    continueLast,
    forkSource,
    detailMode,
    mesh,
    help,
    helpAll,
    version,
    print,
    outputFormat,
    maxTurns,
    unknownCommand,
    interactiveOnlyCommand,
    unknownOption,
    rawArgv: argv,
  };
}
