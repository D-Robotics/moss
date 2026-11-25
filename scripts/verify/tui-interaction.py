#!/usr/bin/env python3
"""Real-PTY smoke for the TUI interaction features (stdlib only, no pyte).

Drives `dist/cli.js` through a pty against a local OpenAI-compatible stub and
matches the ANSI-stripped output stream. It proves the wiring the pure
projection checks cannot: that `/queue <text>` typed during a run really
lands in the queue, that the queued rows are painted, and that the queue
drains once the run ends.

Prints one JSON line: {"ok": true, "checks": N} or {"ok": false, "error": "..."}.
Exit 0 only when every check passed.
"""
import fcntl
import http.client
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NODE = sys.argv[1]
CLI = sys.argv[2]
COLS, ROWS = 100, 30
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
HOLD = threading.Event()

SSE_HEAD = 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Streaming a long answer."},"finish_reason":null}]}\n\n'
def sse_text(value):
    chunk = {
        "id": "x",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "m",
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": value}, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


SSE_DONE = (
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
    "data: [DONE]\n\n"
)


def last_user(messages):
    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content")
            return content if isinstance(content, str) else json.dumps(content)
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, body, content_type):
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(json.dumps({"data": [{"id": "m", "object": "model"}]}), "application/json")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        if self.path == "/__release":
            HOLD.set()
            self.reply("{}", "application/json")
            return
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}
        prompt = last_user(body.get("messages") or [])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        # Close-delimited: a body sent after a `Content-Length: 0` header is a
        # protocol error to the client, and every request then reads as a
        # provider outage.
        self.send_header("Connection", "close")
        self.end_headers()
        if "holdstream" in prompt:
            self.wfile.write(SSE_HEAD.encode())
            self.wfile.flush()
            HOLD.wait(30)
        else:
            # The answer names the prompt, so the probe can tell which queued
            # line really ran (the queued preview rows carry no answer).
            self.wfile.write(sse_text(f"Answer to: {prompt}").encode())
            self.wfile.flush()
        self.wfile.write(SSE_DONE.encode())
        self.wfile.flush()
        self.close_connection = True


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    home = tempfile.mkdtemp(prefix="moss-tui-interaction-home-")
    workspace = tempfile.mkdtemp(prefix="moss-tui-interaction-ws-")
    config_dir = os.path.join(home, "config")
    os.makedirs(config_dir)
    config = os.path.join(config_dir, "config.json")
    json.dump(
        {
            "provider": "openai-compatible",
            "model": "m",
            "baseUrl": f"http://127.0.0.1:{port}/v1",
            "apiKey": "sk-test",
            "permissions": {"defaultMode": "full"},
        },
        open(config, "w"),
    )
    env = {
        "PATH": os.environ["PATH"],
        "HOME": home,
        "MOSS_CONFIG_DIR": config_dir,
        "MOSS_CONFIG_FILE": config,
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "MOSS_NOTIFY": "0",
        "MOSS_NO_RDK_DOCS": "1",
        "MOSS_TRUST_WORKSPACE": "1",
        "MOSS_TUI_RENDERER": "fullscreen",
        "COLUMNS": str(COLS),
        "LINES": str(ROWS),
    }
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    proc = subprocess.Popen(
        [NODE, CLI], stdin=slave, stdout=slave, stderr=slave, env=env,
        cwd=os.path.realpath(workspace), preexec_fn=os.setsid,
    )
    os.close(slave)
    raw = bytearray()

    def pump(timeout):
        ready, _, _ = select.select([master], [], [], timeout)
        if not ready:
            return False
        try:
            data = os.read(master, 65536)
        except OSError:
            return False
        if not data:
            return False
        raw.extend(data)
        return True

    def text():
        return ANSI.sub("", raw.decode("utf-8", "replace"))

    def wait_for(needle, timeout, since=0):
        """Wait for `needle` in the stream written after offset `since`."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if needle in ANSI.sub("", raw[since:].decode("utf-8", "replace")):
                return True
            pump(0.1)
        return needle in ANSI.sub("", raw[since:].decode("utf-8", "replace"))

    def send(value):
        os.write(master, value.encode())

    def release():
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("POST", "/__release", "{}", {"content-type": "application/json"})
            conn.getresponse().read()
        finally:
            conn.close()

    checks = 0
    try:
        if not wait_for("❯", 20):
            raise AssertionError("the composer never appeared")
        send("holdstream\r")
        if not wait_for("Working", 15):
            raise AssertionError("the first prompt never started a run")
        checks += 1
        send("/queue second task\r")
        if not wait_for("queued 1. second task", 10):
            raise AssertionError("/queue <text> did not paint a queued row")
        checks += 1
        send("/queue third\r")
        if not wait_for("queued 2. third", 10):
            raise AssertionError("the second follow-up did not paint")
        checks += 1
        if not wait_for("Alt+↑ edits the newest", 10):
            raise AssertionError("the recall hint is missing")
        checks += 1
        before_release = len(raw)
        release()
        # Only the stream after the release counts: the queued preview rows
        # already carried both lines before it, so matching the whole stream
        # would pass even if the queue never drained.
        if not wait_for("Streaming a long answer.", 30, since=before_release):
            raise AssertionError("the held run did not finish with its answer")
        checks += 1
        if not wait_for("Answer to: second task", 30, since=before_release):
            raise AssertionError("the first queued line did not run after the run")
        checks += 1
        if not wait_for("Answer to: third", 30, since=before_release):
            raise AssertionError("the second queued line did not run")
        checks += 1
        print(json.dumps({"ok": True, "checks": checks}))
    except AssertionError as error:
        tail = re.sub(r"\s+", " ", text())[-400:]
        # MOSS_PROBE_DUMP=<path> keeps the whole stripped stream for debugging.
        if os.environ.get("MOSS_PROBE_DUMP"):
            with open(os.environ["MOSS_PROBE_DUMP"], "w") as handle:
                handle.write(raw.decode("utf-8", "replace"))
        print(json.dumps({"ok": False, "error": f"{error}; tail: {tail}"}))
        sys.exit(1)
    finally:
        try:
            os.write(master, b"\x03\x03")
        except OSError:
            pass
        time.sleep(0.2)
        try:
            proc.kill()
            proc.wait(timeout=5)
        except Exception:
            pass
        os.close(master)
        server.shutdown()
        import shutil

        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
