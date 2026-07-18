import {
  getBackgroundProcessOutputTail,
  type BackgroundProcSnapshot,
} from '../tools/background-exec.js';

/** Multi-line system notice when a background process ends (TUI transcript / CLI stderr). */
export function formatBackgroundCompletionNotice(
  snap: BackgroundProcSnapshot,
  zh: boolean,
): string {
  const ageSec = Math.round(((snap.endedAt ?? Date.now()) - snap.startedAt) / 1000);
  const tag = snap.label ? ` (${snap.label})` : '';
  const exit =
    snap.status === 'error'
      ? `error: ${snap.errorMessage ?? 'unknown'}`
      : `exit ${snap.exitCode ?? '?'}${snap.signal ? ` signal ${snap.signal}` : ''}`;
  const head = zh
    ? `后台命令已结束 ${snap.id}${tag} [${snap.status}] ${exit} · ${ageSec}s · ${snap.command}`
    : `Background finished ${snap.id}${tag} [${snap.status}] ${exit} · ${ageSec}s · ${snap.command}`;
  let tail = '';
  try {
    tail = getBackgroundProcessOutputTail(snap.id, 6);
  } catch {
    tail = '';
  }
  if (!tail && snap.errorMessage) tail = snap.errorMessage;
  if (!tail) return head;
  const lines = tail
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-4);
  return [head, ...lines.map((l) => `  ${l.length > 120 ? `${l.slice(0, 119)}…` : l}`)].join('\n');
}

/** One-line flash / compact status when a background process ends. */
export function formatBackgroundCompletionFlash(
  snap: Pick<BackgroundProcSnapshot, 'id' | 'status' | 'exitCode'>,
  zh: boolean,
): string {
  if (snap.status === 'error' || (snap.exitCode !== null && snap.exitCode !== 0)) {
    return zh
      ? `后台失败 ${snap.id} exit ${snap.exitCode ?? '?'}`
      : `bg failed ${snap.id} exit ${snap.exitCode ?? '?'}`;
  }
  return zh
    ? `后台完成 ${snap.id} exit ${snap.exitCode ?? 0}`
    : `bg done ${snap.id} exit ${snap.exitCode ?? 0}`;
}
