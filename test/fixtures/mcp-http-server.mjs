/**
 * Minimal MCP streamable-HTTP server for test/mcp-client.spec.mjs.
 *
 * Started in-process by the spec (node:http). POST /mcp speaks JSON-RPC 2.0:
 *  - initialize → JSON response + `mcp-session-id` response header
 *  - tools/list → JSON response (records whether the session header came back)
 *  - tools/call "echo"     → SSE (text/event-stream) response — exercises the
 *                            client's event-stream parsing path
 *  - tools/call "ping"     → plain JSON response
 *  - tools/call "fail_tool"→ JSON-RPC error (exercises client error mapping)
 *
 * The returned `state` object lets the spec assert what the server actually
 * observed (session header round-trip, authorization header, etc.).
 */
import http from 'node:http';

const SESSION_ID = 'sess-moss-spec-1';

export async function startMcpHttpFixture() {
  const state = {
    initializeCount: 0,
    sessionHeaderOnCall: null,
    sessionHeaderOnList: null,
    authHeaderOnCall: null,
    requestsWithoutSession: [],
  };

  function fixtureTools() {
    return [
      {
        name: 'echo',
        description: 'Echo the value argument (server responds via SSE stream).',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      {
        name: 'ping',
        description: 'Returns pong (plain JSON response).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'fail_tool',
        description: 'Always fails with a JSON-RPC error.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/mcp')) {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expected POST /mcp' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const sessionId = req.headers['mcp-session-id'] ?? null;
      // Notifications carry no id — acknowledge and move on (202, no body).
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'initialize') {
        state.initializeCount += 1;
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': SESSION_ID,
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'fixture-http', version: '1.0.0' },
            },
          })
        );
        return;
      }
      if (sessionId !== SESSION_ID) state.requestsWithoutSession.push(msg.method);
      if (msg.method === 'tools/list') {
        state.sessionHeaderOnList = sessionId;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: fixtureTools() } }));
        return;
      }
      if (msg.method === 'tools/call') {
        state.sessionHeaderOnCall = sessionId;
        state.authHeaderOnCall = req.headers['authorization'] ?? null;
        const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
        if (name === 'echo') {
          const value =
            typeof msg.params?.arguments?.value === 'string' ? msg.params.arguments.value : '';
          const body = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `echo(${name}):${value}` }],
              isError: false,
            },
          });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: message\ndata: ${body}\n\n`);
          res.end();
          return;
        }
        if (name === 'ping') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: 'pong' }], isError: false },
            })
          );
          return;
        }
        if (name === 'fail_tool') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'fixture failure: boom' },
            })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: `unknown tool: ${name}` },
          })
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, state };
}
