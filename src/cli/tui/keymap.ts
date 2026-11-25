/**
 * Shell key registry (plan v3 P4).
 *
 * One table holds every shortcut of the shell: the key handler looks a key up
 * here, and the help block is generated from the same rows, so a shortcut
 * cannot be advertised without a handler or handled without being advertised.
 *
 * A key is written `mod+…+key` in a canonical order: `ctrl`, then `alt`, then
 * `shift`, then the key. The key is a letter, a digit, or a named key (`enter`,
 * `tab`, `up`, `pageup`, …) — the keys ink reports to the shell; a terminal's
 * F-keys never reach it, so they are not a key here. A letter or a digit needs
 * `ctrl` or `alt`: on its own it is composer text, and `shift+r` is how `R` is
 * typed. `enter`, `tab`, `escape`, `space`, `backspace` and `delete` need a
 * modifier too, since on their own they edit or send the draft. Enter, Esc,
 * Tab and the bare arrows belong to the composer before the registry is read
 * (`RESERVED_KEYS`). A command may own several keys; help prints the first.
 *
 * `~/.config/moss/keybindings.json` may rebind commands. The file is a JSON
 * object from command id to a key or a list of keys
 * (`{ "history.search": ["ctrl+t", "alt+r"] }`). Every problem becomes a
 * warning the user sees; nothing fails silently, and valid lines still apply.
 * Interrupt and quit are locked: a rebind there could strand a running task.
 */

export type ShellCommand =
  | 'caret.lineStart'
  | 'caret.lineEnd'
  | 'edit.killLineStart'
  | 'edit.killLineEnd'
  | 'edit.killWordBack'
  | 'edit.yank'
  | 'edit.attachClipboard'
  | 'history.search'
  | 'view.search'
  | 'editor.external'
  | 'draft.stash'
  | 'view.toggleVerbose'
  | 'queue.recall'
  | 'composer.clear'
  | 'run.interrupt'
  | 'app.quit';

export interface KeyBinding {
  command: ShellCommand;
  /** Every key that runs the command, canonical form. The first is the one help prints. */
  keys: string[];
  /** What the command does, as the help block reads it. */
  label: string;
  /** Interrupt and quit cannot be rebound (see module comment). */
  locked?: boolean;
}

function binding(
  command: ShellCommand,
  keys: readonly string[],
  label: string,
  locked?: boolean
): KeyBinding {
  return { command, keys: [...keys], label, ...(locked ? { locked: true } : {}) };
}

export const DEFAULT_KEYBINDINGS: readonly KeyBinding[] = [
  binding('caret.lineStart', ['ctrl+a'], 'caret to line start'),
  binding('caret.lineEnd', ['ctrl+e'], 'caret to line end'),
  binding('edit.killLineStart', ['ctrl+u'], 'delete to line start'),
  binding('edit.killLineEnd', ['ctrl+k'], 'delete to line end'),
  binding('edit.killWordBack', ['ctrl+w'], 'delete the previous word'),
  binding('edit.yank', ['ctrl+y'], 'paste deleted text'),
  binding('edit.attachClipboard', ['ctrl+v'], 'attach clipboard image (staged for read_image)'),
  binding('history.search', ['ctrl+r'], 'search your earlier prompts'),
  binding('view.search', ['ctrl+f'], 'search the transcript'),
  binding('editor.external', ['ctrl+g'], 'edit the draft in $EDITOR'),
  binding('draft.stash', ['ctrl+s'], 'stash the draft · press again to bring it back'),
  binding('view.toggleVerbose', ['ctrl+o'], 'detailed transcript (full output, reasoning)'),
  binding('queue.recall', ['alt+up'], 'edit the newest queued message'),
  binding('composer.clear', ['ctrl+l'], 'clear the composer'),
  binding('run.interrupt', ['ctrl+c'], 'interrupt the run · press again to quit', true),
  binding('app.quit', ['ctrl+d'], 'quit', true),
];

const COMMANDS = new Set<string>(DEFAULT_KEYBINDINGS.map((entry) => entry.command));

const MODIFIERS = ['ctrl', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'alt',
  shift: 'shift',
};

const NAMED_KEYS = new Set([
  'enter',
  'tab',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'backspace',
  'delete',
  'escape',
  'space',
]);

