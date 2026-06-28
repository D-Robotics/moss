/**
 * web_search backends — tested from the model's perspective: a configured
 * real search API (博查 Bocha / Exa) returns clean, source-linked results, and
 * the backend chain prefers a keyed API over the keyless HTML scrapers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBochaSearch,
  createExaSearch,
  createWebSearchTool,
} from '../dist/tools/web-search.js';

const baseOpts = { maxResults: 5, timeoutMs: 5000, userAgent: 'moss-test' };

/** Replace global.fetch with a recording stub; returns calls + a restore fn. */
function stubFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

test('createBochaSearch maps the Bing-shaped envelope to results', async () => {
  const f = stubFetch(() =>
    jsonResponse(200, {
      code: 200,
      data: {
        webPages: {
          value: [
            {
              name: 'RDK X5 文档',
              url: 'https://developer.d-robotics.cc/rdk_x5',
              snippet: 'short',
              summary: '官方介绍',
            },
            { name: 'skip me', url: 'ftp://nope', snippet: 'x' },
          ],
        },
      },
    })
  );
  try {
    const res = await createBochaSearch('key')('rdk x5', baseOpts);
    assert.equal(res.length, 1, 'non-http url is filtered out');
    assert.equal(res[0].title, 'RDK X5 文档');
    assert.equal(res[0].url, 'https://developer.d-robotics.cc/rdk_x5');
    assert.equal(res[0].snippet, '官方介绍', 'prefers summary over snippet');
    assert.match(f.calls[0].url, /api\.bochaai\.com/);
  } finally {
    f.restore();
  }
});

test('createBochaSearch surfaces auth failure on HTTP 401', async () => {
  const f = stubFetch(() => jsonResponse(401, {}));
  try {
    await assert.rejects(() => createBochaSearch('bad')('q', baseOpts), /returned HTTP 401/);
  } finally {
    f.restore();
  }
});

test('createExaSearch maps results[] to rows, preferring highlights', async () => {
  const f = stubFetch(() =>
    jsonResponse(200, {
      results: [
        { title: 'Exa Result', url: 'https://exa.example/a', text: 'body', highlights: ['hi'] },
      ],
    })
  );
  try {
    const res = await createExaSearch('key')('q', baseOpts);
    assert.equal(res.length, 1);
    assert.equal(res[0].title, 'Exa Result');
    assert.equal(res[0].snippet, 'hi');
    assert.match(f.calls[0].url, /api\.exa\.ai/);
  } finally {
    f.restore();
  }
});

test('chain auto-selects Bocha when its key is present (never hits keyless)', async () => {
  const f = stubFetch((url) => {
    if (url.includes('api.bochaai.com')) {
      return jsonResponse(200, {
        code: 200,
        data: { webPages: { value: [{ name: 'hit', url: 'https://h.example', summary: 'sum' }] } },
      });
    }
    throw new Error('keyless backend must not be reached: ' + url);
  });
  try {
    const tool = createWebSearchTool({ bochaApiKey: 'k' });
    const out = await tool.execute({ query: 'rdk' }, { abortSignal: new AbortController().signal });
    assert.match(out, /hit/);
    assert.match(out, /h\.example/);
    assert.ok(
      f.calls.every((c) => c.url.includes('api.bochaai.com')),
      'only Bocha was queried'
    );
  } finally {
    f.restore();
  }
});

test('provider:"bocha" without a key fails fast at construction', () => {
  const prev = process.env.BOCHA_API_KEY;
  delete process.env.BOCHA_API_KEY;
  try {
    assert.throws(() => createWebSearchTool({ provider: 'bocha' }), /no API key/);
  } finally {
    if (prev !== undefined) process.env.BOCHA_API_KEY = prev;
  }
});
