#!/usr/bin/env python3
"""Real-terminal checks the pyte probe cannot make (plan v3 P7).

Each check skips on its own when that terminal is not installed. A present
terminal that fails the assertion exits 1.

  tmux mouse off  -> inline, alternate screen off, cursor on the prompt
  tmux mouse on   -> fullscreen, alternate screen on, SGR mouse, cursor on
                     the prompt, one 测 (not two) as soon as the composer shows
  GNU screen      -> inline composer and answer, read by attaching (macOS
                     screen 4.00.03 hardcopy writes a 0-byte file)
  Terminal.app    -> composer and answer via AppleScript, only the window
                     this script opened
  iTerm2          -> same, when iTerm.app / iTerm2.app is installed
  VS Code         -> skipped here when the app and `code` are absent; the
                     integrated terminal is not driven from this script
"""
import fcntl
import json
import os
import pty
import select
import tty
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMPT = "\u276f"
CJK = "测"


def have(name):
    return shutil.which(name) is not None


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def macos_app(*names):
    roots = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
        os.path.expanduser("~/Applications"),
    ]
    for root in roots:
        for name in names:
            path = os.path.join(root, name)
            if os.path.isdir(path):
                return path
    return None


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


def prompt_row(pane):
    rows = [index for index, line in enumerate(pane.splitlines()) if PROMPT in line]
    return rows[-1] if rows else None


def tmux_case(stub, mouse, expect_alt, scope="session", check_cjk=False):
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
        info = out(
            "display-message",
            "-p",
            "-t",
            name,
            "#{cursor_x} #{cursor_y} #{alternate_on} #{mouse_sgr_flag}",
        ).split()
        cursor_x, cursor_y, alt, mouse_flag = (
            int(info[0]),
            int(info[1]),
            info[2],
            info[3],
        )
        row = prompt_row(pane)
        if alt != expect_alt:
            raise AssertionError(
                f"tmux mouse {mouse}: alternate_on={alt!r}, expected {expect_alt!r}\n{pane}"
            )
        if mouse_flag != expect_alt:
            raise AssertionError(
                f"tmux mouse {mouse}: mouse_sgr_flag={mouse_flag!r}, expected {expect_alt!r}"
            )
        if row is None or cursor_y != row or cursor_x != 2:
            raise AssertionError(
                f"tmux mouse {mouse}: cursor ({cursor_x},{cursor_y}) is not on the prompt at column 2 (row {row})\n{pane}"
            )
        if check_cjk:
            run("send-keys", "-l", "-t", name, CJK)
            time.sleep(0.45)
            typed = out("capture-pane", "-p", "-t", name)
            typed_info = out(
                "display-message", "-p", "-t", name, "#{cursor_x} #{cursor_y}"
            ).split()
            line = next((item for item in typed.splitlines() if CJK in item), "")
            if line.count(CJK) != 1 or int(typed_info[0]) != 4:
                raise AssertionError(
                    f"tmux mouse {mouse}: {CJK!r} landed as {line!r} cursor x={typed_info[0]} (want one character, x=4)\n{typed}"
                )
            run("send-keys", "-t", name, "BSpace")
            time.sleep(0.25)
        run("send-keys", "-t", name, "hello", "Enter")
        wait_until(
            lambda: out("capture-pane", "-p", "-t", name),
            lambda text: "Done." in text,
            15,
            f"tmux mouse {mouse} answer",
        )
        print(
            f"[PASS] tmux {scope} mouse {mouse}: alternate_on={alt}, "
            f"cursor on prompt ({cursor_x},{cursor_y}), composer and answer visible"
            + (", one CJK" if check_cjk else "")
        )
    finally:
        subprocess.run([*base, "kill-server"], check=False)


def screen_broken():
    """Old macOS screen builds (4.00.03) die on `screen -dm` even for `sleep`.

    Probe with a bare sleeper: if that session cannot stay alive, the screen
    case cannot run here at all and is skipped rather than misreported as a
    moss failure.
    """
    name = f"moss-screen-probe-{os.getpid()}"
    subprocess.run(["screen", "-dmS", name, "/bin/sh", "-c", "sleep 3"], check=False)
    time.sleep(0.5)
    listing = subprocess.run(["screen", "-ls"], capture_output=True, text=True, check=False)
    alive = name in f"{listing.stdout}{listing.stderr}"
    subprocess.run(["screen", "-S", name, "-X", "quit"], capture_output=True, check=False)
    return not alive


