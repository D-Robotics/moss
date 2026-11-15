"""Official offline teaching example: API/commit proof only, never evolution efficacy."""
import argparse
import contextlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", required=True)
args = parser.parse_args()
from worker import capability
caps = capability(args.source_root)
from hermit.config import Config
from hermit.trainer.trainer import Trainer
with tempfile.TemporaryDirectory(prefix="moss-hermit-contract-") as directory:
    root = Path(directory).resolve()
    shutil.copytree(Path(args.source_root) / "docs/_examples/first_training", root / "input")
    config = Config.load(root / "input/run.yaml", overrides=[
        "trainer.output_dir=" + str(root / "output"), "trainer.run_name=offline-contract",
        "data.test=null",
    ])
    with contextlib.redirect_stdout(sys.stderr):
        trainer = Trainer(config, log=lambda _message: None)
        summary = trainer.train()
    records = [json.loads(line) for line in (trainer.run_dir / "steps.jsonl").read_text().splitlines()]
    assert summary["steps"] == 2 and len(records) == 2
    assert all(record["status"] == "done" for record in records)
    assert all(len(record["commit"]) == 40 for record in records)
    assert (trainer.checkout / "ADAPTER.md").is_file()
    print(json.dumps({"purpose": "offline teaching API contract; NOT efficacy or production method proof",
        "hermitCommit": caps["hermitCommit"], "hermitVersion": caps["hermitVersion"],
        "pythonVersion": caps["pythonVersion"], "actualEvolver": "official teaching FormatEvolver",
        "template": caps["template"], "steps": [{"step": r["step"], "commit": r["commit"], "status": r["status"]} for r in records],
        "finalCommit": summary["final_commit"], "spending": summary["spending"]}))
