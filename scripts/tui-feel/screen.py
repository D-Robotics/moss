"""Shared PTY + pyte session for the TUI screen assertions.

Spawns `dist/cli.js` against the local OpenAI-compatible stub so no provider
quota is spent, feeds the output through pyte and exposes the screen, the
hardware cursor and the composer row. Used by assert-layout.py and by the
manual probe.
"""
import codecs
import fcntl
import http.client
import json
import os
import pty
import select
import shutil
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


def require_clean_ancestors(directory):
    """Refuse a temp location whose ancestors could inject a .env into the CLI."""
    current = os.path.realpath(directory)
    while True:
        if os.path.lexists(os.path.join(current, ".env")):
            raise RuntimeError("temporary directory has a .env ancestor; use a clean TMPDIR for tui-feel")
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


class Session:
    """One moss process on a PTY. Use as a context manager."""

    def __init__(self, cols=100, rows=30, renderer="fullscreen", extra_env=None, config=None, keybindings=None,
                 initial_pump=2.0, isolated_env=False):
        self.cols, self.rows = cols, rows
        self.renderer = renderer
        self.initial_pump = initial_pump
        self.isolated_env = isolated_env
        self.spawn_started_ns = None
        self.extra_env = extra_env or {}
        self.config_override = config or {}
        self.keybindings = keybindings
        self.proc = None
        self.stub = None
        self.stub_port = None
        self.master = None
        self.home = None
        self.workspace = None
        self.stream_events_path = None
        self.screen = pyte.HistoryScreen(cols, rows, history=5000)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
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
        if self.isolated_env:
            inherited = {k: os.environ[k] for k in ("PATH", "TMPDIR") if k in os.environ}
        else:
            # Colour switches would silently strip every style; the probe owns them.
            inherited = {k: v for k, v in os.environ.items() if k not in ("NO_COLOR", "FORCE_COLOR")}
        self.home = tempfile.mkdtemp(prefix="moss-screen-home-")
        if self.isolated_env:
            require_clean_ancestors(self.home)
        self.stream_events_path = os.path.join(self.home, "stub-stream-events.jsonl")
        # Let the stub bind its own ephemeral port. Waiting for its listening
        # message avoids both a free-port race and a fixed startup delay.
        self.stub = subprocess.Popen(
            ["node", os.path.join(ROOT, "scripts/tui-feel/stub.mjs"), "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**inherited, "MOSS_TUI_FEEL_EVENTS": self.stream_events_path},
        )
        deadline = time.monotonic() + 10
        response = b""
        while b"\n" not in response and time.monotonic() < deadline:
            ready, _, _ = select.select([self.stub.stdout], [], [], min(0.1, max(0, deadline - time.monotonic())))
            if ready:
                chunk = os.read(self.stub.stdout.fileno(), 1024)
                if not chunk:
                    break
                response += chunk
                if len(response) > 1024:
                    raise RuntimeError("stub emitted an invalid startup message")
            elif self.stub.poll() is not None:
                break
        if b"\n" not in response:
            detail = self.stub.stderr.read().decode("utf-8", "replace").strip() if self.stub.poll() is not None else "timed out"
            raise RuntimeError(f"local stub did not start: {detail}")
        try:
            port = int(response.split(b"\n", 1)[0])
            if not 0 < port < 65536:
                raise ValueError("invalid port")
        except ValueError as error:
            raise RuntimeError(f"invalid local stub startup message: {response!r}") from error
        self.stub_port = port
        self.workspace = tempfile.mkdtemp(prefix="moss-screen-ws-")
        home = self.home
        ws = self.workspace
        cli = os.path.join(ROOT, "dist/cli.js")
        if self.isolated_env:
            require_clean_ancestors(ws)
            # The CLI loads .env above its installation, even with a clean HOME.
            # Run the same build from a temp install with no such ancestors.
            install = os.path.join(home, "install")
            os.mkdir(install)
            for name in ("dist", "bin"):
                source = os.path.join(ROOT, name)
                if os.path.isdir(source):
                    shutil.copytree(source, os.path.join(install, name),
                                    ignore=lambda _dir, names: [entry for entry in names if entry.lower() == ".env"])
            package = os.path.join(ROOT, "package.json")
            if os.path.isfile(package):
                shutil.copy2(package, os.path.join(install, "package.json"))
            modules = os.path.join(ROOT, "node_modules")
            if os.path.isdir(modules):
                os.symlink(modules, os.path.join(install, "node_modules"))
            cli = os.path.join(install, "dist/cli.js")
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
        if self.isolated_env:
            # Defense in depth if a future CLI discovers another config source.
            env["MOSS_FALLBACK_PROVIDERS"] = "[]"
            env["MOSS_FALLBACK_MAX_RETRIES"] = "0"
        self.master, slave = pty.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))
            self.spawn_started_ns = time.monotonic_ns()
            self.proc = subprocess.Popen(
                ["node", cli, "--config-file", cfg],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=os.path.realpath(ws),
                env=env,
            )
        finally:
            os.close(slave)
        self.pump(self.initial_pump)

    def close(self):
        try:
            if self.proc is not None:
                self.proc.kill()
                self.proc.wait(timeout=5)
            if self.stub is not None:
                self.stub.terminate()
                self.stub.wait(timeout=5)
                if self.stub.stdout:
                    self.stub.stdout.close()
                if self.stub.stderr:
                    self.stub.stderr.close()
            if self.master is not None:
                try:
                    os.close(self.master)
                except OSError:
                    pass
        finally:
            self.proc = None
            self.stub = None
            self.stub_port = None
            self.master = None
            home = self.home
            workspace = self.workspace
            self.home = None
            self.workspace = None
            self.stream_events_path = None
            if home:
                shutil.rmtree(home, ignore_errors=True)
            if workspace:
                shutil.rmtree(workspace, ignore_errors=True)

    def pump_once(self, timeout: float) -> bool:
        """Read and process one PTY chunk, returning as soon as it arrives."""
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return False
        try:
            data = os.read(self.master, 65536)
        except OSError:
            return False
        if not data:
            return False
        self.raw.extend(data)
        # pyte keeps the old alternate-buffer cells on DECSET 1049; clear them
        # as a real terminal does to avoid ghost characters after resume.
        data = data.replace(b"\x1b[?1049h", b"\x1b[?1049h\x1b[2J\x1b[H")
        self.stream.feed(self.decoder.decode(data))
        return True

    def pump(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if not self.pump_once(min(0.05, max(0, end - time.monotonic()))) and self.proc.poll() is not None:
                return

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

    def arm_stream(self, stream_id):
        """Mark the active stream using the stub's own monotonic clock."""
        conn = http.client.HTTPConnection("127.0.0.1", self.stub_port, timeout=5)
        try:
            conn.request("POST", "/__tui-feel/arm", json.dumps({"streamId": stream_id}),
                         {"content-type": "application/json"})
            response = conn.getresponse()
            body = response.read(4096)
            if response.status != 200:
                raise RuntimeError(f"stub refused stream marker: HTTP {response.status}")
            event = json.loads(body)
            if event.get("streamId") != stream_id or event.get("type") != "armed":
                raise RuntimeError("stub returned an invalid stream marker")
            return event
        finally:
            conn.close()

    def stream_events(self):
        """Read complete local-stub stream lifecycle records, if any."""
        try:
            with open(self.stream_events_path, encoding="utf-8") as handle:
                content = handle.read()
        except FileNotFoundError:
            return []
        # An append may be in progress; consume a record only after its newline.
        return [json.loads(line) for line in content.split("\n")[:-1] if line]

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
