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

// 8. B267: docs/cli-reference.md is the authoritative command page README
//    defers to; it drifted for months (missing loop/workflow/review/remember,
//    plus a broken table row from an unescaped pipe).
{
  const ref = read('docs/cli-reference.md');
  for (const required of [
    'moss review check',
    'moss workflow',
    'moss loop',
    'moss remember',
    'moss plugins',
    'follow` 实时跟随',
    'moss runs summary',
    '--out <file\\|->',
    '--add-dir',
    '--allowed-tools',
    '`/remember`',
    '`/rules`',
    '`/status`',
    '`/usage`',
    '`/context`',
    '`/export [path]`',
    '`/rewind [seq]`',
    '`/hooks`',
    'moss_sessions_list.v1',
    'moss_skill_list.v1',
    'moss_mcp_list.v1',
    'moss_devices_list.v1',
    'moss_auth_status.v1',
    'moss_trust_list.v1',
    'moss_update.v1',
    'moss_uninstall.v1',
    'moss_doctor.v1',
    'moss_review_list.v1',
    'moss_artifacts.v1',
    'moss_capabilities.v1',
    'moss_skill_validate.v1',
    'moss_sessions_export.v1',
  ]) {
    assert.ok(ref.includes(required), `docs/cli-reference.md lost \`${required}\``);
  }
  const pipeCount = (line) => (line.replace(/\\\|/g, '').match(/\|/g) ?? []).length;
  const tableRows = ref.split('\n').filter((line) => line.startsWith('| '));
  assert.ok(tableRows.length >= 20, 'the command/flags tables are present');
  for (const row of tableRows) {
    const count = pipeCount(row);
    assert.ok(
      count === 3 || count === 4,
      `broken table row (${count} cells) in docs/cli-reference.md: ${row.slice(0, 80)}`
    );
  }
}
ok('docs/cli-reference.md lists the current commands and its tables are well formed');

// 9. B268: user-facing CLI copy must not cite internal ticket ids
//    ("see O87 if CONNECT succeeds…"). Comments may, strings may not.
{
  const dir = path.join(root, 'src/cli');
  const offenders = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const line of text.split('\n')) {
        const code = line.replace(/\/\/.*$/, '');
        if (/\bsee O\d{2,3}\b/.test(code) || /\bO\d{2,3} tracks\b/.test(code)) {
          offenders.push(`${path.relative(root, full)}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(
    offenders,
    [],
    `internal ticket ids leak into CLI copy:\n${offenders.join('\n')}`
  );
}
ok('CLI copy never cites internal ticket ids');

// 10. B269: the install page is linked from README; it should not send users to
//     an internal backlog id for a troubleshooting step.
{
  const install = read('docs/install.md');
  const leaked = install.match(/\bO\d{2,3}\b/g) ?? [];
  assert.deepEqual(leaked, [], `docs/install.md cites internal ids: ${leaked.join(', ')}`);
}
ok('the install page carries no internal ticket ids');

// 11. B270: the probe-count claim in the quality section must be true — count
//     the stage files the sentence points at instead of trusting a number.
{
  const stageCount = fs
    .readdirSync(path.join(root, 'scripts/verify/stages'))
    .filter((name) => name.endsWith('.mjs')).length;
  for (const [name, text, pattern] of [
    ['README.md', zh, /\*\*(\d+)\+ 个可复跑的探针\/阶段\*\*/],
    ['README.en.md', en, /\*\*(\d+)\+ re-runnable/],
  ]) {
    const match = pattern.exec(text);
    assert.ok(match, `${name} lost its probe-count claim`);
    const claimed = Number(match[1]);
    assert.ok(
      claimed <= stageCount,
      `${name} claims ${claimed}+ probes but only ${stageCount} stage files exist`
    );
  }
}
ok('the advertised probe count does not exceed the real stage count');

console.log(`[readme-parity] ${checks}/${checks} checks passed`);
