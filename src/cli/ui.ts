import os from 'node:os';
import path from 'node:path';
import { isEffectiveUiZh } from '../utils/ui-language.js';

// Color detection: same logic as syntax-highlight.ts — check stderr.isTTY
// because Ink intercepts stdout, making stdout.isTTY always false in TUI.
// Also respect NO_COLOR and FORCE_COLOR.
const { env } = process;
const _ansiOn =
  !env.NO_COLOR &&
  (!!env.FORCE_COLOR ||
    !!env.COLORTERM ||
    Boolean((process.stdout as NodeJS.WriteStream).isTTY) ||
    Boolean((process.stderr as NodeJS.WriteStream).isTTY));

// Direct ANSI escape codes — bypass picocolors' TTY gate so colors work in
// Ink TUI (where stdout.isTTY is always false because Ink intercepts stdout).
const _a = (open: number | string, close: number | string) =>
  _ansiOn ? (s: string) => `\x1b[${open}m${s}\x1b[${close}m` : (s: string) => s;

export const ui = {
  bold: _a(1, 22),
  dim: _a(2, 22),
  black: _a(30, 39),
  green: _a(32, 39),
  yellow: _a(33, 39),
  red: _a(31, 39),
  cyan: _a(36, 39),
  gray: _a(90, 39),
};

export function label(name: string): string {
  return ui.dim(`${name}${isEffectiveUiZh() ? '：' : ':'}`);
}

export function compactPath(value: string): string {
  // path.resolve on Windows turns a POSIX absolute path (`/home/test/...`) into
  // `D:\home\test\...`. Those strings are display paths, not local files.
  if (process.platform === 'win32' && value.startsWith('/') && !/^[A-Za-z]:/.test(value)) {
    return value;
  }
  const home = os.homedir();
  const normalized = path.resolve(value);
  if (normalized === home) return '~';
  if (normalized.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, normalized)}`;
  }
  return normalized;
}
