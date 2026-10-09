#!/usr/bin/env python3
"""Inline TUI exit keeps the answer and does not clear the primary screen."""

import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMPT = "❯"
COLS = 80
ROWS = 40


def free_port():
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def visible(screen):
    return "\n".join(screen.display)


def pump(master, stream, raw, timeout):
    end = time.time() + timeout
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        raw.extend(data)
        stream.feed(data.decode("utf-8", "replace"))


def wait_until(master, stream, screen, raw, predicate, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        pump(master, stream, raw, 0.05)
        if predicate():
            return
    raise AssertionError(f"{label}\n{visible(screen)}")


def main():
    port = free_port()
    stub = subprocess.Popen(
        ["node", os.path.join(ROOT, "scripts", "tui-feel", "stub.mjs"), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    home = tempfile.mkdtemp(prefix="moss-inline-exit-home-")
    workspace = tempfile.mkdtemp(prefix="moss-inline-exit-ws-")
    config_dir = os.path.join(home, ".config", "moss")
    os.makedirs(config_dir)
    config_file = os.path.join(config_dir, "config.json")
    with open(config_file, "w", encoding="utf-8") as handle:
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

    screen = pyte.HistoryScreen(COLS, ROWS, history=200)
    stream = pyte.Stream(screen)
    raw = bytearray()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = {
        **os.environ,
        "HOME": home,
        "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "MOSS_CONFIG_DIR": config_dir,
        "MOSS_CONFIG_FILE": config_file,
        "MOSS_NO_RDK_DOCS": "1",
        "MOSS_NOTIFY": "0",
        "MOSS_TUI_RENDERER": "inline",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
    }
    proc = subprocess.Popen(
        ["node", os.path.join(ROOT, "dist", "cli.js"), "--config-file", config_file],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=workspace,
        env=env,
    )
    os.close(slave)
    try:
        wait_until(
            master,
            stream,
            screen,
            raw,
            lambda: any(line.lstrip().startswith(PROMPT) for line in screen.display),
            20,
            "composer did not appear",
        )
        os.write(master, b"ping\r")
        wait_until(
            master,
            stream,
            screen,
            raw,
            lambda: "Done." in visible(screen) and "worked for" in visible(screen),
            20,
            "answer was not committed",
        )
        os.write(master, b"/quit\r")
        deadline = time.time() + 10
        while proc.poll() is None and time.time() < deadline:
            pump(master, stream, raw, 0.05)
        pump(master, stream, raw, 0.3)
        if proc.poll() is None:
            raise AssertionError(f"inline /quit did not exit\n{visible(screen)}")
        shown = visible(screen)
        if "Done." not in shown:
            raise AssertionError(f"inline exit wiped the answer\n{shown}")
        if "moss --continue" not in shown:
            raise AssertionError(f"inline exit did not print the continue hint\n{shown}")
        if b"\x1b[?1049l" in raw:
            raise AssertionError("inline exit left the alternate screen")
        if b"\x1b[H\x1b[2J" in raw:
            raise AssertionError("inline exit cleared the primary screen")
        if proc.returncode not in (0, None):
            raise AssertionError(f"moss exited {proc.returncode}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        stub.terminate()
        stub.wait(timeout=5)
        os.close(master)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
    print("[PASS] inline exit keeps the answer and stays on the primary screen")
