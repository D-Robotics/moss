#!/usr/bin/env python3
"""Screen-level assertions for the moss TUI's interaction features.

Every check runs `dist/cli.js` in a PTY against the local stub and reads the
screen back through pyte, so it sees what a terminal user sees. The pure
projections behind these rows are also asserted in
`scripts/verify/tui-interaction.mjs`; this file is the end-to-end half.

  queue    `/queue <text>` while a run is in flight queues a follow-up; more
           than five fold into `+N more`; Alt+↑ takes the newest back (a draft
           stays below it); Esc puts the whole queue back into the composer;
           `/queue pause` shows on the queue rows; the queue drains when the
           run ends; idle, `/queue <text>` runs now
  search   Ctrl+F searches the transcript, n / N step through the hits, Esc
           leaves the view where the last hit was
  keys     `/hotkeys` lists the bindings a keybindings.json changed; a rebound
           key answers and the default one no longer does
  copy     `/copy` puts the last answer on the clipboard

Exit 0 when every check passes; exit 1 with a per-check report otherwise.
Skips with exit 0 when pyte is missing (same policy as run.mjs).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import pyte  # noqa: F401
except ImportError:
    print("[tui-interaction] skip: pyte is not installed")
    sys.exit(0)

from screen import PROMPT_GLYPH, Session  # noqa: E402

ALT_UP = "\x1b[1;3A"
CTRL = {letter: chr(ord(letter) - 96) for letter in "abcdefghijklmnopqrstuvwxyz"}
results = []


def press(session, name):
    """`ctrl+l`, `up`, `esc`, `enter` … — control keys by name, the rest via Session.key."""
    session.key(CTRL[name[5:]]) if name.startswith("ctrl+") else session.key(name)


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    status = "PASS" if ok else "FAIL"
    suffix = f" — {detail}" if detail and not ok else ""
    print(f"[{status}] {name}{suffix}", flush=True)


def screen_text(session):
    return "\n".join(session.lines())


def wait_rows(session, needle, timeout=6.0):
    return session.wait_for(lambda: needle in screen_text(session), timeout)


def composer_lines(session):
    """The composer's text rows: the `❯` row and the indented rows below it."""
    session.settle()
    lines = session.lines()
    prompts = session.prompt_rows()
    if not prompts:
        return []
    out = []
    for row in range(prompts[-1], len(lines)):
        text = lines[row]
        if row > prompts[-1] and not text.startswith("  "):
            break
        out.append(text.strip())
    return out


def composer_text(session):
    return " / ".join(composer_lines(session))


def type_line(session, text, settle=0.5):
    """Clear the composer, type `text`, press Enter.

    Clearing first keeps one scenario step from appending to whatever the
    previous step left in the composer: `/queue resume` typed after a recalled
    line is a plain prompt, not the command.
    """
    press(session, "ctrl+l")
    session.send(text)
    session.pump(0.15)
    typed = composer_text(session)
    if typed != f"{PROMPT_GLYPH} {text}" and not typed.startswith(f"{PROMPT_GLYPH} {text}"):
        raise AssertionError(f"composer holds {typed!r}, expected {text!r}")
    session.send("\r")
    session.pump(settle)


# ── queue ──────────────────────────────────────────────────────────────────


