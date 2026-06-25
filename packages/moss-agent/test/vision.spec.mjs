#!/usr/bin/env node
/**
 * Test: Vision module — tools, registry, and prompts.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/vision.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinTools } from '../dist/tools/builtin.js';
import {
  createVisionAnalyzeTool,
  VisionRegistry,
  createDefaultVisionRegistry,
  buildVisionSystemPrompt,
} from '../dist/vision/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Tool is in builtin tools
const names = builtinTools.map((t) => t.name);
assert.ok(names.includes('vision_analyze'), 'builtin tools should include vision_analyze');

const tool = builtinTools.find((t) => t.name === 'vision_analyze');
assert.ok(tool, 'vision_analyze tool should be registered');
assert.equal(tool.metadata?.sideEffectClass, 'readonly');
assert.equal(tool.metadata?.planMode, 'allow');

const testDir = process.env.TEST_WORKSPACE_DIR || process.cwd();

// 2. Tool handles invalid input gracefully
const invalidResult = await tool.execute(
  { image: 'nonexistent.png' },
  { workspaceDir: testDir, sessionKey: 'vision-test-invalid' },
);
assert.match(invalidResult, /Error|not found/i);

// 3. Tool handles unsupported format
const txtFile = path.join(__dirname, 'vision-test.txt');
fs.writeFileSync(txtFile, 'not an image');
try {
  const txtResult = await tool.execute(
    { image: 'vision-test.txt' },
    { workspaceDir: __dirname, sessionKey: 'vision-test-txt' },
  );
  assert.match(txtResult, /unsupported|Error/i);
} finally {
  fs.unlinkSync(txtFile);
}

// 4. Tool handles data URL
const dataUrlResult = await tool.execute(
  { image: 'data:image/png;base64,iVBORw0KGgo=', question: 'What is this?' },
  { workspaceDir: testDir, sessionKey: 'vision-test-dataurl' },
);
assert.ok(dataUrlResult.includes('vision_analyze'), 'should return vision_analyze output');

// 5. Structured output via executeStructured
if (tool.executeStructured) {
  const structured = await tool.executeStructured(
    { image: 'data:image/png;base64,iVBORw0KGgo=', question: 'Test' },
    { workspaceDir: testDir, sessionKey: 'vision-test-structured' },
  );
  assert.ok(Array.isArray(structured.content), 'structured result should have content blocks');
  const hasImage = structured.content.some((b) => b.type === 'image');
  assert.ok(hasImage, 'structured result should include image block');
}

// 6. VisionRegistry
const registry = createDefaultVisionRegistry();
assert.equal(registry.supportsVision('gpt-4o'), true);
assert.equal(registry.supportsVision('unknown-model'), false);

const caps = registry.getCapabilities('gpt-4o');
assert.ok(caps, 'should have capabilities for gpt-4o');
assert.equal(caps.provider, 'openai');
assert.ok(caps.supportedMimeTypes.includes('image/png'));

// 7. Custom registry
const customRegistry = new VisionRegistry();
customRegistry.registerDefault('my-model', {
  provider: 'custom',
  maxImageBytes: 1024,
  supportedMimeTypes: ['image/png'],
  maxResolution: 512,
  supportsMultipleImages: false,
});
assert.equal(customRegistry.supportsVision('my-model'), true);
assert.equal(customRegistry.getMaxImageBytes('my-model'), 1024);

// 8. Vision system prompt
const promptEnabled = buildVisionSystemPrompt({ visionEnabled: true, screenshotGuidance: true });
assert.ok(promptEnabled.includes('vision_analyze'), 'prompt should mention vision_analyze');
assert.ok(promptEnabled.includes('screenshot'), 'prompt should include screenshot guidance');

const promptDisabled = buildVisionSystemPrompt({ visionEnabled: false });
assert.equal(promptDisabled, '', 'prompt should be empty when vision is disabled');

// 9. createVisionAnalyzeTool with options
const customTool = createVisionAnalyzeTool({ maxImageBytes: 1000, defaultDetail: 'low' });
assert.equal(customTool.name, 'vision_analyze');

console.log('[PASS] Vision module: tools, registry, and prompts work correctly');
