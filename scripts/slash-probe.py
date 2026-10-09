#!/usr/bin/env python3
"""REPL PTY probe for the v0.31 slash-command surface (plan §8.1).

Starts `MOSS_NO_TUI=1 node dist/cli.js --mock` on a pseudo-terminal, sends the
acceptance commands, and checks the ANSI-stripped transcript. This covers the
readline REPL only. Real-TTY TUI behavior (`/`, `/init`, custom commands, the
session picker) is a separate manual check.

Exit 0 when every row matches. Exit 0 with a skip line when `pty` cannot be
opened (Windows). Exit 1 on an assertion miss. Exit 2 when `dist/cli.js` is
missing — build first (`npm run build`).
"""

from __future__ import annotations

import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

try:
    import fcntl
    import pty
    import struct
    import termios
except ImportError:
    print("slash-probe: skipping (pty unavailable)")
    raise SystemExit(0)

ANSI = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
PROMPT = "› "


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text).replace("\r", "")


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Probe:
    def __init__(self, master: int, proc) -> None:
        self.master = master
        self.proc = proc
        self.raw = bytearray()

    def text(self) -> str:
        return strip_ansi(self.raw.decode("utf-8", "replace"))

    def pump(self, timeout: float) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = deadline - time.time()
            if remaining <= 0:
                return
            ready, _, _ = select.select([self.master], [], [], min(0.2, remaining))
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 8192)
            except OSError:
                return
            if not chunk:
                return
            self.raw.extend(chunk)

    def wait_for(self, marker: str, timeout: float) -> str:
        start = len(self.text())
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(min(0.2, max(0.0, deadline - time.time())))
            segment = self.text()[start:]
            if marker in segment:
                return segment
        return self.text()[start:]

    def send_and_settle(self, line: str, marker: str, timeout: float) -> str:
        """Send a line and return the new transcript once `marker` and the next prompt are in it."""
        self.send(line)
        segment = self.wait_for(marker, timeout)
        if marker not in segment:
            return segment
        after = segment.split(marker, 1)[1]
        if PROMPT in after:
            return segment
        extra = self.wait_for(PROMPT, 5)
        return segment + extra

    def send(self, line: str) -> None:
        os.write(self.master, (line + "\r").encode())


def fail(probe: Probe, message: str) -> None:
    print(f"FAIL: {message}")
    print("--- transcript ---")
    print(probe.text()[-8000:])
    raise SystemExit(1)


def main() -> None:
    root = repo_root()
    cli = os.path.join(root, "dist", "cli.js")
    node = shutil.which("node")
    if node is None or not os.path.isfile(cli):
        print("slash-probe: dist/cli.js is missing; run npm run build", file=sys.stderr)
        raise SystemExit(2)

    temp_root = tempfile.mkdtemp(prefix="moss-slash-probe-")
    home = tempfile.mkdtemp(prefix="home-", dir=temp_root)
    workspace = tempfile.mkdtemp(prefix="workspace-", dir=temp_root)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": home,
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "MOSS_NO_COLOR": "1",
        "MOSS_NO_TUI": "1",
        "MOSS_CONFIG_DIR": os.path.join(home, "config"),
        "MOSS_RUNTIME_DIR": os.path.join(home, "runtime"),
    }
    proc = subprocess.Popen(
        [node, cli, "--mock"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        cwd=workspace,
    )
    os.close(slave)
    probe = Probe(master, proc)
    try:
        ready = probe.wait_for("Ready.", 30)
        if "Ready." not in ready and "Ready." not in probe.text():
            fail(probe, "REPL did not reach Ready.")

        plan = probe.send_and_settle("/plan", "Plan mode", 15)
        if "Plan mode" not in plan:
            fail(probe, "/plan did not confirm plan mode")

        mode = probe.send_and_settle("/mode", "Interaction mode: plan", 15)
        if "Interaction mode: plan" not in mode:
            fail(probe, "/mode after /plan did not show Interaction mode: plan")
        if "Shift+Tab" not in mode:
            fail(probe, "/mode did not mention the Shift+Tab migration")

        loop = probe.send_and_settle("/loop", "已改为 /goal", 15)
        if "已改为 /goal" not in loop:
            fail(probe, "/loop migration text missing")

        unknown = probe.send_and_settle("/foo", "Available:", 15)
        avail_line = ""
        for line in unknown.splitlines():
            if "Available:" in line:
                avail_line = line.split("Available:", 1)[1]
                break
        if not avail_line:
            fail(probe, "/foo did not print an Available list")
        tokens = avail_line.split()
        required = [
            "/model",
            "/compact",
            "/goal",
            "/plan",
            "/review",
            "/doctor",
            "/diff",
            "/permissions",
            "/clear",
            "/help",
        ]
        missing = [cmd for cmd in required if cmd not in tokens]
        if missing:
            fail(probe, f"Available list missing {missing}: {avail_line}")
        banned = [cmd for cmd in ("/mode", "/task") if cmd in tokens]
        if banned:
            fail(probe, f"Available list still offers {banned}: {avail_line}")

        # /init starts a model turn. Assert the run path, then stop the process
        # so a mock tool loop cannot hold the probe open.
        probe.send("/init")
        init = probe.wait_for("Drafting AGENTS.md", 20)
        if "Drafting AGENTS.md" not in init and "Drafting AGENTS.md" not in probe.text():
            fail(probe, "/init did not enter the drafting path")
        if "not available" in init:
            fail(probe, '/init still says "not available"')

        print("slash-probe: PASS")
        print("  /plan  Plan mode")
        print("  /mode  Interaction mode: plan + Shift+Tab")
        print("  /loop  已改为 /goal")
        print(f"  /foo   Available:{avail_line}")
        print("  /init  Drafting AGENTS.md (not available absent)")
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        os.close(master)
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
