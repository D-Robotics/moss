import fs from 'node:fs';
import path from 'node:path';

function normalizedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

export function findApiInventoryViolations(repoRoot, inventory) {
  const findings = [];
  for (const packageEntry of inventory.packages) {
    const packageRoot = path.join(repoRoot, packageEntry.packageDir);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const actualKeys = normalizedKeys(manifest.exports);
    const expectedKeys = normalizedKeys(packageEntry.entrypoints);
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      findings.push(
        `${packageEntry.name}: export inventory drift (package.json: ${actualKeys.join(', ')}; inventory: ${expectedKeys.join(', ')})`
      );
      continue;
    }
    for (const exportPath of expectedKeys) {
      const actualTypes = manifest.exports[exportPath]?.types;
      const expectedTypes = packageEntry.entrypoints[exportPath].types;
      if (actualTypes !== expectedTypes) {
        findings.push(
          `${packageEntry.name} ${exportPath}: types path drift (package.json: ${actualTypes}; inventory: ${expectedTypes})`
        );
      }
    }
  }
  return findings;
}

export function apiReportResultFailed(result, update) {
  return !result.succeeded || (!update && result.apiReportChanged);
}
