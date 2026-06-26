<div align="center">

# Moss

**A robotics-native terminal agent that runs out of the box — and an embeddable, host-neutral agent runtime.**

Made by [D-Robotics (地瓜机器人)](https://developer.d-robotics.cc)

[![npm](https://img.shields.io/npm/v/@rdk-moss/agent.svg?color=cb3837&label=%40rdk-moss%2Fagent)](https://www.npmjs.com/package/@rdk-moss/agent)
[![npm](https://img.shields.io/npm/v/@rdk-moss/core.svg?color=3178c6&label=%40rdk-moss%2Fcore)](https://www.npmjs.com/package/@rdk-moss/core)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org)

**English** · [简体中文](./README.zh-CN.md)

</div>

---

Run `moss`, ask a question, get to work. No API key, no forced login — the first launch already talks to the built-in D-Robotics gateway. When you want your own model, billing, or private endpoint, point Moss at any OpenAI-compatible or Anthropic provider without changing the agent. `/connect` an RDK board and the whole session moves onto the device over SSH with ROS2 and diagnostics tools unlocked.

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss terminal demo" width="720" />
</p>

## Features

- 🤖 **Robotics-native** — `/connect <ip>` moves the session onto an RDK board over SSH; `device_*` diagnostics and a full `ros2_*` toolset become first-class.
- 🚀 **Zero-setup** — built-in gateway, no API key, no login. `npm i -g @rdk-moss/agent && moss` and you're talking to an agent.
- 🔌 **Bring your own model** — DeepSeek, Qwen, OpenAI, Anthropic, any OpenAI-compatible gateway, or self-hosted. Switching providers never changes the agent.
- 🧠 **Long, interruptible work** — sessions auto-save, a working-context checkpoint tracks the active task, and `moss resume` picks it back up. A goal runner drives multi-step tasks to completion.
- 🎓 **Learns while it works** — a teach-while-solve layer narrates device actions; a skill pipeline distills good runs into reviewable `SKILL.md` candidates.
- 🕸️ **Multi-agent collaboration** — a built-in AgentMesh lets agents on the same LAN share knowledge and answers.
- 🛡️ **Honest by design** — separates verified facts from inference, reports unavailable capabilities, never claims a result it did not check.
- 🧩 **Embeddable** — public contracts and npm packages, not only a standalone app. Scaffold a host with `npx create-moss-app`.
- 👁️ **Vision & browser** — analyzes screenshots with `vision_analyze`, automates web tasks with `web_browser`. Works with any vision-capable or browser-equipped model.
- 📐 **Structured & evaluated** — `generate_structured` enforces JSON Schema output; `eval` runs test suites with multiple metrics and weighted scoring.

## Quick Start

**Prerequisites:** Node.js >= 22.16 and a terminal. (Optional: an RDK board for board mode.)

```bash
npm i -g @rdk-moss/agent@latest   # Node 22.16+
moss                               # works immediately — no key, no login

moss "check disk usage on this project"   # one-shot: answer and exit
echo "list files" | moss                  # piped stdin also works
```

Inside the TUI, press **Shift+Tab** to cycle interaction modes: `plan` (read-only) → `default` (per-call approval) → `accept-edits` (auto-approve writes). Type `@` to attach files inline, or type `/help` for the full command reference.

### Connect an RDK board

```text
/connect root@192.168.1.10
Check camera, ROS2 nodes, disk space, and device health — over SSH.
```

Optional flags: `--password <pw>` · `--port 22` · `--key ~/.ssh/id_rsa` · `--no-verify` · `--hybrid`. Default credentials come from `MOSS_DEVICE_USER`, `MOSS_DEVICE_PORT`, `MOSS_DEVICE_KEY`, `MOSS_DEVICE_PASSWORD` env vars.

`/connect` verifies SSH reachability and credentials before enabling device tools. After connect, the session enters **board mode**: the default tools (`exec`, `read_file`, `write_file`, …) run on the board over SSH, and ROS2 (`ros2_topic_list`, `ros2_node_list`, `ros2_launch`, …) plus `device_*` diagnostics become available. `/disconnect` leaves board mode and restores local tools; `--hybrid` keeps local tools and only adds device tools.

### Give Moss RDK board skills

Give Moss RDK board knowledge with the open [**device-knowledge**](https://github.com/D-Robotics/device-knowledge) pack — a set of `SKILL.md` files covering model deployment, TROS/ROS2, GPIO/I2C/SPI peripherals, board diagnostics, and more.

### Use your own model

```bash
moss setup            # interactive: choose provider + model, paste the key
moss auth status      # show resolved provider/model/key source
```

Supported providers: `deepseek`, `qwen`, `openai`, `anthropic`, `openai-compatible`. Model settings live in moss config only — environment variables like `OPENAI_API_KEY` are deliberately ignored so a key exported for another tool never silently changes your provider. Priority: CLI flags / `-c key=value` > project `.moss/config.json` > `moss setup` > built-in gateway.

### Long-Running Tasks And Resume

Moss auto-saves every session. If a run is interrupted (Ctrl-C, terminal close, turn limit), the working-context checkpoint marks it **resumable** — pick up exactly where you left off:

```bash
moss resume --last         # continue the most recent session
moss --continue            # continue the most recent session in-place
moss resume <session-id>   # resume a specific session
```

A run that hits the turn limit is paused, not failed — the agent tells you to resume. Long-horizon goals survive restarts.

## Automation & Safety

Inside the TUI, press **Shift+Tab** to cycle interaction modes: `plan` (read-only) → `default` (per-call approval) → `accept-edits` (auto-approve writes). Type `/yolo` for a full-power session that auto-approves everything.

For scripts and CI, control approval with `--ask-for-approval`:

| Value | Behavior |
| --- | --- |
| `never` | No approval prompts (fully autonomous) |
| `on-request` | Prompt only when the agent asks (default) |
| `read-only` | Auto-approve read-only tools, prompt for writes |
| `workspace-write` | Auto-approve writes inside the workspace, prompt for outside |
| `full-access` | Auto-approve everything including shell commands |

Run `moss doctor` to health-check config, auth, workspace, board, and MCP setup.

## Key commands

| Command | Purpose |
| --- | --- |
| `moss` | Start the interactive session |
| `moss "a task"` | One-shot: answer and exit |
| `moss resume --last` | Continue the most recent session |
| `/connect <ip>` · `/disconnect` | Enter / leave board mode |
| `/status` · `/model` | Show state · switch model |
| `/goal <condition>` | Run until a goal is met |
| `/sessions` · `/resume` | List · switch saved conversations |
| `/diff` · `/review` | Show changes · review for bugs |
| `/mcp` · `/doctor` | Inspect MCP servers · health-check |
| `/compact` · `/clear` | Compress history · new conversation |

## Architecture

A TypeScript, ESM, npm-workspaces monorepo (Node >= 22.16.0) split around a narrow **host boundary**: the host owns model keys, UI, storage, telemetry, device access; Moss owns the agent loop, tool pipeline, context/memory/skills primitives, and host-neutral safety.

| Package | npm name | Role |
| --- | --- | --- |
| `packages/moss` | `@rdk-moss/core` | Core contracts: `KnowledgeModule`, `PlatformExtension`, `VendorPlugin`, the versioned **Host Adapter** contract, `AsyncTask`, and robotics/software engineering prompts. Zero host dependencies, vendor-neutral. |
| `packages/moss-agent` | `@rdk-moss/agent` | Standalone agent runtime + `moss` CLI: agent loop, tool framework, context management, providers, safety. In-tree subsystems (memory, skills, skill-learning, teaching, mesh, mcp, observability) exposed via subpath exports. |
| `packages/create-moss-app` | `create-moss-app` | Minimal project scaffolding (`minimal` / `openai` templates). |

### Embed Moss in your product

```bash
npx create-moss-app my-host
```

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';
```

A host registers its providers/tools/storage/approval gates, publishes a `MossHostRuntimeManifest`, and runs `evaluateMossHostCompatibility()` in CI before adopting a release. See [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md) for the full surface and version policy.

## Documentation

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, commands, boundaries, and how to send a PR.
- [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md) — Host Adapter contract guide and version policy.
- [`AGENTS.md`](./AGENTS.md) — agent working rules, architecture-review discipline, bug-fix checklists.

## Contributing

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss && npm install
npm run verify   # boundaries + hygiene + build + typecheck + lint + test
```

Moss's north star is a **robot-grade, host-neutral runtime**. Before proposing a feature, check the scope rules in [`AGENTS.md`](./AGENTS.md) — anything that hard-codes a robot family or vendor workflow into core belongs in a host adapter, knowledge module, or platform extension instead.

## License

[MIT © D-Robotics](./LICENSE)
