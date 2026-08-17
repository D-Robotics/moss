# Proposal: zero-friction Moss Web UI

## User outcome

A user with a configured Moss model can run `moss web`, open one local URL, and complete a long
agent task in a consistent three-column React workbench while seeing streamed reasoning status,
tool calls, evidence, cancellation, sessions, settings, and the live plugin/tool inventory. The
browser never receives provider credentials.

## Non-goals

- Copying DeepSeek trademarks, source code, or exact visual assets.
- Exposing the server beyond loopback by default.
- Replacing the TUI, ACP, or embedding API.
- Claiming HMR before active tool-call quiescence exists.

## Success evidence

- Built-artifact HTTP integration covers boot, session creation, streaming, tools, cancellation,
  invalid input, and loopback binding.
- A real browser contract verifies the three-column hierarchy, design tokens, interaction path, and
  responsive layout at fixed viewport widths.
- The existing long-horizon harness and full repository verification remain green.
