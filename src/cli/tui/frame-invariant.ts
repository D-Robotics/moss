/**
 * Frame-height invariant (plan v3 P0). A frame taller than the terminal scrolls
 * its own top away and parks the hardware cursor one row off — the class of bug
 * behind the jump-row and cursor regressions. Gemini CLI's `useFlickerDetector`
 * makes the same check; moss records it, off by default.
 *
 * Enabled with `MOSS_TUI_DEBUG=1`. A violation is appended to
 * `<workspace>/.moss/logs/tui-frame.log`; nothing is written to the terminal.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

/** A description of the violation, or `undefined` when the frame fits. */
export function frameViolation(
  frameRows: number,
  terminalRows: number,
  fullscreen: boolean
): string | undefined {
  if (frameRows <= terminalRows) return undefined;
  return `${fullscreen ? 'fullscreen' : 'inline'} frame ${frameRows} rows > terminal ${terminalRows}`;
}

export function noteFrameHeight(
  workspaceDir: string,
  frameRows: number,
  terminalRows: number,
  fullscreen: boolean
): void {
  const problem = frameViolation(frameRows, terminalRows, fullscreen);
  if (!problem) return;
  try {
    const dir = path.join(getMossWorkspacePaths(workspaceDir).runtimeDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tui-frame.log'), `${new Date().toISOString()} ${problem}\n`);
  } catch {
    // Diagnostics must never break the frame they describe.
  }
}
