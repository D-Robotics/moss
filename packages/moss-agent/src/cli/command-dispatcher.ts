// Command dispatcher with explicit initialization phases.
// Replaces 22 if-else branches in main() with a declarative routing table.

import type { LLMMessage } from '../core/llm/llm-provider.js';
import type { SessionStore, SessionMeta } from '../core/session/session.js';

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
  if (!cleaned) return '(no title)';
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
export function renderSessionMarkdown(sessionKey: string, messages: LLMMessage[]): string {
  const lines: string[] = [
    `# Session ${sessionKey}`,
    '',
    `_${messages.length} message(s) · exported from moss._`,
    '',
  ];
  for (const msg of messages) {
    lines.push(`## ${msg.role}`, '');
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) lines.push(content, '');
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lines.push(block.text, '');
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
    text += content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += '\n' + block.text;
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
  // Full agent ready: chat, interactive, device access, etc.
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
 * Command routing table.
 * Maps command name to CommandConfig.
 * Replaces the big if-else tree in main().
 */
export const COMMANDS: Record<string, CommandConfig> = {
  setup: {
    name: 'setup',
    phase: CliPhase.None,
    handler: async () => {
      // Imported from cli/setup.js
      const { runSetupWizard } = await import('./setup.js');
      await runSetupWizard();
    },
  },

  auth: {
    name: 'auth',
    phase: CliPhase.ConfigOnly,
    handler: async (ctx) => {
      const { runAuthLogout, renderAuthStatus } = await import('./setup.js');
      const { runMossCommunityAuthLogin } = await import('./community-auth.js');
      const subCmd = ctx.commandArgs[0];

      if (subCmd === 'status') {
        console.log(renderAuthStatus(undefined, process.env, ctx.fallbackStartDir));
        return;
      }

      if (subCmd === 'login') {
        await runMossCommunityAuthLogin({
          manual: ctx.commandArgs.includes('--manual'),
          openBrowser: !ctx.commandArgs.includes('--manual'),
        });
        return;
      }

      if (subCmd === 'logout') {
        await runAuthLogout();
        return;
      }

      console.error('Usage: moss auth <login|status|logout>');
      const { ExitCode } = await import('./exit-codes.js');
      process.exitCode = ExitCode.USAGE;
    },
  },

  config: {
    name: 'config',
    phase: CliPhase.ConfigOnly,
    handler: async (ctx) => {
      const {
        runConfigShow,
        runConfigInit,
        runConfigSet,
        runConfigUnset,
        runConfigValidate,
        renderConfigUsage,
      } = await import('./setup.js');
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

  mcp: {
    name: 'mcp',
    phase: CliPhase.ConfigOnly,
    handler: async (ctx) => {
      const { runMcpCommand } = await import('./mcp-command.js');
      runMcpCommand(ctx.commandArgs, ctx.fallbackStartDir || '.');
    },
  },

  doctor: {
    name: 'doctor',
    phase: CliPhase.ConfigOnly,
    description: 'inspect config, auth, workspace, runtime, skills, MCP, and update state',
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

  update: {
    name: 'update',
    phase: CliPhase.ConfigOnly,
    description: 'update moss to the latest published version (npm i -g @rdk-moss/agent@latest)',
    handler: async (ctx) => {
      // `moss update` was in the CliCommand type and help.ts but had no
      // dispatcher entry — silently did nothing. runCliUpdate existed but was
      // never called. Wire it now.
      const { runCliUpdate } = await import('./update.js');
      const { getPackageVersion } = await import('./package-info.js');
      const path = await import('node:path');
      const config = ctx.resolvedConfig as import('./config.js').ResolvedCliConfig | undefined;
      const configDir = config?.configPath
        ? path.dirname(config.configPath)
        : ctx.fallbackStartDir || '.';
      const code = await runCliUpdate({
        configDir,
        currentVersion: getPackageVersion(),
      });
      if (code !== 0) process.exitCode = code;
    },
  },

  migrate: {
    name: 'migrate',
    phase: CliPhase.ConfigOnly,
    handler: async (ctx) => {
      const { runMigrateCommand } = await import('./migrate-command.js');
      runMigrateCommand(ctx.fallbackStartDir || '.');
    },
  },

  sessions: {
    name: 'sessions',
    phase: CliPhase.WorkspaceReady,
    handler: async (ctx) => {
      const { JsonlSessionStore } = await import('../core/index.js');
      const { ExitCode } = await import('./exit-codes.js');
      const { errorMessage } = await import('../errors.js');

      const store = new JsonlSessionStore({
        dir: (ctx.workspacePathMigration as any).paths.sessionsDir,
      });
      const subCommand = ctx.commandArgs[0];

      if (subCommand === 'list' || !subCommand) {
        const listArgs = subCommand === 'list' ? ctx.commandArgs.slice(1) : ctx.commandArgs;
        const showAll = listArgs.includes('--no-limit');
        const limitArg = listArgs.find((a) => a.startsWith('--limit='));
        const limit = limitArg ? parseInt(limitArg.slice(8), 10) : 20;

        const sessions = await store.listSessions().catch(() => []);
        if (sessions.length === 0) {
          console.log('No saved sessions in this workspace.');
          return;
        }

        const sorted = sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        const shown = showAll ? sorted : sorted.slice(0, limit);
        console.log('SESSION                          MESSAGES  UPDATED             TITLE');
        console.log('─'.repeat(96));
        for (const session of shown) {
          const updated = Number.isFinite(session.updatedAt)
            ? new Date(session.updatedAt).toLocaleString()
            : 'unknown';
          console.log(
            `${session.sessionKey.padEnd(32)}  ${String(session.messageCount).padStart(7)}  ${updated.padEnd(19)}  ${formatSessionTitle(session.title)}`
          );
        }
        if (!showAll && sorted.length > limit) {
          console.log(
            `\n  … ${sorted.length - limit} more session(s) not shown. Run \`moss sessions list --no-limit\` to see all.`
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
          console.log('No saved sessions to search.');
          return;
        }
        const hits = await searchSessions(store, query);
        if (hits.length === 0) {
          console.log(`No sessions matched "${query}".`);
          return;
        }
        console.log('SESSION                          MESSAGES  UPDATED           MATCH');
        console.log('─'.repeat(96));
        for (const hit of hits) {
          const updated = Number.isFinite(hit.updatedAt)
            ? new Date(hit.updatedAt).toLocaleString()
            : 'unknown';
          console.log(
            `${hit.key.padEnd(32)}  ${String(hit.messageCount).padStart(7)}  ${updated.padEnd(17)}  ${hit.snippet}`
          );
        }
        const capNote =
          hits.length >= SESSION_SEARCH_MAX_HITS
            ? ` (capped at ${SESSION_SEARCH_MAX_HITS} — narrow your query for more)`
            : '';
        console.log(
          `\n  ${hits.length} session(s) matched "${query}".${capNote}  Resume one with \`moss resume ${hits[0]!.key}\`.`
        );
        return;
      }

      if (subCommand === 'export') {
        const key = ctx.commandArgs[1];
        if (!key) {
          console.error('Usage: moss sessions export <key> [--out <file>]');
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
        const outFlag = ctx.commandArgs.find((a) => a.startsWith('--out='));
        const outPath = outFlag ? outFlag.slice(6) : null;
        if (outPath) {
          const { writeFile } = await import('node:fs/promises');
          const resolved = outPath === '-' ? null : outPath;
          if (!resolved) {
            // --out=- writes to stdout
            process.stdout.write(markdown + '\n');
            return;
          }
          try {
            await writeFile(resolved, markdown + '\n', 'utf8');
            console.log(
              `[sessions] Exported "${key}" to ${resolved} (${messages.length} message(s)).`
            );
          } catch (err) {
            console.error(`[sessions] Failed to write "${resolved}": ${errorMessage(err)}`);
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
