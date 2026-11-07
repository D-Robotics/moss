// Command dispatcher with explicit initialization phases.
// Replaces 22 if-else branches in main() with a declarative routing table.

import { isZhLocale, uiText } from './cli-locale.js';
import { resumeUserText } from '../core/session/internal-transcript.js';
import { resolveExportOutPath } from './export-path.js';
import { formatSessionTimestamp } from './session-format.js';
import type { LLMMessage } from '../core/llm/llm-provider.js';
import type { SessionStore, SessionMeta } from '../core/session/session.js';
import type { MossAgent } from '../core/agent/moss-agent.js';
import type { TaskCommandContext } from './task-run.js';

/** A single `sessions search` match: enough to locate and resume the session. */
export interface SessionSearchHit {
  key: string;
  messageCount: number;
  updatedAt: number;
  snippet: string;
}

/** Maximum number of hits `sessions search` reports (caps runaway output). */
const SESSION_SEARCH_MAX_HITS = 50;

/** Max width of the TITLE column in `moss sessions list`. */
const SESSION_TITLE_MAX_WIDTH = 50;

/**
 * Normalize a session title for the `sessions list` TITLE column: trim,
 * collapse whitespace, and truncate with an ellipsis. Returns an empty
 * placeholder when no title was recorded (e.g. the session has no first
 * user message). Exported for unit testing.
 */
export function formatSessionTitle(title: string | undefined): string {
  const cleaned = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return uiText('(no title)', '（无标题）');
  if (cleaned.length <= SESSION_TITLE_MAX_WIDTH) return cleaned;
  return cleaned.slice(0, SESSION_TITLE_MAX_WIDTH - 1) + '…';
}

/** Max length of a single tool_result body in exported markdown. */
const SESSION_EXPORT_TOOL_RESULT_MAX = 2000;

/**
 * Render a session's messages as Markdown for `moss sessions export`.
 * User/assistant text is preserved verbatim; tool_use becomes a fenced JSON block
 * (name + input); tool_result becomes a fenced block (truncated to keep the
 * export readable); thinking is folded into a <details> element. Exported
 * for unit testing.
 */
const hasStructuredUserBlocks = (msg: LLMMessage): boolean =>
  msg.role === 'user' &&
  Array.isArray(msg.content) &&
  msg.content.some((block) => block.type === 'tool_result' || block.type === 'tool_use');

/**
 * B252: harness text is model-facing, never the conversation. The same rules as
 * resume replay apply — <turn-context> preambles, [System] corrections/nudges
 * and [Steering] guidance are dropped from the shared markdown (a user turn that
 * only carried a tool result is still kept for its blocks).
 */
function isExportableMessage(msg: LLMMessage): boolean {
  if (msg.role !== 'user' || hasStructuredUserBlocks(msg)) return true;
  const rawText =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
  return resumeUserText(rawText).trim().length > 0;
}

/** How many messages the shared markdown actually contains (harness turns excluded). */
export function countExportableSessionMessages(messages: readonly LLMMessage[]): number {
  return messages.filter(isExportableMessage).length;
}

export function renderSessionMarkdown(sessionKey: string, messages: LLMMessage[]): string {
  const exportable = messages.filter(isExportableMessage);
  const lines: string[] = [
    `# Session ${sessionKey}`,
    '',
    `_${exportable.length} message(s) · exported from moss._`,
    '',
  ];
  for (const msg of exportable) {
    const userVisible = (text: string): string =>
      msg.role === 'user' ? resumeUserText(text) : text;
    lines.push(`## ${msg.role}`, '');
    const content = msg.content;
    if (typeof content === 'string') {
      const text = userVisible(content);
      if (text.trim()) lines.push(text, '');
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          userVisible(block.text).trim()
        ) {
          lines.push(userVisible(block.text), '');
        } else if (block.type === 'tool_use') {
          lines.push('```json', `// tool_use ${block.name}`, safeStringify(block.input), '```', '');
        } else if (block.type === 'tool_result') {
          const body = String(block.content ?? '').slice(0, SESSION_EXPORT_TOOL_RESULT_MAX);
          const truncated = body.length >= SESSION_EXPORT_TOOL_RESULT_MAX ? '…' : '';
          lines.push(
            '```',
            `tool_result${block.is_error ? ' (error)' : ''}:${truncated}`,
            body,
            '```',
            ''
          );
        }
      }
    }
    if (Array.isArray(msg.thinking) && msg.thinking.length) {
      lines.push(
        '<details><summary>thinking</summary>',
        '',
        msg.thinking.join('\n'),
        '',
        '</details>',
        ''
      );
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Flatten a message into a single searchable string (user/assistant text,
 * tool_use name + input, tool_result content, and thinking). Used by
 * `moss sessions search` to locate a past conversation by content.
 */
function messageSearchableText(message: LLMMessage): string {
  let text = '';
  const content = message.content;
  if (typeof content === 'string') {
    text += message.role === 'user' ? resumeUserText(content) : content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += '\n' + (message.role === 'user' ? resumeUserText(block.text) : block.text);
      } else if (block.type === 'tool_use') {
        text += `\n[tool_use ${block.name}] ${safeStringify(block.input)}`;
      } else if (block.type === 'tool_result' && typeof block.content === 'string') {
        text += `\n[tool_result] ${block.content}`;
      }
    }
  }
  if (Array.isArray(message.thinking)) {
    text += '\n' + message.thinking.join('\n');
  }
  return text;
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Scan all sessions in `store` (most recent first) for messages containing
 * `query` (case-insensitive substring). Returns one hit per matching session
 * (the first matching snippet), capped at SESSION_SEARCH_MAX_HITS. Exported
 * for unit testing.
 */
