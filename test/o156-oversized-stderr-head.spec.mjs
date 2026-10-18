#!/usr/bin/env node
/**
 * O156, QA #149 F1 (P1): the PS 5.1 CategoryInfo check built a RegExp from
 * the first stderr token with no length cap. A hook whose stderr starts with
 * a >= 32759-character token followed by ` : ` made V8 throw "Regular
 * expression too large"; runStopHooks caught it as { blocked: false }, so a
 * Stop hook that blocks on main was allowed, and the other three events
 * crashed. Detection must never throw, and if it ever does, the hook fails
 * closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { windowsMissingCommand } from '../dist/utils/windows-missing-command.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const X = 'moss-o156-missing-cmd';
const record = (name) =>
  `${name} : The term '${name}' is not recognized as the name of a cmdlet, function, script \r\n` +
  'file, or operable program. Check the spelling of the name.\r\nAt line:1 char:1\r\n' +
  `+ ${name}\r\n+ ~~~~\r\n` +
  `    + CategoryInfo          : ObjectNotFound: (${name}:String) [], CommandNotFoundException\r\n` +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n \r\n';
const deRecord = (name) =>
  `${name} : Die Benennung "${name}" wurde nicht erkannt.\r\nIn Zeile:1 Zeichen:1\r\n+ ${name}\r\n` +
  `    + CategoryInfo          : ObjectNotFound: (${name}:String) [], CommandNotFoundException\r\n` +
  '    + FullyQualifiedErrorId : CommandNotFoundException\r\n';

test('detector: an oversized first stderr token never throws and is not a missing command', () => {
  for (const ch of ['A', '.', '(', '\\', '[', '$']) {
    for (const len of [32758, 32759, 40000, 1_000_000]) {
      for (const sep of [' : ', ': ']) {
        const stderr = `${ch.repeat(len)}${sep}policy says no\r\n`;
        let got;
        assert.doesNotThrow(
          () => {
            got = windowsMissingCommand(stderr);
          },
          `${ch}*${len}${JSON.stringify(sep)}`
        );
        assert.equal(got, undefined, `${ch}*${len}`);
      }
    }
  }
});

test('detector: oversized token + CategoryInfo record does not throw; normal names still work', () => {
  const big = 'A'.repeat(40000);
  assert.doesNotThrow(() => windowsMissingCommand(deRecord(big)));
  assert.doesNotThrow(() => windowsMissingCommand(record(big)));
  // Unchanged for real-sized names, including regex metacharacters.
  assert.equal(windowsMissingCommand(deRecord(X)), X);
  assert.equal(windowsMissingCommand(record(X)), X);
  assert.equal(windowsMissingCommand(deRecord('a.b(c)+d')), 'a.b(c)+d');
  // The CategoryInfo name must still equal the record's head.
  assert.equal(windowsMissingCommand(deRecord(X).replace(`(${X}:`, '(other:')), undefined);
});

test('hook verdicts: an oversized stderr head gives the same verdict as plain stderr (Stop/UPS/PreToolUse/PermissionRequest × claude/moss × exit 1/2)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o156-big-'));
  try {
    const r = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'test', 'fixtures', 'o156-hook-verdicts.mjs'),
        path.join(ROOT, 'dist'),
        work,
      ],
      { encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 }
    );
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const { rows } = JSON.parse(r.stdout.trim().split('\n').pop());
    const events = ['Stop', 'UPS', 'PreToolUse', 'PermReq'];
    for (const row of rows) {
      for (const ev of events) {
        assert.doesNotMatch(row[ev], /^THROW/, `${ev} ${JSON.stringify(row)}`);
      }
      const control = rows.find(
        (c) => c.format === row.format && c.exit === row.exit && c.head === 'none'
      );
      for (const ev of events) {
        assert.equal(
          row[ev],
          control[ev],
          `${ev} ${JSON.stringify(row)} vs ${JSON.stringify(control)}`
        );
      }
    }
    // The verdicts main gives (claude exit 1 is the non-blocking claude verdict;
    // PreToolUse non-zero always blocks, O135).
    for (const row of rows) {
      const blocks = row.exit === 2 || row.format === 'moss';
      assert.equal(row.Stop, blocks ? 'BLOCK' : 'ALLOW', `Stop ${JSON.stringify(row)}`);
      assert.equal(row.UPS, blocks ? 'BLOCK' : 'ALLOW', `UPS ${JSON.stringify(row)}`);
      assert.equal(row.PermReq, blocks ? 'BLOCK' : 'ALLOW', `PermReq ${JSON.stringify(row)}`);
      assert.equal(row.PreToolUse, 'BLOCK', `PreToolUse ${JSON.stringify(row)}`);
    }
    assert.equal(rows.length, 16);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('hook outcome fails closed when missing-command detection throws (win32)', () => {
  const script = `
if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32' });
const { hookOutcomeFromExit } = await import(${JSON.stringify(
    new URL('../dist/cli/hooks.js', import.meta.url).href
  )});
const boom = () => { throw new SyntaxError('Regular expression too large'); };
process.stdout.write(JSON.stringify([
  hookOutcomeFromExit(1, 'x : y', boom),
  hookOutcomeFromExit(2, 'x : y', boom),
  hookOutcomeFromExit(0, 'x : y', boom),
  hookOutcomeFromExit(1, 'policy says no', () => undefined),
]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['spawn_failed', 'spawn_failed', 'exit', 'exit']);
});
