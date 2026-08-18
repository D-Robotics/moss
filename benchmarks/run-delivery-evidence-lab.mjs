#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runDeliveryEvidenceLab } from '../scripts/lib/delivery-evidence-lab.mjs';

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const manifestPath = valueAfter('--manifest') ?? 'benchmarks/delivery-evidence-lab.manifest.json';
const outputPath = valueAfter('--output') ?? 'benchmarks/results/delivery-evidence-lab.json';
const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
if (manifest.commit === 'working-tree') {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--short'], { encoding: 'utf8' });
  if (revision.status !== 0 || status.status !== 0) {
    throw new Error('delivery evidence lab could not resolve the source revision');
  }
  manifest.commit = `${revision.stdout.trim()}${status.stdout.trim() ? '+dirty' : ''}`;
}
const report = await runDeliveryEvidenceLab(manifest);
const target = path.resolve(outputPath);
await fs.mkdir(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await fs.rename(temporary, target);
process.stdout.write(`Delivery evidence report: ${target}\n`);
