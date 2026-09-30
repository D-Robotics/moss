#!/usr/bin/env node
/**
 * Network egress policy (v0.16-S4): hostname allowlist matcher and URL
 * filter. Enforcement rides web_fetch's native `allowHosts` (request time AND
 * after redirects); web_search result pages go through the same fetch path.
 */
import assert from 'node:assert/strict';

import { createNetPolicy, hostMatches, hostOf } from '../dist/safety/net-allowlist.js';

// ─── hostMatches ────────────────────────────────────────────────────────────

assert.equal(hostMatches('example.com', 'example.com'), true, 'exact match');
assert.equal(hostMatches('example.com', 'api.example.com'), false, 'no subdomain bleed');
assert.equal(hostMatches('*.example.com', 'api.example.com'), true, 'wildcard subdomain');
assert.equal(hostMatches('*.example.com', 'example.com'), true, 'wildcard covers apex');
assert.equal(hostMatches('*.example.com', 'evil.com'), false);
assert.equal(hostMatches('EXAMPLE.com', 'Example.COM'), true, 'case-insensitive');

// ─── open policy (no allowlist configured) ──────────────────────────────────

{
  const open = createNetPolicy();
  assert.equal(open.open, true);
  assert.equal(open.isHostAllowed('anything.test'), true);
  assert.deepEqual(open.filterAllowedUrls(['https://a.test/x', 'https://b.test/y']), [
    'https://a.test/x',
    'https://b.test/y',
  ]);
}

// ─── closed policy ──────────────────────────────────────────────────────────

{
  const policy = createNetPolicy(['developer.d-robotics.cc', '*.github.com']);
  assert.equal(policy.open, false);
  assert.equal(policy.isHostAllowed('developer.d-robotics.cc'), true, 'listed host allowed');
  assert.equal(policy.isHostAllowed('api.github.com'), true, 'wildcard allowed');
  assert.equal(policy.isHostAllowed('evil.example'), false, 'unlisted host rejected');

  const kept = policy.filterAllowedUrls([
    'https://developer.d-robotics.cc/docs',
    'https://evil.example/payload',
    'https://gist.github.com/x',
    'not a url',
  ]);
  assert.deepEqual(kept, ['https://developer.d-robotics.cc/docs', 'https://gist.github.com/x']);

  assert.equal(hostOf('https://api.github.com:8443/x'), 'api.github.com');
  assert.equal(hostOf('garbage'), undefined);
}

console.log('[PASS] net egress policy');
