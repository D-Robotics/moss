#!/usr/bin/env python3
"""Real-terminal checks the pyte probe cannot make (plan v3 P7).

Drives moss against the local stub inside a private tmux server and a private
GNU screen session, then reads the pane those programs actually display:

  tmux mouse off  -> inline renderer, alternate screen stays off
  tmux mouse on   -> fullscreen renderer, alternate screen turns on
  GNU screen      -> inline renderer (screen cannot host the alternate screen)

Both must show the composer and, after "hello", the stub's answer. Skips with
exit 0 when tmux or screen is not installed. iTerm2, Terminal.app, the VS Code
terminal, Windows Terminal and a real IME are not started here.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMPT = "\u276f"


def have(name):
    return shutil.which(name) is not None


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class Stub:
    def __init__(self):
        port = free_port()
        self.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "scripts/tui-feel/stub.mjs"), str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.home = tempfile.mkdtemp(prefix="moss-real-home-")
        self.ws = tempfile.mkdtemp(prefix="moss-real-ws-")
        cfg_dir = os.path.join(self.home, ".config", "moss")
        os.makedirs(cfg_dir)
        self.cfg = os.path.join(cfg_dir, "config.json")
        with open(self.cfg, "w", encoding="utf-8") as handle:
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
        self.launcher = os.path.join(self.home, "launch.sh")
        cli = os.path.join(ROOT, "dist/cli.js")
        with open(self.launcher, "w", encoding="utf-8") as handle:
            handle.write(
                "#!/bin/sh\n"
                f"cd {self.ws}\n"
                f"export HOME={self.home}\n"
                "export MOSS_NOTIFY=0\n"
                f"export MOSS_CONFIG_FILE={self.cfg}\n"
                "unset NO_COLOR\n"
                "unset FORCE_COLOR\n"
                f"exec node {cli} --config-file {self.cfg}\n"
            )
        os.chmod(self.launcher, 0o755)
        time.sleep(0.3)

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def wait_until(read, predicate, timeout, label):
    last = ""
    end = time.time() + timeout
    while time.time() < end:
        last = read()
        if predicate(last):
            return last
        time.sleep(0.3)
    raise AssertionError(f"{label} not observed\n{last!r}")


def tmux_case(stub, mouse, expect_alt, scope="session"):
    sock = f"moss-real-{os.getpid()}-{scope}-{mouse}"
    name = "moss"
    base = ["tmux", "-L", sock]

    def run(*args, **kwargs):
        return subprocess.run([*base, *args], check=True, text=True, **kwargs)

    def out(*args):
        return subprocess.check_output([*base, *args], text=True)

    # -f /dev/null keeps the user's tmux.conf (mouse, status bar) out of this server.
    run("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "100", "-y", "30")
    try:
        if scope == "global":
            run("set-option", "-g", "mouse", mouse)
        else:
            run("set-option", "-t", name, "mouse", mouse)
        run("send-keys", "-t", name, stub.launcher, "Enter")
        pane = wait_until(
            lambda: out("capture-pane", "-p", "-t", name),
            lambda text: PROMPT in text and "mode on" in text,
            20,
            f"tmux mouse {mouse} composer",
        )
        alt = out("display-message", "-p", "-t", name, "#{alternate_on}").strip()
        if alt != expect_alt:
            raise AssertionError(
                f"tmux mouse {mouse}: alternate_on={alt!r}, expected {expect_alt!r}\n{pane}"
            )
        run("send-keys", "-t", name, "hello", "Enter")
        wait_until(
            lambda: out("capture-pane", "-p", "-t", name),
            lambda text: "Done." in text,
            15,
            f"tmux mouse {mouse} answer",
        )
        print(
            f"[PASS] tmux {scope} mouse {mouse}: alternate_on={alt}, composer and answer visible"
        )
    finally:
        subprocess.run([*base, "kill-server"], check=False)


def screen_case(stub):
    name = f"moss-real-{os.getpid()}"
    hardcopy = os.path.join(stub.home, "screen.txt")

    def read():
        subprocess.run(["screen", "-S", name, "-X", "hardcopy", hardcopy], check=False)
        if not os.path.exists(hardcopy):
            return ""
        with open(hardcopy, encoding="utf-8", errors="replace") as handle:
            return handle.read()

    subprocess.run(["screen", "-dmS", name, stub.launcher], check=True)
    try:
        wait_until(read, lambda text: PROMPT in text and "mode on" in text, 20, "screen composer")
        subprocess.run(["screen", "-S", name, "-X", "stuff", "hello\r"], check=True)
        wait_until(read, lambda text: "Done." in text, 15, "screen answer")
        print("[PASS] GNU screen: inline composer and answer visible")
    finally:
        subprocess.run(["screen", "-S", name, "-X", "quit"], check=False)


def screen_broken():
    """Old macOS screen builds (4.00.03) die on `screen -dm` even for `sleep`.

    Probe with a bare sleeper: if that session cannot stay alive, the screen
    case cannot run here at all and is skipped rather than misreported as a
    moss failure.
    """
    name = f"moss-screen-probe-{os.getpid()}"
    subprocess.run(["screen", "-dmS", name, "/bin/sh", "-c", "sleep 3"], check=False)
    time.sleep(0.5)
    listing = subprocess.run(
        ["screen", "-ls"], capture_output=True, text=True, check=False
    )
    alive = name in f"{listing.stdout}{listing.stderr}"
    subprocess.run(["screen", "-S", name, "-X", "quit"], capture_output=True, check=False)
    return not alive


def main():
    if not have("tmux") or not have("screen"):
        print("[real-terminals] skip: tmux or screen is not installed")
        return 0
    if not os.path.exists(os.path.join(ROOT, "dist/cli.js")):
        print("[real-terminals] skip: dist/cli.js is missing (run npm run build)")
        return 0
    stub = Stub()
    try:
        tmux_case(stub, "off", "0")
        tmux_case(stub, "on", "1", scope="session")
        tmux_case(stub, "on", "1", scope="global")
        if screen_broken():
            print("[real-terminals] skip: GNU screen cannot host even a sleep session on this machine")
        else:
            screen_case(stub)
    finally:
        stub.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"[FAIL] {error}", file=sys.stderr)
        sys.exit(1)
