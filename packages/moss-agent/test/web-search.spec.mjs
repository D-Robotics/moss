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
  preprocessQuery,
  baiduSearch,
  baiduResponseLooksBlocked,
  bingResponseLooksBlocked,
  bingSearch,
  duckDuckGoSearch,
  resolveBackendChain,
  searchWithFallback,
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

function htmlResponse(status, html) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
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
    assert.equal(f.calls[0].init.method, 'POST', 'Bocha API is POST, not GET');
    const body = JSON.parse(String(f.calls[0].init.body));
    assert.equal(body.query, 'rdk x5', 'query sent in JSON body, not as a query param');
    assert.equal(body.count, baseOpts.maxResults, 'count sent in JSON body');
    assert.equal(body.summary, true, 'summary requested');
    assert.match(
      String(f.calls[0].init.headers['content-type'] || f.calls[0].init.headers && f.calls[0].init.headers['Content-Type'] || ''),
      /application\/json/,
      'JSON content-type header set',
    );
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

// ─── preprocessQuery ────────────────────────────────────────────────────

test('preprocessQuery: CJK detection sets region to zh-CN', () => {
  const result = preprocessQuery('地瓜机器人 最新资讯');
  assert.equal(result.region, 'zh-CN', 'CJK query auto-sets zh-CN region');
  assert.equal(result.query, '地瓜机器人 最新资讯', 'query unchanged');
  assert.equal(result.siteHint, undefined, 'no site hint');
});

test('preprocessQuery: explicit region overrides CJK detection', () => {
  const result = preprocessQuery('地瓜机器人', 'en-US');
  assert.equal(result.region, 'en-US', 'explicit region wins over CJK detection');
});

test('preprocessQuery: non-CJK query does not set region', () => {
  const result = preprocessQuery('D-Robotics RDK X5');
  assert.equal(result.region, undefined, 'no region for non-CJK query');
});

test('preprocessQuery: strips site: operator and extracts site hint', () => {
  const result = preprocessQuery('site:d-robotics.cn 地瓜机器人');
  assert.ok(!result.query.includes('site:'), 'site: stripped from query');
  assert.equal(result.siteHint, 'd-robotics.cn', 'site domain extracted as hint');
  assert.equal(result.region, 'zh-CN', 'CJK detection still works after site: strip');
});

test('preprocessQuery: strips OR boolean operator', () => {
  const result = preprocessQuery('site:d-robotics.cn OR site:developer.d-robotics.com');
  assert.ok(!result.query.includes('OR'), 'OR stripped from query');
  assert.ok(result.siteHint.includes('d-robotics.cn'), 'first site extracted');
  assert.ok(result.siteHint.includes('developer.d-robotics.com'), 'second site extracted');
});

test('preprocessQuery: query that is only operators yields empty string', () => {
  const result = preprocessQuery('OR');
  assert.equal(result.query, '', 'operators-only query yields empty string after stripping');
});

// ─── DEFAULT UA ──────────────────────────────────────────────────────────

test('createWebSearchTool default UA is a current Chrome UA', async () => {
  const f = stubFetch(() => jsonResponse(200, { code: 200, data: { webPages: { value: [{ name: 'hit', url: 'https://h.example', summary: 'sum' }] } } }));
  try {
    const tool = createWebSearchTool({ bochaApiKey: 'k' });
    await tool.execute({ query: 'test' }, { abortSignal: new AbortController().signal });
    const ua = f.calls[0].init.headers['user-agent'] || f.calls[0].init.headers['User-Agent'] || '';
    assert.match(ua, /Chrome\/12/, 'default UA should be a Chrome desktop UA');
  } finally {
    f.restore();
  }
});

// ─── RECENCY MAPPING ─────────────────────────────────────────────────────

