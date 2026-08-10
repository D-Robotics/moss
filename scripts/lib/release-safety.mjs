import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const durableFileOperations = {
  open: (file, flags, mode) => fs.openSync(file, flags, mode),
  write: (fileDescriptor, contents) => fs.writeFileSync(fileDescriptor, contents, 'utf8'),
  fsync: (fileDescriptor) => fs.fsyncSync(fileDescriptor),
  close: (fileDescriptor) => fs.closeSync(fileDescriptor),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (file) => fs.unlinkSync(file),
};

function fsyncParentDirectory(file, operations) {
  const directoryDescriptor = operations.open(path.dirname(file), 'r');
  try {
    operations.fsync(directoryDescriptor);
  } finally {
    operations.close(directoryDescriptor);
  }
}

/** Replace a file atomically and durably, including the parent directory entry. */
export function writeDurableFileAtomicSync(file, contents, options = {}) {
  const operations = options.operations ?? durableFileOperations;
  const temporary = options.temporaryPath ?? `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fileDescriptor;
  let renamed = false;
  try {
    fileDescriptor = operations.open(temporary, 'wx', options.mode ?? 0o600);
    operations.write(fileDescriptor, contents);
    operations.fsync(fileDescriptor);
    operations.close(fileDescriptor);
    fileDescriptor = undefined;
    operations.rename(temporary, file);
    renamed = true;
    fsyncParentDirectory(file, operations);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        operations.close(fileDescriptor);
      } catch {
        // Preserve the first durability failure.
      }
    }
    if (!renamed) {
      try {
        operations.unlink(temporary);
      } catch {
        // The temp file may not have been created; preserve the first failure.
      }
    }
    throw error;
  }
}

/** Remove a file durably so a crash cannot resurrect its directory entry. */
export function clearDurableFileSync(file, options = {}) {
  const operations = options.operations ?? durableFileOperations;
  try {
    operations.unlink(file);
  } catch (error) {
    if (options.ignoreMissing && error?.code === 'ENOENT') return false;
    throw error;
  }
  fsyncParentDirectory(file, operations);
  return true;
}

export function releaseDistTag(version) {
  return String(version).split('+')[0].includes('-') ? 'next' : 'latest';
}

export function releaseDependencyRange(version) {
  return String(version).split('+')[0].includes('-') ? String(version) : `^${version}`;
}

export function assertReleaseSourceState({ status, branch, expectedBranch, head, remoteHead }) {
  if (String(status || '').trim()) {
    throw new Error('real publish requires a clean Git worktree and index');
  }
  if (branch !== expectedBranch) {
    throw new Error(`real publish requires branch ${expectedBranch}; current branch is ${branch}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(head) || head !== remoteHead) {
    throw new Error(
      `real publish requires HEAD to equal the pushed origin/${expectedBranch}: head=${head} remote=${remoteHead}`
    );
  }
  return head;
}

export function canonicalGitRemoteUrl(value) {
  const raw = String(value || '').trim();
  const scp = raw.match(/^git@([^:]+):(.+)$/u);
  const normalized = scp
    ? `https://${scp[1]}/${scp[2]}`
    : raw.replace(/^ssh:\/\/git@/u, 'https://');
  return normalized
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '')
    .toLowerCase();
}

export function assertOfficialReleaseRemote(actual, expected) {
  if (canonicalGitRemoteUrl(actual) !== canonicalGitRemoteUrl(expected)) {
    throw new Error(`real publish requires the official Git remote: ${expected}`);
  }
}

const trustedReleaseIdentity = {
  repository: 'D-Robotics/moss',
  workflowRef: 'D-Robotics/moss/.github/workflows/release.yml@refs/heads/main',
  ref: 'refs/heads/main',
  eventName: 'workflow_dispatch',
  coordinator: 'github-actions-release-v1',
};

