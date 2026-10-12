import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Observe the original native probe without changing arguments, receiver or return identity. */
export function observeHostShellProbe(delegate, rows) {
  return function (...args) {
    const started = performance.now();
    const result = Reflect.apply(delegate, this, args);
    rows.push({
      executable: args[0],
      args: args[1],
      timeoutMs: args[2]?.timeout,
      durationMs: Math.round(performance.now() - started),
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
      stdout: String(result.stdout ?? '').slice(0, 2048),
      stderr: String(result.stderr ?? '').slice(0, 2048),
    });
    return result;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const original = cp.spawnSync;
  const rows = [];
  cp.spawnSync = observeHostShellProbe(original, rows);
  syncBuiltinESMExports();
  try {
    // Install the delegate before this first import captures runProcessSync.
    const { resolveHostShell } = await import('../dist/utils/host-shell.js');
    const shell = resolveHostShell();
    if (shell.kind !== 'pwsh') {
      console.error(JSON.stringify({ shell, originalNativeProbes: rows }));
      process.exitCode = 1;
    } else {
      console.log(`${shell.kind} ${shell.executable}`);
    }
  } finally {
    cp.spawnSync = original;
    syncBuiltinESMExports();
  }
}
