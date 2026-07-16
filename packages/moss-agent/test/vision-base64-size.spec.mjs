#!/usr/bin/env node
import assert from 'node:assert/strict';
import { base64DecodedSize } from '../dist/vision/vision-tool.js';

for (const size of [1, 2, 3, 4, 5, 1024]) {
  const encoded = Buffer.alloc(size, 0xab).toString('base64');
  assert.equal(base64DecodedSize(encoded), size, `base64 size is exact for ${size} byte(s)`);
}

console.log('[PASS] vision base64 byte accounting is exact');
