#!/usr/bin/env node
/**
 * O156, QA #149 R2-F1 (P1, looser than main): the English PowerShell pattern
 * on the branch required whitespace after the colon (`:\s+`) and an article
 * (`(?:a|the)\s+name`), where main accepted `:\s*` and `(?:a |the )?name`.
 * Stderr such as `foo:The term 'foo' …` or `… recognized as name of …` was a
 * missing command on main and an ordinary exit 1 on the branch, so claude
 * UserPromptSubmit / Stop / PermissionRequest hooks that block on main were
 * let through. The detector must accept everything main accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { windowsMissingCommand } from '../dist/utils/windows-missing-command.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// main's detector (drobotics/main 68a23b0a, src/utils/windows-missing-command.ts), verbatim.
function mainWindowsMissingCommand(stderr) {
  const text = stripVTControlCharacters(stderr);
  return (
    /^\s*'([^'\r\n]+)' is not recognized as an internal or external command\b/i.exec(text)?.[1] ??
    /^\s*(\S+):\s*The term '\1' is not recognized as (?:a |the )?name of a cmdlet, function, script file, or executable program\b/i.exec(
      text
    )?.[1]
  );
}

function* englishVariants() {
  const names = ['foo', 'a.b', 'a.b(c)+d', 'C:\\x\\y.exe', '命令', 'x'.repeat(1100)];
  const leads = ['', '  ', '\n', '\r\n\r\n', '\t'];
  const seps = [':', ': ', ':  ', ' : ', ':\t', ':\r\n', ':\n  '];
  const articles = ['a ', 'the ', '', 'A ', 'THE '];
  const programs = ['executable', 'operable'];
  const ends = ['.', '. Check the spelling of the name.\r\n', '', ' program'];
  const cases = [(s) => s, (s) => s.toUpperCase(), (s) => s.toLowerCase()];
  for (const name of names)
    for (const lead of leads)
      for (const sep of seps)
        for (const art of articles)
          for (const prog of programs)
            for (const end of ends)
              for (const kase of cases) {
                const body = kase(
                  `The term '${name}' is not recognized as ${art}name of a cmdlet, function, script file, or ${prog} program`
                );
                const plain = `${lead}${name}${sep}${body}${end}`;
                yield plain;
                // pwsh 7 ConciseView colours both halves.
                yield `\u001b[31;1m${lead}${name}${sep}\u001b[31;1m${body}${end}\u001b[0m`;
              }
  // cmd.exe, main's first pattern.
  for (const name of names.filter((n) => !n.includes('\n')))
    for (const lead of leads)
      for (const kase of cases)
        yield `${lead}'${name}' ${kase('is not recognized as an internal or external command')},\r\noperable program or batch file.\r\n`;
}

test('detector is a superset of main: every input main names, the branch names identically', () => {
  let total = 0;
  let mainNamed = 0;
  const misses = [];
  for (const stderr of englishVariants()) {
    total++;
    const expected = mainWindowsMissingCommand(stderr);
    if (expected === undefined) continue;
    mainNamed++;
    const got = windowsMissingCommand(stderr);
    if (got !== expected)
      misses.push({ stderr: JSON.stringify(stderr.slice(0, 90)), expected, got });
  }
  // Guard against a vacuous enumeration.
  assert.ok(mainNamed >= 10_000, `main named only ${mainNamed} of ${total}`);
  assert.deepEqual(
    misses.slice(0, 5),
    [],
    `${misses.length} of ${mainNamed} main-named inputs (of ${total}) differ on the branch`
  );
  assert.equal(misses.length, 0);
});

test('detector: QA R2-F1 examples are named (no space after the colon, no article)', () => {
  const tail = 'cmdlet, function, script file, or executable program.';
  for (const s of [
    `foo:The term 'foo' is not recognized as a name of a ${tail}`,
    `foo: The term 'foo' is not recognized as name of a ${tail}`,
    `foo:The term 'foo' is not recognized as name of a ${tail}`,
    `foo:The term 'foo' is not recognized as the name of a ${tail}`,
  ]) {
    assert.equal(mainWindowsMissingCommand(s), 'foo', s);
    assert.equal(windowsMissingCommand(s), 'foo', s);
  }
});

test('detector: the English pattern stays linear on long hostile input (no ReDoS)', () => {
  for (const s of [
    'a'.repeat(200_000) + ':' + ' '.repeat(200_000),
    'a:'.repeat(200_000),
    `x:${' '.repeat(200_000)}The term 'x' is not recognized as${' '.repeat(200_000)}`,
    `x: The term '${'x'.repeat(200_000)}`,
    ' '.repeat(400_000) + 'x',
  ]) {
    const t0 = process.hrtime.bigint();
    assert.equal(windowsMissingCommand(s), undefined);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, `${ms} ms for ${JSON.stringify(s.slice(0, 20))}…`);
  }
});

test('hook verdicts: claude/moss UserPromptSubmit / Stop / PermissionRequest / PreToolUse, exit 1, main-recognized texts fail closed as "failed to start" (win32)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o156-r2-'));
  try {
    const r = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'test', 'fixtures', 'o156-main-text-hooks.mjs'),
        path.join(ROOT, 'dist'),
        work,
      ],
      { encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 }
    );
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const { rows } = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(rows.length, 10);
    const failures = [];
    for (const row of rows) {
      for (const ev of ['Stop', 'StopHooks', 'UPS', 'PreToolUse', 'PermReq']) {
        if (row[ev] !== 'BLOCK') failures.push(`${row.format} ${row.variant} ${ev}=${row[ev]}`);
        else if (row.format === 'claude' && !/failed to start|未能启动/.test(row.reasons[ev]))
          failures.push(`${row.format} ${row.variant} ${ev} reason=${row.reasons[ev]}`);
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
