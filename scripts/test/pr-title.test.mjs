import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validatePrTitle } from '../lib/pr-title.mjs';

test('approved Conventional Commit PR titles pass', () => {
  assert.deepEqual(validatePrTitle('fix(agent): preserve provider error cause'), []);
  assert.deepEqual(validatePrTitle('feat(core)!: remove legacy host contract'), []);
  assert.deepEqual(validatePrTitle('docs: explain clean checkout verification'), []);
});

test('malformed titles and unapproved scopes fail', () => {
  assert.ok(validatePrTitle('Fix the thing').length > 0);
  assert.ok(
    validatePrTitle('feat(server): add host dependency').some((item) => /scope/.test(item))
  );
  assert.ok(validatePrTitle('unknown(agent): change behavior').some((item) => /type/.test(item)));
});
