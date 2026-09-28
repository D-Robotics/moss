import { estimateTokensForText } from '../../context/tokens.js';
import type { MossAgent } from '../../core/index.js';
import {
  renderCliPermissions,
  renderCliQuickStart,
  renderCliSessionDoctor,
  renderCliStatus,
  type CliRuntimeStatus,
} from '../onboarding.js';
import { runProcess } from '../../utils/run-process.js';
import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import type { ContextUsageSnapshot } from '../usage-display.js';
import { isZhLocale as isZh } from '../cli-locale.js';
import {
  formatCliInteractionModeLabel,
  getCliInteractionMode,
  parseCliInteractionMode,
  setCliInteractionMode,
  type CliInteractionMode,
} from '../approval.js';

export interface CommandInputOptions {
  label: string;
  initialValue?: string;
  masked?: boolean;
}

export type CommandInputPrompt = (options: CommandInputOptions) => Promise<string | null>;

export type CommandSurface = 'repl';

export interface CommandContext {
  agent: MossAgent;
  runtime: CliRuntimeStatus | undefined;
  sessionKey: string;
  workspace: string;
  locale?: string;
  surface: CommandSurface;

  say(kind: 'system' | 'error', text: string): void;

  prefillInput(text: string): void;

  promptInput?: CommandInputPrompt;

  submitPrompt?(text: string): void;
  getContextUsage?(): ContextUsageSnapshot | undefined;
  /** Optional: keep host interactionMode state in sync with setCliInteractionMode. */
  setInteractionMode?(mode: CliInteractionMode): void;
}

export interface CommandSpec {
  name: `/${string}`;

  aliases?: readonly `/${string}`[];

  summary: string;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}

const quickstartCommand: CommandSpec = {
  name: '/quickstart',
  aliases: ['/quick_start', '/start'],
  summary: 'show setup and next-steps guidance',
  run(ctx) {
    ctx.say('system', renderCliQuickStart(ctx.agent, ctx.runtime));
  },
};

const statusCommand: CommandSpec = {
  name: '/status',
  summary: 'view model, workspace, and tool state',
  run(ctx, args) {
    ctx.say(
      'system',
      renderCliStatus(ctx.agent, ctx.runtime, { verbose: args.includes('--verbose') })
    );
  },
};

const doctorCommand: CommandSpec = {
  name: '/doctor',
  summary: 'health-check model, egress, and config in this session',
  run(ctx) {
    ctx.say('system', renderCliSessionDoctor(ctx.agent, ctx.runtime));
  },
};

const permissionsCommand: CommandSpec = {
  name: '/permissions',
  summary: 'show safety mode, approval policy, and permissions',
  run(ctx) {
    ctx.say('system', renderCliPermissions(ctx.runtime));
  },
};

const modeCommand: CommandSpec = {
  name: '/mode',
  aliases: ['/plan'],
  summary: 'show or set interaction mode: plan | default | accept-edits',
  run(ctx, args) {
    const zh = isZh(ctx.locale);
    const token = args.trim();
    if (!token || token === 'status' || token === 'show') {
      const mode = getCliInteractionMode();
      const label = formatCliInteractionModeLabel(mode, zh);
      ctx.say(
        'system',
        zh
          ? [
              `当前交互模式：${label}`,
              '  /mode plan          只读规划（不执行写操作）',
              '  /mode default       正常编码（变更需审批）',
              '  /mode accept-edits  自动接受工作区内文件编辑',
              '  快捷键：Shift+Tab 在三种模式间循环',
            ].join('\n')
          : [
              `Interaction mode: ${label}`,
              '  /mode plan          read-only planning (block mutations)',
              '  /mode default       normal coding (approve mutations)',
              '  /mode accept-edits  auto-approve sandboxed workspace edits',
              '  Shortcut: Shift+Tab cycles plan / default / accept-edits',
            ].join('\n')
      );
      return;
    }
    const next = parseCliInteractionMode(token);
    if (!next) {
      ctx.say(
        'error',
        zh ? '用法：/mode [plan|default|accept-edits]' : 'Usage: /mode [plan|default|accept-edits]'
      );
      return;
    }
    setCliInteractionMode(next);
    ctx.setInteractionMode?.(next);
    const label = formatCliInteractionModeLabel(next, zh);
    ctx.say(
      'system',
      zh
        ? next === 'plan'
          ? `已切换到${label}：只读探索与规划；写文件/副作用命令会被拦截。规划完成后用 /mode default 或 Shift+Tab 退出。`
          : next === 'acceptEdits'
            ? `已切换到${label}：工作区内文件编辑自动通过；shell 变更仍会确认。`
            : `已切换到${label}：正常编码，变更按审批策略确认。`
        : next === 'plan'
          ? `Switched to ${label}: explore and plan read-only; file/side-effect tools are blocked. Leave with /mode default or Shift+Tab when ready to implement.`
          : next === 'acceptEdits'
            ? `Switched to ${label}: sandboxed workspace edits auto-approve; shell mutations still prompt.`
            : `Switched to ${label}: normal coding with the current approval policy.`
    );
  },
};

