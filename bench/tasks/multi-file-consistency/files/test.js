import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatUserName } from './user.js';
import { profileLine } from './profile.js';
import { reportHeader } from './report.js';

const user = { first: 'Ada', last: 'Lovelace' };
assert.equal(formatUserName(user), 'Ada Lovelace');
assert.equal(profileLine(user), 'Name: Ada Lovelace');
assert.equal(reportHeader(user), '[Ada Lovelace]');

for (const f of ['user.js', 'profile.js', 'report.js']) {
  const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
  assert.ok(!src.includes('getUserDisplayName'), `${f} still references the old name`);
}
console.log('all tests passed');
