# Getting Started

Moss is an agent harness that actually does things — reads and edits code,
runs commands, writes tests, verifies, and reports with evidence. It is
cross-platform (Linux / Windows / macOS) and runs in three modes:
interactive TUI, one-shot CLI, and piped stdin.

## Requirements

- **Node.js 22.16 or newer.** Check with `node --version`.

## Install

```sh
npm install -g @rdk-moss/agent@latest
moss --version
```

The published CLI ships a ready-to-use D-Robotics model configuration, so
the **first run does not require a personal API key**. Run `moss setup`
when you want to switch to your own provider or endpoint.

## First run

```sh
cd your-project
moss
```

The interactive TUI opens with the built-in model already active. Type a
request and press Enter; Moss reads code, runs commands, and reports results
with the evidence you can verify. File/exec actions are approved per the
current approval policy (`/permissions` shows the policy; `--ask-for-approval`
sets it).

Try:

```
read the README and summarize what this project does in 3 bullets
```

New here? Run `/quickstart` — it shows your current model, workspace, and
board state plus a few suggested first tasks (it's a status checklist, not a
wizard; use `moss setup` to configure a provider).

## Three ways to run Moss

### Interactive (default)

```sh
moss
```

Full TUI with streaming output, tool approval, slash commands, and a live
task panel. This is where you'll spend most of your time. See
[Slash commands](04-slash-commands.md) for everything available inside a
session.

### One-shot

```sh
moss "check this project for obvious issues"
```

Runs a single prompt to completion, prints the result, exits. Good for
scripts and CI. Pass `--json` or `--output-format stream-json` for
machine-readable output.

### Piped stdin

```sh
echo "list the largest files in this repo" | moss
{ echo "Review this diff for bugs:"; git diff; } | moss
```

Piped stdin becomes the prompt. Note: a prompt passed as a CLI argument takes
precedence over stdin, so to feed `git diff` to the model you pipe it into
stdin (as above) rather than passing both. Combine with `--json` or `--quiet`
for pipelines.

## Switch provider or model

The built-in model works without setup. To use your own:

```sh
moss setup                       # guided: provider, base URL, API key, model
moss config set provider deepseek
moss --provider openai-compatible --base-url https://api.example.com/v1 -m gpt-4o
```

Inside a session, `/model` lists and switches models for the current
session.

## Continue where you left off

Moss saves every session to disk automatically.

```sh
moss resume --last                # resume the most recent session
moss --session work              # continue or create a named session
moss sessions list               # see all saved sessions
moss sessions search "login bug" # find a session by content
```

Inside a session: `/sessions` lists, `/resume` switches, `/rewind` restores
files to a checkpoint and rewinds the conversation (files you changed outside
moss are kept, not overwritten).

## Quick health check

```sh
moss doctor
```

Inspects config, auth, workspace, runtime, search backend, and update state —
the first thing to run when something feels off.

## What's next

- [Slash commands](04-slash-commands.md) — the full in-session reference.
- `moss --help --all` — the complete CLI and flag reference.
- `moss doctor` — a live environment health check.

More topic guides (configuration, sessions, background tasks, skills, MCP,
plan mode, sandbox) are being written; see the [user-guide index](README.md).
