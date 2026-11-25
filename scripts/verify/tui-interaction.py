#!/usr/bin/env python3
"""Real-PTY smoke for the TUI interaction features (stdlib only, no pyte).

Drives `dist/cli.js` through a pty against a local OpenAI-compatible stub and
matches the ANSI-stripped output stream. It proves the wiring the pure
projection checks cannot: that `/queue <text>` typed during a run really
lands in the queue, that the queued rows are painted, and that the queue
drains once the run ends; that a key the user put in keybindings.json (Alt+R)
reaches the command through the same registry, and that `/hotkeys` paints the
key list with its problems; that `/copy` puts the newest answer on both
clipboard routes (the OSC 52 write and the session's clipboard tool, a
stand-in here), reports a tool that fails by name and copies again once it
works, and on Linux says when the session has no tool at all; and that Ctrl+F
opens a transcript search whose typing, stepping, resuming and closing all
reach the real screen; that several Enter-terminated lines reaching the app
in one read each count as an Enter (two commands both print in order, two
prompts run one after the other, text after the last Enter stays a draft);
and that `/thinking` and Alt+T set a level that the
next request really carries (the stub names it), while `/session`,
`/changelog` and `/debug` print or write what they say.

The PTY is not a terminal emulator: nothing answers the kitty keyboard query,
so every key here is the legacy byte sequence a plain xterm would send.

Prints one JSON line: {"ok": true, "checks": N} or {"ok": false, "error": "..."}.
Exit 0 only when every check passed.
"""
import base64
import fcntl
import glob
import http.client
import json
import os
import pty
import re
import select
import signal
import stat
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
LINUX = sys.platform.startswith("linux")
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")
HOLD = threading.Event()
# Two prompts sent in one write must run one after the other. The stub holds
# the first one's answer open for a moment and counts the requests of that
# kind in flight: a second turn started beside it would send its request
# inside that window, which is what `overlap` records.
INFLIGHT = {"count": 0}
OVERLAP = {"seen": False}

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


# A transcript search is only proven by hits that start off screen: sixty
# paragraphs, three carrying a needle (same shape as scripts/tui-feel/stub.mjs).
SEARCHMARK = [
    f"Paragraph {number:02d} of the search transcript. "
    + ("Here is the needle." if number in (4, 24, 34) else "Nothing to see here.")
    for number in range(1, 61)
]


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
        if self.path == "/__stats":
            self.reply(json.dumps({"overlap": OVERLAP["seen"]}), "application/json")
            return
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
        counted = False
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
            if "searchmark" in prompt:
                for index, paragraph in enumerate(SEARCHMARK):
                    self.wfile.write(sse_text(("" if index == 0 else "\n\n") + paragraph).encode())
                    self.wfile.flush()
                    time.sleep(0.01)
            elif "probe-reasoning" in prompt:
                # The answer names the reasoning level this request carried, so
                # the probe can read off the wire what `/thinking` chose.
                effort = body.get("reasoning_effort")
                self.wfile.write(
                    sse_text(f"Answer to: probe-reasoning effort={effort if effort is not None else 'unset'}").encode()
                )
                self.wfile.flush()
            elif "batchline-" in prompt:
                # The answer names the prompt's marker, so each line of a
                # batched write is told apart however long the prompt is.
                named = re.search(r"batchline-\w+", prompt).group(0)
                INFLIGHT["count"] += 1
                counted = True
                if INFLIGHT["count"] > 1:
                    OVERLAP["seen"] = True
                self.wfile.write(sse_text(f"Answer to: {named}").encode())
                self.wfile.flush()
                if named == "batchline-one":
                    # Held open long enough for a turn started beside it to
                    # reach the server.
                    time.sleep(2)
            else:
                self.wfile.write(sse_text(f"Answer to: {prompt}").encode())
                self.wfile.flush()
        self.wfile.write(SSE_DONE.encode())
        self.wfile.flush()
        if counted:
            INFLIGHT["count"] -= 1
        self.close_connection = True


