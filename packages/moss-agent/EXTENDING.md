# Extending Moss

Moss is a cross-platform agent harness. The product ships a capable default agent; the extension points below let you turn it into **your** agent — adjust persona, add skills, wire tools, pick models, automate, and embed. Each layer is independent: pick only what you need.

## Extension surface at a glance

| Layer              | What it shapes                                | Interface                                             | Who                            | Where                                                          |
| ------------------ | --------------------------------------------- | ----------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| **Persona**        | Identity / system prompt                      | `soul.md`                                             | Anyone                         | `.moss/soul.md` (workspace) · `<configDir>/soul.md` (global)   |
| **Skills**         | Per-turn guidance injected when matched       | `SKILL.md`                                            | Anyone                         | `.moss/skills/<name>/SKILL.md` · `~/.claude/skills` · builtins |
| **Slash commands** | Reusable prompt expansions                    | `*.md`                                                | Anyone                         | `.moss/commands/<name>.md`                                     |
| **Tools**          | What the agent can _do_ (side effects, reads) | `Tool` contract / MCP config / `agent.tools.register` | Anyone (MCP) / Embedder (code) | `.moss/mcp.json` / code                                        |
| **Model**          | Which LLM + context window                    | `moss config` / `/model`                              | Anyone                         | `~/.config/moss/config.json`                                   |
| **Automation**     | Hands-off flows                               | `/goal` · `/loop`                                     | Anyone (in-session)            | TUI                                                            |
| **Embedding**      | moss as a library                             | `MossAgent` / `streamChat` / hooks                    | Embedder                       | code                                                           |

---

## 1. Persona — `soul.md`

Replace the default "You are Moss…" identity with your own. Discovery order: workspace `.moss/soul.md` → global `<configDir>/soul.md` → default.

```markdown
---
id: my-agent
mode: prepend # prepend (layer on top of default) | replace (use only this body)
---

You are Ava, a senior backend engineer's pair. You favor small diffs, tests
first, and explicit assumptions. You refuse to add speculative config.
```

- The body (after optional YAML frontmatter) becomes the identity text.
- A non-overridable **model-honesty footer** is appended to any custom soul — a custom persona cannot drop the "name the real model" guarantee.
- `mode: replace` uses only your body; `mode: prepend` layers it on top of the default Moss identity.

## 2. Skills — `SKILL.md`

Skills are **matched against the user's prompt each turn** and the matched skill's body is injected into the dynamic context bucket (never breaks the prompt cache). They shape _how_ the model does a task, not what it can do.

```markdown
---
name: deploy-staging
description: Use when deploying the web app to staging. Runs build, then deploys.
trigger: [deploy, staging, release]
tags: [deploy, web]
risk: medium
permissions: { workspaceRead: true, workspaceWrite: true }
runtimePolicy: { delegatePreference: local, approvalLevel: confirm }
---

## Steps

1. Run `npm run build`.
2. Run `./scripts/deploy-staging.sh` and report the URL.
3. Smoke-test the deployed URL with web_fetch.

Do not deploy past 18:00 unless the user confirms.
```

- File: `.moss/skills/<name>/SKILL.md` (workspace) · `~/.claude/skills` or `~/.agents/skills` (global) · RDK bundle · builtins.
- Frontmatter: `name`, `description`, `trigger` (match keywords), `tags`, `risk`, `permissions`, `runtimePolicy`.
- Manage in-session: `/skills` (list), `/skill enable <name>`, `/skill disable <name>` (per-session), `/skills promote|discard` (auto-learned candidates).
- `/skills` shows each skill's **source** (builtin / rdk / workspace / global) so you know which file to edit.

## 3. Tools — three layers

Tools are capabilities with **side effects or structured reads** (`read_file`, `exec`, `web_fetch`, …). Choose the layer that fits:

### 3a. Builtin tools — always on, no config

moss ships `read_file` / `write_file` / `edit_file` / `move_file` / `list_directory` / `search_code` / `search_files` / `exec` (sandboxed shell) / `web_search` / `web_fetch` / `vision_analyze` / `create_subagent` / `generate_structured` / device tools (when `/connect`ed). These cover most daily coding + office work. `/tools` lists what's active.

### 3b. MCP tools — connect external tool servers (no code)

For ready-made or third-party tool servers (filesystem, git, database, browser…), configure them via the Model Context Protocol. moss auto-registers MCP tools under the server's namespace.

```bash
moss mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /my/project
moss config set mcp.enabled true
```

- Config: `.moss/mcp.json` or `<configDir>/mcp.json`.
- MCP tools are namespaced (`servername__toolname`) — they cannot collide with builtin tools.
- `/mcp` shows connection status + tool counts.

### 3c. Custom tools — register in code (embedder)

For product-specific logic, implement the `Tool` contract and register it. This is the path when you embed moss as a library.

