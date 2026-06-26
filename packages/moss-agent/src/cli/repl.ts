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
import {
  formatCustomModelConfigInstructions,
  formatModelChoices,
  loadModelChoicesForRuntime,
  parseCustomModelConfigInput,
  resolveModelSelection,
} from './model-catalog.js';
import { resolveRealModel } from './model-resolution.js';
import { loadConfigFile, resolveConfigDir, resolveConfigPath, saveConfigFileAtPath } from './config.js';
import { createCliProvider } from './providers.js';
import { runOneShot } from './oneshot.js';
import {
  renderCliDetailHelp,
  renderCliInteractiveHelp,
  renderCliWelcome,
  type CliRuntimeStatus,
} from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, label, ui } from './ui.js';
import { AGENTS_MD_TEMPLATE, formatTuiSessions, renderSkills, runInkInteractive, runLocalShellCommand } from './tui.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { appendQuickAddMemory, openInEditor, parseQuickAddMemory, resolveEditorCommand } from './memory-editor.js';
import { FileCheckpointStore, checkpointTargetPaths } from './file-checkpoint.js';
import { errorMessage } from '../errors.js';

let currentModel = '';

export const INTERACTIVE_COMMANDS = [...INTERACTIVE_COMPLETION_COMMANDS];

function applyCustomModelConfigForRepl(agent: MossAgent, runtime: CliRuntimeStatus | undefined, rawConfig: string): string {
  const configPath = runtime?.config?.configPath ?? resolveConfigPath();
  const parsed = parseCustomModelConfigInput(rawConfig);
  if (!parsed.ok) return `${parsed.message}\n\n${formatCustomModelConfigInstructions(configPath)}`;
  const nextConfig = parsed.config;
  const currentConfig = loadConfigFile(configPath);
  saveConfigFileAtPath({
    ...currentConfig,
    provider: nextConfig.provider,
    model: nextConfig.model,
    baseUrl: nextConfig.baseUrl,
    apiKey: nextConfig.apiKey,
    ...(nextConfig.imageInput === undefined ? {} : { imageInput: nextConfig.imageInput }),
  }, configPath);

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
    if (nextConfig.imageInput !== undefined) {
      runtime.config.imageInput = nextConfig.imageInput;
      runtime.config.imageInputSource = 'config';
    }
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
    imageInput: nextConfig.imageInput,
  });

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
  write: (message: string) => void,
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
      write(`[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`);
    } catch (err) {
      write(`[auth] ${formatCommunityAuthLoginError(err)}`);
    }
    return true;
  }
  if (msg === '/logout' || msg === '/auth logout') {
    const removed = auth.logout();
    write(removed
      ? '[auth] Logged out of the D-Robotics developer community.'
      : '[auth] No D-Robotics developer community session is stored.');
    return true;
  }
  write('Usage: /auth <login|status|logout>');
  return true;
}

function basicReplUnsupportedMessage(command: string): string {
  const token = command.split(/\s+/, 1)[0] || command;
  if (token === '/queue') return '[help] Queue controls need the full TUI. This basic REPL runs one prompt at a time.';
  if (token === '/stop' || token === '/abort') return '[help] Press Ctrl+C to interrupt the terminal process in this basic REPL.';
  if (token === '/thinking') return '[help] Thinking display is a full TUI control. Use `/detail verbose` for more runtime detail here.';
  if (token === '/clear') return '[help] Use Ctrl+L or your shell `clear` command to clear this terminal.';
  if (token === '/init') return '[help] /init is available in the full TUI. In this REPL, create AGENTS.md in your workspace manually.';
  return '[help] This control is available in the full terminal TUI.';
}

