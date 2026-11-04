/**
 * How many diff lines a headless edit preview shows before eliding the rest.
 *
 * This number is shared by the headless renderer (`cli/output.ts`) and the TUI
 * transcript, so it lives in its own tiny module: importing it from
 * `cli/tui/transcript.js` would drag the whole renderer graph (composer,
 * markdown, code-style, theme, text) into every `-p` run.
 */
export const DIFF_PREVIEW_LINES = 14;
