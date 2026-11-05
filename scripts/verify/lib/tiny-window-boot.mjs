/**
 * Boot helpers shared by the tiny-window probes.
 *
 * B80: the tiny-window gate used to be one stage that booted the CLI six times in
 * a row (three `-p` starts, three `doctor` runs, one TUI under a PTY). The verify
 * scheduler only overlaps stages, so that single serial stage sat on the critical
 * path. Each boot group now has its own stage and they share the pool; this module
 * keeps the fixtures identical.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../..');

export { root };

// ── Startup notice: the user must be told the reduced profile is active. ─────

async function bootStderr(contextTokens, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tiny-notice-'));
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      permissions: { defaultMode: 'full' },
      agent: { contextTokens },
    })
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_TUI: '1',
    MOSS_NO_RDK_DOCS: '1',
    MOSS_LANG: 'en',
    MOSS_TRUST_WORKSPACE: '1',
    ...extraEnv,
  };
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), '-p', 'hi'], {
      cwd: home,
      env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve(stderr);
    });
  });
}

// ── doctor: the reduced profile must be inspectable without guessing. ───────
async function bootDoctor(contextTokens) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tiny-doctor-'));
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      permissions: { defaultMode: 'full' },
      agent: { contextTokens },
    })
  );
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), 'doctor'], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        MOSS_CONFIG_DIR: configDir,
        MOSS_NO_TUI: '1',
        MOSS_NO_RDK_DOCS: '1',
        MOSS_LANG: 'en',
        MOSS_TRUST_WORKSPACE: '1',
      },
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
      fs.rmSync(home, { recursive: true, force: true });
      resolve(out);
    });
  });
}

/** B78: the TUI paints before the startup probe; the notice must still land. */
async function bootTuiTinyNotice(contextTokens) {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tui-notice-')), 'probe.py');
  fs.writeFileSync(
    script,
    String.raw`import json, os, pty, re, select, subprocess, sys, tempfile, threading, time, fcntl, struct, termios
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLI = sys.argv[1]
WINDOW = int(os.environ.get('WINDOW', '4096'))
ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]')

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self): self._json({'data': [{'id': 'm', 'context_length': WINDOW}]})
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n)
        chunks = [
            {'id':'x','object':'chat.completion.chunk','created':1,'model':'m',
             'choices':[{'index':0,'delta':{'role':'assistant','content':'ok'},'finish_reason':None}]},
            {'id':'x','object':'chat.completion.chunk','created':1,'model':'m',
             'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':2}}]
        body = (''.join('data: %s\n\n' % json.dumps(c) for c in chunks) + 'data: [DONE]\n\n').encode()
        self.send_response(200); self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
home = tempfile.mkdtemp(prefix='moss-tui-notice-home-'); ws = tempfile.mkdtemp(prefix='moss-tui-notice-ws-')
cfg = os.path.join(home, 'config'); os.makedirs(cfg)
json.dump({'provider':'openai-compatible','model':'m','baseUrl':'http://127.0.0.1:%d/v1' % port,
           'apiKey':'sk-test','permissions':{'defaultMode':'full'}}, open(os.path.join(cfg,'config.json'),'w'))
env = {'PATH': os.environ['PATH'], 'HOME': home, 'MOSS_CONFIG_DIR': cfg, 'TERM': 'xterm-256color',
       'MOSS_TRUST_WORKSPACE': '1', 'MOSS_NO_RDK_DOCS': '1', 'MOSS_LANG': 'en', 'MOSS_NO_COLOR': '1',
       'COLUMNS': '120', 'LINES': '40'}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
proc = subprocess.Popen([CLI], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=os.path.realpath(ws),
                        preexec_fn=os.setsid)
os.close(slave)
out = b''
deadline = time.time() + (int(os.environ.get('WAIT_S', '12')))
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.4)
    if r:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        out += data
    if b'5 core tools' in out: break
try: os.write(master, b'\x03\x03')
except OSError: pass
time.sleep(0.3)
try:
    proc.kill(); proc.wait(timeout=2)
except Exception:
    pass
srv.shutdown()
flat = re.sub(r'\s+', ' ', ANSI.sub('', out.decode('utf-8', 'replace')))
print('NOTICE=%s' % ('yes' if '5 core tools' in flat else 'no'))
`
  );
  const run = await new Promise((resolve) => {
    const child = spawn('python3', [script, path.join(root, 'dist/cli.js')], {
      env: {
        PATH: process.env.PATH,
        WINDOW: String(contextTokens),
        // A tiny window breaks out as soon as the notice renders; a wide one has
        // nothing to wait for, so it only needs the probe window plus a margin.
        WAIT_S: contextTokens <= 6_000 ? '12' : '3',
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  fs.rmSync(path.dirname(script), { recursive: true, force: true });
  return run.includes('NOTICE=yes');
}

export { bootStderr, bootDoctor, bootTuiTinyNotice };
