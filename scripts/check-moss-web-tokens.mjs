import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokenDefinition = path.join(
  workspace,
  'packages/moss-agent/src/web-ui/client/design-system.css'
);
const roots = [
  path.join(workspace, 'packages/moss-agent/src/web-ui/client'),
  path.join(workspace, 'packages/moss-agent/assets/plugins'),
  path.join(workspace, 'packages/create-moss-app'),
];
const sourceExtensions = new Set(['.css', '.html', '.js', '.mjs', '.ts', '.tsx']);
const rawVisualValue =
  /(?:color|background(?:-color)?|border(?:-[a-z-]+)?|box-shadow|fill|stroke)\s*:\s*(?:#[0-9a-f]{3,8}\b|rgba?\()/gi;

async function filesBelow(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(target)));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(target);
  }
  return files;
}

const violations = [];
for (const root of roots) {
  for (const file of await filesBelow(root)) {
    if (file === tokenDefinition) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(rawVisualValue)) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${path.relative(workspace, file)}:${line}: ${match[0]}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    [
      'Moss Web visual values must come from --moss-* design tokens.',
      'Define palette values in design-system.css and consume var(--moss-...) elsewhere.',
      ...violations,
    ].join('\n')
  );
  process.exitCode = 1;
} else {
  console.log('[moss-web-tokens] built-in UI, official plugins, and templates use design tokens');
}
