# Moss User Guide

Moss is a cross-platform agent harness by D-Robotics for daily coding and
office work; robotics comes as skills. It runs as an interactive TUI, a
one-shot CLI, or piped stdin — and keeps every step visible, interruptible,
and resumable.

## Available topics

- [Getting started](01-getting-started.md) — install, first run, one-shot vs interactive.
- [Slash commands](04-slash-commands.md) — the full in-session command reference.
- [Configuration](05-configuration.md) — provider, model, safety profile, context budget.
- [MCP servers](07-mcp-servers.md) — `mcp add/list/remove`, `/mcp`.
- [Skills](08-skills.md) — SKILL.md, SkillHub, `/skill`, `/soul`.
- [Adaptive Skill Composer](21-skill-composer.md) — open-vocabulary selection, board-safe modes, and rollback.
- [Custom sub-agent experts](22-subagent-experts.md) — reusable read-only expert profiles and fan-out.
- [Plan mode](19-plan-mode.md) — `/mode plan`, structured plan approval, Shift+Tab.
- [Sandbox & permissions](18-sandbox.md) — safety mode, approval policy, hard-blocked patterns.
- [Sessions](17-sessions.md) — list, resume, fork, search, export, rewind.
- [Background tasks](20-background-tasks.md) — `exec_background`, `exec_wait`, `exec_stop`.
- [Doctor](doctor.md) — `moss doctor` health check.

The user guide covers the main topics. For anything not here, run
`moss --help --all` for the complete CLI and slash-command reference, and
`moss doctor` for a live environment check.

> The top-level `docs/*.md` files (architecture, host-adapter contract,
> design) are for contributors and host authors, not end users.

This guide is a living document. If a command or behavior here disagrees with
`moss --help --all` or the real CLI, the CLI is authoritative — please open an
issue.