const contextCommand: CommandSpec = {
  name: '/context',
  summary: 'show message count and token usage in this session',
  async run(ctx) {
    try {
      const msgs = await ctx.agent.config.sessionStore.loadMessages(ctx.sessionKey);
      const tokens = msgs.reduce((n, m) => {
        const content = (m as { content?: unknown }).content;
        const text = typeof content === 'string' ? content : content ? JSON.stringify(content) : '';
        return n + estimateTokensForText(text);
      }, 0);
      const windowTokens = ctx.agent.config.contextTokens ?? 200_000;
      const reported = ctx.getContextUsage?.();
      const usage: ContextUsageSnapshot = reported ?? {
        used: tokens,
        total: windowTokens,
        source: 'estimated',
      };
      const pct = Math.min(100, Math.round((usage.used / usage.total) * 100));
      const usagePrefix = usage.source === 'estimated' ? '~' : '';
      const detailLines =
        usage.source === 'provider'
          ? [
              `  source     provider-reported (latest model call)`,
              `  input      ${(usage.inputTokens ?? 0).toLocaleString()}`,
              `  cache read ${(usage.cacheReadTokens ?? 0).toLocaleString()}`,
              `  cache new  ${(usage.cacheCreationTokens ?? 0).toLocaleString()}`,
            ]
          : ['  source     local estimate from saved message content'];
      ctx.say(
        'system',
        [
          'Context window',
          `  messages   ${msgs.length}`,
          `  usage      ${usagePrefix}${usage.used.toLocaleString()} / ${usage.total.toLocaleString()} tokens (${pct}%)`,
          ...detailLines,
          `  model      ${ctx.agent.config.model ?? ''}`,
        ].join('\n')
      );
    } catch (err) {
      ctx.say('error', `Could not read context: ${errorMessage(err)}`);
    }
  },
};

function buildReviewPrompt(diff: string, scopeLabel: string): string {
  return [
    `You are reviewing the following code change (${scopeLabel}). Review ONLY the diff below;`,
    'do not review pre-existing code unrelated to these changes. Read surrounding files with your',
    'tools only when a hunk is ambiguous.',
    '',
    'Review across these dimensions and report HIGH-SIGNAL findings only (skip style nitpicks a',
    'linter would catch and anything you cannot confirm from the diff):',
    '  1. Correctness & bugs — logic errors, null/undefined handling, race conditions, off-by-one,',
    '     wrong results regardless of input, broken control flow.',
    '  2. Security — injection, unsafe child-process/shell, secret/credential leaks, missing input',
    '     validation, path traversal, unsafe deserialization.',
    '  3. Simplification — duplicated logic, dead code, needless abstraction or nesting that can be',
    '     removed without changing behavior.',
    '  4. Type design — weak invariants, types that allow invalid states, `any`/unsafe casts that',
    '     hide real type debt.',
    '',
    'For each finding give: dimension, file:line, a one-line description, and a concrete fix. If a',
    'project guideline file (CLAUDE.md / AGENTS.md) covers a changed file, flag clear violations and',
    'quote the rule. Group findings by severity (Critical / Important / Suggestion). If nothing is',
    'wrong, say so explicitly — do not invent issues.',
    '',
    '--- BEGIN DIFF ---',
    diff,
    '--- END DIFF ---',
  ].join('\n');
}

