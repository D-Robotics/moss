/**
 * RSS search backend — supplements keyless web search with structured feeds.
 *
 * The keyless search chain (Bing → Baidu → DuckDuckGo) returns unstructured
 * HTML results — titles + snippets + URLs. RSS feeds return structured
 * entries with **title, link, publication date, and full or summary content**,
 * which gives the LLM:
 *
 * 1. **Timeliness**: every entry has a pubDate — the LLM can filter by
 *    recency without relying on search-engine time filters (which are often
 *    unreliable for keyless backends).
 * 2. **Accuracy**: RSS content comes directly from the source (no search-engine
 *    snippet truncation or anti-bot interference). The LLM sees the actual
 *    article summary, not a scraped fragment.
 * 3. **Source authority**: RSS feeds are curated by the publisher — no SEO
 *    spam, no content farms. Results are from named sources (blogs, news
 *    sites, project release feeds).
 *
 * Design:
 * - Pluggable into the existing `WebSearchBackend` interface (same signature).
 * - No external dependency beyond global `fetch` (Node 18+).
 * - Supports a built-in catalog of tech/robotics news feeds + user-configurable
 *   feeds via `MOSS_RSS_FEEDS` env var.
 * - Filters by recency (day/week/month) using pubDate.
 * - Falls back gracefully on parse errors (malformed XML, network failures).
 *
 * @public
 */
import type { WebSearchResult, WebSearchBackend, WebSearchBackendOptions } from './web-search.js';
import { isPrivateHost } from './web-fetch.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 8;

/** Built-in feed catalog — tech, AI, robotics, developer news. */
const BUILTIN_FEEDS: RssFeed[] = [
  // AI / ML
  { url: 'https://openai.com/blog/rss.xml', category: 'ai', lang: 'en' },
  { url: 'https://www.anthropic.com/news/rss.xml', category: 'ai', lang: 'en' },
  { url: 'https://huggingface.co/blog/feed.xml', category: 'ai', lang: 'en' },
  { url: 'https://blog.google/technology/ai/rss/', category: 'ai', lang: 'en' },
  // Robotics
  { url: 'https://www.roboticsbusinessreview.com/feed/', category: 'robotics', lang: 'en' },
  // Developer
  { url: 'https://github.blog/feed/', category: 'dev', lang: 'en' },
  { url: 'https://stackoverflow.blog/feed/', category: 'dev', lang: 'en' },
  // Chinese tech
  { url: 'https://www.36kr.com/feed', category: 'tech', lang: 'zh' },
  { url: 'https://www.zhihu.com/rss', category: 'tech', lang: 'zh' },
];

export interface RssFeed {
  url: string;
  category?: string;
  lang?: 'en' | 'zh';
}

export interface RssSearchOptions {
  /** Custom feeds to search (in addition to or instead of built-ins). */
  feeds?: RssFeed[];
  /** Whether to include built-in feeds. Default true. */
  includeBuiltin?: boolean;
  /** Per-feed timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Override the SSRF private-host check. Production leaves this undefined so
   * the real `isPrivateHost` (DNS-based) guards every feed fetch. Tests inject
   * a stub so mock feed hosts (e.g. `rss-mock.test`) don't get rejected by
   * DNS resolution failure.
   *
   * @internal
   */
  isPrivateHostCheck?: (hostname: string) => Promise<boolean>;
}

interface RssEntry {
  title: string;
  link: string;
  pubDate?: Date;
  contentSnippet?: string;
  source?: string;
}

/**
 * Create an RSS search backend that fits the `WebSearchBackend` interface.
 *
 * The backend fetches configured RSS feeds in parallel, filters entries by
 * the query (case-insensitive substring match on title + content), filters
 * by recency if specified, and returns `WebSearchResult[]`.
 */
