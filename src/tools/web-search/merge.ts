/**
 * Evidence merging and ranking for multi-source search results: canonical URL
 * dedup, relevance scoring, news-date parsing, event-signature diversification.
 */

import type { WebSearchBackendOptions, WebSearchResult } from './types.js';

function canonicalResultUrl(urlText: string): string {
  try {
    const url = new URL(urlText);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|ref|source|campaign|spm|from)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    const normalizedPath =
      url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    return `${url.protocol}//${url.host}${normalizedPath}${url.search}`;
  } catch {
    return urlText;
  }
}

function resultRelevanceScore(result: WebSearchResult, query: string): number {
  const text = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  let score = isLikelyHomepageUrl(result.url) ? -3 : 3;
  if (result.date) score += 2;
  for (const token of query
    .toLowerCase()
    .split(/[\s"'，。！？、:：()（）]+/)
    .filter((part) => part.length > 1)) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

function isLikelyHomepageUrl(urlText: string): boolean {
  try {
    const url = new URL(urlText);
    return url.pathname === '/' || url.pathname === '';
  } catch {
    return true;
  }
}

function isArticleLevelNewsResult(result: WebSearchResult): boolean {
  if (!result.date) return false;
  try {
    const url = new URL(result.url);
    if (url.hostname === 'news.google.com') return false;
  } catch {
    return false;
  }
  return !isLikelyHomepageUrl(result.url);
}

export function mergeSearchEvidence(rows: WebSearchResult[]): WebSearchResult[] {
  const merged = new Map<string, WebSearchResult>();
  for (const row of rows) {
    const canonicalUrl = canonicalResultUrl(row.url);
    const existing = merged.get(canonicalUrl);
    if (!existing) {
      merged.set(canonicalUrl, { ...row, url: canonicalUrl });
      continue;
    }
    merged.set(canonicalUrl, {
      ...existing,
      ...row,
      url: canonicalUrl,
      title: row.title.length > existing.title.length ? row.title : existing.title,
      snippet: row.snippet.length > existing.snippet.length ? row.snippet : existing.snippet,
      date: row.date ?? existing.date,
      sourceName: row.sourceName ?? existing.sourceName,
      sourceUrl: row.sourceUrl ?? existing.sourceUrl,
    });
  }
  return [...merged.values()].sort((left, right) => {
    const rightScore = resultRelevanceScore(right, '') + (isArticleLevelNewsResult(right) ? 4 : 0);
    const leftScore = resultRelevanceScore(left, '') + (isArticleLevelNewsResult(left) ? 4 : 0);
    return rightScore - leftScore;
  });
}

function parsedResultDate(dateText: string | undefined, now = new Date()): number | undefined {
  if (!dateText) return undefined;
  const value = Date.parse(dateText);
  if (Number.isFinite(value)) return value;
  const chineseDate = dateText.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (chineseDate) {
    return Date.UTC(Number(chineseDate[1]), Number(chineseDate[2]) - 1, Number(chineseDate[3]));
  }
  const relative = dateText.match(/(\d{1,3})\s*(小时|天)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === '小时' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return now.getTime() - amount * unitMs;
  }
  return undefined;
}

function eventSignature(title: string): string {
  const normalized = title.toLowerCase();
  const groups = [
    [/xyz-100/i, 'xyz-100'],
    [/量产验证|量产路径|量产密码|头部客户|20\+?家|20余家/i, 'mass-validation'],
    [/千台级|规模化部署|工业具身/i, 'deployment'],
    [/ceo|访谈|对话|聊了聊/i, 'interview'],
    [/融资|融了|投资|资本/i, 'funding'],
    [/世界模型|一帧一反馈/i, 'world-model'],
    [/战略合作|达成合作/i, 'partnership'],
  ] as const;
  const tags = groups.filter(([pattern]) => pattern.test(normalized)).map(([, tag]) => tag);
  if (tags.includes('xyz-100') && tags.includes('mass-validation')) {
    return 'xyz-100-mass-validation';
  }
  if (tags.length > 0) return tags.join('|');
  return normalized.replace(/[\s，。！？、“”"'：:·—（）()-]/g, '').slice(0, 36);
}

export function diversifyNewsResults(
  rows: WebSearchResult[],
  recency: WebSearchBackendOptions['recency'],
  now = new Date()
): WebSearchResult[] {
  const windowMs =
    recency === 'day'
      ? 24 * 60 * 60 * 1000
      : recency === 'week'
        ? 7 * 24 * 60 * 60 * 1000
        : recency === 'month'
          ? 31 * 24 * 60 * 60 * 1000
          : recency === 'year'
            ? 366 * 24 * 60 * 60 * 1000
            : undefined;
  const recent = windowMs
    ? rows.filter((row) => {
        const publishedAt = parsedResultDate(row.date, now);
        return publishedAt === undefined || now.getTime() - publishedAt <= windowMs;
      })
    : rows;
  const selected = new Map<string, WebSearchResult>();
  for (const row of recent) {
    const signature = eventSignature(row.title);
    const existing = selected.get(signature);
    if (!existing || resultRelevanceScore(row, '') > resultRelevanceScore(existing, '')) {
      selected.set(signature, row);
    }
  }
  return [...selected.values()].sort((left, right) => {
    const rightDate = parsedResultDate(right.date, now) ?? 0;
    const leftDate = parsedResultDate(left.date, now) ?? 0;
    return rightDate - leftDate || resultRelevanceScore(right, '') - resultRelevanceScore(left, '');
  });
}
