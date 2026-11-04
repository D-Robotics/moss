#!/usr/bin/env python3
"""Run declarative interaction scenarios against a real Moss PTY and local stub."""
import argparse
import json
import math
import os
import pathlib
import subprocess
import sys
import time

if os.name == "nt":
    print("[tui-feel] the PTY benchmark requires macOS or Linux", file=sys.stderr)
    sys.exit(1)

import termios  # noqa: E402

try:
    import pyte  # noqa: F401
except ImportError:
    print("[tui-feel] pyte is required: python3 -m pip install pyte", file=sys.stderr)
    sys.exit(1)

from screen import Session  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCENARIOS = pathlib.Path(__file__).resolve().parent / "scenarios"
DEFAULT_STREAM_CANCEL_TIMEOUT_MS = 1500
TIMING = (
    "monotonic clock; composer_ready_ms starts immediately before CLI spawn and "
    "requires a visible composer, cursor and raw PTY input (polled every 5 ms); "
    "other metrics start immediately before the preceding PTY write and end "
    "when the driver first observes the matching pyte screen after parsing. "
    "Stub startup and copying the CLI to an isolated temporary install are "
    "excluded. Results include PTY transport, rendering and driver "
    "scheduling/parsing, not physical display or human reaction time. "
    "interrupt_ms measures visible UI feedback. The stub timestamps an arm "
    "marker before Esc and the early connection close on its own monotonic "
    "clock; their difference is bounded by streamCancelTimeoutMs. This is "
    "timely association in a controlled stub, not proof of causation. The "
    "CLI and stub share an OS user, so their event file is non-adversarial "
    "evidence, not an independent security attestation."
)


def validate_spec(spec, path):
    if not isinstance(spec, dict):
        raise ValueError(f"{path}: scenario must be an object")
    extra = set(spec) - {"name", "sizes", "cols", "rows", "steps"}
    if extra:
        raise ValueError(f"{path}: unknown scenario fields: {sorted(extra)}")
    name = spec.get("name", path.stem)
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"{path}: name must be nonempty")
    sizes = spec.get("sizes", [{"cols": spec.get("cols", 100), "rows": spec.get("rows", 30)}])
    if not isinstance(sizes, list) or not sizes:
        raise ValueError(f"{path}: sizes must be a nonempty list")
    for size in sizes:
        if not isinstance(size, dict) or set(size) != {"cols", "rows"}:
            raise ValueError(f"{path}: each size must contain only cols and rows")
        if any(type(size[key]) is not int or not 1 <= size[key] <= 1000 for key in ("cols", "rows")):
            raise ValueError(f"{path}: terminal dimensions must be integers from 1 to 1000")
    steps = spec.get("steps")
    if not isinstance(steps, list) or not steps or len(steps) % 2:
        raise ValueError(f"{path}: steps must contain keys/expect pairs")
    metrics = {"composer_ready_ms"}
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"{path}: step {index + 1} must be an object")
        if index % 2 == 0:
            if set(step) != {"type", "text"} or step.get("type") != "keys" or not isinstance(step.get("text"), str) or not step["text"]:
                raise ValueError(f"{path}: step {index + 1} must send nonempty keys")
            continue
        allowed = {"type", "target", "includes", "alsoIncludes", "excludes", "composerReady", "metric", "timeout_ms", "streamCancelled", "streamCancelTimeoutMs"}
        if set(step) - allowed or step.get("type") != "expect":
            raise ValueError(f"{path}: step {index + 1} must be a valid expect")
        if step.get("target", "screen") not in ("screen", "composer"):
            raise ValueError(f"{path}: step {index + 1} has an invalid target")
        for field in ("includes", "alsoIncludes", "excludes", "metric"):
            if (field == "includes" or field in step) and (not isinstance(step.get(field), str) or not step[field]):
                raise ValueError(f"{path}: step {index + 1} requires a nonempty {field}")
        for field in ("composerReady", "streamCancelled"):
            if field in step and not isinstance(step[field], bool):
                raise ValueError(f"{path}: step {index + 1} {field} must be boolean")
        timeout = step.get("timeout_ms", 10000)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 120000:
            raise ValueError(f"{path}: step {index + 1} timeout_ms must be within 1–120000")
        if "streamCancelTimeoutMs" in step:
            limit = step["streamCancelTimeoutMs"]
            if not step.get("streamCancelled") or isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit) or not 0 < limit <= 120000:
                raise ValueError(f"{path}: step {index + 1} streamCancelTimeoutMs requires streamCancelled and must be within 1–120000")
        metric = step.get("metric")
        if metric in metrics:
            raise ValueError(f"{path}: duplicate metric {metric!r}")
        if metric:
            metrics.add(metric)
    return name, sizes, steps


