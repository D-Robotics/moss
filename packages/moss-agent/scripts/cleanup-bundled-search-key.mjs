#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageDir = path.resolve(scriptDir, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageDir = path.resolve(argValue('--package-dir') || defaultPackageDir);
const keyPath = path.join(packageDir, 'bundled-search-key.json');
const markerPath = path.join(packageDir, '.bundled-search-key.generated');

if (!fs.existsSync(markerPath)) {
  process.exit(0);
}

fs.rmSync(keyPath, { force: true });
fs.rmSync(markerPath, { force: true });
console.error('[search-key] removed generated bundled-search-key.json after package packing');
