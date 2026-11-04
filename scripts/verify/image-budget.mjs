#!/usr/bin/env node
/**
 * Deterministic probe for the historical image budget (backlog B01).
 *
 * The session file keeps every observed image (audit trail), but each provider
 * request should carry only the newest few: a screenshot-heavy session would
 * otherwise resend the whole image history every turn. This probe runs the real
 * `convertMessagesToPi` — the one place tool-observed images enter provider
 * messages — so it pins the behavior loops, sub-agents and replay all share.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = async (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);

const { convertMessagesToPi } = await load('core/tools/message-convert.js');
const budget = await load('context/image-budget.js');

const MODEL = { api: 'openai', provider: 'openai', id: 'fake' };

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[image-budget] ok ${name}`);
}

function imageResult(index, bytes = 64) {
  const data = `img${index}-`.padEnd(bytes, 'x');
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `t${index}`,
        content: `[image] pic${index}.png (image/png, ${bytes} B) — attached to the conversation.`,
        structuredContent: [{ type: 'image', data, mimeType: 'image/png', alt: `pic${index}.png` }],
      },
    ],
    timestamp: index,
  };
}

function sessionImages(count) {
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${index}`, name: 'read_image', input: {} }],
      timestamp: index * 2,
    });
    messages.push(imageResult(index));
  }
  return messages;
}

function imageParts(piMessages) {
  return piMessages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part && part.type === 'image');
}

function textOf(piMessages) {
  return piMessages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

// ── 1. Defaults keep a normal session intact ───────────────────────────────

const four = sessionImages(4);
const unchecked = convertMessagesToPi(structuredClone(four), MODEL);
assert.equal(imageParts(unchecked).length, 4);
assert.doesNotMatch(textOf(unchecked), /omitted from this request/);
ok('four images stay attached under the default budget');

// ── 2. Count budget keeps the newest and replaces the rest ────────────────

const original = structuredClone(four);
process.env.MOSS_IMAGE_HISTORY_MAX_COUNT = '2';
delete process.env.MOSS_IMAGE_HISTORY_MAX_BYTES;
try {
  const pruned = convertMessagesToPi(original, MODEL);
  const kept = imageParts(pruned);
  assert.equal(kept.length, 2, 'count budget');
  assert.deepEqual(
    kept.map((part) => part.data.slice(0, 4)),
    ['img2', 'img3'],
    'the newest two images survive'
  );
  // One notice per pruned message; the two older images sat in different
  // messages, so the model reads two single-image notices.
  const notice = textOf(pruned);
  assert.equal(notice.match(/1 earlier image omitted from this request/g)?.length, 2);
  assert.match(notice, /only the newest 2 images/);
  assert.match(notice, /call read_image again/);
  ok('count budget keeps the newest images and tells the model how to get the rest');

  // Session messages are an audit trail: pruning must not rewrite them.
  assert.equal(imageParts(original).length, 0, 'session tool_results keep their blocks');
  assert.equal(
    original
      .filter((message) => message.role === 'user')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result' && block.structuredContent).length,
    4,
    'all four observed images remain in the session shape'
  );
  ok('the session transcript is unchanged; pruning is request-only');
} finally {
  delete process.env.MOSS_IMAGE_HISTORY_MAX_COUNT;
}

// ── 3. Byte budget ────────────────────────────────────────────────────────

const byteLimited = budget.pruneHistoricalImages(
  [
    { role: 'user', content: [{ type: 'image', data: 'a'.repeat(40), mimeType: 'image/png' }] },
    { role: 'user', content: [{ type: 'image', data: 'b'.repeat(40), mimeType: 'image/png' }] },
    { role: 'user', content: [{ type: 'image', data: 'c'.repeat(40), mimeType: 'image/png' }] },
  ],
  { maxCount: 8, maxBytes: 90 }
);
assert.equal(byteLimited.filter((m) => m.content.some((p) => p.type === 'image')).length, 2);
assert.match(
  String(byteLimited[0].content.at(-1).text),
  /1 earlier image omitted from this request/
);
ok('byte budget bounds the base64 payload as well as the count');

// ── 4. Env overrides and invalid values ───────────────────────────────────

assert.deepEqual(budget.resolveImageBudgetLimits({}), {
  maxCount: budget.IMAGE_HISTORY_MAX_COUNT,
  maxBytes: budget.IMAGE_HISTORY_MAX_BYTES,
});
assert.deepEqual(
  budget.resolveImageBudgetLimits({
    MOSS_IMAGE_HISTORY_MAX_COUNT: '3',
    MOSS_IMAGE_HISTORY_MAX_BYTES: '1000',
  }),
  { maxCount: 3, maxBytes: 1000 }
);
assert.deepEqual(
  budget.resolveImageBudgetLimits({
    MOSS_IMAGE_HISTORY_MAX_COUNT: 'nope',
    MOSS_IMAGE_HISTORY_MAX_BYTES: '0',
  }),
  { maxCount: budget.IMAGE_HISTORY_MAX_COUNT, maxBytes: budget.IMAGE_HISTORY_MAX_BYTES }
);
ok('limits come from env when valid and fall back when not');

// ── 5. Messages without images are returned untouched ──────────────────────

const plain = [
  { role: 'user', content: 'hello', timestamp: 1 },
  { role: 'assistant', content: 'hi', timestamp: 2 },
];
const untouched = budget.pruneHistoricalImages(plain, { maxCount: 0, maxBytes: 0 });
assert.equal(untouched[0], plain[0]);
assert.equal(untouched[1], plain[1]);
ok('image-free messages keep their identity (prefix caching unaffected)');

console.log(`[image-budget] PASS (${checks} checks)`);
