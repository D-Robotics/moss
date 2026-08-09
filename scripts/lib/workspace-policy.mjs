import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'docs-api', 'external']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else if (entry.isFile()) out.push(absolute);
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

function stripCodeBlocks(body) {
  return body
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, '')
    .replace(/^( {4}|\t).*$/gm, '');
}

function findMarkdownLinks(body) {
  const stripped = stripCodeBlocks(body);
  const links = [];
  const inlineLink = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of stripped.matchAll(inlineLink)) links.push(match[1]);
  const referenceDefinition = /^\s*\[[^\]]+]:\s+(\S+)/gm;
  for (const match of stripped.matchAll(referenceDefinition)) links.push(match[1]);
  return links;
}

function isContributorPolicy(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, '/');
  const name = path.basename(normalized);
  return (
    name === 'CONTRIBUTING.md' ||
    name === 'AGENTS.md' ||
    normalized === '.github/pull_request_template.md' ||
    normalized === 'docs/code-standards.md' ||
    normalized === 'docs/error-boundary-policy.md'
  );
}

function availableScripts(repoRoot, rootPackage) {
  const scripts = new Set(Object.keys(rootPackage.scripts ?? {}));
  for (const workspace of rootPackage.workspaces ?? []) {
    const manifestPath = path.join(repoRoot, workspace, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const script of Object.keys(manifest.scripts ?? {})) scripts.add(script);
  }
  return scripts;
}

export function findDocumentationViolations(repoRoot, rootPackage) {
  const findings = [];
  const scripts = availableScripts(repoRoot, rootPackage);
  const markdownFiles = walk(repoRoot).filter((absolute) => absolute.endsWith('.md'));

  for (const file of markdownFiles) {
    const body = fs.readFileSync(file, 'utf8');
    const relative = path.relative(repoRoot, file);
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
        findings.push(`${relative}: link escapes repository: ${href}`);
        continue;
      }
      if (!fs.existsSync(target)) {
        findings.push(`${relative}: broken markdown link: ${href}`);
        continue;
      }
      if (anchor && target.endsWith('.md')) {
        const anchors = markdownAnchors(fs.readFileSync(target, 'utf8'));
        if (!anchors.has(decodeURIComponent(anchor).toLowerCase())) {
          findings.push(`${relative}: missing markdown anchor: ${href}`);
        }
      }
    }

    if (!isContributorPolicy(relative)) continue;
    const documentedScripts = new Set(
      [...body.matchAll(/\bnpm(?:\.cmd)?\s+run\s+([A-Za-z0-9][A-Za-z0-9:_-]*)/g)].map(
        (match) => match[1]
      )
    );
    for (const script of documentedScripts) {
      if (!scripts.has(script)) {
        findings.push(`${relative}: documented npm script does not exist: ${script}`);
      }
    }
  }

  return findings;
}
