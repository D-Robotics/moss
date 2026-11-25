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
  search   Ctrl+F searches the transcript; Enter and ↓ go to the next hit, ↑ and
           Shift+Enter to the previous one; Esc leaves the view on the hit and
           the draft in the composer; Ctrl+F again resumes the query
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


# ── search ─────────────────────────────────────────────────────────────────

SEARCH_PROMPT = "searchmark"
NEEDLE = "Here is the needle."
SEARCH_HINT = "type to search"
# The stub puts the needle on paragraphs 4, 24 and 34 of sixty, one paragraph per row.
NEEDLE_ROWS = ("04", "24", "34")
SHIFT_ENTER = "\x1b[13;2u"


def needle_row(session, paragraph):
    """The screen row holding paragraph `paragraph` with the needle, if shown."""
    return next(
        (
            row
            for row, text in enumerate(session.lines())
            if f"Paragraph {paragraph}" in text and NEEDLE in text
        ),
        None,
    )


def bar_text(session):
    """The two rows of the search bar joined: `⌕ needle 1 of 3 · …`."""
    lines = session.lines()
    for row, text in enumerate(lines):
        if text.startswith("⌕"):
            return f"{text.strip()} {' '.join(line.strip() for line in lines[row + 1 : row + 2])}"
    return ""


def wait_bar(session, expected, timeout=6.0):
    return session.wait_for(lambda: expected in bar_text(session), timeout)


def marked(session, attr):
    """What the screen prints with the character attribute `attr`
    (`reverse` or `underline` is `underscore` in pyte): one string per row."""
    buffer = session.screen.buffer
    out = []
    for row in sorted(buffer):
        run = "".join(
            char.data for _, char in sorted(buffer[row].items()) if getattr(char, attr)
        )
        if run:
            out.append(run)
    return out


