import path from 'node:path';
import * as readline from 'node:readline';
import type { MossAgent } from '../core/index.js';
import { setCliApprovalAsker } from './approval.js';
import { handleCompactCommand } from './compact-command.js';
import { resolveLoopMaxIterations } from './loop-tui-events.js';
import { parseGoalCommandLine } from '../core/loop/goal-loop.js';
import { runRegistryCommand, unknownSlashCommandLines } from './commands/registry.js';
import { loadCustomCommands, reservedBuiltinNames } from './commands/custom-commands.js';
import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';
import { CliServices } from './cli-services.js';
import { resolveRealModel } from './model-resolution.js';
import { resolveContextTokensForModel } from './model-catalog.js';
import { writePreferredModel } from './preferred-model-store.js';
import { createCliProvider } from './providers.js';
import { runOneShot } from './oneshot.js';
import { createSessionUsageAccumulator } from './session-usage.js';
import { createCliRunRenderer } from './output.js';
import { renderCliInteractiveHelp, renderCliWelcome, type CliRuntimeStatus } from './onboarding.js';
import { createCliSessionKey } from './session.js';
import { compactPath, label, ui } from './ui.js';
import { formatTuiSessions, runLocalShellCommand } from './tui-utils.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { errorMessage } from '../errors.js';
import { LoopScheduler } from '../core/loop/loop-scheduler.js';

let currentModel = '';

