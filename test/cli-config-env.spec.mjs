#!/usr/bin/env node
/**
 * `moss config env` is the authoritative MOSS_* reference. This spec keeps
 * the list and the source in lockstep by scanning src/ directly: a variable
 * read in code but missing from the reference (or listed but never read)
 * fails here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOSS_ENV_REFERENCE, renderConfigEnv } from '../dist/cli/config-commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(here, '..', 'src');

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const readInSrc = new Set();
for (const file of listTsFiles(srcRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/MOSS_[A-Z0-9_]+/g)) readInSrc.add(match[0]);
}
assert.ok(
  readInSrc.size > 80,
  `src scan found the expected MOSS_* surface (got ${readInSrc.size})`
);

const listed = new Set();
for (const { vars } of MOSS_ENV_REFERENCE) {
  for (const v of vars) listed.add(v.split(' ')[0].trim());
}

// Every variable read in src must be listed (exact match or via a listed prefix root).
for (const name of readInSrc) {
  if (name === 'MOSS_ENV_REFERENCE') continue; // the reference's own const identifier
  const bare = name.replace(/_$/, '');
  const covered = [...listed].some((l) => {
    const lb = l.replace(/_$/, '');
    return name === l || bare === lb || name.startsWith(`${lb}_`);
  });
  assert.ok(covered, `MOSS var read in src but missing from \`moss config env\`: ${name}`);
}

// Every listed entry must correspond to something moss reads (no dead rows).
for (const l of listed) {
  const lb = l.replace(/_$/, '');
  const seen =
    readInSrc.has(l) || readInSrc.has(lb) || [...readInSrc].some((r) => r.startsWith(`${lb}_`));
  assert.ok(seen, `\`moss config env\` lists a var moss never reads: ${l}`);
}

assert.ok(renderConfigEnv().includes('IGNORED'), 'the ignored model-settings group is called out');
assert.ok(renderConfigEnv().includes('MOSS_DEVICE_HOST'), 'device vars are documented');
console.log('[PASS] config env reference coverage');
