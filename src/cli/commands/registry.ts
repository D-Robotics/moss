import { estimateTokensForText } from '../../context/tokens.js';
import type { MossAgent } from '../../core/index.js';
import type { CompactionRecord, SessionUsageSummary } from '../session-usage.js';
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
import { parsePermissionRuleSpec } from '../permission-rules.js';
import { appendUserPermissionRule } from '../config-commands.js';

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
  getSessionUsage?(): SessionUsageSummary | undefined;
  getCompactionHistory?(): readonly CompactionRecord[] | undefined;
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
  summary:
    'permission rule manager: view | add <level> <spec> | remove <spec> | persist <level> <spec>',
  run(ctx, args) {
    const zh = isZh(ctx.locale);
    const trimmed = args.trim();
    const [verb, ...rest] = trimmed.split(/\s+/);
    const runtime = ctx.runtime;

    // /permissions (default view) — defaultMode + 3-level counts + sources.
    if (!trimmed || verb === 'status' || verb === 'show' || verb === '--verbose') {
      ctx.say(
        'system',
        renderCliPermissions(runtime, { verbose: verb === '--verbose' || trimmed === 'verbose' })
      );
      return;
    }

    // Shared quoting: /permissions add deny "read_file(./.env)" — strip quotes.
    const unquote = (value: string): string =>
      value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? value.slice(1, -1)
        : value.startsWith("'") && value.endsWith("'") && value.length >= 2
          ? value.slice(1, -1)
          : value;
    const registry = runtime?.permissionRuleRegistry;

    if (verb === 'add' || verb === 'persist') {
      const [rawLevel, ...specParts] = rest;
      const spec = unquote(specParts.join(' ').trim());
      const level = (rawLevel ?? '').toLowerCase();
      if (!specParts.length || (level !== 'allow' && level !== 'ask' && level !== 'deny')) {
        ctx.say(
          'error',
          zh
            ? `用法：/permissions ${verb} <allow|ask|deny> "<ToolName(pattern)>"，例：/permissions ${verb} deny "read_file(./.env)"`
            : `Usage: /permissions ${verb} <allow|ask|deny> "<ToolName(pattern)>" — e.g. /permissions ${verb} deny "read_file(./.env)"`
        );
        return;
      }
      try {
        const rule = parsePermissionRuleSpec(spec, verb === 'add' ? 'session' : 'user', level);
        if (verb === 'add') {
          if (!registry) {
            ctx.say(
              'error',
              zh
                ? '会话规则注册表不可用（此会话未挂载 live 规则表）；改用 /permissions persist 写入用户配置。'
                : 'The session rule registry is unavailable in this session; use /permissions persist to write the user config instead.'
            );
            return;
          }
          registry.add(rule);
          ctx.say(
            'system',
            zh
              ? `已添加会话级 ${level} 规则：${spec}——下一次工具调用即生效（会话内有效，重启后失效）。`
              : `Session ${level} rule added: ${spec} — effective on the next tool call (session-scoped, resets on restart).`
          );
        } else {
          const result = appendUserPermissionRule(spec, level);
          if (!result.ok) {
            ctx.say('error', result.message);
            return;
          }
          ctx.say(
            'system',
            zh
              ? `已写入用户级 ${level} 规则：${spec}（${result.message}）——重启后仍生效。`
              : `User-level ${level} rule saved: ${spec} (${result.message}) — survives restarts.`
          );
        }
      } catch (err) {
        if (err instanceof MossError) {
          ctx.say('error', `${err.message}${err.hint ? `\n  → ${err.hint}` : ''}`);
          return;
        }
        throw err;
      }
      return;
    }

    if (verb === 'remove') {
      const target = unquote(rest.join(' ').trim());
      if (!target) {
        ctx.say(
          'error',
          zh
            ? '用法：/permissions remove "<spec 或序号>"（仅能移除会话级规则）'
            : 'Usage: /permissions remove "<spec or index>" (session rules only)'
        );
        return;
      }
      if (!registry) {
        ctx.say(
          'error',
          zh
            ? '会话规则注册表不可用；用户/工作区级规则请直接编辑配置文件。'
            : 'The session registry is unavailable; edit the config file for user/workspace rules.'
        );
        return;
      }
      const index = /^\d+$/.test(target) ? Number(target) : target;
      const removed = registry.remove(index);
      if (removed) {
        ctx.say('system', zh ? `已移除会话规则：${target}` : `Session rule removed: ${target}`);
        return;
      }
      // Honest boundary: the rule exists, but not at session level.
      const liveRules = runtime?.permissionsRules?.().rules ?? [];
      const elsewhere = liveRules.find((rule) => {
        const identity = rule.operandPattern
          ? `${rule.toolName}(${rule.operandPattern})`
          : rule.toolName;
        return identity === target;
      });
      if (elsewhere) {
        ctx.say(
          'error',
          zh
            ? `"${target}" 是${elsewhere.source === 'user' ? '用户级' : '工作区级'}规则——会话内不可移除；请编辑 ${elsewhere.source === 'user' ? '~/.config/moss/config.json' : '.moss/config.json'} 的 permissions.${elsewhere.level} 列表。`
            : `"${target}" is a ${elsewhere.source}-level rule and cannot be removed in-session; edit the permissions.${elsewhere.level} list in ${elsewhere.source === 'user' ? '~/.config/moss/config.json' : '.moss/config.json'}.`
        );
        return;
      }
      ctx.say('error', zh ? `未找到会话规则：${target}` : `No session rule matched: ${target}`);
      return;
    }

    ctx.say(
      'error',
      zh
        ? `未知子命令 "${verb}"。用法：/permissions [view|add|remove|persist|status|show] [--verbose]`
        : `Unknown subcommand "${verb}". Usage: /permissions [view|add|remove|persist|status|show] [--verbose]`
    );
  },
};