export async function searchSessions(
  store: SessionStore,
  query: string
): Promise<SessionSearchHit[]> {
  const sessions: SessionMeta[] = await store.listSessions().catch(() => []);
  if (sessions.length === 0) return [];
  const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const needle = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  for (const session of sorted) {
    let messages: LLMMessage[];
    try {
      messages = await store.loadMessages(session.sessionKey);
    } catch {
      continue; // unreadable session — skip, don't abort the whole search
    }
    for (const msg of messages) {
      const text = messageSearchableText(msg);
      const idx = text.toLowerCase().indexOf(needle);
      if (idx !== -1) {
        const start = Math.max(0, idx - 48);
        const end = Math.min(text.length, idx + query.length + 72);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < text.length ? '…' : '';
        const snippet = (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
        hits.push({
          key: session.sessionKey,
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
          snippet,
        });
        break; // one snippet per session is enough to locate it
      }
    }
    if (hits.length >= SESSION_SEARCH_MAX_HITS) break;
  }
  return hits;
}

export enum CliPhase {
  // No initialization needed: help, version, usage
  None = 'none',
  // Load config file only: config commands, doctor
  ConfigOnly = 'configOnly',
  // Config + resolved workspace: sessions
  WorkspaceReady = 'workspaceReady',
  // Full agent ready: chat, interactive, etc.
  AgentReady = 'agentReady',
}

export interface CommandConfig {
  name: string;
  phase: CliPhase;
  handler: (ctx: CommandContext) => Promise<void>;
  description?: string;
}

/**
 * Minimal context passed to a command handler.
 * Populated based on the command's declared CliPhase.
 */
export interface CommandContext {
  argv: string[];
  commandArgs: string[];
  configOverrides: any;

  // Available at ConfigOnly phase and above
  fallbackStartDir?: string;
  loadedConfig?: unknown;
  resolvedConfig?: unknown;

  // Available at WorkspaceReady phase and above
  workspace?: string;
  workspaceStat?: unknown;
  workspacePathMigration?: unknown;

  // Available at AgentReady phase
  agent?: unknown;
  sessionStore?: unknown;
  sessionKey?: string;
  liveRuntime?: unknown;
  [key: string]: unknown;
}

/**
 * Shared `moss task …` / `moss goal …` execution: Ctrl+C must pause the verified
 * run (write `task_failed{detail:"aborted"}`, print the resume hint) and exit
 * 130 instead of killing the process with an in-flight task behind it.
 */
async function dispatchVerifiedRun(ctx: CommandContext, args: string[]): Promise<void> {
  const { runTaskCommand } = await import('./task-run.js');
  const { ExitCode } = await import('./exit-codes.js');
  const workspace = ctx.workspace as string | undefined;
  const agent = ctx.agent;
  if (!workspace || !agent) {
    console.error('[moss] task could not resolve the workspace/agent.');
    process.exitCode = ExitCode.USAGE;
    return;
  }
  const { withCliRunCancellation } = await import('./run-cancellation.js');
  const code = await withCliRunCancellation((signal) =>
    runTaskCommand(args, {
      agent,
      workspace,
      sessionKey: (ctx.sessionKey as string | undefined) ?? `task-${Date.now().toString(36)}`,
      outputJson: ctx.argv.includes('--json'),
      signal,
      ...(typeof ctx.configDir === 'string' ? { configDir: ctx.configDir } : {}),
      ...(ctx.mcp ? { mcp: ctx.mcp as NonNullable<TaskCommandContext['mcp']> } : {}),
    })
  );
  if (code !== 0) process.exitCode = code;
}

/**
 * Command routing table.
 * Maps command name to CommandConfig.
 * Replaces the big if-else tree in main().
 */
export const COMMANDS: Record<string, CommandConfig> = {
  superagent: {
    name: 'superagent',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runSuperagentCommand } = await import('./superagent-command.js');
      await runSuperagentCommand(ctx);
    },
    description:
      'Optional Super-agent admission, durable tickets and isolated verified Moss workers',
  },
  // First-run onboarding: workspace command, no model config.
  init: {
    name: 'init',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runInitCommand } = await import('./init-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] init could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runInitCommand(ctx.commandArgs, {
        workspace,
        ...(ctx.argv.includes('--json') ? { outputJson: true } : {}),
      });
      if (code !== 0) process.exitCode = code;
    },
    description:
      'First-run onboarding: detect commands, write AGENTS.md, print the next verified run',
  },

  // One screen for the capability surface: workspace command, no model config.
  capabilities: {
    name: 'capabilities',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runCapabilitiesCommand } = await import('./capabilities-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] capabilities could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runCapabilitiesCommand(ctx.commandArgs, {
        workspace,
        ...(typeof ctx.configDir === 'string' ? { configDir: ctx.configDir } : {}),
        ...(ctx.argv.includes('--json') ? { outputJson: true } : {}),
      });
      if (code !== 0) process.exitCode = code;
    },
    description:
      'One screen for what this install can do: tools, skills, commands, agents, hooks, MCP, devices',
  },

  // Read-only closed-loop inspection: workspace command, no model config needed.
  artifacts: {
    name: 'artifacts',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runArtifactsCommand } = await import('./artifacts-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] artifacts could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      // B212: `--json` is a global flag and is stripped from commandArgs; the
      // artifacts handler reads it from its own argv (same trap as review).
      const argv =
        ctx.commandArgs.includes('--json') || !ctx.argv.includes('--json')
          ? ctx.commandArgs
          : [...ctx.commandArgs, '--json'];
      const code = await runArtifactsCommand(argv, { workspace });
      if (code !== 0) process.exitCode = code;
    },
    description:
      'Read-only closed-loop artifacts: contracts, evidence, deployments, acceptance, device, timeline',
  },

  task: {
    name: 'task',
    phase: CliPhase.AgentReady,
    handler: async (ctx) => {
      await dispatchVerifiedRun(ctx, ctx.commandArgs);
    },
    description:
      'Unified task runtime: run/resume/status/timeline — one goal in, one verified result out',
  },

  // Hero shortcut: `moss goal "<intent>" --accept "<cmd>"` is the product's
  // one-line promise (one intent in, one verified result out). It is exactly
  // `moss task run`, so the two can never drift; the long form stays documented
  // for discoverability and for the other task subcommands.
  goal: {
    name: 'goal',
    phase: CliPhase.AgentReady,
    handler: async (ctx) => {
      const { classifyRunMode } = await import('./run-mode-args.js');
      const mode = classifyRunMode(ctx.commandArgs);
      if (mode.mode === 'error') {
        const { ExitCode } = await import('./exit-codes.js');
        console.error(`moss goal: ${mode.message}`);
        process.exitCode = ExitCode.USAGE;
        return;
      }
      if (mode.mode === 'workflow') {
        const { runWorkflowCommand } = await import('./workflow-command.js');
        const workspace = ctx.workspace as string | undefined;
        if (!workspace) {
          console.error('[moss] run could not resolve the workspace.');
          process.exitCode = 2;
          return;
        }
        const code = await runWorkflowCommand(['run', mode.target, ...mode.rest], {
          workspaceDir: workspace,
          json: ctx.argv.includes('--json'),
          mock: ctx.argv.includes('--mock'),
        });
        if (code !== 0) process.exitCode = code;
        return;
      }
      if (mode.mode === 'until') {
        const { runLoopCommand } = await import('./loop-command.js');
        const workspace = ctx.workspace as string | undefined;
        const agent = ctx.agent;
        if (!workspace || !agent) {
          console.error('[moss] run could not resolve the workspace/agent.');
          process.exitCode = 2;
          return;
        }
        process.exitCode = await runLoopCommand([...mode.rest, '--until', mode.until], {
          agent: agent as MossAgent,
          workspaceDir: workspace,
        });
        return;
      }
      const { shapeRunResumeArgs, resumeTaskArgs } = await import('./run-resume-args.js');
      const shaped = shapeRunResumeArgs(ctx.commandArgs);
      if (!shaped.resume) {
        await dispatchVerifiedRun(ctx, ['run', ...ctx.commandArgs]);
        return;
      }
      const workspace = ctx.workspace as string | undefined;
      let target = shaped.id;
      if (!target && workspace) {
        // No id: the newest resumable task, same rule `/goal resume` uses.
        const { listTaskStateSnapshots } = await import('../core/index.js');
        const { isResumableTaskPhase } = await import('../contracts/task-runtime.js');
        const latest = (await listTaskStateSnapshots(workspace))
          .filter((snapshot) => isResumableTaskPhase(snapshot.phase))
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        target = latest?.taskId;
      }
      if (!target) {
        const { ExitCode } = await import('./exit-codes.js');
        console.error(
          'moss goal --resume: no resumable task in this workspace. Start one with `moss goal "<intent>" --accept "<cmd>"`, or pass a task id.'
        );
        process.exitCode = ExitCode.USAGE;
        return;
      }
      await dispatchVerifiedRun(ctx, resumeTaskArgs(shaped, target));
    },
    description: 'Verified run: intent in, acceptance-checked result out (moss task run shortcut)',
  },

  // B129: one read path over every autonomous run, whatever engine produced it.
  runs: {
    name: 'runs',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runRunsCommand } = await import('./runs-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] runs could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runRunsCommand(ctx.commandArgs, {
        workspace,
        ...(ctx.argv.includes('--json') ? { outputJson: true } : {}),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Unified run ledger: list/show/prune every task, loop and workflow run',
  },

  skill: {
    name: 'skill',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runSkillCommand } = await import('./skill-commands.js');
      const { ExitCode } = await import('./exit-codes.js');
      const { resolveConfigDir } = await import('./config.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] skill could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runSkillCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        configDir: resolveConfigDir(),
        json: ctx.argv.includes('--json'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Skills: create/list (.moss/skills scaffolding)',
  },

  review: {
    name: 'review',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runReviewCommand } = await import('./review-commands.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] review could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      // B211: `--json` is a global flag, so the top-level parser removes it from
      // commandArgs; pass it down explicitly or `moss review list --json` printed text.
      const argv = ctx.commandArgs.includes('--json')
        ? ctx.commandArgs
        : ctx.argv.includes('--json')
          ? [...ctx.commandArgs, '--json']
          : ctx.commandArgs;
      const code = await runReviewCommand(argv, { workspaceDir: workspace });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Independent review records: list/check (.moss/review.jsonl, CI-ready exit codes)',
  },

  loop: {
    name: 'loop',
    phase: CliPhase.AgentReady,
    handler: async (ctx) => {
      const { readLoopHistoryCommand, runLoopCommand } = await import('./loop-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] loop could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      // History and pruning are a pure read/delete of `.moss/loops/`: do not
      // build a provider or an agent for them (and they work with no API key).
      const sub = ctx.commandArgs[0];
      if (sub === 'list' || sub === 'show' || sub === 'follow' || sub === 'prune') {
        process.exitCode = await readLoopHistoryCommand(ctx.commandArgs, {
          workspaceDir: workspace,
          json: ctx.argv.includes('--json'),
        });
        return;
      }
      const agent = ctx.agent as MossAgent | undefined;
      if (!agent) {
        console.error('[moss] loop could not resolve the agent.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      process.exitCode = await runLoopCommand(ctx.commandArgs, { agent, workspaceDir: workspace });
    },
    description:
      'Closed loop: run the agent, check with your command, feed failures back (--until); `list|show|follow|prune` manage the ledger',
  },

  plugins: {
    name: 'plugins',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runPluginsCommand } = await import('./plugin-commands.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] plugins could not resolve the workspace.');
        process.exitCode = 2;
        return;
      }
      const code = await runPluginsCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        json: ctx.argv.includes('--json'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Local capability packs: validate / install / list / remove',
  },

  workflow: {
    name: 'workflow',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runWorkflowCommand } = await import('./workflow-command.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] workflow could not resolve the workspace.');
        process.exitCode = 2;
        return;
      }
      const code = await runWorkflowCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        json: ctx.argv.includes('--json'),
        mock: ctx.argv.includes('--mock'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description:
      'Declarative orchestration: JSON plan of dependent headless steps (run/resume/status/list)',
  },

  rules: {
    name: 'rules',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runRulesCommand } = await import('./rules-commands.js');
      const { resolveConfigDir } = await import('./config.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] rules could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runRulesCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        userDir: resolveConfigDir(),
        json: ctx.argv.includes('--json'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Scoped instruction rules: list activation class, globs and size',
  },

  remember: {
    name: 'remember',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runRememberCommand } = await import('./remember-command.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] remember could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runRememberCommand(ctx.commandArgs, { workspaceDir: workspace });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Explicit memory: append one fact to AGENTS.md (--dry-run previews)',
  },

  device: {
    name: 'device',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runDeviceCommand } = await import('./device-commands.js');
      const { ExitCode } = await import('./exit-codes.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] device could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const code = await runDeviceCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        json: ctx.argv.includes('--json'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Manage devices: add/list/remove/test (.moss/devices.json registry)',
  },

  mcp: {
    name: 'mcp',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { runMcpCommand } = await import('./mcp-commands.js');
      const { ExitCode } = await import('./exit-codes.js');
      const { resolveConfigDir } = await import('./config.js');
      const workspace = ctx.workspace;
      if (!workspace) {
        console.error('[moss] mcp could not resolve the workspace.');
        process.exitCode = ExitCode.USAGE;
        return;
      }
      const configDir = resolveConfigDir();
      const loaded = ctx.loadedConfig;
      const rdkDocsConfig =
        typeof loaded === 'object' &&
        loaded !== null &&
        'config' in loaded &&
        typeof loaded.config === 'object' &&
        loaded.config !== null &&
        'rdkDocs' in loaded.config
          ? loaded.config.rdkDocs
          : undefined;
      const code = await runMcpCommand(ctx.commandArgs, {
        workspaceDir: workspace,
        configDir,
        json: ctx.argv.includes('--json'),
        ...(rdkDocsConfig !== undefined ? { rdkDocs: rdkDocsConfig } : {}),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'Manage MCP servers: add/list/remove/test (project or user config)',
  },

  trust: {
    name: 'trust',
    phase: CliPhase.None,
    handler: async (ctx) => {
      const { runTrustCommand } = await import('./trust-commands.js');
      const code = await runTrustCommand(ctx.commandArgs, {
        json: ctx.argv.includes('--json'),
      });
      if (code !== 0) process.exitCode = code;
    },
    description: 'List or remove trusted folders (user trust store)',
  },

  setup: {
    name: 'setup',
    phase: CliPhase.None,
    description: 'Interactive setup: provider, model, API key',
    handler: async () => {
      // Imported from cli/setup-wizard.js
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard();
    },
  },

  update: {
    name: 'update',
    phase: CliPhase.None,
    description: 'Print the upgrade command for this install (does not run it)',
    handler: async (ctx) => {
      const { runUpdateCommand } = await import('./update-command.js');
      runUpdateCommand(undefined, [
        ...ctx.commandArgs,
        ...(ctx.argv.includes('--json') ? ['--json'] : []),
      ]);
    },
  },

  uninstall: {
    name: 'uninstall',
    phase: CliPhase.None,
    description: 'Print removal paths and optionally delete the config directory',
    handler: async (ctx) => {
      const { runUninstall } = await import('./uninstall.js');
      await runUninstall({ ...(ctx.argv.includes('--json') ? { json: true } : {}) });
    },
  },

  auth: {
    name: 'auth',
    phase: CliPhase.ConfigOnly,
    description: 'Authentication status or logout (bare `auth` prints status)',
    handler: async (ctx) => {
      const { runAuthLogout, renderAuthStatus } = await import('./setup-wizard.js');
      const subCmd = ctx.commandArgs[0];

      if (subCmd === 'status') {
        if (ctx.argv.includes('--json')) {
          const { renderAuthStatusJson } = await import('./config-commands.js');
          console.log(renderAuthStatusJson(process.env, ctx.fallbackStartDir).trimEnd());
        } else {
          console.log(renderAuthStatus(undefined, process.env, ctx.fallbackStartDir));
        }
        return;
      }

      if (subCmd === 'logout') {
        await runAuthLogout();
        return;
      }

      // A bare `moss auth` (or the `moss login` alias) reads as a status
      // question; printing usage instead made the command look broken.
      if (subCmd === undefined) {
        console.log(renderAuthStatus(undefined, process.env, ctx.fallbackStartDir));
        return;
      }

      console.error('Usage: moss auth <status|logout>');
      const { ExitCode } = await import('./exit-codes.js');
      process.exitCode = ExitCode.USAGE;
    },
  },

  config: {
    name: 'config',
    phase: CliPhase.ConfigOnly,
    description: 'Consult or edit moss config keys (see `moss config --help`)',
    handler: async (ctx) => {
      const {
        runConfigShow,
        runConfigInit,
        runConfigSet,
        runConfigUnset,
        runConfigValidate,
        runConfigEnv,
        renderConfigUsage,
      } = await import('./config-commands.js');
      const { ExitCode } = await import('./exit-codes.js');

      const isConfigShow = (args: string[]) =>
        args.length === 0 || args[0] === 'show' || args[0] === 'status';
      const checkJsonOutput = (args: string[]) => args.some((arg) => arg === '--json');

      const fallbackStartDir = ctx.fallbackStartDir || '.';

      if (isConfigShow(ctx.commandArgs)) {
        runConfigShow(fallbackStartDir, {
          json: checkJsonOutput(ctx.argv),
          overrides: ctx.configOverrides as never,
        });
        return;
      }

      if (ctx.commandArgs[0] === 'env') {
        runConfigEnv();
        return;
      }

      if (ctx.commandArgs[0] === 'init') {
        runConfigInit(ctx.commandArgs.slice(1), fallbackStartDir);
        return;
      }

      if (ctx.commandArgs[0] === 'set') {
        runConfigSet(ctx.commandArgs.slice(1), fallbackStartDir);
        return;
      }

      if (ctx.commandArgs[0] === 'unset') {
        runConfigUnset(ctx.commandArgs.slice(1), fallbackStartDir);
        return;
      }

      if (ctx.commandArgs[0] === 'validate') {
        const validateArgs = [...ctx.commandArgs.slice(1)];
        if (checkJsonOutput(ctx.argv) && !validateArgs.includes('--json')) {
          validateArgs.push('--json');
        }
        runConfigValidate(validateArgs, fallbackStartDir);
        return;
      }

      console.error(renderConfigUsage());
      process.exitCode = ExitCode.USAGE;
    },
  },

  doctor: {
    name: 'doctor',
    phase: CliPhase.ConfigOnly,
    description: 'inspect config, auth, workspace, and runtime state',
    handler: async (ctx) => {
      // `moss doctor` was documented (help.ts) but had no dispatcher entry, so
      // the subcommand silently did nothing (renderCliDoctor was dead code).
      // Wire it now: build DoctorOptions from the resolved config + workspace
      // and print the report.
      const { renderCliDoctor, cliDoctorHasFailure } = await import('./doctor.js');
      const { resolveCliDetailMode } = await import('./output.js');
      const { getPackageVersion } = await import('./package-info.js');
      const path = await import('node:path');
      const config = ctx.resolvedConfig as import('./config.js').ResolvedCliConfig | undefined;
      if (!config) {
        console.error('[moss] doctor could not resolve config.');
        return;
      }
      const workspace = (ctx.workspace as string | undefined) ?? config.workspace;
      const report = await renderCliDoctor({
        config,
        runtimeDir: path.join(workspace, '.moss'),
        currentVersion: getPackageVersion(),
        safetyMode: String(config.safetyMode),
        detailMode: resolveCliDetailMode(),
      });
      console.error(report);
      if (cliDoctorHasFailure(report)) process.exitCode = 1;
    },
  },

  sessions: {
    name: 'sessions',
    phase: CliPhase.WorkspaceReady,
    description: 'Saved sessions: list/delete/search/export',
    handler: async (ctx) => {
      const { JsonlSessionStore } = await import('../core/index.js');
      const { ExitCode } = await import('./exit-codes.js');
      const { errorMessage } = await import('../errors.js');

      const store = new JsonlSessionStore({
        dir: (ctx.workspacePathMigration as any).paths.sessionsDir,
      });
      const subCommand = ctx.commandArgs[0];
      // B277: the arg parser strips the global `--json`; read it from argv.
      const jsonOut = ctx.argv.includes('--json');

      if (subCommand === 'list' || !subCommand) {
        const listArgs = subCommand === 'list' ? ctx.commandArgs.slice(1) : ctx.commandArgs;
        const showAll = listArgs.includes('--no-limit');
        const limitArg = listArgs.find((a) => a.startsWith('--limit='));
        const limit = limitArg ? parseInt(limitArg.slice(8), 10) : 20;

        const sessions = await store.listSessions().catch(() => []);
        if (sessions.length === 0) {
          if (jsonOut) {
            console.log('{"schema":"moss_sessions_list.v1","sessions":[],"total":0,"shown":0}');
            return;
          }
          console.log(uiText('No saved sessions in this workspace.', '此工作区没有已保存的会话。'));
          return;
        }

        const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const shown = showAll ? sorted : sorted.slice(0, limit);
        if (jsonOut) {
          console.log(
            JSON.stringify({
              schema: 'moss_sessions_list.v1',
              sessions: shown.map((session) => ({
                key: session.sessionKey,
                messageCount: session.messageCount,
                updatedAt: session.updatedAt,
                title: session.title ?? '',
              })),
              total: sorted.length,
              shown: shown.length,
            })
          );
          return;
        }
        console.log(
          uiText(
            'SESSION                          MESSAGES  UPDATED             TITLE',
            '会话                              消息      更新时间            标题'
          )
        );
        console.log('─'.repeat(96));
        for (const session of shown) {
          const updated = formatSessionTimestamp(session.updatedAt);
          console.log(
            `${session.sessionKey.padEnd(32)}  ${String(session.messageCount).padStart(7)}  ${updated.padEnd(19)}  ${formatSessionTitle(session.title)}`
          );
        }
        if (!showAll && sorted.length > limit) {
          const hidden = sorted.length - limit;
          console.log(
            uiText(
              `\n  … ${hidden} more session(s) not shown. Run \`moss sessions list --no-limit\` to see all.`,
              `\n  … 还有 ${hidden} 个会话未显示。运行 \`moss sessions list --no-limit\` 可查看全部。`
            )
          );
        }
        return;
      }

      if (subCommand === 'delete') {
        const key = ctx.commandArgs[1];
        if (!key) {
          console.error('Usage: moss sessions delete <key>');
          process.exitCode = ExitCode.USAGE;
          return;
        }

        const exists = await store.exists(key).catch(() => false);
        if (!exists) {
          console.error(`[sessions] No session named "${key}" found.`);
          process.exitCode = ExitCode.SESSION;
          return;
        }

        await store.deleteSession(key).catch((err) => {
          console.error(`[sessions] Failed to delete "${key}": ${errorMessage(err)}`);
          process.exitCode = ExitCode.SESSION;
        });

        if (!process.exitCode) {
          console.log(`[sessions] Deleted "${key}".`);
        }
        return;
      }

      if (subCommand === 'search') {
        const query = ctx.commandArgs.slice(1).join(' ').trim();
        if (!query) {
          console.error('Usage: moss sessions search <text>');
          process.exitCode = ExitCode.USAGE;
          return;
        }
        const sessions = await store.listSessions().catch(() => []);
        if (sessions.length === 0) {
          console.log(uiText('No saved sessions to search.', '没有可搜索的已保存会话。'));
          return;
        }
        const hits = await searchSessions(store, query);
        if (jsonOut) {
          console.log(
            JSON.stringify({
              schema: 'moss_sessions_search.v1',
              query,
              hits: hits.map((hit) => ({
                key: hit.key,
                messageCount: hit.messageCount,
                updatedAt: hit.updatedAt,
                snippet: hit.snippet,
              })),
            })
          );
          return;
        }
        if (hits.length === 0) {
          console.log(uiText(`No sessions matched "${query}".`, `没有会话匹配「${query}」。`));
          return;
        }
        console.log(
          uiText(
            'SESSION                          MESSAGES  UPDATED           MATCH',
            '会话                              消息      更新时间          匹配'
          )
        );
        console.log('─'.repeat(96));
        for (const hit of hits) {
          const updated = formatSessionTimestamp(hit.updatedAt);
          console.log(
            `${hit.key.padEnd(32)}  ${String(hit.messageCount).padStart(7)}  ${updated.padEnd(19)}  ${hit.snippet}`
          );
        }
        const capNote = isZhLocale()
          ? hits.length >= SESSION_SEARCH_MAX_HITS
            ? `（最多 ${SESSION_SEARCH_MAX_HITS} 条，缩小查询范围可看更多）`
            : ''
          : hits.length >= SESSION_SEARCH_MAX_HITS
            ? ` (capped at ${SESSION_SEARCH_MAX_HITS} — narrow your query for more)`
            : '';
        console.log(
          isZhLocale()
            ? `\n  ${hits.length} 个会话匹配「${query}」。${capNote}  用 \`moss resume ${hits[0]!.key}\` 恢复。`
            : `\n  ${hits.length} session(s) matched "${query}".${capNote}  Resume one with \`moss resume ${hits[0]!.key}\`.`
        );
        return;
      }

      if (subCommand === 'export') {
        let key = ctx.commandArgs[1];
        // B218: `--last` mirrors `moss resume --last` / `runs export latest`
        // instead of making the caller copy an opaque session key.
        const wantsLast =
          key === '--last' ||
          key === 'latest' ||
          (ctx.argv.includes('--last') && (key === undefined || key.startsWith('--out')));
        if (wantsLast) {
          const sessions = (await store.listSessions().catch(() => []))
            .filter((session) => (session.messageCount ?? 0) > 0)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          key = sessions[0]?.sessionKey;
          if (!key) {
            console.error('[sessions] No saved sessions with messages to export.');
            process.exitCode = ExitCode.SESSION;
            return;
          }
        }
        if (!key) {
          console.error('Usage: moss sessions export <key|--last> [--out=<file>]');
          process.exitCode = ExitCode.USAGE;
          return;
        }
        const exists = await store.exists(key).catch(() => false);
        if (!exists) {
          console.error(`[sessions] No session named "${key}" found.`);
          process.exitCode = ExitCode.SESSION;
          return;
        }
        const messages = await store.loadMessages(key).catch((err) => {
          console.error(`[sessions] Failed to load "${key}": ${errorMessage(err)}`);
          process.exitCode = ExitCode.SESSION;
          return undefined;
        });
        if (!messages) return;
        const markdown = renderSessionMarkdown(key, messages);
        // `--out=<file>` and `--out <file>`; `--out=-` writes stdout.
        let outPath: string | null = null;
        for (let i = 1; i < ctx.commandArgs.length; i += 1) {
          const arg = ctx.commandArgs[i]!;
          if (arg.startsWith('--out=')) {
            outPath = arg.slice('--out='.length);
          } else if (arg === '--out') {
            outPath = ctx.commandArgs[i + 1] ?? null;
            i += 1;
          }
        }
        if (outPath) {
          if (outPath === '-') {
            process.stdout.write(markdown + '\n');
            return;
          }
          const resolved = resolveExportOutPath(ctx.workspace ?? process.cwd(), outPath);
          if ('error' in resolved) {
            console.error(`[sessions] ${resolved.error}`);
            process.exitCode = ExitCode.USAGE;
            return;
          }
          const { writeFile } = await import('node:fs/promises');
          try {
            await writeFile(resolved.absolute, markdown + '\n', 'utf8');
            console.log(
              `[sessions] Exported "${key}" to ${outPath} (${countExportableSessionMessages(messages)} message(s)).`
            );
          } catch (err) {
            console.error(`[sessions] Failed to write "${outPath}": ${errorMessage(err)}`);
            process.exitCode = ExitCode.SESSION;
          }
        } else {
          process.stdout.write(markdown + '\n');
        }
        return;
      }

      console.error('Usage: moss sessions [list|delete <key>|search <text>|export <key>]');
      process.exitCode = ExitCode.USAGE;
    },
  },

  // `chat` (one-shot) and `resume`/`fork` and interactive fall through to
  // AgentReady initialization (see dispatcher logic in main())
};

/**
 * Subcommands that parse as commands (KNOWN_COMMANDS in args.ts) but have no
 * implementation in this build — subsystems removed before v0.14. Dispatching
 * one must hard-fail instead of silently falling through to chat.
 */
export const UNIMPLEMENTED_COMMANDS: readonly string[] = ['migrate', 'web', 'agent'];

export function isUnimplementedCommand(commandName: string | undefined): boolean {
  return !!commandName && UNIMPLEMENTED_COMMANDS.includes(commandName);
}

/**
 * Returns the CliPhase needed to dispatch the given command.
 * Returns CliPhase.AgentReady if the command is not in the table
 * (means it's a chat/interactive command).
 */
export function getPhaseForCommand(commandName: string | undefined): CliPhase {
  if (!commandName) return CliPhase.AgentReady; // bare `moss` = interactive
  const config = COMMANDS[commandName];
  return config?.phase ?? CliPhase.AgentReady;
}

/**
 * Returns the CommandConfig if the command is in the table.
 * Returns undefined if the command should fall through to AgentReady.
 */
export function getCommandConfig(commandName: string | undefined): CommandConfig | undefined {
  if (!commandName) return undefined;
  return COMMANDS[commandName];
}
