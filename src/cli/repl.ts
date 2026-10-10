import path from 'node:path';
import * as readline from 'node:readline';
import type { MossAgent, MossAgentEvent } from '../core/index.js';
import { setCliApprovalAsker } from './approval.js';
import { noteKnownSecret } from '../safety/known-secrets.js';
import { wrapApprovalAsker } from './permission-request.js';
import { handleCompactCommand } from './compact-command.js';
import { runRegistryCommand, unknownSlashCommandLines } from './commands/registry.js';
import {
  loadCustomCommands,
  reservedBuiltinNames,
  resolveUserCommand,
} from './commands/custom-commands.js';
import { formatBackgroundJobLines } from './commands/background-jobs.js';
import {
  abandonLiveGoal,
  acceptanceProposalLines,
  GOAL_USAGE,
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
import { cliLocale } from './cli-locale.js';
import { listBackgroundProcessSnapshots } from '../core/tools/background-process-registry.js';
import { CliServices } from './cli-services.js';
import { resolveRealModel } from './model-resolution.js';
import { resolveContextTokensForModel } from './model-catalog.js';
import { writePreferredModel } from './preferred-model-store.js';
import { createCliProvider } from './providers.js';
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
import { errorMessage } from '../errors.js';
import { interruptNoticeLine, isUserAbortErrorText } from './tui/copy.js';

let currentModel = '';

let taskRunInFlight = false;

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
    skills?: Array<{ name: string; description: string }>;
  } = {}
) {
  const services = options.services ?? new CliServices();
  const usage = createSessionUsageAccumulator();
  currentModel = agent.config.model || currentModel;
  const workspace = runtime?.workspace || process.cwd();
  let sessionKey = options.sessionKey || createCliSessionKey();

  const runtimeDir = runtime?.runtimeDir ?? path.join(workspace, '.moss', 'runtime');
  let checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
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
    if (pendingGoal && !msg.startsWith('/')) {
      const goal = pendingGoal.goal;
      pendingGoal = null;
      if (/^n$/i.test(msg)) {
        console.error(skippedAcceptanceNotice());
        msg = `/task ${goalRunArgs(goal)}`;
      } else {
        msg = `/task ${goalRunArgs(goal, { acceptance: msg })}`;
      }
    } else if (msg.startsWith('/')) {
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
            taskFlow: messageRequestsTaskContract(String(submitText)),
          });
          if (stop?.blocked) {
            const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
            await runOneShot(agent, feedback, {
              sessionKey,
              onAgentEvent: (event) => usage.record(event),
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
      const rows = options.skills ?? [];
      if (rows.length === 0) {
        console.error('no skills found — create one: moss skill create <name>');
      } else {
        console.error('Skills');
        for (const s of rows)
          console.error(`  ${s.name.padEnd(18)} ${s.description.split('\n')[0] ?? ''}`);
        console.error(`  (${rows.length} skill(s) · load with the skill tool)`);
      }
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
            notRepo
              ? `[diff] Not a git repository: ${workspace} — /diff needs a git workspace.`
              : `[diff] git diff failed (exit ${result.exitCode}): ${output.trim().split('\n')[0] || 'unknown error'}`
          );
        } else {
          console.error(output.trim() || '(no unstaged working-tree changes)');
        }
      } catch (err) {
        console.error(`[diff] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/clear') {
      sessionKey = createCliSessionKey();
      checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
      console.error(
        '[clear] new conversation, empty context. The previous one stays on disk — moss --continue'
      );
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

    // `/goal` is the everyday "work until" entry. `/loop` only prints a
    // suggestion and does not reach this branch. Clear-words abandon the
    // live task; a missing `--accept` proposes a command from the workspace.
    if (msg === '/goal' || msg.startsWith('/goal ')) {
      const plan = planGoalInvocation(msg.slice('/goal'.length).trim(), workspace);
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
        const { listTaskStateSnapshots } = await import('../core/index.js');
        const resumable = (await listTaskStateSnapshots(workspace))
          .filter((s) => isResumableTaskPhase(s.phase))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!resumable) {
          process.stderr.write('No resumable task found. Start one with /goal <condition>.\n');
          rl.prompt();
          continue;
        }
        msg = `/task resume ${resumable.taskId}`;
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
        const maxTurns = resolveLoopMaxIterations(process.env, true);
        msg = `/task ${goalRunArgs(plan.goal, {
          ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
          ...(maxTurns > 0 ? { maxTurns } : {}),
        })}`;
      }
    }

    // Task OS M5: unified task runtime entry — one goal in, one verified
    // result out (plan → execute → verify → repair → accept). PASS can only
    // come from the verdict provider, never from the agent's prose. /goal
    // translates into this branch above, so every autonomous run streams
    // live through the same renderer too.
    if (msg === '/task' || msg.startsWith('/task ')) {
      const rest = msg.slice('/task'.length).trim();
      const sub = rest.split(/\s+/)[0];
      if (!['run', 'resume', 'status', 'timeline', 'view', 'verify'].includes(sub ?? '')) {
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
      const { parseLlmUsageStdout, runTaskCommand, splitCommandArgs } =
        await import('./task-run.js');
      const { formatTurnUsage } = await import('./usage-display.js');
      const taskSessionKey = createCliSessionKey();
      const renderer = createCliRunRenderer({ workspaceDir: workspace, resumeHint: true });
      try {
        const code = await runTaskCommand(splitCommandArgs(rest), {
          agent,
          workspace,
          sessionKey: taskSessionKey,
          onAgentEvent: (event) => renderer.handle(event as MossAgentEvent),
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
        taskRunInFlight = false;
        rl.resume();
        rl.setPrompt('\n› ');
        rl.prompt();
      }
      continue;
    }

    if (msg.startsWith('/')) {
      const resolved = resolveUserCommand(msg, {
        builtinNames: reservedBuiltinNames(),
        customCommands,
        skills: options.skills ?? [],
      });
      if (resolved.kind === 'custom' || resolved.kind === 'skill') {
        checkpointStore.open(`${resolved.kind}: ${resolved.prompt.slice(0, 60)}`);
        const stop = await runOneShot(agent, resolved.prompt, {
          sessionKey,
          onAgentEvent: (event) => usage.record(event),
          taskFlow: messageRequestsTaskContract(resolved.prompt),
        });
        if (stop?.blocked) {
          const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
          await runOneShot(agent, feedback, {
            sessionKey,
            onAgentEvent: (event) => usage.record(event),
            taskFlow: messageRequestsTaskContract(feedback),
          });
        }
        rl.prompt();
        continue;
      }
      for (const helpLine of unknownSlashCommandLines(msg, { locale: cliLocale() })) {
        console.error(`[help] ${helpLine}`);
      }
      const availableCommands = [
        ...SLASH_MENU_ROWS.map((row) => row.command),
        ...customCommands.map((command) => command.name),
        ...(options.skills ?? []).map((skill) => `/${skill.name}`),
      ];
      console.error(`[help] Available: ${availableCommands.join(' ')}`);
      rl.prompt();
      continue;
    }

    checkpointStore.open(msg.slice(0, 60));
    const stop = await runOneShot(agent, msg, {
      sessionKey,
      onAgentEvent: (event) => usage.record(event),
      taskFlow: messageRequestsTaskContract(msg),
    });
    if (stop?.blocked) {
      // Stop hook vetoed the run ending: one forced continuation turn, then
      // the veto is consumed (a hook that keeps blocking would loop forever).
      const feedback = `[stop-hook feedback] ${stop.reason ?? 'The Stop hook requires more work; continue the task.'}`;
      await runOneShot(agent, feedback, {
        sessionKey,
        onAgentEvent: (event) => usage.record(event),
        taskFlow: messageRequestsTaskContract(feedback),
      });
    }
    rl.prompt();
  }

  agent.unregisterPreToolHook('repl-checkpoint');
  agent.unregisterPostToolHook('repl-checkpoint-after');
  setCliApprovalAsker(null);
  rl.close();
}
