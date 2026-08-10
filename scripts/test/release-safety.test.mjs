import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertReleaseTagJournal,
  assertReleaseRecoverySource,
  assertReleaseSourceState,
  assertTrustedReleaseCoordinator,
  assertOfficialReleaseRemote,
  assertMatchingIntegrity,
  canonicalRegistryUrl,
  clearDurableFileSync,
  finalizeReleaseSet,
  prepareReleaseSetTagJournal,
  promoteReleaseSet,
  promoteReleaseSetFromJournal,
  recoverReleaseSetTags,
  RELEASE_TAG_JOURNAL_SCHEMA,
  removeReleaseSetTag,
  releaseDependencyRange,
  releaseDistTag,
  writeDurableFileAtomicSync,
} from '../lib/release-safety.mjs';

test('stable releases use latest and prereleases use next', () => {
  assert.equal(releaseDistTag('1.2.3'), 'latest');
  assert.equal(releaseDistTag('1.2.3-rc.1'), 'next');
  assert.equal(releaseDistTag('1.2.3+build-7'), 'latest');
});

test('prerelease dependencies stay on one exact release set', () => {
  assert.equal(releaseDependencyRange('1.2.3-rc.1'), '1.2.3-rc.1');
  assert.equal(releaseDependencyRange('1.2.3'), '^1.2.3');
});

test('real publishing requires a clean pushed commit on the release branch', () => {
  const state = {
    status: '',
    branch: 'main',
    expectedBranch: 'main',
    head: 'a'.repeat(40),
    remoteHead: 'a'.repeat(40),
  };
  assert.equal(assertReleaseSourceState(state), state.head);
  assert.throws(() => assertReleaseSourceState({ ...state, status: ' M package.json' }), /clean/);
  assert.throws(() => assertReleaseSourceState({ ...state, branch: 'feature' }), /branch main/);
  assert.throws(
    () => assertReleaseSourceState({ ...state, remoteHead: 'b'.repeat(40) }),
    /pushed origin/
  );
  assert.doesNotThrow(() =>
    assertOfficialReleaseRemote(
      'git@github.com:D-Robotics/moss.git',
      'https://github.com/D-Robotics/moss.git'
    )
  );
  assert.throws(
    () =>
      assertOfficialReleaseRemote(
        'https://example.test/attacker/moss.git',
        'https://github.com/D-Robotics/moss.git'
      ),
    /official Git remote/
  );
});

test('real publishing requires the fixed official GitHub Actions coordinator', () => {
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'D-Robotics/moss',
    GITHUB_WORKFLOW_REF: 'D-Robotics/moss/.github/workflows/release.yml@refs/heads/main',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    MOSS_RELEASE_COORDINATOR: 'github-actions-release-v1',
    NODE_AUTH_TOKEN: 'test-token-not-a-real-secret',
  };
  assert.equal(assertTrustedReleaseCoordinator(environment).sha, environment.GITHUB_SHA);
  for (const [field, value] of [
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_REPOSITORY', 'attacker/moss'],
    ['GITHUB_WORKFLOW_REF', 'D-Robotics/moss/.github/workflows/ci.yml@refs/heads/main'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_SHA', 'not-a-sha'],
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ATTEMPT', '0'],
    ['MOSS_RELEASE_COORDINATOR', 'local'],
    ['NODE_AUTH_TOKEN', ''],
  ]) {
    assert.throws(
      () => assertTrustedReleaseCoordinator({ ...environment, [field]: value }),
      /real publish requires/,
      `${field} must fail closed`
    );
  }
});

