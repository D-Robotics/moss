/**
 * CLI bootstrap: everything that must happen once, at process start, before the
 * runtime exists.
 *
 * Argument parsing (and the exit-on-usage-error contract), the UI language, the
 * warning filter, colors, log level, the offline mock provider, and the trusted
 * startup config read. These are load-time concerns, not run-time behavior:
 * `cli/runtime.ts` imports this module and receives parsed values, so a bad flag
 * still fails before any workspace or network work.
 */
import { ErrorCode, errorMessage, MossError } from '../errors.js';
import { ExitCode } from './exit-codes.js';
import {
  commitProjectRoutingEnv,
  envBeforeDotenv,
  loadCliConfigFile,
  resolveConfigDir,
  type LoadedCliConfigFile,
} from './config.js';
import { parseCliArgs } from './args.js';
import { displayHelp, displayVersion } from './help.js';
import { renderSubcommandHelp } from './subcommand-help.js';
import { resolveFolderTrust } from './workspace-trust.js';
import { configureRootLogger, type LogLevel } from '../logger.js';
import { createColors, isColorEnabled, type ColorHelpers } from './color-level.js';
import {
  installCliUiLanguage,
  isZhLocale,
  setupCopy,
  uiText,
  wrapNoticeLines,
} from './cli-locale.js';
import { setTuiLocale } from './tui/copy.js';
import { migrateLegacyWorkspacePaths } from '../utils/workspace-paths.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMRequestOptions,
  LLMStreamEvent,
} from '../core/llm/llm-provider.js';
export function mossLine(en: string, vars?: Record<string, string | number>): string {
  return setupCopy(undefined, en, vars);
}

export class WorkspacePathPermissionError extends MossError {
  constructor(cause: Error) {
    const code = (cause as NodeJS.ErrnoException).code === 'EACCES' ? 'EACCES' : 'EPERM';
    super({
      code: ErrorCode.CONFIG_IO_FAILED,
      message: uiText(
        `Cannot access a workspace path (${code}).`,
        `无法访问工作区路径（${code}）。`
      ),
      hint: uiText(
        'Check permissions and access restrictions for legacy workspace paths and .moss. Migration may be partially complete.',
        '请检查工作区旧目录和 .moss 的权限与访问限制。迁移可能已部分完成。'
      ),
      cause,
    });
  }
}

export function migrateWorkspacePaths(
  workspace: string
): ReturnType<typeof migrateLegacyWorkspacePaths> {
  try {
    return migrateLegacyWorkspacePaths(workspace);
  } catch (err) {
    if (
      err instanceof Error &&
      ((err as NodeJS.ErrnoException).code === 'EACCES' ||
        (err as NodeJS.ErrnoException).code === 'EPERM')
    ) {
      throw new WorkspacePathPermissionError(err);
    }
    throw err;
  }
}

// Argument errors must be a one-line message, not an uncaught stack trace
// (`moss -m` used to dump a raw Node throw at module load).
function parseCliArgsOrExit(argv: string[]): ReturnType<typeof parseCliArgs> {
  try {
    return parseCliArgs(argv);
  } catch (err) {
    console.error(`[moss] ${errorMessage(err)}`);
    console.error(uiText('Run `moss --help` for usage.', '运行 `moss --help` 查看用法。'));
    process.exit(ExitCode.USAGE);
  }
}

export function printWrappedNotice(text: string): void {
  const columns = process.stderr.columns || process.stdout.columns || 80;
  for (const line of wrapNoticeLines(text, columns)) console.error(line);
}

export const parsedArgs = parseCliArgsOrExit(process.argv.slice(2));
const uiLanguageError = installCliUiLanguage({ flag: parsedArgs.lang });
if (uiLanguageError) {
  console.error(uiLanguageError);
  process.exit(ExitCode.USAGE);
}
setTuiLocale(isZhLocale());

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  const warningType =
    typeof args[0] === 'string' ? args[0] : warning instanceof Error ? warning.name : '';
  if (
    warningType === 'ExperimentalWarning' &&
    message.includes('SOCKS5 proxy support is experimental')
  ) {
    return;
  }
  return originalEmitWarning(warning as never, ...(args as never[]));
}) as typeof process.emitWarning;

export const colorEnabled = isColorEnabled(process.argv);

export const c: ColorHelpers = createColors(colorEnabled);

export const argv = parsedArgs.rawArgv;
if (parsedArgs.detailMode) process.env.MOSS_CLI_DETAIL = parsedArgs.detailMode;

export function resolveCliLogLevel(): LogLevel {
  if (argv.includes('--debug')) return 'debug';
  if (argv.includes('--quiet')) return 'warn';
  const explicit = argv.find((a) => a.startsWith('--log-level='));
  if (explicit) {
    const v = explicit.slice('--log-level='.length).toLowerCase() as LogLevel;
    if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  }
  const env = (process.env.MOSS_LOG_LEVEL ?? '').toLowerCase() as LogLevel;
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') return env;
  // Default to 'warn' so internal diagnostics (tool-replay cache hits,
  // subagent lifecycle, loop state, skill distillation, etc.) don't clutter
  // the user's terminal. The user-facing output goes through the renderer /
  // transcript, not log.info. Opt into diagnostics with MOSS_LOG_LEVEL=info
  // or --log-level=info.
  return 'warn';
}

configureRootLogger({
  scope: 'moss-agent',
  level: resolveCliLogLevel(),
  json: process.env.MOSS_LOG_JSON === '1',
});

