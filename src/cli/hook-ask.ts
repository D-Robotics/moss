/**
 * O157: a PreToolUse hook that exits 0 with `ask` (claude
 * `hookSpecificOutput.permissionDecision: "ask"`, or moss / legacy
 * `decision: "ask"`) wants a human to confirm the call. Interactive sessions
 * turn it into Moss's y/a/n prompt naming the hook; `-p` and runs without a
 * terminal cannot confirm, so it is treated as deny. Merge order across
 * hooks: deny > ask > allow.
 */
import type { ToolApprovalDecision, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import { isZhLocale } from './cli-locale.js';
import { hookEventZhName } from './hook-event-names.js';

/** One PreToolUse hook that exited 0 with `ask`. */
export interface PreToolUseHookAsk {
  command: string;
  /** Config file the hook came from. */
  source?: string;
  /** `permissionDecisionReason` / `reason`, if the hook gave one. */
  reason?: string;
}

/** Context the policy hook receives for one call. */
export interface ToolApprovalContext {
  hookAsks?: readonly PreToolUseHookAsk[];
}

function reasonSuffix(ask: PreToolUseHookAsk | undefined, zh: boolean): string {
  if (!ask?.reason) return '';
  return zh ? `（理由：${ask.reason}）` : ` (reason: ${ask.reason})`;
}

/**
 * The refusal when no one can confirm: `print` for `-p`, `headless` for a run
 * with no interactive terminal. Starts with 已拦截 / `Blocked by PreToolUse
 * hook` so the run ends 「被拦」, exit 9.
 */
export function hookAskHeadlessReason(
  asks: readonly PreToolUseHookAsk[],
  where: 'print' | 'headless',
  zh = isZhLocale()
): string {
  const first = asks[0];
  const command = first?.command ?? '';
  const why = reasonSuffix(first, zh);
  if (zh) {
    const mode = where === 'print' ? '-p 模式下无法确认' : '当前没有交互终端，无法确认';
    return `已拦截：${hookEventZhName('PreToolUse')}钩子要求人工确认，${mode}，已按拒绝处理${why}。钩子：\`${command}\``;
  }
  const mode = where === 'print' ? 'which -p mode cannot give' : 'but no interactive terminal is available';
  return `Blocked by PreToolUse hook: it asked for confirmation, ${mode}; treated as deny${why}. Hook: \`${command}\``;
}

/** Lines that head the confirmation prompt: which hook asked, and why. */
export function hookAskPromptLines(asks: readonly PreToolUseHookAsk[], zh = isZhLocale()): string[] {
  const lines: string[] = [];
  for (const ask of asks) {
    lines.push(
      zh
        ? `${hookEventZhName('PreToolUse')}钩子要求确认：\`${ask.command}\`${ask.source ? `（${ask.source}）` : ''}`
        : `PreToolUse hook asks for confirmation: \`${ask.command}\`${ask.source ? ` (${ask.source})` : ''}`
    );
    if (ask.reason) lines.push(zh ? `理由：${ask.reason}` : `Reason: ${ask.reason}`);
  }
  return lines;
}

/** The refusal after the user answered n to a hook-requested confirmation. */
export function hookAskDeniedReason(
  toolName: string,
  asks: readonly PreToolUseHookAsk[],
  zh = isZhLocale()
): string {
  const command = asks[0]?.command ?? '';
  return zh
    ? `已拦截：${hookEventZhName('PreToolUse')}钩子要求确认，用户拒绝了 ${toolName}。钩子：\`${command}\``
    : `Blocked by PreToolUse hook confirmation: user denied ${toolName}. Hook: \`${command}\``;
}

type PreToolUseResult =
  | ToolApprovalDecision
  | { approved: false; reason: string; hookAsks?: readonly PreToolUseHookAsk[] };

/**
 * Configured PreToolUse hooks first, then the policy hook. A deny stops here;
 * an ask (with no deny) goes to the policy hook as `hookAsks`, which prompts
 * (or refuses in -p) even when policy alone would allow.
 */
export function composePreToolUseGate(
  configPreHook: ((req: ToolApprovalRequest) => Promise<PreToolUseResult>) | undefined,
  approvalHook: (req: ToolApprovalRequest, ctx?: ToolApprovalContext) => Promise<ToolApprovalDecision>
): (req: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
  return async (req) => {
    if (configPreHook) {
      const pre = await configPreHook(req);
      if (!pre.approved) {
        const asks = 'hookAsks' in pre ? pre.hookAsks : undefined;
        if (!asks || asks.length === 0) return pre;
        return approvalHook(req, { hookAsks: asks });
      }
    }
    return approvalHook(req);
  };
}
