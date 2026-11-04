#!/usr/bin/env node
/**
 * Minimal MCP stdio server for the D4 protocol probe: tools, resources and
 * prompts over newline-delimited JSON-RPC. No network, no dependencies.
 */
const TOOLS = [
  {
    name: 'mock_echo',
    description: 'Echo the given text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];
const RESOURCES = [
  {
    uri: 'mock://doc/one',
    name: 'One',
    mimeType: 'text/plain',
    description: 'The first mock resource',
  },
];
const PROMPTS = [
  {
    name: 'greet',
    description: 'Greeting template',
    arguments: [{ name: 'who', required: true }],
  },
];

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return; // notification
  const { id, method, params } = request;
  const ok = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'mcp-mock', version: '1.0.0' },
      });
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      if (name !== 'mock_echo') return fail(-32602, `unknown tool ${String(name)}`);
      const text = String(params?.arguments?.text ?? '');
      return ok({ content: [{ type: 'text', text: `echo:${text}` }] });
    }
    case 'resources/list':
      return ok({ resources: RESOURCES });
    case 'resources/read': {
      const uri = params?.uri;
      if (uri !== 'mock://doc/one') return fail(-32602, `unknown resource ${String(uri)}`);
      return ok({
        contents: [{ uri, mimeType: 'text/plain', text: 'mock resource content' }],
      });
    }
    case 'prompts/list':
      return ok({ prompts: PROMPTS });
    case 'prompts/get': {
      if (params?.name !== 'greet') return fail(-32602, `unknown prompt ${String(params?.name)}`);
      const who = String(params?.arguments?.who ?? 'world');
      return ok({
        description: 'Greeting template',
        messages: [{ role: 'user', content: { type: 'text', text: `Hello ${who}` } }],
      });
    }
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}
