/**
 * Putting text on the system clipboard from the shell.
 *
 * Two routes, in this order. The terminal comes first: OSC 52 carries the
 * text to whatever terminal the user has, which also covers ssh and
 * containers — and nothing here can tell whether that terminal honoured it.
 * Then the system's own clipboard tool, whose exit status is the only real
 * proof of a copy. The status line reports what the tool did; when this
 * session has no tool it says so instead of "copied".
 */
import { spawnProcess } from '../../utils/run-process.js';
import { tui } from './copy.js';

/** A command that takes the text on its stdin. */
export interface ClipboardCommand {
  command: string;
  args: readonly string[];
}

/**
 * The clipboard commands for `platform`, in the order to try them. Linux has
 * no clipboard of its own: Wayland and X11 each have their tools, and a
 * session with neither — a container, ssh without forwarding — has only the
 * terminal. Windows gets none: the full-screen shell does not run there, and
 * `clip` reads its stdin in the console code page, which turns UTF-8 into
 * something else.
 */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): ClipboardCommand[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform !== 'linux') return [];
  const commands: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY) commands.push({ command: 'wl-copy', args: ['-t', 'text/plain'] });
  if (env.DISPLAY) {
    commands.push({ command: 'xclip', args: ['-selection', 'clipboard'] });
    commands.push({ command: 'xsel', args: ['--clipboard', '--input'] });
  }
  return commands;
}

/** A clipboard tool that has not exited by then counts as failed. */
export const CLIPBOARD_TIMEOUT_MS = 5_000;

export type ClipboardWrite =
  /** A tool ran and exited 0. */
  | { kind: 'copied'; tool: string }
  /** This session has no clipboard tool: only the terminal route was taken. */
  | { kind: 'terminal' }
  /** Every tool failed; `tool` and `reason` are the last one's. */
  | { kind: 'failed'; tool: string; reason: string };

/**
 * Runs one tool and settles on the tool's own exit.
 *
 * `xclip`, `xsel` and `wl-copy` fork a background process that keeps holding
 * the selection, and that process inherits the pipes. Waiting for the pipes
 * to close would wait forever, and killing the process group on a timeout
 * would kill the holder and empty the clipboard with it. So no pipes are
 * created for the tool's output, its exit is what counts, and a timeout kills
 * the tool alone.
 */
function runClipboardTool(
  command: ClipboardCommand,
  text: string,
  timeoutMs: number
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawnProcess(command.command, command.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timed out');
    }, timeoutMs);
    // A tool that exits before reading everything closes its stdin (EPIPE).
    child.stdin?.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === 'ENOENT' ? 'not found' : 'failed');
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else resolve(code === null ? `killed by ${signal ?? 'a signal'}` : `exit ${code}`);
    });
    child.stdin?.end(text);
  });
}

/**
 * Runs this session's clipboard tools until one exits 0. Never rejects.
 * `timeoutMs` stands in for the default when a probe needs the timeout path
 * to arrive quickly.
 */
export async function writeSystemClipboard(
  text: string,
  context: {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    timeoutMs?: number;
  }
): Promise<ClipboardWrite> {
  let failure: ClipboardWrite | undefined;
  const timeoutMs = context.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
  for (const command of clipboardCommands(context.platform, context.env)) {
    const reason = await runClipboardTool(command, text, timeoutMs);
    if (reason === undefined) return { kind: 'copied', tool: command.command };
    failure = { kind: 'failed', tool: command.command, reason };
  }
  return failure ?? { kind: 'terminal' };
}

/** The status line for a copy: `copied` when a tool did it, else what happened. */
export function clipboardNotice(result: ClipboardWrite, copied: string): string {
  switch (result.kind) {
    case 'copied':
      return copied;
    case 'terminal':
      return tui('sent to the terminal (OSC 52); this session has no clipboard tool');
    case 'failed':
      return tui('{tool} failed ({reason}); the text also went to the terminal (OSC 52)', {
        tool: result.tool,
        reason: result.reason,
      });
  }
}
