import path from 'node:path';
import {
  normalizeApprovalPolicyConfig,
  normalizeConfigProfile,
  normalizeSafetyModeConfig,
  parseConfigBoolean,
  parseTrustedTools,
  safeProcessCwd,
  type CliConfigOverrides,
} from './config.js';
import type { CliInteractionMode, CliSafetyMode } from './approval.js';

export type CliCommand =
  | 'chat'
  | 'setup'
  | 'auth'
  | 'config'
  | 'doctor'
  | 'update'
  | 'resume'
  | 'fork'
  | 'mcp'
  | 'migrate'
  | 'sessions';
export type ApprovalPolicy = 'prompt' | 'never';

export interface ParsedCliArgs {
  command: CliCommand;
  commandArgs: string[];
  prompt: string;
  configOverrides: CliConfigOverrides;
  safetyModeOverride?: CliSafetyMode;
  
  interactionModeOverride?: CliInteractionMode;
  approvalPolicy: ApprovalPolicy;
  sessionKey?: string;
  sessionLast: boolean;
  
  continueLast: boolean;
  forkSource?: string;
  detailMode?: 'quiet' | 'progress' | 'verbose';
  mesh: boolean;
  mock: boolean;
  help: boolean;
  helpAll: boolean;
  version: boolean;
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  maxTurns?: number;
  




  unknownCommand?: { token: string; suggestion: string };
  




  interactiveOnlyCommand?: string;
  




  unknownOption?: string;
  rawArgv: string[];
}

function readValue(
  argv: string[],
  index: number,
  flag: string
): { value: string; nextIndex: number } {
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
  if (raw === 'maxagentturns' || raw === 'maxturns') return 'maxAgentTurns';
  if (raw === 'contexttokens' || raw === 'contextwindow') return 'contextTokens';
  if (raw === 'maxoutputtokens' || raw === 'maxoutput') return 'maxOutputTokens';
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
      throw new Error(
        `Unsupported --config key "trustedTools"; empty value not allowed (omit to use defaults)`
      );
    }
    target.trustedTools = parseTrustedTools(value) ?? [];
    return;
  }
  if (key === 'deniedTools') {
    if (value.trim() === '') {
      throw new Error(
        `Unsupported --config key "deniedTools"; empty value not allowed (omit to use defaults)`
      );
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
  if (key === 'maxAgentTurns' || key === 'contextTokens' || key === 'maxOutputTokens') {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`Unsupported ${key} value "${value}"`);
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
      throw new Error(
        `Unsupported --config key "workspace"; empty value not allowed (use -C with a path)`
      );
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
  'sessions',
];

function asCommand(value: string | undefined): CliCommand | null {
  return value && (KNOWN_COMMANDS as readonly string[]).includes(value)
    ? (value as CliCommand)
    : null;
}








const COMMAND_LIKE_REDIRECTS: Record<string, string> = {
  status: 'doctor',
  help: '--help',
  version: '--version',
};







const INTERACTIVE_ONLY_COMMANDS = new Set<string>([
  'quickstart',
  'examples',
  'tools',
  'models',
  'memory',
  'skills',
  'cost',
  'context',
  'permissions',
  'review',
  'compact',
  'goal',
  'diff',
  'rewind',
  'attach',
  'subagents',
  'thinking',
  'queue',
  'yolo',
  'clear',
  'prompt',
  'theme',
  'onboarding',
  'token',
  'learn',
  'eval',
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
  return (
    arg === '-m' ||
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
    arg === '--log-level'
  );
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
  let interactionModeOverride: CliInteractionMode | undefined;
  let approvalPolicy: ApprovalPolicy = 'never';
  let sessionKey: string | undefined;
  let sessionLast = false;
  let continueLast = false;
  let forkSource: string | undefined;
  let detailMode: ParsedCliArgs['detailMode'];
  let mesh = false;
  let mock = false;
  let help = false;
  let helpAll = false;
  let version = false;
  let print = false;
  let outputFormat: ParsedCliArgs['outputFormat'] = 'text';
  let maxTurns: number | undefined;
  let promptOnly = false;
  
  
  
  let unknownOption: string | undefined;

  
  
  
  
  const requestSafety = (mode: CliSafetyMode, flag: string): void => {
    if (safetyModeOverride !== undefined && safetyModeOverride !== mode) {
      throw new Error(
        `${safetyFlag} and ${flag} conflict — --read-only / --workspace-write / --full-access are mutually exclusive; pick one`
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
    if (arg === '--debug' || arg === '--no-color' || arg === '--setup') {
      continue;
    }
    if (arg === '--json') {
      outputFormat = 'json';
      print = true;
      continue;
    }
    if (arg === '--plan') {
      if (interactionModeOverride !== undefined && interactionModeOverride !== 'plan') {
        throw new Error('--plan and --accept-edits are mutually exclusive; pick one');
      }
      interactionModeOverride = 'plan';
      continue;
    }
    if (arg === '--accept-edits') {
      if (interactionModeOverride !== undefined && interactionModeOverride !== 'acceptEdits') {
        throw new Error('--plan and --accept-edits are mutually exclusive; pick one');
      }
      interactionModeOverride = 'acceptEdits';
      continue;
    }
    if (arg === '--mock') {
      mock = true;
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
    if (arg === '--verbose') {
      detailMode = 'verbose';
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
        
        
        throw new Error(
          `--ask-for-approval must be never|prompt|on-request|read-only|workspace-write|full-access, got "${parsed.value}"`
        );
      }
      if (approval === 'never') {
        approvalPolicy = 'never';
        configOverrides.approvalPolicy = 'never';
      }
      
      
      
      
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

    
    
    
    
    
    
    if (command === 'chat' && arg.startsWith('-') && arg !== '-') {
      if (unknownOption === undefined) unknownOption = arg;
      continue;
    }
    if (arg.startsWith('-') && command !== 'chat') {
      commandArgs.push(arg);
      continue;
    }
    if (command === 'resume') {
      
      
      
      
      
      
      if (sessionKey === undefined) {
        sessionKey = arg;
      } else {
        promptParts.push(arg);
      }
    } else if (command === 'fork') {
      
      
      if (forkSource === undefined) {
        forkSource = arg;
      } else {
        promptParts.push(arg);
      }
    } else if (command === 'chat') {
      promptParts.push(arg);
    } else {
      commandArgs.push(arg);
    }
  }

  
  
  
  let unknownCommand: ParsedCliArgs['unknownCommand'];
  let interactiveOnlyCommand: string | undefined;
  if (
    command === 'chat' &&
    commandArgs.length === 0 &&
    promptParts.length === 1 &&
    !argv.includes('--') &&
    !argv.some((token) => token.startsWith('-'))
  ) {
    
    
    
    
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
    interactionModeOverride,
    approvalPolicy,
    sessionKey,
    sessionLast,
    continueLast,
    forkSource,
    detailMode,
    mesh,
    mock,
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