def search_scenario():
    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        s.submit(SEARCH_PROMPT, wait=1.5)
        s.wait_for(lambda: "worked for" in screen_text(s), 25)
        check("search: the answer scrolls", "Paragraph 60" in screen_text(s), screen_text(s)[-300:])
        check(
            "search: the needle is off screen before the search",
            not any(NEEDLE in row for row in s.lines()),
        )
        # A draft in the composer must survive the search untouched.
        s.send("draft words")
        s.pump(0.5)
        check("search: the composer holds a draft", composer_text(s) == f"{PROMPT_GLYPH} draft words", composer_text(s))

        press(s, "ctrl+f")
        check("search: Ctrl+F opens the bar", wait_rows(s, SEARCH_HINT))
        check("search: the bar says how to step and close", "Esc close" in bar_text(s), bar_text(s))
        check(
            "search: Ctrl+F left the draft alone",
            "draft words" in screen_text(s) and not any(row.startswith("⌕ draft") for row in s.lines()),
        )

        s.send("needle")
        check("search: typing searches the transcript", wait_bar(s, "⌕ needle 1 of 3"), bar_text(s))
        check(
            "search: the view jumps to the first hit, from the bottom of a long answer",
            s.wait_for(lambda: needle_row(s, NEEDLE_ROWS[0]) is not None, 8),
            screen_text(s)[-300:],
        )
        row = needle_row(s, NEEDLE_ROWS[0])
        check("search: the hit is centred, not on the edge", row is not None and 4 <= row <= s.rows - 5, row)
        check(
            "search: the hit row's text is unchanged by the highlight",
            s.lines()[row].strip() == f"Paragraph {NEEDLE_ROWS[0]} of the search transcript. {NEEDLE}",
            s.lines()[row] if row is not None else None,
        )
        check("search: the hit the reader is on is inverted", "needle" in "".join(marked(s, "reverse")), marked(s, "reverse"))
        check("search: nothing on screen is inverted besides the hit", "".join(marked(s, "reverse")).strip("needle") == "", marked(s, "reverse"))

        press(s, "enter")
        check("search: Enter goes to the next hit", wait_bar(s, "⌕ needle 2 of 3"), bar_text(s))
        check("search: the view follows Enter", wait_rows(s, f"Paragraph {NEEDLE_ROWS[1]} of the search transcript. {NEEDLE}"))
        check("search: the first hit is off screen now", needle_row(s, NEEDLE_ROWS[0]) is None)
        press(s, "enter")
        check("search: Enter again reaches the third hit", wait_bar(s, "⌕ needle 3 of 3"), bar_text(s))
        press(s, "enter")
        check("search: Enter past the last hit wraps to the first", wait_bar(s, "⌕ needle 1 of 3"), bar_text(s))

        s.key("up")
        check("search: ↑ goes back, wrapping past the first", wait_bar(s, "⌕ needle 3 of 3"), bar_text(s))
        s.key("down")
        check("search: ↓ goes forward", wait_bar(s, "⌕ needle 1 of 3"), bar_text(s))
        s.send(SHIFT_ENTER)
        check("search: Shift+Enter goes back", s.wait_for(lambda: "⌕ needle 3 of 3" in bar_text(s), 6), bar_text(s))
        press(s, "enter")

        s.key("esc")
        s.pump(0.6)
        check("search: Esc closes the bar", "Esc close" not in screen_text(s) and not any(row.startswith("⌕") for row in s.lines()))
        check("search: Esc leaves the view on the hit", needle_row(s, NEEDLE_ROWS[0]) is not None)
        check("search: the mark is gone with the bar", "".join(marked(s, "reverse")) == "", marked(s, "reverse"))
        check("search: Esc leaves the draft alone", composer_text(s) == f"{PROMPT_GLYPH} draft words", composer_text(s))
        s.send(" more")
        s.pump(0.5)
        check("search: after Esc typing goes to the composer again", composer_text(s) == f"{PROMPT_GLYPH} draft words more", composer_text(s))

        # Ctrl+F again resumes the query on the hit it was left on, selected.
        press(s, "ctrl+f")
        check("search: Ctrl+F resumes the query", wait_bar(s, "⌕ needle 1 of 3"), bar_text(s))
        check(
            "search: the resumed query is shown selected, the hit still marked",
            marked(s, "reverse") == ["needle", "needle"],
            marked(s, "reverse"),
        )
        check("search: the hint says typing replaces the selection", "type to replace" in bar_text(s), bar_text(s))
        s.send("zz")
        check("search: typing replaces a selected query", wait_bar(s, "⌕ zz no match"), bar_text(s))
        check("search: the selection is gone once the query changes", "".join(marked(s, "reverse")) == "", marked(s, "reverse"))
        press(s, "ctrl+u")
        check("search: Ctrl+U clears the query", wait_bar(s, "⌕ type to search"), bar_text(s))
        s.send("need")
        check("search: a new query can be typed after clearing", wait_bar(s, "⌕ need 1 of 3"), bar_text(s))
        s.send("zz")
        check("search: a query without hits says so", wait_bar(s, "⌕ needzz no match"), bar_text(s))
        check("search: nothing is marked without hits", "".join(marked(s, "reverse")) == "", marked(s, "reverse"))
        s.key("\x7f")
        s.key("\x7f")
        check("search: the hits come back when the query is repaired", wait_bar(s, "⌕ need 1 of 3"), bar_text(s))
        s.key("\x7f")
        check("search: Backspace edits a query that is not selected", wait_bar(s, "⌕ nee 1 of 3"), bar_text(s))
        s.key("esc")
        s.pump(0.6)
        press(s, "ctrl+f")
        check("search: Ctrl+F resumes the repaired query, selected", wait_bar(s, "⌕ nee 1 of 3"), bar_text(s))
        s.key("\x7f")
        check("search: Backspace clears a selected query", wait_bar(s, "⌕ type to search"), bar_text(s))
        s.key("esc")
        s.pump(0.6)
        check("search: the draft outlives the whole search", composer_text(s) == f"{PROMPT_GLYPH} draft words more", composer_text(s))

    # Searching during a run neither interrupts it nor steals the stream.
    with Session(cols=100, rows=30) as s:
        s.wait_for_prompt()
        s.submit("holdstream", wait=1.2)
        check("search: a run is streaming", "Working" in screen_text(s))
        press(s, "ctrl+f")
        check("search: Ctrl+F works during a run", wait_rows(s, SEARCH_HINT))
        s.send("Holding")
        check("search: the bar counts hits during a run", wait_bar(s, "⌕ Holding 1 of 1"), bar_text(s))
        s.key("esc")
        s.pump(0.6)
        released = s.release_streams()
        check("search: closing the bar left the run in flight", released == 1, released)

    # The inline renderer has no bar: the key says why instead of staying silent.
    with Session(cols=100, rows=30, renderer="inline") as s:
        s.wait_for_prompt()
        press(s, "ctrl+f")
        shown = s.wait_for(lambda: "find works in the fullscreen view" in screen_text(s), 8)
        check("search: the inline view explains why Ctrl+F does nothing", shown, screen_text(s)[-300:])
        check("search: the inline view opens no bar", not any(row.startswith("⌕") for row in s.lines()))


# ── entry ──────────────────────────────────────────────────────────────────

SCENARIOS = {
    "queue": queue_scenario,
    "search": search_scenario,
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
