import path from 'node:path';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import {
  loadMergedPromptHistory,
  promptHistoryFile,
  savePromptHistory,
} from './tui/prompt-history.js';
import type { MossAgent, MossAgentEvent } from '../core/index.js';
import { setCliApprovalAsker } from './approval.js';
import { noteKnownSecret } from '../safety/known-secrets.js';
import { wrapApprovalAsker } from './permission-request.js';
import { handleCompactCommand } from './compact-command.js';
import {
  formatDiffRunFailure,
  formatNotGitRepository,
  runRegistryCommand,
  unknownSlashCommandLines,
  type ChecklistItem,
} from './commands/registry.js';
import {
  isSlashCommandInput,
  slashHead,
  loadCustomCommands,
  reservedBuiltinNames,
  resolveUserCommand,
  skillSlashToken,
} from './commands/custom-commands.js';
import { closestSlashCommands } from './command-completion.js';
import { DISPATCHABLE_SLASH_COMMANDS } from './interactive-commands.js';
import { formatBackgroundJobLines } from './commands/background-jobs.js';
import {
  abandonLiveGoal,
  acceptanceProposalLines,
  GOAL_USAGE,
  goalResumeDispatchArgs,
  resumeEchoLine,
  goalRunArgs,
  planGoalInvocation,
  resolveLoopMaxIterations,
  skippedAcceptanceNotice,
} from './commands/goal-propose.js';
import {
  INTERACTIVE_COMPLETION_COMMANDS,
  rewriteSlashInput,
  SLASH_MENU_ROWS,
  slashAliasHelpLines,
} from './interactive-commands.js';
import { isResumableTaskPhase } from '../contracts/task-runtime.js';
import { expandMcpResourceMentions, type McpResourceReader } from './mcp-resource-mentions.js';
import { cliLocale } from './cli-locale.js';
import { listBackgroundProcessSnapshots } from '../core/tools/background-process-registry.js';
import { CliServices } from './cli-services.js';
import { resolveRealModel } from './model-resolution.js';
import {
  resolveContextTokensForModel,
  splitModelCustomFlag,
  unavailableModelNote,
} from './model-catalog.js';
import { writePreferredModel } from './preferred-model-store.js';
import { createCliProvider, normalizeProviderForRuntime } from './providers.js';
import { runOneShot } from './oneshot.js';
import { messageRequestsTaskContract } from './task-flow.js';
import { createSessionUsageAccumulator } from './session-usage.js';
import { createCliRunRenderer } from './output.js';
import { renderCliInteractiveHelp, renderCliWelcome, type CliRuntimeStatus } from './onboarding.js';
import { createCliSessionKey, selectSessionForResume } from './session.js';
import { compactPath, label, ui } from './ui.js';
import { runWorkingTreeDiff } from '../utils/git-spawn.js';
import { formatLocalCommandOutput } from './tui-utils.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import type { RewindResult } from './file-checkpoint.js';
import { errorMessage } from '../errors.js';
import { interruptNoticeLine, isUserAbortErrorText, tui } from './tui/copy.js';
import { renderPausedGoalLines, type PausedGoalCandidate } from './goal-pause.js';

let currentModel = '';

/**
 * B17: one REPL turn had no interrupt path. readline owns stdin, and only the
 * headless runs installed a SIGINT bridge, so Esc/Ctrl+C did nothing until the
 * turn finished. This owns SIGINT plus a lone ESC byte for the duration of one
 * run and hands the run an AbortSignal. Arrow/function keys arrive as one
 * multi-byte escape chunk, so only an exact single-byte chunk counts as Esc.
 */
