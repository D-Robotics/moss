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

Moss works in a repository like a coding agent, researches current information through multiple web paths, and connects to robot development boards over persistent SSH. The same runtime can also be embedded in a TypeScript application with custom providers, tools, approvals, storage, and UI.

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss interactive terminal" width="780" />
</p>

## Quick Start

Moss requires **Node.js 22.16 or newer**.

```bash
npm install -g @rdk-moss/agent@latest
cd your-project
moss
```

The published CLI includes a ready-to-use D-Robotics model configuration, so the first run does not require a personal API key. Run `moss setup` when you want to use another provider or endpoint.

Ask for the outcome and the evidence you expect:

```text
Find the root cause of the flaky login test, implement the smallest safe fix,
run the narrowest useful verification, and summarize what changed.
```

Useful entry points:

```bash
moss                                  # interactive TUI
moss "review the current diff"        # one-shot task
moss --session release                # named persistent session
moss resume --last                    # resume the latest session
moss doctor                           # diagnose the local setup
moss --help --all                     # complete CLI reference
```

## Why Moss

- **Controllable while running** — steer the active task, queue follow-ups, ask an isolated BTW question, inspect details, or stop safely.
- **Built for long work** — named sessions, persistent goals, context pruning and compaction, resumable state, and an optional autonomous loop.
- **Safe by default** — the default `balanced` profile supports normal development while asking before sensitive actions; unrestricted execution is explicit.
- **Evidence-oriented research** — search, direct fetch, RSS discovery, browser reading, and parallel source collection can work together instead of trusting one result.
- **First-class robotics workflows** — persistent device sessions, environment discovery, board diagnostics, USB/MIPI cameras, and ROS 1/ROS 2 tools.
- **A real harness, not only a CLI** — providers, sessions, tools, hooks, approvals, usage events, async tasks, knowledge, skills, MCP, and host adapters are public contracts.

<p align="center">
  <img src="docs/assets/three-modes-en.png" alt="Moss usage modes" width="780" />
</p>

## Control The Session

Type `/help` inside the TUI for the complete command list.

| Command | What it does |
|---|---|
| `/status` | Shows the model, workspace, permissions, device, and active capabilities. |
| `/steer <instruction>` | Changes the active task at the next safe boundary. |
| `/btw <question>` | Answers a side question without adding it to the main task context. |
| `/queue` | Inspects, pauses, resumes, drops, or clears queued prompts. |
| `/goal <objective>` | Persists an objective across compaction, restart, and resume. |
| `/loop <objective>` | Runs iterative work until completion or `/stop`. |
| `/compact [instructions]` | Compacts older context while preserving active work. |
| `/cost` | Reports recorded token and cost data. |
| `/review` | Reviews the working tree or a GitHub pull request. |
| `/diff` · `/rewind` | Inspects changes or restores a file checkpoint. |
| `/permissions` | Inspects or changes the active safety profile. |
| `/soul` | Views or switches the active persona. |
| `/connect <target>` | Connects a robot development board over persistent SSH. |
| `/doctor` · `/mcp` | Diagnoses the runtime or inspects MCP servers. |

While a task is running, submit another prompt to queue it, use `/steer` to redirect the main task, use `/btw` for an unrelated question, or use `/stop` to cancel the run and active tool work. Press `Ctrl+O` for execution details and `Ctrl+V` to attach a file or image.

## Soul, Instructions, Skills, And Tools

Moss keeps identity, repository policy, reusable expertise, and executable capabilities separate:

| Layer | Location | Purpose |
|---|---|---|
| Soul | `.moss/soul.md` or global `soul.md` | Persona, voice, values, and collaboration style. |
| Instructions | `AGENTS.md` | Repository rules, commands, constraints, and verification expectations. |
| Skills | `.moss/skills/<name>/SKILL.md` and installed skills | Reusable workflows and domain knowledge. |
| Tools | Built-ins, custom tools, and MCP | Observable actions governed by execution and approval contracts. |

```text
/soul                 # inspect or choose a persona in the TUI
/soul init            # create .moss/soul.md without overwriting one
/soul list            # list available choices
/soul use <CODE>      # install and activate a SkillHub Soul
/soul default         # restore the built-in Moss persona
```

If a selected Soul needs SkillHub, Moss can bootstrap the official CLI and continue the installation flow. Persona content remains owned by its original author. Precedence and discovery rules are documented in [`docs/soul-md-design.md`](./docs/soul-md-design.md).

## Research Current Information

For time-sensitive work, Moss can plan complementary queries, search in multiple languages, discover RSS feeds, fetch source pages, and fall back to browser reading when ordinary HTTP access is blocked. Parallel evidence collection avoids making the first fast result the only result.

Search engines and websites can still block automation or return stale data. Moss should expose those limitations, use concrete dates, and distinguish verified evidence from unconfirmed leads rather than manufacture confidence.

## Connect A Robot

```text
/connect 192.168.1.10
/connect root@192.168.1.10
/connect 192.168.1.10 --user root --key ~/.ssh/id_ed25519
```

`/connect` verifies the target before reporting success, establishes one persistent SSH session, and routes later board operations through that connection. Moss discovers the remote environment before selecting tools instead of assuming every camera is USB or every system runs the same ROS distribution.

Typical workflows include:

