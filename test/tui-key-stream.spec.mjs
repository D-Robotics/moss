#!/usr/bin/env node
/** Unknown terminal sequences never become composer text (G12 / S16). */
import assert from 'node:assert/strict';
import { classifyKeyStream, isComposerLeak } from '../dist/cli/tui/input/key-stream.js';

function kinds(chunk) {
  return classifyKeyStream(chunk).events.map((event) => event.kind);
}

assert.deepEqual(kinds('hello'), ['printable']);
assert.ok(kinds('\x1b[<0;10;5M').includes('mouse'));
assert.ok(kinds('\x1b[<0;10;5m').includes('mouse'));
assert.ok(kinds('\x1b[M !!').includes('mouse'));
assert.deepEqual(kinds('\x1b[I'), ['focus']);
assert.deepEqual(kinds('\x1b[O'), ['focus']);
assert.ok(kinds('\x1bOP').includes('key'));
assert.ok(kinds('\x1b[15~').includes('key'));
{
  const fragment = classifyKeyStream('\x1b[200~');
  assert.equal(fragment.events.length, 0, 'an unfinished paste start is not composer text');
  assert.ok(fragment.carry.startsWith('\x1b[200'));
}

const split = classifyKeyStream('\x1b[<0;10');
assert.equal(split.events.length, 0);
const rest = classifyKeyStream(';5M', split.carry);
assert.equal(rest.events[0]?.kind, 'mouse');

assert.equal(isComposerLeak('\x1b[<0;10;5M'), true);
assert.equal(isComposerLeak('[<0;10;5M'), true);
assert.equal(isComposerLeak('hello'), false);
assert.equal(isComposerLeak('?'), false);
