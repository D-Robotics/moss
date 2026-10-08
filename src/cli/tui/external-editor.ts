/**
 * Arguments for Ctrl+G, the external editor on the draft (plan v3 P6).
 *
 * `EDITOR` may carry arguments (`code --wait`). Editors that take a line number
 * open on the caret's line; VS Code, Cursor and VSCodium need `--wait` or moss
 * reads the draft before the user has saved it.
 */
import path from 'node:path';

export interface EditorCommand {
  bin: string;
  args: string[];
}

/** `code --wait` → `{ bin: 'code', args: ['--wait'] }`. Whitespace splits; quotes are not used. */
export function splitEditorCommand(command: string): EditorCommand {
  const [bin = '', ...args] = command.trim().split(/\s+/);
  return { bin, args };
}

const VSCODE_FAMILY = new Set(['code', 'code-insiders', 'codium', 'cursor']);
const PLUS_LINE = new Set(['vi', 'vim', 'nvim', 'nano', 'emacs', 'micro', 'kak']);

function editorName(bin: string): string {
  return path
    .basename(bin)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
}

/** Arguments that put `file` in front of the editor at `line` (1-based). */
export function externalEditorArgs(bin: string, file: string, line: number): string[] {
  const name = editorName(bin);
  if (VSCODE_FAMILY.has(name)) return ['--wait', '-g', `${file}:${line}`];
  if (PLUS_LINE.has(name)) return [`+${line}`, file];
  return [file];
}

/** 1-based line of the caret in `value`. */
export function caretLine(value: string, caret: number): number {
  const before = value.slice(0, Math.max(0, Math.min(caret, value.length)));
  return before.split('\n').length;
}
