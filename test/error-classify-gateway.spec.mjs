#!/usr/bin/env node
/** In-chat provider errors: 401 and 403 stay distinct, HTML login pages get a next step. */
import assert from 'node:assert/strict';

import { classifyProviderError } from '../dist/provider/error-classify.js';

{
  const auth = classifyProviderError({
    status: 401,
    errorMessage: 'Received API Key = sk-fake-key-000',
    locale: 'zh_CN.UTF-8',
  });
  assert.equal(auth.category, 'auth');
  assert.match(auth.userMessage, /密钥被拒绝（401）/);
  assert.match(auth.userMessage, /moss setup/);
  assert.match(auth.userMessage, /网关原文：/);
  assert.doesNotMatch(auth.userMessage, /sk-fake-key-000/);
  const setup = classifyProviderError({
    status: 401,
    errorMessage: 'invalid api key',
    locale: 'zh_CN.UTF-8',
    audience: 'setup',
  });
  assert.match(setup.userMessage, /密钥被拒绝（401）/);
  assert.doesNotMatch(setup.userMessage, /moss setup/);
}

{
  const forbidden = classifyProviderError({
    status: 403,
    errorMessage: 'permission denied for this key',
    locale: 'zh_CN.UTF-8',
  });
  assert.equal(forbidden.category, 'auth');
  assert.match(forbidden.userMessage, /（403）/);
  assert.match(forbidden.userMessage, /不是密钥错误/);
  assert.doesNotMatch(forbidden.userMessage, /重新粘贴|moss setup/);
  const model = classifyProviderError({
    status: 403,
    errorMessage: 'Tried to access deepseek-nope',
    locale: 'C',
  });
  assert.equal(model.category, 'model_not_found');
  assert.doesNotMatch(model.userMessage, /rejected key \(401\)/);
}

{
  const portal = classifyProviderError({
    errorMessage:
      'captive portal or proxy login page: <html><body>Please log in</body></html> stream terminated without [DONE]',
    locale: 'zh_CN.UTF-8',
  });
  assert.equal(portal.category, 'network');
  assert.match(portal.userMessage, /登录页/);
  assert.match(portal.userMessage, /浏览器/);
  assert.match(portal.userMessage, /网关原文：<html><body>Please log in<\/body><\/html>/);
  assert.doesNotMatch(portal.userMessage, /captive portal or proxy login page/);
  assert.doesNotMatch(portal.userMessage, /gateway API error/);
  assert.doesNotMatch(portal.userMessage, /流在处理事件之后抛出/);
  const bare = classifyProviderError({
    errorMessage: '<!DOCTYPE html><html><head><title>Login</title></head></html>',
    locale: 'zh_CN.UTF-8',
  });
  assert.match(bare.userMessage, /登录页/);
  assert.match(bare.userMessage, /网关原文：<!DOCTYPE html>/);
  assert.doesNotMatch(bare.userMessage, /captive portal or proxy login page/);
}

{
  const wrapped = classifyProviderError({
    status: 401,
    locale: 'zh_CN.UTF-8',
    errorMessage:
      'OpenAI-compatible provider returned HTTP 401: invalid api key — check your API key (moss setup or moss config set apiKey)',
  });
  assert.match(wrapped.userMessage, /网关原文：invalid api key/);
  assert.doesNotMatch(wrapped.userMessage, /provider returned HTTP/);
  assert.doesNotMatch(wrapped.userMessage, /check your API key/);
  const modelHint = classifyProviderError({
    status: 400,
    locale: 'C',
    errorMessage:
      'OpenAI-compatible provider returned HTTP 400: Model Not Exist — this model name is not available on the gateway. Run `/model` to pick one from the list, or `moss setup` to reconfigure.',
  });
  assert.match(modelHint.userMessage, /Gateway text: Model Not Exist/);
  assert.doesNotMatch(modelHint.userMessage, /Run `\/model`/);
  assert.doesNotMatch(modelHint.userMessage, /provider returned HTTP/);
  const refusedInput =
    'fetch failed for 127.0.0.1:59999 (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:59999)\nConnection refused by 127.0.0.1:59999 — the server is not running or the port is wrong. Check that the gateway/service is up and the baseUrl port is correct.';
  const refused = classifyProviderError({
    locale: 'zh_CN.UTF-8',
    errorMessage: refusedInput,
  });
  assert.equal(refused.category, 'network');
  assert.doesNotMatch(refused.userMessage, /网关原文/);
  assert.doesNotMatch(refused.userMessage, /Check that the gateway/);
  const setupRefused = classifyProviderError({
    locale: 'zh_CN.UTF-8',
    audience: 'setup',
    errorMessage: refusedInput,
  });
  assert.match(setupRefused.userMessage, /详细信息：/);
  assert.match(setupRefused.userMessage, /ECONNREFUSED/);
  assert.doesNotMatch(setupRefused.userMessage, /网关原文/);
  assert.doesNotMatch(setupRefused.userMessage, /Check that the gateway/);
  const dns = classifyProviderError({
    locale: 'zh_CN.UTF-8',
    audience: 'setup',
    errorMessage: 'getaddrinfo ENOTFOUND no-such.example',
  });
  assert.equal(dns.category, 'network');
  assert.match(dns.userMessage, /详细信息：getaddrinfo ENOTFOUND/);
  assert.doesNotMatch(dns.userMessage, /网关原文/);
  const timed = classifyProviderError({
    locale: 'C',
    audience: 'setup',
    errorMessage: 'connect ETIMEDOUT 10.0.0.1:443',
  });
  assert.equal(timed.category, 'timeout');
  assert.match(timed.userMessage, /Details: connect ETIMEDOUT/);
  assert.doesNotMatch(timed.userMessage, /Gateway text/);
  const chatTimeout = classifyProviderError({
    locale: 'C',
    errorMessage: 'connect ETIMEDOUT 10.0.0.1:443',
  });
  assert.doesNotMatch(chatTimeout.userMessage, /Gateway text|Details:/);
}

console.log('[PASS] error-classify-gateway');