def queue_scenario():
    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        s.submit("holdstream", wait=1.2)
        check("queue: a run is streaming", "Working" in screen_text(s))

        type_line(s, "/queue second task")
        check("queue: /queue <text> shows a queued row", wait_rows(s, "queued 1. second task"))
        check(
            "queue: the rows say how to take one back",
            "Alt+↑ edits the newest" in screen_text(s),
        )
        check("queue: idle wait is explained", wait_rows(s, "applies when this run finishes"))
        check("queue: status counts the queue", "1 queued" in screen_text(s))

        for text in ["third", "fourth", "fifth", "sixth", "seventh", "eighth"]:
            type_line(s, f"/queue {text}", settle=0.3)
        check("queue: five rows stay visible", wait_rows(s, "queued 5. sixth"))
        check("queue: the rest folds into +N", "+2 more queued" in screen_text(s))
        check("queue: the sixth row is not on screen", "queued 6." not in screen_text(s))

        s.send(ALT_UP)
        s.pump(0.6)
        check(
            "queue: Alt+↑ puts the newest queued line in the composer",
            composer_text(s) == f"{PROMPT_GLYPH} eighth",
            composer_text(s),
        )
        check("queue: the fold shrinks after the recall", "+1 more queued" in screen_text(s))

        press(s, "ctrl+l")
        s.send("draft text")
        s.pump(0.4)
        s.send(ALT_UP)
        s.pump(0.6)
        check(
            "queue: Alt+↑ keeps the draft below the recalled line",
            composer_text(s) == f"{PROMPT_GLYPH} seventh / draft text",
            composer_text(s),
        )

        s.key("up")
        check(
            "queue: plain ↑ with a draft walks history, not the queue",
            composer_text(s) != f"{PROMPT_GLYPH} sixth",
            composer_text(s),
        )
        press(s, "ctrl+l")
        s.key("up")
        recalled = s.wait_for(lambda: composer_text(s) == f"{PROMPT_GLYPH} sixth", 5)
        check(
            "queue: plain ↑ with an empty composer takes the newest back",
            recalled,
            composer_text(s),
        )

        s.key("esc")
        s.pump(1.0)
        returned = composer_text(s)
        # The composer shows its last rows; the full text is asserted on the
        # pure projection (scripts/verify/tui-interaction.mjs).
        check(
            "queue: Esc puts the queued lines back, draft last",
            returned.endswith("fourth / fifth / sixth")
            and returned.startswith(f"{PROMPT_GLYPH}"),
            returned,
        )
        check("queue: the queue is empty after Esc", "more queued" not in screen_text(s))
        check("queue: Esc interrupted the run", "interrupted" in screen_text(s))

    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        s.submit("holdstream", wait=1.2)
        type_line(s, "/queue later one", settle=0.4)
        type_line(s, "/queue later two", settle=0.4)
        type_line(s, "/queue pause", settle=0.6)
        check("queue: pause shows on the rows", wait_rows(s, "Queue paused — /queue resume"))
        check("queue: pause prints a block", "paused — new submissions wait" in screen_text(s))
        type_line(s, "/queue", settle=0.6)
        check("queue: /queue lists the paused queue", "(paused)" in screen_text(s))
        press(s, "ctrl+l")
        s.key("up")
        check(
            "queue: a paused queue still gives its newest line back",
            composer_text(s) == f"{PROMPT_GLYPH} later two",
            composer_text(s),
        )
        # Put it back so the drain below has two lines to run.
        type_line(s, "/queue later two", settle=0.4)
        type_line(s, "/queue resume", settle=0.5)
        check("queue: resume clears the paused row", "Queue paused" not in screen_text(s))
        # The held stream ends when the stub is told to; the first queued line
        # then runs, and the stub answers it with a short reply.
        released = s.release_streams()
        check("queue: the held run was still in flight before the release", released == 1, released)
        s.wait_for(lambda: "worked for" in screen_text(s), timeout=25)
        check(
            "queue: the queue drains when the run ends",
            s.wait_for(lambda: "queued" not in screen_text(s), timeout=20),
            screen_text(s)[-300:],
        )
        check(
            "queue: the drained lines ran as prompts",
            s.wait_for(lambda: screen_text(s).count("Done.") >= 2, timeout=20),
            screen_text(s)[-300:],
        )

    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        type_line(s, "/queue hello idle", settle=0.5)
        # Wait for the answer instead of sleeping: under load the stub's reply
        # took longer than a fixed settle once, on a healthy build.
        ran = s.wait_for(lambda: "Done." in screen_text(s), 15)
        check("queue: idle, /queue <text> runs now", ran, screen_text(s)[-300:])
        check(
            "queue: idle, nothing is left queued",
            s.wait_for(lambda: "queued" not in screen_text(s), 10),
            screen_text(s)[-300:],
        )


# ── keys ───────────────────────────────────────────────────────────────────

HISTORY_SEARCH_OPEN = "Enter to use"


def scroll_overlay_to_end(session, presses=30):
    for _ in range(presses):
        session.key("down")
    session.pump(0.5)


