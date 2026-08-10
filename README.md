<div align="center">

<img src="docs/assets/moss-logo.png" alt="Moss" width="96" />

# Moss

**A terminal agent and TypeScript harness for coding, research, automation, and robotics.**

Built by [D-Robotics (地瓜机器人)](https://developer.d-robotics.cc)

[![CI](https://github.com/D-Robotics/moss/actions/workflows/ci.yml/badge.svg)](https://github.com/D-Robotics/moss/actions/workflows/ci.yml)
[![npm agent](https://img.shields.io/npm/v/@rdk-moss/agent.svg?label=%40rdk-moss%2Fagent&color=d4622a)](https://www.npmjs.com/package/@rdk-moss/agent)
[![npm core](https://img.shields.io/npm/v/@rdk-moss/core.svg?label=%40rdk-moss%2Fcore&color=0891b2)](https://www.npmjs.com/package/@rdk-moss/core)
[![Node](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**English** · [简体中文](./README_CN.md)

</div>

Moss works in a repository like a coding agent, researches current information
through multiple web paths, and connects to robot development boards over
persistent SSH. The same runtime can also be embedded in a TypeScript app, or
driven over the ACP wire protocol by an IDE.

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss interactive terminal" width="780" />
</p>

## Quick start

Requires **Node.js ≥ 22.16**. The published CLI ships a ready-to-use
D-Robotics model — **no personal API key needed** for the first run.

```bash
npm install -g @rdk-moss/agent@latest
cd your-project
moss
```

```bash
moss                                  # interactive TUI
moss "review the current diff"        # one-shot task
moss resume --last                    # resume the latest session
moss doctor                           # diagnose the local setup
moss --help --all                     # complete CLI reference
```

## Why Moss

- **Controllable while running** — steer the active task, queue follow-ups, ask an isolated BTW question, inspect details, or stop safely.
- **Built for long work** — named sessions, persistent goals, context pruning + compaction, resumable state, an optional autonomous loop.
- **Safe by default** — the `balanced` profile supports normal dev while asking before sensitive actions; unrestricted execution is explicit.
- **Evidence-oriented research** — search, direct fetch, RSS discovery, browser reading, and parallel source collection instead of trusting one result.
- **First-class robotics** — persistent device sessions, environment discovery, board diagnostics, USB/MIPI cameras, ROS 1/2 tools.
- **A real harness, not only a CLI** — providers, sessions, tools, hooks, approvals, usage events, async tasks, knowledge, skills, MCP, host adapters, and an ACP stdio server are public contracts.

## Three ways to run

| Mode                 | Command                                                                       | Use for                                                                       |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Interactive TUI**  | `moss`                                                                        | Daily coding + research with streaming output, tool approval, slash commands. |
| **One-shot / piped** | `moss "prompt"` · `echo … \| moss` · `--json` / `--output-format stream-json` | Scripts, CI, pipelines.                                                       |
| **ACP stdio server** | `moss agent stdio`                                                            | IDE / editor embedding via JSON-RPC (host-neutral wire protocol).             |

## Documentation

Topic-focused user guides live in [`docs/user-guide/`](./docs/user-guide/):

- [Getting started](./docs/user-guide/01-getting-started.md) · [Slash commands](./docs/user-guide/04-slash-commands.md) · [Configuration](./docs/user-guide/05-configuration.md)
- [Sessions](./docs/user-guide/17-sessions.md) · [Background tasks](./docs/user-guide/20-background-tasks.md) · [Doctor](./docs/user-guide/doctor.md)
- [Skills](./docs/user-guide/08-skills.md) · [MCP servers](./docs/user-guide/07-mcp-servers.md) · [Plan mode](./docs/user-guide/19-plan-mode.md) · [Sandbox & permissions](./docs/user-guide/18-sandbox.md)

For host authors + contributors: start from the audience-based [`docs/README.md`](./docs/README.md), then use [`packages/moss-agent/EXTENDING.md`](./packages/moss-agent/EXTENDING.md), [`packages/moss-agent/API.md`](./packages/moss-agent/API.md), or [`AGENTS.md`](./AGENTS.md). Design notes describe intent; source, tests, manifests, and API reports decide current behavior.

## Embed the runtime

```bash
npm install @rdk-moss/agent @rdk-moss/core
npx create-moss-app my-agent   # scaffold a new host
```

```ts
import {
  InMemorySessionStore,
  MossAgent,
  OpenAILLMProvider,
  registerBuiltinTools,
} from '@rdk-moss/agent';

const agent = new MossAgent({
  llmProvider: new OpenAILLMProvider({
    apiKey: process.env.MY_MODEL_API_KEY!,
    baseUrl: 'https://your-provider.example/v1',
    defaultModel: 'your-model',
  }),
  sessionStore: new InMemorySessionStore(),
  model: 'your-model',
  workspaceDir: process.cwd(),
  hooks: {
    onBeforeToolExec: async ({ tool }) =>
      tool.metadata?.sideEffectClass === 'readonly'
        ? { approved: true }
        : { approved: false, reason: 'Host approval required' },
  },
});
registerBuiltinTools(agent);

for await (const event of agent.streamChat('session-1', 'Check project health')) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
}
await agent.close();
```

The public runtime: provider, session-store, streaming event + `ChatResult` contracts; built-in + custom tools, approvals, hooks, guardrails, structured output; context budgets, pruning, compaction, prompt-cache + usage telemetry; knowledge, memory, skills, capability packs, MCP, platform extensions; async tasks, device SSH, robotics helpers, diagnostics. See [`EXTENDING.md`](./packages/moss-agent/EXTENDING.md) + [`API.md`](./packages/moss-agent/API.md).

## Configuration & permissions

The default profile is `balanced` (normal dev with approval for sensitive actions); `readonly` and `autonomous` are the bounds. Safety-sensitive fields (`approvalPolicy`, `safetyMode`, `trustedTools`, `deniedTools`) are user-over-project — a cloned repo cannot lower your safety stance.

```bash
moss setup          # guided: provider, base URL, API key, model
moss config --help  # all config keys + sources
moss doctor         # health-check the resolved config
```

See [Configuration](./docs/user-guide/05-configuration.md) + [Sandbox & permissions](./docs/user-guide/18-sandbox.md).

## Architecture

```text
packages/moss/              provider-neutral contracts + prompt policy
packages/moss-agent/        runtime, loop, context, tools, TUI, CLI, robotics, ACP
packages/create-moss-app/  embeddable agent project scaffolding
docs/                      design notes, architecture, benchmarks, user guide
scripts/                   verification, release, benchmark, smoke tooling
```

The core loop stays provider-neutral. Coding, research, robotics, and host-specific behavior compose through tools, prompt layers, capability packs, skills, knowledge modules, and adapters — not one monolithic mode.

## Develop

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci                    # install the exact package-lock dependency graph
npm run check             # canonical fast gate (includes maintainability + standards regressions)
npm run verify            # full gate: check + benchmark + build + API + all package tests
npm run smoke:moss-cli   # pack workspaces, install, verify the CLI + PTY startup
```

Contribution guidance in [`CONTRIBUTING.md`](./CONTRIBUTING.md); coding agents start at [`AGENTS.md`](./AGENTS.md), and all engineering/user/host documentation is routed from [`docs/README.md`](./docs/README.md). Security issues: [`packages/moss-agent/SECURITY.md`](./packages/moss-agent/SECURITY.md).

## License

[MIT](./LICENSE)