def _read_pty(master, buf, predicate, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return predicate()
        if not chunk:
            return predicate()
        buf.extend(chunk)
    return predicate()


def _attach_screen(name):
    """Attach on a raw pty. screen 4.00.03 sometimes writes a single ESC and stalls."""
    master, slave = pty.openpty()
    tty.setraw(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    proc = subprocess.Popen(
        ["screen", "-r", name],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        preexec_fn=os.setsid,
    )
    os.close(slave)
    return master, proc


def _detach_screen(master, proc):
    if master is not None:
        try:
            os.write(master, b"\x01d")
        except OSError:
            pass
        time.sleep(0.2)
        try:
            os.close(master)
        except OSError:
            pass
    if proc is not None:
        proc.terminate()


def screen_case(stub):
    """Read the session by attaching. `hardcopy` on screen 4.00.03 stays empty."""
    name = f"moss-real-{os.getpid()}"
    # `npm test` pins LC_ALL=C. Screen 4.00.03 then stalls on the UTF-8 prompt.
    subprocess.run(["screen", "-U", "-dmS", name, stub.launcher], check=True)
    master = None
    proc = None
    buf = bytearray()
    try:
        deadline = time.time() + 8
        while time.time() < deadline:
            listing = subprocess.run(["screen", "-ls"], capture_output=True, text=True, check=False)
            if name in f"{listing.stdout}{listing.stderr}":
                break
            time.sleep(0.2)
        else:
            raise AssertionError("screen session did not stay up")
        # Let the inline frame land in screen's canvas before the first client.
        time.sleep(1.2)
        last = ""
        for attempt in range(3):
            _detach_screen(master, proc)
            master, proc = _attach_screen(name)
            chunk = bytearray()

            def text():
                return (buf + chunk).decode("utf-8", "replace")

            seen = _read_pty(
                master, chunk, lambda: PROMPT in text() and "mode on" in text(), 4
            )
            if not seen:
                try:
                    os.write(master, b"\x01l")
                except OSError:
                    pass
                seen = _read_pty(
                    master, chunk, lambda: PROMPT in text() and "mode on" in text(), 4
                )
            buf.extend(chunk)
            if seen:
                break
            last = text()
        else:
            raise AssertionError(f"screen composer not observed\n{last[-1500]!r}")

        def all_text():
            return buf.decode("utf-8", "replace")

        os.write(master, b"hello\r")
        if not _read_pty(master, buf, lambda: "Done." in all_text(), 15):
            raise AssertionError(f"screen answer not observed\n{all_text()[-1500]!r}")
        print("[PASS] GNU screen: inline composer and answer visible")
    finally:
        _detach_screen(master, proc)
        subprocess.run(["screen", "-S", name, "-X", "quit"], check=False)


def osascript(source, *args, timeout=25):
    result = subprocess.run(
        ["osascript", "-", *args],
        input=source,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise AssertionError(detail or f"osascript exited {result.returncode}")
    return result.stdout.strip()


TERMINAL_OPEN = """
on run argv
  set launcher to item 1 of argv
  set titleText to item 2 of argv
  tell application "Terminal"
    set theTab to do script launcher
    delay 0.4
    set theTTY to tty of theTab
    set theWin to first window whose tty of selected tab is theTTY
    set custom title of theWin to titleText
    return theTTY
  end tell
end run
"""

TERMINAL_CONTENTS = """
on run argv
  tell application "Terminal"
    set theWin to first window whose custom title is (item 1 of argv)
    return contents of selected tab of theWin as text
  end tell
end run
"""

TERMINAL_TYPE = """
on run argv
  tell application "Terminal"
    set theWin to first window whose custom title is (item 1 of argv)
    do script (item 2 of argv) in selected tab of theWin
  end tell
end run
"""

TERMINAL_CLOSE = """
on run argv
  set titleText to item 1 of argv
  tell application "Terminal"
    if not (exists (first window whose custom title is titleText)) then return "absent"
    set theWin to first window whose custom title is titleText
    close theWin
    return "closed"
  end tell
end run
"""


def terminal_app_case(stub):
    if not have("osascript") or macos_app("Terminal.app") is None:
        print("[real-terminals] skip: Terminal.app is not available")
        return
    title = f"moss-p7-{os.getpid()}"
    tty = None
    try:
        tty = osascript(TERMINAL_OPEN, stub.launcher, title)
        wait_until(
            lambda: osascript(TERMINAL_CONTENTS, title),
            lambda text: PROMPT in text and "mode on" in text,
            25,
            "Terminal.app composer",
        )
        osascript(TERMINAL_TYPE, title, "hello")
        wait_until(
            lambda: osascript(TERMINAL_CONTENTS, title),
            lambda text: "Done." in text,
            20,
            "Terminal.app answer",
        )
        print(
            f"[PASS] Terminal.app: composer and answer visible (tty {tty}, window {title} only)"
        )
    finally:
        # Quit the TUI and the login shell before closing. Killing the tty
        # leaves a window whose `close` AppleScript accepts and then ignores.
        for command in ("/quit", "exit"):
            try:
                osascript(TERMINAL_TYPE, title, command, timeout=8)
                time.sleep(0.4)
            except (AssertionError, subprocess.TimeoutExpired):
                pass
        try:
            osascript(TERMINAL_CLOSE, title, timeout=8)
        except (AssertionError, subprocess.TimeoutExpired):
            pass


ITERM_OPEN = """
on run argv
  set launcher to item 1 of argv
  set titleText to item 2 of argv
  tell application "iTerm"
    set theWindow to (create window with default profile)
    tell current session of theWindow
      set name to titleText
      write text launcher
    end tell
    return "ok"
  end tell
end run
"""

ITERM_CONTENTS = """
on run argv
  set titleText to item 1 of argv
  tell application "iTerm"
    repeat with theWindow in windows
      tell current session of theWindow
        if name is titleText then return contents
      end tell
    end repeat
  end tell
  return ""
end run
"""

ITERM_TYPE = """
on run argv
  set titleText to item 1 of argv
  set lineText to item 2 of argv
  tell application "iTerm"
    repeat with theWindow in windows
      tell current session of theWindow
        if name is titleText then
          write text lineText
          return "ok"
        end if
      end tell
    end repeat
  end tell
  error "iTerm session not found"
end run
"""

ITERM_CLOSE = """
on run argv
  set titleText to item 1 of argv
  tell application "iTerm"
    repeat with theWindow in windows
      tell current session of theWindow
        if name is titleText then
          close theWindow
          return "closed"
        end if
      end tell
    end repeat
  end tell
  return "absent"
end run
"""


def iterm_case(stub):
    app = macos_app("iTerm.app", "iTerm2.app")
    if app is None or not have("osascript"):
        print("[real-terminals] skip: iTerm2 is not installed")
        return
    title = f"moss-p7-iterm-{os.getpid()}"
    try:
        osascript(ITERM_OPEN, stub.launcher, title)
        wait_until(
            lambda: osascript(ITERM_CONTENTS, title),
            lambda text: PROMPT in text and "mode on" in text,
            25,
            "iTerm2 composer",
        )
        osascript(ITERM_TYPE, title, "hello")
        wait_until(
            lambda: osascript(ITERM_CONTENTS, title),
            lambda text: "Done." in text,
            20,
            "iTerm2 answer",
        )
        print(f"[PASS] iTerm2: composer and answer visible ({app})")
    finally:
        try:
            osascript(ITERM_CLOSE, title)
        except AssertionError:
            pass


def vscode_case():
    app = macos_app("Visual Studio Code.app")
    cli = shutil.which("code")
    if app is None and cli is None:
        print("[real-terminals] skip: VS Code is not installed")
        return
    # The integrated terminal has no capture API this script can drive without
    # stealing the focused editor. Presence is recorded; the checklist has the steps.
    where = app or cli
    print(f"[real-terminals] skip: VS Code is installed at {where} but its terminal is manual-only")


def main():
    # The package test runner forces LANG=C. Wide prompts and CJK checks need UTF-8.
    os.environ["LANG"] = "en_US.UTF-8"
    os.environ["LC_ALL"] = "en_US.UTF-8"
    os.environ["LC_CTYPE"] = "en_US.UTF-8"
    if not os.path.exists(os.path.join(ROOT, "dist/cli.js")):
        print("[real-terminals] skip: dist/cli.js is missing (run npm run build)")
        return 0
    stub = None

    def ensure():
        nonlocal stub
        if stub is None:
            stub = Stub()
        return stub

    try:
        if have("tmux"):
            tmux_case(ensure(), "off", "0")
            tmux_case(ensure(), "on", "1", scope="session", check_cjk=True)
            tmux_case(ensure(), "on", "1", scope="global")
        else:
            print("[real-terminals] skip: tmux is not installed")
        if have("screen"):
            if screen_broken():
                print(
                    "[real-terminals] skip: GNU screen cannot host even a sleep session on this machine"
                )
            else:
                screen_case(ensure())
        else:
            print("[real-terminals] skip: GNU screen is not installed")
        if have("osascript"):
            terminal_app_case(ensure())
            iterm_case(ensure())
        else:
            print("[real-terminals] skip: osascript is not available (not macOS)")
        vscode_case()
    finally:
        if stub is not None:
            stub.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"[FAIL] {error}", file=sys.stderr)
        sys.exit(1)
