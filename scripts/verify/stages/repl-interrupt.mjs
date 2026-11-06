/**
 * REPL interrupt (backlog B17 regression guard).
 *
 * The readline REPL used to have no interrupt path: Esc and Ctrl+C did nothing
 * until the turn finished, while the TUI aborted on Esc. This stage drives the
 * real REPL in a PTY against a slow local stub and presses keys mid-stream:
 *
 *   Esc      -> the stream must stop, the stub must see its client disconnect,
 *               and the UI must print the interrupt notice
 *   Ctrl+C   -> same (readline turns ^C into its own 'SIGINT' event)
 *   up arrow -> must NOT interrupt (an arrow key is an escape *sequence*; only a
 *               lone ESC byte is the interrupt key, so this guards false positives)
 *
 * Set `MOSS_VERIFY_CLI_ENTRY` to run the assertions against another build (used
 * to prove the probe fails on the previous revision).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

async function run(command, args, options = {}) {
  const result = await captureProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.timedOut) {
    throw new Error(`$ ${command} ${args.join(' ')} timed out`);
  }
  if (result.status !== 0) {
    // The driver carries a long inline program, so echo only its tails.
    throw new Error(
      [
        `status: ${String(result.status)}; signal: ${result.signal ?? 'none'}`,
        `stdout tail: ${String(result.stdout ?? '').slice(-800)}`,
        `stderr tail: ${String(result.stderr ?? '').slice(-800)}`,
      ].join('\n')
    );
  }
  return result;
}

async function drive(nodeBin, cliEntry, tempRoot, configDir, workspace, key) {
  const code = String.raw`
import json, os, pty, re, select, struct, subprocess, sys, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

node_bin, cli_path, temp_root, config_dir, workspace, key = sys.argv[1:7]
sent = {'count': 0}
closed = {'count': 0}
output = b''


def main():

  class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
      pass

    def do_POST(self):
      length = int(self.headers.get('content-length') or 0)
      self.rfile.read(length)
      if self.path.endswith('/models'):
        data = json.dumps({'data': [{'id': 'fake-model'}]}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return
      self.send_response(200)
      self.send_header('content-type', 'text/event-stream')
      self.end_headers()
      try:
        for index in range(400):
          chunk = {'id': 'x', 'object': 'chat.completion.chunk', 'created': 1,
                   'model': 'fake-model',
                   'choices': [{'index': 0, 'delta': {'content': 'tok%d ' % index}, 'finish_reason': None}]}
          self.wfile.write(('data: %s\n\n' % json.dumps(chunk)).encode())
          self.wfile.flush()
          sent['count'] += 1
          time.sleep(0.02)
      except Exception:
        closed['count'] += 1

  server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
  threading.Thread(target=server.serve_forever, daemon=True).start()
  port = server.server_address[1]
  with open(os.path.join(config_dir, 'config.json'), 'w') as handle:
    json.dump({
      'provider': 'openai-compatible', 'model': 'fake-model',
      'baseUrl': 'http://127.0.0.1:%d/v1' % port, 'apiKey': 'sk-test',
      'permissions': {'defaultMode': 'full'},
    }, handle)

  master, slave = pty.openpty()
  fcntl_tiocswinsz = termios.TIOCSWINSZ
  import fcntl
  fcntl.ioctl(slave, fcntl_tiocswinsz, struct.pack('HHHH', 40, 120, 0, 0))
  home = tempfile.mkdtemp(prefix='home-', dir=temp_root)
  env = {
    'PATH': os.environ.get('PATH', ''),
    'HOME': home,
    'TERM': 'xterm-256color',
    'LANG': 'C.UTF-8',
    'MOSS_NO_COLOR': '1',
    'MOSS_NO_TUI': '1',
    'MOSS_NO_RDK_DOCS': '1',
    'MOSS_TRUST_WORKSPACE': '1',
    'MOSS_CONFIG_DIR': config_dir,
  }
  proc = subprocess.Popen([node_bin, cli_path], stdin=slave, stdout=slave, stderr=slave,
                          env=env, cwd=workspace)
  os.close(slave)


  def pump(seconds):
    global output
    deadline = time.time() + seconds
    while time.time() < deadline:
      try:
        r, _, _ = select.select([master], [], [], 0.05)
      except OSError:
        return
      if r:
        try:
          chunk = os.read(master, 65536)
        except OSError:
          return
        if not chunk:
          return
        output += chunk


  # Wait for output rather than a fixed banner string (ANSI wrapping can split it).
  pump(0.2)
  deadline = time.time() + 10
  while b'Moss' not in output and time.time() < deadline:
    pump(0.1)
  try:
    os.write(master, b'say something long\n')
  except OSError:
    pass
  # Start the key press only once the stub is really streaming.
  deadline = time.time() + 10
  while sent['count'] < 5 and time.time() < deadline:
    pump(0.05)
  before = sent['count']
  try:
    os.write(master, {'esc': b'\x1b', 'ctrlc': b'\x03', 'arrow': b'\x1b[A'}[key])
  except OSError:
    pass
  # Give the abort under a loaded CI runner up to 4s, but stop as soon as the
  # stub sees the client disconnect: the disconnect is the definitive signal.
  deadline = time.time() + 4.0
  while closed['count'] == 0 and time.time() < deadline:
    pump(0.1)
  pump(0.2)
  after = sent['count']
  aborted = closed['count']
  pump(0.3)
  try:
    os.write(master, b'\x03')
  except OSError:
    pass
  pump(0.5)
  try:
    proc.kill()
    proc.wait(timeout=3)
  except Exception:
    pass
  server.shutdown()
  text = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', output.decode('utf-8', 'replace'))
  print(json.dumps({
    'key': key,
    'tokensBefore': before,
    'tokensAfter': after,
    'tokensAfterKey': after - before,
    'clientAborted': aborted,
    'interruptNotice': 'Interrupted' in text,
  }))


try:
  main()
except Exception as error:  # keep the failure readable for the stage
  print(json.dumps({'key': key, 'error': '%s: %s' % (type(error).__name__, error)}))
`;
  const result = await run(
    'python3',
    ['-c', code, nodeBin, cliEntry, tempRoot, configDir, workspace, key],
    {
      timeoutMs: 120_000,
    }
  );
  const line = result.stdout
    .split('\n')
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  if (!line) {
    throw new Error(`the REPL driver printed no result for ${key}`);
  }
  const parsed = JSON.parse(line);
  if (parsed.error) {
    throw new Error(`the REPL driver failed for ${key}: ${parsed.error}`);
  }
  return parsed;
}

async function pythonWithPty() {
  if (process.platform === 'win32') return null;
  const probe = await captureProcess('python3', ['--version'], {});
  return probe.status === 0 ? 'python3' : null;
}

export const stage = {
  name: 'repl-interrupt',
  requires: ['build'],
  description: 'REPL Esc/Ctrl+C interrupt the running turn; an arrow key does not',
  async run(context) {
    const cliEntry = process.env.MOSS_VERIFY_CLI_ENTRY ?? path.join(context.root, 'dist', 'cli.js');
    if (!fs.existsSync(cliEntry)) {
      return { ok: false, detail: `${cliEntry} is missing; run the build stage first` };
    }
    const hasPython = (await pythonWithPty()) !== null;
    if (!hasPython) {
      console.log('[repl-interrupt] skipping: python3/pty is unavailable');
      return { ok: true };
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-repl-interrupt-'));
    try {
      const runKey = async (key) => {
        const configDir = path.join(tempRoot, `config-${key}`);
        const workspace = path.join(tempRoot, `workspace-${key}`);
        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        return drive(process.execPath, cliEntry, tempRoot, configDir, workspace, key);
      };

      // Three PTY boots are independent: run them together (each has its own
      // port/pty/workspace), which turns ~9s of serial booting into one boot.
      const keys = ['esc', 'ctrlc', 'arrow'];
      const results = new Map(await Promise.all(keys.map(async (key) => [key, await runKey(key)])));
      for (const key of ['esc', 'ctrlc']) {
        console.log(`[repl-interrupt] checking ${key} stops the stream`);
        const result = results.get(key);
        if (!(result.tokensBefore > 3)) {
          throw new Error(`the stub sent only ${result.tokensBefore} tokens before ${key}`);
        }
        // The stub seeing its client disconnect is the authoritative signal; a
        // loaded runner may deliver a few more already-buffered tokens before
        // the abort lands, but not hundreds (the stub streams 400).
        if (result.tokensAfterKey > 150) {
          throw new Error(
            `${key} did not interrupt: the stub sent ${result.tokensAfterKey} more tokens after it`
          );
        }
        if (!result.clientAborted) {
          throw new Error(`${key} did not abort the request (the stub saw no client disconnect)`);
        }
        if (!result.interruptNotice) {
          throw new Error(`${key} did not print the interrupt notice`);
        }
      }

      console.log('[repl-interrupt] checking an arrow key does not interrupt');
      const arrow = results.get('arrow');
      if (arrow.tokensAfterKey < 20) {
        throw new Error(
          `an arrow key interrupted the run (only ${arrow.tokensAfterKey} more tokens); only a lone ESC may abort`
        );
      }
      console.log(
        `[repl-interrupt] esc/ctrlc aborted after one in-flight token; arrow kept streaming (${arrow.tokensAfterKey} tokens)`
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
};
