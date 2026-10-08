#!/usr/bin/env node
// Zero-quota OpenAI-compatible stub for TUI feel measurements.
//   "longstream" -> ~90-line markdown answer streamed in 12-char deltas every 25ms
//   "toolstorm"  -> 20 sequential list_directory calls, then a short answer
//   anything else -> one short answer
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8793);

const LONG = Array.from({ length: 30 }, (_, i) =>
  [
    `## Section ${i + 1}`,
    `Paragraph ${i + 1} with **bold**, \`code\` and 中文宽字符 to exercise wrapping across the full width of the terminal window.`,
    `- bullet ${i + 1}`,
  ].join('\n')
).join('\n\n');

function lastUser(messages) {
  const m = [...messages].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
}

const usage = { prompt_tokens: 1200, completion_tokens: 50, total_tokens: 1250 };
const sse = (res) =>
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const done = (res) => {
  send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
};

let seq = 0;
http
  .createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'stub-model', object: 'model' }] }));
      return;
    }
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        /* ignore */
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = lastUser(messages);
      const toolResults = messages.filter((m) => m.role === 'tool').length;
      sse(res);
      if (/longstream/i.test(text)) {
        const pieces = LONG.match(/[\s\S]{1,12}/g) ?? [];
        let i = 0;
        const timer = setInterval(() => {
          if (i < pieces.length) send(res, { choices: [{ index: 0, delta: { content: pieces[i++] } }] });
          else {
            clearInterval(timer);
            done(res);
          }
        }, 25);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (/toolstorm/i.test(text) && toolResults < 20) {
        const id = `call_${++seq}`;
        send(res, { choices: [{ index: 0, delta: { content: `Step ${toolResults + 1}. ` } }] });
        send(res, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
                  },
                ],
              },
            },
          ],
        });
        send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      send(res, { choices: [{ index: 0, delta: { content: 'Done.' } }] });
      done(res);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(PORT));