test('tag journals are registry-bound and package-allowlisted', () => {
  const packages = [{ name: 'core' }, { name: 'agent' }];
  const journal = {
    schema: RELEASE_TAG_JOURNAL_SCHEMA,
    transactionId: 'a1234567-1234-1234-1234-123456789abc',
    registry: 'https://registry.example.test/',
    packages: ['core', 'agent'],
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: null },
    attempted: ['core'],
    source: {
      repository: 'D-Robotics/moss',
      workflowRef: 'D-Robotics/moss/.github/workflows/release.yml@refs/heads/main',
      ref: 'refs/heads/main',
      eventName: 'workflow_dispatch',
      coordinator: 'github-actions-release-v1',
      sha: 'a'.repeat(40),
      runId: '123',
      runAttempt: '2',
    },
  };
  assert.equal(canonicalRegistryUrl(journal.registry), 'https://registry.example.test');
  assert.doesNotThrow(() =>
    assertReleaseTagJournal(journal, packages, 'https://registry.example.test')
  );
  assert.throws(
    () => assertReleaseTagJournal(journal, packages, 'https://other.example.test'),
    /different npm registry/
  );
  assert.throws(
    () =>
      assertReleaseTagJournal({ ...journal, attempted: ['unknown'] }, packages, journal.registry),
    /attempted list/
  );
});

test('recovery accepts only the explicitly verified official source run', () => {
  const source = {
    repository: 'D-Robotics/moss',
    workflowRef: 'D-Robotics/moss/.github/workflows/release.yml@refs/heads/main',
    ref: 'refs/heads/main',
    eventName: 'workflow_dispatch',
    coordinator: 'github-actions-release-v1',
    sha: 'a'.repeat(40),
    runId: '123',
    runAttempt: '2',
  };
  const environment = {
    MOSS_RECOVERY_SOURCE_SHA: source.sha,
    MOSS_RECOVERY_SOURCE_RUN_ID: source.runId,
    MOSS_RECOVERY_SOURCE_RUN_ATTEMPT: source.runAttempt,
  };
  assert.doesNotThrow(() => assertReleaseRecoverySource(source, environment));
  for (const changed of [
    { source: { ...source, repository: 'attacker/moss' }, environment },
    {
      source: {
        ...source,
        workflowRef: 'D-Robotics/moss/.github/workflows/ci.yml@refs/heads/main',
      },
      environment,
    },
    { source: { ...source, sha: 'b'.repeat(40) }, environment },
    { source: { ...source, runId: '124' }, environment },
    { source: { ...source, runAttempt: '1' }, environment },
    { source, environment: { ...environment, MOSS_RECOVERY_SOURCE_SHA: '' } },
    { source, environment: { ...environment, MOSS_RECOVERY_SOURCE_RUN_ID: 'not-a-run' } },
  ]) {
    assert.throws(
      () => assertReleaseRecoverySource(changed.source, changed.environment),
      /trusted release source/,
      'recovery source identity must fail closed'
    );
  }
});

test('an existing version is reusable only when its registry tarball is identical', () => {
  assert.doesNotThrow(() => assertMatchingIntegrity('pkg', '1.0.0', 'sha512-same', 'sha512-same'));
  assert.throws(
    () => assertMatchingIntegrity('pkg', '1.0.0', 'sha512-local', 'sha512-registry'),
    /does not match/
  );
});

test('prepared tag journal is conservative and performs no registry writes', async () => {
  const writes = [];
  const journal = await prepareReleaseSetTagJournal(
    [{ name: 'core' }, { name: 'agent' }],
    '1.0.0',
    'latest',
    {
      journalMetadata: { schema: RELEASE_TAG_JOURNAL_SCHEMA, transactionId: 'tx' },
      readTag: async (name) => (name === 'core' ? '0.9.0' : null),
      setTag: async (...args) => writes.push(args),
      removeTag: async (...args) => writes.push(args),
    }
  );
  assert.deepEqual(journal.previous, { core: '0.9.0', agent: null });
  assert.deepEqual(journal.attempted, ['core', 'agent']);
  assert.deepEqual(writes, [], 'preparing durable recovery evidence cannot mutate dist-tags');
});

test('promotion from a prepared journal preflights all tags before its first write', async () => {
  const journal = {
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: '0.9.0' },
    attempted: ['core', 'agent'],
  };
  const writes = [];
  await assert.rejects(
    () =>
      promoteReleaseSetFromJournal(journal, {
        readTag: async (name) => (name === 'agent' ? '0.9.1' : '0.9.0'),
        setTag: async (...args) => writes.push(args),
        removeTag: async (...args) => writes.push(args),
      }),
    /changed after the recovery journal was prepared/
  );
  assert.deepEqual(writes, [], 'no tag write occurs without a matching pre-uploaded journal');
});

