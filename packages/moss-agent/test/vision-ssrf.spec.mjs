#!/usr/bin/env node
/**
 * vision_analyze — anti-SSRF for URL image fetch.
 *
 * vision_analyze is LLM-callable and accepts an HTTP(S) URL. Without a
 * private-host check, a prompt could drive it to fetch internal services
 * (cloud metadata 169.254.169.254, localhost, RFC-1918 ranges) and exfiltrate
 * the response via the image block. Pin down that private/loopback/link-local
 * targets are refused before fetch.
 */
import assert from 'node:assert/strict';
import { visionAnalyzeTool } from '../dist/vision/vision-tool.js';

const ctx = () => ({ abortSignal: new AbortController().signal });

// ─── private / loopback / link-local URLs are refused (anti-SSRF) ──────────
for (const url of [
  'http://169.254.169.254/latest/meta-data/', // cloud metadata link-local
  'http://localhost/banner.png', // loopback
  'http://127.0.0.1/banner.png', // loopback
  'http://10.0.0.1/banner.png', // RFC-1918
  'http://192.168.1.1/banner.png', // RFC-1918
]) {
  const out = await visionAnalyzeTool.execute({ image: url }, ctx());
  assert.match(
    String(out),
    /private|loopback|link-local|anti-SSRF|Refusing/i,
    `private/loopback URL refused: ${url}`
  );
  assert.ok(
    !/base64/.test(String(out)) || /Error/i.test(String(out)),
    `no image data returned for private URL: ${url}`
  );
}

// ─── an unresolvable/invalid URL is rejected cleanly (not a crash) ────────
{
  const out = await visionAnalyzeTool.execute({ image: 'not-a-url' }, ctx());
  assert.match(String(out), /Error|invalid|unsupported/i, 'invalid input rejected cleanly');
}

console.log('  [PASS] vision: anti-SSRF — private/loopback/link-local URLs refused');
