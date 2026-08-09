#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findMaintainabilityViolations } from './lib/maintainability.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselinePath = path.join(repoRoot, 'scripts/config/maintainability-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const findings = findMaintainabilityViolations(repoRoot, baseline);

if (findings.length > 0) {
  console.error('[maintainability] FAIL');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('[maintainability] OK');
