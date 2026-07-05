#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'external']);
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

function slugifyHeading(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~[\]]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function markdownAnchors(body) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of body.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slugifyHeading(match[2]);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

function findMarkdownLinks(body) {
  const links = [];
  const inlineLink = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of body.matchAll(inlineLink)) {
    links.push(match[1]);
  }
  const refDef = /^\s*\[[^\]]+]:\s+(\S+)/gm;
  for (const match of body.matchAll(refDef)) {
    links.push(match[1]);
  }
  return links;
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
    findings.push(`${rel}: convert filesystem paths with pathToFileURL(...).href before ESM import; Windows absolute paths are not module specifiers`);
  }
}

const rootPackage = readJson('package.json');
const expectedNode = rootPackage.engines?.node;
if (!expectedNode) {
  findings.push('package.json: missing engines.node');
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
  'utf8',
);
// The scaffold's offline fallback must be a PUBLISHED version range (so a
// user's `npm install` resolves even when the local workspace core version is
// an unpublished RC). It must NOT equal the local core RC — that was the bug
// (writing ^0.4.2 when 0.4.2 was unpublished). Verify the fallback is a valid
// caret range; the release script keeps it on a published version.
const createMossFallback = /'@rdk-moss\/core': '(\^[0-9]+\.[0-9]+\.[0-9]+)'/.exec(createMossApp)?.[1];
if (!createMossFallback) {
  findings.push(
    `packages/create-moss-app/index.mjs: missing or invalid FALLBACK_VERSION_RANGE '@rdk-moss/core' entry (expected a '^x.y.z' published range)`,
  );
}

for (const file of walk(repoRoot).filter((abs) => abs.endsWith('.md'))) {
  const body = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  for (const rawHref of findMarkdownLinks(body)) {
    const href = rawHref.replace(/^<|>$/g, '');
    if (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('mailto:') ||
      href.startsWith('#')
    ) {
      continue;
    }

    const [targetPath, anchor] = href.split('#');
    const target = path.resolve(dir, decodeURIComponent(targetPath || path.basename(file)));
    if (!target.startsWith(repoRoot + path.sep) && target !== repoRoot) {
      findings.push(`${path.relative(repoRoot, file)}: link escapes repository: ${href}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      findings.push(`${path.relative(repoRoot, file)}: broken markdown link: ${href}`);
      continue;
    }
    if (anchor && target.endsWith('.md')) {
      const anchors = markdownAnchors(fs.readFileSync(target, 'utf8'));
      if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
        findings.push(`${path.relative(repoRoot, file)}: missing markdown anchor: ${href}`);
      }
    }
  }
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
