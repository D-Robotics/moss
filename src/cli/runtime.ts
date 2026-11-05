/**
 * Startup context-window probe ceiling.
 *
 * Headless `-p` waits for this probe before its first turn (the compaction
 * budget uses the window), so its timeout is user-visible dead time: a slow or
 * hung `/v1/models` used to stall the run for the full 4s before anything
 * happened. 1.5s keeps a healthy endpoint (tens of ms) unaffected, still gives
 * a slow-but-alive one a real chance, and bounds the stall; a timeout keeps the
 * conservative unprobed window, which is exactly what a failed probe yields
 * anyway (doctor surfaces it).
 */
const STARTUP_CONTEXT_PROBE_TIMEOUT_MS = 1_500;

/**
 * CLI runtime: everything one `moss` process wires up.
 *
 * `cli-main.ts` used to be both the entry point and the 1,600-line `main()`. The
 * W5 architecture rule is that the host shell is a thin entry and the runtime is
 * one module the surfaces share. This file is the runtime half of that split;
 * `cli-main.ts` is the entry (load-time guards live in `cli.ts`).
 *
 * The module still runs its own load-time setup on import (argument parsing,
 * UI language, warning filter) because the CLI contract is that a bad flag fails
 * before any work starts. That setup moves to `cli/bootstrap.ts` in W5c.
 */
// Moss Agent CLI main — see --help for usage, config, and environment variables.

import {
  ensureKeepAliveDispatcherInstalled,
  hasProxyConfigured,
} from '../provider/keep-alive-dispatcher.js';
import { resolveHostShell } from '../utils/host-shell.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureWindowsUtf8Console } from '../utils/run-process.js';
import { errorMessage } from '../errors.js';
import { noteKnownSecret } from '../safety/known-secrets.js';
import { buildResumeReplay } from './resume-replay.js';
import { exitCodeForError, ExitCode } from './exit-codes.js';
import { createStartupTiming } from './startup-timing.js';
import { resolveCliAgentRuntimeOptions, deriveMaxOutputTokens } from './agent-runtime.js';
import {
  createCliToolApprovalHook,
  getCliInteractionMode,
  resolveCliSafetyMode,
  setCliInteractionMode,
  type CliInteractionMode,
} from './approval.js';
import { createCliPromptSetup } from './prompt-setup.js';
import { collectSlashNamespace, formatSlashConflict } from './slash-namespace.js';
import { promptLayersDebugEnabled } from '../core/prompt/index.js';
import {
  CliConfigFileError,
  CliConfigWriteError,
  envBeforeDotenv,
  loadCliConfigFile,
  loadEnvFromAncestors,
  resolveCliConfig,
  resolveConfigDir,
  safeProcessCwd,
  shouldShowFullDefaultNotice,
  shouldShowUntrustedFolderNotice,
} from './config.js';
import { shouldOpenResumePicker } from './args.js';
import {
  PermissionRuleRegistry,
  parsePermissionRuleSpec,
  unmatchedRuleToolNames,
  type PermissionRule,
  type ResolvedPermissionRules,
} from './permission-rules.js';
import { createConfiguredGuardrailHooks } from './guardrails.js';
import { mossConfigDirs } from './protected-path-prompt.js';
import {
  createConfiguredHookCallbacks,
  formatUserPromptHookContext,
  setLifecycleHookRunner,
} from './hooks.js';
import { composePreToolUseGate } from './hook-ask.js';
import { hookEventZhName } from './hook-event-names.js';
import {
  ancestorRoutingIgnoredLine,
  resolveProjectCapabilities,
  summarizeTrustItems,
  untrustedFolderLine,
} from './workspace-trust.js';
import { deliverDotenvSafetyEnvNotices } from './safety-env-notice.js';
import { runWithApprovalRequest, setPermissionRequestRunner } from './permission-request.js';
import { resolveSoulIdentity, resolveSoul } from './soul.js';
import type { AgentHooks } from '../core/agent/agent-hooks.js';
import { createCliProvider } from './providers.js';
import type { CliProviderRuntimeConfig } from './providers.js';
import {
  formatModelChoices,
  loadModelChoicesForRuntime,
  resolveContextTokensForModel,
} from './model-catalog.js';
import { createModelInfoTool } from './model-info-tool.js';
import { runOneShotWithCliCancellation } from './run-cancellation.js';
import { armExitGuard } from './exit-guard.js';
import {
  stopAllBackgroundProcesses,
  waitForBackgroundProcesses,
} from '../core/tools/background-process-registry.js';

import { resolveCliSession } from './session.js';
import {
  hasShownOneShotOnboardingHint,
  markOneShotOnboardingShown,
  offerSetupForInteractiveMissingConfig,
  formatUnsetApiKeyEnv,
  printMissingConfigGuidance,
  renderOneShotOnboardingHint,
} from './onboarding-hints.js';
import { MossAgent } from '../core/agent/moss-agent.js';
import { JsonlSessionStore } from '../core/session/jsonl-session-store.js';
import { registerFileBasedTools } from '../tools/file-based-tools.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { loadMcpConfigs } from './mcp-config.js';
import {
  formatMcpStartupLine,
  formatMcpStatusLine,
  rdkDocsAutoConnectEnabled,
  readRdkDocsFlag,
  resolveRdkDocsPackage,
  shouldEagerWarmRdkDocs,
  withBuiltinRdkDocs,
} from './rdk-docs-mcp.js';
import { McpToolRegistry, buildMcpStableIndex } from '../core/mcp/registry.js';
import { RDK_DOCS_SERVER_NAME, rdkDocsKnowledgeLayer } from '../core/mcp/rdk-docs.js';
import { CONFIGURED_DEVICE_PROMPT } from '../device/device-probe-prompt.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { createWebFetchTool } from '../tools/web-fetch.js';
import {
  loadSkillCatalog,
  selectActiveSkills,
  skillSlashName,
  buildEmptySkillsHintLayer,
} from '../core/skills/skill-registry.js';
import { renderSkillCatalog } from '../core/skills/skill-catalog.js';
import { loadSkillUsage } from '../core/skills/skill-usage.js';
import { includeBundledRdkDocsSkill } from '../core/skills/rdk-docs-skill.js';
import {
  adoptFileAgents,
  formatFileAgentReport,
  loadAgentFiles,
} from '../core/subagent/agent-file-loader.js';

import type { CommandContext as RegistryCommandContext } from './commands/registry.js';

/** The slash-command graph is interactive-only; `-p` runs must not pay for it. */
async function registryCommandModule() {
  return import('./commands/registry.js');
}
import { cliLocale } from './cli-locale.js';
import {
  DISPATCHABLE_SLASH_COMMANDS,
  INTERACTIVE_COMPLETION_COMMANDS as KNOWN_COMMANDS,
} from './interactive-commands.js';
import { closestSlashCommands } from './command-completion.js';
import {
  isLoadedSkillSlash,
  isSlashCommandInput,
  loadCustomCommands,
  reservedBuiltinNames,
  skillSlashToken,
} from './commands/custom-commands.js';
import { announceCatalogSkip } from './catalog-skip-notice.js';
import {
  formatFullModeNotice,
  formatHostShellFallbackNotice,
  formatInteractionModeNotice,
  isZhLocale,
  uiText,
} from './cli-locale.js';
import { chrome, setTuiLocale } from './tui/copy.js';
import { gitignoreNoticeForWorkspace } from './gitignore-suggestion.js';
import { getGitBranch } from '../context/environment.js';
import {
  configureDeviceWorkspace,
  projectDeviceHostWithholdsPassword,
  resolveDefaultDeviceTarget,
} from '../device/device-target.js';
import { buildRuntimeCapabilitiesPrompt } from '../context/runtime-capabilities.js';
import { getEffectiveContextWindowTokens } from '../context/window-economics.js';
import { resolveModelOutputBudget } from '../core/loop/output-limit.js';
import { tinyWindowToolSurfaceEnabled } from '../core/tools/tiny-window-tools.js';
import { buildSoftwareEngineeringPromptQuick } from '../contracts/prompts/software-engineering-prompt.js';
import type { CliRuntimeStatus } from './onboarding.js';
import { resolveCliDetailMode } from './output.js';
import {
  CliPhase,
  getPhaseForCommand,
  isUnimplementedCommand,
  getCommandConfig,
  type CommandContext,
} from './command-dispatcher.js';

