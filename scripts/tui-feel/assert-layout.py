#!/usr/bin/env python3
"""Screen-level layout assertions for the moss TUI (plan v3 P0, N1–N4).

Every check runs `dist/cli.js` in a PTY against the local stub and reads the
result back through pyte, so it sees what a terminal user sees:

  matrix   renderer {fullscreen, inline} x size {100x30, 70x24, 44x14, 30x12}
           x state {idle, streaming}
           - the hardware cursor sits on the composer row (N1)
           - the composer row is near the bottom of the painted content
  N2       20-row fullscreen, scrolled up (Jump-to-bottom row visible):
           the frame still fits, the hint row is the last painted row and the
           cursor is on the composer row
  N3       fullscreen, scrolled up while a reply keeps streaming: the visible
           rows do not move
  N4       fullscreen, short transcript: the composer sits on the bottom edge

Exit 0 when every check passes; exit 1 with a per-check report otherwise.
Skips with exit 0 when pyte is missing (same policy as run.mjs).
"""
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import pyte  # noqa: F401
except ImportError:
    print("[tui-layout] skip: pyte is not installed")
    sys.exit(0)

from screen import Session  # noqa: E402

SIZES = [(100, 30), (70, 24), (44, 14), (30, 12)]
RENDERERS = ["fullscreen", "inline"]

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    status = "PASS" if ok else "FAIL"
    suffix = f" — {detail}" if detail and not ok else ""
    print(f"[{status}] {name}{suffix}", flush=True)


def cursor_on_composer(session, label):
    session.settle()
    x, y, hidden = session.cursor()
    prompts = session.prompt_rows()
    check(
        f"{label}: cursor on composer row",
        not hidden and prompts and y == prompts[-1],
        f"cursor y={y} hidden={hidden} prompt rows={prompts}",
    )


DEBUG_ENV = {"MOSS_TUI_DEBUG": "1"}


def frame_clean(session, label):
    problems = session.frame_violations()
    check(f"{label}: frame fits the terminal (MOSS_TUI_DEBUG)", not problems, "; ".join(problems[:3]))


def hint_visible(session, label, renderer):
    # Fullscreen pins the hint to the bottom edge; inline sits right after the
    # transcript, so its rows below the frame are simply empty.
    rows = session.lines()[-4:] if renderer == "fullscreen" else session.lines()
    check(f"{label}: the mode label stays on the hint row",
          any("mode on" in line for line in rows), f"rows={[l.rstrip() for l in rows]!r}")


def matrix(renderer, cols, rows):
    tag = f"{renderer}@{cols}x{rows}"
    with Session(cols=cols, rows=rows, renderer=renderer, extra_env=DEBUG_ENV) as session:
        session.submit("hello", wait=2.5)
        cursor_on_composer(session, f"{tag} idle")
        hint_visible(session, f"{tag} idle", renderer)
        session.submit("longstream", wait=1.5)
        cursor_on_composer(session, f"{tag} streaming")
        frame_clean(session, tag)


def n2_scrolled_frame():
    with Session(cols=80, rows=20, renderer="fullscreen", extra_env=DEBUG_ENV) as session:
        session.submit("longstream", wait=17.0)
        session.key("up")
        session.key("up")
        lines = session.lines()
        jump = any("Jump to bottom" in line for line in lines)
        check("N2 jump row shown when scrolled", jump, "no 'Jump to bottom' on screen")
        last = session.last_nonblank_row()
        check(
            "N2 hint row is the last painted row",
            last >= 0 and "mode" in lines[last],
            f"last nonblank row={last} text={lines[last] if last >= 0 else ''!r}",
        )
        cursor_on_composer(session, "N2 scrolled 20-row")
        frame_clean(session, "N2 scrolled 20-row")


SPINNER = re.compile(r"\S… \d+s")


