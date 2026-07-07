import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import type { MossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { handleGoalCommand } from '../goal.js';
import { setCliApprovalAsker } from './approval.js';
import { handleCompactCommand } from './compact-command.js';
import { formatCommunityAuthLoginError, formatCommunityAuthStatus } from './community-auth.js';
import { runRegistryCommand, unknownSlashCommandLines } from './commands/registry.js';
import { loadCustomCommands, reservedBuiltinNames } from './commands/custom-commands.js';
import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';
import { CliServices } from './cli-services.js';
import { resolveRealModel } from './model-resolution.js';
import { resolveContextTokensForModel } from './model-catalog.js';
import { writePreferredModel } from './preferred-model-store.js';
import { createCliProvider } from './providers.js';
import { runOneShot } from './oneshot.js';
import { createCliRunRenderer } from './output.js';
import { renderCliInteractiveHelp, renderCliWelcome, type CliRuntimeStatus } from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, label, ui } from './ui.js';
import {
  AGENTS_MD_TEMPLATE,
  formatTuiSessions,
  renderSkills,
  runInkInteractive,
  runLocalShellCommand,
} from './tui.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import {
  appendQuickAddMemory,
  openInEditor,
  parseQuickAddMemory,
  resolveEditorCommand,
} from './memory-editor.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { errorMessage } from '../errors.js';
import { LoopScheduler } from '../core/loop/loop-scheduler.js';

let currentModel = '';

let activeLoopScheduler: LoopScheduler | null = null;

export const INTERACTIVE_COMMANDS = [...INTERACTIVE_COMPLETION_COMMANDS];

