/**
 * O70: `moss -p` must exit within 2 s after the answer is printed.
 *
 * Normal exit relies on the event loop draining. Any handle left behind (a
 * background exec child whose stdout/stderr pipes are still open, an MCP
 * child that ignores SIGTERM, a stray ref'd timer or socket) keeps the
 * process alive. The guard is an unref'd timer: when the loop drains on its
 * own it never fires; when something lingers it forces the exit, always prints a
 * stderr warning with the number of open handles, and with MOSS_DEBUG_EXIT=1
 * also names them.
 */
export const EXIT_GUARD_MS = 2000;

export function describeActiveHandles(): string[] {
  const getter = (process as unknown as { getActiveResourcesInfo?: () => string[] })
    .getActiveResourcesInfo;
  return typeof getter === 'function' ? getter.call(process) : [];
}

export function armExitGuard(
  ms: number = EXIT_GUARD_MS,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    // Always warn so the force-exit never hides a leak (O70 acceptance).
    const handles = describeActiveHandles();
    log(
      `[moss] warning: forcing exit after ${ms} ms; ${handles.length} handle(s) still open` +
        (process.env.MOSS_DEBUG_EXIT === '1'
          ? `: ${handles.join(', ')}`
          : ' (set MOSS_DEBUG_EXIT=1 for details)')
    );
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }, ms);
  timer.unref();
  return timer;
}