def keys_scenario():
    # The defaults: every registry key is on the list, and there is no problem.
    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        type_line(s, "/hotkeys", settle=0.8)
        screen = screen_text(s)
        check("keys: /hotkeys opens its own list", "Keys · Esc to close" in screen)
        check(
            "keys: the defaults are listed with their labels",
            re.search(r"Ctrl\+R\s+search your earlier prompts", screen) is not None,
        )
        check(
            "keys: Alt+↑ is listed as a registry key",
            re.search(r"Alt\+↑\s+edit the newest queued message", screen) is not None,
        )
        check("keys: no problems section on a clean config", "problems" not in screen)
        scroll_overlay_to_end(s)
        bottom = screen_text(s)
        check(
            "keys: the keys the composer keeps are listed",
            "keys the composer keeps" in bottom and "Shift+Tab" in bottom,
            bottom[-300:],
        )
        check("keys: it says where to rebind", "keybindings.json" in bottom, bottom[-300:])
        check("keys: nothing is marked as changed", "changed from the defaults" not in bottom)
        s.key("esc")
        s.pump(0.4)
        check("keys: Esc closes the list", "Keys · Esc to close" not in screen_text(s))

    # A keybindings.json with a second key for one command and one bad line.
    with Session(
        cols=100,
        rows=30,
        keybindings={"history.search": ["ctrl+r", "alt+r"], "draft.stash": "enter"},
    ) as s:
        s.wait_for_prompt()
        # At 100 columns the row clips after the detail, so look for its head.
        shown = s.wait_for(
            lambda: "1 keybinding problem — /hotkeys · keybindings.json" in screen_text(s), 10
        )
        check("keys: a bad binding is on screen from the start", shown)
        check("keys: the notice points at /hotkeys", "/hotkeys" in screen_text(s))
        type_line(s, "/hotkeys", settle=0.8)
        screen = screen_text(s)
        check(
            "keys: the problems come first, on the first screen",
            "problems" in screen and screen.index("problems") < screen.index("shortcuts"),
            screen[:400],
        )
        check(
            "keys: both keys of a command are listed",
            re.search(r"Ctrl\+R / Alt\+R\s+search your earlier prompts", screen) is not None,
            screen,
        )
        scroll_overlay_to_end(s)
        check(
            "keys: what moved is listed",
            "history.search  Ctrl+R → Ctrl+R / Alt+R" in screen_text(s),
            screen_text(s),
        )
        s.key("esc")
        s.pump(0.4)
        s.send("\x1br")
        s.pump(0.8)
        check("keys: a key the user chose opens its command", HISTORY_SEARCH_OPEN in screen_text(s))
        s.key("esc")
        s.pump(0.4)
        press(s, "ctrl+r")
        s.pump(0.8)
        check(
            "keys: the default key still answers beside the new one",
            HISTORY_SEARCH_OPEN in screen_text(s),
        )
        s.key("esc")
        s.pump(0.4)
        # A shifted letter must stay composer text: a lookup that treated
        # `shift+r` as a key would make `RDK X5` untypable.
        s.send("RDK X5")
        s.pump(0.6)
        typed = composer_text(s)
        check("keys: a shifted letter is still composer text", typed == f"{PROMPT_GLYPH} RDK X5", typed)
        check("keys: nothing opened while typing", HISTORY_SEARCH_OPEN not in screen_text(s))

    # A moved key: the old one stops answering, the new one starts.
    with Session(cols=100, rows=30, keybindings={"history.search": "alt+r"}) as s:
        s.wait_for_prompt()
        press(s, "ctrl+r")
        s.pump(1.2)
        check("keys: a moved key no longer answers", HISTORY_SEARCH_OPEN not in screen_text(s))
        s.send("\x1br")
        s.pump(0.8)
        check("keys: the key it moved to answers", HISTORY_SEARCH_OPEN in screen_text(s))


# ── /copy ──────────────────────────────────────────────────────────────────

COPY_PROMPT = "copymark"
# What the stub answers to it; the screen paints this without the markdown marks.
COPY_ANSWER = "A **bold** claim and `npm run check`."


def clipboard_text(session):
    """What the `pbcopy` stand-in last received (None before it ran)."""
    if session.clipboard_path is None:
        return None
    try:
        with open(session.clipboard_path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def copy_scenario():
    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        type_line(s, "/copy", settle=0.8)
        check(
            "copy: before the first answer it says so",
            "no answer to copy yet" in screen_text(s),
            screen_text(s)[-300:],
        )
        check("copy: nothing reached the clipboard", clipboard_text(s) is None)

        s.submit(COPY_PROMPT, wait=2.5)
        s.wait_for(lambda: "A bold claim and npm run check." in screen_text(s), 15)
        check(
            "copy: the screen shows the rendered answer",
            "**bold**" not in screen_text(s) and "`npm run check`" not in screen_text(s),
            screen_text(s)[-400:],
        )
        type_line(s, "/copy", settle=0.8)
        check(
            "copy: the status line reports the newest answer",
            f"copied the last answer ({len(COPY_ANSWER)} chars)" in screen_text(s),
            screen_text(s)[-300:],
        )
        copied = s.wait_for(lambda: clipboard_text(s) == COPY_ANSWER, 5)
        check("copy: the clipboard holds the markdown source", copied, clipboard_text(s))

        # A second answer: /copy takes the newest one, not the first.
        s.submit("second turn", wait=2.5)
        s.wait_for(lambda: "Done." in screen_text(s), 15)
        type_line(s, "/copy", settle=0.8)
        check(
            "copy: the second copy reports the second answer",
            "copied the last answer (5 chars)" in screen_text(s),
            screen_text(s)[-300:],
        )
        again = s.wait_for(lambda: clipboard_text(s) == "Done.", 5)
        check("copy: the clipboard now holds the second answer", again, clipboard_text(s))


# ── entry ──────────────────────────────────────────────────────────────────

SCENARIOS = {
    "queue": queue_scenario,
    "search": None,
    "keys": keys_scenario,
    "copy": copy_scenario,
}


def main():
    wanted = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    for name in wanted or list(SCENARIOS):
        runner = SCENARIOS.get(name)
        if runner is None:
            print(f"[tui-interaction] no scenario named {name}")
            sys.exit(2)
        print(f"[tui-interaction] scenario {name}")
        runner()
    failed = [name for name, ok, _ in results if not ok]
    print(f"[tui-interaction] {len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        for name in failed:
            print(f"[tui-interaction] FAIL {name}")
        sys.exit(1)


if __name__ == "__main__":
    main()
