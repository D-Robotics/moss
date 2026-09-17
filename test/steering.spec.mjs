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
  diversifyNewsResults,
  createWebSearchTool,
  applyDomainFilters,
  normalizeDomainFilterList,
  preprocessQuery,
  baiduSearch,
  baiduResponseLooksBlocked,
  bingResponseLooksBlocked,
  bingSearch,
  duckDuckGoSearch,
  resolveBackendChain,
  searchAllWithBudget,
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
              name: 'Example X5 文档',
              url: 'https://example.com/x5_docs',
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
    const res = await createBochaSearch('key')('example x5', baseOpts);
    assert.equal(res.length, 1, 'non-http url is filtered out');
    assert.equal(res[0].title, 'Example X5 文档');
    assert.equal(res[0].url, 'https://example.com/x5_docs');
    assert.equal(res[0].snippet, '官方介绍', 'prefers summary over snippet');
    assert.match(f.calls[0].url, /api\.bochaai\.com/);
    assert.equal(f.calls[0].init.method, 'POST', 'Bocha API is POST, not GET');
    const body = JSON.parse(String(f.calls[0].init.body));
    assert.equal(body.query, 'example x5', 'query sent in JSON body, not as a query param');
    assert.equal(body.count, baseOpts.maxResults, 'count sent in JSON body');
    assert.equal(body.summary, true, 'summary requested');
    assert.match(
      String(
        f.calls[0].init.headers['content-type'] ||
          (f.calls[0].init.headers && f.calls[0].init.headers['Content-Type']) ||
          ''
      ),
      /application\/json/,
      'JSON content-type header set'
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
    const out = await tool.execute(
      { query: 'example board' },
      { abortSignal: new AbortController().signal }
    );
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
  const result = preprocessQuery('某机器人公司 最新资讯');
  assert.equal(result.region, 'zh-CN', 'CJK query auto-sets zh-CN region');
  assert.equal(result.query, '某机器人公司 最新资讯', 'query unchanged');
  assert.equal(result.siteHint, undefined, 'no site hint');
});

test('preprocessQuery: explicit region overrides CJK detection', () => {
  const result = preprocessQuery('某机器人公司', 'en-US');
  assert.equal(result.region, 'en-US', 'explicit region wins over CJK detection');
});

test('preprocessQuery: non-CJK query does not set region', () => {
  const result = preprocessQuery('Example X5 Board');
  assert.equal(result.region, undefined, 'no region for non-CJK query');
});

test('preprocessQuery: strips site: operator and extracts site hint', () => {
  const result = preprocessQuery('site:example.cn 某机器人公司');
  assert.ok(!result.query.includes('site:'), 'site: stripped from query');
  assert.ok(result.query.includes('example.cn'), 'site domain remains as a searchable keyword');
  assert.equal(result.siteHint, 'example.cn', 'site domain extracted as hint');
  assert.equal(result.region, 'zh-CN', 'CJK detection still works after site: strip');
});

test('site-scoped search never returns results from another domain', async () => {
  const tool = createWebSearchTool({
    search: async () => [
      { title: 'Wrong domain', url: 'https://example.com/docs', snippet: 'irrelevant' },
      { title: 'Official docs', url: 'https://docs.example.org/guide', snippet: 'relevant' },
    ],
  });
  const out = await tool.execute(
    { query: 'site:docs.example.org agent guide' },
    { abortSignal: new AbortController().signal }
  );
  assert.match(out, /docs\.example\.org\/guide/);
  assert.doesNotMatch(out, /example\.com\/docs/);
});

test('preprocessQuery: strips OR boolean operator', () => {
  const result = preprocessQuery('site:example.cn OR site:docs.example.com');
  assert.ok(!result.query.includes('OR'), 'OR stripped from query');
  assert.ok(result.siteHint.includes('example.cn'), 'first site extracted');
  assert.ok(result.siteHint.includes('docs.example.com'), 'second site extracted');
});

test('preprocessQuery: query that is only operators yields empty string', () => {
  const result = preprocessQuery('OR');
  assert.equal(result.query, '', 'operators-only query yields empty string after stripping');
});

