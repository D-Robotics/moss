#!/usr/bin/env python3
"""`/todos` end-to-end: a real turn writes a checklist, then the REPL shows it.

Claude Code surfaces the task list so a long refactor can be inspected without
scrolling; Moss's TUI already draws a live todo panel, but the REPL had no way to
see the checklist at all, and re-reading the session store lags a running turn.
This probe drives a real REPL against a stub that answers the first request with
a `todo_write` tool call, then types `/todos` and checks the rendered list.

Usage: todos-view.py <node-binary> <cli-entry> <temp-root>
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

PROMPT = '\u203a'
ANSI_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
TODO_ARGS = json.dumps(
    {
        'todos': [
            {'content': 'audit the loader', 'status': 'completed'},
            {'content': 'refactor the parser', 'status': 'in_progress'},
            {'content': 'run the verifier', 'status': 'pending'},
        ]
    }
)


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
        raw = self.rfile.read(length).decode('utf-8', 'replace')
        tool_ran = '"role":"tool"' in raw.replace(' ', '') or '"role": "tool"' in raw
        if not tool_ran:
            chunks = [
                {
                    'id': 'x',
                    'object': 'chat.completion.chunk',
                    'created': 1,
                    'model': 'm',
                    'choices': [
                        {
                            'index': 0,
                            'delta': {
                                'role': 'assistant',
                                'tool_calls': [
                                    {
                                        'index': 0,
                                        'id': 'call_1',
                                        'type': 'function',
                                        'function': {'name': 'todo_write', 'arguments': TODO_ARGS},
                                    }
                                ],
                            },
                            'finish_reason': None,
                        }
                    ],
                },
                {
                    'id': 'x',
                    'object': 'chat.completion.chunk',
                    'created': 1,
                    'model': 'm',
                    'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}],
                    'usage': {'prompt_tokens': 5, 'completion_tokens': 5},
                },
            ]
        else:
            chunks = [
                {
                    'id': 'x',
                    'object': 'chat.completion.chunk',
                    'created': 1,
                    'model': 'm',
                    'choices': [
                        {
                            'index': 0,
                            'delta': {'role': 'assistant', 'content': 'checklist written'},
                            'finish_reason': None,
                        }
                    ],
                },
                {
                    'id': 'x',
                    'object': 'chat.completion.chunk',
                    'created': 1,
                    'model': 'm',
                    'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 8, 'completion_tokens': 2},
                },
            ]
        body = ''.join('data: %s\n\n' % json.dumps(chunk) for chunk in chunks) + 'data: [DONE]\n\n'
        self._send(body.encode('utf-8'), 'text/event-stream')


def read_until_prompt(master, timeout, quiet=1.0):
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
        plain = ANSI_RE.sub('', text).replace('\r', '\n')
        lines = [line for line in plain.split('\n') if line.strip()]
        if lines and lines[-1].rstrip().endswith(PROMPT):
            break
    return text


def main():
    node_bin, cli_path, temp_root = sys.argv[1:4]
    server = ThreadingHTTPServer(('127.0.0.1', 0), StubLLM)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    home = tempfile.mkdtemp(prefix='todos-home-', dir=temp_root)
    workspace = tempfile.mkdtemp(prefix='todos-workspace-', dir=temp_root)
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
        'MOSS_LANG': 'en',
        'MOSS_CONFIG_DIR': config_dir,
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
    output = ''
    try:
        boot = read_until_prompt(master, 25.0, quiet=10.0)
        if PROMPT not in boot:
            print(json.dumps({'error': 'REPL prompt not detected', 'boot': boot[-1200:]}))
            return 1
        os.write(master, b'plan the refactor\n')
        read_until_prompt(master, 30.0)
        os.write(master, b'/todos\n')
        output = read_until_prompt(master, 20.0)
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

    plain = ANSI_RE.sub('', output)
    checks = {
        'header': 'Checklist 1/3 done' in plain,
        'completed': '\u2713 audit the loader' in plain,
        'in_progress': '\u25d0 refactor the parser (in progress)' in plain,
        'pending': '\u25cb run the verifier' in plain,
    }
    failed = [name for name, ok in checks.items() if not ok]
    print(json.dumps({'checks': checks, 'output': plain[-900:]}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