export function createRssSearchBackend(options: RssSearchOptions = {}): WebSearchBackend {
  const feeds = [
    ...(options.includeBuiltin !== false ? BUILTIN_FEEDS : []),
    ...(options.feeds ?? []),
  ];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isPrivateHostCheck = options.isPrivateHostCheck ?? isPrivateHost;

  return async (query: string, opts: WebSearchBackendOptions): Promise<WebSearchResult[]> => {
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

    // Fetch all feeds in parallel
    const feedResults = await Promise.allSettled(
      feeds.map((feed) => fetchAndParseFeed(feed.url, timeoutMs, opts.signal, isPrivateHostCheck)),
    );

    // Collect + filter entries
    const allEntries: RssEntry[] = [];
    for (let i = 0; i < feedResults.length; i++) {
      const result = feedResults[i];
      if (result.status !== 'fulfilled') continue;
      for (const entry of result.value) {
        // Match: any query term in title or content snippet
        const titleLower = entry.title.toLowerCase();
        const snippetLower = (entry.contentSnippet ?? '').toLowerCase();
        const matched = queryTerms.length === 0
          || queryTerms.some((term) => titleLower.includes(term) || snippetLower.includes(term));
        if (!matched) continue;

        // Recency filter
        if (opts.recency && entry.pubDate) {
          const now = new Date();
          const diffMs = now.getTime() - entry.pubDate.getTime();
          const maxAgeMs = {
            day: 86_400_000,
            week: 604_800_000,
            month: 2_592_000_000,
            year: 31_536_000_000,
          }[opts.recency];
          if (maxAgeMs && diffMs > maxAgeMs) continue;
        }

        allEntries.push(entry);
      }
    }

    // Sort by date (newest first), then by relevance (more term matches first)
    allEntries.sort((a, b) => {
      // Newer first
      const aTime = a.pubDate?.getTime() ?? 0;
      const bTime = b.pubDate?.getTime() ?? 0;
      if (bTime !== aTime) return bTime - aTime;
      // More term matches in title first
      const aTitleMatches = queryTerms.filter((t) => a.title.toLowerCase().includes(t)).length;
      const bTitleMatches = queryTerms.filter((t) => b.title.toLowerCase().includes(t)).length;
      return bTitleMatches - aTitleMatches;
    });

    // Map to WebSearchResult
    return allEntries.slice(0, maxResults).map((entry) => {
      const dateStr = entry.pubDate
        ? ` (${entry.pubDate.toISOString().slice(0, 10)})`
        : '';
      const sourceStr = entry.source ? ` — ${entry.source}` : '';
      return {
        title: `${entry.title}${dateStr}`,
        url: entry.link,
        snippet: (entry.contentSnippet ?? '').slice(0, 300) + sourceStr,
        date: entry.pubDate?.toISOString().slice(0, 10),
      };
    });
  };
}

// ── Feed fetching + XML parsing ─────────────────────────────────────────────

async function fetchAndParseFeed(
  feedUrl: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  isPrivateHostCheck: (hostname: string) => Promise<boolean> = isPrivateHost,
): Promise<RssEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    // M1 fix: SSRF protection — verify the feed URL doesn't resolve to a
    // private/loopback address before fetching (same isPrivateHost gate as
    // web_fetch). A poisoned MOSS_RSS_FEEDS env could otherwise reach
    // 169.254.169.254 or localhost.
    const url = new URL(feedUrl);
    if (await isPrivateHostCheck(url.hostname)) return [];
    const response = await fetch(feedUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; moss-agent/0.5; +https://github.com/D-Robotics/moss)' },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return parseRssXml(xml, feedUrl);
  } catch {
    return []; // network error, timeout, parse error — graceful degradation
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', () => controller.abort());
  }
}

/**
 * Minimal RSS/Atom XML parser — handles both RSS 2.0 (<item>) and
 * Atom 1.0 (<entry>) formats. No external dependency.
 */
function parseRssXml(xml: string, sourceUrl: string): RssEntry[] {
  const entries: RssEntry[] = [];

  // RSS 2.0: <item>...</item>
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    entries.push({
      title: cleanHtml(extractTag(item, 'title')) || '(untitled)',
      link: extractTag(item, 'link') || extractAttr(item, 'link', 'href') || '',
      pubDate: parseDate(extractTag(item, 'pubDate') || extractTag(item, 'dc:date')),
      contentSnippet: cleanHtml(extractTag(item, 'description') || extractTag(item, 'content:encoded')),
      source: extractHostname(sourceUrl),
    });
  }

  // Atom 1.0: <entry>...</entry>
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    entries.push({
      title: cleanHtml(extractTag(entry, 'title')) || '(untitled)',
      link: extractAttr(entry, 'link', 'href') || extractTag(entry, 'link') || '',
      pubDate: parseDate(extractTag(entry, 'published') || extractTag(entry, 'updated')),
      contentSnippet: cleanHtml(extractTag(entry, 'summary') || extractTag(entry, 'content')),
      source: extractHostname(sourceUrl),
    });
  }

  return entries;
}

function extractTag(xml: string, tag: string): string | undefined {
  // Handle CDATA: <tag><![CDATA[...]]></tag>
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = cdataRe.exec(xml);
  if (cdataMatch) return cdataMatch[1].trim();

  // Handle plain text: <tag>text</tag>
  const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const plainMatch = plainRe.exec(xml);
  if (plainMatch) return plainMatch[1].trim();

  return undefined;
}

function extractAttr(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i');
  const match = re.exec(xml);
  return match?.[1];
}

function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function cleanHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '') // strip tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Get the built-in feed list (for testing / configuration). */
export function getBuiltinFeeds(): RssFeed[] {
  return [...BUILTIN_FEEDS];
}

/** Parse user-configured feeds from MOSS_RSS_FEEDS env var (comma-separated URLs). */
export function parseUserFeeds(env: NodeJS.ProcessEnv = process.env): RssFeed[] {
  const raw = env.MOSS_RSS_FEEDS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => ({ url }));
}