// ─── DEFAULT UA ──────────────────────────────────────────────────────────

test('createWebSearchTool default UA is a current Chrome UA', async () => {
  const f = stubFetch(() =>
    jsonResponse(200, {
      code: 200,
      data: { webPages: { value: [{ name: 'hit', url: 'https://h.example', summary: 'sum' }] } },
    })
  );
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
  const f = stubFetch(() =>
    htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>')
  );
  try {
    await bingSearch('test', { maxResults: 5, timeoutMs: 1000, userAgent: 'test', recency: 'day' });
    assert.match(f.calls[0].url, /filters=/, 'Bing URL should contain filters param');
    assert.match(f.calls[0].url, /%221\+day%22/, 'Bing filters should encode "1 day"');
  } finally {
    f.restore();
  }
});

test('recency=week adds Bing filters param', async () => {
  const f = stubFetch(() =>
    htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>')
  );
  try {
    await bingSearch('test', {
      maxResults: 5,
      timeoutMs: 1000,
      userAgent: 'test',
      recency: 'week',
    });
    assert.match(f.calls[0].url, /%221\+week%22/, 'Bing filters should encode "1 week"');
  } finally {
    f.restore();
  }
});

test('recency=month adds Bing filters param', async () => {
  const f = stubFetch(() =>
    htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>')
  );
  try {
    await bingSearch('test', {
      maxResults: 5,
      timeoutMs: 1000,
      userAgent: 'test',
      recency: 'month',
    });
    assert.match(f.calls[0].url, /%221\+month%22/, 'Bing filters should encode "1 month"');
  } finally {
    f.restore();
  }
});

test('recency=year adds Bing filters param', async () => {
  const f = stubFetch(() =>
    htmlResponse(200, '<html><body class="b_results"><div class="b_algo"></div></body></html>')
  );
  try {
    await bingSearch('test', {
      maxResults: 5,
      timeoutMs: 1000,
      userAgent: 'test',
      recency: 'year',
    });
    assert.match(f.calls[0].url, /%221\+year%22/, 'Bing filters should encode "1 year"');
  } finally {
    f.restore();
  }
});

test('recency=day adds DDG df=d param to POST body', async () => {
  const f = stubFetch(() => jsonResponse(200, '<html><body></body></html>'));
  try {
    await assert.rejects(() =>
      duckDuckGoSearch('test', { maxResults: 5, timeoutMs: 500, userAgent: 'test', recency: 'day' })
    );
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
  <h3 class="t"><a href="http://www.baidu.com/link?url=abcdefg" target="_blank" data-url="https://example.com/x5_docs">Example X5 官方文档</a></h3>
  <div class="c-abstract">这是某公司的Example X5开发板文档</div>
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
    const res = await baiduSearch('某机器人公司', {
      maxResults: 10,
      timeoutMs: 1000,
      userAgent: 'test',
    });
    assert.equal(res.length, 2, 'should return 2 organic results (ad filtered)');
    assert.equal(res[0].title, 'Example X5 官方文档');
    assert.equal(res[0].url, 'https://example.com/x5_docs', 'data-url extracted');
    assert.equal(res[0].snippet, '这是某公司的Example X5开发板文档');
    assert.equal(res[0].date, '2026年6月14日', 'date extracted from c-color-gray');
    assert.equal(res[1].title, '正常结果二');
    assert.ok(!res[1].date, 'result without date should have undefined date');
  } finally {
    f.restore();
  }
});

test('baiduResponseLooksBlocked matches bing pattern', () => {
  // Should detect blocked pages
  assert.ok(
    baiduResponseLooksBlocked('<html><head><title>验证</title></head><body>安全检查</body></html>'),
    'verification page detected'
  );
  assert.ok(
    baiduResponseLooksBlocked('<html><body>access denied</body></html>'),
    'access denied detected'
  );
  // Should NOT detect normal results as blocked
  assert.ok(!baiduResponseLooksBlocked(BAIDU_FIXTURE), 'valid baidu results not blocked');
  // Should detect empty page without result markup
  assert.ok(
    baiduResponseLooksBlocked('<html><head><title>百度</title></head><body></body></html>'),
    'empty page without result markup is blocked'
  );
  // Should detect unexpected behavior page
  assert.ok(
    baiduResponseLooksBlocked(
      '<html><head><title>百度</title></head><body><p>unusual traffic</p></body></html>'
    ),
    'unusual traffic detected'
  );
});

