#!/usr/bin/env node
/**
 * RSS search backend — tests for XML parsing, filtering, recency, and feed catalog.
 *
 * Tests the pure logic (XML parsing, entry filtering, date sorting, recency
 * filtering) without network — feeds are mocked as raw XML strings.
 */
import assert from 'node:assert/strict';
import {
  createRssSearchBackend,
  getBuiltinFeeds,
  parseUserFeeds,
} from '../dist/tools/rss-search.js';

// ─── 1. RSS 2.0 XML parsing ────────────────────────────────────────────────
{
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>AI breakthrough in robotics</title>
    <link>https://example.com/ai-robotics</link>
    <pubDate>Mon, 01 Jul 2025 10:00:00 GMT</pubDate>
    <description>New model achieves human-level dexterity</description>
  </item>
  <item>
    <title>Unrelated cooking post</title>
    <link>https://example.com/cooking</link>
    <pubDate>Tue, 02 Jul 2025 12:00:00 GMT</pubDate>
    <description>How to make pasta</description>
  </item>
</channel></rss>`;

  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://test' }] });
  // Monkey-patch fetch to return the mock XML
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => xml });
  try {
    const results = await backend('AI robotics', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.ok(results.length > 0, 'found matching entries');
    assert.ok(results[0].title.includes('AI breakthrough'), 'first result is the AI post');
    assert.ok(!results.some((r) => r.title.includes('cooking')), 'cooking post filtered out');
    assert.ok(results[0].date, 'date present');
    assert.ok(results[0].url.includes('example.com'), 'URL present');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 2. Atom 1.0 XML parsing ───────────────────────────────────────────────
{
  const atomXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Deep learning for robots</title>
    <link href="https://example.com/dl-robots"/>
    <published>2025-07-01T10:00:00Z</published>
    <summary>End-to-end training pipeline</summary>
  </entry>
</feed>`;

  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://atom' }] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => atomXml });
  try {
    const results = await backend('deep learning robots', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.ok(results.length > 0, 'Atom entry parsed');
    assert.ok(results[0].title.includes('Deep learning'), 'title correct');
    assert.ok(results[0].url.includes('example.com'), 'link from href attr');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 3. CDATA handling ─────────────────────────────────────────────────────
{
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[Robot <strong>vision</strong> update]]></title>
      <link>https://example.com/vision</link>
      <description><![CDATA[<p>New camera module</p>]]></description>
    </item>
  </channel></rss>`;

  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://cdata' }] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => xml });
  try {
    const results = await backend('robot vision', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.ok(results.length > 0, 'CDATA entry parsed');
    assert.ok(results[0].title.includes('Robot'), 'CDATA title extracted');
    assert.ok(!results[0].title.includes('<strong>'), 'HTML tags stripped from title');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 4. Recency filtering ──────────────────────────────────────────────────
{
  const old = new Date('2020-01-01').toUTCString();
  const recent = new Date().toUTCString();
  const xml = `<rss><channel>
    <item><title>Old news about AI</title><link>https://old.com</link><pubDate>${old}</pubDate></item>
    <item><title>Recent AI update</title><link>https://new.com</link><pubDate>${recent}</pubDate></item>
  </channel></rss>`;

  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://recency' }] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => xml });
  try {
    // recency=day → only recent
    const dayResults = await backend('AI', { maxResults: 10, timeoutMs: 1000, userAgent: 'test', recency: 'day' });
    assert.ok(dayResults.every((r) => !r.title.includes('Old news')), 'old entry filtered by recency=day');
    assert.ok(dayResults.some((r) => r.title.includes('Recent')), 'recent entry kept');

    // no recency → both
    const allResults = await backend('AI', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.ok(allResults.length >= 2, 'both entries without recency filter');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 5. Network failure graceful degradation ───────────────────────────────
{
  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://fail' }] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network error'); };
  try {
    const results = await backend('anything', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.equal(results.length, 0, 'network failure → empty results, no crash');
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 6. Built-in feed catalog ──────────────────────────────────────────────
{
  const feeds = getBuiltinFeeds();
  assert.ok(feeds.length >= 5, `at least 5 built-in feeds (got ${feeds.length})`);
  assert.ok(feeds.every((f) => f.url.startsWith('https://')), 'all URLs are HTTPS');
  assert.ok(feeds.some((f) => f.lang === 'zh'), 'includes Chinese feeds');
  assert.ok(feeds.some((f) => f.lang === 'en'), 'includes English feeds');
}

// ─── 7. User feed parsing from env ─────────────────────────────────────────
{
  const feeds = parseUserFeeds({ MOSS_RSS_FEEDS: 'https://a.com/feed, https://b.com/rss' });
  assert.equal(feeds.length, 2, '2 feeds parsed');
  assert.equal(feeds[0].url, 'https://a.com/feed', 'first URL');
  assert.equal(feeds[1].url, 'https://b.com/rss', 'second URL');

  const empty = parseUserFeeds({});
  assert.equal(empty.length, 0, 'no env → no feeds');

  const whitespace = parseUserFeeds({ MOSS_RSS_FEEDS: ' , , , ' });
  assert.equal(whitespace.length, 0, 'only whitespace → no feeds');
}

// ─── 8. Sort by date (newest first) ────────────────────────────────────────
{
  const xml = `<rss><channel>
    <item><title>AI old</title><link>https://a.com</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
    <item><title>AI new</title><link>https://b.com</link><pubDate>Wed, 01 Jan 2025 00:00:00 GMT</pubDate></item>
    <item><title>AI newest</title><link>https://c.com</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`;

  const backend = createRssSearchBackend({ includeBuiltin: false, feeds: [{ url: 'mock://sort' }] });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => xml });
  try {
    const results = await backend('AI', { maxResults: 10, timeoutMs: 1000, userAgent: 'test' });
    assert.ok(results[0].title.includes('AI newest'), 'newest first');
    assert.ok(results[1].title.includes('AI new'), 'second newest');
    assert.ok(results[2].title.includes('AI old'), 'oldest last');
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log('  [PASS] rss-search: RSS/Atom parsing, CDATA, recency, failure, catalog, env, sort');
