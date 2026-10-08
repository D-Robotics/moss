#!/usr/bin/env python3
"""Short PTY feel check: the same keystrokes against moss and, optionally, claude.

Passes when moss shows a visible hardware cursor on the insertion point, the
composer text does not shift when the cursor moves, '?' opens help, and a
mouse sequence does not land in the composer. With --compare claude, the
cursor column must match Claude's column on the same string.
"""
from __future__ import annotations

import argparse
import json
import os
import pty
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

import pyte

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEXT = "hello 世界，测试光标"
# ❯ + space (2) + "hello " (6) + 7 wide characters (14) = 22
EXPECTED_X = 22


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Session:
    def __init__(self, argv: list[str], cols: int, rows: int, cwd: str, env: dict[str, str]):
        self.cols, self.rows = cols, rows
        self.screen = pyte.HistoryScreen(cols, rows, history=2000)
        self.stream = pyte.Stream(self.screen)
        self.raw = bytearray()
        master, slave = pty.openpty()
        import fcntl
        import struct
        import termios

        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.master = master
        self.proc = subprocess.Popen(
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            env=env,
            preexec_fn=os.setsid,
        )
        os.close(slave)

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.master], [], [], min(0.05, max(0.0, end - time.time())))
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.raw += chunk
            self.stream.feed(chunk.decode("utf-8", "replace"))

    def send(self, data: bytes) -> None:
        os.write(self.master, data)

    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def cursor(self) -> dict:
        cursor = self.screen.cursor
        return {"x": cursor.x, "y": cursor.y, "hidden": bool(getattr(cursor, "hidden", False))}

    def close(self) -> None:
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except OSError:
            pass
        try:
            os.close(self.master)
        except OSError:
            pass
        self.proc.wait(timeout=3)


def type_text(session: Session, text: str) -> None:
    for char in text:
        session.send(char.encode("utf-8"))
        session.pump(0.05)


def dismiss_trust(session: Session) -> None:
    session.pump(2.5)
    screen = session.text()
    if "trust" in screen.lower() or "信任" in screen:
        if "No, exit" in screen:
            session.send(b"\x1b[B")
            session.pump(0.3)
        session.send(b"\r")
        session.pump(2.0)


def probe(session: Session) -> dict:
    dismiss_trust(session)
    session.pump(1.5)
    type_text(session, TEXT)
    session.pump(0.4)
    typed = {"screen": session.text(), "cursor": session.cursor()}
    for _ in range(3):
        session.send(b"\x1b[D")
        session.pump(0.12)
    moved = {"screen": session.text(), "cursor": session.cursor()}
    # Clear the draft and ask for help on an empty composer.
    session.send(b"\x01")
    session.pump(0.1)
    session.send(b"\x0b")
    session.pump(0.15)
    session.send(b"\x7f" * 40)
    session.pump(0.3)
    session.send(b"?")
    session.pump(0.6)
    helped = session.text()
    session.send(b"\x1b")
    session.pump(0.2)
    session.send(b"\x1b[<0;10;5M\x1b[<0;10;5m")
    session.pump(0.4)
    leaked = session.text()
    return {"typed": typed, "moved": moved, "help": helped, "after_mouse": leaked}


def checks(name: str, report: dict, claude_x: int | None) -> list[str]:
    failures: list[str] = []
    cursor = report["typed"]["cursor"]
    screen = report["typed"]["screen"]
    if TEXT not in screen:
        failures.append(f"{name}: typed text missing from screen")
    if cursor["hidden"]:
        failures.append(f"{name}: hardware cursor hidden after typing ({cursor})")
    expected = claude_x if claude_x is not None else EXPECTED_X
    if cursor["x"] != expected:
        failures.append(f"{name}: cursor x={cursor['x']} expected {expected}")
    moved = report["moved"]["screen"]
    if "测试光标" not in moved:
        failures.append(f"{name}: cursor movement shifted the composer text")
    if "测 试" in moved:
        failures.append(f"{name}: fake caret space still inserted")
    if "Help" not in report["help"] and "快捷" not in report["help"]:
        failures.append(f"{name}: '?' did not open help")
    if "[<0;" in report["after_mouse"]:
        failures.append(f"{name}: mouse sequence entered the composer")
    return failures


def moss_env(home: str, config: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": home,
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
        "MOSS_NOTIFY": "0",
        "MOSS_CONFIG_FILE": config,
        "MOSS_TUI_RENDERER": "fullscreen",
    }
    return env


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare", default="")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    port = free_port()
    stub = subprocess.Popen(
        ["node", os.path.join(ROOT, "scripts/tui-feel/stub.mjs"), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.3)
    home = tempfile.mkdtemp(prefix="moss-feel-home-")
    workspace = tempfile.mkdtemp(prefix="moss-feel-ws-")
    config_dir = os.path.join(home, ".config", "moss")
    os.makedirs(config_dir, exist_ok=True)
    config_path = os.path.join(config_dir, "config.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "provider": "openai-compatible",
                "model": "stub-model",
                "baseUrl": f"http://127.0.0.1:{port}/v1",
                "apiKey": "sk-local-stub",
                "permissions": {"defaultMode": "full"},
            },
            handle,
        )
    reports: dict[str, dict] = {}
    failures: list[str] = []
    claude_x = None
    try:
        if args.compare == "claude" and shutil.which("claude"):
            claude = Session(["claude"], 100, 30, workspace, {**os.environ, "TERM": "xterm-256color", "LANG": "en_US.UTF-8"})
            try:
                reports["claude"] = probe(claude)
                claude_x = reports["claude"]["typed"]["cursor"]["x"]
            finally:
                claude.close()
        moss = Session(
            ["node", os.path.join(ROOT, "dist", "cli.js"), "--config-file", config_path],
            100,
            30,
            workspace,
            moss_env(home, config_path),
        )
        try:
            reports["moss"] = probe(moss)
        finally:
            moss.close()
        failures.extend(checks("moss", reports["moss"], claude_x))
    finally:
        stub.terminate()
        stub.wait(timeout=3)
    result = {"failures": failures, "reports": {key: {"typed_cursor": value["typed"]["cursor"], "moved_cursor": value["moved"]["cursor"]} for key, value in reports.items()}}
    if args.out:
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if failures:
        print("\n--- moss screen after typing ---")
        print(reports.get("moss", {}).get("typed", {}).get("screen", ""))
        print("\n--- moss screen after ? ---")
        print(reports.get("moss", {}).get("help", ""))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
