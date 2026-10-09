"""Pier agent that runs Moss inside a DeepSWE task container.

Loaded with ``--agent-import-path moss_agent:MossHarnessAgent`` and
``PYTHONPATH`` pointing at this directory. The published DeepSeek-V4.1-Flash
scaffold table is the comparison: same tasks, same verifier, only the agent
binary changes.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from pier.agents.installed.base import BaseInstalledAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

from runtime_command import deepswe_agent_command, provider_config_json

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_TARBALL = REPO_ROOT / "bench" / ".cache" / "node-v22.16.0-linux-x64.tar.gz"
MOSS_DIST = REPO_ROOT / "dist"
MOSS_NODE_MODULES = REPO_ROOT / "node_modules"


class MossHarnessAgent(BaseInstalledAgent):
    """Headless Moss, scored by Pier's task verifier."""

    @staticmethod
    def name() -> str:
        return "moss"

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name=self.name(),
            steps=[
                InstallStep(
                    user="root",
                    run="mkdir -p /opt/node /opt/moss /tmp/moss-config",
                )
            ],
            verification_command="/opt/node/bin/node /opt/moss/cli.js --version",
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        # Pier skips install() when the image fingerprint matches. The bundle is
        # uploaded at runtime, so it has to be staged on every trial.
        await super().setup(environment)
        await self._stage_bundle(environment)

    async def _stage_bundle(self, environment: BaseEnvironment) -> None:
        if not NODE_TARBALL.is_file() or not (MOSS_DIST / "cli.js").is_file():
            raise RuntimeError(
                "moss bundle missing: build dist/ and download "
                "bench/.cache/node-v22.16.0-linux-x64.tar.gz"
            )
        if not MOSS_NODE_MODULES.is_dir():
            raise RuntimeError("node_modules missing next to dist/")
        await self.exec_as_root(environment, "mkdir -p /opt/node /opt/moss /tmp/moss-config")
        await environment.upload_file(NODE_TARBALL, "/tmp/node-runtime.tar.gz")
        await environment.upload_dir(MOSS_DIST, "/opt/moss")
        await environment.upload_dir(MOSS_NODE_MODULES, "/opt/moss/node_modules")
        await self.exec_as_root(
            environment,
            "tar -xzf /tmp/node-runtime.tar.gz -C /opt/node --strip-components=1 "
            "&& test -x /opt/node/bin/node && test -f /opt/moss/cli.js "
            "&& chmod +x /opt/moss/cli.js",
        )

    def network_allowlist(self) -> NetworkAllowlist:
        domains = ["api.deepseek.com", "ai-api.d-robotics.cc"]
        base = self._get_env("DEEPSEEK_BASE_URL") or self._get_env("MOSS_BENCH_BASE_URL") or ""
        host = base.split("://", 1)[-1].split("/", 1)[0].strip()
        if host:
            domains.append(host)
        return NetworkAllowlist(domains=domains)

    def populate_context_post_run(self, context: AgentContext) -> None:
        del context

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        del context
        # The task instruction is the grader's prompt, including its commit rule.
        # Do not prepend a conflicting "leave uncommitted" note: the verifier
        # collects `git diff <base> HEAD`.
        body = instruction
        if "MOSS_TASK_EOF" in body:
            body = body.replace("MOSS_TASK_EOF", "MOSS_TASK_END")
        await self.exec_as_root(
            environment,
            "cat > /tmp/moss-task.md <<'MOSS_TASK_EOF'\n" + body + "\nMOSS_TASK_EOF",
        )
        api_key = self._get_env("DEEPSEEK_API_KEY") or self._get_env("MOSS_BENCH_API_KEY") or ""
        base_url = (
            self._get_env("DEEPSEEK_BASE_URL")
            or self._get_env("MOSS_BENCH_BASE_URL")
            or "https://api.deepseek.com"
        )
        model = self.model_name or os.environ.get("MOSS_BENCH_MODEL") or "deepseek-flash"
        if "/" in model:
            model = model.split("/", 1)[1]
        config = provider_config_json(model, base_url, api_key)
        config_path = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
                handle.write(config)
                config_path = handle.name
            os.chmod(config_path, 0o600)
            await self.exec_as_root(environment, "mkdir -p /tmp/moss-config")
            await environment.upload_file(config_path, "/tmp/moss-config/config.json")
        finally:
            if config_path:
                os.unlink(config_path)
        command, runtime = deepswe_agent_command(model, base_url, self._get_env)
        await self.exec_as_agent(environment, command, env=runtime, timeout_sec=10800)