// Subcommand-specific --help: show that command's usage, options, and examples,
// not the root banner. `moss --help` (command === 'chat') stays the root help.
if (parsedArgs.help && parsedArgs.command !== 'chat') {
  const subcommandHelp = await renderSubcommandHelp(parsedArgs.command);
  if (subcommandHelp) {
    console.log(subcommandHelp);
    process.exit(0);
  }
}
if (parsedArgs.help) displayHelp(c, { all: parsedArgs.helpAll });
if (parsedArgs.version) displayVersion(c);

// `moss help <unknown>` must not be sent to the model as a prompt.
if (parsedArgs.unknownHelpTopic) {
  const token = parsedArgs.unknownHelpTopic;
  console.error(uiText(`[moss] unknown command '${token}'`, `[moss] 未知命令「${token}」`));
  console.error(uiText('Run `moss --help` for usage.', '运行 `moss --help` 查看用法。'));
  process.exit(ExitCode.USAGE);
}

// `moss version` / `moss help` / `moss status` are COMMAND_LIKE_REDIRECTS
// that should produce the expected output, not an error.
if (parsedArgs.unknownCommand) {
  const { token, suggestion } = parsedArgs.unknownCommand;
  if (suggestion === '--version') {
    displayVersion(c);
  }
  if (suggestion === '--help') {
    displayHelp(c, { all: false });
  }
  // Redirects to known subcommands (e.g. status→doctor)
  if (suggestion === 'doctor') {
    console.error(
      uiText(
        `[moss] '${token}' is an alias for '${suggestion}'. Run \`moss doctor\` instead.`,
        `[moss]「${token}」是「${suggestion}」的别名。请改用 \`moss doctor\`。`
      )
    );
    process.exit(0);
  }
  // Remaining real typos (e.g. confgi→config). Ordinary words are not suggestions.
  if (!['--version', '--help', 'doctor'].includes(suggestion)) {
    console.error(uiText(`[moss] unknown command '${token}'`, `[moss] 未知命令「${token}」`));
    console.error(
      uiText(
        `Did you mean '${suggestion}'?  Run \`moss --help\` for usage.`,
        `是想输入「${suggestion}」吗？运行 \`moss --help\` 查看用法。`
      )
    );
    console.error(
      uiText(
        `To send it to the agent as a prompt instead: moss chat "${token}"`,
        `若要把它当作提示发给模型：moss chat "${token}"`
      )
    );
    process.exit(ExitCode.USAGE);
  }
}

// `moss quickstart` / `moss examples` / etc. name in-session commands — point
// the user at how to run them instead of billing the word as an LLM prompt.
if (parsedArgs.interactiveOnlyCommand) {
  const name = parsedArgs.interactiveOnlyCommand;
  console.error(
    uiText(
      `'${name}' is an in-session command. Start Moss, then type /${name}:`,
      `「${name}」是会话内命令。先启动 Moss，再输入 /${name}：`
    )
  );
  console.error('  moss');
  console.error(`  > /${name}`);
  console.error(
    uiText(
      `(Or to send "${name}" to the model as a prompt: moss chat "${name}".)`,
      `（或把「${name}」当作提示发给模型：moss chat "${name}"。）`
    )
  );
  process.exit(0);
}

// A dash-prefixed token that matched no known flag must NOT be billed as a chat
// prompt (`moss --hepl`) or silently ignored on a subcommand (`doctor --frob`).
if (parsedArgs.unknownOption) {
  console.error(
    uiText(
      `[moss] unknown option '${parsedArgs.unknownOption}'`,
      `[moss] 未知选项「${parsedArgs.unknownOption}」`
    )
  );
  console.error(
    uiText('Run `moss --help` for the flag list.', '运行 `moss --help` 查看选项列表。')
  );
  console.error(
    uiText(
      'To pass a prompt that begins with "-", use: moss chat "<your text>"  (or  moss -- <your text>)',
      '要传入以「-」开头的提示，用：moss chat "<你的文本>"（或 moss -- <你的文本>）'
    )
  );
  process.exit(ExitCode.USAGE);
}

export function createMockLLMProvider(): LLMProvider {
  const mockText =
    'Mock mode — no live LLM. Tools are available for testing. Start a conversation to see tool approvals and plan flows.';
  return {
    id: 'mock',
    displayName: 'Mock (offline)',
    capabilities: { streaming: true },
    complete: async (_options: LLMRequestOptions): Promise<LLMResponse> => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: mockText }],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    stream: async (
      _options: LLMRequestOptions,
      onEvent: (event: LLMStreamEvent) => void
    ): Promise<LLMResponse> => {
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_delta', text: mockText });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: mockText }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

export async function loadTrustedStartupConfig(input: {
  startDir: string;
  argv: string[];
  trustFlag: boolean;
  prompt: boolean;
}): Promise<{
  loadedConfig: LoadedCliConfigFile;
  trusted: boolean;
  folderKey: string;
  ignoredRoutingEnv: string[];
  ignoredRoutingDirs: string[];
}> {
  const configDir = resolveConfigDir();
  const decision = await resolveFolderTrust({
    startDir: input.startDir,
    configDir,
    interactive: input.prompt,
    trustFlag: input.trustFlag,
    env: envBeforeDotenv,
  });
  const ignoredRouting = commitProjectRoutingEnv({
    trusted: decision.trusted,
    folderKey: decision.folderKey,
    configDir,
  });
  const loadedConfig = loadCliConfigFile(process.env, input.argv, input.startDir, {
    trustProjectRouting: decision.trusted,
  });
  return {
    loadedConfig,
    trusted: decision.trusted,
    folderKey: decision.folderKey,
    ignoredRoutingEnv: ignoredRouting.keys,
    ignoredRoutingDirs: ignoredRouting.directories,
  };
}
