# Moss Product Context

## Register
Product

## Purpose
Moss is a terminal-first agent harness for everyday development, research, and robotics work. It should help users finish real tasks with trustworthy tools, clear control, and low interaction overhead.

## Users
- Developers who expect Codex/Claude Code-level clarity and task completion.
- Robotics developers working locally and through persistent board connections.
- Agent and SDK authors embedding Moss as a programmable harness.

## Experience Principles
- Readable first: strong contrast on light and dark terminals; body text is never decorative gray.
- Low noise: show user decisions, meaningful progress, and actionable failures; hide internal state-machine labels.
- Clear hierarchy: user request, concise agent narration, compact tool activity, then the answer.
- Honest state: suppressed/replayed calls are neutral, failures explain one actionable cause, token data names its source.
- Progressive detail: default view is compact; Ctrl+O reveals raw tool inputs, outputs, and diffs.

## Anti-References
- Dense streams of internal statuses such as `paused_resumable`.
- Red error blocks for successful deduplication or guard behavior.
- Low-contrast gray prose on white terminals.
- Repeated tool retries that dominate the answer.

## Success Standard
A user can scan the transcript in seconds, distinguish progress from failure, read the final answer comfortably, and understand what Moss did without seeing internal plumbing.