import {
  argv,
  createMockLLMProvider,
  loadTrustedStartupConfig,
  migrateWorkspacePaths,
  mossLine,
  parsedArgs,
  printWrappedNotice,
  resolveCliLogLevel,
  WorkspacePathPermissionError,
} from './bootstrap.js';

export async function runCli(): Promise<void> {
  const startupTiming = createStartupTiming();
  // O83: a configured proxy must be in place before ANY request — setup probe,
  // model list, doctor, MCP over HTTP — not only when the agent loop starts.
  // B18: without a proxy the install can wait for the first real request
  // (`fetchWithConnectionContext` installs it there), which keeps undici's 110
  // modules and its dispatcher setup off the path to the composer.
  if (hasProxyConfigured()) await ensureKeepAliveDispatcherInstalled();
  startupTiming.mark('proxy');
  // REPL, one-shot, and the cancel line share the TUI dictionary. The full-screen
  // shell sets the same flag again from its own entry.
  setTuiLocale(isZhLocale());
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

  // B12: ink/react is the single largest import in the shell (~300 ms cold).
  // Load it while config/agent/skills work runs instead of after it, so the
  // composer paints sooner. Only for interactive chat where the TUI will mount;
  // `--version`/`--help`/print paths never pay for it.
  // The builtin tool implementations are another large graph that only the
  // agent-using paths need; start loading it alongside the rest of startup so
  // it is off the synchronous entry path and hidden behind config work.
  const needsAgent =
    (parsedArgs.command === undefined || parsedArgs.command === 'chat') && !parsedArgs.print;
  const builtinToolsPromise = needsAgent ? import('../tools/builtin.js') : undefined;
  const tuiBootWanted =
    Boolean(process.stdout.isTTY) &&
    process.env.MOSS_NO_TUI !== '1' &&
    !parsedArgs.print &&
    // Only the interactive chat shell mounts the TUI; other subcommands must not
    // pay for ink just because stdout is a TTY.
    (parsedArgs.command === undefined || parsedArgs.command === 'chat');
  const tuiBootPromise = tuiBootWanted ? import('./tui/app.js') : undefined;

  // Determine the initialization phase needed for this command
  const requiredPhase =
    parsedArgs.command === 'superagent' && parsedArgs.commandArgs[0] === 'worker'
      ? CliPhase.AgentReady
      : getPhaseForCommand(parsedArgs.command);
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
    deliverDotenvSafetyEnvNotices(false, () => {});
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
    const startup = await loadTrustedStartupConfig({
      startDir: fallbackStartDir,
      argv: process.argv.slice(2),
      trustFlag: parsedArgs.trustWorkspace,
      prompt: false,
    });
    const loadedConfig = startup.loadedConfig;
    const resolvedConfig = resolveCliConfig(
      process.env,
      loadedConfig.config,
      parsedArgs.configOverrides,
      loadedConfig
    );

    deliverDotenvSafetyEnvNotices(false, () => {});
    const ctx: CommandContext = {
      argv,
      commandArgs: parsedArgs.commandArgs,
      configOverrides: parsedArgs.configOverrides,
      fallbackStartDir,
      loadedConfig,
      resolvedConfig,
      workspacePathMigration: migrateWorkspacePaths(resolvedConfig.workspace as string),
    };
    await commandConfig.handler(ctx);
    return;
  }

  // CliPhase.WorkspaceReady: validate workspace and dispatch
  if (requiredPhase === CliPhase.WorkspaceReady && commandConfig) {
    if (parsedArgs.configOverrides.workspace) {
      loadEnvFromAncestors(parsedArgs.configOverrides.workspace as string);
    }
    const startup = await loadTrustedStartupConfig({
      startDir: fallbackStartDir,
      argv: process.argv.slice(2),
      trustFlag: parsedArgs.trustWorkspace,
      prompt: false,
    });
    const loadedConfig = startup.loadedConfig;
    const resolvedConfig = resolveCliConfig(
      process.env,
      loadedConfig.config,
      parsedArgs.configOverrides,
      loadedConfig
    );
    noteKnownSecret(resolvedConfig.apiKey);
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

    deliverDotenvSafetyEnvNotices(false, () => {});
    const ctx: CommandContext = {
      argv,
      commandArgs: parsedArgs.commandArgs,
      configOverrides: parsedArgs.configOverrides,
      fallbackStartDir,
      loadedConfig,
      resolvedConfig,
      workspace,
      workspaceStat,
      workspacePathMigration: migrateWorkspacePaths(workspace),
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
  const startup = await loadTrustedStartupConfig({
    startDir: configStartDir,
    argv: process.argv.slice(2),
    trustFlag: parsedArgs.trustWorkspace,
    prompt: process.stdin.isTTY === true && !parsedArgs.print,
  });
  const loadedConfig = startup.loadedConfig;
  let resolvedConfig = resolveCliConfig(
    process.env,
    loadedConfig.config,
    parsedArgs.configOverrides,
    loadedConfig
  );
  // A named apiKeyEnv that is unset must not fall through to a stored key,
  // an official provider key, or the setup wizard (including on a TTY).
  if (resolvedConfig.apiKeyEnvUnset && resolvedConfig.apiKeyEnv) {
    console.error(formatUnsetApiKeyEnv(resolvedConfig.apiKeyEnv));
    process.exit(ExitCode.CONFIG);
  }
  startupTiming.mark('config');
  if (loadedConfig.blockedProjectBaseUrl) {
    console.error(
      chrome(
        '[moss] Project base URL {url} needs its own apiKey. The primary key is not sent to that host.',
        isZhLocale(),
        { url: loadedConfig.blockedProjectBaseUrl }
      )
    );
    process.exit(ExitCode.CONFIG);
  }
  if (resolvedConfig.envProviderCandidates && resolvedConfig.envProviderCandidates.length > 1) {
    console.error(
      mossLine('[moss] Multiple provider keys are set: {names}.', {
        names: resolvedConfig.envProviderCandidates.join(', '),
      })
    );
    console.error(mossLine('[moss] Pass --provider <name> to choose one.'));
    process.exit(ExitCode.CONFIG);
  }
  if (resolvedConfig.autoEnvNotice) console.error(resolvedConfig.autoEnvNotice);
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
    const ignored = resolvedConfig.ignoredModelEnvVars.join(', ');
    console.error(
      mossLine(
        '[config] not reading {names}. Fix: `moss config set provider <name>` (these MOSS_* variables are not read). using {provider} / {model}.',
        { names: ignored, provider: resolvedConfig.provider, model: resolvedConfig.model }
      )
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
  }
  // O72: the resolved mode is printed on every start (stderr), including -p
  // and --quiet, so a user can always tell whether Moss will ask first.
  console.error(formatInteractionModeNotice(parsedArgs.interactionModeOverride ?? startupMode));
  // O153: a cmd.exe fallback for exec is never silent (`;` is not a separator there).
  if (process.platform === 'win32') {
    const shellNotice = formatHostShellFallbackNotice(resolveHostShell().kind);
    if (shellNotice) console.error(shellNotice);
  }
  // Once per config dir. Doctor still reports the condition on every run.
  if (cliDetailForNotices !== 'quiet' && shouldShowFullDefaultNotice(resolvedConfig)) {
    printWrappedNotice(formatFullModeNotice());
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
  if (cliDetailForNotices !== 'quiet') {
    const gitignoreNotice = gitignoreNoticeForWorkspace(workspace);
    if (gitignoreNotice) console.error(gitignoreNotice);
  }
  // Refreshed after the setup wizard. A const here used to freeze the preset
  // default, so the first question ignored the model the wizard had just saved.
  let model = resolvedConfig.model;
  let baseUrl = resolvedConfig.baseUrl;
  const workspacePathMigration = migrateWorkspacePaths(workspace);
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
  const resumeInteractive = shouldOpenResumePicker({
    command: parsedArgs.command,
    sessionKey: parsedArgs.sessionKey,
    sessionLast: parsedArgs.sessionLast,
    continueLast: parsedArgs.continueLast,
    print: parsedArgs.print,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    noTui: process.env.MOSS_NO_TUI === '1',
  });
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
        uiText(
          `[session] No saved sessions to ${parsedArgs.command} in this workspace (${workspace}).`,
          `[会话] 此工作区没有可${parsedArgs.command === 'fork' ? '分叉' : '恢复'}的已保存会话（${workspace}）。`
        )
      );
      console.error(
        uiText(
          '[session] Start one with `moss`, then use `moss resume --last`.',
          '[会话] 先运行 `moss` 开始会话，再用 `moss resume --last`。'
        )
      );
      process.exit(ExitCode.SESSION);
    }
  }

  if (oneShotMessage.trim() === '/model') {
    const choices = await loadModelChoicesForRuntime(resolvedConfig, resolvedConfig.model ?? '');
    console.error(formatModelChoices(choices));
    return;
  }

  let inlineFirstRun = false;
  if (!resolvedConfig.apiKey && !parsedArgs.mock) {
    const guidance = { bundledDefaultSuppressedBy: resolvedConfig.bundledDefaultSuppressedBy };
    let setupCompleted = false;
    const inlineSetup = interactiveTty && Boolean(process.stdin.isTTY) && !oneShotMessage;
    if (inlineSetup) {
      // The TUI owns setup. Do not print "run moss setup" and exit.
      inlineFirstRun = true;
      setupCompleted = true;
    } else if (process.stdin.isTTY && !oneShotMessage) {
      const setupStarted = await offerSetupForInteractiveMissingConfig(guidance);
      if (!setupStarted) return;
      const refreshed = loadCliConfigFile(process.env, process.argv.slice(2), configStartDir, {
        trustProjectRouting: startup.trusted,
      });
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
      model = resolvedConfig.model;
      baseUrl = resolvedConfig.baseUrl;
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
          mossLine(
            '[moss] No API key configured. Run `moss` to set one up (a key already in the environment is offered there; the value is not printed).'
          )
        );
      }
      process.exit(ExitCode.CONFIG);
    }
  }

  if (parsedArgs.mock) {
    console.error(
      uiText(
        '[mock] Offline mock mode — no live LLM, no API key required.',
        '[mock] 离线模拟模式 — 不连接模型，不需要 API 密钥。'
      )
    );
    console.error(
      uiText(
        '[mock] Tools and approval flows are available for testing.',
        '[mock] 工具和审批流程可用于测试。'
      )
    );
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
  // Every CLI prompt layer is declared once, with its stability (cached prefix
  // or volatile suffix) and its origin spelled out; the registry owns the two
  // arrays the agent takes, and updates them in place so a mode switch or a late
  // MCP handshake reaches existing runs and sub-agents.
  const {
    promptLayers,
    capabilityRegistry,
    trackTouchedInput: trackTouchedInputBase,
    noteUserText,
    touchedPaths,
  } = await createCliPromptSetup({
    workspace,
    ...(configDir ? { configDir } : {}),
    initialText: process.argv.join(' '),
    // git status/log in the env layer is a subprocess chain; the TUI must not
    // wait on it to paint (headless keeps the first-prompt snapshot).
    ...(tuiBootWanted ? { deferEnvironmentLayer: true } : {}),
    onEnvironmentLayerReady: () => startupTiming.mark('env'),
  });
  // Prompt assembly (system prompt layers, AGENTS.md, rules, soul) is the last
  // piece before the agent is built; a separate mark keeps it out of `config`.
  startupTiming.mark('prompt');
  // Skills whose `globs` match a touched path enter the catalog; the skills
  // block below installs the real refresh and this hook forwards to it.
  let refreshSkillActivation = (): void => {};
  const trackTouchedInput = (input: unknown): void => {
    trackTouchedInputBase(input);
    refreshSkillActivation();
  };
  if (promptLayersDebugEnabled()) console.error(`[prompt]\n${promptLayers.formatReport()}`);

  const projectCapabilities = await resolveProjectCapabilities({
    workspaceDir: workspace,
    configDir,
    configPath: loadedConfig.configPath,
    ...(loadedConfig.projectConfigPath
      ? { projectConfigPath: loadedConfig.projectConfigPath }
      : {}),
    interactive: process.stdin.isTTY === true && !parsedArgs.print,
    headlessUntrusted:
      parsedArgs.print || (parsedArgs.command === 'chat' && process.stdin.isTTY !== true),
    trustFlag: parsedArgs.trustWorkspace,
    env: envBeforeDotenv,
    folderTrusted: startup.trusted,
  });
  const configuredHooks = createConfiguredHookCallbacks(projectCapabilities.hooks, {
    workspaceDir: workspace,
  });
  setPermissionRequestRunner((request) =>
    configuredHooks.runPermissionRequest({
      toolName: request.tool.name,
      input: request.input,
    })
  );
  // Lifecycle shell hooks (Stop / SubagentStop) fire from shared run paths
  // that have no access to this wiring — install them as the module runner.
  setLifecycleHookRunner({
    runStop: (info) => configuredHooks.runStop(info),
    runPermissionDenied: (info) => configuredHooks.runPermissionDenied(info),
    runSubagentStart: (info) => configuredHooks.runSubagentStart(info),
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
  if (deviceTarget) {
    promptLayers.set({
      id: 'cli:device',
      stability: 'dynamic',
      origin: 'environment',
      text: CONFIGURED_DEVICE_PROMPT,
    });
  }
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
    sessionPermissionRules: permissionRuleRegistry,
    readOnlyCeiling: resolvedConfig.permissions.readOnlyCeiling,
    deviceTrust: resolvedConfig.permissions.deviceTrust,
    trustedDevices: resolvedConfig.permissions.trustedDevices,
    detailMode: resolveCliDetailMode(argv),
    // O94: -p/--print must auto-deny protected paths even when stdin is a TTY.
    printMode: parsedArgs.print === true,
  });
  const configPreHook = configuredHooks.onBeforeToolExec;
  // O157: a hook `ask` reaches the policy hook, which prompts (or refuses in -p).
  const preToolUseGate = composePreToolUseGate(configPreHook, approvalHook);
  const onBeforeToolExec: AgentHooks['onBeforeToolExec'] = (req) =>
    runWithApprovalRequest(req, async () => {
      const decision = await preToolUseGate(req);
      if (!decision.approved) {
        // Fire-and-forget: the deny verdict must not wait on a logging hook.
        void configuredHooks.runPermissionDenied({
          toolName: req.tool.name,
          input: req.input,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
      }
      return decision;
    });
  const protectedConfigPaths = [
    loadedConfig.configPath,
    ...mossConfigDirs(configDir, envBeforeDotenv).flatMap((dir) =>
      ['config.json', 'credentials', '.apikey-key', '.env', 'mcp.json', 'workspace-trust.json'].map(
        (name) => path.join(dir, name)
      )
    ),
    path.join(workspace, '.moss', 'config.json'),
    path.join(workspace, '.moss', 'mcp.json'),
  ];
  // Match resolveProjectConfigPath's nearest-ancestor search, including files
  // that do not exist yet and could be created during this run.
  let projectConfigDir = path.resolve(configStartDir);
  for (let i = 0; i < 16; i++) {
    protectedConfigPaths.push(path.join(projectConfigDir, '.moss', 'config.json'));
    const parent = path.dirname(projectConfigDir);
    if (parent === projectConfigDir) break;
    projectConfigDir = parent;
  }
  const hooks = createConfiguredGuardrailHooks(resolvedConfig, {
    enrichToolContext: (context) => ({
      ...context,
      protectedConfigPaths,
    }),
    onBeforeToolExec,
    onToolResult: (call, result) => {
      trackTouchedInput(call.input);
      configuredHooks.onToolResult?.(call, result);
    },
    onInputGuardrail: async (request) => {
      // `@rule:<name>` in this message may load a manual rule body; headless
      // already scanned argv, REPL turns arrive here.
      noteUserText(request.userMessage);
      const submitted = await configuredHooks.runUserPromptSubmit(request.userMessage);
      if (submitted.blocked) {
        return {
          approved: false,
          // O91: the zh fallback names the hook in Chinese; en keeps the id.
          reason:
            submitted.reason ??
            (isZhLocale()
              ? `已拦截：${hookEventZhName('UserPromptSubmit')}钩子`
              : 'Blocked by UserPromptSubmit hook'),
        };
      }
      if (submitted.extraContext) {
        return {
          approved: true,
          userMessage: formatUserPromptHookContext(request.userMessage, submitted.extraContext),
        };
      }
      return { approved: true };
    },
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
  let fileAgents: ReturnType<typeof adoptFileAgents> = { agents: [], notices: [] };
  try {
    fileAgents = adoptFileAgents(
      loadAgentFiles({
        workspaceDir: workspace,
        parentModel: model,
        ...(modelTiers ? { modelTiers } : {}),
        // `trusted: true` with an empty project must not imply Claude opt-in.
        projectTrust: {
          trusted: projectCapabilities.trusted,
          claudeOptIn: projectCapabilities.claudeOptIn,
        },
      })
    );
  } catch (err) {
    console.error(`[agents] failed to load agent files: ${errorMessage(err)}`);
  }
  if (
    fileAgents.notices.length > 0 ||
    fileAgents.agents.some((agent) => agent.loadWarnings?.length)
  ) {
    const zh = isZhLocale();
    for (const line of formatFileAgentReport({
      experts: fileAgents.agents,
      notices: fileAgents.notices,
      zh,
    }).split('\n')) {
      if (
        line.startsWith(zh ? '  警告：' : '  warning:') ||
        line.startsWith('  skipped') ||
        line.startsWith('  跳过')
      ) {
        console.error(`[agents] ${line.trim()}`);
      }
    }
  }

  const agent = new MossAgent({
    llmProvider: cliLlmProvider,
    sessionStore,
    model,
    usingBundledDefault: resolvedConfig.usingBundledDefault,
    workspaceDir: workspace,
    // v0.9 W1: shell-write confinement. workspace-write/read-only confine
    // statically-extracted exec write targets to the workspace (same
    // boundary the file tools enforce); full-access leaves the shell
    // unconstrained by explicit host choice.
    ...(safetyMode === 'full-access' ? {} : { execWriteRoots: [workspace] }),
    ...(hasRunBudget ? { budget: runBudget } : {}),
    ...(bestOfN ? { bestOfN } : {}),
    ...(resolvedConfig.reviewMode ? { reviewMode: resolvedConfig.reviewMode } : {}),
    ...(resolvedConfig.verificationGate === false ? { verificationGate: false } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(modelTiers ? { modelTiers } : {}),
    subagentExperts: fileAgents.agents,
    subagentExpertNotices: fileAgents.notices,
    ...(compactHookRegistry ? { compactHooks: compactHookRegistry } : {}),
    subagentStartHook: (info) => configuredHooks.runSubagentStart(info),
    subagentStopHook: (info) => configuredHooks.runSubagentStop(info),
    // Keep the Moss persona, but name the actual model so the agent can answer
    // "which model are you?" honestly instead of substituting "Moss".
    baseSystemPrompt: resolveSoulIdentity({
      configDir,
      workspaceDir: workspace,
      model,
      usingBundledDefault: resolvedConfig.usingBundledDefault,
    }),
    promptLayers,
    // Plan mode is a session state the core cannot see: expose it so plan-only
    // tools (`exit_plan`) are offered exactly while the mode is `plan`, the way
    // Cursor/Claude Code expose ExitPlanMode only inside plan mode.
    planModeActive: () => getCliInteractionMode() === 'plan',
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
  agent.config.baseUrl = baseUrl;
  agent.config.provider = providerConfig.provider;
  // Rebuilt on every switchModel so the persona names the live model, including
  // a soul file's prepend body and the non-overridable honesty footer.
  agent.config.identityFactory = (nextModel: string) =>
    resolveSoulIdentity({
      configDir,
      workspaceDir: workspace,
      model: nextModel,
      usingBundledDefault: agent.config.usingBundledDefault,
    });
  const { registerBuiltinTools, builtinTools } = await (builtinToolsPromise ??
    import('../tools/builtin.js'));
  await registerBuiltinTools(agent);
  // D3 tool-surface experiments: MOSS_HIDE_TOOLS hides tools for an A/B without
  // editing code. Say what was hidden (and what was not a real tool) so a bench
  // run cannot silently measure the wrong surface.
  {
    const { hiddenToolNames, unknownHiddenToolNames } =
      await import('../core/agent/session-tool-offer.js');
    const hidden = hiddenToolNames();
    if (hidden.size > 0) {
      const zh = isZhLocale();
      const registered = new Set(builtinTools.map((tool) => tool.name));
      const hiddenKnown = [...hidden].filter((name) => registered.has(name));
      const unknown = unknownHiddenToolNames([...registered], process.env);
      console.error(
        zh
          ? `[moss] 工具实验：MOSS_HIDE_TOOLS 隐藏 ${String(hiddenKnown.length)} 个工具（${hiddenKnown.join(', ')}）`
          : `[moss] tool experiment: MOSS_HIDE_TOOLS hides ${String(hiddenKnown.length)} tool(s) (${hiddenKnown.join(', ')})`
      );
      if (unknown.length > 0) {
        console.error(
          zh
            ? `[moss] MOSS_HIDE_TOOLS 里这些名字不是已注册工具，已忽略：${unknown.join(', ')}`
            : `[moss] MOSS_HIDE_TOOLS names are not registered tools and were ignored: ${unknown.join(', ')}`
        );
      }
    }
  }
  // Device targets resolve host > env > .moss/devices.json (registered via
  // `moss device add`); declaring the workspace turns the registry tier on.
  // A project's .moss/devices.json picks a host and an env var whose value is
  // sent as the SSH password, so it waits for trust like project routing.
  configureDeviceWorkspace(startup.trusted ? workspace : null);
  const useTui =
    Boolean(process.stdout.isTTY) && process.env.MOSS_NO_TUI !== '1' && !parsedArgs.print;
  // O88: the TUI shows a blocked hook's reason in the tool row; `-p`/piped
  // runs keep the `[hooks]` stderr line.
  configuredHooks.setTuiMode(useTui);
  const pendingTuiNotices: string[] = [];
  const tuiNoticeListeners = new Set<(message: string) => void>();
  const tuiNoticeSource = {
    subscribe(listener: (message: string) => void): () => void {
      tuiNoticeListeners.add(listener);
      for (const message of pendingTuiNotices.splice(0)) listener(message);
      return () => tuiNoticeListeners.delete(listener);
    },
  };
  const emitTuiNotice = (message: string): void => {
    if (tuiNoticeListeners.size === 0) {
      pendingTuiNotices.push(message);
      return;
    }
    for (const listener of tuiNoticeListeners) listener(message);
  };
  if (!startup.trusted) {
    const summary = summarizeTrustItems(projectCapabilities.skipped, isZhLocale());
    const parts = [
      ...(loadedConfig.ignoredProjectRouting ?? []),
      ...(loadedConfig.droppedProjectPermissions ?? []),
      ...startup.ignoredRoutingEnv,
      ...((await import('../device/device-registry-file.js')).loadDeviceRegistry(workspace).length >
      0
        ? ['.moss/devices.json']
        : []),
      ...(summary ? [summary] : []),
    ];
    const line = untrustedFolderLine(parts, isZhLocale());
    // O72: once per folder (and again only if the skipped list changes).
    if (shouldShowUntrustedFolderNotice(startup.folderKey, line)) {
      if (useTui) emitTuiNotice(line);
      else console.error(line);
    }
  } else if (startup.ignoredRoutingEnv.length > 0) {
    const line = ancestorRoutingIgnoredLine(
      startup.ignoredRoutingEnv,
      startup.ignoredRoutingDirs,
      isZhLocale()
    );
    if (useTui) emitTuiNotice(line);
    else console.error(line);
  }
  deliverDotenvSafetyEnvNotices(useTui, emitTuiNotice);
  {
    const withheld = projectDeviceHostWithholdsPassword();
    if (withheld) {
      const line = isZhLocale()
        ? `[moss] MOSS_DEVICE_HOST 来自项目 .env（${withheld}），不会把你自己的 MOSS_DEVICE_PASSWORD 发给它。请把该板子的密码写进同一个 .env，或在 ~/.env / moss device add 里指定主机。`
        : `[moss] MOSS_DEVICE_HOST comes from a project .env (${withheld}); your own MOSS_DEVICE_PASSWORD is not sent to it. Put that board's password in the same .env, or name the host in ~/.env or with moss device add.`;
      if (useTui) emitTuiNotice(line);
      else console.error(line);
    }
  }
  startupTiming.mark('agent');
  // v0.16 MCP client: connect servers declared in `.moss/mcp.json` /
  // `<configDir>/mcp.json` (credentials only via ${ENV_VAR} expansion).
  // User servers stay zero-config = zero overhead. rdk-docs is the one builtin:
  // on by default (no device required), connected in the background so startup
  // does not wait on npx. A failure is one line, not a crashed CLI. No cache,
  // no bundled manual. MOSS_NO_RDK_DOCS=1 or rdkDocs:false skips it.
  let mcpRegistry: McpToolRegistry | null = null;
  // TUI boot paints the current registry snapshot. Notices start only after
  // that paint, so a server still connecting is not also announced as failed.
  let announceMcpStatus = !useTui;
  let syncRdkDocsSkills = (): void => {};
  const refreshMcpPromptLayer = (): void => {
    if (!mcpRegistry) return;
    // Knowledge only. The server index is a stable layer from config names,
    // so a connect that adds a tool count cannot rewrite the cached prefix.
    // MossAgent re-reads the layer arrays before each model call. The MCP index
    // lives in the dynamic suffix so a late connect does not rewrite the cached
    // prefix; its id keeps the slot stable across connects.
    promptLayers.set({
      id: 'cli:mcp',
      stability: 'dynamic',
      origin: 'tooling',
      text: rdkDocsKnowledgeLayer(mcpRegistry.getStatuses()),
    });
    if (promptLayersDebugEnabled()) console.error(`[prompt]\n${promptLayers.formatReport()}`);
  };
  const builtinRdkDocsEnabled = rdkDocsAutoConnectEnabled({
    env: process.env,
    rdkDocs: readRdkDocsFlag(loadedConfig.config.rdkDocs),
    workspaceDir: workspace,
  });
  const mcpConfigs = withBuiltinRdkDocs(
    loadMcpConfigs(
      workspace,
      configDir,
      process.env,
      (warning) => console.error(warning),
      projectCapabilities.mcp
    ),
    builtinRdkDocsEnabled,
    builtinRdkDocsEnabled
      ? resolveRdkDocsPackage(loadedConfig.config.rdkDocs, envBeforeDotenv)
      : undefined
  );
  if (mcpConfigs.length > 0) {
    // Present whenever the search tools are registered, including `moss -p`
    // which starts before the handshake. No counts: those change on connect.
    promptLayers.set({
      id: 'cli:mcp-index',
      stability: 'stable',
      origin: 'tooling',
      text: buildMcpStableIndex(mcpConfigs.map((config) => config.name)),
    });
    try {
      mcpRegistry = McpToolRegistry.connectInBackground(mcpConfigs, {
        // Real MCP tools register on demand: the search meta-tool installs
        // them into the live registry when the model asks for a server's list.
        // Per-server timeouts (rdk-docs lazy connect: 15s, request 20s) live
        // on the config; other servers keep the client defaults.
        registerTool: (tool) => agent.tools.register(tool),
        onStatusChange: (status) => {
          refreshMcpPromptLayer();
          if (status.state !== 'connected' && status.state !== 'failed') return;
          if (!announceMcpStatus) return;
          if (useTui) {
            if (status.state === 'connected' && cliDetailForNotices === 'quiet') return;
            emitTuiNotice(formatMcpStatusLine(status));
            return;
          }
          const line = formatMcpStartupLine(status, cliDetailForNotices);
          if (line) console.error(line);
        },
      });
      for (const searchTool of mcpRegistry.getTools()) agent.tools.register(searchTool);
      // setTimeout(0) still starts npx immediately each session. It does not
      // wait for the first question. The timer is unref'd so a failed warm
      // does not hold the process open by itself.
      // O87: under HTTPS_PROXY/HTTP_PROXY, skip the eager warm so npx registry
      // CONNECTs do not contend with the first model request on a narrow
      // reverse tunnel (board: MCP-on FAIL / MOSS_NO_RDK_DOCS=1 PASS).
      // First rdk-docs tool call still starts the server.
      const warming = mcpRegistry;
      if (shouldEagerWarmRdkDocs(process.env)) {
        const warmTimer = setTimeout(() => {
          warming.startDeferred(RDK_DOCS_SERVER_NAME);
        }, 0);
        if (typeof warmTimer.unref === 'function') warmTimer.unref();
      }
      // Lazy-loading budget: the system prompt gets one index line per server,
      // never the tool list itself. The rdk-docs usage pointer sits on that
      // server's line; a failed connect gets only the unavailable sentence.
      refreshMcpPromptLayer();
    } catch (err) {
      console.error(
        uiText(
          `[mcp] initialization failed: ${errorMessage(err)}`,
          `[mcp] 初始化失败：${errorMessage(err)}`
        )
      );
      mcpRegistry = null;
    }
  }
  // A literal permission rule naming a tool that no longer exists parses fine,
  // counts in `/permissions`, and then matches nothing — a deny rule in that
  // state silently protects nothing. Surface it once at startup (headless users
  // never open `/permissions`); glob and `mcp__…` rules are skipped because the
  // former cannot be checked exactly and the latter register after the handshake.
  for (const tool of unmatchedRuleToolNames(
    startupPermissionRules,
    agent.tools.getAll().map((tool) => tool.name)
  )) {
    console.error(
      uiText(
        `[moss] permission rule "${tool}" names no registered tool — it never applies (fix it in /permissions)`,
        `[moss] 权限规则 "${tool}" 没有匹配的已注册工具——永远不会生效（在 /permissions 里修正）`
      )
    );
  }
  startupTiming.mark('mcp');
  // One source for both `/mcp` views: the registry's live statuses (a `deferred`
  // server has not connected yet and would read as noise in a list).
  const listMcpServerStatuses = () =>
    mcpRegistry
      ? mcpRegistry
          .getStatuses()
          .filter((s) => s.state !== 'deferred')
          .map((s) => ({
            name: s.name,
            state: s.state,
            ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
            ...(s.error ? { error: s.error } : {}),
          }))
      : [];
  agent.config.resolveMissingTool = (name, signal) =>
    mcpRegistry?.resolveCallableTool(name, signal) ?? Promise.resolve(undefined);
  agent.config.describeMissingTool = (name) => mcpRegistry?.missingToolReason(name);
  // File-based custom tools from .moss/tools/*.tool.json — the lightweight
  // path for users who want a named, schema-validated tool without a host
  // extension module.
  registerFileBasedTools(workspace, agent.tools, (name) => {
    console.error(
      `[moss:tools] skipping ${JSON.stringify(sanitizeSecrets(name))}: name already registered`
    );
  });
  // v0.16 skills: SKILL.md files from `.moss/skills/` (workspace) and
  // `<configDir>/skills/` (user). Progressive disclosure — only the index
  // enters the system prompt; bodies load through the readonly skill tool.
  // The count feeds the TUI's boot context line, and the TUI also gets the
  // skills themselves so they surface as first-class `/` commands.
  const loadedSkills: Array<{
    name: string;
    description: string;
    scope: 'workspace' | 'user';
    issues: number;
    slashAlias?: string;
  }> = [];
  const sessionContextInfo: { skills?: number; soul?: string; branch?: string } = {};
  {
    // Discovery scopes: the Moss workspace directory wins, then the cross-client
    // `.agents/skills` / `.claude/skills` conventions, then user-level installs.
    const skillDirSpecs: Array<{ dir: string; scope: 'workspace' | 'shared' | 'user' }> = [
      { dir: path.join(workspace, '.moss', 'skills'), scope: 'workspace' },
      { dir: path.join(workspace, '.agents', 'skills'), scope: 'shared' },
      { dir: path.join(workspace, '.claude', 'skills'), scope: 'shared' },
      { dir: path.join(configDir, 'skills'), scope: 'user' },
      { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
    ];
    const announcedSkillSkips = new Set<string>();
    const emitSkillNotice = (line: string) => {
      if (useTui) emitTuiNotice(line);
      else console.error(line);
    };
    const baseSkills = loadSkillCatalog(skillDirSpecs, {
      onSkip(skip) {
        if (announcedSkillSkips.has(skip.file)) return;
        announcedSkillSkips.add(skip.file);
        announceCatalogSkip(workspace, skip.file, skip.reason, cliLocale(), emitSkillNotice);
      },
      onIssue(issue) {
        emitSkillNotice(`[skill] ${issue.message} (${issue.file})`);
      },
    });
    const sessionSkills = [...baseSkills];
    const emptySkillsLayer = buildEmptySkillsHintLayer(skillDirSpecs.map(({ dir }) => dir));
    const rdkDocsConfigured = mcpConfigs.some((config) => config.name === RDK_DOCS_SERVER_NAME);
    syncRdkDocsSkills = () => {
      // Register once from config, not from the handshake. Swapping the skill
      // tool in when rdk-docs connects changes the tool list mid-session.
      const next = includeBundledRdkDocsSkill(baseSkills, rdkDocsConfigured);
      sessionSkills.splice(0, sessionSkills.length, ...next);
      // Core registers the `skill` tool from this port and re-reads the list on
      // every call, so a late rdk-docs connect or a new install needs no re-register.
      // The agent re-reads this port every turn; the catalog layer is refreshed
      // through `refreshSkillActivation` when a tool touches a matching path.
      // The CLI renders its own layer (see below), so the port is what core uses
      // for the `skill` tool's name resolution.
      refreshSkillActivation = (): void => {
        const budget = skillCatalogBudget();
        agent.setSkillCatalog({
          manifests: () => selectActiveSkills(sessionSkills, touchedPaths()),
          ...('budgetChars' in budget ? { budgetChars: budget.budgetChars } : {}),
        });
        if (sessionSkills.length === 0) return;
        const active = selectActiveSkills(sessionSkills, touchedPaths());
        // B10: entries this workspace actually loaded rank first, so a budget
        // cut drops the least-recently-used skill, not the alphabetically first.
        const catalog = renderSkillCatalog(active, {
          ...skillCatalogBudget(),
          usage: loadSkillUsage(workspace),
        });
        const note =
          catalog.stats.skills > 0
            ? `skills ${String(catalog.stats.skills)}, ${String(catalog.stats.renderedChars)}/${String(
                catalog.stats.uncappedChars
              )} chars, omitted ${String(catalog.stats.omitted)}, strategy ${catalog.stats.strategy}`
            : undefined;
        promptLayers.set({
          id: 'cli:skills',
          stability: 'dynamic',
          origin: 'tooling',
          text: catalog.text ?? '',
          ...(note ? { note } : {}),
        });
        if (promptLayersDebugEnabled()) {
          const activated = active
            .filter((skill) => skill.globs.length > 0)
            .map((skill) => skill.name);
          console.error(
            `[skills] paths touched: ${touchedPaths().join(', ') || '(none)'} → glob-activated: ${
              activated.join(', ') || '(none)'
            }`
          );
        }
      };
      refreshSkillActivation();
      sessionContextInfo.skills = sessionSkills.length;
      loadedSkills.splice(
        0,
        loadedSkills.length,
        ...sessionSkills.map((skill) => {
          const scope = skill.scope === 'workspace' ? ('workspace' as const) : ('user' as const);
          const alias = skillSlashName(skill.name);
          return {
            name: skill.name,
            description: skill.description,
            scope,
            issues: skill.issues.length,
            ...(alias.toLowerCase() !== skill.name.toLowerCase() ? { slashAlias: alias } : {}),
          };
        })
      );
      if (sessionSkills.length === 0) {
        promptLayers.set({
          id: 'cli:skills',
          stability: 'dynamic',
          origin: 'tooling',
          text: emptySkillsLayer,
        });
      }
      // The startup reports print before skills load; this is the first table
      // that includes the catalog, so print it here when the debug flag is on.
      if (promptLayersDebugEnabled()) console.error(`[prompt]\n${promptLayers.formatReport()}`);
    };
    syncRdkDocsSkills();
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
      getReportedModel: () => agent.reportedModel(),
    })
  );
  // Track the locale-derived region for web_search.
  const searchLocale = cliLocale() ?? '';
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
  /**
   * B78: the reduced-profile notice and the `## Context Window` layer both depend
   * on the *effective* window. In the TUI the probe lands after the first paint
   * (by design), so both have to be re-evaluated when it does — otherwise a model
   * whose API reports 4k is told 1000k and never sees the tiny-profile notice.
   */
  let tinyWindowAnnounced = false;
  const announceTinyWindowIfNeeded = (): boolean => {
    if (tinyWindowAnnounced) return false;
    const contextTokens = resolvedConfig.contextTokens;
    if (!contextTokens) return false;
    const outputBudget =
      resolvedConfig.maxOutputTokens ??
      resolveModelOutputBudget({
        modelId: resolvedConfig.model,
        contextTokens,
        pinned: false,
        overrides: agent.config.modelMaxOutputTokens,
      }).initial;
    if (
      !tinyWindowToolSurfaceEnabled({
        effectiveContextTokens: getEffectiveContextWindowTokens(contextTokens, outputBudget),
      })
    ) {
      return false;
    }
    tinyWindowAnnounced = true;
    const ctxK = Math.round(contextTokens / 1000);
    const line = uiText(
      `[moss] This model's context window is small (${ctxK}k tokens): only the 5 core tools are offered, compaction uses a local summary, and each reply is capped at ${outputBudget} tokens. Configure a bigger window with agent.contextTokens (or use a model with one) for the full tool set.`,
      `[moss] 这个模型的上下文窗口较小（${ctxK}k tokens）：只提供 5 个核心工具，压缩使用本地摘要，单次回复上限 ${outputBudget} tokens。需要完整工具面请用 agent.contextTokens 配置更大的窗口（或换更大窗口的模型）。`
    );
    if (useTui) emitTuiNotice(line);
    else console.error(line);
    return true;
  };

  try {
    // Startup context-window probe: if the user didn't explicitly set
    // contextTokens (source is 'unprobed'), ask the provider API.  On success
    // the value flows into the agent's compaction logic immediately.  On failure
    // (provider has no /v1/models, 401, network error, etc.) we keep the
    // unprobed 1M default; doctor will tell user to run /model for exact probe.
    // probe runs before the TUI starts so the first turn already has the correct
    // window — doctor and the status-bar will show it immediately.
    const probeContextWindow = async (): Promise<void> => {
      if (resolvedConfig.contextTokensSource !== 'unprobed' || !resolvedConfig.baseUrl) return;
      try {
        const probed = await resolveContextTokensForModel({
          model: resolvedConfig.model,
          baseUrl: resolvedConfig.baseUrl,
          ...(resolvedConfig.apiKey ? { apiKey: resolvedConfig.apiKey } : {}),
          ...(resolvedConfig.provider ? { provider: String(resolvedConfig.provider) } : {}),
          timeoutMs: STARTUP_CONTEXT_PROBE_TIMEOUT_MS,
        });
        if (probed.source === 'provider-api') {
          agent.config.contextTokens = probed.contextTokens;
          resolvedConfig.contextTokens = probed.contextTokens;
          (resolvedConfig as { contextTokensSource: string }).contextTokensSource = 'provider-api';
          // Also re-derive maxTokens from the freshly-probed context window,
          // but only if the user didn't pin agent.maxOutputTokens explicitly.
          if (resolvedConfig.maxOutputTokens === undefined) {
            const derived = deriveMaxOutputTokens(probed.contextTokens, resolvedConfig.model);
            if (derived) agent.config.maxTokens = derived;
          }
        }
      } catch {
        // Best-effort — keep unprobed default; doctor will surface this.
      } finally {
        startupTiming.mark('probe');
      }
    };
    // The probe talks to the provider API with a 4s timeout. Headless needs the
    // window before the first turn, so it waits; the TUI must paint first and
    // pick the corrected window up when the probe lands (Cursor/Claude render the
    // composer before optional remote data).
    const contextProbe = probeContextWindow();
    if (!useTui) {
      await contextProbe;
    } else {
      // The TUI paints first; when the probe corrects the window, refresh the
      // prompt layer that states it and announce the profile if it became tiny.
      void contextProbe.then(() => {
        const corrected = resolvedConfig.contextTokens;
        if (resolvedConfig.contextTokensSource === 'provider-api' && corrected) {
          promptLayers.set({
            id: 'cli:context-window',
            stability: 'dynamic',
            origin: 'environment',
            text: `## Context Window\nYour context window is ${Math.round(corrected / 1000)}k tokens. State this number accurately when the user asks about context size — do not guess from training knowledge.`,
          });
        }
        announceTinyWindowIfNeeded();
      });
    }

    await configuredHooks.runSessionStart();

    promptLayers.set({
      id: 'cli:runtime-capabilities',
      stability: 'stable',
      origin: 'tooling',
      text: buildRuntimeCapabilitiesPrompt({
        tools: agent.tools.getAll(),
      }),
    });

    // If context window was probed (or configured), tell the LLM its actual size
    // so it can answer "how large is your context window?" accurately.  This layer
    // is pushed AFTER the startup probe (which may have updated contextTokens from
    // the unprobed 1M default to the probe value), so the LLM sees the truth.
    // It lives on the dynamic suffix: a late probe must not rewrite the cached prefix.
    if (resolvedConfig.contextTokens) {
      const ctxK = Math.round(resolvedConfig.contextTokens / 1000);
      promptLayers.set({
        id: 'cli:context-window',
        stability: 'dynamic',
        origin: 'environment',
        text: `## Context Window\nYour context window is ${ctxK}k tokens. State this number accurately when the user asks about context size — do not guess from training knowledge.`,
      });

      // B66/B70: a window this small silently loses the standard tool set and the
      // model-written summary. Say so once, with the knob that changes it: the
      // reduced surface is otherwise invisible until a tool the model wanted is
      // missing from the request. B78 folds this into a helper so the late TUI
      // probe can announce it too.
      announceTinyWindowIfNeeded();
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

    const fileCommands = loadCustomCommands(
      { workspace, configDir, reservedNames: reservedBuiltinNames() },
      (message) => {
        if (useTui) emitTuiNotice(message);
        else console.error(message);
      },
      cliLocale()
    );
    const skillSlashSuggestions = loadedSkills.flatMap((skill) => {
      const token = skillSlashToken(skill);
      return token ? [token] : [];
    });
    // One slash namespace: builtin > workspace command > user command > skill.
    // Conflicts are reported once, with the loser's source, so a shadowed skill
    // is visible instead of silently unreachable.
    const slashNamespace = collectSlashNamespace({
      customCommands: fileCommands,
      skills: loadedSkills,
      builtinNames: reservedBuiltinNames(),
    });
    capabilityRegistry.registerAll(slashNamespace.descriptors);
    for (const conflict of slashNamespace.conflicts) {
      const message = formatSlashConflict(conflict);
      if (useTui) emitTuiNotice(message);
      else console.error(message);
    }

    startupTiming.mark('skills');
    // The TUI keeps collecting: its first render is what the feel benchmark
    // measures, so the line is finished at `composer` below.
    if (!useTui) startupTiming.finish();
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
      if (isSlashCommandInput(oneShotMessage)) {
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
        const { runRegistryCommand, unknownSlashCommandLines } = await registryCommandModule();
        const handled = await runRegistryCommand(
          oneShotMessage.trim(),
          oneshotCmdCtx,
          fileCommands
        );
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
        const isKnownInteractive =
          KNOWN_COMMANDS.includes(cmdToken) || isLoadedSkillSlash(cmdToken, loadedSkills);
        if (isKnownInteractive) {
          console.error(
            uiText(
              `${cmdToken} is an interactive-mode command and isn't run from a one-shot prompt.\n` +
                `Start an interactive session with \`moss\` (then type ${cmdToken}), or rephrase as a natural-language prompt (e.g. \`moss "review auth.js for bugs"\`).`,
              `${cmdToken} 是交互模式命令，不能在一次性提示里运行。\n` +
                `先运行 \`moss\` 再输入 ${cmdToken}，或改成自然语言提示（例如 \`moss "review auth.js for bugs"\`）。`
            )
          );
        } else {
          for (const line of unknownSlashCommandLines(oneShotMessage.trim(), {
            suggestions: closestSlashCommands(cmdToken, [
              ...DISPATCHABLE_SLASH_COMMANDS,
              ...fileCommands.map((command) => command.name),
              ...skillSlashSuggestions,
            ]),
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
        console.error(
          mossLine('[moss] sending "{text}" to the model...', { text: oneShotMessage })
        );
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
        if (isSlashCommandInput(pipedText)) {
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
          const { runRegistryCommand, unknownSlashCommandLines } = await registryCommandModule();
          const handled = await runRegistryCommand(pipedText, pipedCmdCtx, fileCommands);
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
          if (KNOWN_COMMANDS.includes(cmdToken) || isLoadedSkillSlash(cmdToken, loadedSkills)) {
            console.error(
              uiText(
                `${cmdToken} is an interactive-mode command — pipe a natural-language prompt instead,` +
                  ` or run \`moss\` interactively and type ${cmdToken}.`,
                `${cmdToken} 是交互模式命令 — 请改为管道传入自然语言提示，或运行 \`moss\` 后输入 ${cmdToken}。`
              )
            );
          } else {
            const pipedToken = pipedText.split(/\s+/, 1)[0] ?? pipedText;
            for (const line of unknownSlashCommandLines(pipedText, {
              suggestions: closestSlashCommands(pipedToken, [
                ...DISPATCHABLE_SLASH_COMMANDS,
                ...fileCommands.map((command) => command.name),
                ...skillSlashSuggestions,
              ]),
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
        console.error(
          mossLine('[moss] --print requires a prompt argument or non-empty piped stdin')
        );
        process.exitCode = ExitCode.USAGE;
      }
      return;
    }
    if (parsedArgs.print) {
      console.error(mossLine('[moss] --print requires a prompt argument or piped stdin'));
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
      ...(projectCapabilities.hooks
        ? {
            hooksConfig: projectCapabilities.hooks as unknown as Record<
              string,
              readonly import('./hooks-view.js').HookViewEntry[]
            >,
          }
        : {}),
      listMcpServers: listMcpServerStatuses,
    });
    // v0.17: interactive TTY sessions get the full-screen TUI (ink); non-TTY
    // pipes and MOSS_NO_TUI=1 keep the readline REPL. The TUI is dynamically
    // imported so headless/SDK paths never load ink/react.
    // The command namespace + capability registry are built since the `skills`
    // mark, so this position is `commands` (the non-TUI path finished already).
    startupTiming.mark('commands');
    if (!useTui) startupTiming.finish();
    if (useTui) {
      const { runTuiApp } = await (tuiBootPromise ?? import('./tui/app.js'));
      startupTiming.mark('tui-import');
      const { FileCheckpointStore, checkpointTargetPaths } = await import('./file-checkpoint.js');
      const runtimeDirForTui = runtimeDir ?? path.join(workspace, '.moss', 'runtime');
      let currentSessionKey = session.sessionKey;
      let checkpointStore = new FileCheckpointStore({
        runtimeDir: runtimeDirForTui,
        sessionKey: currentSessionKey,
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
        // B12: the composer's first paint is the number the feel benchmark
        // measures; mark it so the phased line covers the visible startup, not
        // just the pre-mount work.
        onComposerReady: () => {
          startupTiming.mark('composer');
          startupTiming.finish();
        },
        agent,
        workspaceDir: workspace,
        sessionKey: session.sessionKey,
        model: inlineFirstRun ? undefined : typeof model === 'string' ? model : undefined,
        ...(inlineFirstRun ? { firstRun: true } : {}),
        onFirstRunReady: (saved) => {
          const refreshed = loadCliConfigFile(process.env, process.argv.slice(2), configStartDir);
          liveRuntime.config = resolveCliConfig(
            process.env,
            refreshed.config,
            parsedArgs.configOverrides,
            refreshed
          );
          agent.switchModel({
            model: saved.model,
            provider: saved.provider,
            baseUrl: saved.baseUrl,
            llmProvider: createCliProvider({
              provider: saved.provider,
              apiKey: saved.apiKey,
              model: saved.model,
              baseUrl: saved.baseUrl,
            }),
            usingBundledDefault: false,
          });
        },
        // Part B: hand the shell the resolved locale explicitly instead of
        // letting every component re-read the environment.
        locale: cliLocale(),
        cliRuntime: liveRuntime,
        workspaceTrusted: projectCapabilities.trusted,
        noticeSource: tuiNoticeSource,
        contextInfo: Object.assign(sessionContextInfo, {
          soul: (() => {
            const soul = resolveSoul({ workspaceDir: workspace, configDir });
            return soul.source === 'default' ? undefined : soul.id;
          })(),
          branch: (await getGitBranch(workspace)) ?? undefined,
        }),
        skills: loadedSkills,
        ...(resumeInteractive ? { resumePicker: true } : {}),
        ...(replayRows ? { replayRows } : {}),
        // The checkpoint is what `/rewind` restores from; without this call the
        // store records nothing and every rewind silently did nothing (D1).
        onTurnStart: (message) => checkpointStore.open(message.slice(0, 60)),
        onNewSession: (next) => {
          currentSessionKey = next;
          checkpointStore = new FileCheckpointStore({
            runtimeDir: runtimeDirForTui,
            sessionKey: next,
          });
        },
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
              current: m.sessionKey === currentSessionKey,
            }));
        },
        listMcpServers: listMcpServerStatuses,
        onMcpUiReady: () => {
          announceMcpStatus = true;
        },
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
      // The TUI never needs the readline REPL; loading it only on the branch
      // that uses it keeps its module graph out of interactive startup.
      const { runInteractive } = await import('./repl.js');
      await runInteractive(agent, liveRuntime, {
        sessionKey: session.sessionKey,
        ...(loadedSkills.length > 0 ? { skills: loadedSkills } : {}),
      });
    }
  } finally {
    try {
      // O70: exec_start children are detached with piped stdout/stderr; left
      // running they hold the event loop open and `moss -p` never returns. Wait
      // for the stop confirmation so an external check never races SIGTERM.
      const stoppedBackgroundIds = stopAllBackgroundProcesses();
      if (stoppedBackgroundIds.length > 0) {
        await waitForBackgroundProcesses(stoppedBackgroundIds, 'wait_all', 5_000, { pollMs: 20 });
      }
      await agent.close();
      await (await import('../device/device-registry.js')).disconnectAllDevices();
    } finally {
      // Shut MCP server connections (stdio children) down after the agent is
      // done — closeAll absorbs per-server errors internally.
      // `moss -p` can reach here before the deferred stdio spawn has run.
      // close() then marks the transport closed, and the child never starts.
      // MOSS_WAIT_MCP_STARTUP=1 (the safe-child-env spec) waits for that
      // attempt first. Default shutdown does not.
      if (envBeforeDotenv.MOSS_WAIT_MCP_STARTUP === '1') {
        await mcpRegistry?.waitForConnections();
      }
      await mcpRegistry?.closeAll();
      // SessionEnd lifecycle hook: fires exactly once at CLI shutdown.
      try {
        await configuredHooks.runSessionEnd({ reason: 'cli_shutdown' });
      } catch {
        /* shutdown hooks never block exit */
      }
      // O70: whatever still lingers after cleanup must not hang a one-shot run.
      if (parsedArgs.print || oneShotMessage) armExitGuard();
    }
  }
}

/** Last-resort CLI error reporting: one clean line per known class, then exit. */
export function handleFatal(err: unknown): void {
  if (err instanceof WorkspacePathPermissionError) {
    console.error(`[moss] ${errorMessage(err)}`);
    process.exit(ExitCode.CONFIG);
  }

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
  const fatal: ReadonlyArray<readonly [number, string, string]> = [
    [
      ExitCode.PROVIDER_AUTH,
      '[moss] Authentication failed: {message}',
      '[moss] Check your API key with `moss config show`, or re-run `moss setup`.',
    ],
    [
      ExitCode.RATE_LIMIT,
      '[moss] Rate limited: {message}',
      '[moss] Wait a moment and try again. Consider setting a lower model or reducing prompt size.',
    ],
    [
      ExitCode.PROVIDER_UPSTREAM,
      '[moss] Provider error: {message}',
      '[moss] The upstream API returned an error. Check your network, base URL, and model name.',
    ],
    [
      ExitCode.CONFIG,
      '[moss] Configuration error: {message}',
      '[moss] Run `moss config show` to inspect settings, or `moss setup` to reconfigure.',
    ],
    [
      ExitCode.SESSION,
      '[moss] Session error: {message}',
      '[moss] List saved sessions with `moss sessions`, or start a new one with `moss`.',
    ],
  ];
  for (const [exit, head, tail] of fatal) {
    if (code !== exit) continue;
    console.error(mossLine(head, { message }));
    console.error(mossLine(tail));
    process.exit(code);
  }

  // User aborted: they hit Ctrl+C or cancelled — not a bug.
  if (code === ExitCode.USER_ABORTED) {
    console.error(
      mossLine('[moss] Cancelled: {message}', {
        message: message || mossLine('operation was interrupted'),
      })
    );
    process.exit(code);
  }

  // For unexpected / internal errors, show the bug-report notice.
  console.error(`[moss] ${message}`);
  console.error('');
  console.error(mossLine('This looks like a bug. Please help us fix it:'));
  console.error(mossLine('  1. Run `moss doctor` to check your environment'));
  console.error(
    mossLine(
      '  2. If the problem persists, report it to the Moss maintainers with the details below.'
    )
  );
  if (err instanceof Error && err.stack) {
    console.error('');
    console.error(mossLine('Technical details (for bug reports):'));
    console.error(err.stack);
  }
  process.exit(code);
}

/** `MOSS_SKILLS_CATALOG_BUDGET` overrides the L1 catalog character budget. */
function skillCatalogBudget(): { budgetChars: number } | Record<string, never> {
  const raw = process.env.MOSS_SKILLS_CATALOG_BUDGET;
  if (!raw) return {};
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 500) return {};
  return { budgetChars: parsed };
}
