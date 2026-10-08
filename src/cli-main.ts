// Moss Agent CLI main — see --help for usage, config, and environment variables.

import fs from 'node:fs';
import path from 'node:path';
import { configureWindowsUtf8Console } from './utils/run-process.js';
import { errorMessage } from './errors.js';
import { buildResumeReplay } from './cli/resume-replay.js';
import { exitCodeForError, ExitCode } from './cli/exit-codes.js';
import { resolveCliAgentRuntimeOptions, deriveMaxOutputTokens } from './cli/agent-runtime.js';
import {
  createCliToolApprovalHook,
  getCliInteractionMode,
  resolveCliSafetyMode,
  setCliInteractionMode,
  type CliInteractionMode,
} from './cli/approval.js';
import {
  CliConfigFileError,
  CliConfigWriteError,
  loadCliConfigFile,
  loadEnvFromAncestors,
  resolveCliConfig,
  resolveConfigDir,
  safeProcessCwd,
  shouldShowFullDefaultNotice,
} from './cli/config.js';
import { parseCliArgs } from './cli/args.js';
import {
  PermissionRuleRegistry,
  parsePermissionRuleSpec,
  type PermissionRule,
  type ResolvedPermissionRules,
} from './cli/permission-rules.js';
import { displayHelp, displayVersion } from './cli/help.js';
import { createConfiguredGuardrailHooks } from './cli/guardrails.js';
import { createConfiguredHookCallbacks, setLifecycleHookRunner } from './cli/hooks.js';
import { resolveSoulIdentity, resolveSoul } from './cli/soul.js';
import type { AgentHooks } from './core/agent/agent-hooks.js';
import { createCliProvider } from './cli/providers.js';
import type { CliProviderRuntimeConfig } from './cli/providers.js';
import { resolveContextTokensForModel } from './cli/model-catalog.js';
import { createModelInfoTool } from './cli/model-info-tool.js';
import { runOneShotWithCliCancellation } from './cli/run-cancellation.js';
import { runInteractive } from './cli/repl.js';
import { resolveCliSession } from './cli/session.js';
import {
  hasShownOneShotOnboardingHint,
  markOneShotOnboardingShown,
  offerSetupForInteractiveMissingConfig,
  printMissingConfigGuidance,
  renderOneShotOnboardingHint,
} from './cli/onboarding-hints.js';
import { renderConfigHelp } from './cli/config-commands.js';
import { MossAgent, JsonlSessionStore } from './core/index.js';
import { configureRootLogger, type LogLevel } from './logger.js';
import pc from 'picocolors';
import { registerBuiltinTools } from './tools/builtin.js';
import { loadFileBasedTools } from './tools/file-based-tools.js';
import { loadMcpConfigs } from './cli/mcp-config.js';
import { McpToolRegistry, buildMcpPromptLayer } from './core/mcp/registry.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import {
  loadSkills,
  buildSkillsPromptLayer,
  buildEmptySkillsHintLayer,
} from './core/skills/skill-registry.js';
import { buildAgentsMdLayer } from './cli/project-instructions.js';
import { createSkillTool } from './tools/skill-tool.js';
import {
  runRegistryCommand,
  unknownSlashCommandLines,
  type CommandContext as RegistryCommandContext,
} from './cli/commands/registry.js';
import { commandSuggestion, cliLocale, KNOWN_COMMANDS } from './cli/tui-utils.js';
import { buildAnswerLanguageLayer } from './cli/cli-locale.js';
import { buildEnvironmentContextLayer, getGitBranch } from './context/environment.js';
import { disconnectAllDevices } from './device/device-registry.js';
import { configureDeviceWorkspace, resolveDefaultDeviceTarget } from './device/device-target.js';
import { buildRuntimeCapabilitiesPrompt } from './context/runtime-capabilities.js';
import { buildSoftwareEngineeringPromptQuick } from './contracts/index.js';
import type { CliRuntimeStatus } from './cli/onboarding.js';
import { resolveCliDetailMode } from './cli/output.js';
import { migrateLegacyWorkspacePaths } from './utils/workspace-paths.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMRequestOptions,
  LLMStreamEvent,
} from './core/llm/llm-provider.js';
import {
  CliPhase,
  getPhaseForCommand,
  isUnimplementedCommand,
  getCommandConfig,
  type CommandContext,
} from './cli/command-dispatcher.js';

// Argument errors must be a one-line message, not an uncaught stack trace
// (`moss -m` used to dump a raw Node throw at module load).
function parseCliArgsOrExit(argv: string[]): ReturnType<typeof parseCliArgs> {
  try {
    return parseCliArgs(argv);
  } catch (err) {
    console.error(`[moss] ${errorMessage(err)}`);
    console.error('Run `moss --help` for usage.');
    process.exit(exitCodeForError(err));
  }
}

const parsedArgs = parseCliArgsOrExit(process.argv.slice(2));

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

const colorEnabled = (() => {
  if (process.argv.includes('--no-color')) return false;
  if (process.env.NO_COLOR || process.env.MOSS_NO_COLOR === '1') return false;
  if (!process.stderr.isTTY && !process.stdout.isTTY) return false;
  return true;
})();

export const c = {
  bold: (s: string) => (colorEnabled ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled ? pc.dim(s) : s),
  red: (s: string) => (colorEnabled ? pc.red(s) : s),
  green: (s: string) => (colorEnabled ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled ? pc.yellow(s) : s),
  blue: (s: string) => (colorEnabled ? pc.blue(s) : s),
  cyan: (s: string) => (colorEnabled ? pc.cyan(s) : s),
  magenta: (s: string) => (colorEnabled ? pc.magenta(s) : s),
  gray: (s: string) => (colorEnabled ? pc.gray(s) : s),
};

const argv = parsedArgs.rawArgv;
if (parsedArgs.detailMode) process.env.MOSS_CLI_DETAIL = parsedArgs.detailMode;

function resolveCliLogLevel(): LogLevel {
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

// Subcommand-specific --help: show the subcommand's own usage, not the global
// banner, so `moss config --help` answers the actual question.
if (parsedArgs.help && parsedArgs.command === 'config') {
  console.log(renderConfigHelp());
  process.exit(0);
}
if (parsedArgs.help) displayHelp(c, { all: parsedArgs.helpAll });
if (parsedArgs.version) displayVersion(c);

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
      `[moss] '${token}' is an alias for '${suggestion}'. Run \`moss doctor\` instead.`
    );
    process.exit(0);
  }
  // Remaining edit-distance typos (e.g. confgi→config)
  if (!['--version', '--help', 'doctor'].includes(suggestion)) {
    console.error(`[moss] unknown command '${token}'`);
    console.error(`Did you mean '${suggestion}'?  Run \`moss --help\` for usage.`);
    console.error(`To send it to the agent as a prompt instead: moss chat "${token}"`);
    process.exit(ExitCode.USAGE);
  }
}

