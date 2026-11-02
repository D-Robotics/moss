#!/usr/bin/env python3
"""Prove the benchmark does not use fallback settings from an install .env."""
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root / "scripts/tui-feel"))
from screen import Session  # noqa: E402

# The test supplies only synthetic configuration and loopback endpoints.
os.environ.clear()
os.environ.update({"PATH": sys.argv[2], "LANG": "en_US.UTF-8"})
counts = {"primary": 0, "fallback": 0}


class Primary(BaseHTTPRequestHandler):
    def do_POST(self):
        counts["primary"] += 1
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"synthetic server error"}}')

    def log_message(self, *args):
        pass


class Fallback(BaseHTTPRequestHandler):
    def do_POST(self):
        counts["fallback"] += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b'data: {"choices":[{"index":0,"delta":{"content":"fallback reached"}}]}\n\n')
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *args):
        pass


primary = ThreadingHTTPServer(("127.0.0.1", 0), Primary)
fallback = ThreadingHTTPServer(("127.0.0.1", 0), Fallback)
for server in (primary, fallback):
    threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    fallback_config = [{
        "provider": "openai-compatible", "model": "stub-model",
        "baseUrl": f"http://127.0.0.1:{fallback.server_port}/v1", "apiKey": "synthetic-fallback",
    }]
    (root / ".env").write_text(
        "MOSS_FALLBACK_PROVIDERS=" + json.dumps(fallback_config) + "\n"
        "MOSS_FALLBACK_MAX_RETRIES=1\n", encoding="utf-8"
    )

    def probe(isolated):
        before_primary, before_fallback = counts["primary"], counts["fallback"]
        with Session(
            initial_pump=0,
            isolated_env=isolated,
            config={"baseUrl": f"http://127.0.0.1:{primary.server_port}/v1"},
            extra_env={"MOSS_LANG": "en", "MOSS_NO_TUI": "0"},
        ) as session:
            if not session.wait_for(lambda: session.prompt_rows() or session.proc.poll() is not None, 15):
                raise AssertionError("CLI did not paint a composer")
            if session.proc.poll() is not None:
                raise AssertionError(f"CLI exited {session.proc.returncode}: {bytes(session.raw)[-4000:]!r}")
            # Let Ink attach its raw-mode input handler before sending the request.
            session.pump(0.5)
            session.send("fallbackprobe\r")
            deadline = time.monotonic() + 12
            after_primary = None
            while time.monotonic() < deadline:
                session.pump(0.1)
                if session.proc.poll() is not None:
                    raise AssertionError(f"CLI exited during fallback probe: {session.proc.returncode}")
                if counts["fallback"] > before_fallback:
                    break
                if counts["primary"] > before_primary and after_primary is None:
                    # Give a retryable failure time to reach the router; an
                    # immediate screen check can precede the fallback attempt.
                    after_primary = time.monotonic() + 5
                if after_primary is not None and time.monotonic() >= after_primary:
                    break
            return counts["primary"] - before_primary, counts["fallback"] - before_fallback

    control_primary, control_fallback = probe(False)
    if control_primary < 1 or control_fallback < 1:
        raise AssertionError(f"synthetic fallback positive control not reached: {counts}")
    isolated_primary, isolated_fallback = probe(True)
    if isolated_primary < 1 or isolated_fallback != 0:
        raise AssertionError(f"isolated session used synthetic fallback: primary={isolated_primary}, fallback={isolated_fallback}")

    # Probe the real dotenv loader using only synthetic files inside the copied
    # install. Non-routing variables are assigned immediately on import.
    (root / "dist/cli.js").write_text(
        "import fs from 'node:fs';\n"
        "await import('./cli/config.js');\n"
        "fs.writeFileSync(process.env.MOSS_PROBE_OUTPUT, process.env.MOSS_TUI_INCREMENTAL ?? 'unset');\n",
        encoding="utf-8",
    )
    output = root / "incremental-result"

    def dotenv_probe(isolated):
        if output.exists():
            output.unlink()
        with Session(initial_pump=0, isolated_env=isolated,
                     extra_env={"MOSS_PROBE_OUTPUT": str(output)}) as session:
            code = session.proc.wait(timeout=15)
            if code != 0:
                session.pump(0.1)
                raise AssertionError(f"dotenv probe exited {code}: {bytes(session.raw)[-4000:]!r}")
        return output.read_text(encoding="utf-8")

    for relative in ("dist/.env", "dist/cli/.env"):
        synthetic_env = root / relative
        synthetic_env.write_text("MOSS_TUI_INCREMENTAL=0\n", encoding="utf-8")
        try:
            control_value = dotenv_probe(False)
            isolated_value = dotenv_probe(True)
            if control_value != "0" or isolated_value != "unset":
                raise AssertionError(f"{relative} leaked into isolated CLI: control={control_value}, isolated={isolated_value}")
        finally:
            synthetic_env.unlink()
    mixed_case_env = root / "dist/cli/.Env"
    mixed_case_env.write_text("MOSS_TUI_INCREMENTAL=0\n", encoding="utf-8")
    try:
        with Session(initial_pump=0, isolated_env=True,
                     extra_env={"MOSS_PROBE_OUTPUT": str(output)}) as session:
            if (Path(session.home) / "install/dist/cli/.Env").exists():
                raise AssertionError("mixed-case .Env was copied into the isolated install")
            if session.proc.wait(timeout=15) != 0:
                raise AssertionError("mixed-case dotenv probe failed")
    finally:
        mixed_case_env.unlink()
    print("[PASS] synthetic dist/.env and dist/cli/.env excluded (control=0, isolated=unset)")

    polluted_temp = root / "polluted-temp"
    polluted_temp.mkdir()
    previous_temp = tempfile.tempdir
    tempfile.tempdir = str(polluted_temp)
    try:
        try:
            with Session(isolated_env=True):
                raise AssertionError("a temp directory under a .env ancestor was accepted")
        except RuntimeError as error:
            if ".env ancestor" not in str(error):
                raise
    finally:
        tempfile.tempdir = previous_temp
    print(f"[PASS] synthetic 503 fallback: control={control_primary}/{control_fallback}, "
          f"isolated={isolated_primary}/{isolated_fallback} (primary/fallback requests)")
finally:
    for server in (primary, fallback):
        server.shutdown()
        server.server_close()