def input_ready(session):
    # Before Ink enables raw mode the PTY kernel itself echoes typed bytes,
    # which looks like a composer update even if the app has not read them.
    flags = termios.tcgetattr(session.master)[3]
    return not flags & (termios.ECHO | termios.ICANON)


def composer_bounds(session):
    lines = session.lines()
    _, cursor_row, hidden = session.cursor()
    if hidden:
        return None

    def is_rule(line):
        text = line.strip()
        return len(text) >= 2 and set(text) == {"─"}

    for row, line in enumerate(lines):
        if row == 0 or not line.startswith("❯ ") or not is_rule(lines[row - 1]):
            continue
        for end in range(row + 1, len(lines)):
            if is_rule(lines[end]):
                if row <= cursor_row < end:
                    return row, end
                break
    return None


def composer_ready(session):
    return composer_bounds(session) is not None


def screen_state(session):
    lines = session.lines()
    bounds = composer_bounds(session)
    return {
        "screen": "\n".join(lines),
        "composer": "\n".join(lines[bounds[0]:bounds[1]]) if bounds else "",
        "composer_ready": bounds is not None,
    }


def area_text(session, target):
    return screen_state(session)[target]


def wait_for(session, predicate, timeout, description, poll_interval=0.1):
    deadline = time.monotonic_ns() + int(timeout * 1_000_000_000)
    while time.monotonic_ns() <= deadline:
        if session.proc.poll() is not None:
            raise RuntimeError(f"CLI exited with status {session.proc.returncode} while waiting for {description}")
        if session.stub.poll() is not None:
            raise RuntimeError(f"local stub exited with status {session.stub.returncode} while waiting for {description}")
        if predicate():
            observed_at = time.monotonic_ns()
            if observed_at <= deadline:
                return observed_at
            break
        remaining = (deadline - time.monotonic_ns()) / 1_000_000_000
        if remaining <= 0:
            break
        session.pump_once(min(poll_interval, remaining))
    raise RuntimeError(f"timed out waiting for {description}")


def elapsed_ms(start, end):
    return round((end - start) / 1_000_000, 3)


def active_stub_stream(events):
    active = {}
    for event in events:
        if event.get("type") == "started":
            active[event["streamId"]] = event
        elif event.get("type") == "closed":
            active.pop(event["streamId"], None)
    if len(active) != 1:
        raise RuntimeError(f"expected one active stub stream before interruption, found {len(active)}")
    return next(iter(active.values()))


