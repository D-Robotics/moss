#!/usr/bin/env node
/**
 * classifyProviderError — 超时不得被误判为 auth（2026-08-05 生产事故回归）。
 * 上游网关 45s 无首字节抛出的 LlmFirstChunkTimeoutError 文案里顺带提到
 * "API Key"，旧 matchAuth 的裸 `api key` 正则把它误判成 auth（retryable:false），
 * 20 个上游停滞 run 全部计为凭据故障且不重试，把 AI 成功率 SLO 燃烧率拉到 9.23x。
 */
import assert from 'node:assert/strict';

import { classifyProviderError } from '../dist/provider/error-classify.js';

// ─── 首字节超时文案：timeout 且可重试，绝不落 auth ────────────────────────

{
  const message =
    'LLM produced no streaming output (including thinking) within 45s. ' +
    'Check network/proxy, Base URL, API Key and model availability.';
  const r = classifyProviderError({ errorMessage: message });
  assert.equal(r.category, 'timeout', 'first-chunk stall is a timeout, not auth');
  assert.equal(r.retryable, true, 'first-chunk stall is retryable');
}

// ─── 显式凭据错误仍是 auth 且不可重试（无回归） ──────────────────────────

{
  const r = classifyProviderError({ errorMessage: 'Invalid API key', status: 401 });
  assert.equal(r.category, 'auth', '401 invalid key stays auth');
  assert.equal(r.retryable, false);
}

{
  const r = classifyProviderError({ errorMessage: 'Unauthorized: bad credentials' });
  assert.equal(r.category, 'auth', '"unauthorized" stays auth');
  assert.equal(r.retryable, false);
}

// 倒装凭据文案保召回（收紧裸 `api key` 后不能丢这类真实故障）
for (const errorMessage of ['API key is invalid', 'Your API key has expired', 'Bad API key']) {
  const r = classifyProviderError({ errorMessage });
  assert.equal(r.category, 'auth', `"${errorMessage}" stays auth after matchAuth tightening`);
  assert.equal(r.retryable, false);
}

// ─── 用户/系统中止语义落 aborted，不计为模型故障 ─────────────────────────

{
  const r = classifyProviderError({ errorMessage: 'Operation aborted', abortReason: 'user' });
  assert.equal(r.category, 'aborted_by_user', '"Operation aborted" is a user abort');
  assert.ok(r.silent, 'user abort surface is silent');
}

{
  const r = classifyProviderError({ errorMessage: 'Operation aborted' });
  assert.ok(
    r.category === 'aborted_by_user' || r.category === 'aborted_by_server',
    'abort without reason still routes to an aborted category',
  );
  assert.equal(r.category === 'auth', false, 'abort never falls into auth');
}

console.error('error-classify: timeout stall no longer misclassified as auth ✓');
