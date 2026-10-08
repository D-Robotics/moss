/**
 * `/permissions` as a panel, not a transcript dump.
 *
 * Claude Code opens a rule list you can move through. Moss keeps the same
 * idea: the current mode, every allow/ask/deny rule, and a way to drop a
 * session rule. Adding a rule stays a command (`/permissions add …`) because
 * the spec has to be typed.
 */
import { clip, line, type TuiLine } from './text.js';
import { tui } from './copy.js';
import { TONE } from './theme.js';

export interface PermissionPanelRule {
  level: string;
  spec: string;
  source: string;
  /** Session rules can be removed from this panel. Config rules cannot. */
  session: boolean;
}

export interface PermissionPanelView {
  width: number;
  mode: string;
  rules: readonly PermissionPanelRule[];
  cursor: number;
}

export function renderPermissionsPanel(view: PermissionPanelView): TuiLine[] {
  const width = Math.max(20, view.width);
  const cursor =
    view.rules.length === 0 ? 0 : Math.max(0, Math.min(view.cursor, view.rules.length - 1));
  const out: TuiLine[] = [
    line(clip(tui('Permissions'), width), { bold: true, color: TONE.accent }),
    line(clip(tui('  mode  {mode}    Shift+Tab cycles', { mode: view.mode }), width), {
      dim: true,
    }),
  ];
  if (view.rules.length === 0) {
    out.push(
      line(clip(tui('  no rules — full allows tools; deny still wins everywhere'), width), {
        dim: true,
      })
    );
  }
  view.rules.forEach((rule, index) => {
    const mark = index === cursor ? '❯' : ' ';
    const where = rule.session ? tui('session') : rule.source;
    out.push(
      line(
        clip(`  ${mark} ${rule.level.padEnd(5)} ${rule.spec}  ${where}`, width),
        index === cursor ? { bold: true } : { dim: true }
      )
    );
  });
  out.push(
    line(clip(tui('  ↑↓ select · d remove session rule · Esc close'), width), { dim: true })
  );
  out.push(line(clip(tui('  add   /permissions add deny "exec(rm *)"'), width), { dim: true }));
  return out;
}
