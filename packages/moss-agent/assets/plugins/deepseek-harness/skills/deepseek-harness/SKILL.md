---
name: deepseek-harness
description: Apply the DeepSeek V4 API protocol contract when building or debugging DeepSeek clients.
license: MIT
version: 0.2.0
author: Henry Zhang (HenryZ838978), adapted for Moss by D-Robotics
homepage: https://github.com/HenryZ838978/deepseek-harness
---

# DeepSeek V4 Harness

Use these rules when code calls DeepSeek V4-Pro, V4-Flash, `deepseek-chat`, or
`deepseek-reasoner` through an OpenAI-compatible API. This Moss edition is adapted from
`HenryZ838978/deepseek-harness` at commit
`d1dd82381604aeb3586edb242e67a62003b77d71`.

1. Disable thinking for work that does not benefit from reasoning. In Python, send
   `extra_body={"thinking":{"type":"disabled"}}`; for OpenAI's TypeScript SDK, confirm how the
   installed SDK forwards provider extensions.
2. When thinking is enabled and an assistant message contains tool calls, preserve its original
   `reasoning_content` while completing that tool loop. Dropping it can make the next request fail.
3. Always set a finite `max_tokens` output cap. Treat the model and gateway limits as runtime
   configuration, not as timeless constants.
4. Aggregate streamed parallel tool-call deltas by the protocol's call index. Do not assume chunks
   arrive in call-list order.
5. Buffer text and reasoning chunks in arrays and join them once; repeated string concatenation can
   become quadratic for long reasoning streams.
6. Accept stream chunks whose `choices` array is empty. They can still carry usage information.
7. Keep input plus requested output within the model's advertised context window. Probe or configure
   the current limit rather than relying on an old catalog value.
8. Keep the stable prompt prefix free of volatile timestamps and request-specific state when prefix
   caching matters. Read both DeepSeek-native and OpenAI-shaped cached-token usage fields.
9. Use the normal DeepSeek endpoint for tool-using flows unless current official documentation
   explicitly requires a beta endpoint.
10. Validate tool arguments after JSON parsing even when strict function schemas are enabled.

For a real client implementation, prefer the maintained upstream packages and MCP server instead of
copying an old snapshot blindly:

- Python: `deepseek-harness`
- CLI: `deepseek-harness-cli`
- MCP: `@deepseek-harness/mcp`

Before recommending install commands or model limits, verify the current upstream README and official
DeepSeek API documentation. Never put API keys in source, plugin configuration output, logs, or chat.
