/**
 * Vim modal editing stub — vim mode is disabled by default.
 * The full implementation was not completed; these stubs
 * allow the build to succeed and keep the TUI functional
 * with vim mode always off.
 */

let vimEnabled = false;
let vimMode: 'normal' | 'insert' = 'insert';

export function isVimEnabled(): boolean {
  return vimEnabled;
}

export function getVimModeIndicator(): string {
  return vimEnabled ? `-- ${vimMode.toUpperCase()} --` : '';
}

export function getVimModeColor(): string {
  return vimMode === 'normal' ? 'green' : 'gray';
}

export function getVimState(): { mode: 'normal' | 'insert' } {
  return { mode: vimMode };
}

export function setVimMode(mode: 'normal' | 'insert'): void {
  vimMode = mode;
  vimEnabled = mode !== 'insert';
}

export interface VimMoveAction {
  direction: 'left' | 'right' | 'up' | 'down';
  distance: number;
}

export interface VimEditAction {
  op: 'delete' | 'change' | 'paste' | 'yank';
}

export interface VimKeyAction {
  type: 'none' | 'mode' | 'move' | 'edit';
  move?: VimMoveAction;
  edit?: VimEditAction;
}

export function handleVimKey(_key: string, _cursor: number, _length: number): VimKeyAction {
  return { type: 'none' };
}
