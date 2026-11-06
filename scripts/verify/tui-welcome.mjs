#!/usr/bin/env node
/**
 * TUI first-screen parity probe (offline, B137).
 *
 * The REPL welcome reads the unified run ledger and AGENTS.md (B136); the TUI
 * must tell the same story on its first frame — `last run: …` plus a `Next:`
 * line that can be a resume command. Boots the real TUI under a PTY with a stub
 * provider and a seeded run record, then asserts on the stripped frame text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[tui-welcome] ok ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-welcome-'));
const home = path.join(tmp, 'home');
const ws = path.join(tmp, 'ws');
const configDir = path.join(home, 'config');
fs.mkdirSync(path.join(ws, '.moss', 'runs', 'task_failed_demo'), { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
fs.writeFileSync(
  path.join(ws, '.moss', 'runs', 'task_failed_demo', 'run.json'),
  `${JSON.stringify(
    {
      version: 1,
      runId: 'task_failed_demo',
      kind: 'task',
      status: 'verify_failed',
      exitCode: 1,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 60_000,
      durationMs: 60_000,
      goal: 'ship the demo feature',
      taskId: 'task_failed_demo',
      reason: 'acceptance command failed (exit 1)',
      next: 'moss task resume task_failed_demo',
    },
    null,
    2
  )}\n`,
  'utf8'
);
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({
    provider: 'openai-compatible',
    model: 'm',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-test',
    permissions: { defaultMode: 'full' },
  })
);

const script = path.join(tmp, 'probe.py');
fs.writeFileSync(
  script,
  String.raw`import os, pty, re, select, subprocess, sys, time, fcntl, struct, termios
CLI = sys.argv[1]
WS = sys.argv[2]
HOME = sys.argv[3]
CFG = sys.argv[4]
ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]')
env = {'PATH': os.environ['PATH'], 'HOME': HOME, 'MOSS_CONFIG_DIR': CFG, 'TERM': 'xterm-256color',
       'MOSS_TRUST_WORKSPACE': '1', 'MOSS_NO_RDK_DOCS': '1', 'MOSS_LANG': 'en', 'MOSS_NO_COLOR': '1',
       'COLUMNS': '120', 'LINES': '40'}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
proc = subprocess.Popen([CLI], stdin=slave, stdout=slave, stderr=slave, env=env,
                        cwd=os.path.realpath(WS), preexec_fn=os.setsid)
os.close(slave)
out = b''
deadline = time.time() + 12
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.4)
    if r:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        out += data
    if b'Next:' in out and b'last run' in out and b'Resume with' in out:
        break
try: os.write(master, b'\x03\x03')
except OSError: pass
time.sleep(0.3)
try:
    proc.kill(); proc.wait(timeout=2)
except Exception:
    pass
flat = re.sub(r'\s+', ' ', ANSI.sub('', out.decode('utf-8', 'replace')))
print('FRAME=' + flat)
`,
  'utf8'
);

try {
  const run = await new Promise((resolve) => {
    const child = spawn('python3', [script, path.join(root, 'dist/cli.js'), ws, home, configDir], {
      env: { PATH: process.env.PATH },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  const frameLine = run.split('\n').find((line) => line.startsWith('FRAME='));
  assert.ok(frameLine, `the TUI boot produced no frame: ${run.slice(0, 400)}`);
  const frame = frameLine.slice('FRAME='.length);
  assert.match(frame, /last run: verify_failed/, frame.slice(0, 600));
  assert.match(frame, /ship the demo feature/, 'the goal should appear on the first frame');
  assert.match(frame, /Next: \/run resume task_failed_demo/, frame.slice(0, 600));
  assert.match(
    frame,
    /Resume with moss task resume task_failed_demo/,
    'the empty composer should offer the resume, not a slogan'
  );
  ok('the TUI first frame shows the last run, its resume command and the composer hint');

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (error) {
  fs.rmSync(tmp, { recursive: true, force: true });
  throw error;
}

console.log(`[tui-welcome] ${checks}/${checks} checks passed`);