test('a crash after the last formal tag write is recovered as committed', async () => {
  const journal = {
    packages: ['core', 'agent', 'create'],
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: '0.9.0', create: '0.9.0' },
    attempted: ['core', 'agent', 'create'],
  };
  const tags = new Map(journal.packages.map((name) => [name, journal.version]));
  const writes = [];
  const result = await recoverReleaseSetTags(journal, {
    readTag: async (name) => tags.get(name),
    setTag: async (...args) => writes.push(`set:${args.join(':')}`),
    removeTag: async (...args) => writes.push(`remove:${args.join(':')}`),
  });
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(writes, [], 'a fully promoted release is never rolled back');
  assert.deepEqual(Object.fromEntries(tags), {
    core: '1.0.0',
    agent: '1.0.0',
    create: '1.0.0',
  });
});

test('post-promotion staging cleanup failure retains the recovery journal', async () => {
  let cleared = false;
  await assert.rejects(
    () =>
      finalizeReleaseSet([{ name: 'core' }, { name: 'agent' }], 'moss-staging-1-0-0', '1.0.0', {
        readTag: async (name) => (name === 'agent' ? '1.0.0' : null),
        removeTag: async () => {
          throw new Error('staging cleanup unavailable');
        },
        clearJournal: async () => {
          cleared = true;
        },
      }),
    /staging tag .* cleanup was incomplete/
  );
  assert.equal(cleared, false, 'journal remains durable until staging cleanup succeeds');

  const formalWrites = [];
  const recovery = await recoverReleaseSetTags(
    {
      packages: ['core', 'agent'],
      version: '1.0.0',
      tag: 'latest',
      previous: { core: '0.9.0', agent: '0.9.0' },
      attempted: ['core', 'agent'],
    },
    {
      readTag: async () => '1.0.0',
      setTag: async (...args) => formalWrites.push(args),
      removeTag: async (...args) => formalWrites.push(args),
    }
  );
  assert.equal(recovery.outcome, 'committed');
  assert.deepEqual(formalWrites, [], 'cleanup recovery retains every completed formal tag');
});

test('post-promotion journal clear failure remains safely recoverable as committed', async () => {
  await assert.rejects(
    () =>
      finalizeReleaseSet([{ name: 'core' }], 'moss-staging-1-0-0', '1.0.0', {
        readTag: async () => null,
        removeTag: async () => assert.fail('absent staging tag is not removed'),
        clearJournal: async () => {
          throw new Error('journal clear failed');
        },
      }),
    /journal clear failed/
  );
  const writes = [];
  const result = await recoverReleaseSetTags(
    {
      packages: ['core'],
      version: '1.0.0',
      tag: 'latest',
      previous: { core: '0.9.0' },
      attempted: ['core'],
    },
    {
      readTag: async () => '1.0.0',
      setTag: async (...args) => writes.push(args),
      removeTag: async (...args) => writes.push(args),
    }
  );
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(writes, []);
});

test('partial dist-tag promotion restores every tag already changed', async () => {
  const tags = new Map([
    ['core', '0.9.0'],
    ['agent', '0.9.0'],
    ['create', '0.9.0'],
  ]);
  await assert.rejects(
    () =>
      promoteReleaseSet(
        [{ name: 'core' }, { name: 'agent' }, { name: 'create' }],
        '1.0.0',
        'latest',
        {
          readTag: async (name) => tags.get(name),
          setTag: async (name, version) => {
            tags.set(name, version);
            if (name === 'create' && version === '1.0.0')
              throw new Error('registry timeout after write');
          },
          removeTag: async (name) => tags.delete(name),
        }
      ),
    /registry timeout after write/
  );
  assert.deepEqual(Object.fromEntries(tags), {
    core: '0.9.0',
    agent: '0.9.0',
    create: '0.9.0',
  });
});

