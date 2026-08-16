# Proposal: zero-friction Moss Web UI

## User outcome

A user with a configured Moss model can run `moss web`, open one local URL, and complete a long
agent task while seeing streamed reasoning status, tool calls, evidence, cancellation, and the live
plugin/tool inventory. The browser never receives provider credentials.

## Non-goals

- Copying DeepSeek trademarks, source code, or exact visual assets.
- Exposing the server beyond loopback by default.
- Replacing the TUI, ACP, or embedding API.
- Claiming HMR before active tool-call quiescence exists.

## Success evidence

- Built-artifact HTTP integration covers boot, session creation, streaming, tools, cancellation,
  invalid input, and loopback binding.
- A browser screenshot verifies the usable visual hierarchy at desktop width.
- The existing long-horizon harness and full repository verification remain green.