function assertTrustedReleaseSourceShape(source) {
  const expectedKeys = [
    ...Object.keys(trustedReleaseIdentity),
    'sha',
    'runId',
    'runAttempt',
  ].sort();
  if (
    !source ||
    Array.isArray(source) ||
    JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error('trusted release source has an unsupported shape');
  }
  for (const [key, expected] of Object.entries(trustedReleaseIdentity)) {
    if (source[key] !== expected) {
      throw new Error(`trusted release source requires ${key}: ${expected}`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(source.sha || '')) {
    throw new Error('trusted release source requires a valid source SHA');
  }
  if (!/^[1-9][0-9]*$/u.test(source.runId || '')) {
    throw new Error('trusted release source requires a valid run id');
  }
  if (!/^[1-9][0-9]*$/u.test(source.runAttempt || '')) {
    throw new Error('trusted release source requires a valid run attempt');
  }
  return source;
}

export function assertTrustedReleaseCoordinator(environment) {
  const expected = trustedReleaseIdentity;
  const actual = {
    repository: environment.GITHUB_REPOSITORY,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    ref: environment.GITHUB_REF,
    eventName: environment.GITHUB_EVENT_NAME,
    coordinator: environment.MOSS_RELEASE_COORDINATOR,
  };
  if (environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('real publish requires GitHub Actions');
  }
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(`real publish requires trusted ${key}: ${expected[key]}`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA || '')) {
    throw new Error('real publish requires a valid GitHub Actions source SHA');
  }
  if (!/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID || '')) {
    throw new Error('real publish requires a valid GitHub Actions run id');
  }
  if (!/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('real publish requires a valid GitHub Actions run attempt');
  }
  if (!String(environment.NODE_AUTH_TOKEN || '').trim()) {
    throw new Error('real publish requires the workflow-scoped NPM_TOKEN secret');
  }
  return {
    ...actual,
    sha: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  };
}

export function assertReleaseRecoverySource(source, environment) {
  assertTrustedReleaseSourceShape(source);
  const expected = {
    sha: environment.MOSS_RECOVERY_SOURCE_SHA,
    runId: environment.MOSS_RECOVERY_SOURCE_RUN_ID,
    runAttempt: environment.MOSS_RECOVERY_SOURCE_RUN_ATTEMPT,
  };
  if (!/^[0-9a-f]{40}$/u.test(expected.sha || '')) {
    throw new Error('trusted release source requires a verified recovery SHA');
  }
  if (!/^[1-9][0-9]*$/u.test(expected.runId || '')) {
    throw new Error('trusted release source requires a verified recovery run id');
  }
  if (!/^[1-9][0-9]*$/u.test(expected.runAttempt || '')) {
    throw new Error('trusted release source requires a verified recovery run attempt');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (source[key] !== value) {
      throw new Error(`trusted release source ${key} does not match the verified artifact run`);
    }
  }
  return source;
}

export function assertMatchingIntegrity(name, version, localIntegrity, registryIntegrity) {
  if (!localIntegrity || !registryIntegrity || localIntegrity !== registryIntegrity) {
    throw new Error(
      `${name}@${version} registry integrity does not match the locally verified tarball: ` +
        `local=${localIntegrity || 'missing'} registry=${registryIntegrity || 'missing'}`
    );
  }
}

export const RELEASE_TAG_JOURNAL_SCHEMA = 'rdk-moss.release-tag-journal.v2';

export function canonicalRegistryUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('npm registry must be an http(s) URL without embedded credentials');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/u, '');
}

export function assertReleaseTagJournal(journal, packages, expectedRegistry) {
  const allowedNames = packages.map((pkg) => pkg.name);
  const keys = Object.keys(journal ?? {}).sort();
  const expectedKeys = [
    'attempted',
    'packages',
    'previous',
    'registry',
    'schema',
    'source',
    'tag',
    'transactionId',
    'version',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error('release tag journal has an unsupported shape');
  }
  if (journal.schema !== RELEASE_TAG_JOURNAL_SCHEMA) {
    throw new Error('release tag journal has an unsupported schema');
  }
  assertTrustedReleaseSourceShape(journal.source);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(journal.transactionId)) {
    throw new Error('release tag journal has an invalid transaction id');
  }
  if (canonicalRegistryUrl(journal.registry) !== canonicalRegistryUrl(expectedRegistry)) {
    throw new Error('release tag journal belongs to a different npm registry');
  }
  if (JSON.stringify(journal.packages) !== JSON.stringify(allowedNames)) {
    throw new Error('release tag journal package allowlist does not match this release set');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(journal.version)) {
    throw new Error('release tag journal has an invalid version');
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(journal.tag)) {
    throw new Error('release tag journal has an invalid dist-tag');
  }
  if (
    !journal.previous ||
    Array.isArray(journal.previous) ||
    JSON.stringify(Object.keys(journal.previous)) !== JSON.stringify(allowedNames)
  ) {
    throw new Error('release tag journal previous tags do not match the package allowlist');
  }
  for (const value of Object.values(journal.previous)) {
    if (value !== null && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
      throw new Error('release tag journal contains an invalid previous version');
    }
  }
  if (
    !Array.isArray(journal.attempted) ||
    new Set(journal.attempted).size !== journal.attempted.length ||
    journal.attempted.some((name) => !allowedNames.includes(name))
  ) {
    throw new Error('release tag journal attempted list is invalid');
  }
  return journal;
}

