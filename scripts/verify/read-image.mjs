#!/usr/bin/env node
/**
 * Deterministic probe for the image-link slice of backlog B01.
 *
 * Before this change read_file reported binary files as errors and nothing
 * attached an image to the conversation, while the help text advertised image
 * input. These checks pin the tool, its guards, the session→provider conversion
 * of a tool-result image, and the structured-content budget that would
 * otherwise replace every real screenshot with a truncation notice.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const builtin = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);
const convert = await import(
  pathToFileURL(path.join(root, 'dist/core/tools/message-convert.js')).href
);
const imageToolModule = await import(
  pathToFileURL(path.join(root, 'dist/tools/read-image-tool.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[read-image] ok ${name}`);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const tool = builtin.builtinTools.find((candidate) => candidate.name === 'read_image');

// ── 1. Registration and side-effect metadata ───────────────────────────────

assert.ok(tool, 'read_image must be registered in builtinTools');
assert.equal(tool.metadata?.sideEffectClass, 'readonly');
assert.equal(tool.metadata?.planMode, 'allow');
assert.ok(tool.description.length > 40);
assert.deepEqual(tool.inputSchema.required, ['path']);
ok('read_image is registered as a readonly, plan-safe tool');

// ── 2. A real PNG is attached (not just described) ─────────────────────────

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-image-'));
const ctx = { workspaceDir: dir };
try {
  const pngPath = path.join(dir, 'shot.png');
  await fs.writeFile(pngPath, PNG_1X1);

  const prepared = await tool.executeStructured({ path: 'shot.png' }, ctx);
  assert.equal(prepared.isError, undefined);
  const textBlock = prepared.content.find((block) => block.type === 'text');
  const imageBlock = prepared.content.find((block) => block.type === 'image');
  assert.ok(textBlock && textBlock.text.includes('image/png'));
  assert.ok(textBlock.text.includes('shot.png'));
  assert.ok(imageBlock, 'structured result must carry the image block');
  assert.equal(imageBlock.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(imageBlock.data, 'base64'), PNG_1X1);
  ok('PNG bytes are attached as an image block (not text)');

  // Magic bytes win over a lying extension.
  const jpegAsPng = path.join(dir, 'actually-jpeg.png');
  await fs.writeFile(jpegAsPng, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  const jpegPrepared = await tool.executeStructured({ path: 'actually-jpeg.png' }, ctx);
  const jpegImage = jpegPrepared.content.find((block) => block.type === 'image');
  assert.equal(jpegImage.mimeType, 'image/jpeg');
  ok('magic bytes decide the mime type, not the extension');

  // ── 3. Guards ──────────────────────────────────────────────────────────

  const textAsPng = path.join(dir, 'fake.png');
  await fs.writeFile(textAsPng, 'this is plain text pretending to be a png');
  const fake = await tool.executeStructured({ path: 'fake.png' }, ctx);
  assert.equal(fake.isError, true);
  assert.ok(fake.content[0].text.includes('not a supported image'));
  ok('text renamed .png is refused with a hint');

  const missing = await tool.executeStructured({ path: 'nope.png' }, ctx);
  assert.equal(missing.isError, true);
  assert.ok(missing.content[0].text.includes('does not exist'));
  ok('missing file is an error, not an empty attachment');

  const tooBig = path.join(dir, 'huge.png');
  await fs.writeFile(tooBig, PNG_1X1);
  await fs.truncate(tooBig, imageToolModule.READ_IMAGE_MAX_BYTES + 1);
  const huge = await tool.executeStructured({ path: 'huge.png' }, ctx);
  assert.equal(huge.isError, true);
  assert.ok(huge.content[0].text.includes('larger than read_image'));
  ok(`oversized images are refused (${imageToolModule.READ_IMAGE_MAX_BYTES} byte cap)`);

  // ── 4. Session → provider: the tool-result image reaches the model ─────

  const sessionMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          name: 'read_image',
          content: '[image] shot.png (image/png, 70 B)',
          structuredContent: prepared.content,
        },
      ],
      timestamp: 1,
    },
  ];
  const providerMessages = convert.convertMessagesToPi(sessionMessages, {
    api: 'openai-completions',
    provider: 'deepseek',
    id: 'deepseek-flash',
  });
  const toolResultEntry = providerMessages.find((message) => message.role === 'toolResult');
  assert.ok(toolResultEntry, 'tool result must stay a toolResult entry');
  assert.ok(toolResultEntry.content[0].text.includes('[image] shot.png'));
  const userImageEntry = providerMessages.find(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'image')
  );
  assert.ok(userImageEntry, 'tool-result image must be attached as a user image turn');
  const sentImage = userImageEntry.content.find((block) => block.type === 'image');
  assert.equal(sentImage.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(sentImage.data, 'base64'), PNG_1X1);
  ok('tool-result images are converted into the provider request');

  // An ordinary text-only tool result gains no extra message.
  const textOnly = convert.convertMessagesToPi(
    [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-2', name: 'read_file', content: 'ok' }],
        timestamp: 2,
      },
    ],
    { api: 'openai-completions', provider: 'deepseek', id: 'deepseek-flash' }
  );
  assert.equal(textOnly.length, 1);
  ok('text-only tool results are unchanged');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`[read-image] PASS (${checks} checks)`);
