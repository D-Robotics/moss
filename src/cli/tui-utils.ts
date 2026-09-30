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
 *   - `attachment-refs.ts`    — `[Image #n]` / `[File #n]` input-ref helpers
 *   - `repl-chrome.ts`        — status line/badges/footer/welcome/label rendering
 *
 * Kept at the original path so consumers importing `dist/cli/tui-utils.js`
 * (src/cli/output.ts, src/cli/doctor.ts, src/cli/repl.ts, src/cli-main.ts, and
 * the cli-tui* / markdown-table / cli-attachments specs) keep working unchanged.
 * The exported surface is exactly the historical surface of this former
 * single-file module. `AGENTS_MD_TEMPLATE` stays here: it is a lone static
 * template constant with no code affinity to any of the modules above.
 */

export * from './terminal-text.js';
export * from './repl-process.js';
export * from './resume-replay.js';
export * from './transcript-types.js';
export * from './command-completion.js';
export * from './tool-headline.js';
export * from './attachment-refs.js';
export * from './repl-chrome.js';

export { cliLocale, isZhLocale } from './cli-locale.js';

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

Project memory for Moss and coding agents. Auto-loaded at the start of every session.

## Overview
<!-- What this project is, in one or two sentences. -->

## Build / test / run
<!-- The exact commands an agent should use, e.g. install / build / test / lint. -->

## Layout
<!-- Top-level directories and what lives in each. -->

## Conventions
<!-- Code style, naming, patterns to follow, and things NOT to touch. -->
`;
