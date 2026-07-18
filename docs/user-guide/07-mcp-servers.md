# MCP Servers

Moss supports Model Context Protocol (MCP) servers as additional tools. An
MCP server exposes named tools moss can call alongside its built-ins.

## List servers

```sh
moss mcp list          # configured servers, connection status, tool counts
```

In-session, `/mcp` shows the same — connection status and how many tools
each server contributes.

## Add a server

```sh
moss mcp add filesystem "npx" "-y" "@modelcontextprotocol/server-filesystem" /workspace
moss mcp add time "uvx" "mcp-server-time"
```

Arguments after the command are passed through verbatim. No JSON editing.

## Remove a server

```sh
moss mcp remove filesystem
```

## Configuration

```sh
moss config set mcp.enabled true
moss config set mcp.configPath ~/.config/moss/mcp.json
```

`mcp.enabled` gates whether MCP servers are loaded from config; `mcp.configPath`
points at an explicit MCP config file (overrides the default
`~/.config/moss/mcp.json`).

## Namespacing

MCP tools are exposed with a namespace so they don't collide with built-ins
or across servers — a tool `search` from server `filesystem` is distinct from
one on server `git`. This makes MCP a safe extension point.

See the [user-guide index](README.md) for other topics.