def transcript_body(session):
    """Painted transcript rows: no scroll-bar column, no ticking spinner row."""
    rows = []
    for line in session.lines():
        if SPINNER.search(line):
            continue
        # pyte's display string is not one character per cell (wide CJK), so the
        # bar is removed by its glyph, not by position.
        rows.append(re.sub(r"[┃│↑↓]$", "", line.rstrip()).rstrip())
    return rows[: max(0, len(rows) - 6)]


def n3_scroll_stable():
    with Session(cols=80, rows=20, renderer="fullscreen") as session:
        session.submit("longstream", wait=2.0)
        session.key("pgup")
        before = transcript_body(session)
        session.pump(3.0)
        after = transcript_body(session)
        still_running = any("Esc to interrupt" in line for line in session.lines())
        check("N3 reply still streaming during sample", still_running, "stream ended too early")
        check(
            "N3 visible rows stay put while a reply streams below",
            before == after,
            "transcript drifted under the reader",
        )


def n4_bottom_edge():
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("hello", wait=2.5)
        prompts = session.prompt_rows()
        check(
            "N4 composer sits on the bottom edge (rows-3)",
            prompts and prompts[-1] == 30 - 3,
            f"prompt rows={prompts}, expected {30 - 3}",
        )


def p1_scroll_bar_and_home():
    with Session(cols=80, rows=20, renderer="fullscreen", extra_env=DEBUG_ENV) as session:
        session.submit("longstream", wait=17.0)
        session.settle()
        # Idle: the bar is hidden until the pointer or a scroll touches it.
        idle = [i for i, line in enumerate(session.lines()[:14]) if line.rstrip()[-1:] in ("┃", "│", "↑", "↓")]
        check("P1 scroll bar is hidden while idle", not idle, f"bar rows while idle={idle}")
        # Hover over the bar column (mode 1003 motion, no button held): 1-based x=80.
        session.send("\x1b[<35;80;5M")
        session.pump(0.3)
        lines = session.lines()
        bar_rows = [i for i, line in enumerate(lines[:14]) if line.rstrip()[-1:] in ("┃", "│", "↑", "↓")]
        check("P1 hovering the right column shows the scroll bar",
              len(bar_rows) >= 10, f"bar rows={bar_rows}")
        arrows = [line.rstrip()[-1:] for line in lines[:-4] if line.rstrip()[-1:] in ("↑", "↓")]
        check("P1 the bar has an up and a down arrow", arrows[:1] == ["↑"] and arrows[-1:] == ["↓"],
              f"arrows={arrows}")
        session.pump(2.0)
        session.settle()
        after = [i for i, line in enumerate(session.lines()[:14]) if line.rstrip()[-1:] in ("┃", "│", "↑", "↓")]
        check("P1 the bar hides again after the pointer leaves", not after, f"bar rows={after}")
        session.send("\x1b[<35;80;5M")
        session.pump(0.3)
        thumbs = [i for i, line in enumerate(lines[:-4]) if line.rstrip().endswith("┃")]
        check("P1 thumb is present", bool(thumbs), "no thumb glyph")
        session.key("home")
        session.settle()
        top_rows = " ".join(transcript_body(session)[:12])
        check("P1 Home jumps to the first section",
              "Section 1" in top_rows, f"top rows={top_rows!r}")
        session.key("end")
        session.settle()
        check("P1 End returns to the latest rows",
              "Section 30" in " ".join(transcript_body(session)) or "bullet 30" in " ".join(transcript_body(session)),
              "latest rows not visible")
        # Click on the top of the scroll bar (1-based SGR coordinates).
        session.send("\x1b[<0;80;1M")
        session.pump(0.2)
        session.send("\x1b[<0;80;1m")
        session.pump(0.5)
        session.settle()
        # Drag the thumb from the top of the bar to its bottom (button held = +32).
        bar = [i for i, line in enumerate(session.lines()[:-4]) if line.rstrip()[-1:] in ("┃", "│", "↑", "↓")]
        last_bar_row = max(bar) + 1  # 1-based SGR row of the bar's last cell
        session.send(f"\x1b[<32;80;{last_bar_row}M")
        session.pump(0.2)
        session.send(f"\x1b[<0;80;{last_bar_row}m")
        session.pump(0.5)
        session.settle()
        check("P1 dragging the scroll bar to its bottom reaches the latest rows",
              "bullet 30" in " ".join(transcript_body(session)) or "Section 30" in " ".join(transcript_body(session)),
              "drag did not reach the bottom")
        session.send("\x1b[<0;80;1M")
        session.pump(0.2)
        session.send("\x1b[<0;80;1m")
        session.pump(0.5)
        session.settle()
        top_rows = " ".join(transcript_body(session)[:12])
        check("P1 clicking the top of the scroll bar jumps to the start",
              "Section 1" in top_rows, f"top rows={top_rows!r}")


