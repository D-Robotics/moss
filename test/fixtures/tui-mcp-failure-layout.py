#!/usr/bin/env python3
"""Real-CLI layout probe for an MCP failure arriving after TUI mount."""

import fcntl
import json
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

import pyte


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMPT = "❯"


def free_port():
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_case(cols, rows):
    home = tempfile.mkdtemp(prefix="moss-mcp-layout-home-")
    workspace = tempfile.mkdtemp(prefix="moss-mcp-layout-ws-")
    try:
        return _run_mcp_case(cols, rows, home, workspace)
    finally:
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree(workspace, ignore_errors=True)


def _run_mcp_case(cols, rows, home, workspace):
    port = free_port()
    stub = subprocess.Popen(
        ["node", os.path.join(ROOT, "scripts", "tui-feel", "stub.mjs"), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
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
    moss_dir = os.path.join(workspace, ".moss")
    os.makedirs(moss_dir)
    with open(os.path.join(moss_dir, "mcp.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "mcpServers": {
                    "rdk-docs": {
                        "transport": "stdio",
                        "command": sys.executable,
                        "args": ["-c", "raise SystemExit(1)"],
                        "connectTimeoutMs": 1000,
                    }
                }
            },
            handle,
        )

    screen = pyte.HistoryScreen(cols, rows, history=500)
    stream = pyte.Stream(screen)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = {
        **os.environ,
        "HOME": home,
        "XDG_CONFIG_HOME": os.path.join(home, ".config"),
        "MOSS_CONFIG_DIR": config_dir,
        "MOSS_CONFIG_FILE": config_file,
        "MOSS_NO_RDK_DOCS": "1",
        "MOSS_NOTIFY": "0",
        # This probe's mcp.json is a project server named rdk-docs. That name
        # is project code, so the TUI would otherwise ask before the failure
        # paints. The flag is this throwaway workspace's own opt-in.
        "MOSS_TRUST_WORKSPACE": "1",
        "TERM": "xterm-256color",
        "LANG": "en_US.UTF-8",
    }
    env.pop("MOSS_TUI_RENDERER", None)
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
        deadline = time.time() + 15
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                data = data.replace(b"\x1b[?1049h", b"\x1b[?1049h\x1b[2J\x1b[H")
                stream.feed(data.decode("utf-8", "replace"))
            display = list(screen.display)
            if any(PROMPT in line for line in display) and any(
                "rdk-docs" in line and ("unreachable" in line or "failed" in line)
                for line in display
            ):
                break
        return list(screen.display)
    finally:
        proc.kill()
        proc.wait(timeout=5)
        stub.terminate()
        stub.wait(timeout=5)
        os.close(master)


fullscreen = run_case(100, 30)
fullscreen_prompts = [index for index, line in enumerate(fullscreen) if line.lstrip().startswith(PROMPT)]
assert 27 in fullscreen_prompts, (
    f"fullscreen composer moved after MCP failure: prompts={fullscreen_prompts}\n"
    + "\n".join(fullscreen)
)
assert any("rdk-docs" in line and ("unreachable" in line or "failed" in line) for line in fullscreen)

inline = run_case(30, 12)
inline_text = "".join(line.strip() for line in inline)
assert "using the inline view" in inline_text, (
    "inline fallback notice disappeared after MCP failure\n" + "\n".join(inline)
)
inline_prompts = [index for index, line in enumerate(inline) if line.lstrip().startswith(PROMPT)]
assert inline_prompts, "inline composer disappeared after MCP failure\n" + "\n".join(inline)

print("[PASS] asynchronous rdk-docs failure preserves fullscreen and inline layout")
