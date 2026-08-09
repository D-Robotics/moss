#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fastNewsRunPolicy, verifiedNewsResearchContext } from '../dist/cli/oneshot.js';

const policy = fastNewsRunPolicy(
  '今天机器人领域有什么大新闻？请只搜索一次，给我最多 5 条。每条包含日期和来源 URL。'
);
assert.ok(policy, 'fresh-news prompt gets a fast-news policy');
assert.equal(policy.maxToolCalls, 1);
assert.equal(policy.reasoning, 'off');
assert.equal(policy.maxOutputTokens, 700);
assert.equal(policy.toolInputLimits?.web_search?.max_results, 5);
assert.equal(policy.toolInputOverrides?.web_search?.published_on, undefined);
assert.match(policy.extraContext, /answer immediately after that result/i);

assert.equal(fastNewsRunPolicy('帮我修复项目里的 TypeScript 错误'), undefined);
assert.equal(
  fastNewsRunPolicy('Preserve concurrent read coalescing while fixing the stale cache bug.'),
  undefined,
  'the substring "current" inside "concurrent" is not a current-news signal'
);
assert.equal(
  fastNewsRunPolicy(
    'Implement updateSettings so it merges a partial patch with current settings, writes through a temp file plus rename, serializes concurrent updates, and runs npm test.'
  ),
  undefined,
  '"current settings" in an implementation task is not a current-news request'
);
assert.equal(
  verifiedNewsResearchContext('Cross-check concurrent cache invalidation with independent tests.'),
  undefined,
  'verification-heavy coding prompts are not routed as news research'
);

const dated = fastNewsRunPolicy('今天有什么新闻？只搜索一次，最多 3 条。今天是 2026-07-16。');
assert.equal(dated?.toolInputOverrides.web_search.published_on, '2026-07-16');

const followUp = fastNewsRunPolicy('和机器人相关的呢？', '今天有什么好玩的新闻？');
assert.ok(followUp, 'news follow-up inherits the previous turn freshness intent');
assert.match(followUp.extraContext, /follow-up/i);
assert.equal(followUp.toolInputOverrides.web_search.published_on, undefined);

const entityFollowUp = fastNewsRunPolicy('有地瓜机器人的什么信息吗？', '今天机器人有什么大新闻？');
assert.ok(
  entityFollowUp,
  'an entity narrowing question after fresh news stays in the one-search news path'
);
assert.equal(entityFollowUp.maxToolCalls, 1);
assert.match(entityFollowUp.extraContext, /internally performs multi-source/i);
assert.match(entityFollowUp.extraContext, /recent 24-hour window/i);
assert.match(entityFollowUp.extraContext, /never infer the local calendar date from result dates/i);

const verifiedResearch = fastNewsRunPolicy(
  '请并行检索机器人行业和地瓜机器人今天的新闻，至少用两个独立来源交叉验证，并给出原始文章 URL。'
);
assert.equal(
  verifiedResearch,
  undefined,
  'explicit parallel cross-source research must not be reduced to one search and 700 output tokens'
);
const verifiedContext = verifiedNewsResearchContext(
  '请并行检索今天的机器人新闻，至少用两个独立来源交叉验证，并给出原始文章 URL。'
);
assert.match(verifiedContext, /two independent article-level URLs/i);
assert.match(verifiedContext, /syndicated copies.*one source/i);
assert.match(verifiedContext, /single-source lead/i);
assert.equal(verifiedNewsResearchContext('今天有什么新闻？'), undefined);
console.log('[PASS] fast-news requests get one bounded low-reasoning run');