// `moss quickstart` / `moss examples` / etc. name in-session commands — point
// the user at how to run them instead of billing the word as an LLM prompt.
if (parsedArgs.interactiveOnlyCommand) {
  const c = parsedArgs.interactiveOnlyCommand;
  console.error(`'${c}' is an in-session command. Start Moss, then type /${c}:`);
  console.error('  moss');
  console.error(`  > /${c}`);
  console.error(`(Or to send "${c}" to the model as a prompt: moss chat "${c}".)`);
  process.exit(0);
}

// A dash-prefixed token that matched no known flag must NOT be billed as a chat
// prompt (`moss --hepl`) or silently ignored on a subcommand (`doctor --frob`).
if (parsedArgs.unknownOption) {
  console.error(`[moss] unknown option '${parsedArgs.unknownOption}'`);
  console.error('Run `moss --help` for the flag list.');
  console.error(
    'To pass a prompt that begins with "-", use: moss chat "<your text>"  (or  moss -- <your text>)'
  );
  process.exit(ExitCode.USAGE);
}

function createMockLLMProvider(): LLMProvider {
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

async function main() {
  if (process.platform === 'win32') {
    try {
      configureWindowsUtf8Console();
    } catch {
      /* best-effort UTF-8 */
    }
  }

  const fallbackStartDir =
    parsedArgs.configOverrides.workspace ||
    process.env.MOSS_WORKSPACE ||
    safeProcessCwd(process.env);

  // Determine the initialization phase needed for this command
  const requiredPhase = getPhaseForCommand(parsedArgs.command);
  const commandConfig = getCommandConfig(parsedArgs.command);

  // Known-but-unimplemented subcommands must hard-fail instead of silently
  // falling through into chat.
  if (isUnimplementedCommand(parsedArgs.command)) {
    console.error(
      `moss: "${parsedArgs.command}" is not implemented in this build — the subsystem was removed. Run "moss --help" for available commands.`
    );
    process.exit(ExitCode.USAGE);
  }

  // CliPhase.None: no initialization needed (e.g., setup, --help, --version)
  if (requiredPhase === CliPhase.None && commandConfig) {
    const ctx: CommandContext = {
      argv,
      commandArgs: parsedArgs.commandArgs,
      configOverrides: parsedArgs.configOverrides,
    };
    await commandConfig.handler(ctx);
    return;
  }

  // CliPhase.ConfigOnly: load config file, resolve it, and dispatch
  if (requiredPhase === CliPhase.ConfigOnly && commandConfig) {
    if (parsedArgs.configOverrides.workspace) {
      loadEnvFromAncestors(parsedArgs.configOverrides.workspace as string);
    }
    const loadedConfig = loadCliConfigFile(process.env, process.argv.slice(2), fallbackStartDir);
    const resolvedConfig = resolveCliConfig(
      process.env,
      loadedConfig.config,
      parsedArgs.configOverrides,
      loadedConfig
    );

    const ctx: CommandContext = {
      argv,
      commandArgs: parsedArgs.commandArgs,
      configOverrides: parsedArgs.configOverrides,
      fallbackStartDir,
      loadedConfig,
      resolvedConfig,
      workspacePathMigration: migrateLegacyWorkspacePaths(resolvedConfig.workspace as string),
    };
    await commandConfig.handler(ctx);
    return;
  }

  // CliPhase.WorkspaceReady: validate workspace and dispatch
  if (requiredPhase === CliPhase.WorkspaceReady && commandConfig) {
    if (parsedArgs.configOverrides.workspace) {
      loadEnvFromAncestors(parsedArgs.configOverrides.workspace as string);
    }
    const loadedConfig = loadCliConfigFile(process.env, process.argv.slice(2), fallbackStartDir);
    const resolvedConfig = resolveCliConfig(
      process.env,
      loadedConfig.config,
      parsedArgs.configOverrides,
      loadedConfig
    );
    const workspace = resolvedConfig.workspace as string;

    let workspaceStat: fs.Stats;
    try {
      workspaceStat = fs.statSync(workspace);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`[moss] workspace path does not exist: ${workspace}`);
        console.error(
          'Pass an existing directory with -C/--cd, or run moss from inside your project.'
        );
      } else {
        console.error(`[moss] cannot access workspace: ${errorMessage(err)}`);
      }
      process.exit(ExitCode.CONFIG);
    }
    if (!workspaceStat.isDirectory()) {
      console.error(`[moss] workspace path is not a directory: ${workspace}`);
      console.error('Pass a directory with -C/--cd.');
      process.exit(ExitCode.CONFIG);
    }

    const ctx: CommandContext = {
      argv,
      commandArgs: parsedArgs.commandArgs,
      configOverrides: parsedArgs.configOverrides,
      fallbackStartDir,
      loadedConfig,
      resolvedConfig,
      workspace,
      workspaceStat,
      workspacePathMigration: migrateLegacyWorkspacePaths(workspace),
    };
    await commandConfig.handler(ctx);
    return;
  }

  // CliPhase.AgentReady: config + workspace + full agent initialization
  // Everything after this point is for interactive/chat/resume/fork commands
  if (parsedArgs.configOverrides.workspace) {
    loadEnvFromAncestors(parsedArgs.configOverrides.workspace);
  }
  const configStartDir = fallbackStartDir;
  const loadedConfig = loadCliConfigFile(process.env, process.argv.slice(2), configStartDir);
  let resolvedConfig = resolveCliConfig(
    process.env,
    loadedConfig.config,
    parsedArgs.configOverrides,
    loadedConfig
  );
  // Model settings are config-only (decision 2026-06). Say so once when a
  // leftover provider env var is present, instead of silently ignoring it —
  // doctor shows the same list as a structured `env ignored` line.
  // Gate on both the resolved CLI log level and detail mode so `--quiet`
  // / `MOSS_LOG_LEVEL=warn` / `MOSS_CLI_DETAIL=quiet` silence this notice;
  // doctor's `env ignored` line stays the source of truth.
  const cliLogLevel = resolveCliLogLevel();
  const cliDetailForNotices = parsedArgs.detailMode ?? resolveCliDetailMode(argv);
  // Warn about ignored env vars only when no API key is configured — the
  // warning is noise for users who already set up their own provider.
  if (
    resolvedConfig.ignoredModelEnvVars.length > 0 &&
    !resolvedConfig.apiKey &&
    parsedArgs.command !== 'doctor' &&
    (cliLogLevel === 'debug' || cliLogLevel === 'info') &&
    cliDetailForNotices !== 'quiet'
  ) {
    console.error(
      `[config] ignoring model env var(s): ${resolvedConfig.ignoredModelEnvVars.join(', ')} — ` +
        `model settings come only from moss config, not env vars. ` +
        `using ${resolvedConfig.provider} / ${resolvedConfig.model} ` +
        '(change with moss setup / moss config set)'
    );
  }
  // v0.26 mode engine (T01): the mode is the first axis. Startup mode =
  // flag override (--plan/--accept-edits/--full-access/--read-only…) >
  // resolved config permissions.defaultMode (env/legacy migrated inside).
  // safetyMode is a read projection of the mode (deriveEngineQuantas).
  const startupMode: CliInteractionMode =
    parsedArgs.interactionModeOverride ?? resolvedConfig.permissions.defaultMode;
  const safetyMode =
    parsedArgs.safetyModeOverride ?? resolvedConfig.safetyMode ?? resolveCliSafetyMode(argv);
  // Apply startup interaction mode (flags or the config default). The global
  // singleton starts at 'manual'; the resolved default (v0.26: full) takes
  // over unless a flag already set it above.
  if (parsedArgs.interactionModeOverride || startupMode !== 'manual') {
    setCliInteractionMode(startupMode);
    if (cliDetailForNotices !== 'quiet') {
      const modeLabels: Record<string, string> = {
        plan: 'plan (dry-run)',
        acceptEdits: 'accept-edits',
        manual: 'manual',
        full: 'full (v0.26 default — add deny rules with /permissions)',
      };
      console.error(
        `[moss] Interaction mode: ${modeLabels[parsedArgs.interactionModeOverride ?? startupMode] || (parsedArgs.interactionModeOverride ?? startupMode)}`
      );
    }
  }
  // v0.26 one-shot full-default notice (PRD decision 7): session-level
  // deduplication in memory — the factory-default full user with no deny rules
  // hears "add deny rules with /permissions" exactly once per session.
  if (cliDetailForNotices !== 'quiet' && shouldShowFullDefaultNotice(resolvedConfig)) {
    console.error(
      '[moss] Default full mode has no deny rules; add them with /permissions ' +
        '(e.g. deny read_file(./.env)) to keep sensitive tools gated. This notice shows once.'
    );
  }
  const workspace = resolvedConfig.workspace;
  // Validate the workspace up front so a bad -C/--cd (or MOSS_WORKSPACE) yields
  // a one-line actionable error instead of a raw "ENOENT: mkdir" Node stack from
  // deep inside the session store.
  let workspaceStat: fs.Stats;
  try {
    workspaceStat = fs.statSync(workspace);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`[moss] workspace path does not exist: ${workspace}`);
      console.error(
        'Pass an existing directory with -C/--cd, or run moss from inside your project.'
      );
    } else {
      console.error(`[moss] cannot access workspace: ${errorMessage(err)}`);
    }
    process.exit(ExitCode.CONFIG);
  }
  if (!workspaceStat.isDirectory()) {
    console.error(`[moss] workspace path is not a directory: ${workspace}`);
    console.error('Pass a directory with -C/--cd.');
    process.exit(ExitCode.CONFIG);
  }
  const model = resolvedConfig.model;
  const baseUrl = resolvedConfig.baseUrl;
  const workspacePathMigration = migrateLegacyWorkspacePaths(workspace);
  const runtimeDir = workspacePathMigration.paths.runtimeDir;

  const oneShotMessage = parsedArgs.prompt;

  // `--continue` on a bare `moss` auto-resumes the most recent session (parity
  // with `claude --continue`): treat it as a resume+useLast for session resolution.
  const continueLatest = parsedArgs.continueLast && parsedArgs.command === 'chat';
  // `moss resume` with no key/--last on a TTY opens the IN-TUI session picker
  // instead of the pre-TUI readline prompt: resolve a fresh session here and
  // let the shell's overlay do the choosing (A12.88).
  const interactiveTty =
    Boolean(process.stdout.isTTY) && process.env.MOSS_NO_TUI !== '1' && !parsedArgs.print;
  const resumeInteractive =
    parsedArgs.command === 'resume' &&
    parsedArgs.sessionKey === undefined &&
    !parsedArgs.continueLast &&
    interactiveTty;
  const sessionCommand: 'chat' | 'resume' | 'fork' =
    parsedArgs.command === 'resume' || parsedArgs.command === 'fork'
      ? resumeInteractive
        ? 'chat'
        : parsedArgs.command
      : continueLatest
        ? 'resume'
        : 'chat';

  // Diagnose `resume`/`fork` with no saved sessions BEFORE the model-config
  // gate: "needs a model configuration" was the wrong message for that case.
  // Reuse this store instance later (L489) instead of creating a second one.
  let earlySessionStore: JsonlSessionStore | undefined;
  if (parsedArgs.command === 'resume' || parsedArgs.command === 'fork') {
    earlySessionStore = new JsonlSessionStore({ dir: workspacePathMigration.paths.sessionsDir });
    const existing = await earlySessionStore.listSessions().catch(() => []);
    if (existing.length === 0) {
      console.error(
        `[session] No saved sessions to ${parsedArgs.command} in this workspace (${workspace}).`
      );
      console.error('[session] Start one with `moss`, then use `moss resume --last`.');
      process.exit(ExitCode.SESSION);
    }
  }

  if (!resolvedConfig.apiKey && !parsedArgs.mock) {
    const guidance = { bundledDefaultSuppressedBy: resolvedConfig.bundledDefaultSuppressedBy };
    let setupCompleted = false;
    if (process.stdin.isTTY && !oneShotMessage) {
      const setupStarted = await offerSetupForInteractiveMissingConfig(guidance);
      if (!setupStarted) return;
      const refreshed = loadCliConfigFile(process.env, process.argv.slice(2), configStartDir);
      resolvedConfig = resolveCliConfig(
        process.env,
        refreshed.config,
        parsedArgs.configOverrides,
        refreshed
      );
      if (!resolvedConfig.apiKey) {
        printMissingConfigGuidance(false, {
          bundledDefaultSuppressedBy: resolvedConfig.bundledDefaultSuppressedBy,
        });
        process.exit(ExitCode.CONFIG);
      }
      setupCompleted = true;
    }
    if (!setupCompleted) {
      // One-shot mode with no model configured: show a brief onboarding hint
      // (once), then the full config guidance.
      if (oneShotMessage && !hasShownOneShotOnboardingHint()) {
        console.error(renderOneShotOnboardingHint());
        markOneShotOnboardingShown();
        console.error('');
      }
      if (resolveCliDetailMode(argv) !== 'quiet') {
        printMissingConfigGuidance(false, guidance);
      } else {
        console.error(
          '[moss] No API key configured. Run `moss setup` to add one (model settings are config-only — env keys are ignored).'
        );
      }
      process.exit(ExitCode.CONFIG);
    }
  }

  if (parsedArgs.mock) {
    console.error('[mock] Offline mock mode — no live LLM, no API key required.');
    console.error('[mock] Tools and approval flows are available for testing.');
  }

  const configDir = resolveConfigDir();
  const providerConfig: CliProviderRuntimeConfig = { ...resolvedConfig };

  const sessionStore =
    earlySessionStore ?? new JsonlSessionStore({ dir: workspacePathMigration.paths.sessionsDir });
  const session = await resolveCliSession({
    command: sessionCommand,
    store: sessionStore,
    sessionKey: parsedArgs.sessionKey,
    useLast: parsedArgs.sessionLast || continueLatest,
    forkSource: parsedArgs.forkSource,
  });
  if (session.error) {
    console.error(`[session] ${session.error}`);
    console.error(
      '[session] List saved sessions with `moss sessions`, or start a new one with `moss`.'
    );
    process.exit(ExitCode.SESSION);
  }
  if (session.notice) console.error(`[session] ${session.notice}`);
  // Per-run context layers. The environment layer describes the workspace so
  // the agent does not have to discover it on the first turn; the runtime
  // capability and context-window layers are appended after tools are wired.
  const extraPromptLayers: string[] = [];
  const envLayer = await buildEnvironmentContextLayer(workspace);
  if (envLayer) extraPromptLayers.push(envLayer);
  // Project instructions: the workspace AGENTS.md, loaded once so the
  // "auto-loaded from workspace root" claim in help/onboarding is real.
  const agentsLayer = buildAgentsMdLayer(workspace);
  if (agentsLayer) extraPromptLayers.push(agentsLayer);
  // Answer language follows the user's locale (a recorded UX finding: Chinese
  // questions occasionally got English answers).
  const answerLanguageLayer = buildAnswerLanguageLayer();
  if (answerLanguageLayer) extraPromptLayers.push(answerLanguageLayer);

  const configuredHooks = createConfiguredHookCallbacks(loadedConfig.config.hooks, {
    workspaceDir: workspace,
  });
  // Lifecycle shell hooks (Stop / SubagentStop) fire from shared run paths
  // that have no access to this wiring — install them as the module runner.
  setLifecycleHookRunner({
    runStop: (info) => configuredHooks.runStop(info),
    runSubagentStop: (info) => configuredHooks.runSubagentStop(info),
    runNotification: (info) => configuredHooks.runNotification(info),
  });
  const compactHookRegistry = configuredHooks.buildCompactHookRegistry();
  // The live runtime object mutates in place as in-session commands run; the
  // approval hook closes over getters so it observes those changes live.
  const liveRuntime: CliRuntimeStatus = {};
  // v0.26 (T03) rule engine: startup rules come from the resolved
  // permissions block (allow/ask/deny lists — legacy trustedTools/deniedTools
  // already migrated into them at resolve time); the SESSION registry holds
  // /permissions add and 'a' grants. The live getter snapshots per tool call
  // so a new rule takes effect on the very next call (PRD W2 运行中生效).
  const permissionRuleRegistry = new PermissionRuleRegistry();
  const startupPermissionRules: PermissionRule[] = [
    ...resolvedConfig.permissions.allow.map((spec) =>
      parsePermissionRuleSpec(spec, 'user', 'allow')
    ),
    ...resolvedConfig.permissions.ask.map((spec) => parsePermissionRuleSpec(spec, 'user', 'ask')),
    ...resolvedConfig.permissions.deny.map((spec) => parsePermissionRuleSpec(spec, 'user', 'deny')),
  ];
  const permissionRuleSources = {
    userPath: path.join(configDir, 'config.json'),
    ...(resolvedConfig.projectConfigPath
      ? { workspacePath: resolvedConfig.projectConfigPath }
      : {}),
  };
  const livePermissionRules = (): ResolvedPermissionRules => ({
    rules: [...startupPermissionRules, ...permissionRuleRegistry.list()],
    sources: permissionRuleSources,
  });
  const deviceTarget = resolveDefaultDeviceTarget();
  const approvalHook = createCliToolApprovalHook(safetyMode, process.env, {
    approvalPolicy: resolvedConfig.approvalPolicy,
    trustedTools: resolvedConfig.trustedTools,
    deniedTools: resolvedConfig.deniedTools,
    workspaceDir: workspace,
    // "a" (don't ask again) persists to the user config only from a real
    // interactive terminal — piped/scripted answers stay session-scoped.
    persistTrust: process.stdin.isTTY === true,
    device: deviceTarget
      ? {
          host: deviceTarget.host,
          ...(deviceTarget.user ? { user: deviceTarget.user } : {}),
          ...(deviceTarget.port ? { port: deviceTarget.port } : {}),
        }
      : null,
    // v0.26: the /yolo fullPower bypass is retired — the interaction mode is
    // the single mode axis (mode=full derives full-access + never).
    interactionMode: () => getCliInteractionMode(),
    // v0.26 (T03): the live rule table + the startup read-only ceiling
    // (flags/env/migrated cautious all resolved into the config view).
    permissionRules: livePermissionRules,
    readOnlyCeiling: resolvedConfig.permissions.readOnlyCeiling,
    detailMode: resolveCliDetailMode(argv),
  });
  const configPreHook = configuredHooks.onBeforeToolExec;
  const onBeforeToolExec: AgentHooks['onBeforeToolExec'] = configPreHook
    ? async (req) => {
        const pre = await configPreHook(req);
        return pre.approved ? approvalHook(req) : pre;
      }
    : approvalHook;
  const hooks = createConfiguredGuardrailHooks(resolvedConfig, {
    onBeforeToolExec,
    onToolResult: configuredHooks.onToolResult,
  });

  const cliLlmProvider = parsedArgs.mock
    ? createMockLLMProvider()
    : createCliProvider(providerConfig);

  // v0.9 W3 run-budget guardrails: config agent.budget with env overrides —
  // the unattended/overnight ceiling (tokens / tool calls / turns / wall ms).
  const runBudget = resolvedConfig.budget;
  const hasRunBudget = Boolean(runBudget);
  const bestOfN = resolvedConfig.bestOfN;
  const reasoningBudget = resolvedConfig.reasoningBudget;
  const modelTiers = resolvedConfig.modelTiers;

  const agent = new MossAgent({
    llmProvider: cliLlmProvider,
    sessionStore,
    model,
    workspaceDir: workspace,
    // v0.9 W1: shell-write confinement. workspace-write/read-only confine
    // statically-extracted exec write targets to the workspace (same
    // boundary the file tools enforce); full-access leaves the shell
    // unconstrained by explicit host choice.
    ...(safetyMode === 'full-access' ? {} : { execWriteRoots: [workspace] }),
    ...(hasRunBudget ? { budget: runBudget } : {}),
    ...(bestOfN ? { bestOfN } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(modelTiers ? { modelTiers } : {}),
    ...(compactHookRegistry ? { compactHooks: compactHookRegistry } : {}),
    subagentStopHook: (info) => configuredHooks.runSubagentStop(info),
    // Keep the Moss persona, but name the actual model so the agent can answer
    // "which model are you?" honestly instead of substituting "Moss".
    baseSystemPrompt: resolveSoulIdentity({
      configDir,
      workspaceDir: workspace,
      model,
      usingBundledDefault: resolvedConfig.usingBundledDefault,
    }),
    enableToolOutputTruncation: true,
    extraPromptLayers,
    // Coding is the primary CLI workload. Inject the compact software-
    // engineering domain prompt into the stable system prompt so every coding
    // turn gets "read before edit → minimal verifiable change → close the loop".
    domainPrompt: () => buildSoftwareEngineeringPromptQuick(),
    ...resolveCliAgentRuntimeOptions(resolvedConfig),
    // Let a sub-agent's model override resolve the correct context window for
    // the overridden model (provider API probe -> name-pattern fallback), so
    // compaction/pruning inside the sub-agent uses the right window. Core
    // can't do provider probes, so the CLI injects this resolver.
    resolveModelContextTokens: (m: string) =>
      resolveContextTokensForModel({
        model: m,
        ...(resolvedConfig.baseUrl ? { baseUrl: resolvedConfig.baseUrl } : {}),
        ...(resolvedConfig.apiKey ? { apiKey: resolvedConfig.apiKey } : {}),
        ...(resolvedConfig.provider ? { provider: String(resolvedConfig.provider) } : {}),
        timeoutMs: 4000,
      })
        .then((r) => r.contextTokens)
        .catch(() => undefined),
    hooks,
  });
  await registerBuiltinTools(agent);
  // Device targets resolve host > env > .moss/devices.json (registered via
  // `moss device add`); declaring the workspace turns the registry tier on.
  configureDeviceWorkspace(workspace);
  // v0.16 MCP client: connect servers declared in `.moss/mcp.json` /
  // `<configDir>/mcp.json` (credentials only via ${ENV_VAR} expansion).
  // Zero-config = zero overhead (nothing spawns, nothing enters the prompt);
  // a failing server degrades to a warning and never blocks the CLI.
  let mcpRegistry: McpToolRegistry | null = null;
  const mcpConfigs = loadMcpConfigs(workspace, configDir, process.env, (warning) =>
    console.error(warning)
  );
  if (mcpConfigs.length > 0) {
    try {
      mcpRegistry = await McpToolRegistry.connectAll(mcpConfigs, {
        // Real MCP tools register on demand: the search meta-tool installs
        // them into the live registry when the model asks for a server's list.
        registerTool: (tool) => agent.tools.register(tool),
      });
      for (const searchTool of mcpRegistry.getTools()) agent.tools.register(searchTool);
      for (const status of mcpRegistry.getStatuses()) {
        if (status.state === 'failed') {
          console.error(
            `[mcp] server "${status.name}" unavailable: ${status.error} — its tools are disabled for this session.`
          );
        } else if (status.state === 'connected' && cliDetailForNotices !== 'quiet') {
          console.error(
            `[mcp] server "${status.name}" connected (${status.toolCount ?? 0} tools, lazy-loaded — search with mcp__${status.name.replace(/[^a-zA-Z0-9_-]/g, '_')}__search)`
          );
        }
      }
      // Lazy-loading budget: the system prompt gets one index line per server,
      // never the tool list itself.
      const mcpLayer = buildMcpPromptLayer(mcpRegistry);
      if (mcpLayer) extraPromptLayers.push(mcpLayer);
    } catch (err) {
      console.error(`[mcp] initialization failed: ${errorMessage(err)}`);
      mcpRegistry = null;
    }
  }
  // File-based custom tools from .moss/tools/*.tool.json — the lightweight
  // path for users who want a named, schema-validated tool without a host
  // extension module.
  for (const tool of loadFileBasedTools(workspace)) agent.tools.register(tool);
  // v0.16 skills: SKILL.md files from `.moss/skills/` (workspace) and
  // `<configDir>/skills/` (user). Progressive disclosure — only the index
  // enters the system prompt; bodies load through the readonly skill tool.
  // The count feeds the TUI's boot context line, and the TUI also gets the
  // skills themselves so they surface as first-class `/` commands.
  let loadedSkillCount = 0;
  let loadedSkills: Array<{ name: string; description: string }> = [];
  {
    const skills = loadSkills([
      path.join(workspace, '.moss', 'skills'),
      path.join(configDir, 'skills'),
    ]);
    loadedSkillCount = skills.length;
    loadedSkills = skills.map(({ name, description }) => ({ name, description }));
    if (skills.length > 0) {
      agent.tools.register(createSkillTool(skills));
      const layer = buildSkillsPromptLayer(skills);
      if (layer) extraPromptLayers.push(layer);
    } else {
      // With no skills installed the model used to shell out and scan other
      // tools' skill folders; anchor it to Moss's own directories instead.
      extraPromptLayers.push(
        buildEmptySkillsHintLayer([
          path.join(workspace, '.moss', 'skills'),
          path.join(configDir, 'skills'),
        ])
      );
    }
  }
  // Answers model-identity questions from the gateway and tracks later context-window probes.
  agent.tools.replace(
    createModelInfoTool({
      provider: () => agent.config.llmProvider,
      config: () => ({
        model: agent.config.model,
        baseUrl: liveRuntime.config?.baseUrl ?? providerConfig.baseUrl,
        usingBundledDefault:
          liveRuntime.config?.usingBundledDefault ?? providerConfig.usingBundledDefault,
      }),
      getContextTokens: () => agent.config.contextTokens,
      getMaxOutputTokens: () => agent.config.maxTokens,
    })
  );
  // Track the locale-derived region for web_search.
  const searchLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const searchRegion = /zh|_cn|-cn|\.cn/i.test(searchLocale) ? 'zh-CN' : undefined;
  // Region-aware re-registration: ToolRegistry.register is overwrite-by-name,
  // so the builtin web_search registered above is replaced by the localized one.
  if (searchRegion) {
    agent.tools.replace(createWebSearchTool({ region: searchRegion }));
  }
  // v0.16 net egress policy: `net.allowHosts` (config) plus
  // MOSS_NET_ALLOW_HOSTS (comma list, env) constrain web_fetch at request
  // time AND after redirects (the tool enforces both).
  {
    const envHosts = (process.env.MOSS_NET_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const allowHosts = [...(loadedConfig.config.net?.allowHosts ?? []), ...envHosts];
    if (allowHosts.length > 0) {
      agent.tools.replace(createWebFetchTool({ allowHosts }));
    }
  }
  try {
    // Startup context-window probe: if the user didn't explicitly set
    // contextTokens (source is 'unprobed'), ask the provider API.  On success
    // the value flows into the agent's compaction logic immediately.  On failure
    // (provider has no /v1/models, 401, network error, etc.) we keep the
    // unprobed 1M default; doctor will tell user to run /model for exact probe.
    // probe runs before the TUI starts so the first turn already has the correct
    // window — doctor and the status-bar will show it immediately.
    if (resolvedConfig.contextTokensSource === 'unprobed' && resolvedConfig.baseUrl) {
      try {
        const probed = await resolveContextTokensForModel({
          model: resolvedConfig.model,
          baseUrl: resolvedConfig.baseUrl,
          ...(resolvedConfig.apiKey ? { apiKey: resolvedConfig.apiKey } : {}),
          ...(resolvedConfig.provider ? { provider: String(resolvedConfig.provider) } : {}),
          timeoutMs: 4000,
        });
        if (probed.source === 'provider-api') {
          agent.config.contextTokens = probed.contextTokens;
          resolvedConfig.contextTokens = probed.contextTokens;
          (resolvedConfig as { contextTokensSource: string }).contextTokensSource = 'provider-api';
          // Also re-derive maxTokens from the freshly-probed context window,
          // but only if the user didn't pin agent.maxOutputTokens explicitly.
          if (resolvedConfig.maxOutputTokens === undefined) {
            const derived = deriveMaxOutputTokens(probed.contextTokens);
            if (derived) agent.config.maxTokens = derived;
          }
        }
      } catch {
        // Best-effort — keep unprobed default; doctor will surface this.
      }
    }

    await configuredHooks.runSessionStart();

    extraPromptLayers.push(
      buildRuntimeCapabilitiesPrompt({
        tools: agent.tools.getAll(),
      })
    );

    // If context window was probed (or configured), tell the LLM its actual size
    // so it can answer "how large is your context window?" accurately.  This layer
    // is pushed AFTER the startup probe (which may have updated contextTokens from
    // the unprobed 1M default to the probe value), so the LLM sees the truth.
    if (resolvedConfig.contextTokens) {
      const ctxK = Math.round(resolvedConfig.contextTokens / 1000);
      extraPromptLayers.push(
        `## Context Window\nYour context window is ${ctxK}k tokens. State this number accurately when the user asks about context size — do not guess from training knowledge.`
      );
    }

    // AgentReady table commands (moss task …) dispatch with the fully
    // initialized agent — the unified task runtime needs the real thing.
    if (commandConfig && requiredPhase === CliPhase.AgentReady) {
      await commandConfig.handler({
        argv,
        commandArgs: parsedArgs.commandArgs,
        configOverrides: parsedArgs.configOverrides,
        resolvedConfig,
        workspace,
        agent,
        sessionStore,
        sessionKey: session.sessionKey,
        liveRuntime,
        configDir,
        // Capability discovery selects MCP tools per task and reveals exactly
        // those; without this port it could only name servers to search.
        mcp: mcpRegistry
          ? {
              catalog: () =>
                mcpRegistry.getCatalog().map((entry) => ({
                  name: entry.wireName,
                  description: entry.description,
                })),
              reveal: (wireNames: readonly string[]) => mcpRegistry?.revealTools(wireNames) ?? [],
            }
          : undefined,
      });
      return;
    }

    if (oneShotMessage) {
      // Slash-command dispatch in oneshot mode. Previously a prompt like
      // `moss "/review"` or `moss "/skills"` was sent verbatim to the LLM,
      // which either hallucinated a command table or cascaded into a failed
      // tool loop — because oneshot skipped the TUI/REPL command dispatcher.
      // Now: if the prompt starts with `/`, try the registry first. Commands
      // that produce a review/analysis prompt (e.g. /review) call submitPrompt
      // and we run THAT prompt through runOneShot. Commands that handle
      // themselves (e.g. /help, /skills printing) just print and exit. An
      // unknown `/foo` gets a did-you-mean hint instead of burning an LLM call.
      if (oneShotMessage.trimStart().startsWith('/')) {
        let pendingPrompt: string | null = null;
        const oneshotCmdCtx: RegistryCommandContext = {
          agent,
          runtime: liveRuntime,
          sessionKey: session.sessionKey,
          workspace,
          locale: cliLocale(),
          surface: 'repl',
          say: (_kind, text) => console.error(text),
          prefillInput: () => {},
          submitPrompt: (text) => {
            pendingPrompt = text;
          },
        };
        const handled = await runRegistryCommand(oneShotMessage.trim(), oneshotCmdCtx);
        if (handled) {
          if (pendingPrompt) {
            // The command (e.g. /review) gathered context and built a prompt
            // for the agent — run it as the oneshot.
            await runOneShotWithCliCancellation(agent, pendingPrompt, {
              sessionKey: session.sessionKey,
              outputFormat: parsedArgs.print ? parsedArgs.outputFormat : 'text',
              headless: parsedArgs.print || parsedArgs.maxTurns !== undefined,
              cwd: workspace,
            });
          }
          return;
        }
        // Unknown slash command — don't send it to the LLM (it would
        // hallucinate or fail). Distinguish two cases:
        //  (a) the command IS a known interactive command (e.g. /help, /skills,
        //      /model, /compact) that the registry doesn't serve in oneshot —
        //      tell the user to run `moss` interactively;
        //  (b) genuinely unknown — give a did-you-mean hint.
        const cmdToken = oneShotMessage.trim().split(/\s+/, 1)[0] ?? oneShotMessage.trim();
        const isKnownInteractive = KNOWN_COMMANDS.includes(cmdToken);
        if (isKnownInteractive) {
          console.error(
            `${cmdToken} is an interactive-mode command and isn't run from a one-shot prompt.\n` +
              `Start an interactive session with \`moss\` (then type ${cmdToken}), or rephrase as a natural-language prompt (e.g. \`moss "review auth.js for bugs"\`).`
          );
        } else {
          for (const line of unknownSlashCommandLines(oneShotMessage.trim(), {
            suggestion: commandSuggestion(oneShotMessage.trim()),
            locale: cliLocale(),
          })) {
            console.error(line);
          }
        }
        process.exitCode = ExitCode.USAGE;
        return;
      }

      // Bare single-word chat prompts (e.g. `moss nonono`, `moss hello`) are
      // valid but ambiguous — a brief notice makes the user aware they're about
      // to be billed for an LLM call. Suppressed in quiet mode for scripting.
      if (cliDetailForNotices !== 'quiet' && !oneShotMessage.includes(' ')) {
        console.error(`[moss] sending "${oneShotMessage}" to the model...`);
      }
      await runOneShotWithCliCancellation(agent, oneShotMessage, {
        sessionKey: session.sessionKey,
        ...(process.env.MOSS_RUN_ID ? { runId: process.env.MOSS_RUN_ID } : {}),
        outputFormat: parsedArgs.print ? parsedArgs.outputFormat : 'text',
        headless: parsedArgs.print || parsedArgs.maxTurns !== undefined,
        cwd: workspace,
      });
      return;
    }

    if (!process.stdin.isTTY) {
      let piped = '';
      // Cap piped stdin at 10 MB to prevent OOM from a misbehaving upstream
      // pipe (e.g. `cat huge.log | moss` would otherwise buffer the whole file
      // in memory before any LLM call). 10 MB is far above any reasonable
      // prompt (a 200k-token context window is ~800 KB of text); exceeding it
      // means the caller is doing something moss isn't designed for — surface
      // a clear error instead of silently swapping to death.
      //
      // `MOSS_TEST_PIPED_STDIN_CAP` overrides the cap for tests (so a spec can
      // verify the guard fires without producing a 10 MB stream). Production
      // callers never set it.
      const configuredCap = Number(process.env.MOSS_TEST_PIPED_STDIN_CAP);
      const MAX_PIPED_STDIN_BYTES =
        Number.isFinite(configuredCap) && configuredCap > 0
          ? Math.floor(configuredCap)
          : 10 * 1024 * 1024;
      for await (const chunk of process.stdin) {
        piped += chunk;
        if (Buffer.byteLength(piped, 'utf8') > MAX_PIPED_STDIN_BYTES) {
          console.error(
            `[moss] piped stdin exceeds ${MAX_PIPED_STDIN_BYTES} bytes — truncate your input,` +
              ` attach it as a file with @<path>, or pass the relevant excerpt. moss refuses to` +
              ` buffer an unbounded stream into memory.`
          );
          process.exitCode = ExitCode.USAGE;
          return;
        }
      }
      if (piped.trim()) {
        const pipedText = piped.trim();
        // Slash-command dispatch for piped stdin — sibling fix to the oneshot
        // mode dispatch (b76a7ef). `echo "/review" | moss` previously sent the
        // slash verbatim to the LLM (hallucinated command table). Now piped
        // slash-commands go through the registry first.
        if (pipedText.startsWith('/')) {
          let pendingPrompt: string | null = null;
          const pipedCmdCtx: RegistryCommandContext = {
            agent,
            runtime: liveRuntime,
            sessionKey: session.sessionKey,
            workspace,
            locale: cliLocale(),
            surface: 'repl',
            say: (_kind, text) => console.error(text),
            prefillInput: () => {},
            submitPrompt: (text) => {
              pendingPrompt = text;
            },
          };
          const handled = await runRegistryCommand(pipedText, pipedCmdCtx);
          if (handled) {
            if (pendingPrompt) {
              await runOneShotWithCliCancellation(agent, pendingPrompt, {
                sessionKey: session.sessionKey,
                outputFormat: parsedArgs.print ? parsedArgs.outputFormat : 'text',
                headless: parsedArgs.print || parsedArgs.maxTurns !== undefined,
                cwd: workspace,
              });
            }
            return;
          }
          const cmdToken = pipedText.split(/\s+/, 1)[0] ?? pipedText;
          if (KNOWN_COMMANDS.includes(cmdToken)) {
            console.error(
              `${cmdToken} is an interactive-mode command — pipe a natural-language prompt instead,` +
                ` or run \`moss\` interactively and type ${cmdToken}.`
            );
          } else {
            for (const line of unknownSlashCommandLines(pipedText, {
              suggestion: commandSuggestion(pipedText),
              locale: cliLocale(),
            })) {
              console.error(line);
            }
          }
          process.exitCode = ExitCode.USAGE;
          return;
        }
        await runOneShotWithCliCancellation(agent, pipedText, {
          sessionKey: session.sessionKey,
          outputFormat: parsedArgs.print ? parsedArgs.outputFormat : 'text',
          headless: parsedArgs.print || parsedArgs.maxTurns !== undefined,
          cwd: workspace,
        });
      }
      // Piped stdin was empty/whitespace-only. If the user explicitly asked
      // for --print (or --max-turns), surface a clear "needs input" error
      // instead of silently succeeding — silent exit on `echo "" | moss --print`
      // looks like a successful empty result and hides the user's mistake.
      if (parsedArgs.print || parsedArgs.maxTurns !== undefined) {
        console.error('[moss] --print requires a prompt argument or non-empty piped stdin');
        process.exitCode = ExitCode.USAGE;
      }
      return;
    }
    if (parsedArgs.print) {
      console.error('[moss] --print requires a prompt argument or piped stdin');
      process.exitCode = ExitCode.USAGE;
      return;
    }
    // Publish the resolved runtime for in-session commands and the renderer.
    Object.assign(liveRuntime, {
      workspace,
      runtimeDir,
      configDir,
      baseUrl,
      execBackend: process.env.MOSS_EXEC_BACKEND || 'local',
      safetyMode,
      sessionKey: session.sessionKey,
      config: resolvedConfig,
      // v0.26 (T03): live rule table + the session registry (consumed by
      // /permissions from T04 and by 'a' grants through the hook's getter).
      permissionsRules: livePermissionRules,
      permissionRuleRegistry,
    });
    // v0.17: interactive TTY sessions get the full-screen TUI (ink); non-TTY
    // pipes and MOSS_NO_TUI=1 keep the readline REPL. The TUI is dynamically
    // imported so headless/SDK paths never load ink/react.
    const useTui =
      Boolean(process.stdout.isTTY) && process.env.MOSS_NO_TUI !== '1' && !parsedArgs.print;
    if (useTui) {
      const { runTuiApp } = await import('./cli/tui/app.js');
      const { FileCheckpointStore, checkpointTargetPaths } =
        await import('./cli/file-checkpoint.js');
      const runtimeDirForTui = runtimeDir ?? path.join(workspace, '.moss', 'runtime');
      const checkpointStore = new FileCheckpointStore({
        runtimeDir: runtimeDirForTui,
        sessionKey: session.sessionKey,
      });
      const parsePatchPaths = (patch: string): string[] => {
        const out: string[] = [];
        for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
          out.push(m[1].trim());
        return out;
      };
      agent.registerPreToolHook({
        name: 'tui-checkpoint',
        priority: 5,
        async check({ tool, input }) {
          for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
            checkpointStore.trackBeforeWrite(p);
          }
          return null;
        },
      });
      agent.registerPostToolHook({
        name: 'tui-checkpoint-after',
        priority: 5,
        async process({ tool, input }) {
          for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
            checkpointStore.noteAfterWrite(p);
          }
          return null;
        },
      });
      // Resuming must SHOW the conversation: the replay builder exists but was
      // never wired here, so a resumed session booted blank (D2 in the parity
      // baseline audit).
      let replayRows: Array<{ kind: 'user' | 'assistant' | 'system'; text: string }> | undefined;
      if (sessionCommand !== 'chat') {
        try {
          const replay = buildResumeReplay(await sessionStore.loadMessages(session.sessionKey));
          if (replay.items.length > 0) replayRows = replay.items;
        } catch {
          // A missing/unreadable session store must not block the shell.
        }
      }
      await runTuiApp({
        agent,
        workspaceDir: workspace,
        sessionKey: session.sessionKey,
        model: typeof model === 'string' ? model : undefined,
        // Part B: hand the shell the resolved locale explicitly instead of
        // letting every component re-read the environment.
        locale: cliLocale(),
        cliRuntime: liveRuntime,
        contextInfo: {
          skills: loadedSkillCount,
          mcp: mcpRegistry
            ? {
                connected: mcpRegistry.getStatuses().filter((s) => s.state === 'connected').length,
                total: mcpRegistry.getStatuses().length,
              }
            : undefined,
          soul: (() => {
            const soul = resolveSoul({ workspaceDir: workspace, configDir });
            return soul.source === 'default' ? undefined : soul.id;
          })(),
          branch: (await getGitBranch(workspace)) ?? undefined,
        },
        ...(loadedSkills.length > 0 ? { skills: loadedSkills } : {}),
        ...(resumeInteractive ? { resumePicker: true } : {}),
        ...(replayRows ? { replayRows } : {}),
        // The checkpoint is what `/rewind` restores from; without this call the
        // store records nothing and every rewind silently did nothing (D1).
        onTurnStart: (message) => checkpointStore.open(message.slice(0, 60)),
        listSessions: async () => {
          const metas = await sessionStore.listSessions().catch(() => []);
          return metas
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, 15)
            .map((m) => ({
              key: m.sessionKey,
              ...(m.title ? { title: m.title } : {}),
              ...(m.messageCount !== undefined ? { messageCount: m.messageCount } : {}),
              ...(m.updatedAt !== undefined ? { updatedAt: m.updatedAt } : {}),
              current: m.sessionKey === session.sessionKey,
            }));
        },
        mcpServers: mcpRegistry
          ? mcpRegistry.getStatuses().map((s) => ({
              name: s.name,
              state: s.state,
              ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
              ...(s.error ? { error: s.error } : {}),
            }))
          : [],
        listCheckpoints: () =>
          checkpointStore.list().map((cp) => ({
            seq: cp.seq,
            label: cp.label,
            files: cp.fileCount,
          })),
        rewindTo: (seq) => {
          try {
            const result = checkpointStore.rewindTo(seq);
            if (!result.found) return { ok: false, detail: `no checkpoint ${seq}` };
            const skipped = result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : '';
            return {
              ok: true,
              detail: `${result.restored.length} file(s) restored${skipped}`,
            };
          } catch (err) {
            return { ok: false, detail: errorMessage(err) };
          }
        },
      });
    } else {
      await runInteractive(agent, liveRuntime, {
        sessionKey: session.sessionKey,
        ...(loadedSkills.length > 0 ? { skills: loadedSkills } : {}),
      });
    }
  } finally {
    try {
      await agent.close();
      await disconnectAllDevices();
    } finally {
      // Shut MCP server connections (stdio children) down after the agent is
      // done — closeAll absorbs per-server errors internally.
      await mcpRegistry?.closeAll();
      // SessionEnd lifecycle hook: fires exactly once at CLI shutdown.
      try {
        await configuredHooks.runSessionEnd({ reason: 'cli_shutdown' });
      } catch {
        /* shutdown hooks never block exit */
      }
    }
  }
}