/** Other spellings a user may reasonably write for a named key. */
const NAMED_KEY_ALIASES: Readonly<Record<string, string>> = { return: 'enter' };

/** Keys that edit or send the draft on their own; a binding needs ctrl or alt. */
const TYPING_KEYS = new Set(['enter', 'tab', 'escape', 'space', 'backspace', 'delete']);

/**
 * Keys the composer and the viewport answer before the registry is read. A
 * binding there would never fire, so `loadKeybindings` refuses it and says why.
 */
export const RESERVED_KEYS: readonly string[] = [
  'enter',
  'shift+enter',
  'alt+enter',
  'ctrl+j',
  'tab',
  'shift+tab',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'alt+left',
  'alt+right',
  'ctrl+left',
  'ctrl+right',
  'home',
  'end',
  'pageup',
  'pagedown',
];
// The viewport reads Home/End/PgUp/PgDn off the ink key whatever modifiers are
// held, so no `shift+pageup` can get past it either.
const RESERVED_WITH_ANY_MODIFIER = /^(?:(?:ctrl|alt|shift)\+)*(?:home|end|pageup|pagedown)$/;
const RESERVED = new Set(RESERVED_KEYS);
const isReserved = (key: string): boolean =>
  RESERVED.has(key) || RESERVED_WITH_ANY_MODIFIER.test(key);

/** What a keybindings.json value may name, for the warning text. */
const KEY_GRAMMAR =
  'ctrl/alt/shift + a letter, a digit, enter, tab, an arrow, home, end, pageup, pagedown';

/** Canonical form for a user-written key (`Alt+Up`, `shift+ctrl+f`), or undefined. */
export function parseKeySpec(spec: string): string | undefined {
  const parts = spec
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const base = parts.pop();
  if (!base) return undefined;
  const spelled = NAMED_KEY_ALIASES[base] ?? base;
  const named = NAMED_KEYS.has(spelled)
    ? spelled
    : /^[a-z0-9]$/.test(spelled)
      ? spelled
      : undefined;
  if (!named) return undefined;
  const held = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier || held.has(modifier)) return undefined;
    held.add(modifier);
  }
  const needsModifier = /^[a-z0-9]$/.test(named) || TYPING_KEYS.has(named);
  if (needsModifier && !held.has('ctrl') && !held.has('alt')) return undefined;
  return [...MODIFIERS.filter((modifier) => held.has(modifier)), named].join('+');
}

/** The user's key with case and spacing folded, so `Enter` can still be recognised as one the composer keeps. */
function looseKeySpec(spec: string): string {
  return spec
    .trim()
    .toLowerCase()
    .split(/\s*\+\s*/)
    .join('+');
}

