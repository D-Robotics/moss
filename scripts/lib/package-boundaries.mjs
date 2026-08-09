import fs from 'node:fs';
import path from 'node:path';

const WORKSPACES = [
  {
    rel: 'packages/moss',
    name: '@rdk-moss/core',
    allowed: new Set(),
  },
  {
    rel: 'packages/moss-agent',
    name: '@rdk-moss/agent',
    allowed: new Set(['@rdk-moss/core']),
  },
  {
    rel: 'packages/create-moss-app',
    name: 'create-moss-app',
    allowed: new Set(['@rdk-moss/core', '@rdk-moss/agent']),
  },
];

const WORKSPACE_NAMES = new Set(WORKSPACES.map((workspace) => workspace.name));
const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](@rdk-moss\/(?:core|agent)|create-moss-app)(?:\/[^'"]*)?['"]/g;
const DIRECTION = 'create-moss-app -> @rdk-moss/agent -> @rdk-moss/core';

function walkSource(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSource(absolute, out);
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) out.push(absolute);
  }
  return out;
}

export function findPackageBoundaryViolations(repoRoot) {
  const findings = [];

  for (const workspace of WORKSPACES) {
    const packageJsonPath = path.join(repoRoot, workspace.rel, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    if (workspace.name === '@rdk-moss/core') {
      const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
      const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {});
      const allRuntimeDependencies = [...runtimeDependencies, ...optionalDependencies];
      if (allRuntimeDependencies.length > 0) {
        findings.push(
          `${workspace.rel}/package.json: @rdk-moss/core must have zero runtime dependencies (found: ${allRuntimeDependencies.join(', ')})`
        );
      }
    }

    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        if (!WORKSPACE_NAMES.has(dependency) || dependency === workspace.name) continue;
        if (!workspace.allowed.has(dependency)) {
          findings.push(
            `${workspace.rel}/package.json: reverse workspace dependency ${dependency} in ${section} (allowed direction: ${DIRECTION})`
          );
        }
      }
    }

    const sourceRoot = path.join(repoRoot, workspace.rel, 'src');
    for (const file of walkSource(sourceRoot)) {
      const body = fs.readFileSync(file, 'utf8');
      for (const match of body.matchAll(IMPORT_PATTERN)) {
        const importedWorkspace = match[1];
        if (importedWorkspace === workspace.name || workspace.allowed.has(importedWorkspace)) {
          continue;
        }
        const relFile = path.relative(repoRoot, file).replaceAll(path.sep, '/');
        findings.push(
          `${relFile}: reverse workspace import ${importedWorkspace} (allowed direction: ${DIRECTION})`
        );
      }
    }
  }

  return findings;
}