main().catch((err) => {
  // Config file errors already carry a clean, actionable one-liner — show it
  // alone instead of a raw Node stack. A malformed/hand-edited config.json
  // (parse error → CliConfigFileError) is just as likely as a write failure,
  // so both get the same friendly treatment on every entry point.
  if (err instanceof CliConfigWriteError || err instanceof CliConfigFileError) {
    console.error(`[moss] ${err.message}`);
    process.exit(ExitCode.CONFIG);
  }

  const code = exitCodeForError(err);
  const message = errorMessage(err);

  // Provider-level errors: print a clean, actionable diagnostic — never claim
  // it's a bug. Auth failures, rate limits, network timeouts, and context
  // overflows are external conditions, not code defects.
  if (code === ExitCode.PROVIDER_AUTH) {
    console.error(`[moss] Authentication failed: ${message}`);
    console.error('[moss] Check your API key with `moss config show`, or re-run `moss setup`.');
    process.exit(code);
  }
  if (code === ExitCode.RATE_LIMIT) {
    console.error(`[moss] Rate limited: ${message}`);
    console.error(
      '[moss] Wait a moment and try again. Consider setting a lower model or reducing prompt size.'
    );
    process.exit(code);
  }
  if (code === ExitCode.PROVIDER_UPSTREAM) {
    console.error(`[moss] Provider error: ${message}`);
    console.error(
      '[moss] The upstream API returned an error. Check your network, base URL, and model name.'
    );
    process.exit(code);
  }
  if (code === ExitCode.CONFIG) {
    console.error(`[moss] Configuration error: ${message}`);
    console.error(
      '[moss] Run `moss config show` to inspect settings, or `moss setup` to reconfigure.'
    );
    process.exit(code);
  }

  // Session errors: the user's session data is the problem, not the code.
  if (code === ExitCode.SESSION) {
    console.error(`[moss] Session error: ${message}`);
    console.error(
      '[moss] List saved sessions with `moss sessions`, or start a new one with `moss`.'
    );
    process.exit(code);
  }

  // User aborted: they hit Ctrl+C or cancelled — not a bug.
  if (code === ExitCode.USER_ABORTED) {
    console.error(`[moss] Cancelled: ${message || 'operation was interrupted'}`);
    process.exit(code);
  }

  // For unexpected / internal errors, show the bug-report notice.
  console.error(`[moss] ${message}`);
  console.error('');
  console.error('This looks like a bug. Please help us fix it:');
  console.error('  1. Run `moss doctor` to check your environment');
  console.error(
    '  2. If the problem persists, report it to the Moss maintainers with the details below.'
  );
  if (err instanceof Error && err.stack) {
    console.error('');
    console.error('Technical details (for bug reports):');
    console.error(err.stack);
  }
  process.exit(code);
});
