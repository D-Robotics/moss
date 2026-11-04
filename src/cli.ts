#!/usr/bin/env node

import { enforceNodeVersion } from './cli/node-version-check.js';

enforceNodeVersion();

// Prevent unhandled promise rejections from crashing the interactive CLI.
// Node.js v15+ defaults to `throw` mode (process crash on unhandled rejection).
// In a long-running interactive session, a single fire-and-forget promise
// rejection (event handler, stream error, background task) should not kill
// the entire session. Log the rejection for debugging and let the user continue.
process.on('unhandledRejection', (reason) => {
  let detail: string;
  if (reason instanceof Error) {
    detail = `${reason.message}${reason.stack ? `\n${reason.stack}` : ''}`;
  } else if (typeof reason === 'string') {
    detail = reason;
  } else {
    // For plain objects (the "#<Object>" case), log as much diagnostic
    // info as possible so the source can be identified: constructor name,
    // own keys, and JSON body.
    const ctor = (reason as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    const keys = (() => {
      try {
        return Object.keys(reason as object)
          .slice(0, 20)
          .join(', ');
      } catch {
        return '(keys unavailable)';
      }
    })();
    const json = (() => {
      try {
        return JSON.stringify(reason, null, 0)?.slice(0, 500);
      } catch {
        return '(non-serializable)';
      }
    })();
    detail = `[${ctor}] keys: ${keys}\n${json}`;
  }
  process.stderr.write(
    `\n[moss] Internal warning: an async operation failed but was not caught.\n${detail}\n`
  );
});

/**
 * `--version` fast path.
 *
 * `moss --version` used to load the whole runtime graph (~320 ms of process
 * startup) just to print one line: the CLI entry imports `cli-main.js` before
 * anything can inspect argv, and that pulls in config, tools, providers and the
 * TUI shell. The version line needs only package.json and the build stamp, so
 * answer it here before the runtime exists. Same rules as arg parsing: a version
 * flag before `--` wins unless help was also requested, and a flag after `--` is
 * payload for the model (`moss -- --version`), never a request.
 */
const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const flagScope = separator === -1 ? argv : argv.slice(0, separator);
const wantsVersion = flagScope.some((arg) => arg === '--version' || arg === '-v');
const wantsHelp = flagScope.some((arg) => arg === '--help' || arg === '-h');
if (wantsVersion && !wantsHelp) {
  const { formatVersionLine, getPackageVersion, readBuildStamp } =
    await import('./utils/package-info.js');
  const { createColors, isColorEnabled } = await import('./cli/color-level.js');
  const c = createColors(isColorEnabled(process.argv));
  // Same rendering as displayVersion(): bold "moss", cyan version + stamp.
  const rest = formatVersionLine(getPackageVersion(), readBuildStamp()).slice('moss '.length);
  process.stdout.write(`${c.bold('moss')} ${c.cyan(rest)}\n`);
} else {
  const { installSafeProcessCwd } = await import('./utils/safe-cwd.js');
  installSafeProcessCwd();
  await import('./cli-main.js');
}