test('bingResponseLooksBlocked: blocked page detection', () => {
  assert.ok(
    bingResponseLooksBlocked('<html><body><div id="captcha">verify</div></body></html>'),
    'captcha detected'
  );
  assert.ok(bingResponseLooksBlocked('<html><body>异常流量</body></html>'), 'CJK captcha detected');
  assert.ok(
    !bingResponseLooksBlocked(
      '<html><body class="b_results"><div class="b_algo"></div></body></html>'
    ),
    'valid results not blocked'
  );
});

// ─── PARALLEL RACING ─────────────────────────────────────────────────────

test('parallel race: secondary wins when primary exceeds grace window', async () => {
  const t0 = Date.now();
  // Create backends with controlled delays
  const primaryBackend = async (_q, _o) => {
    await new Promise((r) => setTimeout(r, 300));
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
  assert.ok(
    !secondaryCalled,
    'secondary should not be called when primary wins within grace window'
  );
});

test('fresh-news race waits for dated evidence instead of accepting a faster undated result', async () => {
  const primaryBackend = async () => [
    {
      title: 'Fast portal result',
      url: 'https://portal.example/',
      snippet: 'generic portal summary',
    },
  ];
  const secondaryBackend = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [
      {
        title: 'Dated publisher report',
        url: 'https://publisher.example/news/dated-report',
        snippet: 'dated evidence',
        date: '2026-07-16',
        sourceName: 'Publisher',
      },
    ];
  };
  const result = await searchWithFallback(
    [
      { name: 'fast-undated', backend: primaryBackend },
      { name: 'slower-dated', backend: secondaryBackend },
    ],
    'robotics news today',
    { maxResults: 5, timeoutMs: 5000, userAgent: 'test', recency: 'day' },
    { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() },
    10,
    { acceptResults: (results) => results.some((entry) => Boolean(entry.date)) }
  );
  assert.equal(result[0]?.title, 'Dated publisher report');
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

test('parallel evidence search merges successful sources instead of cancelling slower evidence', async () => {
  const chain = [
    {
      name: 'fast',
      backend: async () => [
        {
          title: 'Fast evidence',
          url: 'https://fast.example/news/1',
          snippet: 'fast',
          date: '2026-07-16',
        },
      ],
    },
    {
      name: 'slower',
      backend: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [
          {
            title: 'Slower evidence',
            url: 'https://slow.example/news/2',
            snippet: 'slow',
            date: '2026-07-16',
          },
        ];
      },
    },
  ];
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const results = await searchAllWithBudget(chain, 'robot news', baseOpts, retry, 200);
  assert.deepEqual(results.map((result) => result.title).sort(), [
    'Fast evidence',
    'Slower evidence',
  ]);
});

test('parallel evidence search deduplicates the same article across sources', async () => {
  const chain = [
    {
      name: 'exa',
      backend: async () => [
        {
          title: 'Example Corp launches S600',
          url: 'https://example.com/news/s600?utm_source=exa',
          snippet: 'short',
          date: '2026-07-16',
        },
      ],
    },
    {
      name: 'browser',
      backend: async () => [
        {
          title: 'Example Corp launches S600',
          url: 'https://example.com/news/s600',
          snippet: 'a fuller article summary',
          date: '2026-07-16',
        },
      ],
    },
  ];
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const results = await searchAllWithBudget(chain, 'Example Corp S600', baseOpts, retry, 200);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/news/s600');
  assert.equal(results[0].snippet, 'a fuller article summary');
});

test('parallel evidence search returns completed evidence when another source exceeds budget', async () => {
  const chain = [
    {
      name: 'fast',
      backend: async () => [
        {
          title: 'Available',
          url: 'https://example.com/news/available',
          snippet: 'ready',
          date: '2026-07-16',
        },
      ],
    },
    {
      name: 'hung',
      backend: async (_query, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => resolve([]), { once: true });
        }),
    },
  ];
  const retry = { maxAttempts: 1, baseDelayMs: 0, sleep: () => Promise.resolve() };
  const started = Date.now();
  const results = await searchAllWithBudget(chain, 'robot news', baseOpts, retry, 40);
  assert.equal(results[0].title, 'Available');
  assert.ok(Date.now() - started < 150);
});

