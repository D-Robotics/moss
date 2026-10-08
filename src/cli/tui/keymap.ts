/**
 * Shell key registry (plan v3 P4).
 *
 * One table holds every Ctrl-letter action of the shell: the key handler looks a
 * key up here, and the help block is generated from the same rows, so a shortcut
 * cannot be advertised without a handler or handled without being advertised.
 *
 * `~/.config/moss/keybindings.json` may rebind commands. The file is a JSON object
 * from command id to key (`{ "history.search": "ctrl+t" }`). Every problem becomes
 * a warning the user sees; nothing fails silently, and valid lines still apply.
 * Interrupt and quit are locked: a rebind there could strand a running task.
 */

export type ShellCommand =
  | 'caret.lineStart'
  | 'caret.lineEnd'
  | 'edit.killLineStart'
  | 'edit.killLineEnd'
  | 'edit.killWordBack'
  | 'edit.yank'
  | 'history.search'
  | 'editor.external'
  | 'draft.stash'
  | 'view.toggleVerbose'
  | 'composer.clear'
  | 'run.interrupt'
  | 'app.quit';

export interface KeyBinding {
  command: ShellCommand;
  /** Canonical form: `ctrl+<letter>`. */
  key: string;
  /** What the command does, as the help block reads it. */
  label: string;
  /** Interrupt and quit cannot be rebound (see module comment). */
  locked?: boolean;
}

export const DEFAULT_KEYBINDINGS: readonly KeyBinding[] = [
  { command: 'caret.lineStart', key: 'ctrl+a', label: 'caret to line start' },
  { command: 'caret.lineEnd', key: 'ctrl+e', label: 'caret to line end' },
  { command: 'edit.killLineStart', key: 'ctrl+u', label: 'delete to line start' },
  { command: 'edit.killLineEnd', key: 'ctrl+k', label: 'delete to line end' },
  { command: 'edit.killWordBack', key: 'ctrl+w', label: 'delete the previous word' },
  { command: 'edit.yank', key: 'ctrl+y', label: 'paste deleted text' },
  { command: 'history.search', key: 'ctrl+r', label: 'search your earlier prompts' },
  { command: 'editor.external', key: 'ctrl+g', label: 'edit the draft in $EDITOR' },
  {
    command: 'draft.stash',
    key: 'ctrl+s',
    label: 'stash the draft · press again to bring it back',
  },
  {
    command: 'view.toggleVerbose',
    key: 'ctrl+o',
    label: 'detailed transcript (full output, reasoning)',
  },
  { command: 'composer.clear', key: 'ctrl+l', label: 'clear the composer' },
  {
    command: 'run.interrupt',
    key: 'ctrl+c',
    label: 'interrupt the run · press again to quit',
    locked: true,
  },
  { command: 'app.quit', key: 'ctrl+d', label: 'quit', locked: true },
];

const COMMANDS = new Set<string>(DEFAULT_KEYBINDINGS.map((binding) => binding.command));

/** Canonical `ctrl+<letter>` for a user-written key, or undefined. */
export function parseKeySpec(spec: string): string | undefined {
  const match = /^\s*ctrl\s*\+\s*([a-z])\s*$/i.exec(spec);
  return match ? `ctrl+${match[1]?.toLowerCase()}` : undefined;
}

export function commandForKey(
  bindings: readonly KeyBinding[],
  key: string
): ShellCommand | undefined {
  return bindings.find((binding) => binding.key === key)?.command;
}

export function keyForCommand(
  bindings: readonly KeyBinding[],
  command: ShellCommand
): string | undefined {
  return bindings.find((binding) => binding.command === command)?.key;
}

export interface LoadedKeybindings {
  bindings: KeyBinding[];
  warnings: string[];
}

/** Apply a keybindings.json body over the defaults. Pure: no I/O. */
export function loadKeybindings(text: string | undefined): LoadedKeybindings {
  const bindings: KeyBinding[] = DEFAULT_KEYBINDINGS.map((binding) => ({ ...binding }));
  const warnings: string[] = [];
  if (text === undefined || !text.trim()) return { bindings, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push('keybindings.json is not valid JSON — the defaults are kept');
    return { bindings, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push('keybindings.json must be an object of command → key — the defaults are kept');
    return { bindings, warnings };
  }

  for (const [command, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!COMMANDS.has(command)) {
      warnings.push(`keybindings.json: unknown command "${command}" (ignored)`);
      continue;
    }
    const target = bindings.find((binding) => binding.command === command);
    if (!target) continue;
    if (target.locked) {
      warnings.push(`keybindings.json: ${command} cannot be rebound (ignored)`);
      continue;
    }
    const key = typeof value === 'string' ? parseKeySpec(value) : undefined;
    if (!key) {
      warnings.push(
        `keybindings.json: "${String(value)}" for ${command} is not a key this shell reads (use ctrl+<letter>)`
      );
      continue;
    }
    target.key = key;
  }

  // Two commands on one key: the first in table order keeps it, the rest are told.
  const seen = new Map<string, ShellCommand>();
  for (const binding of bindings) {
    const owner = seen.get(binding.key);
    if (owner) {
      warnings.push(
        `keybindings.json: ${binding.key} is bound to both ${owner} and ${binding.command} — ${binding.command} is unbound`
      );
      binding.key = '';
    } else {
      seen.set(binding.key, binding.command);
    }
  }
  return { bindings: bindings.filter((binding) => binding.key !== ''), warnings };
}

export interface ShortcutRow {
  keys: string;
  label: string;
}

/** Help rows for the Ctrl-letter bindings, generated from the table. */
export function shortcutRows(bindings: readonly KeyBinding[]): ShortcutRow[] {
  return bindings.map((binding) => ({
    keys: binding.key
      .replace(/^ctrl\+/, 'Ctrl+')
      .replace(/^Ctrl\+(.)/, (_, letter: string) => `Ctrl+${letter.toUpperCase()}`),
    label: binding.label,
  }));
}
