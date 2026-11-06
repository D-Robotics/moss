import fs from 'node:fs';
import path from 'node:path';

import { estimateTokensForText } from '../../context/tokens.js';
import {
  buildProviderToolDeclarations,
  shouldLeanToolDescriptions,
} from '../../core/loop/agent-loop-context-prep.js';
import { hiddenToolNames } from '../../core/agent/session-tool-offer.js';
import type { MossAgent } from '../../core/index.js';
import type { CompactionRecord, SessionUsageSummary } from '../session-usage.js';
import {
  renderCliPermissions,
  renderCliSessionDoctor,
  renderCliStatus,
  type CliRuntimeStatus,
} from '../onboarding.js';
import { MossError, errorMessage } from '../../errors.js';
import type { ContextUsageSnapshot } from '../usage-display.js';
import {
  effectiveUiLanguage,
  isZhLocale as isZh,
  parseLanguageSetting,
  setSessionUiLanguage,
  uiLanguageResolution,
  formatUiLanguageStatus,
  uiText,
  writeUserLanguageSetting,
} from '../cli-locale.js';
import { chrome, setTuiLocale } from '../tui/copy.js';
import { workspaceWriteLimit } from '../workspace-write-copy.js';
import { GITIGNORE_SUGGESTION } from '../gitignore-suggestion.js';
import {
  formatCliInteractionModeLabel,
  getCliInteractionMode,
  parseCliInteractionMode,
  setCliInteractionMode,
  type CliInteractionMode,
} from '../approval.js';
import { parsePermissionRuleSpec } from '../permission-rules.js';
import { appendUserPermissionRule } from '../config-commands.js';
import { stopAllBackgroundProcesses } from '../../core/tools/background-process-registry.js';
import { probeDoctorModelPing } from '../doctor-model-ping.js';
import { reportedModelMatchesConfigured } from '../model-resolution.js';
import { envBeforeDotenv, loadCliConfigFile, resolveConfigDir } from '../config.js';
import { isFilesystemRoot, forgetFolderTrust, rememberFolderTrust } from '../folder-trust-store.js';
import { detectProject } from '../init-command.js';
import {
  currentOutputStyle,
  OUTPUT_STYLE_NAMES,
  parseOutputStyle,
  setOutputStyle,
} from '../output-style.js';
import { resolveFolderKey } from '../workspace-trust.js';
import {
  configuredBaseUrl,
  formatCostEstimate,
  priceSourceLine,
  pricingOverridesFromConfig,
  quoteUsage,
  unknownPriceMessage,
} from '../model-pricing.js';
import type { UsageSlice } from '../model-pricing.js';
import { formatFileAgentReport } from '../../core/subagent/agent-file-loader.js';

export interface CommandInputOptions {
  label: string;
  initialValue?: string;
  masked?: boolean;
}

export type CommandInputPrompt = (options: CommandInputOptions) => Promise<string | null>;

export type CommandSurface = 'repl' | 'tui';

/** `/diff` or `/review` run outside a git repository. */
export function formatNotGitRepository(
  command: '/diff' | '/review',
  workspace: string,
  zh: boolean = isZh()
): string {
  return command === '/review'
    ? chrome('Not a git repository: {path} — /review needs a git workspace.', zh, {
        path: workspace,
      })
    : chrome('Not a git repository: {path} — /diff needs a git workspace.', zh, {
        path: workspace,
      });
}

/** A real `/diff` run that exited non-zero (TUI and REPL): the first line of git's output. */
export function formatDiffRunFailure(
  exitCode: number | null | undefined,
  output: string,
  zh: boolean = isZh()
): string {
  return chrome('git diff failed (exit {code}): {error}', zh, {
    code: exitCode ?? chrome('signal', zh),
    error: output.trim().split('\n')[0] || chrome('unknown error', zh),
  });
}

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

  /**
   * The todo_write checklist the host is currently showing (TUI panel, REPL
   * tracker). `/todos` needs the live list: reading it back from the session
   * store would miss the turn that is still running.
   */
  getTodos?(): readonly ChecklistItem[] | undefined;
  getSessionUsage?(): SessionUsageSummary | undefined;
  getCompactionHistory?(): readonly CompactionRecord[] | undefined;
  /** Optional: keep host interactionMode state in sync with setCliInteractionMode. */
  setInteractionMode?(mode: CliInteractionMode): void;
}