export async function runInteractive(
  agent: MossAgent,
  skillLearner?: SkillLearner,
  runtime?: CliRuntimeStatus,
  options: { sessionKey?: string } = {},
) {
  if (process.stdin.isTTY && process.stdout.isTTY && process.env.MOSS_CLI_TUI !== '0') {
    await runInkInteractive(agent, skillLearner, runtime, options);
    return;
  }

  currentModel = agent.config.model || currentModel;
  const workspace = runtime?.workspace || process.cwd();
  const sessionKey = options.sessionKey || createCliSessionKey();

  // File checkpoint for /rewind and /undo in REPL mode.
  const runtimeDir = runtime?.runtimeDir ?? path.join(workspace, '.moss', 'runtime');
  const checkpointStore = new FileCheckpointStore({ runtimeDir, sessionKey });
  const parsePatchPaths = (patch: string): string[] => {
    const out: string[] = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim());
    return out;
  };

  // Register pre/post hooks so every tool write is checkpointed.
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
  // File-based custom commands (.moss/commands/*.md) join the registry dispatch.
  const customCommands = loadCustomCommands({
    workspace,
    configDir: runtime?.configDir ?? resolveConfigDir(),
    reservedNames: reservedBuiltinNames(),
  });
  let closed = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n› ',
    completer: completeInteractiveCommand,
  });
  setCliApprovalAsker((question) => new Promise((resolve) => {
    const onSigint = () => {
      rl.off('SIGINT', onSigint);
      resolve('');
    };
    rl.once('SIGINT', onSigint);
    rl.question(question, (answer) => {
      rl.off('SIGINT', onSigint);
      resolve(answer);
    });
  }));

  console.error(renderCliWelcome(agent, { ...runtime, sessionKey }));
  console.error(ui.dim(`${label('directory')} ${compactPath(workspace)}   ${label('exit')} Ctrl+D or /quit`));
  console.error(ui.dim(`${label('status')} Ready. Type a prompt and press Enter, or /help for commands.`));
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

    // Registry-first dispatch: shared
    // commands live in the registry; the legacy chain below shrinks with
    // each migration phase.
    if (msg.startsWith('/')) {
      let pendingPrefill: string | null = null;
      let pendingSubmit: string | null = null;
      const handled = await runRegistryCommand(msg, {
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
      }, customCommands);
      if (handled) {
        // A custom command expands to a prompt — run it as the next turn.
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

    // /rewind and /undo: list checkpoints or rewind to a specific one.
    if (msg === '/rewind' || msg === '/undo' || msg.startsWith('/rewind ') || msg.startsWith('/undo ')) {
      const arg = msg.split(/\s+/, 2)[1]?.trim();
      const isUndo = msg === '/undo' || msg.startsWith('/undo ');
      if (arg && !/^\d+$/.test(arg)) {
        console.error('[rewind] Usage: /rewind [seq] — pass a checkpoint number from /rewind with no argument.');
        rl.prompt();
        continue;
      }
      // /undo with no argument = rewind to the most recent checkpoint (one-step undo).
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
            console.error(`[undo] Reverted ${result.restored.length} file(s) from checkpoint ${last.seq} (${last.label}).`);
            for (const p of result.restored) console.error(`  ✓ ${p}`);
            if (result.skipped.length) {
              console.error(`[undo] Skipped ${result.skipped.length} file(s) to protect external changes:`);
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
          console.error(`[rewind] Restored ${result.restored.length} file(s) to checkpoint ${seq}.`);
          for (const p of result.restored) console.error(`  ✓ ${p}`);
          if (result.skipped.length) {
            console.error(`[rewind] Skipped ${result.skipped.length} file(s) to protect external changes:`);
            for (const p of result.skipped) console.error(`  ⊘ ${p}`);
          }
        }
      } else {
        const list = checkpointStore.list();
        if (list.length === 0) {
          console.error('[rewind] No checkpoints yet. Files are checkpointed each turn when the agent writes.');
        } else {
          console.error(`[rewind] ${list.length} checkpoint(s):`);
          for (const cp of list) {
            console.error(`  seq=${cp.seq}  [${new Date(cp.ts).toLocaleTimeString()}] ${cp.label}  (${cp.fileCount} files)`);
          }
          console.error('[rewind] Run `/rewind <seq>` to restore, or `/undo` to undo the last checkpoint.');
        }
      }
      rl.prompt();
      continue;
    }

    // /connect and /disconnect are handled by the command registry above.

    if (msg === '/goal' || msg.startsWith('/goal ')) {
      const result = await handleGoalCommand({ agent, sessionKey, input: msg, locale: cliLocale() });
      console.error(result.message);
      rl.prompt();
      continue;
    }

    if (msg === '/compact' || msg.startsWith('/compact ')) {
      const compactInstructions = msg.slice('/compact'.length).trim() || undefined;
      try {
        console.error(await handleCompactCommand(agent, sessionKey, compactInstructions));
      } catch (err) {
        console.error(`[compact] ${errorMessage(err)}`);
        console.error('[compact] You can keep chatting; try /status --verbose to inspect context, or ask Moss to summarize the current session manually.');
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
          console.error(notRepo
            ? `[diff] Not a git repository: ${workspace} — /diff needs a git workspace.`
            : `[diff] git diff failed (exit ${result.exitCode}): ${result.output.trim().split('\n')[0] || 'unknown error'}`);
        } else {
          console.error(result.output.trim() || '(no unstaged working-tree changes)');
        }
      } catch (err) {
        console.error(`[diff] ${errorMessage(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (
      msg === '/queue'
      || msg.startsWith('/queue ')
      || msg === '/stop'
      || msg === '/abort'
      || msg === '/thinking'
      || msg === '/clear'
      || msg === '/init'
    ) {
      console.error(basicReplUnsupportedMessage(msg));
      rl.prompt();
      continue;
    }

    if (msg === '/model' || msg.startsWith('/model ')) {
      const newModel = msg === '/model' ? '' : msg.slice(7).trim();
      if (newModel === 'config' || newModel.startsWith('config ')) {
        const rawConfig = newModel === 'config' ? '' : newModel.slice('config'.length).trim();
        try {
          console.error(applyCustomModelConfigForRepl(agent, runtime, rawConfig));
        } catch (err) {
          console.error(`[config] Could not save model config: ${errorMessage(err)}`);
        }
        rl.prompt();
        continue;
      }
      // Showing the list is an explicit "what model am I on?" — resolve the real
      // backing model on demand (one probe, cached) so it can be displayed.
      if (!newModel && runtime?.config?.usingBundledDefault) {
        await resolveRealModel(agent.config.llmProvider, runtime.config);
      }
      const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
        fallbackProvider: (agent.config as { provider?: string }).provider,
      });
      if (newModel) {
        const selected = resolveModelSelection(newModel, modelChoices.choices);
        const model = selected?.model ?? newModel;
        currentModel = model;
        agent.config.model = model;
        if (runtime?.config) {
          runtime.config.model = model;
          runtime.config.modelSource = 'cli';
        }
        console.error(selected
          ? `[config] Model switched to: ${model} (${modelChoices.provider})`
          : `[config] Model switched to custom model: ${model} (${modelChoices.provider})`);
      } else {
        console.error(formatModelChoices(modelChoices));
      }
      rl.prompt();
      continue;
    }

    // /version is handled by the command registry above.

    if (msg.startsWith('/detail')) {
      const mode = msg.slice('/detail'.length).trim().toLowerCase();
      if (mode === 'quiet' || mode === 'progress' || mode === 'verbose') {
        process.env.MOSS_CLI_DETAIL = mode;
        console.error(`[config] CLI detail set to: ${mode}`);
      } else {
        console.error(renderCliDetailHelp());
      }
      rl.prompt();
      continue;
    }

    if (msg === '/memory' || msg === '/memory list') {
      // The basic REPL uses a plain readline, so handing the TTY to $EDITOR is
      // safe here (unlike the Ink TUI). `/memory` opens AGENTS.md in $EDITOR;
      // `/memory list` (and the editor-less fallback) shows the stored listing.
      if (msg === '/memory' && resolveEditorCommand() && process.stdin.isTTY) {
        const target = path.join(workspace, 'AGENTS.md');
        if (!fs.existsSync(target)) {
          try { fs.writeFileSync(target, AGENTS_MD_TEMPLATE, 'utf8'); } catch { /* fall through to listing */ }
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
        // Only a missing index means "no memories" — a malformed file or a
        // permission error is a real failure and must not be masked.
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
