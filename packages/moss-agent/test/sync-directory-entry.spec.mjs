import assert from 'node:assert/strict';
import test from 'node:test';

import { syncDirectoryEntryIfSupported } from '../dist/orchestration/sync-directory-entry.js';

test('Windows skips unsupported directory fsync without weakening file fsync', () => {
  let called = false;
  syncDirectoryEntryIfSupported(
    'C:\\runtime\\graph',
    {
      openSync: () => {
        called = true;
        throw Object.assign(new Error('unsupported directory handle'), { code: 'EPERM' });
      },
      fsyncSync: () => {
        called = true;
      },
      closeSync: () => {
        called = true;
      },
    },
    'win32'
  );
  assert.equal(called, false);
});

test('POSIX directory fsync remains mandatory and closes its descriptor', () => {
  const calls = [];
  assert.throws(
    () =>
      syncDirectoryEntryIfSupported(
        '/runtime/graph',
        {
          openSync: () => {
            calls.push('open');
            return 17;
          },
          fsyncSync: () => {
            calls.push('fsync');
            throw new Error('durability failure');
          },
          closeSync: () => calls.push('close'),
        },
        'linux'
      ),
    /durability failure/
  );
  assert.deepEqual(calls, ['open', 'fsync', 'close']);
});
