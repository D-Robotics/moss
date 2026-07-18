// Moss Agent CLI main — see --help for usage, config, and environment variables.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from './errors.js';
import { exitCodeForError, ExitCode } from './cli/exit-codes.js';
import { resolveCliAgentRuntimeOptions, deriveMaxOutputTokens } from './cli/agent-runtime.js';
import { createCliToolApprovalHook, getCliInteractionMode, resolveCliSafetyMode, setCliInteractionMode } from './cli/approval.js';
import { CliConfigFileError, CliConfigWriteError, loadCliConfigFile, loadEnvFromAncestors, resolveCliConfig, resolveConfigDir, safeProcessCwd } from './cli/config.js';
import { parseCliArgs } from './cli/args.js';
import { displayHelp, displayVersion } from './cli/help.js';
import { createConfiguredGuardrailHooks } from './cli/guardrails.js';
import { createConfiguredHookCallbacks } from './cli/hooks.js';
import { resolveSoulIdentity } from './cli/soul.js';
import type { AgentHooks } from './core/agent/agent-hooks.js';
import { createCliProvider } from './cli/providers.js';
import type { CliProviderRuntimeConfig } from './cli/providers.js';
import { resolveContextTokensForModel } from './cli/model-catalog.js';
import {
  clearMossCommunityAuthSession,
  MossCommunityAuthRequiredError,
  ensureMossCommunityAuth,
  getMossCommunityAuthStatus,
  runMossCommunityAuthLogin,
} from './cli/community-auth.js';
import type { MossCommunityAuthContext, MossCommunityAuthRuntime } from './cli/community-auth.js';
import { createMemoryTools } from './cli/tools.js';
import { createModelInfoTool } from './cli/model-info-tool.js';
import { runOneShot } from './cli/oneshot.js';
import { runInteractive } from './cli/repl.js';
import { resolveCliSession } from './cli/session.js';
import { registerConfiguredMcpTools } from './cli/mcp.js';
import { autoRegisterCodeGraphTools } from './cli/codegraph-auto.js';
import {
  hasShownOneShotOnboardingHint,
  markOneShotOnboardingShown,
  offerSetupForInteractiveMissingConfig,
  printMissingConfigGuidance,
  renderConfigUsage,
  renderOneShotOnboardingHint,
} from './cli/setup.js';
import { renderMcpUsage } from './cli/mcp-command.js';
import { MossAgent, JsonlSessionStore, MemoryManager } from './core/index.js';
import { configureRootLogger, type LogLevel } from './logger.js';
import pc from 'picocolors';
import { registerBuiltinTools, bundledBochaKey } from './tools/builtin.js';
import { loadFileBasedTools } from './tools/file-based-tools.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { runRegistryCommand, unknownSlashCommandLines, type CommandContext as RegistryCommandContext } from './cli/commands/registry.js';
import { commandSuggestion, cliLocale, KNOWN_COMMANDS } from './cli/tui-utils.js';
import { SkillLearner } from './core/memory/skill-learner.js';
import { SkillPipeline } from './skill-learning/index.js';
import { WorkspaceMemory } from './core/memory/workspace-memory.js';
import { buildEnvironmentContextLayer } from './context/environment.js';
import { buildRuntimeCapabilitiesPrompt } from './context/runtime-capabilities.js';
import { buildSoftwareEngineeringPromptQuick } from '@rdk-moss/core';
import { createCliCompletionGate } from './cli/coding-completion-gate.js';
import { createDockerExecTool } from './tools/docker-exec.js';
import { getDeviceConfigFromEnv } from './tools/device-ssh.js';
import { connectDeviceForSession } from './cli/device-connect.js';
import type { CliRuntimeStatus } from './cli/onboarding.js';
import { AgentMesh, createMeshTools, isMeshVerboseEnabled } from './mesh/agent-mesh.js';
import { MeshEventBus } from './mesh/index.js';
import { LanDiscovery } from './mesh/lan-discovery.js';
import { setTracer } from './observability/tracing.js';
import { initObservability, shutdownObservability } from './observability/index.js';
import { resolveLLMUsageLogPath } from './observability/llm-usage.js';
import { redactSensitiveData } from './observability/redact.js';
import { resolveCliDetailMode } from './cli/output.js';
import type { DeviceSshConfig } from './tools/device-ssh.js';
import type { McpConnection } from './mcp/index.js';
import { migrateLegacyWorkspacePaths } from './utils/workspace-paths.js';
import type { LLMProvider, LLMResponse, LLMRequestOptions, LLMStreamEvent } from './core/llm/llm-provider.js';
import { CliPhase, getPhaseForCommand, getCommandConfig, type CommandContext } from './cli/command-dispatcher.js';

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
  const warningType = typeof args[0] === 'string' ? args[0] : warning instanceof Error ? warning.name : '';
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