def p1_heading_style_kept():
    with Session(cols=80, rows=20, renderer="fullscreen") as session:
        session.submit("longstream", wait=17.0)
        session.key("home")
        session.settle()
        lines = session.lines()
        row = next((i for i, line in enumerate(lines) if "Section 1" in line), None)
        if row is None:
            check("P1 heading keeps its bold style in fullscreen", False, "no 'Section 1' row")
            return
        col = lines[row].index("Section 1")
        bold = session.screen.buffer[row][col].bold
        check("P1 heading keeps its bold style in fullscreen", bool(bold), "bold attribute lost")


def p1_reply_end_no_jump():
    with Session(cols=80, rows=20, renderer="fullscreen", extra_env=DEBUG_ENV) as session:
        session.submit("longstream", wait=2.0)
        session.key("pgup")
        session.pump(0.3)
        before = transcript_body(session)[0]
        end = __import__("time").time() + 25
        while __import__("time").time() < end:
            if not any("Esc to interrupt" in line for line in session.lines()):
                break
            session.pump(0.5)
        session.settle()
        check("P1 reply finished (run ended)", not any("Esc to interrupt" in l for l in session.lines()),
              "still streaming after 25s")
        after = transcript_body(session)[0]
        check("P1 reply completion does not jump the reader",
              before == after, f"before={before!r} after={after!r}")
        check("P1 frame fits the terminal (MOSS_TUI_DEBUG)", not session.frame_violations(),
              "; ".join(session.frame_violations()[:2]))


def p2_narrow_fallback():
    with Session(cols=30, rows=12, renderer="") as session:
        session.pump(0.5)
        text = "\n".join(session.lines())
        # The notice wraps at 30 columns, so the two key words are checked apart.
        check("P2 a 30-column window falls back to inline with a notice",
              "narrower" in text and "40 columns" in text, "no fallback notice on screen")


def p3_tool_rows():
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("toolstorm", wait=6.0)
        session.settle()
        text = "\n".join(line.rstrip() for line in session.lines())
        check("P3 consecutive answers are separate rows (N7)",
              "Step 2.Step" not in text and "Step 3.Done" not in text,
              "assistant prose ran together")
        check("P3 the final answer is shown once",
              sum(1 for line in session.lines() if line.strip() == "⏺ Done.") == 1,
              f"'Done.' rows={[l.strip() for l in session.lines() if 'Done.' in l]}")
        check("P3 a read-only result names what came back",
              "Listed 1 entry" in text, "no semantic headline on the tool row")