def run_scenario(name, size, steps):
    cols, rows = size["cols"], size["rows"]
    result = {"name": name, "cols": cols, "rows": rows, "status": "passed", "metrics": {}, "steps": []}
    extra_env = {"MOSS_LANG": "en", "MOSS_NO_TUI": "0"}
    if os.environ.get("MOSS_STARTUP_TIMING"):
        extra_env["MOSS_STARTUP_TIMING"] = os.environ["MOSS_STARTUP_TIMING"]
    with Session(cols=cols, rows=rows, initial_pump=0, isolated_env=True,
                 extra_env=extra_env) as session:
        try:
            ready_at = wait_for(session, lambda: composer_ready(session) and input_ready(session), 20,
                                "visible composer, cursor and raw PTY input", poll_interval=0.005)
            result["metrics"]["composer_ready_ms"] = elapsed_ms(session.spawn_started_ns, ready_at)
            # B12: the CLI's own phased line, when the caller opted in, so a
            # slow phase can be located instead of guessed at.
            if os.environ.get("MOSS_STARTUP_TIMING"):
                raw = bytes(session.raw).decode("utf-8", "replace")
                for line in raw.split("\r\n") + raw.split("\n"):
                    if "[startup] timing:" in line:
                        result["metrics"]["startup_timing"] = line.split("[startup] timing:")[-1].strip()
                        break
            result["composer"] = {"row": composer_bounds(session)[0], "cursor": session.cursor(),
                                  "observed": area_text(session, "composer").rstrip()}
            previous = None
            started = None
            stream_capture = None
            for index, step in enumerate(steps):
                if step["type"] == "keys":
                    if not input_ready(session):
                        raise RuntimeError("PTY input is not raw; refusing to measure kernel echo")
                    stream_capture = None
                    if steps[index + 1].get("streamCancelled"):
                        events = session.stream_events()
                        stream = active_stub_stream(events)
                        marker = session.arm_stream(stream["streamId"])
                        stream_capture = (stream, len(events), marker)
                    previous = screen_state(session)
                    started = time.monotonic_ns()
                    session.send(step["text"])
                    result["steps"].append({"type": "keys", "text": step["text"]})
                    continue
                target = step.get("target", "screen")
                expected = step["includes"]
                def matches(state):
                    screen = state["screen"]
                    return (expected in state[target]
                            and (target != "composer" or state["composer_ready"])
                            and (not step.get("composerReady") or state["composer_ready"])
                            and (not step.get("alsoIncludes") or step["alsoIncludes"] in screen)
                            and (not step.get("excludes") or step["excludes"] not in screen))

                if step.get("metric") and matches(previous):
                    raise RuntimeError(f"expectation {expected!r} was already satisfied before the preceding keys")
                observed_at = wait_for(session, lambda: matches(screen_state(session)),
                                       step.get("timeout_ms", 10000) / 1000,
                                       f"expectation {expected!r} on {target}")
                duration = elapsed_ms(started, observed_at)
                if step.get("metric"):
                    result["metrics"][step["metric"]] = duration
                lines = area_text(session, target).splitlines()
                observed = "\n".join(line.rstrip() for line in lines
                                     if expected in line or (step.get("alsoIncludes") and step["alsoIncludes"] in line))
                step_result = {"type": "expect", "includes": expected, "target": target,
                               "observed": observed, "elapsed_ms": duration}
                if step.get("streamCancelled"):
                    stream, event_count, marker = stream_capture

                    def closed_event():
                        return next((event for event in session.stream_events()[event_count:]
                                     if event.get("type") == "closed" and event.get("streamId") == stream["streamId"]), None)

                    limit_ms = step.get("streamCancelTimeoutMs", DEFAULT_STREAM_CANCEL_TIMEOUT_MS)
                    wait_for(session, closed_event, limit_ms / 1000,
                             "stub stream cancellation", poll_interval=0.01)
                    closed = closed_event()
                    sent, total = closed.get("sentChunks"), closed.get("totalChunks")
                    armed_at, closed_at = marker.get("armedAtNs"), closed.get("closedAtNs")
                    if (closed.get("completed") is not False or type(sent) is not int
                            or type(total) is not int or total != stream.get("totalChunks")
                            or not 0 < sent < total):
                        raise RuntimeError(f"stub stream did not close during streaming: {closed!r}")
                    if (not isinstance(armed_at, str) or not armed_at.isdigit()
                            or closed.get("armedAtNs") != armed_at
                            or not isinstance(closed_at, str) or not closed_at.isdigit()):
                        raise RuntimeError("stub stream timestamps are missing or inconsistent")
                    delta_ns = int(closed_at) - int(armed_at)
                    if delta_ns < 0 or delta_ns > limit_ms * 1_000_000:
                        raise RuntimeError(f"stub stream cancellation exceeded {limit_ms} ms from its marker")
                    step_result["streamCancellation"] = {
                        "streamId": stream["streamId"], "sentChunks": sent, "totalChunks": total,
                        "armedAtNs": armed_at, "closedAtNs": closed_at,
                        "afterArmMs": round(delta_ns / 1_000_000, 3), "limitMs": limit_ms,
                    }
                result["steps"].append(step_result)
            if session.proc.poll() is not None or session.stub.poll() is not None:
                raise RuntimeError("CLI or local stub exited before the scenario finished")
        except Exception as error:
            screen = "\n".join(line.rstrip() for line in session.lines())
            raise RuntimeError(f"{name}@{cols}x{rows}: {error}\n--- last screen ---\n{screen}") from error
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--scenario", type=pathlib.Path, help="run one scenario JSON instead of the default set")
    args = parser.parse_args()
    try:
        cli = ROOT / "dist" / "cli.js"
        if not cli.is_file():
            raise FileNotFoundError(f"{cli} missing; run npm run build")
        paths = [args.scenario] if args.scenario else sorted(SCENARIOS.glob("*.json"))
        if not paths:
            raise ValueError(f"no scenario JSON files found in {SCENARIOS}")
        scenarios = [(path, validate_spec(json.loads(path.read_text(encoding="utf-8")), path)) for path in paths]
        reports = []
        for _, (name, sizes, steps) in scenarios:
            for size in sizes:
                result = run_scenario(name, size, steps)
                reports.append(result)
                print(f"[tui-feel] PASS {name}@{size['cols']}x{size['rows']}: {result['metrics']}", flush=True)
        pathlib.Path(args.out).write_text(json.dumps({"timing": TIMING, "scenarios": reports}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[tui-feel] report: {args.out}")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"[tui-feel] FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
