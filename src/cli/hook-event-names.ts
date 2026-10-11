import type { HooksConfig } from './config.js';

/**
 * O91: user-visible Chinese display names for Moss-format hook events.
 *
 * Event ids are the machine surface — JSON config keys, TypeScript types, the
 * `MOSS_HOOK_EVENT` env value — and stay English everywhere. This module only
 * feeds user-visible copy (stderr `[hooks]` lines, blocked reasons,
 * `formatHookFailure` heads, `/hooks` listings). A wording change is a
 * table-only edit (plus the O91 spec expectations); it never changes hook
 * behavior, config keys, or exit codes.
 */

/** Hook event ids exactly as they appear as `hooks` config keys. */
export type MossHookEventId = keyof HooksConfig;

/**
 * The O91 copy table — the single source of zh hook event names. No value
 * carries a 「钩子」 suffix (UX-final wording from specs/O91.md; the extras
 * beyond the spec table follow the same pattern) — the sentence templates
 * that consume a name append 「钩子」 themselves (「已拦截：停止前钩子未能
 * 启动。」), so copy never doubles into 「钩子钩子」. Typed as a full
 * `Record<keyof HooksConfig, string>` so a new config event key without a
 * display name is a compile error here (drift guard).
 */
export const HOOK_EVENT_ZH_NAMES: Readonly<Record<MossHookEventId, string>> = Object.freeze({
  PreToolUse: '工具使用前',
  PostToolUse: '工具使用后',
  UserPromptSubmit: '提交用户提示前',
  PermissionRequest: '权限请求时',
  SessionStart: '会话开始时',
  Stop: '停止前',
  SubagentStop: '子代理停止前',
  PreCompact: '压缩前',
  PostCompact: '压缩后',
  SessionEnd: '会话结束时',
  Notification: '通知时',
});

/** Every event id, in `/hooks` listing order (same order as HOOK_EVENT_KEYS). */
export const MOSS_HOOK_EVENT_IDS: readonly MossHookEventId[] = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PermissionRequest',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Notification',
]);

const KNOWN_EVENT_IDS: ReadonlySet<string> = new Set<string>(MOSS_HOOK_EVENT_IDS);

/** Type guard for arbitrary strings (e.g. keys of a user-authored hooks object). */
export function isMossHookEventId(value: string): value is MossHookEventId {
  return KNOWN_EVENT_IDS.has(value);
}

/** The zh display name for a known event id (the table is exhaustive). */
export function hookEventZhName(event: MossHookEventId): string {
  return HOOK_EVENT_ZH_NAMES[event];
}

/** Locale-aware label: the zh display name when `zh`, the English id otherwise. */
export function hookEventDisplayName(event: MossHookEventId, zh: boolean): string {
  return zh ? hookEventZhName(event) : event;
}

/**
 * The `/hooks` empty-state catalog: which event keys the config accepts.
 * en lists the bare keys (they are the literals the user types); zh pairs each
 * key with its Chinese display name so no bare id is the only label.
 */
export function hookEventCatalogLines(zh: boolean, indent = '  '): string[] {
  const labels = MOSS_HOOK_EVENT_IDS.map((id) => (zh ? `${id}（${HOOK_EVENT_ZH_NAMES[id]}）` : id));
  const perLine = zh ? 2 : 4;
  const lines: string[] = [];
  for (let i = 0; i < labels.length; i += perLine) {
    lines.push(`${indent}${labels.slice(i, i + perLine).join(' · ')}`);
  }
  return lines;
}