let activeLoopScheduler: LoopScheduler | null = null;
let taskRunInFlight = false;
let goalAcceptanceMirror: ((passed: boolean, exitCode: number, tail: string) => void) | undefined;

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
    runtime.config.usingBundledDefault = false;
  }

  currentModel = nextConfig.model;
  agent.config.model = nextConfig.model;
  (agent.config as { provider?: string; baseUrl?: string }).provider = nextConfig.provider;
  (agent.config as { provider?: string; baseUrl?: string }).baseUrl = nextConfig.baseUrl;
  agent.config.llmProvider = createCliProvider({
    provider: nextConfig.provider,
    apiKey: nextConfig.apiKey,
    model: nextConfig.model,
    baseUrl: nextConfig.baseUrl,
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

function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

export function completeInteractiveCommand(line: string): [string[], string] {
  const hits = INTERACTIVE_COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
}

function basicReplUnsupportedMessage(command: string): string {
  const token = command.split(/\s+/, 1)[0] || command;
  if (token === '/stop' || token === '/abort')
    return '[help] Press Ctrl+C to interrupt the terminal process in this basic REPL.';
  if (token === '/clear')
    return '[help] Use Ctrl+L or your shell `clear` command to clear this terminal.';
  if (token === '/init')
    return '[help] /init is not available in this REPL. Create AGENTS.md in your workspace manually.';
  return '[help] This control is not available in this REPL.';
}

export async function runInteractive(
  agent: MossAgent,
  runtime?: CliRuntimeStatus,
  options: { sessionKey?: string; services?: CliServices } = {}
) {
  const services = options.services ?? new CliServices();
  const usage = createSessionUsageAccumulator();
  currentModel = agent.config.model || currentModel;
  const workspace = runtime?.workspace || process.cwd();
  const sessionKey = options.sessionKey || createCliSessionKey();

  const runtimeDir = runtime?.runtimeDir ?? path.join(workspace, '.moss', 'runtime');
  const checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
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
    (msg) => console.warn(`[moss] ${msg}`)
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n› ',
    completer: completeInteractiveCommand,
  });
  setCliApprovalAsker(
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
  );

  console.error(renderCliWelcome(agent, { ...runtime, sessionKey }));
  console.error(
    ui.dim(`${label('directory')} ${compactPath(workspace)}   ${label('exit')} Ctrl+D or /quit`)
  );
  console.error(
    ui.dim(`${label('status')} Ready. Type a prompt and press Enter, or /help for commands.`)
  );
  rl.prompt();

  const wireLoopScheduler = (sched: LoopScheduler, mode: 'started' | 'resumed'): void => {
    activeLoopScheduler = sched;
    rl.setPrompt('\n[loop] › ');
    sched.on((event) => {
      if (event.type === 'iteration_completed') {
        process.stderr.write(
          `\n[loop ${event.result.iteration}] ${event.result.response.slice(0, 400)}\n`
        );
      } else if (event.type === 'iteration_failed') {
        process.stderr.write(`\n[loop ${event.iteration}] failed: ${event.error.slice(0, 200)}\n`);
      } else if (event.type === 'loop_paused') {
        process.stderr.write(`\nLoop paused at iteration ${event.iteration}: ${event.reason}\n`);
        if (activeLoopScheduler === sched) {
          activeLoopScheduler = null;
          rl.setPrompt('\n› ');
        }
      } else if (event.type === 'loop_completed') {
        process.stderr.write(
          `\nLoop completed: ${event.totalIterations} iteration(s) in ${Math.round(event.totalDurationMs / 1000)}s.\n`
        );
        if (activeLoopScheduler === sched) {
          activeLoopScheduler = null;
          rl.setPrompt('\n› ');
        }
      } else if (event.type === 'loop_aborted') {
        process.stderr.write(`\nLoop aborted at iteration ${event.iteration}.\n`);
        if (activeLoopScheduler === sched) {
          activeLoopScheduler = null;
          rl.setPrompt('\n› ');
        }
      }
    });
    if (mode === 'resumed') {
      process.stderr.write(
        `Loop resumed from saved state (iteration onward). /loop stop waits for the current step.\n`
      );
    }
    void sched.start().catch((err) => {
      process.stderr.write(`Loop error: ${errorMessage(err)}\n`);
      if (activeLoopScheduler === sched) activeLoopScheduler = null;
    });
  };

  for await (const line of rl) {
    const msg = line.trim();
    if (!msg) {
      rl.prompt();
      continue;
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
          checkpointStore.open(`custom: ${String(submitText).slice(0, 60)}`);
          const stop = await runOneShot(agent, String(submitText), {
            sessionKey,
            onAgentEvent: (event) => usage.record(event),
          });
          if (stop?.blocked) {
            await runOneShot(
              agent,
              `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`,
              { sessionKey, onAgentEvent: (event) => usage.record(event) }
            );
          }
        }
        rl.prompt();
        if (pendingPrefill) rl.write(pendingPrefill);
        continue;
      }
    }

    if (msg === '/help') {
      console.error(renderCliInteractiveHelp());
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

    if (msg === '/sessions' || msg === '/session') {
      try {
        const sessions = await agent.config.sessionStore.listSessions();
        console.error(formatTuiSessions(sessions, sessionKey));
      } catch (err) {
        console.error(`[sessions] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/diff' || msg.startsWith('/diff ')) {
      try {
        const result = await runLocalShellCommand({
          command: 'git --no-pager diff --stat && git --no-pager diff',
          cwd: workspace,
        });
        if (result.exitCode !== 0) {
          const notRepo = /not a git repository/i.test(result.output);
          console.error(
            notRepo
              ? `[diff] Not a git repository: ${workspace} — /diff needs a git workspace.`
              : `[diff] git diff failed (exit ${result.exitCode}): ${result.output.trim().split('\n')[0] || 'unknown error'}`
          );
        } else {
          console.error(result.output.trim() || '(no unstaged working-tree changes)');
        }
      } catch (err) {
        console.error(`[diff] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/stop' || msg === '/abort' || msg === '/clear' || msg === '/init') {
      console.error(basicReplUnsupportedMessage(msg));
      rl.prompt();
      continue;
    }

    if (msg === '/model' || msg.startsWith('/model ')) {
      const newModel = msg === '/model' ? '' : msg.slice(7).trim();
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
        const selected = services.models.resolveModelSelection(newModel, modelChoices.choices);
        const model = selected?.model ?? newModel;
        currentModel = model;
        agent.config.model = model;
        if (runtime?.config) {
          runtime.config.model = model;
          runtime.config.modelSource = 'cli';

          writePreferredModel(runtime.config.baseUrl, model);
        }
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

    if (
      msg === '/loop stop' ||
      msg === '/loop abort' ||
      msg === '/goal stop' ||
      msg === '/goal abort'
    ) {
      if (!activeLoopScheduler) {
        process.stderr.write('No /loop or /goal is running.\n');
      } else {
        activeLoopScheduler.abort();
        activeLoopScheduler = null;
        rl.setPrompt('\n› ');
        process.stderr.write('Loop aborted.\n');
      }
      rl.prompt();
      continue;
    }
    if (msg === '/loop resume' || msg === '/goal resume') {
      if (activeLoopScheduler) {
        process.stderr.write('A /loop is already running. Use /loop stop first.\n');
        rl.prompt();
        continue;
      }
      // v0.9 W4: continue the last interrupted/paused autonomous loop from
      // its persisted state (goal, iteration, journal) — completed steps live
      // in the journal + session history and are not redone.
      const restored = await LoopScheduler.restore(agent, workspace, {
        onIterationEvent: (() => {
          const renderer = createCliRunRenderer({ workspaceDir: workspace });
          return renderer.handle.bind(renderer);
        })(),
      });
      if (!restored) {
        process.stderr.write(
          'No resumable loop found (no saved state, or the last loop completed). Start one with /loop <goal>.\n'
        );
        rl.prompt();
        continue;
      }
      wireLoopScheduler(restored, 'resumed');
      rl.prompt();
      continue;
    }

    // Task OS M5: unified task runtime entry — one goal in, one verified
    // result out (plan → execute → verify → repair → accept). PASS can only
    // come from the verdict provider, never from the agent's prose.
    if (msg === '/task' || msg.startsWith('/task ')) {
      const rest = msg.slice('/task'.length).trim();
      const sub = rest.split(/\s+/)[0];
      if (!['run', 'resume', 'status', 'timeline'].includes(sub)) {
        process.stderr.write(
          'Usage: /task run <goal...> [--accept "<cmd>"] [--max-repairs N] | /task status [id] | /task timeline [id] | /task resume <id>\n'
        );
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
      const { runTaskCommand, splitCommandArgs } = await import('./task-run.js');
      const taskSessionKey = createCliSessionKey();
      try {
        const code = await runTaskCommand(splitCommandArgs(rest), {
          agent,
          workspace,
          sessionKey: taskSessionKey,
        });
        if (code === 2) process.stderr.write('(bad /task arguments — see usage above)\n');
      } catch (err) {
        process.stderr.write(`task run failed: ${errorMessage(err)}\n`);
      } finally {
        taskRunInFlight = false;
        rl.resume();
        rl.setPrompt('\n› ');
        rl.prompt();
      }
      continue;
    }

    // v0.15 goal mode: same autonomous engine as /loop, plus an acceptance
    // gate — the loop only completes when the verification command exits 0.
    if (msg.startsWith('/goal ')) {
      const parsed = parseGoalCommandLine(msg.slice('/goal '.length));
      if (!parsed) {
        process.stderr.write(
          'Usage: /goal <goal> [--accept "<verification command>"] — run autonomously until the acceptance command exits 0. /goal stop aborts.\n'
        );
        rl.prompt();
        continue;
      }
      if (activeLoopScheduler) {
        process.stderr.write('A /loop or /goal is already running. Use /loop stop first.\n');
        rl.prompt();
        continue;
      }
      const maxIterations = resolveLoopMaxIterations(process.env, true);
      // Task OS M6: goal runs ARE tasks — the acceptance verdict mirrors into
      // the unified runtime so /goal history shows up in `moss task status`
      // and the TUI like every other task.
      let goalTaskId: string | undefined;
      if (parsed.acceptance) {
        try {
          const { createDraftTask, appendTaskEvent, emitAcceptanceLifecycle } =
            await import('../core/index.js');
          const contract = await createDraftTask(workspace, parsed.goal);
          await appendTaskEvent(workspace, contract.taskId, 'execution_started');
          goalTaskId = contract.taskId;
          goalAcceptanceMirror = (passed: boolean, exitCode: number, tail: string) => {
            void emitAcceptanceLifecycle(
              workspace,
              contract.taskId,
              passed,
              passed
                ? 'goal acceptance command exited 0'
                : `goal acceptance command failed (exit ${exitCode}): ${tail.slice(0, 300)}`
            ).catch(() => undefined);
          };
        } catch {
          // Mirroring is observability — /goal must work without it.
          goalTaskId = undefined;
        }
      }
      const sched = new LoopScheduler(agent, {
        prompt: parsed.goal,
        intervalMs: 0,
        maxIterations,
        sessionKey: 'goal',
        compactBetweenIterations: true,
        journal: true,
        autonomous: true,
        ...(parsed.acceptance ? { acceptance: parsed.acceptance } : {}),
        ...(goalTaskId
          ? {
              onAcceptanceVerdict: (result: {
                passed: boolean;
                exitCode: number;
                tail: string;
              }) => {
                goalAcceptanceMirror?.(result.passed, result.exitCode, result.tail);
              },
            }
          : {}),
        onIterationEvent: (() => {
          const renderer = createCliRunRenderer({ workspaceDir: workspace });
          return renderer.handle.bind(renderer);
        })(),
      });
      wireLoopScheduler(sched, 'started');
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/loop ')) {
      const prompt = msg.slice('/loop '.length).trim();
      if (!prompt) {
        process.stderr.write(
          'Usage: /loop <goal> — run autonomously until the goal is done. /loop stop waits for the current step, then stops.\n'
        );
        rl.prompt();
        continue;
      }
      if (activeLoopScheduler) {
        process.stderr.write('A /loop is already running. Use /loop stop first.\n');
        rl.prompt();
        continue;
      }
      const maxIterations = resolveLoopMaxIterations(process.env);
      const sched = new LoopScheduler(agent, {
        prompt,
        intervalMs: 0,
        maxIterations,
        sessionKey: 'loop',
        compactBetweenIterations: true,
        journal: true,
        autonomous: true,
        // Stream each iteration's events through the CLI renderer so the user
        // sees tool calls and text output live, not just summaries at iteration end.
        onIterationEvent: (() => {
          const renderer = createCliRunRenderer({ workspaceDir: workspace });
          return renderer.handle.bind(renderer);
        })(),
      });
      wireLoopScheduler(sched, 'started');
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/')) {
      for (const line of unknownSlashCommandLines(msg, { locale: cliLocale() })) {
        console.error(`[help] ${line}`);
      }
      const availableCommands = [
        ...INTERACTIVE_COMMANDS.filter((cmd) => !cmd.includes(' ')),
        ...customCommands.map((command) => command.name),
      ];
      console.error(`[help] Available: ${availableCommands.join(' ')}`);
      rl.prompt();
      continue;
    }

    checkpointStore.open(msg.slice(0, 60));
    const stop = await runOneShot(agent, msg, {
      sessionKey,
      onAgentEvent: (event) => usage.record(event),
    });
    if (stop?.blocked) {
      // Stop hook vetoed the run ending: one forced continuation turn, then
      // the veto is consumed (a hook that keeps blocking would loop forever).
      await runOneShot(
        agent,
        `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`,
        { sessionKey, onAgentEvent: (event) => usage.record(event) }
      );
    }
    rl.prompt();
  }

  agent.unregisterPreToolHook('repl-checkpoint');
  agent.unregisterPostToolHook('repl-checkpoint-after');
  setCliApprovalAsker(null);
  rl.close();
}
