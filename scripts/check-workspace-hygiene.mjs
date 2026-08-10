#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findAgentEntryViolations,
  findDocumentationViolations,
  findReadmeContractViolations,
} from './lib/workspace-policy.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'docs-api', 'external']);
const findings = [];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function checkCrossPlatformEsmImports(file) {
  if (!/\.(?:mjs|js)$/.test(file)) return;
  const body = fs.readFileSync(file, 'utf8');
  const rel = path.relative(repoRoot, file);
  const generatedImportPatterns = [
    /from\s+\$\{JSON\.stringify\(path\.(?:resolve|join)\(/,
    /import\(\s*path\.(?:resolve|join)\(/,
  ];
  for (const pattern of generatedImportPatterns) {
    if (!pattern.test(body)) continue;
    findings.push(
      `${rel}: convert filesystem paths with pathToFileURL(...).href before ESM import; Windows absolute paths are not module specifiers`
    );
  }
}

const rootPackage = readJson('package.json');
findings.push(...findDocumentationViolations(repoRoot, rootPackage));
findings.push(...findAgentEntryViolations(repoRoot, rootPackage));
findings.push(...findReadmeContractViolations(repoRoot, rootPackage));
const expectedNode = rootPackage.engines?.node;
if (!expectedNode) {
  findings.push('package.json: missing engines.node');
}

// A source-bearing repository must keep a tracked root AGENTS.md so every
// fresh clone gives coding agents project instructions (architecture
// constraints, dependency direction, validation routes) instead of zero
// context. Local-only instruction files (gitignored) do not count.
const trackedAgentsFile = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'AGENTS.md'], {
  cwd: repoRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (trackedAgentsFile.status !== 0) {
  findings.push(
    'AGENTS.md: missing root agent instructions file (must be tracked, not gitignored)'
  );
}

for (const workspace of rootPackage.workspaces ?? []) {
  const packagePath = `${workspace}/package.json`;
  const pkg = readJson(packagePath);
  if (pkg.engines?.node !== expectedNode) {
    findings.push(`${packagePath}: engines.node must match root (${expectedNode})`);
  }
  if (!pkg.scripts?.test) {
    findings.push(`${packagePath}: missing scripts.test`);
  }
}

const createMossApp = fs.readFileSync(
  path.join(repoRoot, 'packages/create-moss-app/index.mjs'),
  'utf8'
);
// The scaffold's offline fallback must be a PUBLISHED version range (so a
// user's `npm install` resolves even when the local workspace core version is
// an unpublished RC). It must NOT equal the local core RC — that was the bug
// (writing ^0.4.2 when 0.4.2 was unpublished). Verify the fallback is a valid
// caret range; the release script keeps it on a published version.
const createMossFallback = /'@rdk-moss\/agent': '(\^[0-9]+\.[0-9]+\.[0-9]+)'/.exec(
  createMossApp
)?.[1];
if (!createMossFallback) {
  findings.push(
    `packages/create-moss-app/index.mjs: missing or invalid FALLBACK_VERSION_RANGE '@rdk-moss/agent' entry (expected a '^x.y.z' published range)`
  );
}

for (const file of walk(repoRoot)) {
  checkCrossPlatformEsmImports(file);
}

if (findings.length > 0) {
  console.error('[workspace-hygiene] FAIL');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('[workspace-hygiene] OK');