// ─── DATE FIELD IN FORMAT RESULTS ────────────────────────────────────────

test('formatResults includes date when present', () => {
  // We test indirectly through createWebSearchTool with a known backend
  const backend = async (_q, _o) => [
    { title: 'Test', url: 'https://t.example', snippet: 'desc', date: '2026-07-01' },
    { title: 'No date', url: 'https://n.example', snippet: 'no date here' },
  ];
  const f = stubFetch(() => {
    throw new Error('should not be called');
  });
  try {
    const tool = createWebSearchTool({ search: backend });
    const promise = tool.execute({ query: 'test' }, { abortSignal: new AbortController().signal });
    // The execute calls searchWithFallback which calls our custom backend
    return promise.then((out) => {
      assert.match(
        out,
        /BEGIN UNTRUSTED WEB SEARCH RESULTS/,
        'search output has an explicit untrusted-data boundary'
      );
      assert.match(
        out,
        /data, not instructions/i,
        'search snippets cannot become agent instructions'
      );
      assert.match(out, /2026-07-01/, 'date should appear in formatted output');
      assert.match(out, /Test/, 'title appears');
      assert.match(out, /No date/, 'result without date still appears');
      assert.ok(!out.includes('()'), 'no empty parentheses for undated result');
      assert.match(out, /END UNTRUSTED WEB SEARCH RESULTS/);
      assert.match(
        out,
        /FRESH-NEWS ANSWER CONTRACT/i,
        'fresh news evidence carries a prominent response contract'
      );
      assert.match(
        out,
        /each cited item.*publication date/i,
        'the response contract requires a date per cited item'
      );
      assert.match(
        out,
        /clickable.*URL/i,
        'the response contract requires a source URL per cited item'
      );
    });
  } finally {
    f.restore();
  }
});

test('run-level max_results limit overrides an oversized model request', async () => {
  // Use today's date so the day recency window keeps the mock results (a
  // hardcoded absolute date would fall outside the rolling 24h window once
  // that date passes, making the test flaky/date-bound).
  const todayIso = new Date().toISOString();
  let observedMaxResults = 0;
  const tool = createWebSearchTool({
    search: async (_query, options) => {
      observedMaxResults = options.maxResults;
      return Array.from({ length: options.maxResults }, (_, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: 'dated result',
        date: todayIso,
      }));
    },
  });
  const out = await tool.execute(
    { query: 'robotics news', recency: 'day', max_results: 15 },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'bounded-search',
      toolInputLimits: { web_search: { max_results: 5 } },
    }
  );
  assert.equal(observedMaxResults, 5);
  assert.match(out, /Found 5 result\(s\)/);
  assert.doesNotMatch(out, /6\. Result 6/);
});

test('run-level published_on override filters out yesterday and surfaces source URLs', async () => {
  // Relative dates so the test is not bound to a calendar day: "today" is
  // within the day window, "yesterday" is just outside it, and published_on
  // pins to the today date.
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const tool = createWebSearchTool({
    search: async () => [
      {
        title: 'Today item',
        url: 'https://news.google.com/rss/articles/today',
        sourceUrl: 'https://official.example/news/today',
        sourceName: 'Official Example',
        snippet: 'today',
        date: todayStr,
      },
      {
        title: 'Yesterday item',
        url: 'https://news.google.com/rss/articles/yesterday',
        sourceUrl: 'https://official.example/news/yesterday',
        sourceName: 'Official Example',
        snippet: 'yesterday',
        date: yesterdayStr,
      },
    ],
  });
  const out = await tool.execute(
    { query: 'robotics news', recency: 'day', max_results: 5 },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'dated-search',
      toolInputOverrides: { web_search: { published_on: todayStr } },
    }
  );
  assert.match(out, /Today item/);
  assert.doesNotMatch(out, /Yesterday item/);
  assert.match(out, /https:\/\/official\.example\/news\/today/);
  assert.doesNotMatch(out, /https:\/\/official\.example\/news\/yesterday/);
});