async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
  for (const connection of connections) {
    await connection.close().catch(() => {});
  }
}

async function loadStoredCommunityAuth(configDir: string): Promise<MossCommunityAuthContext | undefined> {
  try {
    return await ensureMossCommunityAuth({ configDir, interactive: false });
  } catch (err) {
    if (err instanceof MossCommunityAuthRequiredError) return undefined;
    throw err;
  }
}

function createCommunityAuthRuntime(
  providerConfig: CliProviderRuntimeConfig,
  configDir: string,
): MossCommunityAuthRuntime {
  return {
    getStatus: () => getMossCommunityAuthStatus({ configDir }),
    getContext: () => providerConfig.communityAuth,
    login: async (print, options) => {
      const auth = await runMossCommunityAuthLogin({
        configDir,
        print,
        manual: options?.manual,
        openBrowser: options?.openBrowser,
        readLine: options?.readLine,
      });
      providerConfig.communityAuth = auth;
      return auth;
    },
    logout: () => {
      providerConfig.communityAuth = undefined;
      return clearMossCommunityAuthSession(configDir);
    },
  };
}

if (process.env.MOSS_TRACE === 'console' || process.env.MOSS_TRACE === '1' || process.env.MOSS_TRACE === 'true') {
  setTracer('console');
}

if (parsedArgs.help && parsedArgs.command === 'config') {
  console.log(renderConfigUsage());
  process.exit(0);
}
// Subcommand-specific --help: show the subcommand's own usage, not the global
// banner, so `moss mcp --help` / `moss auth --help` answer the actual question.
if (parsedArgs.help && parsedArgs.command === 'mcp') {
  console.log(renderMcpUsage());
  process.exit(0);
}
if (parsedArgs.help && parsedArgs.command === 'auth') {
  console.log(
    [
      'Usage: moss auth <login|status|logout>',
      '  login [--manual]   optional: link a D-Robotics developer community account',
      '  status             show community login + provider/model/key state',
      '  logout             remove stored community login and API key config',
    ].join('\n'),
  );
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
    console.error(`[moss] '${token}' is an alias for '${suggestion}'. Run \`moss doctor\` instead.`);
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
  console.error('To pass a prompt that begins with "-", use: moss chat "<your text>"  (or  moss -- <your text>)');
  process.exit(ExitCode.USAGE);
}

