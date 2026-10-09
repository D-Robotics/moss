/**
 * Run a bench shell on the local sandbox or over SSH.
 *
 * Dry mode executes locally with simulated systemctl/dpkg on PATH.
 * Sim and real modes SSH. The password is read from MOSS_DEVICE_PASSWORD or
 * RDK_S600_PASSWORD and is never placed in argv or in error text.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { findForbidden, redactSecrets, shellQuote } from './device-bench-safety.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SIM_BIN = path.join(repoRoot, 'bench', 'device-tasks', 'sim', 'bin');
export const SIM_ROS_BIN = path.join(repoRoot, 'bench', 'device-tasks', 'sim', 'ros-bin');

const REWRITE_PREFIXES = ['/etc/systemd/system', '/usr/share/moss-bench-marker', '/var/lib/dpkg'];

const REWRITE_BOUNDARY = /[\s"'=<>;&|(`]/;

export function rewriteSimPaths(command, stateDir) {
  let out = command;
  for (const prefix of REWRITE_PREFIXES) {
    const replacement = path.join(stateDir, prefix.replace(/^\//, ''));
    let next = '';
    let cursor = 0;
    while (cursor < out.length) {
      const index = out.indexOf(prefix, cursor);
      if (index === -1) {
        next += out.slice(cursor);
        break;
      }
      const boundary = index === 0 || REWRITE_BOUNDARY.test(out[index - 1] ?? '');
      next += out.slice(cursor, index);
      next += boundary ? replacement : prefix;
      cursor = index + prefix.length;
    }
    out = next;
  }
  return out;
}

export function stateDirFromScript(script, fallback) {
  const match = String(script).match(/MOSS_BENCH_STATE='([^']*)'/);
  return match?.[1] || fallback;
}

export function wrapScript(script, ctx) {
  const lines = [
    'set -eu',
    `export MOSS_BENCH_ROOT=${shellQuote(ctx.root)}`,
    `export MOSS_BENCH_STATE=${shellQuote(ctx.stateDir)}`,
    `export MOSS_BENCH_TOKEN=${shellQuote(ctx.token)}`,
    `export MOSS_BENCH_PORT=${shellQuote(String(ctx.port))}`,
    `export MOSS_BENCH_WORKSPACE=${shellQuote(ctx.workspace ?? '')}`,
  ];
  if (ctx.sim) lines.push('export MOSS_BENCH_SIM=1');
  if (ctx.simCamera) lines.push('export MOSS_BENCH_SIM_CAMERA=1');
  if (ctx.simRos) lines.push('export MOSS_BENCH_SIM_ROS=1');
  lines.push(script);
  return lines.join('\n');
}

function benchEnv(ctx) {
  const bins = [];
  if (ctx.simRos) bins.push(SIM_ROS_BIN);
  if (ctx.sim) bins.push(SIM_BIN);
  const pathEnv = [...bins, process.env.PATH].filter(Boolean).join(path.delimiter);
  const env = {
    PATH: pathEnv,
    HOME: process.env.HOME ?? os.homedir(),
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    MOSS_BENCH_ROOT: ctx.root,
    MOSS_BENCH_STATE: ctx.stateDir,
    MOSS_BENCH_WORKSPACE: ctx.workspace ?? '',
    MOSS_BENCH_TOKEN: ctx.token,
    MOSS_BENCH_PORT: String(ctx.port),
  };
  if (ctx.sim) env.MOSS_BENCH_SIM = '1';
  if (ctx.simCamera) env.MOSS_BENCH_SIM_CAMERA = '1';
  if (ctx.simRos) env.MOSS_BENCH_SIM_ROS = '1';
  return env;
}

function runBash(script, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { env });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: redactSecrets(error.message), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = timedOut ? '\ntimed out' : '';
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: redactSecrets(Buffer.concat(stdout).toString('utf8')),
        stderr: redactSecrets(Buffer.concat(stderr).toString('utf8') + tail),
        timedOut,
      });
    });
  });
}

export function execLocalRaw(script, ctx) {
  const body = ctx.sim ? rewriteSimPaths(script, ctx.stateDir) : script;
  const hits = findForbidden(body);
  if (hits.length > 0) {
    return Promise.resolve({
      code: 126,
      stdout: '',
      stderr: `blocked: ${hits.join(',')}`,
      timedOut: false,
    });
  }
  return runBash(body, benchEnv(ctx), ctx.timeoutMs ?? 30_000);
}

function deviceConnectConfig() {
  const host = process.env.MOSS_DEVICE_HOST?.trim();
  if (!host) {
    throw new Error('MOSS_DEVICE_HOST is not set');
  }
  const username = process.env.MOSS_DEVICE_USER?.trim() || 'root';
  const port = Number(process.env.MOSS_DEVICE_PORT) || 22;
  const config = { host, port, username, readyTimeout: 15_000 };
  const keyPath = process.env.MOSS_DEVICE_KEY?.trim();
  if (keyPath) {
    config.privateKey = fs.readFileSync(keyPath);
    return config;
  }
  const password = process.env.MOSS_DEVICE_PASSWORD || process.env.RDK_S600_PASSWORD;
  if (!password) {
    throw new Error(
      'no device credentials (set RDK_S600_PASSWORD, MOSS_DEVICE_PASSWORD, or MOSS_DEVICE_KEY)'
    );
  }
  config.password = password;
  return config;
}

function execSsh(script, ctx) {
  const hits = findForbidden(script);
  if (hits.length > 0) {
    return Promise.resolve({
      code: 126,
      stdout: '',
      stderr: `blocked: ${hits.join(',')}`,
      timedOut: false,
    });
  }
  let config;
  try {
    config = deviceConnectConfig();
  } catch (error) {
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: redactSecrets(error instanceof Error ? error.message : String(error)),
      timedOut: false,
    });
  }
  const command = `bash -c ${shellQuote(script)}`;
  const timeoutMs = ctx.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const conn = new ssh2.Client();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ code: 124, stdout: '', stderr: 'ssh timed out', timedOut: true });
    }, timeoutMs);
    conn.on('ready', () => {
      conn.exec(command, (error, stream) => {
        if (error) {
          finish({
            code: 1,
            stdout: '',
            stderr: redactSecrets(error.message),
            timedOut: false,
          });
          return;
        }
        const stdout = [];
        const stderr = [];
        stream.on('data', (chunk) => stdout.push(chunk));
        stream.stderr.on('data', (chunk) => stderr.push(chunk));
        stream.on('close', (code) => {
          finish({
            code: typeof code === 'number' ? code : 1,
            stdout: redactSecrets(Buffer.concat(stdout).toString('utf8')),
            stderr: redactSecrets(Buffer.concat(stderr).toString('utf8')),
            timedOut: false,
          });
        });
      });
    });
    conn.on('error', (error) => {
      finish({
        code: 1,
        stdout: '',
        stderr: redactSecrets(error.message),
        timedOut: false,
      });
    });
    conn.connect(config);
  });
}

export function execOnTarget(script, ctx) {
  const wrapped = wrapScript(script, ctx);
  if (ctx.mode === 'ssh') return execSsh(wrapped, ctx);
  return execLocalRaw(wrapped, ctx);
}

export function newBenchPassword() {
  return randomBytes(18).toString('base64url');
}

/**
 * In-process ssh2 server whose exec channel runs the local sandbox.
 * Host keys are generated in memory. The password is compared in memory
 * and never written to known_hosts or to a log line.
 */
