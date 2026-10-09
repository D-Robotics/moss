"""Host-side command for the Moss process inside a DeepSWE container.

Pier runs this agent on the host. ``exec_as_agent`` only forwards an explicit
``env`` dict into the sandbox, so a shell ``${MOSS_TEMPERATURE:-1}`` reads the
container and ignores the job. Bake the host values into the script.
"""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable


def pick_env(getenv: Callable[[str], str | None], name: str, default: str) -> str:
    raw = getenv(name)
    if raw is None:
        return default
    text = str(raw).strip()
    return text if text else default


def provider_config_json(model: str, base_url: str, api_key: str) -> str:
    return json.dumps(
        {
            "provider": "openai-compatible",
            "model": model,
            "baseUrl": base_url,
            "apiKey": api_key,
        },
        ensure_ascii=False,
    )


def deepswe_agent_command(
    model: str, base_url: str, getenv: Callable[[str], str | None]
) -> tuple[str, dict[str, str]]:
    temperature = pick_env(getenv, "MOSS_TEMPERATURE", "1")
    top_p = pick_env(getenv, "MOSS_TOP_P", "0.95")
    max_turns = pick_env(getenv, "MOSS_DEEPSWE_MAX_TURNS", "80")
    runtime = {
        "MOSS_TEMPERATURE": temperature,
        "MOSS_TOP_P": top_p,
        "MOSS_DEEPSWE_MAX_TURNS": max_turns,
        "MOSS_CONFIG_DIR": "/tmp/moss-config",
        "MOSS_SAFETY_MODE": "workspace-write",
        "MOSS_APPROVAL_POLICY": "never",
        "MOSS_NO_COLOR": "1",
    }
    node = (
        "/opt/node/bin/node /opt/moss/cli.js -p --output-format stream-json "
        "--ask-for-approval never "
        f"--model {shlex.quote(model)} --base-url {shlex.quote(base_url)} "
        f"--max-turns {shlex.quote(max_turns)} "
        '"$(cat /tmp/moss-task.md)" > /logs/agent/moss-run.log 2>&1 || true'
    )
    script = "\n".join(
        [
            "export PATH=/opt/node/bin:$PATH",
            "export NODE_OPTIONS='--dns-result-order=ipv4first'",
            "test -f /opt/moss/cli.js",
            f"export MOSS_CONFIG_DIR={shlex.quote(runtime['MOSS_CONFIG_DIR'])}",
            f"export MOSS_TEMPERATURE={shlex.quote(temperature)}",
            f"export MOSS_TOP_P={shlex.quote(top_p)}",
            f"export MOSS_SAFETY_MODE={shlex.quote(runtime['MOSS_SAFETY_MODE'])}",
            f"export MOSS_APPROVAL_POLICY={shlex.quote(runtime['MOSS_APPROVAL_POLICY'])}",
            "export MOSS_NO_COLOR=1",
            "cd /app",
            "mkdir -p /logs/agent",
            node,
        ]
    )
    return script, runtime
