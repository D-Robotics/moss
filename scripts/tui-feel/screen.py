"""Shared PTY + pyte session for the TUI screen assertions.

Spawns `dist/cli.js` against the local OpenAI-compatible stub so no provider
quota is spent, feeds the output through pyte and exposes the screen, the
hardware cursor and the composer row. Used by assert-layout.py and by the
manual probe.
"""
import fcntl
import json
import os
import pty
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import time

import pyte

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KEYS = {
    "up": "\x1b[A",
    "down": "\x1b[B",
    "pgup": "\x1b[5~",
    "pgdn": "\x1b[6~",
    "home": "\x1b[H",
    "ctrl-home": "\x1b[1;5H",
    "end": "\x1b[F",
    "enter": "\r",
    "esc": "\x1b",
    "ctrl-o": "\x0f",
    "ctrl-r": "\x12",
    "ctrl-t": "\x14",
    "ctrl-l": "\x0c",
    "ctrl-g": "\x07",
    "tab": "\t",
    "shift-tab": "\x1b[Z",
}
PROMPT_GLYPH = "\u276f"  # ❯


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Session:
    """One moss process on a PTY. Use as a context manager."""

    def __init__(self, cols=100, rows=30, renderer="fullscreen", extra_env=None, config=None, keybindings=None):
        self.cols, self.rows = cols, rows
        self.renderer = renderer
        self.extra_env = extra_env or {}
        self.config_override = config or {}
        self.keybindings = keybindings
        self.proc = None
        self.stub = None
        self.master = None
        self.home = None
        self.workspace = None
        self.screen = pyte.HistoryScreen(cols, rows, history=5000)
        self.stream = pyte.Stream(self.screen)
        self.raw = bytearray()

    def __enter__(self):
        try:
            self.start()
        except Exception:
            self.close()
            raise
        return self

    def __exit__(self, *exc):
        self.close()

    def start(self):
        port = free_port()
        self.stub = subprocess.Popen(
            ["node", os.path.join(ROOT, "scripts/tui-feel/stub.mjs"), str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.4)
        self.home = tempfile.mkdtemp(prefix="moss-screen-home-")
        self.workspace = tempfile.mkdtemp(prefix="moss-screen-ws-")
        home = self.home
        ws = self.workspace
        cfg_dir = os.path.join(home, ".config", "moss")
        os.makedirs(cfg_dir)
        cfg = os.path.join(cfg_dir, "config.json")
        config = {
            "provider": "openai-compatible",
            "model": "stub-model",
            "baseUrl": f"http://127.0.0.1:{port}/v1",
            "apiKey": "sk-local-stub",
            "permissions": {"defaultMode": "full"},
        }
        config.update(self.config_override)
        with open(cfg, "w", encoding="utf-8") as handle:
            json.dump(config, handle)
        if self.keybindings is not None:
            with open(os.path.join(cfg_dir, "keybindings.json"), "w", encoding="utf-8") as handle:
                json.dump(self.keybindings, handle)
        # Colour switches are inherited from the developer's shell (NO_COLOR, FORCE_COLOR)
        # and would silently strip every style; the probe owns them.
        inherited = {k: v for k, v in os.environ.items() if k not in ("NO_COLOR", "FORCE_COLOR")}
        env = {
            **inherited,
            "HOME": home,
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "MOSS_NOTIFY": "0",
            "MOSS_NO_RDK_DOCS": "1",
            # Layout probes measure the TUI, not the first-launch folder prompt.
            "MOSS_TRUST_WORKSPACE": "1",
            "MOSS_CONFIG_FILE": cfg,
            "MOSS_TUI_RENDERER": self.renderer,
            **self.extra_env,
        }
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
        self.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "dist/cli.js"), "--config-file", cfg],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=ws,
            env=env,
        )
        os.close(slave)
        self.pump(2.0)

    def close(self):
        try:
            if self.proc is not None:
                self.proc.kill()
                self.proc.wait(timeout=5)
            if self.stub is not None:
                self.stub.terminate()
                self.stub.wait(timeout=5)
            if self.master is not None:
                try:
                    os.close(self.master)
                except OSError:
                    pass
        finally:
            self.proc = None
            self.stub = None
            self.master = None
            home = self.home
            workspace = self.workspace
            self.home = None
            self.workspace = None
            if home:
                shutil.rmtree(home, ignore_errors=True)
            if workspace:
                shutil.rmtree(workspace, ignore_errors=True)

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.raw.extend(data)
            # A real terminal clears the alternate buffer on entry (DECSET 1049);
            # pyte keeps the old cells, which fakes ghost characters after a
            # suspend/resume. Model the clear so the screen matches a terminal.
            data = data.replace(b"\x1b[?1049h", b"\x1b[?1049h\x1b[2J\x1b[H")
            self.stream.feed(data.decode("utf-8", "replace"))

    def settle(self, timeout: float = 1.0) -> None:
        """Pump until the hardware cursor is visible (a finished frame).

        ink hides the cursor while it repaints; sampling mid-frame reads a hidden
        cursor that a real terminal would never show as a final state.
        """
        end = time.time() + timeout
        while self.screen.cursor.hidden and time.time() < end:
            self.pump(0.05)

    def send(self, text: str) -> None:
        os.write(self.master, text.encode())

    def key(self, name: str) -> None:
        if name not in KEYS and not (len(name) == 1 or name.startswith("\x1b")):
            raise KeyError(f"unknown key name {name!r}: add it to KEYS so it is not sent as text")
        self.send(KEYS.get(name, name))
        self.pump(0.4)

    def wait_for(self, predicate, timeout: float = 5.0) -> bool:
        """Pump until `predicate` is true or `timeout` elapses.

        A fixed pump after a key misses the frame on a slow machine: the
        history search overlay can land after 0.7s, and the check then reads
        a screen that has not opened yet.
        """
        end = time.time() + timeout
        while time.time() < end:
            if predicate():
                return True
            self.pump(0.05)
        return bool(predicate())

    def wait_for_prompt(self, timeout: float = 20.0) -> None:
        """Pump until the composer glyph is painted.

        A fixed pump assumed a fast machine: under load the first TUI frame can
        land seconds after spawn (observed 2-4s), and every later assertion
        would then read an app that never painted. Wait for the glyph instead.
        """
        end = time.time() + timeout
        while not self.prompt_rows() and time.time() < end:
            self.pump(0.05)
        if not self.prompt_rows():
            raise AssertionError(f"composer did not appear within {timeout}s")

    def submit(self, text: str, wait: float = 3.0) -> None:
        self.wait_for_prompt()
        self.send(text)
        self.pump(0.3)
        self.send("\r")
        self.pump(wait)

    # ── observations ────────────────────────────────────────────────────

    def frame_violations(self):
        """Lines the MOSS_TUI_DEBUG frame invariant wrote for this session."""
        if not self.workspace:
            return []
        path = os.path.join(self.workspace, ".moss", "logs", "tui-frame.log")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as handle:
            return [line.strip() for line in handle if line.strip()]

    def lines(self):
        return list(self.screen.display)

    def cursor(self):
        return self.screen.cursor.x, self.screen.cursor.y, self.screen.cursor.hidden

    def prompt_rows(self):
        return [i for i, line in enumerate(self.lines()) if line.lstrip().startswith(PROMPT_GLYPH)]

    def last_nonblank_row(self):
        lines = self.lines()
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip():
                return i
        return -1
