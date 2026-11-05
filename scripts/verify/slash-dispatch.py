#!/usr/bin/env python3
"""Drive one REPL session through every catalogued slash command.

`src/cli/interactive-commands.ts` is the catalog the REPL advertises (menu rows,
hidden-but-dispatchable rows, and the "did you mean" pool). Nothing tied that
catalog to the REPL's dispatch chain, so a row could claim a command the REPL
answers with "unknown command" — `/queue` and `/steer` did exactly that, because
mid-run input only exists in the TUI.

This probe boots the built CLI in a PTY with a local OpenAI-compatible stub (the
commands themselves need no model call; `/doctor` pings, so the stub must answer),
types each command on its own line, and reports which one was not understood.

Usage: slash-dispatch.py <node-binary> <cli-entry> <temp-root> <commands-json>
The commands file is a JSON array of slash command strings.
"""
import json
import os
import pty
import re
import select
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROMPT = '\u203a'.encode('utf-8')


class StubLLM(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def _send(self, body, content_type):
        self.send_response(200)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(
            json.dumps({'data': [{'id': 'm', 'context_length': 128000}]}).encode('utf-8'),
            'application/json',
        )

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        self.rfile.read(length)
        chunks = [
            {
                'id': 'x',
                'object': 'chat.completion.chunk',
                'created': 1,
                'model': 'm',
                'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': None}],
            },
            {
                'id': 'x',
                'object': 'chat.completion.chunk',
                'created': 1,
                'model': 'm',
                'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 5, 'completion_tokens': 1},
            },
        ]
        body = ''.join('data: %s\n\n' % json.dumps(chunk) for chunk in chunks) + 'data: [DONE]\n\n'
        self._send(body.encode('utf-8'), 'text/event-stream')


ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')


def at_prompt(text):
    """The readline prompt is `› ` followed by a cursor-position escape."""
    plain = ANSI_RE.sub('', text).replace('\r', '\n')
    lines = [line for line in plain.split('\n') if line.strip()]
    return bool(lines) and lines[-1].rstrip().endswith('\u203a')


def read_until_prompt(master, timeout, quiet=0.8):
    """Read until the REPL prompt is back.

    `quiet` is only a safety net for output that never re-prints the prompt: a
    prompt match returns immediately, so the probe is as fast as the CLI answers.
    """
    chunks = []
    text = ''
    deadline = time.time() + timeout
    last_output = time.time()
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            if chunks and time.time() - last_output > quiet:
                break
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
        text += chunk.decode('utf-8', 'replace')
        last_output = time.time()
        if at_prompt(text):
            break
    return text


def main():
    node_bin, cli_path, temp_root, commands_file = sys.argv[1:5]
    commands = json.load(open(commands_file, encoding='utf-8'))

    server = ThreadingHTTPServer(('127.0.0.1', 0), StubLLM)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    home = tempfile.mkdtemp(prefix='slash-home-', dir=temp_root)
    workspace = tempfile.mkdtemp(prefix='slash-workspace-', dir=temp_root)
    config_dir = os.path.join(home, 'config')
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, 'config.json'), 'w', encoding='utf-8') as handle:
        json.dump(
            {
                'provider': 'openai-compatible',
                'model': 'm',
                'baseUrl': 'http://127.0.0.1:%d/v1' % port,
                'apiKey': 'sk-test',
                'permissions': {'defaultMode': 'full'},
            },
            handle,
        )

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
        'MOSS_RUNTIME_DIR': os.path.join(home, 'runtime'),
    }

    master, slave = pty.openpty()
    proc = subprocess.Popen(
        [node_bin, cli_path],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        cwd=workspace,
        close_fds=True,
    )
    os.close(slave)

    results = {}
    try:
        boot = read_until_prompt(master, 25.0, quiet=8.0)
        if PROMPT.decode('utf-8') not in boot:
            print(json.dumps({'error': 'REPL prompt not detected', 'boot': boot[-1500:]}, ensure_ascii=False))
            return 1
        for command in commands:
            os.write(master, (command + '\n').encode('utf-8'))
            output = read_until_prompt(master, 15.0)
            plain = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', output).lower()
            if 'unknown command' in plain or 'did you mean' in plain:
                verdict = 'unknown'
            elif 'usage:' in plain:
                verdict = 'usage'
            else:
                verdict = 'ok'
            results[command] = verdict
    finally:
        try:
            os.write(master, b'\x03')
            time.sleep(0.2)
            os.write(master, b'/quit\n')
        except OSError:
            pass
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        try:
            os.close(master)
        except OSError:
            pass
        server.shutdown()

    unknown = sorted(name for name, verdict in results.items() if verdict == 'unknown')
    print(
        json.dumps(
            {'checked': len(results), 'unknown': unknown, 'verdicts': results},
            ensure_ascii=False,
        )
    )
    return 1 if unknown else 0


if __name__ == '__main__':
    sys.exit(main())