export interface KeyEventLike {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/**
 * The canonical key an ink key event names, or undefined when the event is
 * composer text (a letter, a digit, a shifted letter). `shift` on its own
 * never makes a binding, so typing `RDK` is never mistaken for a shortcut.
 */
export function keyEventSpec(key: KeyEventLike, chunk: string): string | undefined {
  const named = key.upArrow
    ? 'up'
    : key.downArrow
      ? 'down'
      : key.leftArrow
        ? 'left'
        : key.rightArrow
          ? 'right'
          : key.return
            ? 'enter'
            : key.tab
              ? 'tab'
              : key.escape
                ? 'escape'
                : key.backspace
                  ? 'backspace'
                  : key.delete
                    ? 'delete'
                    : key.pageUp
                      ? 'pageup'
                      : key.pageDown
                        ? 'pagedown'
                        : key.home
                          ? 'home'
                          : key.end
                            ? 'end'
                            : typeof chunk === 'string' && /^[a-z0-9]$/i.test(chunk)
                              ? chunk.toLowerCase()
                              : undefined;
  if (!named) return undefined;
  return parseKeySpec(
    [key.ctrl ? 'ctrl' : '', key.meta ? 'alt' : '', key.shift ? 'shift' : '', named]
      .filter(Boolean)
      .join('+')
  );
}

/** The command a canonical key runs, whichever position it holds in `keys`. */
export function commandForKey(
  bindings: readonly KeyBinding[],
  key: string
): ShellCommand | undefined {
  return bindings.find((entry) => entry.keys.includes(key))?.command;
}

export interface LoadedKeybindings {
  bindings: KeyBinding[];
  warnings: string[];
}

/** Apply a keybindings.json body over the defaults. Pure: no I/O. */
export function loadKeybindings(text: string | undefined): LoadedKeybindings {
  const bindings: KeyBinding[] = DEFAULT_KEYBINDINGS.map((entry) => ({
    ...entry,
    keys: [...entry.keys],
  }));
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
    const target = bindings.find((entry) => entry.command === command);
    if (!target) continue;
    if (target.locked) {
      warnings.push(`keybindings.json: ${command} cannot be rebound (ignored)`);
      continue;
    }
    const specs = (Array.isArray(value) ? value : [value]).filter(
      (spec): spec is string => typeof spec === 'string'
    );
    const keys = specs.map(parseKeySpec);
    const loose = specs.map(looseKeySpec);
    // A key the composer owns is refused even where it is too bare to parse
    // (`enter`, `up`): "the composer answers this" is the truer reason.
    const reserved = specs.filter((_spec, index) =>
      keys[index] !== undefined ? isReserved(keys[index] ?? '') : isReserved(loose[index] ?? '')
    );
    const unreadable = specs.some(
      (_spec, index) => keys[index] === undefined && !isReserved(loose[index] ?? '')
    );
    if (specs.length === 0 || unreadable) {
      warnings.push(
        `keybindings.json: ${JSON.stringify(value)} for ${command} is not a key this shell reads (use ${KEY_GRAMMAR})`
      );
      continue;
    }
    if (reserved.length > 0) {
      warnings.push(
        `keybindings.json: ${formatKeyList(reserved)} for ${command} is a key the composer already answers — pick another`
      );
      if (reserved.length === specs.length) continue;
    }
    const canonical = keys.filter((key): key is string => key !== undefined && !isReserved(key));
    target.keys = [...new Set(canonical)];
  }

  // Two commands on one key: the first in table order keeps it, the rest lose it.
  const seen = new Map<string, ShellCommand>();
  for (const entry of bindings) {
    entry.keys = entry.keys.filter((key) => {
      const owner = seen.get(key);
      if (owner) {
        warnings.push(
          `keybindings.json: ${key} is bound to both ${owner} and ${entry.command} — ${entry.command} loses that key`
        );
        return false;
      }
      seen.set(key, entry.command);
      return true;
    });
  }
  const kept = bindings.filter((entry) => entry.keys.length > 0);
  for (const entry of bindings) {
    if (entry.keys.length === 0) {
      warnings.push(`keybindings.json: ${entry.command} has no key left — it cannot be reached`);
    }
  }
  return { bindings: kept, warnings };
}

/** `ctrl+t, alt+r` — a warning reads better with the user's spelling kept. */
function formatKeyList(keys: readonly string[]): string {
  return keys.map((key) => `"${key}"`).join(', ');
}

/** `ctrl+up` → `Ctrl+↑`; the arrow glyphs match the rest of the help block. */
export function formatKeySpec(key: string): string {
  const parts = key.split('+');
  return parts
    .map((part) => {
      if (part === 'up') return '↑';
      if (part === 'down') return '↓';
      if (part === 'left') return '←';
      if (part === 'right') return '→';
      if (part === 'pageup') return 'PgUp';
      if (part === 'pagedown') return 'PgDn';
      if (part === 'enter') return 'Enter';
      if (part === 'tab') return 'Tab';
      if (part === 'escape') return 'Esc';
      if (part === 'space') return 'Space';
      if (part === 'backspace') return 'Bksp';
      if (part === 'delete') return 'Del';
      return part === 'ctrl' || part === 'alt' || part === 'shift'
        ? part[0]?.toUpperCase() + part.slice(1)
        : part.toUpperCase();
    })
    .join('+');
}

export interface ShortcutRow {
  keys: string;
  label: string;
}

/** Help rows for the bindings, generated from the table: one row, the first key. */
export function shortcutRows(bindings: readonly KeyBinding[]): ShortcutRow[] {
  return bindings.map((entry) => ({
    keys: formatKeySpec(entry.keys[0] ?? ''),
    label: entry.label,
  }));
}
