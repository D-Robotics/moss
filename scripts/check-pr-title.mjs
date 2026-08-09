#!/usr/bin/env node
import { validatePrTitle } from './lib/pr-title.mjs';

const title = process.env.PR_TITLE ?? process.argv.slice(2).join(' ');
const findings = validatePrTitle(title);

if (findings.length > 0) {
  console.error('[pr-title] FAIL');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`[pr-title] OK: ${title.trim()}`);
