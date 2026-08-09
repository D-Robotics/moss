#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { apiReportResultFailed, findApiInventoryViolations } from './lib/api-governance.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const inventoryPath = path.join(repoRoot, 'scripts/config/api-entrypoints.json');
const baseConfigPath = path.join(repoRoot, 'scripts/config/api-extractor.base.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const update = process.argv.includes('--update');
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--update');

if (unknownArgs.length > 0) {
  console.error(`[api] unknown argument(s): ${unknownArgs.join(', ')}`);
  process.exit(1);
}

const inventoryFindings = findApiInventoryViolations(repoRoot, inventory);

if (inventoryFindings.length > 0) {
  console.error('[api] FAIL: entry-point inventory drift');
  for (const finding of inventoryFindings) console.error(`- ${finding}`);
  process.exit(1);
}

let failed = false;
for (const packageEntry of inventory.packages) {
  const packageRoot = path.join(repoRoot, packageEntry.packageDir);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));

  for (const [exportPath, entrypoint] of Object.entries(packageEntry.entrypoints)) {
    const entrypointPath = path.join(packageRoot, entrypoint.types.replace(/^\.\//, ''));
    if (!fs.existsSync(entrypointPath)) {
      console.error(
        `[api] ${packageEntry.name} ${exportPath}: missing declaration ${path.relative(repoRoot, entrypointPath)}; run the build first`
      );
      failed = true;
      continue;
    }

    const configObject = structuredClone(baseConfig);
    configObject.projectFolder = packageRoot;
    configObject.mainEntryPointFilePath = entrypointPath;
    configObject.compiler.tsconfigFilePath = path.join(packageRoot, 'tsconfig.build.json');
    configObject.apiReport.reportFileName = entrypoint.report;
    configObject.apiReport.reportFolder = path.join(packageRoot, 'etc');
    configObject.apiReport.reportTempFolder = path.join(
      repoRoot,
      '.tmp/api-extractor',
      packageEntry.name.replaceAll('/', '__'),
      entrypoint.report
    );
    fs.mkdirSync(configObject.apiReport.reportFolder, { recursive: true });
    fs.mkdirSync(configObject.apiReport.reportTempFolder, { recursive: true });

    const extractorConfig = ExtractorConfig.prepare({
      configObject,
      configObjectFullPath: baseConfigPath,
      packageJsonFullPath: packageJsonPath,
      projectFolderLookupToken: packageRoot,
    });
    const result = Extractor.invoke(extractorConfig, {
      localBuild: update,
      printApiReportDiff: !update,
      showVerboseMessages: false,
    });
    const reportFailed = apiReportResultFailed(result, update);
    const status = reportFailed ? 'FAIL' : 'OK';
    console.log(
      `[api] ${status} ${packageEntry.name} ${exportPath} -> ${entrypoint.report}.api.md`
    );
    if (reportFailed) failed = true;
  }
}

if (failed) process.exit(1);
console.log(
  `[api] ${update ? 'reports updated' : 'reports verified'}; entry-point inventory verified`
);