async function runReplTurn(
  agent: MossAgent,
  message: string,
  options: {
    sessionKey: string;
    onAgentEvent: (event: MossAgentEvent) => void;
    taskFlow: boolean;
    /** readline turns ^C into its own SIGINT event instead of a process signal. */
    readline?: {
      on(event: 'SIGINT', listener: () => void): unknown;
      off(event: 'SIGINT', listener: () => void): unknown;
    };
    /** D4: readers for `@server:uri` resource mentions (undefined = no MCP). */
    readMcpResource?: McpResourceReader['read'];
    /** B125: one-shot context held over from the last autonomous run. */
    extraContext?: string;
  }
): Promise<Awaited<ReturnType<typeof runOneShot>>> {
  const controller = new AbortController();
  const onSigInt = (): void => {
    // A second Ctrl+C is the hard-stop escape hatch for an uncooperative provider.
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  const onStdinData = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (bytes.length === 1 && bytes[0] === 0x1b) controller.abort();
  };
  process.on('SIGINT', onSigInt);
  options.readline?.on('SIGINT', onSigInt);
  process.stdin.on('data', onStdinData);
  try {
    // D4: `@server:uri` mentions attach MCP resources before the turn starts.
    const { readMcpResource, ...runOptions } = options;
    const mention = await expandMcpResourceMentions(message, { read: readMcpResource });
    for (const line of mention.notes) console.error(line);
    const extraContext = [options.extraContext, mention.extraContext]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    return await runOneShot(agent, message, {
      ...runOptions,
      ...(extraContext ? { extraContext } : {}),
      abortSignal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigInt);
    options.readline?.off('SIGINT', onSigInt);
    process.stdin.off('data', onStdinData);
  }
}

let taskRunInFlight = false;
/** B125: run summary handed to exactly one following chat turn, then dropped. */
let pendingRunContext = '';

export const INTERACTIVE_COMMANDS = [...INTERACTIVE_COMPLETION_COMMANDS];

function applyCustomModelConfigForRepl(
  agent: MossAgent,
  runtime: CliRuntimeStatus | undefined,
  rawConfig: string,
  services: CliServices
): string {
  const configPath = runtime?.config?.configPath ?? services.config.resolveConfigPath();
  const parsed = services.models.parseCustomModelConfigInput(rawConfig);
  if (!parsed.ok)
    return `${parsed.message}\n\n${services.models.formatCustomModelConfigInstructions(configPath)}`;
  const nextConfig = parsed.config;
  const currentConfig = services.config.loadConfigFile(configPath);
  services.config.saveConfigFileAtPath(
    {
      ...currentConfig,
      provider: nextConfig.provider,
      model: nextConfig.model,
      baseUrl: nextConfig.baseUrl,
      apiKey: nextConfig.apiKey,
    },
    configPath
  );

  if (runtime?.config) {
    runtime.config.provider = nextConfig.provider;
    runtime.config.providerSource = 'config';
    runtime.config.model = nextConfig.model;
    runtime.config.modelSource = 'config';
    runtime.config.baseUrl = nextConfig.baseUrl;
    runtime.config.baseUrlSource = 'config';
    runtime.config.apiKey = nextConfig.apiKey;
    runtime.config.apiKeySource = 'config';
    noteKnownSecret(nextConfig.apiKey);
    runtime.config.usingBundledDefault = false;
  }

  currentModel = nextConfig.model;
  agent.switchModel({
    model: nextConfig.model,
    provider: nextConfig.provider,
    baseUrl: nextConfig.baseUrl,
    llmProvider: createCliProvider({
      provider: nextConfig.provider,
      apiKey: nextConfig.apiKey,
      model: nextConfig.model,
      baseUrl: nextConfig.baseUrl,
    }),
    usingBundledDefault: false,
  });

  // Probe the new model's context window so compaction and display reflect the
  // correct limit — same logic as TUI's switchModelForSession (parity fix).
  void (async () => {
    try {
      const detected = await resolveContextTokensForModel({
        model: nextConfig.model,
        ...(nextConfig.baseUrl ? { baseUrl: nextConfig.baseUrl } : {}),
        ...(nextConfig.apiKey ? { apiKey: nextConfig.apiKey } : {}),
        ...(nextConfig.provider ? { provider: nextConfig.provider } : {}),
        timeoutMs: 4000,
      });
      agent.config.contextTokens = detected.contextTokens;
      if (runtime?.config) runtime.config.contextTokens = detected.contextTokens;
    } catch {
      // Best-effort — name-matching fallback already ran during config load.
    }
  })();

  return [
    `[config] Custom model configured: ${nextConfig.model} (${nextConfig.provider})`,
    `[config] Saved to ${configPath}`,
  ].join('\n');
}

export function completeInteractiveCommand(line: string): [string[], string] {
  const hits = INTERACTIVE_COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
}

export async function runInteractive(
  agent: MossAgent,
  runtime?: CliRuntimeStatus,
  options: {
    sessionKey?: string;
    services?: CliServices;
    /** Discovered skills (name+description) for /skills; omitted when none. */
    skills?: Array<{ name: string; description: string; issues?: number }>;
  } = {}
) {
  const services = options.services ?? new CliServices();
  const usage = createSessionUsageAccumulator();
  /** Latest todo_write checklist, shown by `/todos` (live, not from the store). */
  let liveTodos: ChecklistItem[] = [];
  // The registry command asks the host for this instead of re-reading the
  // session store, which lags the turn that is still running.
  const trackTodos = (event: MossAgentEvent): void => {
    if (event.type !== 'tool_start' || event.toolName !== 'todo_write') return;
    const raw = event.input.todos;
    if (!Array.isArray(raw)) return;
    liveTodos = raw.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.content !== 'string' || typeof record.status !== 'string') return [];
      return [{ content: record.content, status: record.status }];
    });
  };
  const recordAgentEvent = (event: MossAgentEvent): void => {
    usage.record(event);
    trackTodos(event);
  };
  currentModel = agent.config.model || currentModel;
  const workspace = runtime?.workspace || process.cwd();
  let sessionKey = options.sessionKey || createCliSessionKey();

  const runtimeDir = runtime?.runtimeDir ?? path.join(workspace, '.moss', 'runtime');
  let checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
  /**
   * Open a checkpoint with the stored message count so `/rewind` can drop the
   * turn from the LLM context too (Claude's "restore code and conversation").
   * A failed count must not block the turn: the file restore still works.
   */
  const openCheckpoint = async (label: string): Promise<void> => {
    let messageCount = 0;
    try {
      messageCount = await agent.countSessionMessages(sessionKey);
    } catch {
      messageCount = 0;
    }
    checkpointStore.open(label, messageCount);
  };
  /**
   * `/rewind` restores files and, when the checkpoint recorded a message count,
   * drops the turn from the LLM context as well — Claude Code's "restore code
   * and conversation" in one step. A failed truncation is reported, never
   * silently pretended: the files are already back.
   */
  const rewindConversationAt = async (result: RewindResult): Promise<void> => {
    if (result.messageCount === undefined) return;
    try {
      const { truncated } = await agent.rewindConversation(sessionKey, result.messageCount);
      console.error(
        truncated > 0
          ? `[rewind] Dropped ${truncated} message(s) from the LLM context: this turn is no longer remembered.`
          : '[rewind] LLM context was already at or before this checkpoint.'
      );
    } catch (err) {
      console.error(
        `[rewind] Files are restored, but the conversation could not be rewound: ${errorMessage(err)}`
      );
    }
  };

  const parsePatchPaths = (patch: string): string[] => {
    const out: string[] = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
      out.push(m[1].trim());
    return out;
  };

  agent.registerPreToolHook({
    name: 'repl-checkpoint',
    priority: 5,
    async check({ tool, input }) {
      for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
        checkpointStore.trackBeforeWrite(p);
      }
      return null;
    },
  });
  agent.registerPostToolHook({
    name: 'repl-checkpoint-after',
    priority: 5,
    async process({ tool, input }) {
      for (const p of checkpointTargetPaths(tool.name, input, workspace, parsePatchPaths)) {
        checkpointStore.noteAfterWrite(p);
      }
      return null;
    },
  });

  const customCommands = loadCustomCommands(
    {
      workspace,
      configDir: runtime?.configDir ?? services.config.resolveConfigDir(),
      reservedNames: reservedBuiltinNames(),
    },
    (msg) => console.warn(`[moss] ${msg}`),
    cliLocale()
  );
  // B123: the run window owns stdin. The readline async iterator keeps reading
  // input even while `rl.pause()` is set, so a keystroke meant for a run-scoped
  // question (`> 2`) used to be queued and replayed as a phantom chat prompt
  // once the run ended (proved by `.moss/prompt-history.jsonl` containing the
  // answer). Route bytes through one owner: the question reader, the run (which
  // ignores ordinary typing, Ctrl+C is handled separately), or readline.
  // readline puts its input stream into raw mode when it looks like a TTY (Esc
  // and arrow-key handling depend on it), so the router stream mirrors stdin's
  // terminal identity instead of hiding it behind a plain PassThrough.
  const stdinIsTTY = Boolean(process.stdin.isTTY);
  const replInput = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  replInput.isTTY = stdinIsTTY;
  if (stdinIsTTY) {
    replInput.setRawMode = (mode: boolean) => {
      process.stdin.setRawMode?.(mode);
    };
    Object.defineProperty(replInput, 'isRaw', {
      get: () => Boolean(process.stdin.isRaw),
    });
  }
  let questionPending = 0;
  let runInputHinted = false;
  const routeReplStdin = (chunk: Buffer): void => {
    if (questionPending > 0) return;
    if (taskRunInFlight) {
      if (!runInputHinted) {
        runInputHinted = true;
        process.stderr.write(
          `${ui.dim(
            cliLocale() === 'zh'
              ? '（运行期间的键入被忽略：Ctrl+C 暂停；被提问时会出现 > 提示）'
              : '(input ignored while the run owns the terminal — Ctrl+C pauses; a question shows a > prompt)'
          )}\n`
        );
      }
      return;
    }
    replInput.write(chunk);
  };
  process.stdin.on('data', routeReplStdin);
  process.stdin.once('end', () => replInput.end());
  const rl = readline.createInterface({
    input: replInput,
    output: process.stderr,
    prompt: '\n› ',
    completer: completeInteractiveCommand,
  });
  // The TUI recalls prompts across sessions; the REPL used to start every
  // session with an empty history, so Up only reached this run. Seed readline's
  // history (newest first) from the same workspace/config files.
  const promptHistoryFiles = (() => {
    const workspaceFile = promptHistoryFile(getMossWorkspacePaths(workspace).runtimeDir);
    const configDir = runtime?.configDir;
    return configDir ? [promptHistoryFile(configDir), workspaceFile] : [workspaceFile];
  })();
  const seededHistory = loadMergedPromptHistory(promptHistoryFiles);
  if (seededHistory.length > 0) {
    // `history` is a documented readline.Interface field that @types/node does
    // not declare here.
    (rl as unknown as { history: string[] }).history = [...seededHistory].reverse();
  }
  const rememberPrompt = (text: string): void => {
    if (!text) return;
    for (const file of promptHistoryFiles) savePromptHistory(file, [text]);
  };
  setCliApprovalAsker(
    wrapApprovalAsker(
      (question) =>
        new Promise((resolve) => {
          const onSigint = () => {
            rl.off('SIGINT', onSigint);
            resolve('');
          };
          rl.once('SIGINT', onSigint);
          rl.question(question, (answer) => {
            rl.off('SIGINT', onSigint);
            resolve(answer);
          });
        })
    )
  );

  console.error(renderCliWelcome(agent, { ...runtime, sessionKey }));
  console.error(
    ui.dim(`${label('directory')} ${compactPath(workspace)}   ${label('exit')} Ctrl+D or /quit`)
  );
  console.error(
    ui.dim(`${label('status')} Ready. Type a prompt and press Enter, or /help for commands.`)
  );
  rl.prompt();

  let pendingGoal: { goal: string } | null = null;

  for await (const line of rl) {
    let msg = line.trim();
    if (!msg) {
      rl.prompt();
      continue;
    }
    rememberPrompt(msg);
    if (pendingGoal && !isSlashCommandInput(msg)) {
      const goal = pendingGoal.goal;
      pendingGoal = null;
      if (/^n$/i.test(msg)) {
        console.error(skippedAcceptanceNotice());
        msg = `/task ${goalRunArgs(goal)}`;
      } else {
        msg = `/task ${goalRunArgs(goal, { acceptance: msg })}`;
      }
    } else if (isSlashCommandInput(msg)) {
      pendingGoal = null;
      const rewritten = rewriteSlashInput(msg, cliLocale());
      if (rewritten.suggestion) {
        if (rewritten.migration) console.error(rewritten.migration);
        rl.prompt();
        rl.write(rewritten.suggestion);
        continue;
      }
      if (rewritten.migration) console.error(rewritten.migration);
      msg = rewritten.text;
    }
    if (msg === '/quit' || msg === '/exit') break;

    if (msg.startsWith('/')) {
      let pendingPrefill: string | null = null;
      let pendingSubmit: string | null = null;
      const handled = await runRegistryCommand(
        msg,
        {
          agent,
          runtime,
          sessionKey,
          workspace,
          locale: cliLocale(),
          surface: 'repl',
          say: (_kind, text) => console.error(text),
          prefillInput: (text) => {
            pendingPrefill = text;
          },
          getSessionUsage: () => usage.summary(),
          getTodos: () => liveTodos,
          getContextUsage: () => usage.latestContextUsage(),
          getCompactionHistory: () => usage.compactionHistory(),
          submitPrompt: (text) => {
            pendingSubmit = text;
          },
        },
        customCommands
      );
      if (handled) {
        const submitText: string | null = pendingSubmit;
        if (submitText) {
          await openCheckpoint(`custom: ${String(submitText).slice(0, 60)}`);
          const stop = await runReplTurn(agent, String(submitText), {
            sessionKey,
            onAgentEvent: (event) => recordAgentEvent(event),
            taskFlow: messageRequestsTaskContract(String(submitText)),
            readline: rl,
            ...(runtime?.mcpResources ? { readMcpResource: runtime.mcpResources.read } : {}),
          });
          // O165: a fatal (throwing) Stop hook is terminal — no continuation.
          if (stop?.blocked && !stop.fatal) {
            const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
            await runOneShot(agent, feedback, {
              sessionKey,
              onAgentEvent: (event) => recordAgentEvent(event),
              taskFlow: messageRequestsTaskContract(feedback),
            });
          }
        }
        rl.prompt();
        if (pendingPrefill) rl.write(pendingPrefill);
        continue;
      }
    }

    if (msg === '/help' || msg === '/help --all') {
      console.error(renderCliInteractiveHelp());
      if (msg === '/help --all') console.error(slashAliasHelpLines(cliLocale()).join('\n'));
      if (customCommands.length) {
        console.error(`\n  Custom commands (.moss/commands/*.md)`);
        for (const command of customCommands) {
          console.error(`    ${command.name.padEnd(18)} ${command.summary}`);
        }
      }
      rl.prompt();
      continue;
    }

    if (
      msg === '/rewind' ||
      msg === '/undo' ||
      msg.startsWith('/rewind ') ||
      msg.startsWith('/undo ')
    ) {
      const arg = msg.split(/\s+/, 2)[1]?.trim();
      const isUndo = msg === '/undo' || msg.startsWith('/undo ');
      if (arg && !/^\d+$/.test(arg)) {
        console.error(
          '[rewind] Usage: /rewind [seq] — pass a checkpoint number from /rewind with no argument.'
        );
        rl.prompt();
        continue;
      }

      if (isUndo && !arg) {
        const list = checkpointStore.list();
        if (list.length === 0) {
          console.error('[undo] No checkpoints to undo.');
        } else {
          const last = list[list.length - 1];
          const result = checkpointStore.rewindTo(last.seq);
          if (!result.found) {
            console.error(`[undo] Checkpoint ${last.seq} not found.`);
          } else {
            console.error(
              `[undo] Reverted ${result.restored.length} file(s) from checkpoint ${last.seq} (${last.label}).`
            );
            for (const p of result.restored) console.error(`  ✓ ${p}`);
            if (result.skipped.length) {
              console.error(
                `[undo] Skipped ${result.skipped.length} file(s) to protect external changes:`
              );
              for (const p of result.skipped) console.error(`  ⊘ ${p}`);
            }
            await rewindConversationAt(result);
          }
        }
      } else if (arg) {
        const seq = parseInt(arg, 10);
        const result = checkpointStore.rewindTo(seq);
        if (!result.found) {
          console.error(`[rewind] Checkpoint ${seq} not found.`);
        } else {
          console.error(
            `[rewind] Restored ${result.restored.length} file(s) to checkpoint ${seq}.`
          );
          for (const p of result.restored) console.error(`  ✓ ${p}`);
          if (result.skipped.length) {
            console.error(
              `[rewind] Skipped ${result.skipped.length} file(s) to protect external changes:`
            );
            for (const p of result.skipped) console.error(`  ⊘ ${p}`);
          }
          await rewindConversationAt(result);
        }
      } else {
        const list = checkpointStore.list();
        if (list.length === 0) {
          console.error(
            '[rewind] No checkpoints yet. Files are checkpointed each turn when the agent writes.'
          );
        } else {
          console.error(`[rewind] ${list.length} checkpoint(s):`);
          for (const cp of list) {
            console.error(
              `  seq=${cp.seq}  [${new Date(cp.ts).toLocaleTimeString()}] ${cp.label}  (${cp.fileCount} files)`
            );
          }
          console.error(
            '[rewind] Run `/rewind <seq>` to restore, or `/undo` to undo the last checkpoint.'
          );
        }
      }
      rl.prompt();
      continue;
    }

    if (msg === '/compact' || msg.startsWith('/compact ')) {
      const compactInstructions = msg.slice('/compact'.length).trim() || undefined;
      try {
        console.error(await handleCompactCommand(agent, sessionKey, compactInstructions));
      } catch (err) {
        console.error(`[compact] ${errorMessage(err)}`);
        console.error(
          '[compact] You can keep chatting; try /status --verbose to inspect context, or ask Moss to summarize the current session manually.'
        );
      }
      rl.prompt();
      continue;
    }

    if (msg === '/resume' || msg.startsWith('/resume ')) {
      const query = msg.slice('/resume'.length).trim();
      try {
        const selected = await selectSessionForResume(agent.config.sessionStore, query);
        console.error(selected.notice);
        if (selected.sessionKey && selected.sessionKey !== sessionKey) {
          sessionKey = selected.sessionKey;
          checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
        }
      } catch (err) {
        console.error(`[resume] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/tasks') {
      const subagents = (agent.asyncTasks?.list() ?? []).map((task) => ({
        taskId: task.taskId,
        status: task.status,
      }));
      console.error(
        formatBackgroundJobLines({
          processes: listBackgroundProcessSnapshots(),
          subagents,
        }).join('\n')
      );
      rl.prompt();
      continue;
    }

    if (msg === '/skills') {
      // D10 parity: `moss skill list` and `/skills` must report the same numbers
      // (scope, real usage, per-entry catalog cost, eval presence). The shared
      // renderer already existed; this surface used to print its own narrower row.
      const { renderSkillsList } = await import('./skill-commands.js');
      const configDir = runtime?.configDir ?? services.config.resolveConfigDir();
      for (const line of (
        await renderSkillsList(workspace, configDir, undefined, agent.config.contextTokens)
      ).split('\n')) {
        console.error(line);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/mcp' || msg.startsWith('/mcp ')) {
      // MCP statuses used to be TUI-only; the REPL answered `/mcp` with an
      // unknown-command error. Same wording as the TUI rows.
      const { formatMcpStatusLine } = await import('./rdk-docs-mcp.js');
      const servers = runtime?.listMcpServers?.() ?? [];
      console.error('MCP');
      if (servers.length === 0) {
        console.error(
          cliLocale() === 'zh'
            ? '  未配置 MCP 服务器（moss mcp add <name> <command>，或编辑 .moss/mcp.json）'
            : '  no MCP servers configured (moss mcp add <name> <command>, or .moss/mcp.json)'
        );
      } else {
        for (const server of servers) console.error(`  ${formatMcpStatusLine(server)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/hooks' || msg.startsWith('/hooks ')) {
      // The hooks view used to be TUI-only; a readline REPL user could not see
      // which hook fires on what. Shared formatter + the never-fires warnings.
      const { formatHookViewLines } = await import('./hooks-view.js');
      const hooks = runtime?.hooksConfig;
      const lines = formatHookViewLines(hooks, {
        zh: cliLocale() === 'zh',
        knownToolNames: agent.tools.getAll().map((tool) => tool.name),
        ...(runtime?.configDir ? { configDir: runtime.configDir } : {}),
      });
      console.error('Hooks');
      for (const line of lines) console.error(`  ${line}`);
      rl.prompt();
      continue;
    }

    if (msg === '/paste' || msg.startsWith('/paste ')) {
      // Ctrl+V needs the TUI composer; the readline REPL offers the same gesture
      // as a command: capture the clipboard, stage it under .moss/runtime/
      // attachments, and turn the mention into the message the model gets
      // ("@<path> <rest>"), so read_image can open it.
      const { captureClipboardAttachment, formatAttachmentMention } =
        await import('./clipboard-attachment.js');
      const rest = msg === '/paste' ? '' : msg.slice('/paste'.length).trim();
      const capture = await captureClipboardAttachment({ workspaceDir: workspace });
      if (capture.kind === 'image') {
        console.error(
          ui.dim(
            tui('attached {name} ({size}) — ask moss to read_image it', {
              name: path.basename(capture.relPath),
              size: `${Math.max(1, Math.round(capture.bytes / 1024))} KB`,
            })
          )
        );
        msg = `${formatAttachmentMention(capture.relPath)}${rest ? ` ${rest}` : ''}`;
      } else if (capture.kind === 'text') {
        console.error(ui.dim(tui('pasted clipboard text')));
        msg = `${rest}${rest ? '\n' : ''}${capture.text}`;
      } else {
        console.error(ui.yellow(`[moss] ${capture.reason}`));
        rl.prompt();
        continue;
      }
    }

    if (msg === '/rules' || msg.startsWith('/rules ')) {
      const { collectRuleRows, renderRulesUsage } = await import('./rules-commands.js');
      const { resolveConfigDir } = await import('./config.js');
      const rows = collectRuleRows({ workspaceDir: workspace, userDir: resolveConfigDir() });
      if (rows.length === 0) {
        console.error(renderRulesUsage(cliLocale() === 'zh'));
      } else {
        console.error('Rules');
        for (const row of rows) {
          const globs = row.globs.length > 0 ? ` [${row.globs.join(', ')}]` : '';
          const description = row.description ? ` — ${row.description}` : '';
          console.error(
            `  ${row.name.padEnd(16)} ${row.activation.padEnd(7)} ${row.scope.padEnd(9)} ${String(row.bytes).padStart(5)}B${globs}${description}`
          );
        }
        console.error(`  (${rows.length} rule(s) · manual rules need @rule:<name>)`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/remember' || msg.startsWith('/remember ')) {
      const fact = msg.slice('/remember'.length).trim();
      const remember = await import('./remember-command.js');
      if (fact === '') {
        console.error(remember.renderRememberUsage());
        rl.prompt();
        continue;
      }
      const plan = remember.buildRememberPlan(workspace, fact);
      if ('error' in plan) {
        console.error(`/remember: ${plan.error}`);
        rl.prompt();
        continue;
      }
      console.error(remember.renderRememberPreview(plan));
      if (!plan.changed) {
        rl.prompt();
        continue;
      }
      const answer = await new Promise<string>((resolve) => {
        rl.question('Write to AGENTS.md? [y/N] ', (line) => resolve(line.trim()));
      });
      if (!/^y(es)?$/i.test(answer)) {
        console.error('cancelled — nothing written');
        rl.prompt();
        continue;
      }
      const applied = remember.applyRememberPlan(plan);
      if (!applied.ok) console.error(`/remember: ${applied.error}`);
      else
        console.error(
          `wrote ${plan.file} (review: git diff AGENTS.md; a new session loads it automatically)`
        );
      rl.prompt();
      continue;
    }

    if (msg === '/diff' || msg.startsWith('/diff ')) {
      try {
        const result = await runWorkingTreeDiff(workspace);
        const output = formatLocalCommandOutput(result.output);
        if (result.exitCode !== 0) {
          const notRepo = /not a git repository/i.test(output);
          console.error(
            `[diff] ${
              notRepo
                ? formatNotGitRepository('/diff', workspace)
                : formatDiffRunFailure(result.exitCode, output)
            }`
          );
        } else {
          console.error(output.trim() || tui('(no unstaged working-tree changes)'));
        }
      } catch (err) {
        console.error(`[diff] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/clear') {
      liveTodos = [];
      sessionKey = createCliSessionKey();
      checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
      console.error(
        '[clear] new conversation, empty context. The previous one stays on disk — moss --continue'
      );
      rl.prompt();
      continue;
    }

    if (msg === '/model' || msg.startsWith('/model ')) {
      const requested = msg === '/model' ? '' : msg.slice(7).trim();
      const { token: newModel, custom } = splitModelCustomFlag(requested);
      if (newModel === 'config' || newModel.startsWith('config ')) {
        const rawConfig = newModel === 'config' ? '' : newModel.slice('config'.length).trim();
        try {
          console.error(applyCustomModelConfigForRepl(agent, runtime, rawConfig, services));
        } catch (err) {
          console.error(`[config] Could not save model config: ${errorMessage(err)}`);
        }
        rl.prompt();
        continue;
      }

      if (!newModel && runtime?.config?.usingBundledDefault) {
        await resolveRealModel(agent.config.llmProvider, runtime.config);
      }
      const modelChoices = await services.models.loadModelChoicesForRuntime(
        runtime?.config,
        currentModel,
        {
          fallbackProvider: (agent.config as { provider?: string }).provider,
        }
      );
      if (newModel) {
        const unavailable = unavailableModelNote(newModel, modelChoices, undefined, { custom });
        if (unavailable) {
          console.error(`[config] ${unavailable}`);
          rl.prompt();
          continue;
        }
        const selected = services.models.resolveModelSelection(newModel, modelChoices.choices);
        const model = selected?.model ?? newModel;
        const provider = normalizeProviderForRuntime(
          selected?.provider ??
            agent.config.provider ??
            modelChoices.provider ??
            runtime?.config?.provider ??
            'openai-compatible'
        );
        const baseUrl = runtime?.config?.baseUrl || agent.config.baseUrl || '';
        const apiKey = runtime?.config ? runtime.config.apiKey : '';
        const usingBundledDefault =
          runtime?.config?.usingBundledDefault ?? agent.config.usingBundledDefault;
        currentModel = model;
        agent.switchModel({
          model,
          provider,
          ...(baseUrl ? { baseUrl } : {}),
          llmProvider: createCliProvider({
            provider,
            apiKey,
            model,
            baseUrl,
            ...(usingBundledDefault ? { usingBundledDefault: true } : {}),
          }),
          ...(usingBundledDefault !== undefined ? { usingBundledDefault } : {}),
        });
        if (runtime?.config) {
          runtime.config.model = model;
          runtime.config.modelSource = 'cli';

          writePreferredModel(runtime.config.baseUrl, model);
        }
        void (async () => {
          try {
            const detected = await resolveContextTokensForModel({
              model,
              ...(baseUrl ? { baseUrl } : {}),
              ...(apiKey ? { apiKey } : {}),
              provider,
              timeoutMs: 4000,
            });
            agent.config.contextTokens = detected.contextTokens;
            if (runtime?.config) runtime.config.contextTokens = detected.contextTokens;
          } catch {
            // Best-effort — the name-matching fallback already ran during config load.
          }
        })();
        console.error(
          selected
            ? `[config] Model switched to: ${model} (${modelChoices.provider})`
            : `[config] Model switched to custom model: ${model} (${modelChoices.provider})`
        );
      } else {
        console.error(services.models.formatModelChoices(modelChoices));
      }
      rl.prompt();
      continue;
    }

    // `/run` is the everyday "work until" entry. `/loop` only prints a
    // suggestion and does not reach this branch. Clear-words abandon the
    // live task; a missing `--accept` proposes a command from the workspace.
    if (msg === '/run' || msg.startsWith('/run ')) {
      const plan = planGoalInvocation(msg.slice('/run'.length).trim(), workspace);
      if (plan.kind === 'usage') {
        process.stderr.write(`${GOAL_USAGE}\n`);
        rl.prompt();
        continue;
      }
      if (plan.kind === 'clear') {
        process.stderr.write(`${await abandonLiveGoal(workspace)}\n`);
        rl.prompt();
        continue;
      }
      if (plan.kind === 'resume') {
        let taskId = plan.taskId;
        if (!taskId) {
          const { listTaskStateSnapshots } = await import('../core/index.js');
          const resumable = (await listTaskStateSnapshots(workspace))
            .filter((s) => isResumableTaskPhase(s.phase))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (!resumable) {
            process.stderr.write('No resumable task found. Start one with /run <condition>.\n');
            rl.prompt();
            continue;
          }
          taskId = resumable.taskId;
        }
        process.stderr.write(`${resumeEchoLine(taskId, plan, cliLocale() === 'zh')}\n`);
        msg = `/task ${goalResumeDispatchArgs(plan, taskId)}`;
      } else if (plan.kind === 'propose') {
        for (const line of acceptanceProposalLines(plan.goal, plan.candidates)) {
          process.stderr.write(`${line}\n`);
        }
        pendingGoal = { goal: plan.goal };
        rl.prompt();
        rl.write(plan.candidates[0] ?? '');
        continue;
      } else {
        if (plan.notice) process.stderr.write(`${plan.notice}\n`);
        const envMaxTurns = resolveLoopMaxIterations(process.env, true);
        const maxTurns = plan.maxTurns ?? (envMaxTurns > 0 ? envMaxTurns : undefined);
        msg = `/task ${goalRunArgs(plan.goal, {
          ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(plan.maxRepairs !== undefined ? { maxRepairs: plan.maxRepairs } : {}),
        })}`;
      }
    }

    // Task OS M5: unified task runtime entry — one goal in, one verified
    // result out (plan → execute → verify → repair → accept). PASS can only
    // come from the verdict provider, never from the agent's prose. /run
    // translates into this branch above, so every autonomous run streams
    // live through the same renderer too.
    if (msg === '/task' || msg.startsWith('/task ')) {
      const rest = msg.slice('/task'.length).trim();
      const sub = rest.split(/\s+/)[0];
      if (!['run', 'resume', 'status', 'timeline', 'view', 'verify', 'list'].includes(sub ?? '')) {
        const { interactiveTaskUsageLines } = await import('./task-run.js');
        process.stderr.write(`${interactiveTaskUsageLines().join('\n')}\n`);
        rl.prompt();
        continue;
      }
      if (taskRunInFlight) {
        process.stderr.write('A /task is already running in this session.\n');
        rl.prompt();
        continue;
      }
      taskRunInFlight = true;
      rl.pause();
      // Ctrl+C pauses, it does not kill the CLI: the run gets an AbortSignal,
      // the task engine records the interruption and the state stays resumable.
      const taskController = new AbortController();
      let lastAbortAt = 0;
      const abortTask = (): void => {
        if (taskController.signal.aborted) {
          // A second press shortly after the first is usually readline and the
          // raw stdin byte reporting the same Ctrl+C; only a deliberate second
          // press (>=400ms later) is the hard-stop escape hatch.
          if (Date.now() - lastAbortAt >= 400) process.exit(130);
          return;
        }
        lastAbortAt = Date.now();
        taskController.abort();
      };
      // readline is paused, and the terminal is in raw mode during a run, so
      // Ctrl+C arrives as a 0x03 byte rather than SIGINT. Without this listener
      // the run simply ignored Ctrl+C; keep SIGINT for non-raw terminals.
      const onTaskStdin = (chunk: Buffer | string): void => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        if (bytes.includes(0x03)) abortTask();
      };
      process.on('SIGINT', abortTask);
      rl.on('SIGINT', abortTask);
      process.stdin.on('data', onTaskStdin);
      process.stdin.resume();
      const { parseLlmUsageStdout, runTaskCommand, splitCommandArgs } =
        await import('./task-run.js');
      const { formatTurnUsage } = await import('./usage-display.js');
      const taskSessionKey = createCliSessionKey();
      const renderer = createCliRunRenderer({ workspaceDir: workspace, resumeHint: true });
      // readline is paused for the whole run, so the normal approval asker can
      // never resolve: an `ask_user_question` from the agent used to spin until
      // the user hit Ctrl+C. Bind a run-scoped asker that reads stdin directly;
      // a non-TTY run gets `null` and the tool declines so the agent continues.
      const { readStdinLine } = await import('./stdin-line.js');
      const restoreQuestionAsker = agent.setUserQuestionAsker(async (question, signal) => {
        renderer.pauseSpinner();
        process.stderr.write(`\n${question}\n`);
        questionPending += 1;
        try {
          const line = await readStdinLine({
            ...(signal ? { signal } : {}),
            prompt: '> ',
          });
          if (line === null) {
            throw new Error('interactive questions are unavailable in this run');
          }
          return line;
        } finally {
          questionPending -= 1;
        }
      });
      try {
        const code = await runTaskCommand(splitCommandArgs(rest), {
          agent,
          workspace,
          sessionKey: taskSessionKey,
          signal: taskController.signal,
          onAgentEvent: (event) => {
            trackTodos(event as MossAgentEvent);
            renderer.handle(event as MossAgentEvent);
          },
          onOutput: (stream, text) => {
            const usage = stream === 'stdout' ? parseLlmUsageStdout(text) : null;
            if (usage) {
              process.stderr.write(`${formatTurnUsage(usage.inputTokens, usage.outputTokens)}\n`);
              return;
            }
            process[stream].write(text);
          },
        });
        if (code === 2) process.stderr.write('(bad /task arguments — see usage above)\n');
      } catch (err) {
        const message = errorMessage(err);
        process.stderr.write(
          isUserAbortErrorText(message)
            ? `${interruptNoticeLine()}\n`
            : `task run failed: ${message}\n`
        );
      } finally {
        restoreQuestionAsker();
        process.off('SIGINT', abortTask);
        rl.off('SIGINT', abortTask);
        process.stdin.off('data', onTaskStdin);
        // B125: hand the outcome to the next chat turn — the run wrote its own
        // session, so without this the conversation restarts blind.
        const { listTaskStateSnapshots } = await import('../core/index.js');
        const snapshots = await listTaskStateSnapshots(workspace);
        const latest = [...snapshots].sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (latest) {
          const [{ buildTaskStatusJson }, { listTaskEvents }, { formatRunContextNote }] =
            await Promise.all([
              import('./task-run.js'),
              import('../core/task/task-store.js'),
              import('./run-context.js'),
            ]);
          const events = await listTaskEvents(workspace, latest.taskId);
          const status = await buildTaskStatusJson(workspace, latest, events);
          pendingRunContext = formatRunContextNote(status, cliLocale() === 'zh');
        }
        if (taskController.signal.aborted) {
          const resumable = snapshots
            .filter((snapshot) => isResumableTaskPhase(snapshot.phase))
            .sort((left, right) => right.updatedAt - left.updatedAt)[0];
          const candidate: PausedGoalCandidate | null = resumable
            ? { taskId: resumable.taskId, goal: resumable.goal, phase: 'paused' }
            : null;
          for (const line of renderPausedGoalLines(candidate, cliLocale())) {
            process.stderr.write(`${line}\n`);
          }
        }
        // The renderer owns a progress watchdog + spinner; without this the
        // heartbeat kept printing "Still reasoning, waited Ns" at the prompt and
        // its interval kept the process alive after /quit (observed in a PTY).
        renderer.dispose();
        taskRunInFlight = false;
        runInputHinted = false;
        rl.resume();
        rl.setPrompt('\n› ');
        rl.prompt();
      }
      continue;
    }

    if (isSlashCommandInput(msg)) {
      const resolved = resolveUserCommand(msg, {
        builtinNames: reservedBuiltinNames(),
        customCommands,
        skills: options.skills ?? [],
      });
      if (resolved.kind === 'custom' || resolved.kind === 'skill') {
        await openCheckpoint(`${resolved.kind}: ${resolved.prompt.slice(0, 60)}`);
        const stop = await runReplTurn(agent, resolved.prompt, {
          sessionKey,
          onAgentEvent: (event) => recordAgentEvent(event),
          taskFlow: messageRequestsTaskContract(resolved.prompt),
          readline: rl,
          ...(runtime?.mcpResources ? { readMcpResource: runtime.mcpResources.read } : {}),
        });
        // O165: a fatal (throwing) Stop hook is terminal — no continuation.
        if (stop?.blocked && !stop.fatal) {
          const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
          await runOneShot(agent, feedback, {
            sessionKey,
            onAgentEvent: (event) => recordAgentEvent(event),
            taskFlow: messageRequestsTaskContract(feedback),
          });
        }
        rl.prompt();
        continue;
      }
      const suggestions = closestSlashCommands(slashHead(msg), [
        // Hidden builtins still dispatch, so a near miss should name them too.
        ...DISPATCHABLE_SLASH_COMMANDS,
        ...reservedBuiltinNames(),
        ...customCommands.map((command) => command.name),
        ...(options.skills ?? []).flatMap((skill) => {
          const token = skillSlashToken(skill);
          return token ? [token] : [];
        }),
      ]);
      for (const helpLine of unknownSlashCommandLines(msg, {
        suggestions,
        locale: cliLocale(),
      })) {
        console.error(`[help] ${helpLine}`);
      }
      const availableCommands = [
        ...SLASH_MENU_ROWS.map((row) => row.command),
        ...customCommands.map((command) => command.name),
        ...(options.skills ?? []).flatMap((skill) => {
          const token = skillSlashToken(skill);
          return token ? [token] : [];
        }),
      ];
      console.error(`[help] Available: ${availableCommands.join(' ')}`);
      rl.prompt();
      continue;
    }

    await openCheckpoint(msg.slice(0, 60));
    // B125: the note rides exactly one turn, then the conversation owns the rest.
    const carriedRunContext = pendingRunContext;
    pendingRunContext = '';
    const stop = await runReplTurn(agent, msg, {
      sessionKey,
      onAgentEvent: (event) => recordAgentEvent(event),
      taskFlow: messageRequestsTaskContract(msg),
      readline: rl,
      ...(carriedRunContext ? { extraContext: carriedRunContext } : {}),
      ...(runtime?.mcpResources ? { readMcpResource: runtime.mcpResources.read } : {}),
    });
    // O165: a fatal (throwing) Stop hook is terminal — no continuation turn;
    // the run already ended Incomplete with a visible notice.
    if (stop?.blocked && !stop.fatal) {
      // Stop hook vetoed the run ending: one forced continuation turn, then
      // the veto is consumed (a hook that keeps blocking would loop forever).
      const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
      await runOneShot(agent, feedback, {
        sessionKey,
        onAgentEvent: (event) => recordAgentEvent(event),
        taskFlow: messageRequestsTaskContract(feedback),
      });
    }
    rl.prompt();
  }

  agent.unregisterPreToolHook('repl-checkpoint');
  agent.unregisterPostToolHook('repl-checkpoint-after');
  setCliApprovalAsker(null);
  // The router keeps stdin flowing for the whole session; leaving it live held
  // the event loop open after /quit (the CLI never exited in a PTY test).
  process.stdin.off('data', routeReplStdin);
  process.stdin.pause();
  replInput.end();
  rl.close();
}
