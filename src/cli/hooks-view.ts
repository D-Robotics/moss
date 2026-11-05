/**
 * `/hooks` view for both CLI surfaces.
 *
 * The hooks subsystem is the most powerful config surface (nine events, blocking
 * vetoes) and used to be manageable only in the TUI. The rows are the same data
 * everywhere: event, matcher, target, flags. Rules that can never fire are named:
 * a matcher naming an unregistered tool, or an `if:` condition naming one, is a
 * silent no-op until someone sees it.
 */
import { hookEventCatalogLines, hookEventZhName, isMossHookEventId } from './hook-event-names.js';

export interface HookViewEntry {
  matcher?: string;
  command?: string;
  url?: string;
  blocking?: boolean;
  timeoutMs?: number;
  /** PreToolUse gate expression (permission-rule syntax). */
  if?: string;
}

export interface HooksViewOptions {
  zh: boolean;
  /** Registered tool names, for the never-fires warnings. */
  knownToolNames?: readonly string[];
  configDir?: string;
}

const GLOB_CHARS = /[*?[\]]/;

function warnsAboutTool(
  value: string | undefined,
  knownToolNames: readonly string[] | undefined
): boolean {
  if (!value || !knownToolNames || knownToolNames.length === 0) return false;
  if (GLOB_CHARS.test(value)) return false;
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;
  return !knownToolNames.some((name) => name.toLowerCase() === wanted);
}

/** Tool name of a permission-rule condition (`exec(git *)` → `exec`). */
function conditionToolName(condition: string | undefined): string | undefined {
  if (!condition) return undefined;
  const head = condition.split('(', 1)[0]?.trim();
  return head || undefined;
}

export function formatHookViewLines(
  hooks: Record<string, readonly HookViewEntry[]> | undefined,
  options: HooksViewOptions
): string[] {
  const { zh } = options;
  const lines: string[] = [];
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    for (const hook of entries ?? []) {
      const label =
        zh && isMossHookEventId(event) ? `${event}（${hookEventZhName(event)}）` : event;
      const target = hook.command ?? hook.url ?? (zh ? '(未配置目标)' : '(no target)');
      lines.push(
        `${label.padEnd(14)} ${hook.matcher ? `[${hook.matcher}] ` : ''}${target}` +
          `${hook.blocking ? ' · blocking' : ''}` +
          `${hook.timeoutMs !== undefined ? ` · ${hook.timeoutMs}ms` : ''}`
      );
      if (warnsAboutTool(hook.matcher, options.knownToolNames)) {
        lines.push(
          zh
            ? `  ⚠ 事件 ${event} 的 matcher "${hook.matcher}" 没有匹配的已注册工具——这个 hook 永远不会触发`
            : `  ⚠ matcher "${hook.matcher}" on ${event} matches no registered tool — this hook never fires`
        );
      }
      const conditionTool = conditionToolName(hook.if);
      if (warnsAboutTool(conditionTool, options.knownToolNames)) {
        lines.push(
          zh
            ? `  ⚠ 事件 ${event} 的 if 条件引用了未知工具 "${conditionTool}"——条件永远为假`
            : `  ⚠ if condition on ${event} names unknown tool "${conditionTool}" — it never matches`
        );
      }
    }
  }
  if (lines.length === 0) {
    lines.push(
      zh
        ? '未配置 hooks——在配置文件中加入 "hooks" 对象：'
        : 'no hooks configured — add a "hooks" object to the config file:',
      ...hookEventCatalogLines(zh),
      zh
        ? '每条：{ "command": "…", "matcher": "tool-glob", "timeoutMs": 5000, "blocking": true }'
        : 'each entry: { "command": "…", "matcher": "tool-glob", "timeoutMs": 5000, "blocking": true }'
    );
  }
  if (options.configDir) {
    lines.push(
      '',
      zh
        ? `配置目录：${options.configDir}（或 MOSS_CONFIG_FILE）`
        : `config dir: ${options.configDir} (or MOSS_CONFIG_FILE)`
    );
  }
  return lines;
}
