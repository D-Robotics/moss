# Proposal: zero-friction Moss Web UI

## User outcome

A user with a configured Moss model can run `moss web`, open one local URL, and complete a long
agent task in a consistent three-column React workbench while seeing streamed reasoning status,
tool calls, evidence, cancellation, sessions, settings, and the live plugin/tool inventory. The
browser never receives provider credentials.

The complete acceptance scope is enumerated in
[`completion-matrix.md`](completion-matrix.md); a smaller green test surface is not completion.

## Non-goals

- Copying DeepSeek trademarks, source code, or exact visual assets.
- Exposing the server beyond loopback by default.
- Replacing the TUI, ACP, or embedding API.
- Running third-party JavaScript as if it were a security sandbox. Explicitly installed plugins are
  trusted code, but failures remain isolated from the core workbench.

## Success evidence

- Built-artifact HTTP integration covers the full session, interaction, settings, plugin, resumable
  streaming, cancellation, invalid-input, security, and loopback contracts.
- A real browser contract verifies the three-column hierarchy, design tokens, interaction path, and
  responsive layout at fixed viewport widths.
- The existing long-horizon harness and full repository verification remain green.