test('promotion rollback preserves a concurrent third tag value and its journal', async () => {
  const tags = new Map([
    ['core', '0.9.0'],
    ['agent', '0.9.0'],
  ]);
  let cleared = false;
  let promotionFailed = false;
  const rollbackWrites = [];
  await assert.rejects(
    () =>
      promoteReleaseSet([{ name: 'core' }, { name: 'agent' }], '1.0.0', 'latest', {
        readTag: async (name) => tags.get(name),
        setTag: async (name, version) => {
          if (promotionFailed) rollbackWrites.push(`set:${name}:${version}`);
          tags.set(name, version);
          if (name === 'agent') {
            tags.set('core', '1.1.0');
            promotionFailed = true;
            throw new Error('agent promotion failed');
          }
        },
        removeTag: async (name) => {
          rollbackWrites.push(`remove:${name}`);
          tags.delete(name);
        },
        clearJournal: async () => {
          cleared = true;
        },
      }),
    /rollback was incomplete.*changed during rollback/s
  );
  assert.equal(tags.get('core'), '1.1.0', 'a concurrent release is never overwritten');
  assert.equal(
    tags.get('agent'),
    '1.0.0',
    'preflight detects a later reverse-list conflict before compensating earlier members'
  );
  assert.deepEqual(
    rollbackWrites,
    [],
    'ownership preflight rejects the whole set with zero writes'
  );
  assert.equal(cleared, false, 'manual recovery evidence is retained after unsafe rollback');
});

test('durable journal replace fsyncs content before rename and then its parent', () => {
  const calls = [];
  const operations = {
    open: (file, flags, mode) => {
      calls.push(`open:${file}:${flags}:${mode ?? ''}`);
      return file.endsWith('/repo') ? 22 : 11;
    },
    write: (descriptor, contents) => calls.push(`write:${descriptor}:${contents}`),
    fsync: (descriptor) => calls.push(`fsync:${descriptor}`),
    close: (descriptor) => calls.push(`close:${descriptor}`),
    rename: (from, to) => calls.push(`rename:${from}:${to}`),
    unlink: (file) => calls.push(`unlink:${file}`),
  };
  writeDurableFileAtomicSync('/repo/journal', '{}\n', {
    operations,
    temporaryPath: '/repo/journal.tmp',
  });
  assert.deepEqual(calls, [
    'open:/repo/journal.tmp:wx:384',
    'write:11:{}\n',
    'fsync:11',
    'close:11',
    'rename:/repo/journal.tmp:/repo/journal',
    'open:/repo:r:',
    'fsync:22',
    'close:22',
  ]);
});

test('durable journal write cleans a temp file after a pre-rename fsync failure', () => {
  const calls = [];
  const operations = {
    open: () => 11,
    write: () => calls.push('write'),
    fsync: () => {
      calls.push('fsync');
      throw new Error('disk failure');
    },
    close: () => calls.push('close'),
    rename: () => calls.push('rename'),
    unlink: () => calls.push('unlink'),
  };
  assert.throws(
    () =>
      writeDurableFileAtomicSync('/repo/journal', '{}\n', {
        operations,
        temporaryPath: '/repo/journal.tmp',
      }),
    /disk failure/
  );
  assert.deepEqual(calls, ['write', 'fsync', 'close', 'unlink']);
});

test('durable journal clear unlinks before fsyncing its parent', () => {
  const calls = [];
  clearDurableFileSync('/repo/journal', {
    operations: {
      unlink: (file) => calls.push(`unlink:${file}`),
      open: (file, flags) => {
        calls.push(`open:${file}:${flags}`);
        return 22;
      },
      fsync: (descriptor) => calls.push(`fsync:${descriptor}`),
      close: (descriptor) => calls.push(`close:${descriptor}`),
    },
  });
  assert.deepEqual(calls, ['unlink:/repo/journal', 'open:/repo:r', 'fsync:22', 'close:22']);
});

