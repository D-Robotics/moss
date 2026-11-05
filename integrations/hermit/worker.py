"""Optional official Hermit subprocess. No provider credentials, optimizer or judge here."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request

COMMIT = "2c9d94a1b1437d1c66b80aab05cb0262f557e6d7"
VERSION = "0.2.0"
TEMPLATE = "prompt-only@1.0"
MAX_BYTES = 8192
GEPA_COMMIT = "d771eb21b5dd3228bc3f567293d2ccfc423fc900"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, root=None):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("regular_file_required")
    real = path.resolve(strict=True)
    if root is not None and not real.is_relative_to(Path(root).resolve()):
        raise ValueError("path_outside_owned_root")
    # Reject symlinked ancestor directories, including dangling links.
    if root is not None:
        cursor = path.absolute()
        if not cursor.is_relative_to(Path(root).resolve()):
            raise ValueError("noncanonical_path_forbidden")
        while cursor != Path(root).resolve():
            if cursor.is_symlink():
                raise ValueError("symlink_not_supported")
            cursor = cursor.parent
    return real


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True,
                                   timeout=10, stderr=subprocess.DEVNULL).strip()


def capability(source):
    source = Path(source).resolve(strict=True)
    if git(source, "rev-parse", "HEAD") != COMMIT or git(source, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("upstream_checkout_identity_mismatch")
    import hermit
    from hermit.config import Config
    from hermit.trainer.trainer import Trainer
    from hermit.agent.evolver.loader import BUILTIN, find, load_class
    if not Path(hermit.__file__).resolve().is_relative_to(source):
        raise ValueError("imported_upstream_identity_mismatch")
    version = importlib.metadata.version("hermit-harness")
    if version != VERSION or sys.version_info < (3, 12):
        raise ValueError("upstream_runtime_identity_mismatch")
    reasons = []
    if sys.platform != "linux":
        reasons.append("linux_required_for_required_bubblewrap_sandbox")
    if not shutil.which("bwrap"):
        reasons.append("bubblewrap_unavailable")
    evolvers = {}
    for method in ("codex", "gepa"):
        spec = find(method)
        if spec.directory != (BUILTIN / method).resolve():
            raise ValueError("official_evolver_identity_mismatch")
        load_class(spec)
        failures = list(reasons) if method == "codex" else []
        if method == "codex":
            if not shutil.which("codex"):
                failures.append("codex_cli_unavailable")
            failures.append("responses_endpoint_requires_host_preflight")
        elif importlib.util.find_spec("gepa") is None:
            failures.append("optional_gepa_dependency_unavailable")
        else:
            provenance = json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json") or "{}")
            if provenance.get("vcs_info", {}).get("commit_id") != GEPA_COMMIT:
                failures.append("gepa_dependency_identity_mismatch")
        evolvers[method] = {"available": not failures, "reasons": failures}
    return {"hermitCommit": COMMIT, "hermitVersion": version,
            "pythonVersion": platform.python_version(), "platform": sys.platform,
            "trainerApi": callable(Trainer.train) and callable(Config.load),
            "template": TEMPLATE, "gepaCommit": GEPA_COMMIT, "evolvers": evolvers,
            "available": evolvers["gepa"]["available"], "reasons": evolvers["gepa"]["reasons"]}


def adapter_text(adapter):
    if Path(adapter).is_symlink():
        raise ValueError("symlink_not_supported")
    root = Path(adapter).resolve(strict=True)
    # Export exactly context text; never load candidate code, tools, hooks or roles.
    export = regular(root / "exports.yaml", root).read_text()
    import yaml
    if yaml.safe_load(export) != {"context": "ADAPTER.md"}:
        raise ValueError("unsupported_adapter_exports")
    for entry in root.rglob("*"):
        if entry.is_symlink():
            raise ValueError("symlink_not_supported")
    data = regular(root / "ADAPTER.md", root).read_bytes()
    if not data.strip() or len(data) > MAX_BYTES or b"\0" in data:
        raise ValueError("adapter_text_invalid")
    return data.decode("utf-8")


def bridge(route, payload):
    from urllib.parse import urlsplit
    base = os.environ["MOSS_HERMIT_JOB_BRIDGE"]
    parsed = urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("bridge_invalid")
    request = urllib.request.Request(base.rstrip("/") + route,
        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json",
        "Authorization": "Bearer " + os.environ["MOSS_HERMIT_JOB_TOKEN"]}, method="POST")
    # No proxy environment or redirects; job capability must stay at the loopback host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            raise ValueError("bridge_redirect_forbidden")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=120) as response:
        data = response.read(1_048_577)
    if len(data) > 1_048_576:
        raise ValueError("bridge_response_limit")
    return json.loads(data)


def run_task(task, adapter):
    from hermit.task import RunOutput
    text = adapter_text(adapter)
    result = bridge("/run", {"taskId": task["id"], "instructions": text,
                            "adapterDigest": digest(text.encode())})
    return RunOutput(output=result["output"], tokens=result.get("tokens"),
                     cost_usd=result.get("cost_usd"), messages=result.get("messages"),
                     extra={"runId": result["runId"], "adapterDigest": digest(text.encode())})


def score_task(task, output):
    from hermit.task import JudgeResult
    result = bridge("/score", {"taskId": task["id"], "runId": output.extra["runId"],
                              "adapterDigest": output.extra["adapterDigest"]})
    score = result["score"]
    if not isinstance(score, (float, int)) or isinstance(score, bool) or not 0 <= score <= 1:
        raise ValueError("judge_score_invalid")
    return JudgeResult(score=score, feedback=str(result.get("feedback", "")), extra=result.get("extra", {}))


def train(source, job, expected, training_token_limit):
    from hermit.config import Config
    from hermit.trainer.trainer import Trainer
    from hermit.agent.evolver.loader import BUILTIN, find
    caps = capability(source)
    job = Path(job).resolve(strict=True)
    config_path = regular(job / "input" / "run.yaml", job)
    if digest(config_path.read_bytes()) != expected:
        raise ValueError("config_digest_mismatch")
    config = Config.load(config_path)
    d = config.data
    method = d["evolver"]["name"]
    if method != "gepa" or not caps["evolvers"]["gepa"]["available"]:
        raise ValueError("required_official_method_runtime_unavailable")
    if find(method, config.base).directory != (BUILTIN / method).resolve():
        raise ValueError("local_evolver_shadow_forbidden")
    worker = str(Path(__file__).resolve())
    if d["agent"]["name"] != worker + ":run_task" or str(config.path(d["judge"]["path"])) != worker or d["judge"]["name"] != "score_task":
        raise ValueError("trusted_host_pipeline_required")
    if d["agent"]["params"] or d["data"]["test"] or d["task_info"] or d["start_from"] or d["backends"]:
        raise ValueError("unsupported_training_inputs")
    if str(d["template"]) != TEMPLATE or config.template_dir() != (Path(source) / "hermit/adapter/templates/prompt_only").resolve():
        raise ValueError("official_template_required")
    if d["evolver"]["params"].get("files", ["ADAPTER.md"]) != ["ADAPTER.md"]:
        raise ValueError("only_adapter_text_is_learnable")
    access = d["evolver_access"]
    if access["tools"] or access["environment"] or access["send_material_out"]:
        raise ValueError("external_tools_and_environment_forbidden")
    sandbox = d["sandbox"]
    if sandbox["enabled"] or sandbox["read"] or sandbox["allow"] or sandbox["profiles"]:
        raise ValueError("trusted_text_method_has_no_local_shell_sandbox_or_custom_profiles")
    if set(sandbox["env"] or []) != {"MOSS_HERMIT_JOB_BRIDGE", "MOSS_HERMIT_JOB_TOKEN"} or sandbox["env"] is None:
        raise ValueError("explicit_capability_environment_required")
    for key in ("tasks", "train", "val"):
        regular(config.path(d["data"][key]), job / "input")
    from hermit.task import TaskData
    tasks = TaskData(config.path(d["data"]["tasks"]), config.path(d["data"]["train"]), config.path(d["data"]["val"]), None)
    if tasks.overlaps() or not tasks.splits["val"] or set(tasks.tasks) != set(tasks.splits["train"] + tasks.splits["val"]):
        raise ValueError("training_validation_split_invalid")
    if d["trainer"]["epochs"] != 2 or d["data"]["step_size"] != len(tasks.splits["train"]):
        raise ValueError("exactly_two_training_steps_required")
    budget = d["trainer"]["budget"]
    if not isinstance(training_token_limit, int) or training_token_limit <= 0 or budget["tokens"] != training_token_limit:
        raise ValueError("frozen_training_budget_required")
    for output in (config.run_dir(), config.tree_dir("prompt-only")):
        if not output.resolve().is_relative_to(job / "output") or output.exists():
            raise ValueError("fresh_owned_output_required")
    # Reflection model must go through the job host's per-HTTP token reservation proxy.
    llm = d["llm"]
    if not isinstance(llm, dict) or llm.get("cli") or llm.get("api_key_env") != "MOSS_HERMIT_JOB_TOKEN" or llm.get("base_url") != os.environ["MOSS_HERMIT_JOB_BRIDGE"] + "/v1":
        raise ValueError("metered_job_model_proxy_required")
    (job / "home").mkdir(exist_ok=True)
    with contextlib.redirect_stdout(sys.stderr):
        trainer = Trainer(config, python=sys.executable, log=lambda _message: None)
        summary = trainer.train()
    if digest(config_path.read_bytes()) != expected:
        raise ValueError("config_changed_during_run")
    text = adapter_text(trainer.checkout)
    steps = [json.loads(line) for line in regular(trainer.run_dir / "steps.jsonl", job).read_text().splitlines() if line.strip()]
    if len(steps) != 2 or any(s.get("bootstrap") or s["status"] != "done" for s in steps):
        raise ValueError("two_completed_official_steps_required")
    return {"hermitCommit": COMMIT, "hermitVersion": VERSION, "gepaCommit": GEPA_COMMIT, "method": "gepa", "runId": summary["run"],
            "finalCommit": summary["final_commit"], "instructions": text,
            "instructionsSha256": digest(text.encode()),
            "summarySha256": digest(regular(trainer.run_dir / "summary.json", job).read_bytes()),
            "steps": [{"step": s["step"], "commits": s["commits"], "status": s["status"]} for s in steps]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("probe", "train"))
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--job-dir")
    parser.add_argument("--config-sha256")
    parser.add_argument("--training-token-limit", type=int)
    args = parser.parse_args()
    result = capability(args.source_root) if args.mode == "probe" else train(args.source_root, args.job_dir, args.config_sha256, args.training_token_limit)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Neither provider bodies, prompts nor capabilities cross the failure channel.
        print("hermit_worker_failed", file=sys.stderr)
        sys.exit(1)