```typescript
import { MossAgent } from '@rdk-moss/agent';

agent.tools.register({
  name: 'deploy_staging',
  description: 'Deploy the web app to staging and return the URL.',
  inputSchema: {
    type: 'object',
    properties: { confirm: { type: 'boolean', description: 'must be true to deploy' } },
    required: ['confirm'],
  },
  metadata: { sideEffectClass: 'runtime_state', planMode: 'requires_user_confirmation' },
  execute: async (input, ctx) => {
    if (!input.confirm) return 'Error: confirm is required.';
    const url = await runDeploy();
    return `Deployed to ${url}`;
  },
});
```

- `sideEffectClass`: `readonly` (parallel-safe) | `runtime_state` (mutates state, not parallel) | `local_write` | `subagent`. moss uses this to parallelize safe calls and gate unsafe ones.
- `planMode`: `allow` | `requires_user_confirmation` — whether the tool may run in plan mode.
- Approval + audit: see `onBeforeToolExec` / `onToolResult` hooks (USAGE.md → Customization).

**When to use which tool layer:**

- Builtin for common ops (files, shell, search, web).
- MCP for external/ready-made servers, no code.
- Custom (`agent.tools.register`) for product-specific logic when embedding.

> **Note on file-based custom tools:** moss does not (yet) ship a `.moss/tools/*.json` mechanism that wraps a shell command as a named tool. For now, use the builtin `exec` tool (the model can run any command through it, gated by approval), or an MCP server, or a registered custom tool. If you have a concrete use case a file-based tool would solve better, that's the candidate for the next layer.

## 4. Slash commands — `.moss/commands/*.md`

Distinct from tools: a slash command **expands into a prompt** the model runs. Use for canned workflows, not side effects.

```markdown
<!-- .moss/commands/ship.md -->

Review the staged diff for bugs, then run the test suite, then draft a
conventional-commit message. Do not push; show me the commit message.
```

Type `/ship` in the TUI. Custom commands never shadow builtins.

## 5. Model — `/model`, `moss config`

```bash
moss config set provider=openai-compatible model=<your-model> baseUrl=<https://host>
moss setup                                   # stores the API key (hidden prompt)
moss config set agent.contextTokens=128000   # optional explicit override
```

- In-session: `/model` lists/selects, `/model config ...` adds a custom model.
- moss **auto-detects the context window** (provider `/v1/models` or Ollama `/api/show` → name-pattern fallback) on `/model` switch; a user-pinned `contextTokens` wins.
- Per-subagent model override: `create_subagent` accepts a `model` field (strong model for a decision, cheap model for exploration).

## 6. Automation — `/goal`, `/loop`

- `/goal set <objective>` — keep working toward an objective until you mark it done; moss auto-continues each turn. Vague objectives ("fix it") are refused with a clarification request.
- `/loop <prompt>` — re-run a prompt autonomously up to `MOSS_LOOP_MAX` (default 5) iterations on an isolated session; `/loop stop` aborts.
- `/btw <question>` — a side question on an isolated session that does not pollute the main task context; runs concurrently with an active run.

## 7. Embedding — moss as a library

moss core is a library; the CLI is one host. Embed it to build your own product:

**Quickest start — scaffold a project:**

```bash
npx create-moss-app my-agent            # scaffold a working embedder project
cd my-agent && npm install
npm start                              # talks to the built-in gateway, or set ANTHROPIC_API_KEY
```

The scaffold ships a working `index.ts` (minimal template uses `AnthropicLLMProvider`; `--template openai` uses `OpenAILLMProvider`) plus `mcp.json.example` and a typecheck script.

**The code pattern:**

```typescript
import { MossAgent, InMemorySessionStore, AnthropicLLMProvider } from '@rdk-moss/agent';

const agent = new MossAgent({
  llmProvider: new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
  workspaceDir: process.cwd(),
  baseSystemPrompt: myPersona, // or use soul.md
  resolveModelContextTokens, // inject per-model context detection
  hooks: { onBeforeToolExec, onToolResult, onError /* … */ },
});
agent.tools.register(myTool);

for await (const event of agent.streamChat(sessionKey, message, { extraContext })) {
  // tool_start / tool_end / text_delta / thinking_delta / retry / compaction / done / error
}
```

- Full surface: `API.md` (Tool / ToolContext / ToolRegistry / hooks / events / chat options).
- Embedder owns: persona, tools, knowledge, model, hooks, UI. moss owns: the loop, retries, compaction, streaming, safety gates.

---

## Layering rules of thumb

- **Skill vs tool:** a skill shapes _how_ the model works (instructions); a tool is _what_ it can do (side effects). If you want the model to follow a process → skill. If you want it to perform an action it can't via builtin/MCP → tool.
- **Slash command vs skill:** a command is an explicit, user-invoked prompt expansion. A skill is auto-matched and injected transparently. Use commands for "run this canned workflow now"; skills for "whenever the user asks about X, apply this guidance".
- **Persona vs skill:** persona is the agent's identity (always on). Skills are per-turn, match-triggered.
- **Builtin vs MCP vs custom tool:** prefer builtin; reach for MCP when a server already exists; write a custom tool only for product-specific logic.
