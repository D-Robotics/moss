# Moss User Guide

Moss is a cross-platform agent harness by D-Robotics for daily coding and
office work; robotics comes as skills. It runs as an interactive TUI, a
one-shot CLI, or piped stdin — and keeps every step visible, interruptible,
and resumable.

## Available topics

- [Getting started](01-getting-started.md) — install, first run, one-shot vs interactive.
- [Slash commands](04-slash-commands.md) — the full in-session command reference.

## Planned topics

More guides are being written (matching grok-build's topic-decomposed style):
configuration, sessions, background tasks, skills, MCP servers, plan mode,
sandbox & permissions, and the doctor health check. Until they land, run
`moss --help --all` for the complete CLI and slash-command reference, and
`moss doctor` for a live environment check.

> The top-level `docs/*.md` files (architecture, host-adapter contract,
> design) are for contributors and host authors, not end users.

This guide is a living document. If a command or behavior here disagrees with
`moss --help --all` or the real CLI, the CLI is authoritative — please open an
issue.
