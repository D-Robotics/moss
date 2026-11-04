/**
 * Thin re-export shell for the former single-file `cli/tui-utils.ts` grab-bag,
 * now split into focused sibling modules:
 *
 *   - `terminal-text.ts`      — ANSI/control-char sanitizers, visible/truncated text
 *   - `repl-process.ts`       — local `!` shell execution and process-tree kill
 *   - `resume-replay.ts`      — transcript rows replayed after `/resume`
 *   - `transcript-types.ts`   — transcript/activity/picker state types + id factory
 *   - `command-completion.ts` — slash-command suggestion/completion
 *   - `tool-headline.ts`      — one-line tool-call summaries for headlines
 *   - `repl-chrome.ts`        — status line/badges/footer/welcome/label rendering
 *
 * Kept at the original path so consumers importing `dist/cli/tui-utils.js`
 * (src/cli/output.ts, src/cli/doctor.ts, src/cli/repl.ts, src/cli-main.ts) keep
 * working unchanged.
 */

export * from './terminal-text.js';
export * from './repl-process.js';
export * from './resume-replay.js';
export * from './transcript-types.js';
export * from './command-completion.js';
export * from './tool-headline.js';
export * from './repl-chrome.js';

export { cliLocale, isZhLocale } from './cli-locale.js';
