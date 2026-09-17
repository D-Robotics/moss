#!/usr/bin/env node
/**
 * File and image attachment handling — tested from the user's perspective:
 * can the user attach files and images to their prompts, and are they described correctly?
 */
import assert from 'node:assert/strict';

import { extractAttachmentRefs, formatAttachmentChip } from '../dist/cli/tui.js';

// ─── extractAttachmentRefs — parsing attachment markers in prompt text ────────

{
  // No attachments in plain text
  const refs = extractAttachmentRefs('Hello, can you help me?');
  assert.deepEqual(refs, [], 'plain text has no attachment refs');
}

{
  // Image reference
  const refs = extractAttachmentRefs('Look at this [Image #1] please');
  assert.equal(refs.length, 1, 'one image ref found');
  assert.equal(refs[0].kind, 'image', 'correctly identified as image');
  assert.equal(refs[0].index, 1, 'index is 1');
  assert.equal(refs[0].label, 'Image #1', 'label is correct');
}

{
  // File reference
  const refs = extractAttachmentRefs('Here is [File #2] for review');
  assert.equal(refs.length, 1, 'one file ref found');
  assert.equal(refs[0].kind, 'file', 'correctly identified as file');
  assert.equal(refs[0].index, 2, 'index is 2');
}

{
  // Multiple attachments
  const refs = extractAttachmentRefs('See [Image #1] and [File #2] and [Image #3]');
  assert.equal(refs.length, 3, 'three attachment refs found');
  assert.equal(refs[0].kind, 'image');
  assert.equal(refs[1].kind, 'file');
  assert.equal(refs[2].kind, 'image');
}

{
  // Duplicate refs are deduplicated
  const refs = extractAttachmentRefs('[Image #1] and again [Image #1]');
  assert.equal(refs.length, 1, 'duplicate refs are deduplicated');
}

{
  // Empty text returns empty array
  const refs = extractAttachmentRefs('');
  assert.deepEqual(refs, []);
}

// ─── formatAttachmentChip — UI chip description ────────────────────────────────

{
  const chip = formatAttachmentChip({ index: 1, kind: 'image', label: 'Image #1' });
  assert.ok(chip.includes('Image #1'), 'chip includes the label');
  assert.ok(chip.includes('image'), 'chip mentions the kind');
}

{
  const chip = formatAttachmentChip({ index: 2, kind: 'file', label: 'File #2' });
  assert.ok(chip.includes('File #2'), 'chip includes the label');
  assert.ok(chip.includes('file'), 'chip mentions the kind');
}

console.log('[PASS] File and image attachment handling');
