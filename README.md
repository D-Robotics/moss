# Moss

Moss is a minimal, cross-platform coding agent harness. It ships one thing well: a `moss` CLI
that runs an agent loop — chat with an LLM, call tools, manage context, keep sessions — with
pluggable providers and a built-in terminal UI.

## Quickstart

Requirements: Node.js ≥ 22.16.0 (Linux / macOS / Windows).

```bash
git clone <this repository> moss
cd moss
npm install
npm run build
node dist/cli.js            # interactive TUI
node dist/cli.js "prompt"   # one-shot
```

Optionally link the `moss` command globally:

```bash
npm link        # or: npm install -g .
moss
```

## Configure a model

First run guides you through setup:

```bash
moss setup
```

Or configure manually (Anthropic-style or OpenAI-compatible endpoints):

```bash
moss config set provider anthropic
moss config set api_key $ANTHROPIC_API_KEY
moss config set model claude-sonnet-4-20250514

# any OpenAI-compatible gateway
moss config set provider openai-compatible
moss config set base_url https://api.deepseek.com/v1
moss config set api_key $DEEPSEEK_API_KEY
moss config set model deepseek-chat
```

Configuration lives in `~/.config/moss/config.json` (override with `MOSS_CONFIG_DIR`).
API keys can also be supplied via the usual environment variables
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …).

## What's inside

- **Agent loop** — tool calling, steering, retry/overflow recovery, turn limits.
- **Tools** — file read/write/edit, patch, search (files/code), shell `exec`
  (with background execution), web fetch/search, todo, run-tests helpers,
  ask-user-question, subagents (`create_subagent` / `fan_out_subagents`).
- **Context management** — token accounting, pruning, compaction, microcompaction,
  context-window guards.
- **Sessions** — JSONL session store, resume, rewind, event log.
- **Safety** — secret sanitization, dangerous-command blocking, tool approval hooks,
  protected paths.
- **CLI** — interactive TUI (ink), one-shot/headless mode with `--print`, REPL fallback.

Embed it as a library:

```ts
import { MossAgent, InMemorySessionStore, AnthropicLLMProvider } from 'moss';

const agent = new MossAgent({
  llmProvider: new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  sessionStore: new InMemorySessionStore(),
});
const result = await agent.chat('main', 'Explain this repository.');
```

## Development

```bash
npm run check   # format + lint + typecheck
npm run test    # build + run the spec suite (test/*.spec.mjs)
npm run verify  # check + test + CLI smoke
```

Focused test iteration: `npm run test:filter -- --filter <spec-name>`.

## License

MIT — see [LICENSE](LICENSE).
