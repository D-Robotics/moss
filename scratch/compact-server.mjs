#!/usr/bin/env node
/**
 * Stand-in remote compaction service (localhost dev endpoint).
 * Contract: GET /compact/health → 200; POST /compact → {summary, tokens_saved}.
 * Summarizes with the same configured model but a tight output budget —
 * representing what a tuned compact service would do.
 */
import http from 'node:http';
import { createCliProvider } from '../dist/cli/providers.js';
import { resolveCliConfig } from '../dist/cli/config.js';

const resolved = resolveCliConfig();
const provider = createCliProvider({
  provider: resolved.provider,
  apiKey: resolved.apiKey,
  model: resolved.model,
  baseUrl: resolved.baseUrl,
});

const PORT = 8787;
const MAX_OUTPUT_TOKENS = 3000;

function extractTurns(messages) {
  const turns = [];
  for (const m of messages ?? []) {
    if (typeof m.content === 'string' && m.content.trim()) {
      turns.push(`${m.role}: ${m.content.slice(0, 1500)}`);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text?.trim()) turns.push(`${m.role}: ${b.text.slice(0, 1500)}`);
        else if (b.type === 'tool_use')
          turns.push(`assistant tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 300)}`);
        else if (b.type === 'tool_result')
          turns.push(`tool_result(${b.tool_use_id}): ${String(b.content).slice(0, 1500)}`);
      }
    }
  }
  return turns.join('\n\n');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/compact')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    try {
      const transcript = extractTurns(body.messages).slice(0, 300_000);
      const resp = await provider.complete({
        model: body.model ?? resolved.model,
        systemPrompt:
          'You are a conversation compaction service. Produce a DENSE summary the coding agent can continue from. ' +
          'Hard limits: at most ~2500 tokens. Keep: user goals/constraints, files touched with paths, tool calls and their outcomes, ' +
          'decisions made, and the current task state. Drop verbatim file contents — keep only paths and one-line purposes.',
        messages: [
          {
            role: 'user',
            content: `Summarize this conversation for context handoff:\n\n${transcript}`,
          },
        ],
        maxTokens: MAX_OUTPUT_TOKENS,
      });
      const summary = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ summary, tokens_saved: 0 }));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () =>
  console.error(`[compact-server] listening on http://localhost:${PORT}/compact`)
);
