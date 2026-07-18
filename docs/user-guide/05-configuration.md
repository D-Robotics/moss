# Configuration

Moss configuration lives in `~/.config/moss/config.json` (or a project
`.moss/config.json`). Inspect and change it with `moss config`, or set flags
per-run. Run `moss doctor` to validate the resolved config.

## See the resolved config

```sh
moss config                # show resolved values + where each came from
moss config show --json    # redacted JSON, safe for scripts
moss config validate       # check config files + audit warnings
moss config validate --strict  # fail when audit warnings are present
moss config init           # create a user or project config file
```

Priority order: CLI flags / `-c` overrides > environment variables > config
files > built-in defaults. For most fields the project `.moss/config.json`
overrides the user `~/.config/moss/config.json`; **safety-sensitive fields
(`approvalPolicy`, `safetyMode`, `trustedTools`, `deniedTools`) are the
exception — the USER's config wins over the PROJECT's**, so a cloned repo
cannot silently lower your safety stance. CLI flags and env vars override
both.

## Provider, model, and API key

The built-in D-Robotics model needs no key. To use your own:

```sh
moss setup                       # guided: provider, base URL, API key, model
moss config set provider deepseek
moss config set baseUrl https://api.deepseek.com    # API root, no /v1 (it's stripped)
moss config set model deepseek-v4-flash
```

`moss setup` is the recommended way to set an API key (it persists encrypted;
`config set apiKey=…` also works but leaks the key into shell history). The
`baseUrl` must be the API root — `/v1`, endpoint paths, and query strings are
stripped. Providers: `deepseek` · `qwen` · `openai` · `anthropic` ·
`openai-compatible`.

Per-run overrides:

```sh
moss --provider openai-compatible --base-url https://api.example.com/v1 -m gpt-4o
moss -c provider=openai-compatible -c model=gpt-4o
```

In-session, `/model` switches the model for the current session and
`/model config base_url=… key=… model_name=…` adds a custom one (the key
persists to disk — prefer `moss setup` for hidden-key entry).

## Safety mode and approval policy

Moss separates two axes: the **safety mode** (the ceiling — what tool classes
are even considered) and the **approval policy** (whether moss asks before a
mutating action that the safety mode allows).

**Safety mode** (`--workspace-write`, `--full-access`, `MOSS_SAFETY_MODE`, or
`config set safetyMode`):

| Mode | What's allowed |
|---|---|
| `read-only` | only read-only actions; everything else blocked |
| `workspace-write` | workspace file writes + exec inside the workspace; **device/external mutations are blocked, not prompted** |
| `full-access` | everything, including device/external tools (the ceiling) |

**Approval policy** (`--ask-for-approval` or `config set approvalPolicy`) —
only two real values persist; other flag spellings normalize:

| Policy | Behavior |
|---|---|
| `prompt` | ask before each mutating action (`on-request` normalizes to this) |
| `never` | auto-approve what the safety mode allows; `deniedTools`, the hard-blocklist, and plan mode still block |

The `--ask-for-approval` flag also accepts `read-only` / `workspace-write` /
`full-access` as a shortcut — these set the **safety mode**, not an approval
policy. The profile shortcuts map to bundles of both:

```sh
moss config set profile cautious      # cautious | balanced | autonomous
moss --workspace-write                # safety mode = workspace-write
moss --full-access                    # safety mode = full-access
moss --ask-for-approval prompt        # approval policy
```

In-session, `/permissions` shows the resolved safety mode + approval policy +
how to change them. There is no `/yolo` command — use `--full-access` or
`/permissions` to raise the safety mode.

Tool allow/deny lists:

```sh
moss config set trustedTools "read_file,search_code,exec"   # auto-approve after safety checks
moss config set deniedTools "device_exec"                    # always block
```

## Context budget and turn limits

The model's context window is probed per provider on first use. Override it
explicitly with the `MOSS_CONTEXT_TOKENS` env var or the `agent.contextTokens`
config key (use these when probing is wrong for your model):

```sh
moss config set agent.contextTokens 120000   # config override
MOSS_CONTEXT_TOKENS=120000 moss ...          # env override
moss config set agent.maxTurns 40            # per-request agent turn budget
```

In-session, `/context` shows current usage; `/compact` compresses when full.

## Guardrails

A 2×2 matrix — input vs output, redact vs block:

- `guardrails.input.redactPatterns` — scrub matching user text before it leaves.
- `guardrails.input.blockPatterns` — reject matching user input outright.
- `guardrails.output.redactPatterns` — scrub matching model output.
- `guardrails.output.blockPatterns` — stop matching responses.

```sh
moss config set guardrails.input.redactPatterns "AKIA[0-9A-Z]{16}"
moss config set guardrails.output.blockPatterns "forbidden-token"
moss config set promptCacheDebug true        # prompt-prefix cache diagnostics
```

## More config operations

```sh
moss config unset provider                  # remove a stored override
moss config set --project trustedTools=read_file  # write to project config
moss config set provider=deepseek model=deepseek-v4-flash   # batch
moss config validate --json                 # audit warnings as JSON
moss config init --project --force          # create/overwrite a project config file
```

## MCP servers

```sh
moss config set mcp.enabled true
moss config set mcp.configPath ~/.config/moss/mcp.json
moss mcp list
moss mcp add filesystem "npx" "-y" "@modelcontextprotocol/server-filesystem" /workspace
moss mcp remove filesystem
```

See [MCP servers](README.md) for the index (a dedicated MCP page is being
written). In-session, `/mcp` shows connection status + tool counts.

## Config file locations

| File | Scope |
|---|---|
| `~/.config/moss/config.json` | user (all projects) |
| `<project>/.moss/config.json` | project (overrides user) |
| `MOSS_CONFIG_FILE=<path>` | explicit file (overrides both) |

Run `moss config` to see which file each value came from.
