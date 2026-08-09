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

const { installSafeProcessCwd } = await import('./utils/safe-cwd.js');
installSafeProcessCwd();
await import('./cli-main.js');
