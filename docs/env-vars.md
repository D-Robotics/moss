# Moss Environment Variables

All environment variables use the `MOSS_` prefix. Model settings (provider, model, baseUrl, apiKey) are managed via `moss setup` / `moss config set` — they are **never** read from env vars. Leftover `DEEPSEEK_API_KEY` etc. are ignored.

## Configuration & Profile

| Variable | Default | Description |
|---|---|---|
| `MOSS_PROFILE` | — | Config profile: `cautious` \| `balanced` \| `autonomous`. Shortcut for applying preset safety/approval/turn settings. |
| `MOSS_CONFIG_PROFILE` | — | Alias for `MOSS_PROFILE`. |
| `MOSS_CONFIG_DIR` | `~/.config/moss` | Directory for moss config files. |
| `MOSS_CONFIG_FILE` | — | Explicit config JSON path (overrides config dir discovery). |
| `MOSS_CONFIG_PATH` | — | Alias for `MOSS_CONFIG_FILE`. |
| `MOSS_WORKSPACE` | `process.cwd()` | Working directory for the agent. |
| `MOSS_BUNDLED_DEFAULT_FILE` | — | Path to a bundled default config file. |
| `MOSS_NO_BUNDLED_DEFAULT` | — | Set to `1` to skip loading the bundled default config. |

## Safety & Approval

| Variable | Default | Description |
|---|---|---|
| `MOSS_SAFETY_MODE` | `workspace-write` | Safety mode: `read-only` \| `workspace-write` \| `full-access`. |
| `MOSS_CLI_SAFETY_MODE` | — | Alias for `MOSS_SAFETY_MODE`. |
| `MOSS_CLI_AUTO_APPROVE` | — | Set to `1` to auto-approve allowed mutating tools without prompting. |
| `MOSS_AUTO_APPROVE` | — | Alias for `MOSS_CLI_AUTO_APPROVE`. |
| `MOSS_APPROVAL_POLICY` | — | Approval policy override. |
| `MOSS_ASK_FOR_APPROVAL` | — | Alias for `MOSS_APPROVAL_POLICY`. |
| `MOSS_TRUSTED_TOOLS` | — | Comma-separated list of tool names to always trust. |
| `MOSS_DENIED_TOOLS` | — | Comma-separated list of tool names to always deny. |

## Device Connection (SSH)

| Variable | Default | Description |
|---|---|---|
| `MOSS_DEVICE_HOST` | — | Device IP or hostname. Enables SSH-based board tools. |
| `MOSS_DEVICE_USER` | `root` | SSH username for the device. |
| `MOSS_DEVICE_PASSWORD` | — | SSH password (password auth). |
| `MOSS_DEVICE_PORT` | `22` | SSH port. |
| `MOSS_DEVICE_KEY` | — | Path to SSH private key file. |
| `MOSS_DEVICE_NO_VERIFY` | — | Set to `1` to skip the startup SSH reachability probe. |
| `MOSS_DEVICE_HYBRID` | — | Set to `1` to keep local tools at startup instead of switching to board mode. |

## Execution Backend

| Variable | Default | Description |
|---|---|---|
| `MOSS_EXEC_BACKEND` | `local` | Execution backend: `local` \| `docker`. |
| `MOSS_DOCKER_IMAGE` | `node:20-slim` | Docker image used when `MOSS_EXEC_BACKEND=docker`. |
| `MOSS_BROWSER_EXECUTABLE` | — | Chrome/Chromium executable path for browser tools. |

## Agent Loop

| Variable | Default | Description |
|---|---|---|
| `MOSS_MAX_AGENT_TURNS` | `64` | Maximum agent loop turns. Hard cap: 256. |
| `MOSS_CONTEXT_TOKENS` | — | Override the context window token limit. |
| `MOSS_PROMPT_CACHE` | — | Enable/disable prompt caching. |
| `MOSS_PROMPT_CACHE_ENABLED` | — | Alias for `MOSS_PROMPT_CACHE`. |
| `MOSS_PROMPT_CACHE_DEBUG` | — | Enable prompt cache debug logging. |
| `MOSS_PROMPT_PREFIX_DEBUG` | — | Alias for `MOSS_PROMPT_CACHE_DEBUG`. |
| `MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS` | `0` | Timeout for first LLM stream chunk (0 = disabled, max 3,600,000). |
| `MOSS_SELF_LEARNING` | — | Set to `true` to extract user-correction feedback as memory. |

## MCP (Model Context Protocol)

| Variable | Default | Description |
|---|---|---|
| `MOSS_MCP_ENABLED` | — | `true`/`false` to override MCP enablement from config. |
| `MOSS_MCP_CONFIG` | — | Path to MCP servers JSON file (overrides config dir). |
| `MOSS_MCP_CONFIG_FILE` | — | Alias for `MOSS_MCP_CONFIG`. |

## Mesh Networking

