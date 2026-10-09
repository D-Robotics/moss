#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DECISIONS = new Set(['accept', 'reject', 'hold', 'merged', 'rolled_back', null]);
const REQUIRED = [
  'round',
  'branch',
  'baseSha',
  'headSha',
  'parent',
  'hypothesis',
  'prediction',
  'predictionHeld',
  'changedPaths',
  'dev',
  'holdout',
  'cost',
  'decision',
];
const SENSITIVE =
  /^(?:api[-_]?key|authorization|password|passphrase|secret|access[-_]?token|refresh[-_]?token|private[-_]?key)$/i;

function parseArgs(argv) {
  const out = { repo: process.cwd(), validate: false, append: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--validate') out.validate = true;
    else if (arg === '--append') out.append = next();
    else if (arg === '--ledger') out.ledger = next();
    else if (arg === '--repo') out.repo = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  out.repo = path.resolve(out.repo);
  out.ledger = path.resolve(out.repo, out.ledger ?? path.join('.rsi', 'ledger.jsonl'));
  if (out.append) out.append = path.resolve(out.repo, out.append);
  if (!out.append) out.validate = true;
  return out;
}

function sensitiveDataPaths(value) {
  const hits = [];
  const visit = (item, at) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      const next = at ? `${at}.${key}` : key;
      if (SENSITIVE.test(key) && child != null && child !== '') hits.push(next);
      visit(child, next);
    }
  };
  visit(value, '');
  return [...new Set(hits)].sort();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateEntry(entry, index) {
  const where = index === undefined ? 'entry' : `line ${index + 1}`;
  if (!isObject(entry)) throw new Error(`${where}: not an object`);
  const sensitive = sensitiveDataPaths(entry);
  if (sensitive.length > 0) {
    throw new Error(`${where}: sensitive data is not allowed (${sensitive.join(', ')})`);
  }
  for (const key of REQUIRED) {
    if (!Object.hasOwn(entry, key)) throw new Error(`${where}: missing ${key}`);
  }
  if (!DECISIONS.has(entry.decision)) throw new Error(`${where}: decision is not allowed`);
  if (entry.changedPaths !== null && !Array.isArray(entry.changedPaths)) {
    throw new Error(`${where}: changedPaths must be an array or null`);
  }
  if (entry.parent !== null && typeof entry.parent !== 'string') {
    throw new Error(`${where}: parent must be a sha or null`);
  }
  if (entry.prediction !== null) {
    const { tasks, why } = entry.prediction ?? {};
    if (
      !Array.isArray(tasks) ||
      tasks.length === 0 ||
      tasks.some((task) => typeof task !== 'string') ||
      typeof why !== 'string' ||
      !why.trim()
    ) {
      throw new Error(`${where}: prediction must be null or { tasks, why }`);
    }
  }
  if (entry.predictionHeld !== null && typeof entry.predictionHeld !== 'boolean') {
    throw new Error(`${where}: predictionHeld must be true, false, or null`);
  }
  for (const key of ['dev', 'holdout', 'cost']) {
    if (entry[key] !== null && !isObject(entry[key]))
      throw new Error(`${where}: ${key} must be an object or null`);
  }
}

export function loadLedger(file) {
  if (!fs.existsSync(file)) throw new Error(`missing ledger ${file}`);
  const entries = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`line ${index + 1}: ${message}`, { cause: error });
    }
    validateEntry(entry, index);
    entries.push(entry);
  }
  const seen = new Set();
  for (const entry of entries) {
    const key = String(entry.round);
    if (seen.has(key)) throw new Error(`duplicate round ${key}`);
    seen.add(key);
  }
  return entries;
}

export function appendEntry(file, entry) {
  validateEntry(entry);
  const existing = fs.existsSync(file) ? loadLedger(file) : [];
  if (existing.some((row) => String(row.round) === String(entry.round))) {
    throw new Error(`duplicate round ${entry.round}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return loadLedger(file);
}

function refuseIfStopped(repo) {
  if (process.env.MOSS_RSI_DISABLED === '1') {
    console.error('RSI refused: MOSS_RSI_DISABLED=1');
    process.exit(2);
  }
  if (fs.existsSync(path.join(repo, '.rsi', 'STOP'))) {
    console.error('RSI refused: .rsi/STOP exists');
    process.exit(2);
  }
}

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      refuseIfStopped(args.repo);
      console.log('Usage: npm run rsi:ledger -- [--validate] [--append <file>]');
      process.exit(0);
    }
    refuseIfStopped(args.repo);
    if (args.append) {
      const entry = JSON.parse(fs.readFileSync(args.append, 'utf8'));
      const entries = appendEntry(args.ledger, entry);
      console.log(`[rsi:ledger] appended round ${entry.round}; ${entries.length} line(s)`);
    } else {
      const entries = loadLedger(args.ledger);
      console.log(`[rsi:ledger] ok ${entries.length} line(s) ${args.ledger}`);
    }
  } catch (error) {
    console.error(`[rsi:ledger] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