function applyCustomModelConfigForRepl(
  agent: MossAgent,
  runtime: CliRuntimeStatus | undefined,
  rawConfig: string,
  services: CliServices,
): string {
  const configPath = runtime?.config?.configPath ?? services.config.resolveConfigPath();
  const parsed = services.models.parseCustomModelConfigInput(rawConfig);
  if (!parsed.ok) return `${parsed.message}\n\n${services.models.formatCustomModelConfigInstructions(configPath)}`;
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

async function handleInteractiveAuthCommand(
  msg: string,
  runtime: CliRuntimeStatus | undefined,
  write: (message: string) => void
): Promise<boolean> {
  const auth = runtime?.communityAuth;
  if (!(msg === '/auth' || msg.startsWith('/auth ') || msg === '/logout')) return false;
  if (!auth) {
    write('[auth] Community auth runtime is unavailable in this session.');
    return true;
  }
  if (msg === '/auth' || msg === '/auth status') {
    write(`[auth] ${formatCommunityAuthStatus(auth.getStatus())}`);
    return true;
  }
  if (msg === '/auth login' || msg.startsWith('/auth login ')) {
    const manual = msg.split(/\s+/).includes('--manual');
    try {
      const context = await auth.login(write, { manual });
      write(
        `[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`
      );
    } catch (err) {
      write(`[auth] ${formatCommunityAuthLoginError(err)}`);
    }
    return true;
  }
  if (msg === '/logout' || msg === '/auth logout') {
    const removed = auth.logout();
    write(
      removed
        ? '[auth] Logged out of the D-Robotics developer community.'
        : '[auth] No D-Robotics developer community session is stored.'
    );
    return true;
  }
  write('Usage: /auth <login|status|logout>');
  return true;
}

function basicReplUnsupportedMessage(command: string): string {
  const token = command.split(/\s+/, 1)[0] || command;
  if (token === '/stop' || token === '/abort')
    return '[help] Press Ctrl+C to interrupt the terminal process in this basic REPL.';
  if (token === '/clear')
    return '[help] Use Ctrl+L or your shell `clear` command to clear this terminal.';
  if (token === '/init')
    return '[help] /init is available in the full TUI. In this REPL, create AGENTS.md in your workspace manually.';
  return '[help] This control is available in the full terminal TUI.';
}

export async function runInteractive(
  agent: MossAgent,
  skillLearner?: SkillLearner,
  runtime?: CliRuntimeStatus,
  options: { sessionKey?: string; services?: CliServices } = {}
) {
  if (process.stdin.isTTY && process.stdout.isTTY && process.env.MOSS_CLI_TUI !== '0') {
    await runInkInteractive(agent, skillLearner, runtime, options);
    return;
  }

  const services = options.services ?? new CliServices();
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
    (msg) => console.warn(`[moss] ${msg}`),
  );
  let closed = false;
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
  if (runtime?.configDir) {
    startCliUpdateCheck({
      configDir: runtime.configDir,
      currentVersion: getPackageVersion(),
      onNotice: (message) => {
        if (closed) return;
        console.error(`\n${message}`);
        rl.prompt(true);
      },
    });
  }

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
          await runOneShot(agent, String(submitText), skillLearner, { sessionKey });
        }
        rl.prompt();
        if (pendingPrefill) rl.write(pendingPrefill);
        continue;
      }
    }

    if (await handleInteractiveAuthCommand(msg, runtime, (message) => console.error(message))) {
      rl.prompt();
      continue;
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

    

    if (msg === '/goal' || msg.startsWith('/goal ')) {
      const result = await handleGoalCommand({
        agent,
        sessionKey,
        input: msg,
        locale: cliLocale(),
      });
      console.error(result.message);
      // When a goal is set (and not vague), auto-start a LoopScheduler so the
      // agent works toward it autonomously — matching TUI's goal auto-run UX.
      if (result.action === 'set' && !result.vague && result.goal?.objective && !activeLoopScheduler) {
        const objective = result.goal.objective;
        const maxIterations = (() => {
          const raw = Number.parseInt(String(process.env.MOSS_GOAL_AUTO_MAX_RUNS ?? process.env.MOSS_LOOP_MAX ?? '20'), 10);
          return Number.isFinite(raw) && raw > 0 ? raw : 20;
        })();
        const sched = new LoopScheduler(agent, {
          prompt: objective,
          intervalMs: 0,
          maxIterations,
          sessionKey,
          compactBetweenIterations: true,
          journal: true,
          autonomous: true,
        });
        activeLoopScheduler = sched;
        sched.on((event) => {
          if (event.type === 'iteration_completed') {
            process.stderr.write(`\n[goal run ${event.result.iteration}/${maxIterations}] ${event.result.response.slice(0, 400)}\n`);
          } else if (event.type === 'iteration_failed') {
            process.stderr.write(`\n[goal] run ${event.iteration} failed: ${event.error.slice(0, 200)}\n`);
          } else if (event.type === 'loop_completed') {
            process.stderr.write(`\nGoal completed after ${event.totalIterations} run(s). /goal complete to mark done.\n`);
            if (activeLoopScheduler === sched) activeLoopScheduler = null;
          } else if (event.type === 'loop_aborted') {
            process.stderr.write(`\nGoal auto-run stopped at iteration ${event.iteration}.\n`);
            if (activeLoopScheduler === sched) activeLoopScheduler = null;
          }
        });
        process.stderr.write(`Goal set: "${objective.slice(0, 80)}${objective.length > 80 ? '…' : ''}"\nStarting autonomous run (up to ${maxIterations} iterations). /loop stop to abort.\n`);
        void sched.start().catch((err) => {
          process.stderr.write(`Goal run error: ${errorMessage(err)}\n`);
          if (activeLoopScheduler === sched) activeLoopScheduler = null;
        });
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
      const modelChoices = await services.models.loadModelChoicesForRuntime(runtime?.config, currentModel, {
        fallbackProvider: (agent.config as { provider?: string }).provider,
      });
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

    if (msg === '/memory' || msg === '/memory list') {
      
      
      
      if (msg === '/memory' && resolveEditorCommand() && process.stdin.isTTY) {
        const target = path.join(workspace, 'AGENTS.md');
        if (!fs.existsSync(target)) {
          try {
            fs.writeFileSync(target, AGENTS_MD_TEMPLATE, 'utf8');
          } catch {
            
          }
        }
        try {
          await openInEditor(target);
          console.error(`[memory] Edited ${compactPath(target)} — auto-loads next session.`);
          rl.prompt();
          continue;
        } catch (err) {
          console.error(`[memory] Editor failed: ${errorMessage(err)}`);
        }
      }
      const paths = getMossWorkspacePaths(workspace);
      const memDir = fs.existsSync(paths.memoryDir) ? paths.memoryDir : paths.legacyMemoryDir;
      try {
        const indexPath = path.join(memDir, 'index.json');
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const entries = JSON.parse(raw);
        console.error(`[memory] ${entries.length} entries stored`);
        for (const e of entries.slice(0, 5)) {
          console.error(`  - [${e.id}] ${e.content.slice(0, 80)}...`);
        }
        if (entries.length > 5) console.error(`  ... and ${entries.length - 5} more`);
      } catch (err) {
        
        
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          console.error('[memory] No memories stored yet.');
        } else {
          console.error(`[memory] Failed to read memory index: ${errorMessage(err)}`);
        }
      }
      rl.prompt();
      continue;
    }

    if (msg === '/skills') {
      console.error(renderSkills(workspace));
      rl.prompt();
      continue;
    }

    if (msg === '/loop stop' || msg === '/loop abort') {
      if (!activeLoopScheduler) {
        process.stderr.write('No /loop is running.\n');
      } else {
        activeLoopScheduler.abort();
        activeLoopScheduler = null;
        rl.setPrompt('\n› ');
        process.stderr.write('Loop aborted.\n');
      }
      rl.prompt();
      continue;
    }
    if (msg.startsWith('/loop ')) {
      const prompt = msg.slice('/loop '.length).trim();
      if (!prompt) {
        process.stderr.write('Usage: /loop <goal> — run autonomously until the goal is done. /loop stop aborts.\n');
        rl.prompt();
        continue;
      }
      if (activeLoopScheduler) {
        process.stderr.write('A /loop is already running. Use /loop stop first.\n');
        rl.prompt();
        continue;
      }
      const maxIterations = (() => {
        const raw = Number.parseInt(String(process.env.MOSS_LOOP_MAX ?? '20'), 10);
        return Number.isFinite(raw) && raw >= 0 ? raw : 0;
      })();
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
      activeLoopScheduler = sched;
      // Update the prompt while the loop is running so the user can see at a glance
      rl.setPrompt('\n[loop] › ');
      sched.on((event) => {
        if (event.type === 'iteration_completed') {
          process.stderr.write(`\n[loop ${event.result.iteration}/${maxIterations}] ${event.result.response.slice(0, 400)}\n`);
        } else if (event.type === 'iteration_failed') {
          process.stderr.write(`\n[loop ${event.iteration}] failed: ${event.error.slice(0, 200)}\n`);
        } else if (event.type === 'loop_completed') {
          process.stderr.write(`\nLoop completed: ${event.totalIterations} iteration(s) in ${Math.round(event.totalDurationMs / 1000)}s.\n`);
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
      process.stderr.write(`Loop started: "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}" (up to ${maxIterations} iterations). /loop stop to abort.\n`);
      void sched.start().catch((err) => {
        process.stderr.write(`Loop error: ${errorMessage(err)}\n`);
        if (activeLoopScheduler === sched) activeLoopScheduler = null;
      });
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

    const quickMemory = parseQuickAddMemory(msg);
    if (quickMemory !== null) {
      try {
        const target = appendQuickAddMemory(workspace, quickMemory, AGENTS_MD_TEMPLATE);
        console.error(`[memory] Added to ${compactPath(target)}: ${quickMemory}`);
      } catch (err) {
        console.error(`[memory] Could not add memory: ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    checkpointStore.open(msg.slice(0, 60));
    await runOneShot(agent, msg, skillLearner, { sessionKey });
    rl.prompt();
  }

  closed = true;
  agent.unregisterPreToolHook('repl-checkpoint');
  agent.unregisterPostToolHook('repl-checkpoint-after');
  setCliApprovalAsker(null);
  rl.close();
}