def p4_keybindings():
    # A rebound command answers on its new key and not on the old one.
    with Session(cols=100, rows=30, renderer="fullscreen",
                 keybindings={"history.search": "ctrl+t"}) as session:
        session.key("ctrl-t")
        session.pump(0.3)
        check("P4 a rebound key opens its command", "Enter to use" in "\n".join(session.lines()),
              "history search did not open on Ctrl+T")
        session.key("esc")
        session.pump(0.3)
        session.key("ctrl-r")
        session.pump(0.3)
        check("P4 the old key no longer answers", "Enter to use" not in "\n".join(session.lines()),
              "Ctrl+R still opened history search")
    # A bad line is reported, and the valid line still applies.
    with Session(cols=100, rows=30, renderer="fullscreen",
                 keybindings={"run.interrupt": "ctrl+z", "composer.clear": "ctrl+t"}) as session:
        session.pump(0.5)
        text = "\n".join(session.lines())
        check("P4 a locked command is reported on screen", "cannot be rebound" in text,
              "no warning for run.interrupt")
        session.submit("draft text", wait=0.5)
        session.key("ctrl-t")
        session.pump(0.3)
        check("P4 a valid rebind still applies beside a bad one",
              "draft text" not in "\n".join(session.lines()[-8:]),
              "Ctrl+T did not clear the composer")


def p0_approval_dialog():
    """An approval dialog is a selector: its own caret is the hardware cursor."""
    with Session(
        cols=100,
        rows=30,
        renderer="fullscreen",
        extra_env=DEBUG_ENV,
        config={"permissions": {"defaultMode": "manual"}},
    ) as session:
        session.submit("approvewrite", wait=2.5)
        session.settle()
        lines = session.lines()
        text = "\n".join(line.rstrip() for line in lines)
        option = next((i for i, line in enumerate(lines) if "❯" in line and "1." in line), None)
        x, y, hidden = session.cursor()
        check("P0 an approval dialog shows its question and options",
              "Do you want to create note.txt?" in text and option is not None,
              "approval dialog missing")
        check("P0 the hardware cursor sits on the selected approval option",
              option is not None and not hidden and y == option and x == lines[option].index("❯"),
              f"option={option} cursor=({x},{y}) hidden={hidden}")
        check("P0 an approval dialog still fits the terminal",
              not session.frame_violations(),
              "; ".join(session.frame_violations()[:2]))


def p1_ctrl_home():
    with Session(cols=80, rows=20, renderer="fullscreen") as session:
        session.submit("longstream", wait=4.0)
        session.settle()
        session.key("ctrl-home")
        session.settle()
        top = " ".join(transcript_body(session)[:8])
        check("P1 Ctrl+Home returns to the first rows", "Section 1" in top, f"top={top!r}")


def foregrounds(session, row):
    seen = set()
    for cell in session.screen.buffer[row].values():
        if str(cell.data).strip() and cell.fg not in ("default", None):
            seen.add(cell.fg)
    return seen


def p5_light_colours():
    """Light theme remaps yellow (the spinner) so it stays readable; dark keeps it."""
    def spinner_colours(theme):
        env = {"MOSS_TUI_THEME": theme} if theme else {}
        with Session(cols=80, rows=20, renderer="fullscreen", extra_env=env) as session:
            session.submit("longstream", wait=1.2)
            session.settle()
            row = next((i for i, line in enumerate(session.lines()) if "…" in line), None)
            return foregrounds(session, row) if row is not None else set()

    # pyte names ANSI yellow (SGR 33) "brown", the VGA name for that colour.
    yellow = {"yellow", "brown"}
    light = spinner_colours("light")
    dark = spinner_colours("dark")
    check("P5 a light theme remaps the spinner off yellow",
          "magenta" in light and not (light & yellow), f"light={light!r}")
    check("P5 a dark theme keeps the spinner yellow",
          bool(dark & yellow), f"dark={dark!r}")


def p5_theme():
    import re
    colour = re.compile(rb"\x1b\[(?:3[0-7]|9[0-7]|38;)[0-9;]*m")
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("hello", wait=2.5)
        check("P5 default theme paints colour", bool(colour.search(bytes(session.raw))),
              "no colour escape in the default theme")
    with Session(cols=100, rows=30, renderer="fullscreen", extra_env={"NO_COLOR": "1"}) as session:
        session.submit("hello", wait=2.5)
        check("P5 NO_COLOR paints no colour", not colour.search(bytes(session.raw)),
              "a colour escape leaked under NO_COLOR")
        check("P5 NO_COLOR keeps the layout", prompt_ok(session), "composer lost under NO_COLOR")