test('today queries keep recent dated results across a midnight boundary', async () => {
  const now = new Date();
  // Use a rolling-window fixture: 6 hours ago is always inside 24h, and is
  // often "yesterday" after local midnight without depending on clock edges.
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  assert.ok(
    now.getTime() - sixHoursAgo.getTime() < 24 * 60 * 60 * 1000,
    'fixture must remain inside the rolling 24-hour window'
  );
  const tool = createWebSearchTool({
    search: async () => [
      {
        title: 'Today',
        url: 'https://example.com/today',
        snippet: 'today',
        date: now.toISOString(),
      },
      {
        title: 'Yesterday',
        url: 'https://example.com/yesterday',
        snippet: 'yesterday',
        date: sixHoursAgo.toISOString(),
      },
    ],
  });
  const out = await tool.execute(
    { query: '今天机器人有什么新闻', recency: 'day' },
    { workspaceDir: process.cwd(), sessionKey: 'today-filter' }
  );
  assert.match(out, /Today/);
  assert.match(
    out,
    /Yesterday/,
    'recency=day is a rolling window; exact-date filtering requires an explicit override'
  );
});

test('news diversification collapses syndicated coverage of one event', () => {
  const results = diversifyNewsResults(
    [
      {
        title: '某机器人公司获超20家具身智能头部企业认可 XYZ-100已开启量产验证',
        url: 'https://a.example/1',
        snippet: 'a',
        date: '2026-07-15T13:38:31Z',
      },
      {
        title: 'WAIC期间落地多项合作成果 XYZ-100拿下头部客户认可开启量产验证',
        url: 'https://b.example/2',
        snippet: 'b',
        date: '2026-07-15T12:25:44Z',
      },
      {
        title: 'XYZ-100打通具身智能量产路径，超20家具身智能头部企业都在用',
        url: 'https://c.example/3',
        snippet: 'c',
        date: '2026-07-15T13:49:24Z',
      },
      {
        title: '关于机器人的算力标准和量产交付，我们和某公司CEO聊了聊',
        url: 'https://d.example/4',
        snippet: 'd',
        date: '2026-07-15T15:02:09Z',
      },
      {
        title: '搭载XYZ-100，某创企公司开启千台级工业具身机器人规模化部署',
        url: 'https://e.example/5',
        snippet: 'e',
        date: '2026-07-14T12:46:00Z',
      },
    ],
    'week',
    new Date('2026-07-16T00:00:00Z')
  );

  assert.equal(results.length, 3);
  assert.ok(results.some((result) => /某公司CEO/.test(result.title)));
  assert.ok(results.some((result) => /千台级/.test(result.title)));
  assert.equal(
    results.filter((result) => /20家|头部客户|量产验证|量产路径/.test(result.title)).length,
    1
  );
});

test('news diversification enforces the requested rolling recency window', () => {
  const results = diversifyNewsResults(
    [
      {
        title: 'Fresh',
        url: 'https://example.com/fresh',
        snippet: 'fresh',
        date: '2026-07-15T12:00:00Z',
      },
      {
        title: 'Old',
        url: 'https://example.com/old',
        snippet: 'old',
        date: '2025-11-21T08:00:00Z',
      },
      {
        title: 'Old Chinese date',
        url: 'https://example.com/old-cn',
        snippet: 'old',
        date: '2024年9月22日',
      },
      {
        title: 'Recent relative date',
        url: 'https://example.com/recent-relative',
        snippet: 'fresh',
        date: '9小时前',
      },
    ],
    'week',
    new Date('2026-07-16T00:00:00Z')
  );
  assert.deepEqual(results.map((result) => result.title).sort(), ['Fresh', 'Recent relative date']);
});

// ─── CJK CHAIN ORDER ─────────────────────────────────────────────────────