const reviewCommand: CommandSpec = {
  name: '/review',
  summary:
    'review the working-tree diff (or `/review <PR#>`) for bugs, security, and simplification',
  async run(ctx, args) {
    if (!ctx.submitPrompt) {
      ctx.say(
        'error',
        '/review needs a session that can start a run; it is unavailable in this context.'
      );
      return;
    }
    const arg = args.trim();
    try {
      let diff: string;
      let scopeLabel: string;
      if (arg) {
        const prNumber = arg.replace(/^#/, '');
        if (!/^\d+$/.test(prNumber)) {
          ctx.say(
            'error',
            'Usage: /review            (working tree + staged changes)\n       /review <PR#>     (a GitHub pull request via `gh pr diff`)'
          );
          return;
        }
        const result = await runProcess('gh', {
          args: ['pr', 'diff', prNumber],
          cwd: ctx.workspace,
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: `gh pr diff ${prNumber} failed (exit ${result.exitCode})`,
            hint: 'Install and authenticate the GitHub CLI (`gh auth login`) and run inside the repo, or use `/review` with no argument to review local changes.',
            cause: result.stderr.trim() || undefined,
          });
        }
        diff = result.stdout;
        scopeLabel = `GitHub PR #${prNumber}`;
      } else {
        const result = await runProcess('git', {
          args: ['--no-pager', 'diff', 'HEAD'],
          cwd: ctx.workspace,
          timeout: 30_000,
        });
        if (result.exitCode !== 0) {
          const notRepo = /not a git repository/i.test(result.stderr);
          throw new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: notRepo
              ? `Not a git repository: ${ctx.workspace} — /review needs a git workspace.`
              : `git diff failed (exit ${result.exitCode})`,
            hint: notRepo
              ? 'Open a git repository, or pass a PR number: `/review <PR#>`.'
              : result.stderr.trim() || undefined,
          });
        }
        diff = result.stdout;
        scopeLabel = 'local working tree + staged changes';
      }

      if (!diff.trim()) {
        ctx.say(
          'system',
          arg
            ? `No changes found in PR ${arg}.`
            : 'No changes to review (working tree and index are clean). Make some edits, or pass a PR number: /review <PR#>.'
        );
        return;
      }

      const MAX_DIFF_CHARS = 400_000;
      const totalLines = diff.split('\n').length;
      let reviewDiff = diff;
      let truncatedNote = '';
      if (diff.length > MAX_DIFF_CHARS) {
        const kept = diff.slice(0, MAX_DIFF_CHARS);
        const keptLines = kept.split('\n').length;
        reviewDiff = `${kept}\n\n[diff truncated: showing ${keptLines} of ${totalLines} lines (${Math.round(MAX_DIFF_CHARS / 1024)} KB cap). Narrow the scope — review specific paths or stage a subset — for a complete review.]`;
        truncatedNote = ` — truncated to ${Math.round(MAX_DIFF_CHARS / 1024)} KB; narrow the scope for full coverage`;
      }

      ctx.say('system', `Reviewing ${scopeLabel} (${totalLines} diff lines)${truncatedNote} …`);
      ctx.submitPrompt(buildReviewPrompt(reviewDiff, scopeLabel));
    } catch (err) {
      const moss =
        err instanceof MossError
          ? err
          : new MossError({
              code: ErrorCode.TOOL_EXECUTION_FAILED,
              message: `Could not gather a diff for review: ${errorMessage(err)}`,
            });
      ctx.say('error', moss.hint ? `${moss.message}\n  ${moss.hint}` : moss.message);
    }
  },
};

const COMMANDS: readonly CommandSpec[] = [
  quickstartCommand,
  statusCommand,
  doctorCommand,
  reviewCommand,
  permissionsCommand,
  modeCommand,
  contextCommand,
];

export interface RegistryMatch {
  spec: CommandSpec;
  args: string;
}

export function registryCommandNames(): string[] {
  const names: string[] = [];
  for (const command of COMMANDS) {
    names.push(command.name, ...(command.aliases ?? []));
  }
  return names;
}

export function findRegistryCommand(
  input: string,
  customCommands: readonly CommandSpec[] = []
): RegistryMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const head = trimmed.split(/\s+/, 1)[0];
  const spec =
    COMMANDS.find(
      (command) => command.name === head || command.aliases?.includes(head as `/${string}`)
    ) ?? customCommands.find((command) => command.name === head);
  if (!spec) return null;
  return { spec, args: trimmed.slice(head.length).trim() };
}

export async function runRegistryCommand(
  input: string,
  ctx: CommandContext,
  customCommands: readonly CommandSpec[] = []
): Promise<boolean> {
  const match = findRegistryCommand(input, customCommands);
  if (!match) return false;
  await match.spec.run(ctx, match.args);
  return true;
}

export function unknownSlashCommandLines(
  input: string,
  options: { suggestion?: string | null; locale?: string } = {}
): string[] {
  const zh = isZh(options.locale);
  return [
    zh ? `未知命令：${input}` : `Unknown command: ${input}`,
    options.suggestion
      ? zh
        ? `是想输入 ${options.suggestion} 吗？`
        : `Did you mean ${options.suggestion}?`
      : zh
        ? '用 /help 查看全部命令。'
        : 'Use /help for available commands.',
    zh
      ? '提示：以 / 开头的输入是 CLI 命令，不会发给模型。想让模型处理这句话，去掉行首的 / 重新发送。'
      : 'Note: "/" input is a CLI command and never reaches the model. To let the model handle it, resend without the leading "/".',
  ];
}