async function assertTagValue(operations, name, tag, expected) {
  const actual = await operations.readTag(name, tag);
  if ((actual ?? null) !== (expected ?? null)) {
    throw new Error(
      `${name} dist-tag ${tag} readback mismatch: expected=${expected ?? 'absent'} actual=${actual ?? 'absent'}`
    );
  }
}

/** Capture a conservative rollback plan before any registry mutation. */
export async function prepareReleaseSetTagJournal(packages, version, tag, operations) {
  const previous = {};
  for (const pkg of packages) previous[pkg.name] = await operations.readTag(pkg.name, tag);
  return {
    ...operations.journalMetadata,
    version,
    tag,
    previous,
    // A crash can happen after the registry applied a write but before the
    // client observed success. Recovery therefore treats the full set as
    // potentially attempted; unchanged values are idempotent no-ops.
    attempted: packages.map((pkg) => pkg.name),
  };
}

/** Promote only from a pre-uploaded journal whose old values still match. */
export async function promoteReleaseSetFromJournal(journal, operations) {
  for (const name of journal.packages ?? Object.keys(journal.previous)) {
    const current = await operations.readTag(name, journal.tag);
    const previous = journal.previous[name];
    if ((current ?? null) !== (previous ?? null)) {
      throw new Error(
        `${name} dist-tag ${journal.tag} changed after the recovery journal was prepared: ` +
          `expected ${previous ?? 'absent'}, found ${current ?? 'absent'}`
      );
    }
  }
  try {
    for (const name of journal.packages ?? Object.keys(journal.previous)) {
      await operations.setTag(name, journal.version, journal.tag);
      await assertTagValue(operations, name, journal.tag, journal.version);
    }
  } catch (error) {
    try {
      await recoverReleaseSetTags(journal, operations);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `release tag promotion failed and prepared-journal recovery was incomplete: ${String(recoveryError)}`,
        { cause: recoveryError }
      );
    }
    throw error;
  }
}

