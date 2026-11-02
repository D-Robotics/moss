import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/** Bench-only recording transport. It never writes prompts, answers or credentials. */
export async function createRecordingRelay({
  baseUrl,
  model,
  key,
  outputFile,
  maxRequests = 100,
  maxOutputTokens = 4096,
  thinking,
  groupLimits = {},
  minGapMs = 0,
}) {
  const token = randomUUID();
  const rows = [];
  const pending = new Set();
  const gates = new Map();
  let phase = 'coding';
  let count = 0;
  const groupCounts = new Map();
  let nextDispatchAt = 0;
  let cooldownUntil = 0;
  const server = createServer((req, res) => {
    const done = serve(req, res)
      .catch(() => {
        if (res.destroyed) return;
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded)
          res.end('{"error":{"message":"benchmark upstream transport failed"}}');
      })
      .finally(() => pending.delete(done));
    pending.add(done);
  });
  async function serve(req, res) {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const route = /^\/(baseline|superagent)\/v1\/(models|chat\/completions)$/.exec(req.url ?? '');
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET' && route[2] === 'models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: model, context_length: 32768 }] }));
      return;
    }
    if (req.method !== 'POST' || route[2] !== 'chat/completions') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw);
    const group = `${route[1]}:${phase}`;
    if (
      body.model !== model ||
      count >= maxRequests ||
      (groupCounts.get(group) ?? 0) >= (groupLimits[group] ?? Infinity)
    ) {
      res.writeHead(429);
      res.end('{"error":{"message":"benchmark model/request limit"}}');
      return;
    }
    count++;
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
    body.max_tokens = Math.min(maxOutputTokens, Number(body.max_tokens) || maxOutputTokens);
    if (body.max_completion_tokens)
      body.max_completion_tokens = Math.min(maxOutputTokens, body.max_completion_tokens);
    if (thinking) body.thinking = { type: thinking };
    if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
    const record = {
      request: count,
      arm: route[1],
      phase,
      case: /\[case:(telemetry|alerts|queue)\]/.exec(raw)?.[1] ?? null,
      startedAt: Date.now(),
      model,
      dispatched: false,
      thinking: body.thinking?.type ?? null,
      status: null,
      completed: false,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    };
    rows.push(record);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    res.once('close', () => {
      if (!record.completed) controller.abort();
    });
    const usage = (value) => {
      if (!value?.usage) return;
      record.inputTokens = value.usage.prompt_tokens ?? null;
      record.outputTokens = value.usage.completion_tokens ?? null;
      record.cacheReadTokens =
        value.usage.prompt_cache_hit_tokens ??
        value.usage.prompt_tokens_details?.cached_tokens ??
        null;
    };
    try {
      const gate = gates.get(record.case);
      if (gate)
        await Promise.race([gate.promise, new Promise((resolve) => res.once('close', resolve))]);
      if (res.destroyed) return;
      const slot = Math.max(Date.now(), nextDispatchAt, cooldownUntil);
      nextDispatchAt = slot + minGapMs;
      if (slot > Date.now())
        await sleep(slot - Date.now(), undefined, { signal: controller.signal });
      if (cooldownUntil > Date.now())
        await sleep(cooldownUntil - Date.now(), undefined, { signal: controller.signal });
      if (res.destroyed) return;
      record.dispatched = true;
      if (outputFile)
        await fs.appendFile(
          outputFile.replace(/\.jsonl$/, '-started.jsonl'),
          JSON.stringify(record) + '\n',
          { mode: 0o600 }
        );
      const upstream = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      record.status = upstream.status;
      if (!upstream.ok) {
        const detail = await upstream.json().catch(() => ({}));
        record.upstreamError = String(detail.error?.message ?? detail.message ?? '')
          .split(key)
          .join('[redacted]')
          .slice(0, 600);
        if (upstream.status === 429) {
          const reset = /Limit resets at: ([0-9-]+ [0-9:]+) UTC/.exec(record.upstreamError)?.[1];
          const retryMs = Number(upstream.headers.get('retry-after')) * 1000;
          const resetMs = reset ? Date.parse(reset.replace(' ', 'T') + 'Z') - Date.now() : 0;
          const delay = Math.max(3000, Math.min(20000, retryMs || resetMs || 3000));
          cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
          res.setHeader('Retry-After', String(Math.ceil(delay / 1000)));
        }
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: `benchmark upstream HTTP ${upstream.status}` } })
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-cache',
      });
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        const text = decoder.decode(chunk, { stream: true });
        buffer += text;
        if (body.stream) {
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines)
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                usage(JSON.parse(line.slice(6)));
              } catch {
                /* Partial/non-data SSE line carries no usage. */
              }
            }
        }
        if (!res.destroyed) res.write(chunk);
      }
      if (!body.stream) {
        try {
          usage(JSON.parse(buffer));
        } catch {
          /* Upstream non-JSON response is not measured as zero. */
        }
      }
      record.completed = true;
      res.end();
    } finally {
      clearTimeout(timer);
      record.endedAt = Date.now();
      record.wallMs = record.endedAt - record.startedAt;
      if (outputFile)
        await fs.appendFile(outputFile, JSON.stringify(record) + '\n', { mode: 0o600 });
    }
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    token,
    url: `http://127.0.0.1:${server.address().port}`,
    setPhase(value) {
      phase = value;
    },
    hold(caseName) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      gates.set(caseName, { promise, resolve });
    },
    release(caseName) {
      gates.get(caseName)?.resolve();
      gates.delete(caseName);
    },
    records() {
      return structuredClone(rows);
    },
    async close() {
      for (const gate of gates.values()) gate.resolve();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pending]);
    },
  };
}
