#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProviderError } from '../dist/provider/error-classify.js';

test('refused connect with HTTPS_PROXY blames the proxy, not the base URL', () => {
  const prev = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy,
    http_proxy: process.env.http_proxy,
  };
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    const r = classifyProviderError({
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:9',
      locale: 'en',
    });
    assert.equal(r.category, 'network');
    assert.match(r.userMessage, /[Pp]roxy/);
    assert.doesNotMatch(r.userMessage, /Nothing is listening at that base URL/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('refused connect without proxy still blames the base URL', () => {
  const prev = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy,
    http_proxy: process.env.http_proxy,
  };
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.https_proxy;
  delete process.env.http_proxy;
  try {
    const r = classifyProviderError({
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:9',
      locale: 'en',
    });
    assert.match(r.userMessage, /Fix the base URL|Nothing is listening at that base URL/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