const modeCommand: CommandSpec = {
  name: '/mode',
  aliases: ['/plan'],
  summary: 'show or set interaction mode: manual | accept-edits | plan | full',
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
              '  /mode manual        正常编码（逐次审批写操作与设备变更）',
              '  /mode accept-edits  自动接受工作区内文件编辑',
              '  /mode plan          只读规划（不执行写操作）',
              '  /mode full          全开：跳过询问，仅 deny 规则与硬拦截生效（默认）',
              '  快捷键：Shift+Tab 在四种模式间循环',
            ].join('\n')
          : [
              `Interaction mode: ${label}`,
              '  /mode manual        normal coding (approve mutations one by one)',
              '  /mode accept-edits  auto-approve sandboxed workspace edits',
              '  /mode plan          read-only planning (block mutations)',
              '  /mode full          skip prompts — only deny rules and hard blocks apply (default)',
              '  Shortcut: Shift+Tab cycles manual / accept-edits / plan / full',
            ].join('\n')
      );
      return;
    }
    const next = parseCliInteractionMode(token);
    if (!next) {
      ctx.say(
        'error',
        zh
          ? '用法：/mode [manual|accept-edits|plan|full]（default 为 manual 别名）'
          : 'Usage: /mode [manual|accept-edits|plan|full] (default is a manual alias)'
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
          ? `已切换到${label}：只读探索与规划；写文件/副作用命令会被拦截。规划完成后用 /mode manual 或 Shift+Tab 退出。`
          : next === 'acceptEdits'
            ? `已切换到${label}：工作区内文件编辑自动通过；shell 变更仍会确认。`
            : next === 'full'
              ? `已切换到${label}：跳过询问，deny 规则与危险命令拦截仍生效。`
              : `已切换到${label}：正常编码，写操作与设备变更逐次确认。`
        : next === 'plan'
          ? `Switched to ${label}: explore and plan read-only; file/side-effect tools are blocked. Leave with /mode manual or Shift+Tab when ready to implement.`
          : next === 'acceptEdits'
            ? `Switched to ${label}: sandboxed workspace edits auto-approve; shell mutations still prompt.`
            : next === 'full'
              ? `Switched to ${label}: prompts are skipped; deny rules and dangerous-command blocks still apply.`
              : `Switched to ${label}: normal coding; mutations and device changes confirm one by one.`
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
      const fmt = (n: number) => n.toLocaleString();
      // The fill bar (A11.81): the share of the window is a shape, not just a
      // number — one glance answers "how much headroom is left".
      const barWidth = 24;
      const filled = Math.min(
        barWidth,
        pct > 0 ? Math.max(1, Math.round((pct / 100) * barWidth)) : 0
      );
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
      // Per-category breakdown with the numbers moss can compute honestly:
      // the system prompt (built and estimated right here), saved messages,
      // the free remainder, and the compaction reserve (A11.82's buffer).
      let systemPromptTokens: number | undefined;
      try {
        systemPromptTokens = estimateTokensForText(ctx.agent.buildSystemPrompt({}) as string);
      } catch {
        systemPromptTokens = undefined;
      }
      const reserveTokens = ctx.agent.config.compactionSettings?.reserveTokens ?? 20_000;
      const freeTokens = Math.max(0, usage.total - usage.used);
      const detailLines =
        usage.source === 'provider'
          ? [
              `  source     provider-reported (latest model call)`,
              `  input      ${(usage.inputTokens ?? 0).toLocaleString()}`,
              `  cache read ${(usage.cacheReadTokens ?? 0).toLocaleString()}`,
              `  cache new  ${(usage.cacheCreationTokens ?? 0).toLocaleString()}`,
            ]
          : ['  source     local estimate from saved message content'];
      const compactions = ctx.getCompactionHistory?.() ?? [];
      const compactionLines: string[] = [];
      if (compactions.length > 0) {
        compactionLines.push(
          `  compactions ${compactions.length} this session (last ${Math.min(5, compactions.length)}):`
        );
        for (const c of compactions.slice(-5)) {
          const before = c.tokensBefore;
          const after = c.tokensAfter;
          const ratio =
            before !== undefined && after !== undefined && before > 0
              ? ` → ${after.toLocaleString()} (${Math.round((after / before) * 100)}%)`
              : '';
          compactionLines.push(
            `    ${new Date(c.ts).toLocaleTimeString()}  ${before !== undefined ? before.toLocaleString() : '?'} tokens${ratio} · dropped ${c.droppedMessages}` +
              (c.keptToolNames !== undefined ? ` · kept ${c.keptToolNames} tool(s)` : '')
          );
        }
      }
      ctx.say(
        'system',
        [
          'Context window',
          `  ${bar} ${pct}%`,
          `  usage      ${usagePrefix}${fmt(usage.used)} / ${fmt(usage.total)} tokens`,
          '  by category',
          ...(systemPromptTokens !== undefined
            ? [`    system prompt  ~${fmt(systemPromptTokens)}`]
            : []),
          `    messages       ~${fmt(tokens)} (${msgs.length} saved)`,
          `    free           ${fmt(freeTokens)}`,
          `    compact keep   ${fmt(reserveTokens)} (auto-compact reserve)`,
          ...detailLines,
          ...compactionLines,
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
        // runProcess rejects on non-zero exit, so "not a git repository" (git
        // exits 128/129 there, depending on version) arrives as a throw —
        // classify it from the error, not from a result we never receive.
        let result: { exitCode: number; stdout: string; stderr: string };
        try {
          result = await runProcess('git', {
            args: ['--no-pager', 'diff', 'HEAD'],
            cwd: ctx.workspace,
            timeout: 30_000,
          });
        } catch (err) {
          // runProcess rejects on non-zero exit — git exits 128/129 outside a
          // repo depending on version, so the classification reads the
          // ProcessError's own stderr, not a result we never receive.
          const procErr = err as { stderr?: string; exitCode?: number };
          const stderr = procErr.stderr ?? (err instanceof Error ? err.message : String(err));
          const notRepo = /not a git repository/i.test(stderr);
          throw new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: notRepo
              ? `Not a git repository: ${ctx.workspace} — /review needs a git workspace.`
              : `git diff failed${procErr.exitCode !== undefined ? ` (exit ${procErr.exitCode})` : ''}: ${errorMessage(err)}`,
            hint: notRepo
              ? 'Open a git repository, or pass a PR number: `/review <PR#>`.'
              : undefined,
          });
        }
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

const usageCommand: CommandSpec = {
  name: '/usage',
  summary: 'show cumulative token usage for this session',
  run(ctx) {
    const zh = isZh(ctx.locale);
    const summary = ctx.getSessionUsage?.();
    if (!summary) {
      ctx.say(
        'system',
        zh
          ? '本会话还没有可统计的模型调用。发送一条消息后再运行 /usage。'
          : 'No model calls recorded in this session yet. Send a message, then run /usage.'
      );
      return;
    }
    if (summary.calls === 0) {
      ctx.say(
        'system',
        zh
          ? '本会话还没有可统计的模型调用。发送一条消息后再运行 /usage。'
          : 'No model calls recorded in this session yet. Send a message, then run /usage.'
      );
      return;
    }
    const promptTotal = summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens;
    const cacheHitPct =
      promptTotal > 0 ? Math.round((summary.cacheReadTokens / promptTotal) * 100) : 0;
    const lines = [
      zh ? '本会话累计用量' : 'Session usage',
      `  ${zh ? '模型调用' : 'model calls'}   ${summary.calls}`,
      `  ${zh ? '输入' : 'input'}        ${summary.inputTokens.toLocaleString()} tokens`,
      `  ${zh ? '输出' : 'output'}       ${summary.outputTokens.toLocaleString()} tokens`,
      `  ${zh ? '缓存读' : 'cache read'}  ${summary.cacheReadTokens.toLocaleString()} tokens`,
      `  ${zh ? '缓存写' : 'cache new'}  ${summary.cacheCreationTokens.toLocaleString()} tokens`,
      `  ${zh ? '提示词合计' : 'prompt total'} ${promptTotal.toLocaleString()} tokens (${zh ? '含缓存' : 'incl. cache'})`,
      `  ${zh ? '缓存命中率' : 'cache hit'}   ${cacheHitPct}% ${zh ? '（缓存读占提示词比例）' : '(cache read share of prompt tokens)'}`,
      ...(summary.ttftMsAvg !== undefined
        ? [`  ${zh ? '首 token' : 'ttft'}        ${summary.ttftMsAvg}ms ${zh ? '（平均）' : 'avg'}`]
        : []),
      ...(summary.tokensPerSecond !== undefined
        ? [`  ${zh ? '输出速率' : 'output'}      ~${summary.tokensPerSecond} tok/s`]
        : []),
      ...(summary.turnGapMsAvg !== undefined
        ? [
            `  ${zh ? '轮间隔' : 'turn gap'}    ${summary.turnGapMsAvg}ms ${zh ? '（平均，工具结束→下次调用）' : 'avg (last activity → next call)'}`,
          ]
        : []),
    ];
    if (summary.spanMs > 0) {
      lines.push(`  ${zh ? '时间跨度' : 'span'}       ${(summary.spanMs / 1000).toFixed(0)}s`);
    }
    lines.push(
      zh
        ? '  提示：用量为会话内存累计，重启会话后从零开始。'
        : '  Note: usage accumulates in memory for this session; it resets when the session restarts.'
    );
    ctx.say('system', lines.join('\n'));
  },
};

const exportCommand: CommandSpec = {
  name: '/export',
  summary: 'export this session to markdown (/export [path])',
  async run(ctx, args) {
    const { renderSessionMarkdown } = await import('../command-dispatcher.js');
    const { writeFile } = await import('node:fs/promises');
    const pathArg = args.trim() || '';
    try {
      const messages = await ctx.agent.config.sessionStore.loadMessages(ctx.sessionKey);
      if (messages.length === 0) {
        ctx.say('error', 'Nothing to export yet — the session has no messages.');
        return;
      }
      const markdown = renderSessionMarkdown(ctx.sessionKey, messages);
      if (pathArg === '-') {
        process.stdout.write(markdown + '\n');
        return;
      }
      const target = pathArg || `moss-session-${ctx.sessionKey}.md`;
      await writeFile(target, markdown + '\n', 'utf8');
      ctx.say(
        'system',
        `Exported ${messages.length} message(s) to ${target}. (Use /export - to print, or /export <path> to choose a file.)`
      );
    } catch (err) {
      ctx.say('error', `Could not export session: ${errorMessage(err)}`);
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
  usageCommand,
  exportCommand,
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
