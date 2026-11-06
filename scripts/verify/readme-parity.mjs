#!/usr/bin/env node
/**
 * README parity probe (offline).
 *
 * The two READMEs drifted: different section sets, stale tool counts, references
 * to files that no longer exist, and internal issue ids in a public page. This
 * locks the product page: same section order in Chinese and English, every docs
 * link resolves, the advertised tool/device counts match the build, and no
 * internal ticket ids leak into it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const zh = read('README.md');
const en = read('README.en.md');
const { builtinTools } = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[readme-parity] ok ${name}`);
};

const headings = (text) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());

// 1. Same sections, same order, Chinese and English 1:1.
const zhHeadings = headings(zh);
const enHeadings = headings(en);
assert.ok(zhHeadings.length >= 10, `zh has only ${zhHeadings.length} sections`);
assert.equal(
  enHeadings.length,
  zhHeadings.length,
  `zh ${zhHeadings.length} vs en ${enHeadings.length} sections`
);
ok(`both READMEs carry the same ${zhHeadings.length} sections`);

// 2. Both are product pages, not install manuals: bounded length.
for (const [name, text] of [
  ['README.md', zh],
  ['README.en.md', en],
]) {
  const lines = text.split('\n').length;
  assert.ok(lines >= 120, `${name} is only ${lines} lines`);
  assert.ok(lines <= 260, `${name} grew to ${lines} lines — move details to docs/`);
}
ok('both stay within the product-page budget (120–260 lines)');

// 3. Every relative link resolves.
for (const [name, text] of [
  ['README.md', zh],
  ['README.en.md', en],
]) {
  const targets = [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);
  for (const target of targets) {
    if (/^https?:/.test(target) || target.startsWith('#') || target.startsWith('mailto:')) continue;
    assert.ok(fs.existsSync(path.join(root, target)), `${name} links to missing ${target}`);
  }
}
ok('every relative link in both READMEs resolves');

// 4. The advertised capability counts match the built tool surface.
const deviceCount = builtinTools.filter((tool) => tool.name.startsWith('device_')).length;
for (const [name, text] of [
  ['README.md', zh],
  ['README.en.md', en],
]) {
  assert.match(
    text,
    new RegExp(`\\b${builtinTools.length} (?:built-in\\s+)?(?:内置)?\\s*(?:tools|个内置工具)`),
    name
  );
  assert.match(text, new RegExp(`${deviceCount} (?:device tools|个设备工具)`), name);
}
ok(`tool counts match the build (${builtinTools.length} tools, ${deviceCount} device tools)`);

// 5. The hero commands and the verification story are present in both.
for (const required of [
  'moss goal',
  '--accept',
  'moss device',
  'moss task status',
  'moss loop',
  'moss runs follow',
  '/style',
]) {
  assert.ok(zh.includes(required), `zh README lost \`${required}\``);
  assert.ok(en.includes(required), `en README lost \`${required}\``);
}
ok('both READMEs keep the hero commands and the verified-run story');

// 6. No internal ticket ids in a public page.
for (const [name, text] of [
  ['README.md', zh],
  ['README.en.md', en],
]) {
  const match = /\bO\d{2,3}\b/.exec(text);
  assert.equal(match, null, `${name} leaks internal ticket ${match?.[0]}`);
}
ok('no internal issue ids leak into the product page');

// 7. Language switch works both ways.
assert.ok(zh.includes('README.en.md'), 'zh README does not link English');
assert.ok(en.includes('README.md'), 'en README does not link Chinese');
ok('the language switch links both ways');

console.log(`[readme-parity] ${checks}/${checks} checks passed`);