- board health, storage, networking, processes, temperatures, and logs;
- USB/UVC and MIPI/CSI camera discovery and capture diagnostics;
- ROS 1 and ROS 2 nodes, topics, services, packages, and launch inspection;
- remote builds, deployment, model execution, and performance analysis;
- board-local web interfaces through the verified target.

<p align="center">
  <img src="packages/moss-agent/assets/moss-connect-vision.gif" alt="Moss connected robot workflow" width="780" />
</p>

Use `/disconnect` to close board mode. `--hybrid` keeps local tools available while adding board tools. Connection defaults can be supplied through `MOSS_DEVICE_USER`, `MOSS_DEVICE_PASSWORD`, `MOSS_DEVICE_KEY`, and `MOSS_DEVICE_PORT`.

## Embed The Runtime

```bash
npm install @rdk-moss/agent @rdk-moss/core
```

```ts
import {
  InMemorySessionStore,
  MossAgent,
  OpenAILLMProvider,
  registerBuiltinTools,
} from '@rdk-moss/agent';

const model = 'your-model';
const agent = new MossAgent({
  llmProvider: new OpenAILLMProvider({
    apiKey: process.env.MY_MODEL_API_KEY!,
    baseUrl: 'https://your-provider.example/v1',
    defaultModel: model,
  }),
  sessionStore: new InMemorySessionStore(),
  model,
  workspaceDir: process.cwd(),
  recordLlmUsage: true,
  hooks: {
    onBeforeToolExec: async ({ tool }) =>
      tool.metadata?.sideEffectClass === 'readonly'
        ? { approved: true }
        : { approved: false, reason: 'Host approval required' },
  },
});

registerBuiltinTools(agent);

agent.tools.register({
  name: 'project_health',
  description: 'Return application health information',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => JSON.stringify({ status: 'ok' }),
});

try {
  for await (const event of agent.streamChat('session-1', 'Check project health')) {
    if (event.type === 'text_delta') process.stdout.write(event.delta);
    if (event.type === 'llm_usage') console.error(event);
  }
} finally {
  await agent.close();
}
```

`await agent.close()` rejects new work, aborts active runs, waits for in-flight operations, and stops resources owned by the Agent. Registries injected by a host remain host-owned. `dispose()` is retained as a synchronous fire-and-forget compatibility trigger; applications with a lifecycle should prefer `close()`.

The public runtime includes:

- provider, session-store, streaming event, and `ChatResult` contracts;
- built-in and custom tools, approvals, hooks, guardrails, and structured output;
- context budgets, pruning, compaction, prompt-cache and usage telemetry;
- knowledge, memory, skills, capability packs, MCP, and platform extensions;
- async task lifecycle, device SSH, robotics helpers, and diagnostics.

See [`packages/moss-agent/API.md`](./packages/moss-agent/API.md) for the API surface and [`packages/moss-agent/EXTENDING.md`](./packages/moss-agent/EXTENDING.md) for extension patterns. Start a new host with:

```bash
npx create-moss-app my-agent
```

## Permissions And Configuration

The default profile is **balanced**, not unrestricted.

| Profile | Intended use |
|---|---|
| `readonly` | Inspect and explain without changing the workspace. |
| `balanced` | Normal development with approval for sensitive actions. |
| `autonomous` | Broad execution in an explicitly trusted environment. |

Configuration priority is:

1. CLI flags and `-c` overrides;
2. project `.moss/config.json`;
3. user configuration;
4. bundled defaults.

```bash
moss setup
moss config --help
moss doctor
```

Secrets use hidden prompts where possible. Moss intentionally does not infer model settings from unrelated provider environment variables. Use autonomous mode only in disposable or otherwise trusted environments.

## Reliability

Moss treats harness behavior as an observable contract. Regression coverage includes:

- goals surviving compaction, process restart, and resume;
- valid tool-use/tool-result pairing through pruning and overflow recovery;
- token, cache, compaction, and cost accounting;
- instance ownership and isolation for injected resources;
- abort, timeout, process cleanup, approval, queue, steering, BTW, and connection behavior;
- packaged CLI installation and PTY startup on supported operating systems.

The repository also maintains a 200-case harness benchmark across common coding, research, automation, safety, session, and robotics scenarios. It is an evidence set for finding concrete failures, not a claim that every model, website, board, or MCP server behaves perfectly.

## Architecture

```text
packages/moss/              provider-neutral contracts and prompt policy
packages/moss-agent/        runtime, loop, context, tools, TUI, CLI, and robotics
packages/create-moss-app/   embeddable agent project scaffolding
docs/                       design notes, architecture, benchmarks, and guides
scripts/                    verification, release, benchmark, and smoke tooling
```

Moss keeps the core loop provider-neutral. Coding, research, robotics, and host-specific behavior are composed through tools, prompt layers, capability packs, skills, knowledge modules, and adapters instead of one monolithic mode.

<p align="center">
  <img src="docs/assets/platform-support-en.png" alt="Moss platform support" width="780" />
</p>

## Develop

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm install
npm run verify
npm run smoke:moss-cli
```

`npm run verify` checks package boundaries, workspace hygiene, the harness benchmark, builds, types, lint, and all package tests. `npm run smoke:moss-cli` then packs the current workspaces, installs them into a temporary project, and verifies the installed CLI and interactive PTY startup.

Contribution guidance lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md). Report security issues through [`packages/moss-agent/SECURITY.md`](./packages/moss-agent/SECURITY.md).

## License

[MIT](./LICENSE)