/** Promote a release set with compensating rollback if any tag update fails. */
export async function promoteReleaseSet(packages, version, tag, operations) {
  const previous = new Map();
  for (const pkg of packages) previous.set(pkg.name, await operations.readTag(pkg.name, tag));
  const promoted = [];
  await operations.writeJournal?.({
    ...operations.journalMetadata,
    version,
    tag,
    previous: Object.fromEntries(previous),
    attempted: [],
  });
  try {
    for (const pkg of packages) {
      promoted.push(pkg.name);
      await operations.writeJournal?.({
        ...operations.journalMetadata,
        version,
        tag,
        previous: Object.fromEntries(previous),
        attempted: [...promoted],
      });
      await operations.setTag(pkg.name, version, tag);
    }
    for (const pkg of packages) await assertTagValue(operations, pkg.name, tag, version);
  } catch (error) {
    const rollbackErrors = [];
    const rollbackPlan = [];
    for (const name of [...promoted].reverse()) {
      try {
        const oldVersion = previous.get(name);
        const currentVersion = await operations.readTag(name, tag);
        if ((currentVersion ?? null) === (oldVersion ?? null)) continue;
        if (currentVersion !== version) {
          throw new Error(
            `${name} dist-tag ${tag} changed during rollback: ` +
              `expected ${version} or ${oldVersion ?? 'absent'}, found ${currentVersion ?? 'absent'}`,
            { cause: error }
          );
        }
        rollbackPlan.push({ name, oldVersion });
      } catch (rollbackError) {
        rollbackErrors.push(
          new Error(`${name}: ${String(rollbackError)}`, { cause: rollbackError })
        );
      }
    }
    // Do not partially compensate a release set if any member has moved to a
    // value owned by another publisher. The journal is the safe recovery path.
    if (rollbackErrors.length === 0) {
      for (const { name, oldVersion } of rollbackPlan) {
        try {
          // Narrow the unavoidable registry TOCTOU window by checking ownership
          // again immediately before every compensating write.
          const currentVersion = await operations.readTag(name, tag);
          if ((currentVersion ?? null) === (oldVersion ?? null)) continue;
          if (currentVersion !== version) {
            throw new Error(
              `${name} dist-tag ${tag} changed during rollback: ` +
                `expected ${version} or ${oldVersion ?? 'absent'}, found ${currentVersion ?? 'absent'}`,
              { cause: error }
            );
          }
          if (oldVersion) await operations.setTag(name, oldVersion, tag);
          else await operations.removeTag(name, tag);
          await assertTagValue(operations, name, tag, oldVersion);
        } catch (rollbackError) {
          rollbackErrors.push(
            new Error(`${name}: ${String(rollbackError)}`, { cause: rollbackError })
          );
          break;
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `release tag promotion failed and rollback was incomplete: ${rollbackErrors.join('; ')}`,
        { cause: error }
      );
    }
    await operations.clearJournal?.();
    throw error;
  }
  await operations.clearJournal?.();
}

export async function removeReleaseSetTag(packages, tag, operations, expectedVersion) {
  const errors = [];
  for (const pkg of packages) {
    try {
      const current = await operations.readTag(pkg.name, tag);
      if (current == null) continue;
      if (expectedVersion && current !== expectedVersion) {
        throw new Error(
          `${pkg.name} staging tag ${tag} changed: expected ${expectedVersion}, found ${current}`
        );
      }
      await operations.removeTag(pkg.name, tag);
      await assertTagValue(operations, pkg.name, tag, null);
    } catch (error) {
      errors.push(new Error(`${pkg.name}: ${String(error)}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `release succeeded but staging tag ${tag} cleanup was incomplete; rerun the release to retry`
    );
  }
}

export async function finalizeReleaseSet(packages, stagingTag, expectedVersion, operations) {
  await removeReleaseSetTag(packages, stagingTag, operations, expectedVersion);
  await operations.clearJournal();
}

/**
 * Compensate only tag values still owned by an interrupted transaction.
 * A later maintainer may have deliberately promoted another version before
 * recovery; overwriting that third value would turn a recovery command into
 * an unreviewed rollback of newer work.
 */
export async function recoverReleaseSetTags(journal, operations) {
  const packageNames = journal.packages ?? journal.attempted;
  const observed = new Map();
  for (const name of packageNames) {
    observed.set(name, await operations.readTag(name, journal.tag));
  }
  if (packageNames.every((name) => observed.get(name) === journal.version)) {
    return { outcome: 'committed' };
  }

  const recoveryPlan = [];
  for (const name of [...journal.attempted].reverse()) {
    const previousVersion = journal.previous[name];
    const currentVersion = observed.get(name);
    if ((currentVersion ?? null) === (previousVersion ?? null)) continue;
    if (currentVersion !== journal.version) {
      throw new Error(
        `${name} dist-tag ${journal.tag} changed after the interrupted release: ` +
          `expected ${journal.version} or ${previousVersion ?? 'absent'}, found ${currentVersion ?? 'absent'}`
      );
    }
    recoveryPlan.push({ name, previousVersion });
  }
  for (const { name, previousVersion } of recoveryPlan) {
    const currentVersion = await operations.readTag(name, journal.tag);
    if ((currentVersion ?? null) === (previousVersion ?? null)) continue;
    if (currentVersion !== journal.version) {
      throw new Error(
        `${name} dist-tag ${journal.tag} changed during interrupted-release recovery: ` +
          `expected ${journal.version} or ${previousVersion ?? 'absent'}, found ${currentVersion ?? 'absent'}`
      );
    }
    if (previousVersion) await operations.setTag(name, previousVersion, journal.tag);
    else await operations.removeTag(name, journal.tag);
    await assertTagValue(operations, name, journal.tag, previousVersion);
  }
  return { outcome: 'rolled_back' };
}