| Variable | Default | Description |
|---|---|---|
| `MOSS_MESH_ENABLED` | — | Set to `true` to start the agent mesh. |
| `MOSS_MESH_PORT` | `9090` | Port for mesh TCP listener. |
| `MOSS_MESH_ID` | `moss-<timestamp>` | Unique mesh node ID. |
| `MOSS_MESH_NAME` | `Moss @ <hostname>` | Human-readable mesh node name. |
| `MOSS_MESH_LISTEN_HOST` | — | Listen host for mesh TCP server. |
| `MOSS_MESH_SHARED_SECRET` | — | Shared secret for mesh peer authentication. |
| `MOSS_MESH_SECRET` | — | Alias for `MOSS_MESH_SHARED_SECRET`. |
| `MOSS_MESH_PEERS` | — | Comma-separated list of peer addresses (`host:port`). |
| `MOSS_MESH_ALLOW_INCOMING` | `true` | Set to `false` to reject incoming mesh queries. |

## Logging & Observability

| Variable | Default | Description |
|---|---|---|
| `MOSS_LOG_LEVEL` | `info` | Log level: `trace` \| `debug` \| `info` \| `warn` \| `error`. |
| `MOSS_LOG_JSON` | — | Set to `1` to format internal logs as JSON lines. |
| `MOSS_CLI_DETAIL` | `progress` | CLI output detail: `quiet` \| `progress` \| `verbose`. |
| `MOSS_SHOW_THINKING` | — | Set to `true` to print raw thinking deltas in verbose mode. |
| `MOSS_TRACE` | — | Set to `console` to emit tracing spans to stderr. |
| `MOSS_LLM_USAGE_LOG` | — | Path to append LLM usage JSONL records. |
| `MOSS_LLM_USAGE` | — | Set to `1` to enable usage logging without an explicit path. |
| `MOSS_VERBOSE_CLI` | — | Set to `true` to force verbose CLI output. |
| `MOSS_VERBOSE_TOOLS` | — | Set to `true` to force verbose tool output. |

## TUI & Display

| Variable | Default | Description |
|---|---|---|
| `MOSS_CLI_TUI` | — | Set to `0` to disable TUI and use plain REPL. |
| `MOSS_NO_COLOR` | — | Set to `1` to disable colored output. |
| `MOSS_VIM_MODE` | — | Set to `1` to enable vim keybindings in the TUI prompt. |
| `MOSS_TUI_THEME` | — | Override TUI color theme (auto-detected by default). |
| `MOSS_THEME` | — | Alias for `MOSS_TUI_THEME`. |
| `MOSS_TUI_NO_EMOJI` | — | Set to `1` to use bracket tags instead of emoji. |
| `MOSS_TUI_LOCAL_SHELL` | — | Set internally when launching a local shell session. |
| `MOSS_NO_TERM_QUERY` | — | Set to `1` to skip terminal capability queries. |
| `MOSS_GOAL_AUTO_MAX_RUNS` | — | Max auto-continuation runs for `/goal` autonomous mode. |

## Provider Internals

| Variable | Default | Description |
|---|---|---|
| `MOSS_PI_AI_TOOL_CHOICE` | — | Override tool choice for Pi-AI provider. |
| `MOSS_PI_AI_FIRST_EVENT_TIMEOUT_MS` | — | First-event timeout for Pi-AI streaming. |
| `MOSS_TRACE_PI_AI_STREAM` | — | Set to `1` to trace Pi-AI stream chunks. |
| `MOSS_DISABLE_CONN_WARMUP` | — | Set to `1` to disable connection warm-up. |

## Multi-Provider Fallback

| Variable | Default | Description |
|---|---|---|
| `MOSS_FALLBACK_PROVIDERS` | — | Comma-separated list of fallback provider names. |
| `MOSS_FALLBACK_MAX_RETRIES` | — | Max retry attempts before switching to a fallback provider. |
| `MOSS_FALLBACK_COOLDOWN_MS` | — | Cooldown (ms) before retrying a failed provider. |

## Teaching Layer

| Variable | Default | Description |
|---|---|---|
| `MOSS_TEACH_LLM_TIMEOUT_MS` | `350` | Timeout (ms) for teaching-layer LLM calls. |
| `MOSS_TEACH_CACHE_TTL_SEC` | `60` | Cache TTL (seconds) for teaching-layer responses. |

## CodeGraph Integration

| Variable | Default | Description |
|---|---|---|
| `MOSS_CODEGRAPH_CMD` | `codegraph` | Command to invoke the CodeGraph CLI. |
| `MOSS_CODEGRAPH_ENABLED` | `1` | Set to `0` to disable CodeGraph integration. |
| `MOSS_CODEGRAPH_AUTO_INIT` | `1` | Set to `0` to disable auto-initialization of CodeGraph index. |

## Eval

| Variable | Default | Description |
|---|---|---|
| `MOSS_EVAL_TIMEOUT_MS` | — | Per-task timeout (ms) for eval runs. |
| `MOSS_EVAL_CONCURRENCY` | — | Concurrency level for eval runs. |
| `MOSS_EVAL_RETRIES` | `0` | Number of retries for failed eval tasks. |

## Update Check

| Variable | Default | Description |
|---|---|---|
| `MOSS_NO_UPDATE_CHECK` | — | Set to `1`/`true`/`yes` to skip the CLI update check. |

## Hook Script Environment

These variables are set automatically by moss when invoking hook scripts. They are not user-facing configuration.

| Variable | Description |
|---|---|
| `MOSS_HOOK_EVENT` | The hook event type being fired. |
| `MOSS_TOOL_NAME` | The tool name that triggered the hook (when applicable). |
