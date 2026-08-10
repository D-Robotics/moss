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

function extractLevelTwoSection(body, title) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^#{1,2}\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join('\n');
}

function shellCommandLines(markdown) {
  const commands = [];
  const fencedShell = /^[ \t]{0,3}```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gim;
  for (const match of markdown.matchAll(fencedShell)) {
    for (const line of match[1].split(/\r?\n/)) {
      const command = line.trim();
      if (command && !command.startsWith('#')) commands.push(command);
    }
  }
  return commands;
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

  const sourceSetupSections = [
    ['CONTRIBUTING.md', 'Setup'],
    ['README.md', 'Develop'],
    ['README_CN.md', '开发'],
    ['packages/moss-agent/CONTRIBUTING.md', 'Development Setup'],
    ['packages/moss-agent/README.md', 'From Source'],
  ];
  for (const [relative, title] of sourceSetupSections) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    const body = fs.readFileSync(absolute, 'utf8');
    const commands = shellCommandLines(extractLevelTwoSection(body, title));
    if (!commands.some((command) => /^npm ci(?:\s+#.*)?$/.test(command))) {
      findings.push(`${relative}: source-development setup must use npm ci`);
    }
    if (commands.some((command) => /^npm install(?:\s|$)/.test(command))) {
      findings.push(`${relative}: source-development setup must not use bare npm install`);
    }
  }

  return findings;
}

/**
 * Validate the minimum repository-entry contract used by fresh coding agents.
 * Keep this semantic and manifest-backed: wording/layout may evolve, while the
 * executable setup and verification routes must remain discoverable.
 */
export function findAgentEntryViolations(repoRoot, rootPackage) {
  const findings = [];
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return ['AGENTS.md: missing root agent entry'];

  const body = fs.readFileSync(agentsPath, 'utf8');
  const nodeVersion = String(rootPackage.engines?.node ?? '').match(/\d+(?:\.\d+){2}/)?.[0];
  if (!nodeVersion || !body.includes(nodeVersion)) {
    findings.push('AGENTS.md: must state the Node version from package.json engines.node');
  }

  for (const command of ['npm ci', 'npm run check', 'npm run verify']) {
    const commandLines = body
      .split(/\r?\n/)
      .filter((candidate) => candidate.includes(`\`${command}\``));
    if (commandLines.length === 0) {
      findings.push(`AGENTS.md: missing required repository command: ${command}`);
      continue;
    }
    if (!commandLines.some((line) => /exit code 0/i.test(line))) {
      findings.push(`AGENTS.md: missing explicit success contract for: ${command}`);
    }
  }

  if (!body.includes('npm run test:filter')) {
    findings.push('AGENTS.md: missing focused test route: npm run test:filter');
  }
  if (!/至少匹配\s*1\s*个\s*spec[^\n]*所有匹配\s*spec[^\n]*exit code 0/iu.test(body)) {
    findings.push(
      'AGENTS.md: focused test route must require at least one match and exit code 0 for every matched spec'
    );
  }
  if (!/无匹配[^\n]*(?:报错|非零|退出)/u.test(body)) {
    findings.push('AGENTS.md: focused test route must state that an empty match fails');
  }

  const linkedRoutes = new Set(
    findMarkdownLinks(body).map((href) => href.split('#')[0].replace(/^\.\//, ''))
  );
  for (const route of [
    'README.md',
    'docs/README.md',
    'CONTRIBUTING.md',
    'packages/moss/AGENTS.md',
    'packages/moss-agent/AGENTS.md',
    'packages/moss-agent/EXTENDING.md',
    'packages/create-moss-app/AGENTS.md',
  ]) {
    if (!linkedRoutes.has(route)) {
      findings.push(`AGENTS.md: missing clickable documentation route: ${route}`);
    }
  }
  for (const section of [
    '## 文档所有权与阅读顺序',
    '## 想做 X → 去哪改',
    '## 从需求到交付',
    '## 当前事实从哪里读',
  ]) {
    if (
      !stripCodeBlocks(body)
        .split(/\r?\n/)
        .some((line) => line.trim() === section)
    )
      findings.push(`AGENTS.md: missing stable navigation section: ${section}`);
  }
  if (!/源码\/测试\/manifest 决定实现事实/u.test(body)) {
    findings.push('AGENTS.md: must explain where current implementation truth comes from');
  }

  const hostAdapterRoute = 'npm run test:filter -w @rdk-moss/core -- --filter host-adapter';
  if (!body.includes(hostAdapterRoute)) {
    findings.push(`AGENTS.md: missing executable focused route: ${hostAdapterRoute}`);
  }
  const coreTestRoot = path.join(repoRoot, 'packages/moss/test');
  const hostAdapterMatches = fs.existsSync(coreTestRoot)
    ? walk(coreTestRoot).filter(
        (absolute) =>
          absolute.endsWith('.spec.mjs') && path.basename(absolute).includes('host-adapter')
      )
    : [];
  if (hostAdapterMatches.length === 0) {
    findings.push('AGENTS.md: host-adapter focused route must match at least one core spec');
  }

  const packageAgentPath = path.join(repoRoot, 'packages/moss-agent/AGENTS.md');
  if (fs.existsSync(packageAgentPath)) {
    const packageAgent = fs.readFileSync(packageAgentPath, 'utf8');
    if (/\b\d+\+?\s+spec\b/i.test(packageAgent)) {
      findings.push('packages/moss-agent/AGENTS.md: must not hard-code a spec count');
    }
  }

  for (const [relative, requiredPaths] of [
    ['packages/moss/AGENTS.md', ['packages/moss/src/contracts', 'packages/moss/src/prompts']],
    [
      'packages/create-moss-app/AGENTS.md',
      ['packages/create-moss-app/index.mjs', 'packages/create-moss-app/test/scaffold.test.mjs'],
    ],
  ]) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    const packageAgent = fs.readFileSync(absolute, 'utf8');
    for (const requiredPath of requiredPaths) {
      const packageRelative = path
        .relative(path.dirname(relative), requiredPath)
        .replaceAll('\\', '/');
      const documentedPath = packageRelative.replace(/^\.\//, '');
      if (
        !packageAgent.includes(`\`${documentedPath}\``) &&
        !packageAgent.includes(`\`${documentedPath}/\``)
      ) {
        findings.push(`${relative}: missing current owner path: ${documentedPath}`);
      }
      if (!fs.existsSync(path.join(repoRoot, requiredPath))) {
        findings.push(`${relative}: owner path does not exist: ${requiredPath}`);
      }
    }
  }

  return findings;
}
