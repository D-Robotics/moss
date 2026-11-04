/**
 * Two small formatters shared by the headless command path and the REPL.
 *
 * They used to live in `cli/repl-chrome.ts`, so `command-dispatcher.ts` /
 * `tasks-commands.ts` / `doctor.ts` dragged the whole REPL chrome module (status
 * line, badges, footer, welcome text) into every `-p` run just to format a
 * timestamp or a token count. `repl-chrome.ts` re-exports them unchanged.
 */
import { isZhLocale } from './cli-locale.js';

export function formatSessionTimestamp(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0)
    return isZhLocale() ? '未知时间' : 'unknown time';
  const date = new Date(updatedAt);
  if (!isZhLocale()) return date.toLocaleString();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}
