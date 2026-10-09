#!/usr/bin/env node
/**
 * Append or validate `.rsi/ledger.jsonl`.
 * One JSON object per line. Historical rows may use null where a score was never recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sensitiveDataPaths } from './lib/secrets.mjs';

const GATE_KEYS = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
const DECISIONS = new Set([
  'accept',
  'neutral',
  'reject',
  'pending-holdout',
  'merged',
  'rolled_back',
  null,
]);
const TIERS = new Set(['A', 'B', null]);
const REQUIRED = [
  'round',
  'branch',
  'baseSha',
  'headSha',
  'backlogItem',
  'hypothesis',
  'changedPaths',
  'tier',
  'gates',
  'dev',
  'holdout',
  'cost',
  'reviewer',
  'decision',
];

function usage() {
  return [
    'Usage: npm run rsi:ledger -- [--validate] [--append <file>] [--ledger <path>] [--repo <path>]',
    '',
    'Default action is --validate of .rsi/ledger.jsonl.',
    'Append refuses a duplicate round. Null fields are allowed when the value was not recorded.',
  ].join('\n');
}

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

function hasKeys(object, keys, where) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error(`${where} must be an object`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) throw new Error(`${where}.${key} is missing`);
  }
}

export function validateEntry(entry, index) {
  const where = index === undefined ? 'entry' : `line ${index + 1}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where}: not an object`);
  }
  const sensitive = sensitiveDataPaths(entry);
  if (sensitive.length > 0) {
    throw new Error(`${where}: sensitive data is not allowed (${sensitive.join(', ')})`);
  }
  for (const key of REQUIRED) {
    if (!Object.hasOwn(entry, key)) throw new Error(`${where}: missing ${key}`);
  }
  if (!TIERS.has(entry.tier)) throw new Error(`${where}: tier must be "A", "B", or null`);
  if (!DECISIONS.has(entry.decision)) throw new Error(`${where}: decision is not allowed`);
  if (entry.changedPaths !== null && !Array.isArray(entry.changedPaths)) {
    throw new Error(`${where}: changedPaths must be an array or null`);
  }
  if (entry.gates === null || typeof entry.gates !== 'object' || Array.isArray(entry.gates)) {
    throw new Error(`${where}: gates must be an object`);
  }
  for (const gate of GATE_KEYS) {
    if (!Object.hasOwn(entry.gates, gate)) throw new Error(`${where}: gates.${gate} is missing`);
  }
  hasKeys(entry.dev, ['hardScore', 'weighted'], `${where}: dev`);
  hasKeys(entry.holdout, ['score', 'band'], `${where}: holdout`);
  hasKeys(entry.cost, ['tokens', 'usd', 'wallMin'], `${where}: cost`);
  hasKeys(entry.reviewer, ['model', 'verdict'], `${where}: reviewer`);
  if (
    entry.rollback !== undefined &&
    entry.rollback !== null &&
    typeof entry.rollback !== 'object'
  ) {
    throw new Error(`${where}: rollback must be an object or null`);
  }
}

export function loadLedger(file) {
  if (!fs.existsSync(file)) throw new Error(`missing ledger ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  const lines = text.split('\n');
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
      console.log(usage());
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
