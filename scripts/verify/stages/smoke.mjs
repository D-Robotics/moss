/**
 * CLI smoke: the built `dist/cli.js` must report its version, render help,
 * resolve `config --help` with a clean environment, and start the TUI in a
 * PTY when python3/pty is available. The build is a separate stage; this one
 * only checks the artifact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from '../lib/proc.mjs';

function log(step) {
  console.log(`[smoke:moss-cli] ${step}`);
}

async function run(command, args, options = {}) {
  const result = await captureProcess(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
  if (result.timedOut) {
    throw new Error(`$ ${command} ${args.join(' ')} timed out`);
  }
  if (result.status !== 0) {
    const rendered = [
      `$ ${command} ${args.join(' ')}`,
      result.error ? `launch error: ${result.error.name}: ${result.error.message}` : null,
      `status: ${String(result.status)}; signal: ${result.signal ?? 'none'}`,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(rendered);
  }
  return result;
}

function assertMatch(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} did not match ${pattern}\n--- text ---\n${text}`);
  }
}

function cleanMossEnv(tempRoot) {
  const env = {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'home', '.config'),
    MOSS_CONFIG_DIR: path.join(tempRoot, 'home', '.config', 'moss'),
    MOSS_RUNTIME_DIR: path.join(tempRoot, 'home', '.moss-runtime'),
    MOSS_NO_COLOR: '1',
    // Builtin rdk-docs connects by default. Smoke must not spawn npx.
    MOSS_NO_RDK_DOCS: '1',
  };
  for (const key of [
    'MOSS_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DASHSCOPE_API_KEY',
    'ALIYUN_API_KEY',
    'MOSS_PROVIDER',
    'MOSS_MODEL',
    'MOSS_BASE_URL',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'DASHSCOPE_BASE_URL',
  ]) {
    delete env[key];
  }
  return env;
}

async function pythonWithPty() {
  if (process.platform === 'win32') return null;
  const probe = await captureProcess('python3', ['--version'], {});
  return probe.status === 0 ? 'python3' : null;
}

async function runPtyStartup(tempRoot, cliEntry) {
  const python = await pythonWithPty();
  if (!python) {
    log('skipping PTY startup check because python3/pty is unavailable');
    return;
  }
  const code = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, tempfile, termios, time
node_bin = sys.argv[1]
cli_path = sys.argv[2]
temp_root = sys.argv[3]
master, slave = pty.openpty()
# Ink waits for a usable terminal geometry before rendering. A synthetic PTY
# starts at 0x0 on some Linux hosts, unlike a real interactive terminal.
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 120, 0, 0))
home = tempfile.mkdtemp(prefix='home-', dir=temp_root)
workspace = tempfile.mkdtemp(prefix='workspace-', dir=temp_root)
env = {
  'PATH': os.environ.get('PATH', ''),
  'HOME': home,
  'TERM': 'xterm-256color',
  'LANG': 'C.UTF-8',
  'MOSS_NO_COLOR': '1',
  'MOSS_CONFIG_DIR': os.path.join(home, 'config'),
  'MOSS_RUNTIME_DIR': os.path.join(home, 'runtime'),
  'MOSS_NO_RDK_DOCS': '1',
  'MOSS_TRUST_WORKSPACE': '1',
}
proc = subprocess.Popen([node_bin, cli_path], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=workspace)
os.close(slave)
data = b''
try:
  deadline = time.time() + 15
  while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
      chunk = os.read(master, 8192)
      if not chunk:
        break
      data += chunk
      if b'Moss' in data and (b'/help' in data or b'Ask Moss' in data or b'setup' in data.lower()):
        break
  try:
    os.write(master, b'\x03')
  except OSError:
    pass
  try:
    proc.wait(timeout=2)
  except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait(timeout=2)
finally:
  os.close(master)
text = data.decode('utf-8', 'replace')
print(text[:2000])
if 'Moss' not in text or not ('/help' in text or 'Ask Moss' in text or 'setup' in text.lower()):
  raise SystemExit('Moss TUI startup text was not detected')
`;
  const result = await run(python, ['-c', code, process.execPath, cliEntry, tempRoot]);
  assertMatch(result.stdout, /Moss/, 'PTY startup');
}

export const stage = {
  name: 'smoke',
  requires: ['build'],
  description: 'built CLI: version, help, config help, PTY startup',
  async run(context) {
    const cliEntry = path.join(context.root, 'dist', 'cli.js');
    if (!fs.existsSync(cliEntry)) {
      return { ok: false, detail: 'dist/cli.js is missing; run the build stage first' };
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cli-smoke-'));
    try {
      log('checking moss --version / --help');
      const version = (await run(process.execPath, [cliEntry, '--version'])).stdout;
      assertMatch(version, /moss v\d+\.\d+\.\d+/, 'moss --version');

      const help = (await run(process.execPath, [cliEntry, '--help'])).stdout;
      assertMatch(help, /Moss/, 'moss --help');

      log('checking config help with a clean environment');
      const configHelp = (
        await run(process.execPath, [cliEntry, 'config', '--help'], {
          env: cleanMossEnv(tempRoot),
        })
      ).stdout;
      assertMatch(configHelp, /moss config init/, 'moss config --help');

      log('checking interactive REPL startup through a PTY');
      await runPtyStartup(tempRoot, cliEntry);

      log('PASS');
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
};
