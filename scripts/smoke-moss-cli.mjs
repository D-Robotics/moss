#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliEntry = path.join(repoRoot, 'dist', 'cli.js');

function log(step) {
  console.log(`[smoke:moss-cli] ${step}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: options.shell ?? (process.platform === 'win32' && /\.cmd$/i.test(command)),
  });
  if (result.status !== 0) {
    const rendered = [`$ ${command} ${args.join(' ')}`, result.stdout, result.stderr]
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

function runPtyStartup(tempRoot) {
  const python =
    process.platform === 'win32'
      ? null
      : spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0
        ? 'python3'
        : null;
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
  const result = run(python, ['-c', code, process.execPath, cliEntry, tempRoot], {
    cwd: repoRoot,
  });
  assertMatch(result.stdout, /Moss/, 'PTY startup');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cli-smoke-'));

try {
  log('building the CLI');
  run('npm', ['run', 'build'], { stdio: 'inherit' });
  if (!fs.existsSync(cliEntry)) throw new Error('dist/cli.js was not produced by the build');

  log('checking moss --version / --help');
  const version = run(process.execPath, [cliEntry, '--version']).stdout;
  assertMatch(version, /moss v\d+\.\d+\.\d+/, 'moss --version');

  const help = run(process.execPath, [cliEntry, '--help']).stdout;
  assertMatch(help, /Moss/, 'moss --help');

  log('checking config help with a clean environment');
  const configHelp = run(process.execPath, [cliEntry, 'config', '--help'], {
    env: cleanMossEnv(tempRoot),
  }).stdout;
  assertMatch(configHelp, /moss config init/, 'moss config --help');

  log('checking interactive REPL startup through a PTY');
  runPtyStartup(tempRoot);

  log('PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