async function setupMesh(agent: MossAgent, deviceConfig: DeviceSshConfig | null) {
  const meshPort = parseInt(process.env.MOSS_MESH_PORT || '9090', 10);
  const meshId = process.env.MOSS_MESH_ID || `moss-${Date.now()}`;
  const meshName = process.env.MOSS_MESH_NAME || `Moss @ ${os.hostname()}`;
  const meshListenHost = process.env.MOSS_MESH_LISTEN_HOST || undefined;
  const meshSharedSecret = process.env.MOSS_MESH_SHARED_SECRET || process.env.MOSS_MESH_SECRET || undefined;
  const meshPeers = (process.env.MOSS_MESH_PEERS || '').split(',').filter(Boolean).map((p) => {
    const [host, port] = p.split(':');
    return { host, port: parseInt(port || '9090', 10) };
  });
  const allowIncoming = process.env.MOSS_MESH_ALLOW_INCOMING !== 'false';
  const mesh = new AgentMesh({
    id: meshId, name: meshName, port: meshPort, listenHost: meshListenHost,
    sharedSecret: meshSharedSecret, peers: meshPeers,
    capabilities: deviceConfig ? ['device-control', 'ros2'] : ['general'],
    deviceInfo: deviceConfig ? `${deviceConfig.host}` : undefined, allowIncoming,
  });
  const meshEvents = new MeshEventBus();
  mesh.setEventBus(meshEvents);
  meshEvents.on((event) => {
    if (!isMeshVerboseEnabled()) return;
    console.error(`[mesh:event] ${event.type} ${JSON.stringify(redactSensitiveData(event))}`);
  });
  mesh.onQuery(async (query) => {
    const result = await agent.chat(`mesh-${Date.now()}`, query);
    return result.response || '(no response)';
  });
  await mesh.start();
  await mesh.announce();
  if (isMeshVerboseEnabled()) {
    console.error(`[mesh] Agent mesh started on port ${meshPort} (id: ${meshId})`);
    console.error(`[mesh] Listen host: ${meshListenHost || '127.0.0.1'}`);
    console.error(`[mesh] Shared secret: ${meshSharedSecret ? 'configured' : 'not configured'}`);
    console.error(`[mesh] Incoming queries: ${allowIncoming ? 'ALLOWED' : 'BLOCKED'} (set MOSS_MESH_ALLOW_INCOMING=false to block)`);
    if (meshPeers.length) console.error(`[mesh] Known peers: ${meshPeers.map((p) => `${p.host}:${p.port}`).join(', ')}`);
  }
  for (const tool of createMeshTools(mesh)) agent.tools.register(tool);
  try {
    const discovery = new LanDiscovery({ mesh, meshPort, agentId: meshId, agentName: meshName, sharedSecret: meshSharedSecret });
    discovery.onNewPeer((peer) => {
      if (isMeshVerboseEnabled()) {
        console.error(`\n[mesh] 🔗 New peer discovered: ${peer.name} (${peer.host}:${peer.port})`);
        if (peer.deviceInfo) console.error(`[mesh]    Device: ${peer.deviceInfo}`);
      }
    });
    await discovery.start();
    if (isMeshVerboseEnabled()) console.error(`[mesh] LAN auto-discovery active (UDP broadcast on port 9091)`);
  } catch (err) {
    console.error(`[mesh] LAN discovery unavailable: ${errorMessage(err)}`);
  }
}


