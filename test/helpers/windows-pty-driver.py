"""Real Windows ConPTY counterpart to the first-run spec's POSIX PTY driver."""
import os
import select
import sys
import time
from winpty import Backend, PtyProcess

node_bin, cli_path, home, config_dir, workspace, script, observer = sys.argv[1:8]
steps = []
for line in script.split('\n'):
    line = line.strip()
    if line:
        steps.append(line.split('\t', 1))

# Preserve only OS process support, not inherited provider credentials.
env = {key: os.environ[key] for key in
       ('PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP')
       if key in os.environ}
env.update({
    'HOME': home,
    'USERPROFILE': home,
    'TERM': 'xterm-256color',
    'LANG': 'C.UTF-8',
    'LC_ALL': 'C',
    'MOSS_CONFIG_DIR': config_dir,
    'MOSS_RUNTIME_DIR': os.path.join(home, 'runtime'),
    'MOSS_NO_BUNDLED_DEFAULT': '1',
    'MOSS_TRUST_WORKSPACE': '1',
    'NO_COLOR': '1',
    'MOSS_E2E_TRACE': os.path.join(home, 'config-mode-trace.jsonl'),
})
for pair in os.environ.get('MOSS_E2E_EXTRA', '').split('\n'):
    if pair and '=' in pair:
        key, value = pair.split('=', 1)
        env[key] = value

proc = PtyProcess.spawn([node_bin, '--import', observer, cli_path],
                       cwd=workspace, env=env, dimensions=(40, 120),
                       backend=str(Backend.ConPTY))
data = b''
failed = False


def pull(timeout):
    global data
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not proc.isalive():
            return False
        # PtyProcess.fileno() exposes its reader socket;
        # Windows select supports sockets, while the child receives a real TTY.
        ready, _, _ = select.select([proc], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = proc.read(16384)
        except (EOFError, OSError):
            return False
        if not chunk:
            continue
        data += chunk.encode('utf-8')
    return True


try:
    for kind, payload in steps:
        if kind == 'wait':
            needle = payload.encode()
            deadline = time.time() + 25
            found = False
            while time.time() < deadline:
                if needle in data:
                    found = True
                    break
                if not pull(0.3):
                    break
            if not found:
                sys.stderr.write('TIMEOUT waiting for %r\n' % payload)
                failed = True
                break
            time.sleep(0.2)
        elif kind == 'send':
            proc.write(payload.encode('utf-8').decode('unicode_escape'))
            time.sleep(0.2)
        elif kind == 'sleep':
            time.sleep(float(payload))
finally:
    try:
        proc.write('\x03')
        time.sleep(0.2)
        proc.write('\x03')
    except (EOFError, OSError):
        pass
    deadline = time.time() + 3
    while proc.isalive() and time.time() < deadline:
        pull(0.2)
    proc.close(force=True)

sys.stdout.buffer.write(data)
if failed:
    raise SystemExit(2)
