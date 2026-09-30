/** One status line: model + workspace + run state. Kept pure for specs. */
export interface StatusBarState {
  model?: string;
  workspace?: string;
  running: boolean;
  scrollOffset: number;
  halted?: boolean;
}

export function renderStatusBar(state: StatusBarState): string {
  const left = `moss · ${state.model ?? 'no model'}`;
  const ws = state.workspace ? ` · ${shortPath(state.workspace)}` : '';
  const run = state.halted
    ? ' · halted'
    : state.running
      ? ' · working (Esc to interrupt)'
      : ' · ready';
  const scroll = state.scrollOffset > 0 ? ` · ↑${state.scrollOffset}` : '';
  return `${left}${ws}${run}${scroll}`;
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.slice(-2).join('/');
}