def prompt_ok(session):
    prompts = session.prompt_rows()
    return bool(prompts) and any("mode on" in line for line in session.lines())


def p6_overlay_cursor():
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("hello", wait=2.5)
        session.key("ctrl-r")
        session.send("abc")
        session.pump(0.4)
        session.settle()
        lines = session.lines()
        query = [i for i, line in enumerate(lines) if "⌕ abc" in line]
        x, y, hidden = session.cursor()
        check("P6 the hardware cursor sits at the end of the search query",
              bool(query) and not hidden and y == query[0] and x == lines[query[0]].index("abc") + 3,
              f"query rows={query} cursor=({x},{y}) hidden={hidden}")


def p6_external_editor():
    import tempfile
    workdir = tempfile.mkdtemp(prefix="moss-editor-")
    log = os.path.join(workdir, "argv.txt")
    # Named `vim`: the editor family decides how the line number is passed.
    os.makedirs(os.path.join(workdir, "bin"))
    script = os.path.join(workdir, "bin", "vim")
    with open(script, "w", encoding="utf-8") as handle:
        handle.write('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_EDITOR_LOG"\n')
    os.chmod(script, 0o755)
    with Session(cols=100, rows=30, renderer="fullscreen",
                 extra_env={"EDITOR": script, "FAKE_EDITOR_LOG": log}) as session:
        session.send("one")
        session.pump(0.2)
        session.send("\n")
        session.pump(0.2)
        session.send("two")
        session.pump(0.3)
        session.key("ctrl-g")
        # Poll for the editor's argv instead of sleeping: a loaded machine can take
        # several seconds to start a child process.
        deadline = time.time() + 8.0
        while time.time() < deadline and not os.path.exists(log):
            session.pump(0.2)
        session.pump(0.2)
        argv = open(log, encoding="utf-8").read().split("\n") if os.path.exists(log) else []
        check("P6 Ctrl+G opens the editor on the caret's line",
              argv[:1] == ["+2"] and any(a.endswith(".txt") for a in argv),
              f"argv={argv!r}")


def p5_theme_command():
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("/theme light", wait=1.2)
        session.settle()
        text = "\n".join(line.rstrip() for line in session.lines())
        check("P5 /theme light switches the session theme", "theme: light" in text, "no theme confirmation")


def p6_queue_recall():
    with Session(cols=100, rows=30, renderer="fullscreen") as session:
        session.submit("longstream", wait=1.2)
        session.submit("queued note", wait=0.8)
        session.settle()
        queued = any("1 queued" in line for line in session.lines())
        check("P6 a message sent during a run is queued", queued, "queue count missing")
        session.key("up")
        session.settle()
        tail = [line.rstrip() for line in session.lines()[-6:]]
        check(
            "P6 Up pulls the queued message back into the composer",
            any("queued note" in line and line.lstrip().startswith("❯") for line in tail),
            f"tail={tail!r}",
        )


def main():
    for renderer in RENDERERS:
        for cols, rows in SIZES:
            matrix(renderer, cols, rows)
    n2_scrolled_frame()
    n3_scroll_stable()
    n4_bottom_edge()
    p2_narrow_fallback()
    p3_tool_rows()
    p4_keybindings()
    p0_approval_dialog()
    p1_ctrl_home()
    p5_theme()
    p5_light_colours()
    p5_theme_command()
    p6_queue_recall()
    p6_overlay_cursor()
    p6_external_editor()
    p1_scroll_bar_and_home()
    p1_heading_style_kept()
    p1_reply_end_no_jump()
    failed = [name for name, ok, _ in results if not ok]
    print(f"[tui-layout] {len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