function createMockLLMProvider(): LLMProvider {
  const mockText = 'Mock mode — no live LLM. Tools are available for testing. Start a conversation to see tool approvals and plan flows.';
  return {
    id: 'mock',
    displayName: 'Mock (offline)',
    capabilities: { streaming: true },
    complete: async (_options: LLMRequestOptions): Promise<LLMResponse> => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: mockText }],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    stream: async (_options: LLMRequestOptions, onEvent: (event: LLMStreamEvent) => void): Promise<LLMResponse> => {
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
    try { execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* best-effort UTF-8 */ }
  }

  const fallbackStartDir = parsedArgs.configOverrides.workspace || process.env.MOSS_WORKSPACE || safeProcessCwd(process.env);

  // Determine the initialization phase needed for this command
  const requiredPhase = getPhaseForCommand(parsedArgs.command);
  const commandConfig = getCommandConfig(parsedArgs.command);

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
    const resolvedConfig = resolveCliConfig(process.env, loadedConfig.config, parsedArgs.configOverrides, loadedConfig);

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
    const resolvedConfig = resolveCliConfig(process.env, loadedConfig.config, parsedArgs.configOverrides, loadedConfig);
    const workspace = resolvedConfig.workspace as string;

    let workspaceStat: fs.Stats;
    try {
      workspaceStat = fs.statSync(workspace);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`[moss] workspace path does not exist: ${workspace}`);
        console.error('Pass an existing directory with -C/--cd, or run moss from inside your project.');
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
  const resolvedConfig = resolveCliConfig(process.env, loadedConfig.config, parsedArgs.configOverrides, loadedConfig);
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
      '(change with moss setup / moss config set)',
    );
  }
  const safetyMode = parsedArgs.safetyModeOverride ?? resolvedConfig.safetyMode ?? resolveCliSafetyMode(argv);
  // Apply startup interaction mode from --plan / --accept-edits flags.
  if (parsedArgs.interactionModeOverride) {
    setCliInteractionMode(parsedArgs.interactionModeOverride);
    if (cliDetailForNotices !== 'quiet') {
      const modeLabels: Record<string, string> = { plan: 'plan (dry-run)', acceptEdits: 'accept-edits' };
      console.error(`[moss] Interaction mode: ${modeLabels[parsedArgs.interactionModeOverride] || parsedArgs.interactionModeOverride}`);
    }
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
      console.error('Pass an existing directory with -C/--cd, or run moss from inside your project.');
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
  const sessionCommand: 'chat' | 'resume' | 'fork' =
    parsedArgs.command === 'resume' || parsedArgs.command === 'fork'
      ? parsedArgs.command
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
      console.error(`[session] No saved sessions to ${parsedArgs.command} in this workspace (${workspace}).`);
      console.error('[session] Start one with `moss`, then use `moss resume --last`.');
      process.exit(ExitCode.SESSION);
    }
  }

  if (!resolvedConfig.apiKey && !parsedArgs.mock) {
    const guidance = { bundledDefaultSuppressedBy: resolvedConfig.bundledDefaultSuppressedBy };
    if (process.stdin.isTTY && !oneShotMessage) {
      await offerSetupForInteractiveMissingConfig(guidance);
      return;
    }
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
      console.error('[moss] No API key configured. Run `moss setup` or set MOSS_API_KEY.');
    }
    process.exit(ExitCode.CONFIG);
  }

  if (parsedArgs.mock) {
    console.error('[mock] Offline mock mode — no live LLM, no API key required.');
    console.error('[mock] Tools and approval flows are available for testing.');
  }

  const configDir = resolveConfigDir();
  const communityAuth = await loadStoredCommunityAuth(configDir);
  const providerConfig: CliProviderRuntimeConfig = { ...resolvedConfig, communityAuth };
  const communityAuthRuntime = createCommunityAuthRuntime(providerConfig, configDir);

  const sessionStore = earlySessionStore ?? new JsonlSessionStore({ dir: workspacePathMigration.paths.sessionsDir });
  const session = await resolveCliSession({
    command: sessionCommand,
    store: sessionStore,
    sessionKey: parsedArgs.sessionKey,
    useLast: parsedArgs.sessionLast || continueLatest,
    forkSource: parsedArgs.forkSource,
  });
  if (session.error) {
    console.error(`[session] ${session.error}`);
    console.error('[session] List saved sessions with `moss sessions`, or start a new one with `moss`.');
    process.exit(ExitCode.SESSION);
  }
  if (session.notice) console.error(`[session] ${session.notice}`);
  const memoryManager = new MemoryManager(workspacePathMigration.paths.memoryDir);
  const skillLearner = new SkillLearner({ skillsDir: workspacePathMigration.paths.skillsDir });
  const skillPipeline = new SkillPipeline({ workspaceDir: workspace, model });
  // Codex hierarchical AGENTS.md: root → cwd path + optional global user file.
  // Claude Code: CLAUDE.md candidates. AGENTS.override.md preferred per directory.
  const globalAgentsPath = path.join(configDir, 'AGENTS.md');
  const workspaceMemory = new WorkspaceMemory({
    workspaceDir: workspace,
    cwd: process.cwd(),
    globalInstructionPaths: [globalAgentsPath],
  });
  const wsContext = await workspaceMemory.loadContext();
  const wsPromptLayer = workspaceMemory.buildPromptLayer(wsContext);
  // The default-workflow discipline (superpower selection, CodeGraph
  // preference, no-GUI-terminal guard, workspace-data protection, close-the-
  // loop verification) used to be a separate stable layer; it is now folded
  // into the compact agent-behavior contract (buildAgentBehaviorPromptQuick),
  // so it is no longer injected separately here to avoid duplication.
  const extraPromptLayers: string[] = [];
  const envLayer = await buildEnvironmentContextLayer(workspace);
  if (envLayer) extraPromptLayers.push(envLayer);
  if (wsPromptLayer) extraPromptLayers.push(wsPromptLayer);

  const configuredHooks = createConfiguredHookCallbacks(loadedConfig.config.hooks, { workspaceDir: workspace });
  // Resolved early so device-mutation approval cards can show the board target.
  // (A board connected later via /connect falls back to the generic label.)
  const envDeviceConfig = getDeviceConfigFromEnv();
  // The live runtime object board mode mutates in place. /connect and the
  // startup env-device connect both set runtime.deviceSession.boardMode here;
  // the approval hook closes over a getter so it observes those flips without
  // being recreated (it is created once, below).
  const liveRuntime: CliRuntimeStatus = { device: null, deviceSession: null };
  const approvalHook = createCliToolApprovalHook(safetyMode, process.env, {
    approvalPolicy: resolvedConfig.approvalPolicy,
    trustedTools: resolvedConfig.trustedTools,
    deniedTools: resolvedConfig.deniedTools,
    workspaceDir: workspace,
    device: envDeviceConfig ? { host: envDeviceConfig.host, user: envDeviceConfig.user, port: envDeviceConfig.port } : null,
    boardMode: () => liveRuntime.deviceSession?.boardMode === true,
    // /yolo flips liveRuntime.fullPower → session becomes full-access + no prompt.
    safetyModeOverride: () => (liveRuntime.fullPower ? 'full-access' : undefined),
    autoApprove: () => liveRuntime.fullPower === true,
    interactionMode: () => getCliInteractionMode(),
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
    enrichToolContext: (ctx) => ({ ...ctx, workspaceDir: workspace }),
    onBeforeToolExec,
    onToolResult: configuredHooks.onToolResult,
  });

  const cliLlmProvider = parsedArgs.mock ? createMockLLMProvider() : createCliProvider(providerConfig);

  // Initialize observability (OTel tracing + metrics + local file trace) based on env.
  // No-op when MOSS_OTEL_ENABLED is unset and MOSS_OTEL_URL absent.
  initObservability({ workspaceDir: workspace });

  const agent = new MossAgent({
    llmProvider: cliLlmProvider, sessionStore, model,
    workspaceDir: workspace,
    recordLlmUsage: true,
    llmUsageLogPath: resolveLLMUsageLogPath({ workspaceDir: workspace }),
    // Keep the Moss persona, but name the actual model so the agent can answer
    // "which model are you?" honestly instead of substituting "Moss".
    baseSystemPrompt: resolveSoulIdentity({ configDir, workspaceDir: workspace, model, usingBundledDefault: resolvedConfig.usingBundledDefault }),
    enableToolOutputTruncation: true, extraPromptLayers, skillPipeline,
    // Coding is the primary CLI workload. Inject the compact software-
    // engineering domain prompt into the stable system prompt so every coding
    // turn gets "read before edit → minimal verifiable change → close the loop"
    // without paying for the long robotics engineering block.
    // Robotics stays per-turn only when the turn shows a robotics signal
    // (detectRoboticsDomainContext in oneshot/TUI). Core remains host-neutral:
    // domainPrompt === undefined still injects robotics for other hosts.
    domainPrompt: () => buildSoftwareEngineeringPromptQuick(),
    // Soft coding gates: incomplete todos, missing real verification, red
    // verification + success claim, unresolved tool failures. Injects a
    // correction turn (does not buffer streaming — see shouldBufferAssistantOutput).
    completionGate: createCliCompletionGate(undefined, {
      onReject: (decision) => {
        if (cliDetailForNotices === 'quiet') return;
        const reason = decision.reason || 'correction';
        process.stderr.write(`↻ completion gate: ${reason}\n`);
      },
    }),
    memoryContextProvider: () => memoryManager.buildDigest(),
    ...resolveCliAgentRuntimeOptions(resolvedConfig),
    // Let a sub-agent's model override resolve the correct context window for
    // the overridden model (provider API probe -> name-pattern fallback), so
    // compaction/pruning inside the sub-agent uses the right window. Core
    // can't do provider probes, so the CLI injects this resolver.
    resolveModelContextTokens: (m: string) => resolveContextTokensForModel({
      model: m,
      ...(resolvedConfig.baseUrl ? { baseUrl: resolvedConfig.baseUrl } : {}),
      ...(resolvedConfig.apiKey ? { apiKey: resolvedConfig.apiKey } : {}),
      ...(resolvedConfig.provider ? { provider: String(resolvedConfig.provider) } : {}),
      timeoutMs: 4000,
    }).then((r) => r.contextTokens).catch(() => undefined),
    hooks,
  });
  await registerBuiltinTools(agent);
  // File-based custom tools from .moss/tools/*.tool.json — the lightweight
  // path for users who want a named, schema-validated tool without an MCP
  // server or embedder code.
  for (const tool of loadFileBasedTools(workspace)) agent.tools.register(tool);
  // Lets the agent answer "which model are you?" with the gateway's real backing
  // model instead of the "Moss" billing placeholder (resolved on demand + cached).
  // The getContextTokens getter is dynamic so it reflects the startup-probe result
  // (which may update agent.config.contextTokens after tool registration).
  agent.tools.register(createModelInfoTool({
    provider: () => agent.config.llmProvider,
    config: () => ({
      model: agent.config.model,
      baseUrl: liveRuntime.config?.baseUrl ?? providerConfig.baseUrl,
      usingBundledDefault: liveRuntime.config?.usingBundledDefault ?? providerConfig.usingBundledDefault,
    }),
    getContextTokens: () => agent.config.contextTokens,
    getMaxOutputTokens: () => agent.config.maxTokens,
  }));
  // Replace the default web_fetch with a board-aware one: it waives the private
  // SSRF block ONLY for the connected /connect target (getter → tracks live
  // /connect), so a board's LAN web UI (http://192.168.x.y:port) is reachable
  // while the rest of the private network stays blocked.
  agent.tools.register(createWebFetchTool({
    allowPrivateHosts: () => (liveRuntime.device?.host ? [liveRuntime.device.host] : []),
  }));
  const searchLocale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const searchRegion = /zh|_cn|-cn|\.cn/i.test(searchLocale) ? 'zh-CN' : undefined;
  // Merge the bundled Bocha key with the locale-derived region. The builtin
  // web_search (registered above with the key) is overwritten by this
  // re-registration; without merging the key back in, ToolRegistry.register
  // (overwrite-by-name) silently drops the bundled key and every search falls
  // back to the keyless chain — a packaged/configured key never actually worked.
  agent.tools.register(
    createWebSearchTool({
      ...(searchRegion ? { region: searchRegion } : {}),
      ...(bundledBochaKey ? { bochaApiKey: bundledBochaKey } : {}),
    }),
  );
  const mcpConnections = await registerConfiguredMcpTools(agent, resolvedConfig);

  // Auto-detect CodeGraph when `.codegraph/` exists in the workspace.
  const codeGraphResult = await autoRegisterCodeGraphTools(
    workspace,
    process.stdin.isTTY && !oneShotMessage,
  );
  for (const connection of codeGraphResult.connections) {
    for (const tool of connection.tools) {
      agent.tools.register(tool, `mcp:codegraph`);
    }
    mcpConnections.push(connection);
  }
  if (codeGraphResult.notice && cliDetailForNotices !== 'quiet') {
    // The notice ("CodeGraph is available…") is useful guidance in an
    // interactive TUI session — the user can act on it. In oneshot / piped
    // / scripted modes it's pure noise: the user issued a one-off command
    // and doesn't care about workspace indexing state. Suppress it there.
    const isInteractiveTui = process.stdin.isTTY && !oneShotMessage;
    if (isInteractiveTui) {
      console.error(`[codegraph] ${codeGraphResult.notice}`);
    }
  }

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

  try {
    await configuredHooks.runSessionStart();
    if ((process.env.MOSS_EXEC_BACKEND || 'local') === 'docker') {
      agent.tools.register(createDockerExecTool({ workspaceDir: workspace, image: process.env.MOSS_DOCKER_IMAGE }));
    }
    for (const tool of createMemoryTools(memoryManager)) agent.tools.register(tool);

    const deviceConfig = envDeviceConfig;
    if (process.env.MOSS_MESH_ENABLED === 'true' || parsedArgs.mesh) {
      await setupMesh(agent, deviceConfig);
    }

    if (deviceConfig) {
      // Same verified path as /connect: probe SSH before claiming the device
      // is connected — an env var being set proves nothing about the board.
      const skipVerify = process.env.MOSS_DEVICE_NO_VERIFY === '1' || process.env.MOSS_DEVICE_NO_VERIFY === 'true';
      const mode = process.env.MOSS_DEVICE_HYBRID === '1' || process.env.MOSS_DEVICE_HYBRID === 'true' ? 'hybrid' : 'board';
      if (!skipVerify && cliDetailForNotices !== 'quiet') {
        console.error(`[device] Verifying SSH to ${deviceConfig.user || 'root'}@${deviceConfig.host}:${deviceConfig.port || 22} (set MOSS_DEVICE_NO_VERIFY=1 to skip) ...`);
      }
      // Mutates liveRuntime in place so the approval hook's boardMode getter
      // sees the startup connect, exactly like an in-session /connect.
      const startupConnect = await connectDeviceForSession(agent, liveRuntime, deviceConfig, {
        skipVerify,
        mode,
        locale: process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG,
      });
      console.error(startupConnect.message);
    }

    extraPromptLayers.push(buildRuntimeCapabilitiesPrompt({
      tools: agent.tools.getAll(),
      mcpEnabled: resolvedConfig.mcpEnabled,
      mcpServerNames: mcpConnections.map((connection) => connection.serverName),
    }));

    // If context window was probed (or configured), tell the LLM its actual size
    // so it can answer "how large is your context window?" accurately.  This layer
    // is pushed AFTER the startup probe (which may have updated contextTokens from
    // the unprobed 1M default to the probe value), so the LLM sees the truth.
    if (resolvedConfig.contextTokens) {
      const ctxK = Math.round(resolvedConfig.contextTokens / 1000);
      extraPromptLayers.push(
        `## Context Window\nYour context window is ${ctxK}k tokens. State this number accurately when the user asks about context size — do not guess from training knowledge.`,
      );
    }

    // The skill catalog (name + description for every enabled skill) used to
    // be injected into the STABLE system prompt on every run. It is now
    // injected per turn ONLY when the user asks "what skills do you have?"
    // (see buildSkillCatalogContext in tui-utils, wired in oneshot/TUI) —
    // task-matched skills are already handled by buildMatchedSkillContext, so
    // the full catalog list is dead weight on every non-catalog turn.

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
            await runOneShot(agent, pendingPrompt, skillLearner, {
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
      await runOneShot(agent, oneShotMessage, skillLearner, {
        sessionKey: session.sessionKey,
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
            submitPrompt: (text) => { pendingPrompt = text; },
          };
          const handled = await runRegistryCommand(pipedText, pipedCmdCtx);
          if (handled) {
            if (pendingPrompt) {
              await runOneShot(agent, pendingPrompt, skillLearner, {
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
        await runOneShot(agent, pipedText, skillLearner, {
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
    // Same object the approval hook's boardMode getter reads — so an in-session
    // /connect (which mutates runtime.deviceSession via the command registry)
    // flips board-mode auto-approval live. Preserves the device/deviceSession
    // already set in place by the startup connect.
    Object.assign(liveRuntime, {
      workspace,
      runtimeDir,
      configDir,
      baseUrl,
      execBackend: process.env.MOSS_EXEC_BACKEND || 'local',
      safetyMode,
      dockerImage: process.env.MOSS_DOCKER_IMAGE,
      meshEnabled: process.env.MOSS_MESH_ENABLED === 'true' || parsedArgs.mesh,
      sessionKey: session.sessionKey,
      config: resolvedConfig,
      communityAuth: communityAuthRuntime,
      mcp: mcpConnections.map((connection) => ({
        name: connection.serverName,
        connected: true,
        toolCount: connection.tools.length,
      })),
    });
    await runInteractive(agent, skillLearner, liveRuntime, { sessionKey: session.sessionKey });
  } finally {
    await agent.close();
    await closeMcpConnections(mcpConnections);
    await shutdownObservability();
  }
}

// Flush any in-flight traces/metrics on unexpected exit paths.
process.on('beforeExit', () => { void shutdownObservability(); });

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
    console.error('[moss] Wait a moment and try again. Consider setting a lower model or reducing prompt size.');
    process.exit(code);
  }
  if (code === ExitCode.PROVIDER_UPSTREAM) {
    console.error(`[moss] Provider error: ${message}`);
    console.error('[moss] The upstream API returned an error. Check your network, base URL, and model name.');
    process.exit(code);
  }
  if (code === ExitCode.CONFIG) {
    console.error(`[moss] Configuration error: ${message}`);
    console.error('[moss] Run `moss config show` to inspect settings, or `moss setup` to reconfigure.');
    process.exit(code);
  }

  // Session errors: the user's session data is the problem, not the code.
  if (code === ExitCode.SESSION) {
    console.error(`[moss] Session error: ${message}`);
    console.error('[moss] List saved sessions with `moss sessions`, or start a new one with `moss`.');
    process.exit(code);
  }

  // MCP connection errors: the external MCP server is the problem.
  if (code === ExitCode.MCP_CONNECTION) {
    console.error(`[moss] MCP connection failed: ${message}`);
    console.error('[moss] Check your MCP server configuration with `moss mcp status`.');
    console.error('[moss] Verify the MCP server is running and accessible.');
    process.exit(code);
  }

  // Device SSH errors: the board/device connection failed.
  if (code === ExitCode.DEVICE_SSH) {
    console.error(`[moss] Device connection failed: ${message}`);
    console.error('[moss] Verify the device is reachable and SSH credentials are correct.');
    console.error('[moss] Set MOSS_DEVICE_NO_VERIFY=1 to skip the pre-flight SSH check.');
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
  console.error('  2. If the problem persists, report it at: https://github.com/D-Robotics/moss/issues');
  if (err instanceof Error && err.stack) {
    console.error('');
    console.error('Technical details (for bug reports):');
    console.error(err.stack);
  }
  process.exit(code);
});