def copy_without_clipboard_tool(env, workspace):
    """A second session with `env`, one answer, then `/copy`. Returns the
    status the shell reported and what its OSC 52 write decoded to."""
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    proc = subprocess.Popen(
        [NODE, CLI], stdin=slave, stdout=slave, stderr=slave, env=env,
        cwd=os.path.realpath(workspace), preexec_fn=os.setsid,
    )
    os.close(slave)
    raw = bytearray()
    try:
        def wait(needle):
            deadline = time.time() + 20
            while time.time() < deadline:
                if needle in ANSI.sub("", raw.decode("utf-8", "replace")):
                    return True
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        raw.extend(os.read(master, 65536))
                    except OSError:
                        return False
            return False

        if not wait("❯"):
            return "the shell did not start", None
        os.write(master, b"hi\r")
        if not wait("Answer to: hi"):
            return "the stub did not answer", None
        raw.clear()
        os.write(master, b"/copy\r")
        notice = "sent to the terminal (OSC 52); this session has no clipboard tool"
        if not wait(notice):
            return None, None
        osc = re.search(rb"\x1b\]52;c;([A-Za-z0-9+/=]+)\x07", bytes(raw))
        decoded = base64.b64decode(osc.group(1)).decode("utf-8") if osc else None
        return notice, decoded
    finally:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
        os.close(master)


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
    # A second key for history.search (the probe presses Alt+R) and one the
    # composer keeps, so /hotkeys has a problem to report.
    json.dump({"history.search": ["ctrl+r", "alt+r"], "draft.stash": "enter"},
              open(os.path.join(config_dir, "keybindings.json"), "w"))
    # Stand-ins for the session's clipboard tools (`pbcopy` on macOS, the X11
    # tools on Linux), first on PATH: the probe must not touch the developer's
    # clipboard, and their file shows what the native path got. Each exits 3
    # for as long as `clipboard-fail` exists.
    bin_dir = os.path.join(home, "bin")
    os.makedirs(bin_dir)
    clipboard = os.path.join(home, "clipboard.txt")
    clipboard_fail = os.path.join(home, "clipboard-fail")
    for tool in ("pbcopy", "xclip", "xsel"):
        stand_in = os.path.join(bin_dir, tool)
        with open(stand_in, "w") as handle:
            handle.write(f"#!/bin/sh\n[ -e '{clipboard_fail}' ] && exit 3\ncat > '{clipboard}'\n")
        os.chmod(stand_in, 0o755)
    env = {
        "PATH": bin_dir + os.pathsep + os.environ["PATH"],
        "HOME": home,
        "MOSS_CONFIG_DIR": config_dir,
        "MOSS_CONFIG_FILE": config,
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "MOSS_NOTIFY": "0",
        "MOSS_NO_RDK_DOCS": "1",
        # The intent judge is on by default and calls a network service before
        # and after a turn. This probe is about the keyboard: keep every turn
        # offline and the same length.
        "MOSS_JEV_ENABLED": "0",
        "MOSS_TRUST_WORKSPACE": "1",
        "MOSS_TUI_RENDERER": "fullscreen",
        "COLUMNS": str(COLS),
        "LINES": str(ROWS),
    }
    if LINUX:
        # Linux picks its tools from the session's display variables.
        env["DISPLAY"] = ":0"
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

    def wait_match(pattern, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if re.search(pattern, text()):
                return True
            pump(0.1)
        return re.search(pattern, text()) is not None

    def send(value):
        os.write(master, value.encode())

    def runs(since):
        """`(text, attributes)` for what was written after offset `since`.
        Attributes are tracked across the separate sequences the renderer
        emits (`ESC[7m ESC[1m answer ESC[22m ESC[27m`)."""
        out = []
        active = set()
        stream = raw[since:].decode("utf-8", "replace")
        tokens = re.finditer(r"\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|([^\x1b]+)", stream)
        for token in tokens:
            if token.group(1) is not None:
                for value in token.group(1).split(";"):
                    code = int(value) if value else 0
                    if code == 0:
                        active.clear()
                    elif code == 22:
                        active -= {1, 2}
                    elif code in (23, 24, 27, 29):
                        active.discard({23: 3, 24: 4, 27: 7, 29: 9}[code])
                    else:
                        active.add(code)
            elif token.group(2):
                out.append((token.group(2), frozenset(active)))
        return out

    def painted(sgr, since):
        """Text printed while SGR attribute `sgr` (7 = inverse, 4 = underline)
        is active, in the stream written after offset `since`."""
        return "".join(value for value, attrs in runs(since) if sgr in attrs)

    def query_selected(since, query):
        """True when the bar shows `query` after `⌕ ` with inverse on, as a
        resumed query is; a query painted in the glyph's own run is not."""
        seen = runs(since)
        for index, (value, _) in enumerate(seen):
            if not value.startswith("⌕"):
                continue
            if query in value:
                return False
            return any(query in text and 7 in attrs for text, attrs in seen[index + 1 : index + 4])
        return False

    def search_position(since, exclude=None):
        """The `n of 3` the bar painted after `since`, skipping `exclude`."""
        stream = ANSI.sub("", raw[since:].decode("utf-8", "replace"))
        found = re.findall(r"(\d) of 3", stream)
        for value in reversed(found):
            if value != exclude:
                return value
        return None

    def wait_position(since, exclude, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = search_position(since, exclude)
            if found is not None:
                return found
            pump(0.1)
        return search_position(since, exclude)

    def release():
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("POST", "/__release", "{}", {"content-type": "application/json"})
            conn.getresponse().read()
        finally:
            conn.close()

    def stats():
        """What the stub noticed about the requests it served."""
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("GET", "/__stats")
            return json.loads(conn.getresponse().read())
        finally:
            conn.close()

    checks = 0
    try:
        if not wait_for("❯", 20):
            raise AssertionError("the composer never appeared")
        send("/copy\r")
        if not wait_for("no answer to copy yet", 10):
            raise AssertionError("/copy before the first answer did not say so")
        checks += 1
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
        # The row clips at the terminal width, so it leads with the pointer.
        if not wait_for("1 keybinding problem — /hotkeys", 10):
            raise AssertionError("the keybinding notice never reached the screen")
        checks += 1
        # Alt+R is bound to history.search only by keybindings.json above.
        send("\x1br")
        if not wait_for("⌕", 10):
            raise AssertionError("Alt+R (a user binding) did not open the prompt search")
        checks += 1
        send("\x1b")
        time.sleep(0.4)
        send("/hotkeys\r")
        if not wait_for("Keys · Esc to close", 10):
            raise AssertionError("/hotkeys did not open the key list")
        checks += 1
        if not wait_match(r"Ctrl\+R / Alt\+R\s+search your earlier prompts", 10):
            raise AssertionError("/hotkeys does not list both keys of history.search")
        checks += 1
        if not wait_match(r"Alt\+↑\s+edit the newest queued message", 10):
            raise AssertionError("/hotkeys does not list the Alt+↑ default")
        checks += 1
        if not wait_match(r"problems\s+keybindings\.json: \"enter\" for draft\.stash is a key the composer already answers", 10):
            raise AssertionError("/hotkeys does not show the keybinding problem")
        checks += 1
        send("\x1b")
        time.sleep(0.4)
        # The newest answer is the last queued line's. Both clipboard paths
        # must carry exactly that text.
        send("/copy\r")
        if not wait_for("copied the last answer (16 chars)", 10):
            raise AssertionError("/copy did not report the newest answer")
        checks += 1
        osc = re.search(r"\x1b\]52;c;([A-Za-z0-9+/=]+)\x07", raw.decode("utf-8", "replace"))
        if not osc or base64.b64decode(osc.group(1)).decode("utf-8") != "Answer to: third":
            raise AssertionError("the OSC 52 write did not carry the newest answer")
        checks += 1
        # The native path is spawned, not awaited. The stand-in's file exists,
        # empty, from the moment its shell opens it: wait for content.
        native = None
        deadline = time.time() + 5
        while time.time() < deadline:
            if os.path.exists(clipboard):
                with open(clipboard, encoding="utf-8") as handle:
                    native = handle.read()
                if native:
                    break
            time.sleep(0.1)
        if native != "Answer to: third":
            raise AssertionError(f"the clipboard tool received {native!r}")
        checks += 1
        # A tool that exits non-zero is reported as failed, by name: never as
        # "copied". With the cause gone, the next copy is a copy again.
        # Linux tries xclip first, and the report names it, not the xsel after.
        failing = "pbcopy" if sys.platform == "darwin" else "xclip"
        open(clipboard_fail, "w").close()
        mark = len(raw)
        send("/copy\r")
        failed = f"{failing} failed (exit 3); the text also went to the terminal (OSC 52)"
        if not wait_for(failed, 10, mark):
            raise AssertionError("/copy did not report the clipboard tool that failed")
        checks += 1
        os.remove(clipboard_fail)
        mark = len(raw)
        send("/copy\r")
        if not wait_for("copied the last answer (16 chars)", 10, mark):
            raise AssertionError("/copy did not copy again after the tool recovered")
        checks += 1
        if LINUX:
            # A session without a display has no clipboard tool at all. The
            # text still goes to the terminal, and the status says so.
            without = dict(env)
            without.pop("DISPLAY")
            # The stand-ins write this file when they run. It is gone before the
            # session starts, so its presence afterwards would mean a tool ran.
            os.remove(clipboard)
            notice, osc_text = copy_without_clipboard_tool(without, workspace)
            if notice != "sent to the terminal (OSC 52); this session has no clipboard tool":
                raise AssertionError(f"/copy without a clipboard tool said {notice!r}")
            checks += 1
            # The stub answers with the whole prompt it was sent, and the first
            # turn's prompt ends with the session's injected <turn-context>
            # block. The copy is that answer, so it starts with these words.
            if not (osc_text or "").startswith("Answer to: hi"):
                raise AssertionError(f"without a tool the OSC 52 write carried {osc_text[:60]!r}")
            checks += 1
            if os.path.exists(clipboard):
                raise AssertionError("a session without a clipboard tool ran one")
            checks += 1
        # ── transcript search ──
        # The transcript holds three answers: "Streaming a long answer.", then
        # the two queued ones. The prompt search prints the same glyph, so the
        # bar is recognised by its own hint row.
        def stream_since(since):
            return ANSI.sub("", raw[since:].decode("utf-8", "replace"))

        def next_of(value):
            return str(int(value) % 3 + 1)

        def previous_of(value):
            return str((int(value) - 2) % 3 + 1)

        current = [None]

        def step(key_bytes, expect_of):
            """Press a key and wait for the bar to move to the expected hit."""
            nonlocal checks
            since = len(raw)
            send(key_bytes)
            expect = expect_of(current[0])
            found = wait_position(since, current[0])
            if found != expect:
                raise AssertionError(
                    f"{key_bytes!r} went from hit {current[0]} to {found}, expected {expect}"
                )
            current[0] = expect
            checks += 1

        before = len(raw)
        send("\x06")
        if not wait_for("type to search", 10, since=before):
            raise AssertionError("Ctrl+F did not open the transcript search")
        checks += 1

        before = len(raw)
        send("answer")
        first = wait_position(before, None)
        if first is None or not wait_for(" of 3", 5, since=before):
            raise AssertionError("typing with the bar open did not count three hits")
        current[0] = first
        checks += 1
        # The hit the reader is on is inverted, the other two are underlined.
        if not re.search(r"[Aa]nswer", painted(7, before)):
            raise AssertionError("the current hit is not inverted")
        if not re.search(r"nswer", painted(4, before)):
            raise AssertionError("the other hits are not underlined")
        checks += 1

        step("\r", next_of)
        step("\x1b[B", next_of)
        step("\x1b[A", previous_of)
        # Shift+Enter, as the terminals that report it send it.
        step("\x1b[13;2u", previous_of)

        # Esc closes the bar; a letter is composer text again.
        send("\x1b")
        time.sleep(0.5)
        before = len(raw)
        send("x")
        deadline = time.time() + 10
        while time.time() < deadline and not re.search(r"❯\s*x", stream_since(before)):
            pump(0.1)
        if not re.search(r"❯\s*x", stream_since(before)):
            raise AssertionError("after Esc a letter did not reach the composer")
        if "⌕ answerx" in stream_since(before):
            raise AssertionError("the closed bar still took the letter")
        checks += 1
        send("\x15")  # Ctrl+U clears the composer
        time.sleep(0.3)

        # Ctrl+F again resumes the query on the hit it was left on, selected.
        before = len(raw)
        send("\x06")
        if not wait_for("⌕ answer", 10, since=before):
            raise AssertionError("Ctrl+F did not resume the earlier query")
        if wait_position(before, None) != current[0]:
            raise AssertionError("the resumed search is not on the hit it was left on")
        checks += 1
        # Selected text is shown inverted: the query, not the glyph.
        deadline = time.time() + 5
        while time.time() < deadline and not query_selected(before, "answer"):
            pump(0.1)
        if not query_selected(before, "answer"):
            raise AssertionError("the resumed query is not shown selected")
        if not wait_for("type to replace", 10, since=before):
            raise AssertionError("the hint does not say that typing replaces a selected query")
        checks += 1

        # Backspace clears a selected query.
        before = len(raw)
        send("\x7f")
        if not wait_for("type to search", 10, since=before):
            raise AssertionError("Backspace did not clear the selected query")
        checks += 1
        # A new query can be typed; Ctrl+U clears it.
        before = len(raw)
        send("answer")
        if not wait_position(before, None):
            raise AssertionError("a new query did not count its hits")
        checks += 1
        before = len(raw)
        send("\x15")
        if not wait_for("type to search", 10, since=before):
            raise AssertionError("Ctrl+U did not clear the query")
        checks += 1
        # With the query selected, typing replaces it instead of appending.
        before = len(raw)
        send("\x06")
        wait_for("⌕ answer", 10, since=before)
        before = len(raw)
        send("zz")
        if not wait_for("⌕ zz", 10, since=before) or "answerzz" in stream_since(before):
            raise AssertionError("typing did not replace the selected query")
        if not wait_for("no match", 10, since=before):
            raise AssertionError("a query without hits did not say so")
        checks += 1

        # A bracketed paste goes to the open bar on one line: the line break
        # becomes a space and a control character is dropped. The state row
        # is not repainted, as `no match` was already showing.
        before = len(raw)
        send("\x1b[200~ answer zz\nq\x00q\x1b[201~")
        if not wait_for("⌕ zz answer zz qq", 10, since=before):
            raise AssertionError("a paste did not reach the open bar on one line")
        if b"\x00" in raw[before:]:
            raise AssertionError("a pasted control character reached the terminal")
        checks += 1
        send("\x1b")
        time.sleep(0.4)

        # ── a hit that starts off screen ──
        # Everything above sits on one screen, so it cannot tell whether the
        # view moved. Here the needle is on paragraphs 4, 24 and 34 of sixty
        # and the view is at the bottom: only a real jump brings it back.
        # The view stayed on the hit, so the new turn is appended below the
        # window: go back to the bottom first, as a reader would.
        send("\x1b[F")
        time.sleep(0.3)
        before = len(raw)
        send("searchmark")
        if not wait_for("❯ searchmark", 10, since=before):
            raise AssertionError("typing after the search did not reach the composer")
        send("\r")
        if not wait_for("Paragraph 60", 30, since=before):
            raise AssertionError("the long answer never finished")
        checks += 1
        before = len(raw)
        send("\x06")
        # One key per read: a ctrl key that shares a read with the next
        # keystroke is dropped by the input layer, terminal or probe. The bar
        # resumes the last query, selected.
        if not wait_for("⌕ zz answer zz qq", 10, since=before):
            raise AssertionError("Ctrl+F did not resume the search after a long answer")
        before = len(raw)
        # Typing replaces the selected query.
        send("needle")
        if not wait_for("Paragraph 04 of the search transcript.", 10, since=before):
            raise AssertionError("the view did not jump to the off-screen hit")
        checks += 1
        # From the bottom of the transcript the search wraps to the first hit,
        # not to the nearest one above.
        # The jump is painted before the bar that says where it landed.
        if wait_position(before, None) != "1":
            raise AssertionError(
                f"from the bottom the search started at hit {search_position(before, None)} of 3"
            )
        checks += 1
        if not re.search(r"^needle$", painted(7, before)):
            raise AssertionError("the off-screen hit is not the one inverted once shown")
        checks += 1
        before = len(raw)
        send("\r")
        if not wait_for("Paragraph 24 of the search transcript.", 10, since=before):
            raise AssertionError("Enter did not bring the next off-screen hit into view")
        checks += 1
        if wait_position(before, "1") != "2":
            raise AssertionError("the bar did not move to the second hit")
        checks += 1
        send("\x1b")
        time.sleep(0.4)
        # The search left the view on an earlier hit. Go back to the bottom, as
        # a reader would, so what the next commands print is on screen.
        send("\x1b[F")
        time.sleep(0.4)

        # ── thinking level, /session, /changelog, /debug ──
        def hint_row(since=0):
            """The text before the newest `? for shortcuts` of the frames
            written after `since`: the prompt line's hint row, without its tail."""
            stream = stream_since(since)
            at = stream.rfind("? for shortcuts")
            return "" if at < 0 else stream[max(0, at - 80) : at]

        def wait_hint(needle, timeout=10, absent=False):
            """True once the newest hint row has `needle` (or has lost it).
            A frame is painted in parts: the command block comes before the
            prompt line, so the row is polled, not read once."""
            deadline = time.time() + timeout
            while time.time() < deadline:
                row = hint_row()
                if (needle not in row) if absent else (needle in row):
                    return True
                pump(0.1)
            return False

        def wait_done(since, answer, timeout=30):
            """True once the turn that printed `answer` after `since` has
            settled. The transcript prints `worked for` only when a turn ends,
            but the previous footer stays in the repainted part of the screen
            and is written again as soon as the next block starts, so the one
            that counts is the first footer after this turn's answer. Keys sent
            before then are steering for the turn still running, not a prompt
            of their own."""
            deadline = time.time() + timeout
            while time.time() < deadline:
                stream = stream_since(since)
                at = stream.rfind(answer)
                if at >= 0 and "worked for" in stream[at:]:
                    return True
                pump(0.1)
            return False

        def flow(sentence):
            """The sentence as a pattern that survives a wrap between words."""
            return r"\s+".join(re.escape(word) for word in sentence.split())

        def wait_match_since(pattern, since, timeout=10):
            """True once `pattern` is in the stream written after offset `since`.
            `wait_match` reads the whole stream, where an earlier block can
            already hold the same words."""
            deadline = time.time() + timeout
            while time.time() < deadline:
                if re.search(pattern, ANSI.sub("", raw[since:].decode("utf-8", "replace"))):
                    return True
                pump(0.1)
            return False

        # The renderer wraps each frame in synchronized output; the closing
        # sequence is what says the frame is complete.
        END_OF_FRAME = "\x1b[?2026l"
        # Opening rows of the `/usage` and `/session` blocks.
        USAGE_BLOCK = r"tokens\s+\d+\s+session\s+·"
        SESSION_BLOCK = r"Session\s+id\s+\S+\s+workspace"

        def frame_finished(marker, since=0):
            """True once the frame that painted `marker` after offset `since`
            has ended. The prompt rows are repainted only when their text
            changed, so the sight of them is no signal; keys sent before the
            frame ends are dropped. Without `since` the newest `marker` in the
            whole stream counts, which an earlier block with the same words
            satisfies before the new one is painted."""
            stream = ANSI.sub(
                "", raw[since:].decode("utf-8", "replace").replace(END_OF_FRAME, "\x00")
            )
            at = stream.rfind(marker)
            return at >= 0 and stream.rfind("\x00") > at

        def wait_frame(marker, timeout=10, since=0):
            deadline = time.time() + timeout
            while time.time() < deadline:
                if frame_finished(marker, since):
                    return True
                pump(0.1)
            return frame_finished(marker, since)

        def stream_text(since):
            return ANSI.sub("", raw[since:].decode("utf-8", "replace"))

        # ── several Enter-terminated lines in one read ──
        # Ink does not split a chunk at a bare CR/LF, so two lines that reach
        # the app in one read arrive as a single key event. Every terminator is
        # an Enter in typing order: no line is dropped, reordered or merged.
        before = len(raw)
        send("/usage\r/session\r")
        if not wait_match_since(USAGE_BLOCK, before, 10):
            raise AssertionError("the first of two commands sent in one write was dropped")
        if not wait_match_since(SESSION_BLOCK, before, 10):
            raise AssertionError("the second of two commands sent in one write was dropped")
        if not wait_frame("workspace", since=before):
            raise AssertionError("the prompt line did not come back after two batched commands")
        written = stream_text(before)
        if re.search(USAGE_BLOCK, written).start() > re.search(SESSION_BLOCK, written).start():
            raise AssertionError("two commands sent in one write ran out of order")
        checks += 1
        # Two prompts in one write run as two turns, the second after the first.
        # The stub holds the first answer open and reports a request of the
        # second kind arriving inside that window.
        before = len(raw)
        send("batchline-one\rbatchline-two\r")
        if not wait_match_since(r"Answer to: batchline-one", before, 30):
            raise AssertionError("the first of two prompts sent in one write was dropped")
        if not wait_match_since(r"Answer to: batchline-two", before, 30):
            raise AssertionError("the second of two prompts sent in one write was dropped")
        if not wait_done(before, "Answer to: batchline-two"):
            raise AssertionError("the second batched prompt did not settle")
        if stats()["overlap"]:
            raise AssertionError("two prompts sent in one write ran as turns side by side")
        if not re.search(
            r"Answer to: batchline-one.*?worked for \d+s · done.*?Answer to: batchline-two",
            stream_text(before),
            re.S,
        ):
            raise AssertionError("the second batched prompt did not wait for the first to end")
        checks += 1
        # Text after the last Enter is the next draft, sent by the next Enter.
        before = len(raw)
        send("/usage\rbatchline-tail")
        if not wait_match_since(USAGE_BLOCK, before, 10):
            raise AssertionError("a command followed by unsubmitted text in one write did not run")
        if not wait_match_since(r"❯\s+batchline-tail", before, 10):
            raise AssertionError("the text after the last Enter was not kept in the composer")
        if not wait_frame("· api ", since=before):
            raise AssertionError("the prompt line did not come back after the batched write")
        settle_until = time.time() + 1
        while time.time() < settle_until:
            pump(0.1)
        if "Answer to: batchline-tail" in stream_text(before):
            raise AssertionError("text after the last Enter was sent without an Enter")
        before = len(raw)
        send("\r")
        if not wait_match_since(r"Answer to: batchline-tail", before, 30):
            raise AssertionError("the Enter after the kept draft did not send it")
        if not wait_done(before, "Answer to: batchline-tail"):
            raise AssertionError("the turn for the kept draft did not settle")
        checks += 1

        send("/thinking\r")
        if not wait_for("thinking: model default", 10):
            raise AssertionError("/thinking did not show the level in effect")
        checks += 1
        # Alt+T walks Pi's seven levels in Pi's order and wraps to `off`.
        for level in ("off", "minimal", "low", "medium", "high", "xhigh", "max", "off"):
            before = len(raw)
            send("\x1bt")
            if not wait_for(f"thinking: {level} (this session)", 10, since=before):
                raise AssertionError(f"Alt+T did not cycle the level to {level}")
        checks += 1
        # A level the word does not name is refused, and the level stays.
        send("/thinking sideways\r")
        if not wait_for('unknown level "sideways"', 10):
            raise AssertionError("/thinking accepted a word that names no level")
        if not wait_hint("thinking:off"):
            raise AssertionError("the prompt line does not show the level Alt+T stopped on")
        checks += 1
        send("/thinking high\r")
        if not wait_for("thinking: high (this session) from the next turn.", 10):
            raise AssertionError("/thinking high did not confirm the new level")
        if not wait_hint("thinking:high"):
            raise AssertionError("the prompt line does not show the level /thinking chose")
        checks += 1
        # The level reaches the request, not only the screen.
        before = len(raw)
        send("probe-reasoning\r")
        if not wait_for("effort=high", 30, since=before):
            raise AssertionError("the level chosen with /thinking did not reach the request")
        if not wait_done(before, "effort=high"):
            raise AssertionError("the first probe turn did not settle")
        checks += 1
        # Only the stream after the send counts: a later `/thinking default`
        # would otherwise match this block the moment it is typed.
        before = len(raw)
        send("/thinking default\r")
        if not wait_for("thinking follows the config again", 10, since=before):
            raise AssertionError("/thinking default did not hand the level back to the config")
        if not wait_frame("thinking follows the config again", since=before):
            raise AssertionError("the prompt line did not come back after /thinking default")
        if not wait_hint("thinking:", absent=True):
            raise AssertionError("the prompt line still shows a level after /thinking default")
        checks += 1
        before = len(raw)
        send("probe-reasoning\r")
        if not wait_for("effort=unset", 30, since=before):
            raise AssertionError("a request still carried a level after /thinking default")
        if not wait_done(before, "effort=unset"):
            raise AssertionError("the second probe turn did not settle")
        checks += 1
        # `off` is a level of its own on the OpenAI-compatible wire.
        send("/thinking off\r")
        if not wait_for("thinking: off (this session) from the next turn.", 10):
            raise AssertionError("/thinking off did not confirm the level")
        before = len(raw)
        send("probe-reasoning\r")
        if not wait_for("effort=none", 30, since=before):
            raise AssertionError("the level off did not reach the request as `none`")
        if not wait_done(before, "effort=none"):
            raise AssertionError("the third probe turn did not settle")
        checks += 1
        # The first `/thinking default` block is still in the stream with the
        # same words. Without `since` both waits below passed on that block
        # before this one was painted, and `/session` was typed into the same
        # read as `/thinking default`.
        before = len(raw)
        send("/thinking default\r")
        if not wait_for("thinking follows the config again", 10, since=before):
            raise AssertionError("/thinking default did not hand the level back a second time")
        if not wait_frame("thinking follows the config again", since=before):
            raise AssertionError("the prompt line did not come back after /thinking default")
        # The workspace path sits close to the row's width, so it may wrap.
        before = len(raw)
        send("/session\r")
        if not wait_match_since(
            r"Session\s+id\s+\S+\s+workspace\s+\S+(?:\s+\S+)?\s+model\s+m\s+messages\s+[1-9]\d*",
            before,
            10,
        ):
            raise AssertionError("/session did not print the session's id, model and message count")
        if not wait_match_since(
            r"model calls\s+[1-9]\d*\s+input\s+[\d,]+ tokens\s+output\s+[\d,]+ tokens", before, 10
        ):
            raise AssertionError("/session did not print the model calls and their tokens")
        if not wait_frame("cost: unpriced", since=before):
            raise AssertionError("the prompt line did not come back after /session")
        checks += 1
        send("/changelog\r")
        # A full-screen renderer paints only what fits the viewport: on 30 rows
        # the top of a 24-line block is above it. The closing note is the part
        # in view; the excerpt itself is asserted by command-extras.mjs.
        if not wait_for("more line(s) in CHANGELOG.md", 10):
            raise AssertionError("/changelog did not print the top of the changelog")
        if not wait_frame("more line(s) in CHANGELOG.md"):
            raise AssertionError("the prompt line did not come back after /changelog")
        checks += 1
        # `/usage` is this shell's own block, counted by the same events as the
        # status row. Its total has to be the sum of what came in and went out.
        before = len(raw)
        send("/usage\r")
        if not wait_match_since(r"Usage\s+tokens \d+ session · ↑ \d+ in · ↓ \d+ out", before):
            raise AssertionError("/usage did not print the session's tokens")
        counted = re.search(r"tokens (\d+) session · ↑ (\d+) in · ↓ (\d+) out", text())
        if int(counted.group(1)) != int(counted.group(2)) + int(counted.group(3)):
            raise AssertionError("/usage tokens do not add up to its input and output")
        if not wait_frame("cost: unpriced"):
            raise AssertionError("the prompt line did not come back after /usage")
        checks += 1
        # `/debug` writes the session and the screen; the file is the user's own.
        # On this width its path and its warning both wrap, so they are
        # matched word by word.
        before = len(raw)
        send("/debug\r")
        if not wait_match_since(
            flow("Debug wrote")
            + r"\s+\S+[\s\S]*?moss-debug-[\w.-]+\.log \(\d+ messages, \d+ screen lines\)\.",
            before,
        ):
            raise AssertionError("/debug did not report the file it wrote")
        if not wait_match_since(
            flow("Review it before sharing: it can hold prompts, tool output and file contents."),
            before,
        ):
            raise AssertionError("/debug did not say the file can hold private content")
        if not wait_frame("file contents."):
            raise AssertionError("the prompt line did not come back after /debug")
        checks += 1
        # `/clear` starts a new session. The status row and `/usage` zero their
        # counters there, so `/session` must not keep counting the previous one.
        before = len(raw)
        send("/clear\r")
        if not wait_for("transcript cleared", 10, since=before):
            raise AssertionError("/clear did not run")
        if not wait_frame("transcript cleared"):
            raise AssertionError("the prompt line did not come back after /clear")
        before = len(raw)
        send("/session\r")
        if not wait_for("no model calls yet.", 10, since=before):
            raise AssertionError("/session kept the usage of the session /clear ended")
        if not wait_frame("no model calls yet."):
            raise AssertionError("the prompt line did not come back after /session")
        checks += 1
        logs = glob.glob(os.path.join(config_dir, "debug", "moss-debug-*.log"))
        if len(logs) != 1:
            raise AssertionError(f"/debug left {len(logs)} file(s), expected one")
        with open(logs[0], encoding="utf-8") as handle:
            debug_text = handle.read()
        for needle in ("== session messages (", "probe-reasoning", "== screen lines ("):
            if needle not in debug_text:
                raise AssertionError(f"the /debug file has no {needle!r}")
        if stat.S_IMODE(os.stat(logs[0]).st_mode) != 0o600:
            raise AssertionError("the /debug file is readable by other users")
        checks += 1
        send("\x1b")
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