export interface CommandSpec {
  name: `/${string}`;

  aliases?: readonly `/${string}`[];

  /** Where a file command came from; built-ins omit it. */
  scope?: 'workspace' | 'user';

  summary: string;
  /** Raw prompt body for a file-based command. Built-ins omit it. */
  body?: string;
  /**
   * Match only when arguments are present, so the host keeps owning the bare
   * form (`/mcp` has a rich panel in the TUI while `/mcp prompts` works in both
   * surfaces through this registry).
   */
  requiresArgs?: boolean;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}

/** One row of the model's todo_write checklist (status stays a plain string: the
 * tool owns the vocabulary, hosts only display it). */
export interface ChecklistItem {
  content: string;
  status: string;
}

const CHECKLIST_GLYPH: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
};

const todosCommand: CommandSpec = {
  name: '/todos',
  summary: 'list the checklist the model is tracking (todo_write)',
  run(ctx) {
    const zh = isZh(ctx.locale);
    const todos = ctx.getTodos?.() ?? [];
    if (todos.length === 0) {
      ctx.say(
        'system',
        zh
          ? '还没有清单——模型调用 todo_write 后会显示在这里。'
          : 'No checklist yet — one appears here after the model calls todo_write.'
      );
      return;
    }
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const lines = [
      zh ? `清单 ${done}/${todos.length} 已完成` : `Checklist ${done}/${todos.length} done`,
      ...todos.map(
        (todo, index) =>
          `  ${index + 1}. ${CHECKLIST_GLYPH[todo.status] ?? '○'} ${todo.content}${
            todo.status === 'in_progress' ? (zh ? '（进行中）' : ' (in progress)') : ''
          }`
      ),
    ];
    ctx.say('system', lines.join('\n'));
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

const runsCommand: CommandSpec = {
  name: '/runs',
  summary:
    'unified run ledger: list | show | export | prune (what ran, how it ended, what is next)',
  async run(ctx, args) {
    const { runRunsCommand } = await import('../runs-command.js');
    const tokens = args.trim() ? args.trim().split(/\s+/) : [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRunsCommand(tokens, {
      workspace: ctx.workspace,
      ...(tokens.includes('--json') ? { outputJson: true } : {}),
      output: (stream, text) => {
        (stream === 'stderr' ? err : out).push(text.trimEnd());
      },
    });
    const stdout = out.join('\n').trim();
    const stderr = err.join('\n').trim();
    if (stdout) ctx.say('system', stdout);
    if (stderr) ctx.say('error', stderr);
    if (code !== 0 && !stderr) ctx.say('error', `moss runs exited ${code}`);
  },
};

const capabilitiesCommand: CommandSpec = {
  name: '/capabilities',
  summary: 'one screen for tools/skills/commands/agents/hooks/MCP/devices (read-only)',
  async run(ctx, args) {
    const { runCapabilitiesCommand } = await import('../capabilities-command.js');
    const tokens = args.trim() ? args.trim().split(/\s+/) : [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCapabilitiesCommand(tokens, {
      workspace: ctx.workspace,
      ...(tokens.includes('--json') ? { outputJson: true } : {}),
      output: (stream, text) => {
        (stream === 'stderr' ? err : out).push(text.trimEnd());
      },
    });
    const stdout = out.join('\n').trim();
    const stderr = err.join('\n').trim();
    if (stdout) ctx.say('system', stdout);
    if (stderr) ctx.say('error', stderr);
    if (code !== 0 && !stderr) ctx.say('error', `moss capabilities exited ${code}`);
  },
};

const doctorCommand: CommandSpec = {
  name: '/doctor',
  summary: 'health-check model, egress, and config in this session',
  async run(ctx) {
    const report = renderCliSessionDoctor(ctx.agent, ctx.runtime);
    const llm = ctx.agent.config.llmProvider;
    const secrets: string[] = [];
    const configuredKey = ctx.runtime?.config?.apiKey;
    if (typeof configuredKey === 'string' && configuredKey) secrets.push(configuredKey);
    const ping = await probeDoctorModelPing({
      model: ctx.agent.config.model ?? '',
      ...(llm && typeof llm.complete === 'function' ? { provider: llm } : {}),
      secrets,
    });
    ctx.say('system', `${report}\n${ping}`);
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
        renderCliPermissions(runtime, {
          verbose: verb === '--verbose' || trimmed === 'verbose',
          locale: ctx.locale,
          currentMode: getCliInteractionMode(),
          knownToolNames: ctx.agent.tools.getAll().map((tool) => tool.name),
        })
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
        ctx.say(
          'system',
          zh
            ? `已移除会话规则：${target}。已保存的用户或工作区规则不受影响，重启后仍可能生效。`
            : `Session rule removed: ${target}. Saved user or workspace rules remain unchanged and may apply after restart.`
        );
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
              '  /mode accept-edits  自动通过本文件夹内的文件编辑；终端命令仍需确认（-p 下会被拦下）',
              '  /mode plan          只读规划（不执行写操作）',
              '  /mode full          全开：跳过询问，仅 deny 规则与硬拦截生效（默认）',
              '  快捷键：Shift+Tab（TUI）在四种模式间循环',
              `  ${workspaceWriteLimit(true)}`,
            ].join('\n')
          : [
              `Interaction mode: ${label}`,
              '  /mode manual        normal coding (approve mutations one by one)',
              '  /mode accept-edits  auto-approve file edits in this folder; shell commands still ask (blocked in -p)',
              '  /mode plan          read-only planning (block mutations)',
              '  /mode full          skip prompts — only deny rules and hard blocks apply (default)',
              '  Shortcut: Shift+Tab (TUI) cycles manual / accept-edits / plan / full',
              `  ${workspaceWriteLimit(false)}`,
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
          ? `已切换到${label}：只读探索与规划；写文件/副作用命令会被拦截。规划完成后用 /mode manual 退出（TUI 里也可用 Shift+Tab）。`
          : next === 'acceptEdits'
            ? `已切换到${label}：工作区内文件工具编辑自动通过。${workspaceWriteLimit(true)} shell 变更仍会确认。`
            : next === 'full'
              ? `已切换到${label}：跳过询问，deny 规则与危险命令拦截仍生效。`
              : `已切换到${label}：正常编码，写操作与设备变更逐次确认。`
        : next === 'plan'
          ? `Switched to ${label}: explore and plan read-only; file/side-effect tools are blocked. Leave with /mode manual (or Shift+Tab in the TUI) when ready to implement.`
          : next === 'acceptEdits'
            ? `Switched to ${label}: workspace file-tool edits auto-approve. ${workspaceWriteLimit(false)} Shell mutations still prompt.`
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
      // What the tools cost: every turn pays for these declarations, and the
      // lean/full decision (flag or small window) changes the number, so report
      // the same choice the loop will make instead of a fixed estimate.
      const offeredTools = ctx.agent.offeredTools?.() ?? [];
      const leanSurface = shouldLeanToolDescriptions({ contextWindowTokens: windowTokens });
      const toolDeclarations = buildProviderToolDeclarations(offeredTools, {
        contextWindowTokens: windowTokens,
      });
      const toolTokens = toolDeclarations.reduce(
        (n, declaration) =>
          n +
          estimateTokensForText(declaration.description) +
          estimateTokensForText(JSON.stringify(declaration.parameters)),
        0
      );

      const hiddenTools = hiddenToolNames();
      const hiddenLine =
        hiddenTools.size > 0
          ? [`  experiment hidden  ${[...hiddenTools].join(', ')} (MOSS_HIDE_TOOLS)`]
          : [];
      const configuredModel = ctx.agent.config.model ?? '';
      const reportedModel = ctx.agent.reportedModel();
      const modelLine =
        reportedModel &&
        configuredModel &&
        !reportedModelMatchesConfigured(configuredModel, reportedModel)
          ? `configured ${configuredModel}, gateway reported ${reportedModel}`
          : configuredModel;
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
          `  tools      ~${fmt(toolTokens)} tokens (${toolDeclarations.length} declared, ${
            leanSurface ? 'lean' : 'full'
          } descriptions)`,
          ...hiddenLine,
          `  model      ${modelLine}`,
        ].join('\n')
      );
    } catch (err) {
      ctx.say('error', `Could not read context: ${errorMessage(err)}`);
    }
  },
};

/**
 * `/review` runs the same independent-review pipeline the loop uses: the main
 * model calls `review_changes`, which collects the diff and spawns the
 * read-only reviewer with a clean context. The command used to paste a large
 * diff into the main conversation and ask the same model that produced the
 * change to review it — self-review bias plus a diff that ate the window.
 */
function buildReviewPrompt(prNumber?: string): string {
  const target = prNumber ? ` (pr=${prNumber})` : '';
  return [
    `Run an independent review of this change with the review_changes tool${target}.`,
    'Then report the tool result to the user: the verdict, every finding as severity +',
    'file:line + what breaks + fix hint, and anything the reviewer said it could not cover',
    '(for example a truncated diff).',
    'Do not edit files in this turn, do not re-review the code yourself, and do not add',
    'findings the tool did not produce. If it reports nothing to review, say that and stop.',
  ].join(' ');
}

const reviewCommand: CommandSpec = {
  name: '/review',
  summary:
    'review the working-tree diff (or `/review <PR#>`) for bugs, security, and simplification',
  async run(ctx, args) {
    const zh = isZh(ctx.locale);
    if (!ctx.submitPrompt) {
      ctx.say(
        'error',
        zh
          ? '/review 需要能启动运行的会话；当前环境不可用。'
          : '/review needs a session that can start a run; it is unavailable in this context.'
      );
      return;
    }
    const arg = args.trim();
    const prNumber = arg.replace(/^#/, '');
    if (arg && !/^\d+$/.test(prNumber)) {
      ctx.say(
        'error',
        zh
          ? '用法：/review            （工作区与暂存区改动）\n      /review <拉取请求号>   （用 `gh pr diff` 取 GitHub 拉取请求）'
          : 'Usage: /review            (working tree + staged changes)\n       /review <PR#>     (a GitHub pull request via `gh pr diff`)'
      );
      return;
    }
    ctx.say(
      'system',
      zh
        ? `启动独立 reviewer 评审${prNumber ? ` PR #${prNumber}` : '工作区改动'}（评审者只读，findings 写入 .moss/review.jsonl）…`
        : `Launching an independent reviewer for ${prNumber ? `PR #${prNumber}` : 'the working-tree changes'} (read-only; findings land in .moss/review.jsonl) …`
    );
    ctx.submitPrompt(buildReviewPrompt(prNumber || undefined));
  },
};

const styleCommand: CommandSpec = {
  name: '/style',
  aliases: ['/output-style'],
  summary: 'show or switch the output style for this session (default | explanatory | learning)',
  run(ctx, args) {
    const zh = isZh(ctx.locale);
    const requested = args.trim().toLowerCase();
    if (!requested) {
      const current = currentOutputStyle();
      ctx.say(
        'system',
        zh
          ? `输出风格：${current}（本次会话）· 可选：${OUTPUT_STYLE_NAMES.join(' / ')} · 永久保存：moss config set outputStyle <name>`
          : `output style: ${current} (this session) · options: ${OUTPUT_STYLE_NAMES.join(' / ')} · persist: moss config set outputStyle <name>`
      );
      return;
    }
    const style = parseOutputStyle(requested);
    if (!style) {
      ctx.say(
        'system',
        zh
          ? `未知输出风格：${requested}。可选：${OUTPUT_STYLE_NAMES.join(' / ')}`
          : `unknown output style: ${requested}. Options: ${OUTPUT_STYLE_NAMES.join(' / ')}`
      );
      return;
    }
    setOutputStyle(style);
    ctx.say(
      'system',
      zh
        ? `输出风格已切换为 ${style}（仅本次会话；永久保存：moss config set outputStyle ${style}）`
        : `output style switched to ${style} (this session; persist with moss config set outputStyle ${style})`
    );
  },
};

const usageCommand: CommandSpec = {
  name: '/usage',
  aliases: ['/cost', '/stats'],
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
    const slices: UsageSlice[] =
      summary.slices && summary.slices.length > 0
        ? [...summary.slices]
        : [
            {
              ...(ctx.agent.config.model ? { model: ctx.agent.config.model } : {}),
              inputTokens: summary.inputTokens,
              outputTokens: summary.outputTokens,
              cacheReadTokens: summary.cacheReadTokens,
              cacheCreationTokens: summary.cacheCreationTokens,
            },
          ];
    let overrides = {};
    try {
      overrides = pricingOverridesFromConfig(loadCliConfigFile().config.pricing);
    } catch {
      overrides = {};
    }
    const baseUrl = configuredBaseUrl(ctx.agent.config as { baseUrl?: string }, ctx.runtime);
    const quote = quoteUsage(slices, {
      overrides,
      env: process.env,
      ...(baseUrl ? { baseUrl } : {}),
      ...(ctx.agent.config.model ? { fallbackModel: ctx.agent.config.model } : {}),
    });
    if (quote.amount !== null && quote.currency) {
      lines.push(
        `  ${zh ? '费用' : 'cost'}        ${formatCostEstimate(quote.amount, quote.currency, zh)}`
      );
      const source = priceSourceLine(quote, zh);
      if (source) lines.push(`  ${source}`);
    } else {
      lines.push(`  ${unknownPriceMessage(quote.unknownModel ?? ctx.agent.config.model, zh)}`);
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

/**
 * B158: `/init` is the model-drafted variant of `moss init`. The deterministic
 * CLI detection is passed in as verified starting points so the two modes agree
 * on the commands they claim, and the model never has to rediscover them.
 */
export function buildInitPrompt(workspace: string): string {
  const agentsPath = path.join(workspace, 'AGENTS.md');
  const detection = detectProject(workspace);
  const detected =
    detection.commands.length > 0
      ? [
          `Verified entry points detected from files (${detection.kind}):`,
          ...detection.commands.map((entry) => `- ${entry.label}: ${entry.command}`),
          'These were read from the repository; keep them verbatim unless running them proves otherwise.',
        ]
      : [
          'No build/test entry point was detected from package.json, Makefile, go.mod or pyproject.toml.',
          'Say so explicitly rather than inventing commands.',
        ];
  const gitignore = [
    'If you create or update .gitignore, include this suggestion so session logs are not committed:',
    '```',
    GITIGNORE_SUGGESTION,
    '```',
  ];
  if (!fs.existsSync(agentsPath)) {
    return [
      'Analyze this repository and create an AGENTS.md project memory file at the workspace root.',
      'Cover the build, test, and layout facts you can verify by reading the repo.',
      'Do not invent commands or conventions you did not observe.',
      ...detected,
      ...gitignore,
    ].join('\n');
  }
  return [
    'AGENTS.md already exists. Review it against the current repository and update it incrementally.',
    'Keep instructions that are still accurate, fix stale ones, and do not rewrite unrelated sections.',
    'Never delete a user instruction just because your review did not confirm it; mark it stale or ask.',
    'The file to edit is AGENTS.md.',
    ...detected,
    ...gitignore,
  ].join('\n');
}

const initCommand: CommandSpec = {
  name: '/init',
  summary: 'create or incrementally review AGENTS.md',
  run(ctx) {
    if (!ctx.submitPrompt) {
      ctx.say('error', '/init needs a session that can start a run.');
      return;
    }
    ctx.say(
      'system',
      fs.existsSync(path.join(ctx.workspace, 'AGENTS.md'))
        ? 'Reviewing the existing AGENTS.md with the model… (the offline deterministic variant is `moss init`)'
        : 'Drafting AGENTS.md with the model… (the offline deterministic variant is `moss init`)'
    );
    ctx.submitPrompt(buildInitPrompt(ctx.workspace));
  },
};

const planCommand: CommandSpec = {
  name: '/plan',
  summary: 'enter plan mode; /plan <description> starts planning immediately',
  run(ctx, args) {
    const zh = isZh(ctx.locale);
    setCliInteractionMode('plan');
    ctx.setInteractionMode?.('plan');
    ctx.say(
      'system',
      zh
        ? '已进入 plan 模式：只读规划。退出：/mode manual（TUI 里也可用 Shift+Tab），或 /permissions。'
        : 'Plan mode: read-only planning. Leave with /mode manual (or Shift+Tab in the TUI), or /permissions.'
    );
    const description = args.trim();
    if (!description) return;
    if (ctx.submitPrompt) ctx.submitPrompt(description);
    else ctx.prefillInput(description);
  },
};

const stopCommand: CommandSpec = {
  name: '/stop',
  aliases: ['/abort'],
  summary: 'stop background processes; Esc or Ctrl+C interrupts the current run',
  run(ctx) {
    const zh = isZh(ctx.locale);
    const stopped = stopAllBackgroundProcesses(ctx.sessionKey);
    if (stopped.length === 0) {
      ctx.say(
        'system',
        zh
          ? '没有正在运行的后台进程。Esc（或 Ctrl+C）中断当前回复。'
          : 'No background processes running. Esc (or Ctrl+C) interrupts the current run.'
      );
      return;
    }
    ctx.say(
      'system',
      zh
        ? `已停止 ${stopped.length} 个后台进程：${stopped.join(', ')}。当前回复不受影响；Esc 才会中断它。`
        : `Stopped ${stopped.length} background process(es): ${stopped.join(', ')}. The current run is still going; Esc interrupts it.`
    );
  },
};

const languageCommand: CommandSpec = {
  name: '/language',
  aliases: ['/lang'],
  summary: 'show or switch the UI language for this session',
  run(ctx, args) {
    const tokens = args.split(/\s+/).filter((token) => token.length > 0);
    const save = tokens.some((token) => token === 'save' || token === '--save');
    const choice = tokens.find((token) => token !== 'save' && token !== '--save');
    if (!choice) {
      const status = formatUiLanguageStatus();
      ctx.say(
        'system',
        [
          uiText(
            `UI language: ${status.name} (${status.detail})`,
            `界面语言：${status.name}（${status.detail}）`
          ),
          uiText(
            '  /language en|zh|auto     switch for this session',
            '  /language en|zh|auto     只切换本会话'
          ),
          uiText(
            '  /language en save        remember it in the user config',
            '  /language en save        记到用户配置'
          ),
          uiText('  /lang                    alias', '  /lang                    别名'),
        ].join('\n')
      );
      return;
    }
    const setting = parseLanguageSetting(choice);
    if (!setting) {
      ctx.say(
        'error',
        uiText('Usage: /language [en|zh|auto] [save]', '用法：/language [en|zh|auto] [save]')
      );
      return;
    }
    if (setting === 'auto') setSessionUiLanguage('system');
    else setSessionUiLanguage(setting);
    setTuiLocale(isZh());
    if (save) {
      try {
        writeUserLanguageSetting(setting);
      } catch (err) {
        ctx.say(
          'error',
          uiText(
            `Could not save language: ${errorMessage(err)}`,
            `无法保存语言：${errorMessage(err)}`
          )
        );
        return;
      }
    }
    const language = effectiveUiLanguage();
    const languageName = language === 'zh' ? uiText('Chinese', '中文') : uiText('English', '英语');
    const resolution = uiLanguageResolution();
    const notes: string[] = [];
    if (save && resolution?.source === 'flag') {
      notes.push(
        uiText(
          ` --lang=${resolution.language} overrides the saved setting for this process. The next start uses the saved setting unless --lang or MOSS_LANG is set.`,
          ` 本次进程的 --lang=${resolution.language} 会覆盖已保存的设置。下次启动若不带 --lang、也不设 MOSS_LANG，则使用已保存的值。`
        )
      );
    }
    const envLang = envBeforeDotenv.MOSS_LANG?.trim().toLowerCase();
    if (save && (envLang === 'en' || envLang === 'zh')) {
      notes.push(
        uiText(
          ` MOSS_LANG=${envLang} will override this on the next start.`,
          ` 下次启动时 MOSS_LANG=${envLang} 会覆盖它。`
        )
      );
    }
    const override = notes.join('');
    const savedZh = setting === 'auto' ? '自动' : setting === 'zh' ? '中文' : '英语';
    ctx.say(
      'system',
      uiText(
        `UI language: ${languageName}${save ? ` (saved ${setting} to the user config${setting === 'auto' ? ': follows the system locale' : ''})` : ' (this session)'}${override}`,
        `界面语言：${languageName}${save ? `（已把「${savedZh}」写入用户配置${setting === 'auto' ? '，跟随系统区域' : ''}）` : '（仅本会话）'}${override}`
      )
    );
  },
};

const trustCommand: CommandSpec = {
  name: '/trust',
  summary: 'trust this folder for project settings',
  async run(ctx) {
    const key = await resolveFolderKey(ctx.workspace);
    if (isFilesystemRoot(key)) {
      ctx.say(
        'system',
        uiText(
          'The filesystem root is not remembered as trusted.',
          '文件系统根目录不会被记为已信任。'
        )
      );
      return;
    }
    const configDir = resolveConfigDir();
    rememberFolderTrust(configDir, key);
    ctx.say(
      'system',
      uiText(
        `Trusted ${key}. It applies the next time Moss starts.`,
        `已信任 ${key}。下次启动 Moss 时生效。`
      )
    );
  },
};

const untrustCommand: CommandSpec = {
  name: '/untrust',
  summary: 'forget trust for this folder',
  async run(ctx) {
    const removed = forgetFolderTrust(resolveConfigDir(), ctx.workspace);
    ctx.say(
      'system',
      removed
        ? uiText(
            `Removed trust for ${removed}. It applies the next time Moss starts.`,
            `已取消对 ${removed} 的信任。下次启动 Moss 时生效。`
          )
        : uiText('This folder is not trusted.', '此文件夹未被信任。')
    );
  },
};

const agentsCommand: CommandSpec = {
  name: '/agents',
  summary: 'list file-defined sub-agents with source paths and warnings',
  run(ctx) {
    const experts = ctx.agent.config.subagentExperts ?? [];
    const notices = ctx.agent.config.subagentExpertNotices ?? [];
    ctx.say('system', formatFileAgentReport({ experts, notices, zh: isZh(ctx.locale) }));
  },
};

const skillsCommand: CommandSpec = {
  name: '/skills',
  summary: 'list skills with scope, usage, catalog cost, and evals',
  async run(ctx) {
    const { renderSkillsList } = await import('../skill-commands.js');
    const { resolveConfigDir } = await import('../config.js');
    ctx.say(
      'system',
      await renderSkillsList(
        ctx.workspace,
        resolveConfigDir(),
        isZh(ctx.locale),
        ctx.agent.config.contextTokens
      )
    );
  },
};

function mcpUsage(): string {
  return uiText(
    [
      'Usage:',
      '  /mcp prompts                                list MCP prompt templates',
      '  /mcp prompt <server> <name> [key=value...]  expand one prompt and run it',
      '',
      'The bare /mcp command still shows server status.',
    ].join('\n'),
    [
      '用法：',
      '  /mcp prompts                                列出 MCP 提示词模板',
      '  /mcp prompt <server> <name> [key=value...]  展开一条提示词并作为一轮发送',
      '',
      '裸 /mcp 仍然显示服务器状态。',
    ].join('\n')
  );
}

const mcpCommand: CommandSpec = {
  name: '/mcp',
  requiresArgs: true,
  summary: 'list MCP prompt templates or run one as a turn',
  async run(ctx, args) {
    const tokens = args.split(/\s+/).filter(Boolean);
    const sub = tokens[0] ?? '';
    const rest = tokens.slice(1);

    if (sub === 'prompts' || sub === 'list') {
      const prompts = ctx.runtime?.mcpPrompts;
      if (!prompts) {
        ctx.say('error', uiText('MCP is not loaded in this session.', '本会话没有加载 MCP。'));
        return;
      }
      const catalog = await prompts.catalog();
      const lines: string[] = [];
      if (catalog.prompts.length === 0 && catalog.failures.length === 0) {
        lines.push(
          uiText(
            'No MCP prompt templates: the configured servers expose none.',
            '没有 MCP 提示词模板：已配置的服务器没有暴露 prompts。'
          )
        );
      }
      for (const prompt of catalog.prompts) {
        const params = prompt.arguments
          .map((argument) => `${argument.name}${argument.required ? '' : '?'}`)
          .join(', ');
        const suffix = params ? ` (${params})` : '';
        lines.push(
          `${prompt.server}/${prompt.name}${suffix}${
            prompt.description ? ` — ${prompt.description}` : ''
          }`
        );
      }
      for (const failure of catalog.failures) {
        lines.push(
          uiText(
            `${failure.server}: prompts unavailable — ${failure.error}`,
            `${failure.server}: 提示词不可用 — ${failure.error}`
          )
        );
      }
      if (catalog.prompts.length > 0) {
        lines.push(
          '',
          uiText(
            'Run one with: /mcp prompt <server> <name> key=value...',
            '运行一条：/mcp prompt <server> <name> key=value...'
          )
        );
      }
      ctx.say('system', ['MCP prompts', ...lines].join('\n'));
      return;
    }

    if (sub === 'prompt') {
      const [server, name, ...pairs] = rest;
      if (!server || !name) {
        ctx.say('error', mcpUsage());
        return;
      }
      const values: Record<string, string> = {};
      for (const pair of pairs) {
        const at = pair.indexOf('=');
        if (at <= 0) {
          ctx.say(
            'error',
            uiText(`Argument "${pair}" is not key=value.`, `参数「${pair}」不是 key=value 形式。`)
          );
          return;
        }
        values[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const prompts = ctx.runtime?.mcpPrompts;
      if (!prompts) {
        ctx.say('error', uiText('MCP is not loaded in this session.', '本会话没有加载 MCP。'));
        return;
      }
      try {
        const expanded = await prompts.expand(server, name, values);
        if (!ctx.submitPrompt) {
          // A host without a turn queue still shows what the prompt expands to.
          ctx.say('system', expanded.text);
          return;
        }
        ctx.say(
          'system',
          uiText(
            `Running MCP prompt "${name}" from "${server}" (${expanded.messages} message${expanded.messages === 1 ? '' : 's'}).`,
            `正在运行「${server}」的 MCP 提示词「${name}」（${expanded.messages} 条消息）。`
          )
        );
        ctx.submitPrompt(expanded.text);
      } catch (error) {
        ctx.say('error', errorMessage(error));
      }
      return;
    }

    ctx.say('error', mcpUsage());
  },
};

const COMMANDS: readonly CommandSpec[] = [
  todosCommand,
  statusCommand,
  runsCommand,
  capabilitiesCommand,
  doctorCommand,
  languageCommand,
  trustCommand,
  untrustCommand,
  agentsCommand,
  reviewCommand,
  permissionsCommand,
  modeCommand,
  planCommand,
  initCommand,
  stopCommand,
  contextCommand,
  skillsCommand,
  mcpCommand,
  usageCommand,
  styleCommand,
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
  const args = trimmed.slice(head.length).trim();
  if (spec.requiresArgs && args.length === 0) return null;
  return { spec, args };
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
  options: { suggestion?: string | null; suggestions?: readonly string[]; locale?: string } = {}
): string[] {
  const zh = isZh(options.locale);
  const head = input.trim().split(/\s+/, 1)[0] ?? input.trim();
  const suggestions = (options.suggestions ?? (options.suggestion ? [options.suggestion] : []))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 3);
  const lines = [zh ? `未知命令：${head}` : `unknown command "${head}"`];
  if (suggestions.length > 0) {
    lines.push(
      zh ? `是想输入 ${suggestions.join('、')} 吗？` : `Did you mean ${suggestions.join(', ')}?`
    );
  }
  lines.push(zh ? '输入 /help 查看全部命令。' : 'Type /help for available commands.');
  lines.push(
    zh
      ? '提示：以 / 开头的输入是 CLI 命令，不会发给模型。想让模型处理这句话，去掉行首的 / 重新发送。'
      : 'Note: "/" input is a CLI command and never reaches the model. To let the model handle it, resend without the leading "/".'
  );
  return lines;
}
