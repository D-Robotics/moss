#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import { runDeliveryEvidenceLab } from '../scripts/lib/delivery-evidence-lab.mjs';

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const manifestPath = valueAfter('--manifest');
const outputPath = valueAfter('--output');
if (!manifestPath || !outputPath) {
  throw new Error('usage: run-delivery-evidence-lab --manifest <file> --output <file>');
}
const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
const report = await runDeliveryEvidenceLab(manifest);
const target = path.resolve(outputPath);
await fs.mkdir(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await fs.rename(temporary, target);
process.stdout.write(`Delivery evidence report: ${target}\n`);
