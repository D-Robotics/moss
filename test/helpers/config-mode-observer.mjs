/** Observe real Windows config writes and TTY identity; never alter their result. */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const trace = process.env.MOSS_E2E_TRACE;
const configDir = path.resolve(process.env.MOSS_CONFIG_DIR);
const append = fs.appendFileSync.bind(fs);
const record = (entry) => append(trace, `${JSON.stringify(entry)}\n`, 'utf8');
record({ operation: 'terminal', stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY });

const open = fs.openSync;
fs.openSync = function (file, flags, mode) {
  const result = open.call(this, file, flags, mode);
  if (typeof file === 'string' && path.dirname(path.resolve(file)) === configDir) {
    record({ operation: 'open', file: path.resolve(file), flags, mode });
  }
  return result;
};
const chmod = fs.chmodSync;
fs.chmodSync = function (file, mode) {
  const result = chmod.call(this, file, mode);
  if (typeof file === 'string' && path.dirname(path.resolve(file)) === configDir) {
    record({ operation: 'chmod', file: path.resolve(file), mode });
  }
  return result;
};
syncBuiltinESMExports();
