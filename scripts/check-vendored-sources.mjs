#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = 'packages/moss-agent/src/vendor/cordis/README.md';
const licensePath = 'packages/moss-agent/src/vendor/cordis/LICENSE';
const noticePath = 'packages/moss-agent/THIRD_PARTY_NOTICES.md';
const expectedRevision = '47f943859bef60e4160492346772ded9b24f765a';
const findings = [];

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    findings.push(`${relativePath}: required vendoring metadata is missing`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

const manifest = read(manifestPath);
const license = read(licensePath);
const notice = read(noticePath);
if (!manifest.includes(expectedRevision)) {
  findings.push(`${manifestPath}: pin the reviewed upstream revision ${expectedRevision}`);
}
for (const phrase of ['Local differences', 'sync', 'not a claim']) {
  if (!manifest.toLowerCase().includes(phrase.toLowerCase())) {
    findings.push(`${manifestPath}: missing required ${JSON.stringify(phrase)} disclosure`);
  }
}
if (!license.includes('Copyright (c) 2021-present Shigma') || !license.includes('MIT License')) {
  findings.push(`${licensePath}: Cordis MIT attribution is incomplete`);
}
if (!notice.includes(expectedRevision) || !notice.includes('src/vendor/cordis/LICENSE')) {
  findings.push(`${noticePath}: notice must reference the pinned revision and retained license`);
}

if (findings.length > 0) {
  console.error('[vendored-sources] FAIL');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log('[vendored-sources] OK');
}
