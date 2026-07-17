#!/usr/bin/env node
/**
 * @rdk-moss/core — software engineering domain prompt content unit test.
 *
 * The CLI injects the compact SE prompt as domainPrompt so coding turns get
 * evidence-first / close-the-loop guidance without the robotics block.
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { buildSoftwareEngineeringPrompt, buildSoftwareEngineeringPromptQuick } = mod;

assert.equal(typeof buildSoftwareEngineeringPrompt, 'function');
assert.equal(typeof buildSoftwareEngineeringPromptQuick, 'function');

const full = buildSoftwareEngineeringPrompt();
assert.ok(full.length > 200, 'full SE prompt should be substantive');
for (const marker of [
  'Software Engineering Capability',
  'Evidence first',
  'Read before you edit',
  'Minimal verifiable change',
  'Trust successful write tools',
]) {
  assert.ok(full.includes(marker), `full SE prompt should include "${marker}"`);
}
assert.ok(!/[一-鿿]/.test(full), 'full SE prompt prose should be English');

const quick = buildSoftwareEngineeringPromptQuick();
assert.ok(quick.length > 80, 'quick SE prompt should have content');
for (const marker of [
  'Software Engineering',
  'evidence first',
  'close the loop',
  'batch independent',
  'edit_file',
  'every explicit requirement',
  'Verification means',
  'never claim success',
]) {
  assert.ok(
    quick.toLowerCase().includes(marker.toLowerCase()) || quick.includes(marker),
    `quick SE prompt should include "${marker}"`
  );
}
assert.ok(!/[一-鿿]/.test(quick), 'quick SE prompt prose should be English');

console.log('[software-engineering-prompt.spec] PASS');
