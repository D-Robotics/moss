#!/usr/bin/env python3
"""PTY + pyte driver for the TUI feel bench. Scenarios are JSON step lists."""
import argparse, json, os, pathlib, pty, select, shutil, subprocess, sys, time

try:
    import pyte
except ImportError:
    print("[tui-feel] skip: pyte is not installed")
    sys.exit(0)

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCENARIOS = pathlib.Path(__file__).resolve().parent / "scenarios"


def run_scenario(name, cols, rows):
    cli = ROOT / "dist" / "cli.js"
    if not cli.exists():
        return {"name": name, "skipped": "dist/cli.js missing"}
    screen = pyte.HistoryScreen(cols, rows, history=2000)
    stream = pyte.Stream(screen)
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["node", str(cli)],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=str(ROOT),
        env={**os.environ, "TERM": "xterm-256color", "MOSS_NO_TUI": "0"},
    )
    os.close(slave)
    raw = bytearray()
    end = time.time() + 2
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw += chunk
        stream.feed(chunk.decode("utf-8", "replace"))
    proc.kill()
    os.close(master)
    text = "\n".join(screen.display)
    return {
        "name": name,
        "bytes": len(raw),
        "clears": raw.count(b"\x1b[2J"),
        "cursorHidden": b"\x1b[?25l" in raw and text.strip() == "",
        "screenHasComposer": "❯" in text or ">" in text,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--real", action="store_true")
    parser.add_argument("--compare", default="")
    args = parser.parse_args()
    reports = []
    for path in sorted(SCENARIOS.glob("*.json")):
        spec = json.loads(path.read_text())
        reports.append(run_scenario(spec.get("name", path.stem), spec.get("cols", 100), spec.get("rows", 30)))
    pathlib.Path(args.out).write_text(json.dumps({"scenarios": reports}, indent=2))
    print(args.out)


if __name__ == "__main__":
    main()