test('promotion fails and rolls back when registry write success has no effect', async () => {
  const tags = new Map([
    ['core', '0.9.0'],
    ['agent', '0.9.0'],
  ]);
  let cleared = false;
  await assert.rejects(
    () =>
      promoteReleaseSet([{ name: 'core' }, { name: 'agent' }], '1.0.0', 'latest', {
        readTag: async (name) => tags.get(name),
        setTag: async () => {},
        removeTag: async (name) => tags.delete(name),
        clearJournal: async () => {
          cleared = true;
        },
      }),
    /readback mismatch/
  );
  assert.deepEqual(Object.fromEntries(tags), { core: '0.9.0', agent: '0.9.0' });
  assert.equal(cleared, true, 'a fully verified rollback may clear the recovery journal');
});

test('staging tags are removed and verified after promotion', async () => {
  const tags = new Map([
    ['core', '1.0.0'],
    ['agent', '0.9.0'],
  ]);
  await removeReleaseSetTag([{ name: 'core' }, { name: 'agent' }], 'staging', {
    readTag: async (name) => tags.get(name),
    removeTag: async (name) => tags.delete(name),
  });
  assert.equal(tags.size, 0);
});

test('interrupted tag recovery is idempotent and never overwrites a later release', async () => {
  const journal = {
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: null },
    attempted: ['core', 'agent'],
  };
  const tags = new Map([
    ['core', '0.9.0'],
    ['agent', '1.0.0'],
  ]);
  const writes = [];
  const operations = {
    readTag: async (name) => tags.get(name),
    setTag: async (name, version) => {
      writes.push(`set:${name}:${version}`);
      tags.set(name, version);
    },
    removeTag: async (name) => {
      writes.push(`remove:${name}`);
      tags.delete(name);
    },
  };
  await recoverReleaseSetTags(journal, operations);
  assert.deepEqual(writes, ['remove:agent'], 'previously restored packages are not rewritten');

  tags.set('agent', '1.1.0');
  await assert.rejects(() => recoverReleaseSetTags(journal, operations), /changed after.*1\.1\.0/);
  assert.equal(tags.get('agent'), '1.1.0', 'a later tag is preserved for manual review');
});

test('interrupted recovery preflights the full reverse plan before its first write', async () => {
  const journal = {
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: '0.9.0', create: '0.9.0' },
    attempted: ['core', 'agent', 'create'],
  };
  const tags = new Map([
    ['core', '1.1.0'],
    ['agent', '1.0.0'],
    ['create', '1.0.0'],
  ]);
  const writes = [];
  await assert.rejects(
    () =>
      recoverReleaseSetTags(journal, {
        readTag: async (name) => tags.get(name),
        setTag: async (name, version) => {
          writes.push(`set:${name}:${version}`);
          tags.set(name, version);
        },
        removeTag: async (name) => {
          writes.push(`remove:${name}`);
          tags.delete(name);
        },
      }),
    /core dist-tag latest changed after.*1\.1\.0/
  );
  assert.deepEqual(writes, [], 'a third value in the last reverse item permits zero writes');
  assert.equal(tags.get('create'), '1.0.0');
  assert.equal(tags.get('agent'), '1.0.0');
});

test('interrupted recovery re-reads ownership immediately before every write', async () => {
  const journal = {
    version: '1.0.0',
    tag: 'latest',
    previous: { core: '0.9.0', agent: '0.9.0' },
    attempted: ['core', 'agent'],
  };
  const tags = new Map([
    ['core', '1.0.0'],
    ['agent', '0.9.0'],
  ]);
  const calls = [];
  await recoverReleaseSetTags(journal, {
    readTag: async (name) => {
      calls.push(`read:${name}`);
      return tags.get(name);
    },
    setTag: async (name, version) => {
      calls.push(`set:${name}:${version}`);
      tags.set(name, version);
    },
    removeTag: async () => assert.fail('this recovery restores versions'),
  });
  assert.deepEqual(calls, ['read:core', 'read:agent', 'read:core', 'set:core:0.9.0', 'read:core']);
});