test('resolveBackendChain with isCjk=true includes baidu before ddg', () => {
  const names = resolveBackendChain({}, true).map((c) => c.name);
  const bingIdx = names.indexOf('bing');
  const baiduIdx = names.indexOf('baidu');
  const ddgIdx = names.indexOf('duckduckgo');
  assert.ok(baiduIdx >= 0, 'baidu should be in CJK chain');
  assert.ok(baiduIdx > bingIdx, 'baidu should come after bing');
  assert.ok(ddgIdx > baiduIdx, 'baidu should come before duckduckgo');
});

test('resolveBackendChain with isCjk=false omits baidu', () => {
  const names = resolveBackendChain({}, false).map((c) => c.name);
  assert.ok(!names.includes('baidu'), 'baidu should not be in non-CJK chain');
  assert.ok(names.includes('duckduckgo'), 'duckduckgo should be in non-CJK chain');
});

// ─── query_keyword_groups (parallel multi-angle) ───────────────────────────

test('query_keyword_groups runs angles in parallel and merges/dedupes', async () => {
  const calls = [];
  const tool = createWebSearchTool({
    search: async (query) => {
      calls.push(query);
      return [
        {
          title: `${query} A`,
          url: `https://example.com/${encodeURIComponent(query)}-a`,
          snippet: 'a',
        },
        { title: 'Shared', url: 'https://example.com/shared', snippet: 'shared hit' },
      ];
    },
  });
  const out = await tool.execute(
    {
      query: 'Redis benchmark',
      query_keyword_groups: ['Memcached benchmark', 'DragonflyDB benchmark', 'Redis benchmark'],
      max_results: 10,
    },
    { workspaceDir: process.cwd(), sessionKey: 't', abortSignal: new AbortController().signal }
  );
  // Primary + two unique groups (duplicate Redis stripped)
  assert.equal(calls.length, 3, `expected 3 angles, got ${calls.length}: ${calls.join(' | ')}`);
  assert.ok(calls.includes('Redis benchmark'));
  assert.ok(calls.includes('Memcached benchmark'));
  assert.ok(calls.includes('DragonflyDB benchmark'));
  assert.match(String(out), /parallel angle/i);
  // Shared URL should appear once after merge
  const sharedHits = String(out).match(/example\.com\/shared/g) ?? [];
  assert.equal(sharedHits.length, 1, 'shared URL deduped');
});

// ─── domain allow/block filters ────────────────────────────────────────────

test('normalizeDomainFilterList strips schemes and www', () => {
  assert.deepEqual(
    normalizeDomainFilterList(['https://www.Docs.Python.org/3/', 'github.com', 'github.com', '']),
    ['docs.python.org', 'github.com']
  );
});

test('applyDomainFilters allow and block', () => {
  const rows = [
    { title: 'A', url: 'https://docs.python.org/3/library/os.html', snippet: 'a' },
    { title: 'B', url: 'https://github.com/python/cpython', snippet: 'b' },
    { title: 'C', url: 'https://pinterest.com/x', snippet: 'c' },
  ];
  const allowed = applyDomainFilters(rows, ['docs.python.org'], []);
  assert.deepEqual(
    allowed.map((r) => r.title),
    ['A']
  );
  const blocked = applyDomainFilters(rows, [], ['pinterest.com']);
  assert.deepEqual(
    blocked.map((r) => r.title),
    ['A', 'B']
  );
  const both = applyDomainFilters(rows, ['github.com', 'docs.python.org'], ['github.com']);
  assert.deepEqual(
    both.map((r) => r.title),
    ['A']
  );
});

test('web_search allowed_domains filters backend results', async () => {
  const tool = createWebSearchTool({
    search: async () => [
      { title: 'PyDocs', url: 'https://docs.python.org/3/', snippet: 'docs' },
      { title: 'Other', url: 'https://example.com/x', snippet: 'other' },
    ],
  });
  const out = await tool.execute(
    { query: 'os module', allowed_domains: ['docs.python.org'], max_results: 10 },
    { workspaceDir: process.cwd(), sessionKey: 't', abortSignal: new AbortController().signal }
  );
  assert.match(String(out), /PyDocs|docs\.python\.org/);
  assert.doesNotMatch(String(out), /example\.com\/x/);
});