export async function startSimSsh(options) {
  const password = options.password;
  const user = options.user ?? 'root';
  if (!password) throw new Error('sim ssh requires an in-memory password');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const hostKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new ssh2.Server({ hostKeys: [hostKeyPem] });
  const template = options.ctx;
  const live = new Set();
  server.on('connection', (conn) => {
    live.add(conn);
    conn.once('close', () => live.delete(conn));
    conn.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.username === user && auth.password === password) {
        auth.accept();
      } else {
        auth.reject(['password']);
      }
    });
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const command = info?.command ?? '';
          const hits = findForbidden(command);
          const finish = (code, stdout, stderr) => {
            // Defer so the client can attach its listeners. A synchronous
            // exit inside the exec handler drops the channel before that.
            setImmediate(() => {
              if (stdout) stream.write(stdout);
              if (stderr) stream.stderr.write(stderr);
              stream.exit(code);
              stream.end();
            });
          };
          if (hits.length > 0) {
            finish(126, '', `blocked: ${hits.join(',')}\n`);
            return;
          }
          const stateDir = stateDirFromScript(command, template.stateDir);
          const simRos = /MOSS_BENCH_SIM_ROS=1/.test(command) || template.simRos === true;
          const simCamera = /MOSS_BENCH_SIM_CAMERA=1/.test(command) || template.simCamera === true;
          execLocalRaw(command, {
            ...template,
            stateDir,
            sim: true,
            simRos,
            simCamera,
            mode: 'local',
          })
            .then((result) => {
              finish(result.code ?? 1, result.stdout, result.stderr);
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              finish(1, '', redactSecrets(message));
            });
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('sim ssh failed to bind');
  }
  return {
    host: '127.0.0.1',
    port: address.port,
    user,
    close: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(), 1000);
        for (const conn of live) conn.end();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
