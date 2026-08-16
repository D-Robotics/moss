"""Canonical Harbor adapter for an exact published Moss CLI version.

Run with:
  harbor run -d terminal-bench/terminal-bench-2 \
    --agent benchmarks.harbor.moss_agent:MossAgent \
    --agent-version "$MOSS_HARBOR_AGENT_VERSION" -m "openai/$MOSS_MODEL" -k 5
"""

import os
import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, EnvVar, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class MossAgent(BaseInstalledAgent):
    """Install and execute Moss inside one Harbor task environment."""

    MODEL_CONNECTION = ModelConnectionSpec(default_provider="openai", passthrough=True)
    ENV_VARS = [
        EnvVar("api_key", env="OPENAI_API_KEY", type="str", env_fallback="OPENAI_API_KEY"),
        EnvVar("base_url", env="OPENAI_BASE_URL", type="str", env_fallback="OPENAI_BASE_URL"),
    ]

    @staticmethod
    @override
    def name() -> str:
        return "moss"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; moss --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._version:
            raise ValueError("Moss Harbor runs require an exact --agent-version")
        await self.ensure_system_dependencies(environment, ("curl", "git", "ripgrep"))
        package = shlex.quote(f"@rdk-moss/agent@{self._version}")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {package} && moss --version"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        env = dict(self.model_connection.env)
        model = self.model_name.split("/", 1)[-1] if self.model_name else os.getenv("MOSS_MODEL")
        if not model:
            raise ValueError("Moss Harbor runs require an exact model")
        env["MOSS_MODEL"] = model
        prompt = shlex.quote(instruction)
        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                "moss --print --output-format stream-json --accept-edits "
                "--workspace-write --ask-for-approval never --max-turns 64 "
                f"--no-color --quiet {prompt} "
                "2>&1 | stdbuf -oL tee /logs/agent/moss.jsonl"
            ),
            env=env,
        )
