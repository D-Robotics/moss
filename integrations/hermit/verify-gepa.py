"""Actual official GEPA + Trainer with scripted LOCAL HTTP. Contract only, not efficacy."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading

from worker import capability, digest, train

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", required=True)
args = parser.parse_args()
assert capability(args.source_root)["evolvers"]["gepa"]["available"]
model_requests = []
runs = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        assert self.headers["Authorization"] == "Bearer offline-contract-only"
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/v1/chat/completions":
            model_requests.append(payload)
            result = {"id": "offline-contract", "object": "chat.completion", "model": "scripted-contract",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "```\nAlways include the offline-contract marker.\n```"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}}
        elif self.path == "/run":
            run_id = str(len(runs) + 1)
            passed = "offline-contract marker" in payload["instructions"]
            runs[run_id] = passed
            result = {"runId": run_id, "output": "offline-contract marker" if passed else "baseline fixture", "tokens": 0, "cost_usd": 0.0}
        elif self.path == "/score":
            result = {"score": 1.0 if runs[payload["runId"]] else 0.0, "feedback": "Fixture contract expects offline-contract marker."}
        else:
            self.send_error(404)
            return
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    import yaml
    with tempfile.TemporaryDirectory(prefix="moss-gepa-interface-") as directory:
        root = Path(directory).resolve()
        input_dir = root / "input"
        input_dir.mkdir()
        (input_dir / "tasks.jsonl").write_text('\n'.join(json.dumps({"id": name, "prompt": "scripted interface fixture"}) for name in ("train", "validation")))
        (input_dir / "train.txt").write_text("train\n")
        (input_dir / "validation.txt").write_text("validation\n")
        bridge_url = f"http://127.0.0.1:{server.server_port}"
        worker = str(Path(__file__).with_name("worker.py").resolve())
        config = {"data": {"tasks": "tasks.jsonl", "train": "train.txt", "val": "validation.txt", "step_size": 1, "shuffle": False},
            "agent": {"name": worker + ":run_task", "concurrency": 1}, "judge": {"path": worker, "name": "score_task"},
            "template": "prompt-only@1.0", "evolver": {"name": "gepa", "params": {"files": ["ADAPTER.md"], "max_tokens": 100}},
            "sandbox": {"enabled": False, "env": ["MOSS_HERMIT_JOB_BRIDGE", "MOSS_HERMIT_JOB_TOKEN"]},
            "llm": {"base_url": bridge_url + "/v1", "model": "scripted-contract", "api_key_env": "MOSS_HERMIT_JOB_TOKEN"},
            "trainer": {"run_name": "gepa-interface", "output_dir": str(root / "output"), "epochs": 2, "budget": {"tokens": 1000, "hours": 0.01}}}
        config_path = input_dir / "run.yaml"
        config_path.write_text(yaml.safe_dump(config))
        os.environ["MOSS_HERMIT_JOB_BRIDGE"] = bridge_url
        os.environ["MOSS_HERMIT_JOB_TOKEN"] = "offline-contract-only"
        os.environ["HOME"] = str(root / "home")
        os.environ["HA_BACKENDS"] = str(input_dir / "absent-user-backends.yaml")
        result = train(args.source_root, root, digest(config_path.read_bytes()), 1000)
        assert len(result["steps"]) == 2 and len(model_requests) >= 1
        assert "offline-contract marker" in result["instructions"]
        print(json.dumps({"purpose": "official GEPA/Trainer scripted HTTP interface ONLY; NOT efficacy", "modelHttpRequests": len(model_requests), "actingRuns": len(runs), **result}))
finally:
    server.shutdown()
    server.server_close()