test('recency=day adds Bing filters param to URL', async () => {
  const f = stubFetch(() => htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>'));
  try {
    await bingSearch('test', { maxResults: 5, timeoutMs: 1000, userAgent: 'test', recency: 'day' });
    assert.match(f.calls[0].url, /filters=/, 'Bing URL should contain filters param');
    assert.match(f.calls[0].url, /%221\+day%22/, 'Bing filters should encode "1 day"');
  } finally {
    f.restore();
  }
});

test('recency=week adds Bing filters param', async () => {
  const f = stubFetch(() => htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>'));
  try {
    await bingSearch('test', { maxResults: 5, timeoutMs: 1000, userAgent: 'test', recency: 'week' });
    assert.match(f.calls[0].url, /%221\+week%22/, 'Bing filters should encode "1 week"');
  } finally {
    f.restore();
  }
});

test('recency=month adds Bing filters param', async () => {
  const f = stubFetch(() => htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>'));
  try {
    await bingSearch('test', { maxResults: 5, timeoutMs: 1000, userAgent: 'test', recency: 'month' });
    assert.match(f.calls[0].url, /%221\+month%22/, 'Bing filters should encode "1 month"');
  } finally {
    f.restore();
  }
});

test('recency=year adds Bing filters param', async () => {
  const f = stubFetch(() => htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>'));
  try {
    await bingSearch('test', { maxResults: 5, timeoutMs: 1000, userAgent: 'test', recency: 'year' });
    assert.match(f.calls[0].url, /%221\+year%22/, 'Bing filters should encode "1 year"');
  } finally {
    f.restore();
  }
});

test('recency=day adds DDG df=d param to POST body', async () => {
  const f = stubFetch(() => jsonResponse(200, '<html><body></body></html>'));
  try {
    await assert.rejects(() => duckDuckGoSearch('test', { maxResults: 5, timeoutMs: 500, userAgent: 'test', recency: 'day' }));
    // The request may fail (empty/blocked), but we can check the body
    const body = f.calls[0]?.init?.body?.toString() || '';
    assert.match(body, /df=d/, 'DDG body should contain df=d for day');
  } finally {
    f.restore();
  }
});

// ─── BAIDU PARSING ───────────────────────────────────────────────────────

const BAIDU_FIXTURE = `<!DOCTYPE html>
<html>
<body>
<div class="result c-container " id="1">
  <h3 class="t"><a href="http://www.baidu.com/link?url=abcdefg" target="_blank" data-url="https://developer.d-robotics.cc/rdk_x5">RDK X5 官方文档</a></h3>
  <div class="c-abstract">这是地瓜机器人的RDK X5开发板文档</div>
  <span class="c-color-gray">2026年6月14日</span>
</div>
<div class="result c-container result-op" id="2">
  <h3 class="t"><a href="http://www.baidu.com/link?url=adurl" target="_blank">赞助商链接</a></h3>
  <div class="c-abstract">这是广告</div>
  <span class="c-color-gray">2026年6月15日</span>
</div>
<div class="result c-container " id="3">
  <h3 class="t"><a href="http://www.baidu.com/link?url=another" target="_blank">正常结果二</a></h3>
  <div class="c-abstract">第二个结果摘要</div>
</div>
</body>
</html>`;

test('baiduSearch parses results, filters ads, extracts date and real URL', async () => {
  const f = stubFetch(() => htmlResponse(200, BAIDU_FIXTURE));
  try {
    const res = await baiduSearch('地瓜机器人', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.equal(res.length, 2, 'should return 2 organic results (ad filtered)');
    assert.equal(res[0].title, 'RDK X5 官方文档');
    assert.equal(res[0].url, 'https://developer.d-robotics.cc/rdk_x5', 'data-url extracted');
    assert.equal(res[0].snippet, '这是地瓜机器人的RDK X5开发板文档');
    assert.equal(res[0].date, '2026年6月14日', 'date extracted from c-color-gray');
    assert.equal(res[1].title, '正常结果二');
    assert.ok(!res[1].date, 'result without date should have undefined date');
  } finally {
    f.restore();
  }
});

test('baiduResponseLooksBlocked matches bing pattern', () => {
  // Should detect blocked pages
  assert.ok(baiduResponseLooksBlocked('<html><head><title>验证</title></head><body>安全检查</body></html>'), 'verification page detected');
  assert.ok(baiduResponseLooksBlocked('<html><body>access denied</body></html>'), 'access denied detected');
  // Should NOT detect normal results as blocked
  assert.ok(!baiduResponseLooksBlocked(BAIDU_FIXTURE), 'valid baidu results not blocked');
  // Should detect empty page without result markup
  assert.ok(baiduResponseLooksBlocked('<html><head><title>百度</title></head><body></body></html>'), 'empty page without result markup is blocked');
  // Should detect unexpected behavior page
  assert.ok(baiduResponseLooksBlocked('<html><head><title>百度</title></head><body><p>unusual traffic</p></body></html>'), 'unusual traffic detected');
});

test('bingResponseLooksBlocked: blocked page detection', () => {
  assert.ok(bingResponseLooksBlocked('<html><body><div id="captcha">verify</div></body></html>'), 'captcha detected');
  assert.ok(bingResponseLooksBlocked('<html><body>异常流量</body></html>'), 'CJK captcha detected');
  assert.ok(!bingResponseLooksBlocked('<html><body class="b_results"><div class="b_algo"></div></body></html>'), 'valid results not blocked');
});

// ─── PARALLEL RACING ─────────────────────────────────────────────────────

test('parallel race: secondary wins when primary exceeds grace window', async () => {
  const t0 = Date.now();
  // Create backends with controlled delays
  const primaryBackend = async (_q, _o) => {
    await new Promise(r => setTimeout(r, 300));
    return []; // returns empty after 300ms
  };
  const secondaryBackend = async (_q, _o) => {
    return [{ title: 'win', url: 'https://win.example', snippet: 'winner' }]; // returns immediately
  };
  const chain = [
    { name: 'primary', backend: primaryBackend },
    { name: 'secondary', backend: secondaryBackend },
  ];
  const opts = { maxResults: 5, timeoutMs: 5000, userAgent: 'test' };
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const raceGraceMs = 50; // small grace window so secondary starts quickly
  const result = await searchWithFallback(chain, 'test', opts, retry, raceGraceMs);
  const elapsed = Date.now() - t0;
  assert.equal(result.length, 1, 'secondary should win');
  assert.equal(result[0].title, 'win');
  // Should be faster than serial (300 + 50 + 0) ≈ 350, and well under grace+secondary delay
  assert.ok(elapsed < 200, `secondary should win fast (${elapsed}ms < 200ms)`);
});

test('parallel race: primary that returns immediately wins fast', async () => {
  const primaryBackend = async (_q, _o) => {
    return [{ title: 'primary', url: 'https://primary.example', snippet: 'fast' }];
  };
  let secondaryCalled = false;
  const secondaryBackend = async (_q, _o) => {
    secondaryCalled = true;
    return [{ title: 'secondary', url: 'https://secondary.example', snippet: 'never' }];
  };
  const chain = [
    { name: 'primary', backend: primaryBackend },
    { name: 'secondary', backend: secondaryBackend },
  ];
  const opts = { maxResults: 5, timeoutMs: 5000, userAgent: 'test' };
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const raceGraceMs = 1000;
  const result = await searchWithFallback(chain, 'test', opts, retry, raceGraceMs);
  assert.equal(result.length, 1, 'primary should win');
  assert.equal(result[0].title, 'primary');
  assert.ok(!secondaryCalled, 'secondary should not be called when primary wins within grace window');
});

test('parallel race: no-winner fallback waits for the whole chain (primary empty fast, secondary delayed hits)', async () => {
  // Regression: the no-winner path previously returned [] as soon as the FIRST
  // backend settled (Promise.all captured only the first promise), so a fast
  // empty primary short-circuited the chain and a delayed secondary with real
  // hits was never waited for. The fix makes launchNext await its recursion so
  // Promise.all sees every launched promise and the chain runs to completion.
  const primaryBackend = async (_q, _o) => {
    return []; // empty immediately — must NOT short-circuit the chain
  };
  const secondaryBackend = async (_q, _o) => {
    await new Promise((r) => setTimeout(r, 30));
    return [{ title: 'delayed-hit', url: 'https://delayed.example', snippet: 's' }];
  };
  const chain = [
    { name: 'primary', backend: primaryBackend },
    { name: 'secondary', backend: secondaryBackend },
  ];
  const opts = { maxResults: 5, timeoutMs: 5000, userAgent: 'test' };
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const raceGraceMs = 50;
  const result = await searchWithFallback(chain, 'test', opts, retry, raceGraceMs);
  assert.equal(result.length, 1, 'secondary delayed hit must be returned, not []');
  assert.equal(result[0].title, 'delayed-hit');
});

test('parallel race: all backends empty returns []', async () => {
  const chain = [
    { name: 'a', backend: async () => [] },
    { name: 'b', backend: async () => [] },
  ];
  const opts = { maxResults: 5, timeoutMs: 5000, userAgent: 'test' };
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const raceGraceMs = 20;
  const result = await searchWithFallback(chain, 'test', opts, retry, raceGraceMs);
  assert.equal(result.length, 0, 'all-empty chain returns []');
});

// ─── DATE FIELD IN FORMAT RESULTS ────────────────────────────────────────

test('formatResults includes date when present', () => {
  // We test indirectly through createWebSearchTool with a known backend
  const backend = async (_q, _o) => [
    { title: 'Test', url: 'https://t.example', snippet: 'desc', date: '2026-07-01' },
    { title: 'No date', url: 'https://n.example', snippet: 'no date here' },
  ];
  const f = stubFetch(() => { throw new Error('should not be called'); });
  try {
    const tool = createWebSearchTool({ search: backend });
    const promise = tool.execute({ query: 'test' }, { abortSignal: new AbortController().signal });
    // The execute calls searchWithFallback which calls our custom backend
    return promise.then(out => {
      assert.match(out, /2026-07-01/, 'date should appear in formatted output');
      assert.match(out, /Test/, 'title appears');
      assert.match(out, /No date/, 'result without date still appears');
      assert.ok(!out.includes('()'), 'no empty parentheses for undated result');
    });
  } finally {
    f.restore();
  }
});

// ─── CJK CHAIN ORDER ─────────────────────────────────────────────────────

test('resolveBackendChain with isCjk=true includes baidu before ddg', () => {
  const names = resolveBackendChain({}, true).map(c => c.name);
  const bingIdx = names.indexOf('bing');
  const baiduIdx = names.indexOf('baidu');
  const ddgIdx = names.indexOf('duckduckgo');
  assert.ok(baiduIdx >= 0, 'baidu should be in CJK chain');
  assert.ok(baiduIdx > bingIdx, 'baidu should come after bing');
  assert.ok(ddgIdx > baiduIdx, 'baidu should come before duckduckgo');
});

test('resolveBackendChain with isCjk=false omits baidu', () => {
  const names = resolveBackendChain({}, false).map(c => c.name);
  assert.ok(!names.includes('baidu'), 'baidu should not be in non-CJK chain');
  assert.ok(names.includes('duckduckgo'), 'duckduckgo should be in non-CJK chain');
});
