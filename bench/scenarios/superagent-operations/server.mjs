import { createServer } from 'node:http';
import path from 'node:path';
import { openTelemetry } from './src/telemetry.mjs';
import { openAlerts } from './src/alerts.mjs';
import { openQueue } from './src/queue.mjs';

const dir = process.env.OPS_DATA_DIR ?? path.resolve('data');
const telemetry = openTelemetry(path.join(dir, 'samples.jsonl'));
const alerts = openAlerts(path.join(dir, 'alerts.json'), [
  { metric: 'temperature', op: 'gte', open: 90, clear: 85, consecutive: 2 },
  { metric: 'battery', op: 'lte', open: 15, clear: 20, consecutive: 2 },
]);
const queue = openQueue(path.join(dir, 'queue.json'));
function dispatchPending() {
  for (const event of alerts.pending()) {
    queue.enqueue({ id: event.id, key: event.id, type: 'notify', payload: event });
    alerts.ack(event.id);
  }
}
dispatchPending();
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) {
      raw += part;
      if (raw.length > 65536) throw new Error('request too large');
    }
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://localhost');
    let result;
    if (req.method === 'GET' && url.pathname === '/health') result = { ok: true };
    else if (req.method === 'POST' && url.pathname === '/samples') {
      result = telemetry.ingest(body);
      if (result.accepted) alerts.observe(body);
      dispatchPending();
    } else if (req.method === 'GET' && url.pathname.startsWith('/devices/')) {
      const id = decodeURIComponent(url.pathname.slice(9));
      result = {
        latest: telemetry.latest(id),
        history: telemetry.history(id),
        total: telemetry.count(),
      };
    } else if (req.method === 'GET' && url.pathname === '/alerts')
      result = { active: alerts.active(), pending: alerts.pending() };
    else if (req.method === 'GET' && url.pathname === '/jobs/stats') result = queue.stats();
    else if (req.method === 'POST' && url.pathname === '/jobs/claim')
      result = queue.claim(body.worker, body.now, body.leaseMs);
    else if (req.method === 'POST' && /^\/jobs\/[^/]+\/complete$/.test(url.pathname)) {
      queue.complete(
        decodeURIComponent(url.pathname.split('/')[2]),
        body.token,
        body.result,
        body.now
      );
      result = { done: true };
    } else if (req.method === 'GET' && url.pathname.startsWith('/jobs/'))
      result = queue.get(decodeURIComponent(url.pathname.slice(6)));
    else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(/CONFLICT|STALE/.test(error.code ?? '') ? 409 : 400, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ error: error.code ?? 'INVALID_REQUEST' }));
  }
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () =>
  console.log(JSON.stringify({ port: server.address().port }))
);
process.once('SIGTERM', () => server.close());
