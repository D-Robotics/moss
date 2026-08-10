#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseTagJournal,
  assertReleaseRecoverySource,
  assertReleaseSourceState,
  assertOfficialReleaseRemote,
  assertMatchingIntegrity,
  assertTrustedReleaseCoordinator,
  canonicalRegistryUrl,
  clearDurableFileSync,
  finalizeReleaseSet,
  prepareReleaseSetTagJournal,
  promoteReleaseSetFromJournal,
  recoverReleaseSetTags,
  RELEASE_TAG_JOURNAL_SCHEMA,
  releaseDependencyRange,
  releaseDistTag,
  writeDurableFileAtomicSync,
} from './lib/release-safety.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tagJournalPath = path.join(repoRoot, '.release-tag-journal.json');
const officialRepositoryUrl = 'https://github.com/D-Robotics/moss.git';

const releasePackages = [
  { name: '@rdk-moss/core', dir: 'packages/moss' },
  { name: '@rdk-moss/agent', dir: 'packages/moss-agent' },
  { name: 'create-moss-app', dir: 'packages/create-moss-app' },
];

const internalNames = new Set(releasePackages.map((pkg) => pkg.name));

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/release-rdk-moss.mjs <version> [--publish]',
      '  node scripts/release-rdk-moss.mjs <version> --prepare',
      '  node scripts/release-rdk-moss.mjs <version> --prepare-tag-journal',
      '  node scripts/release-rdk-moss.mjs --recover-tags',
      '',
      'Use --prepare, commit and push the coordinated version bump, then dispatch release.yml.',
      'Default mode is a dry-run from an already prepared version commit.',
      'Official --publish and --recover-tags writes are accepted only from that trusted workflow.',
      'The script verifies and stages core, agent, and create-moss-app before promoting latest.',
      '',
      'Examples:',
      '  node scripts/release-rdk-moss.mjs 0.3.7',
      '  node scripts/release-rdk-moss.mjs 0.3.7 --prepare',
    ].join('\n')
  );
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const shown = [command, ...args].join(' ');
  console.error(`[release] ${shown}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw new Error(`${shown}: ${result.error.message}`, { cause: result.error });
  if ((result.status ?? 0) !== 0) throw new Error(`${shown}: exited ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(
      `${command} ${args.join(' ')}: ${result.stderr.trim() || `exited ${result.status}`}`
    );
  }
  return result.stdout.trim();
}

function requireNpmAuth(registry) {
  const result = spawnSync('npm', ['whoami', '--registry', registry], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(
      'npm is not logged in. Run `npm login` or configure an npm auth token before using --publish.'
    );
  }
  console.error(`[release] npm authenticated as ${result.stdout.trim()}`);
}

function readPackageJson(dir) {
  const file = path.join(repoRoot, dir, 'package.json');
  return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function writePackageJson(file, json) {
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function prepareReleaseVersions(version) {
  if (capture('git', ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('--prepare requires a clean Git worktree and index');
  }
  const internalRange = releaseDependencyRange(version);
  for (const pkg of releasePackages) {
    const { file, json } = readPackageJson(pkg.dir);
    json.version = version;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const depName of Object.keys(json[field] ?? {})) {
        if (internalNames.has(depName)) json[field][depName] = internalRange;
      }
    }
    writePackageJson(file, json);
  }
  const createAppFile = path.join(repoRoot, 'packages/create-moss-app/index.mjs');
  const createAppSource = fs.readFileSync(createAppFile, 'utf8');
  const pattern = /'@rdk-moss\/agent': '\^?[^']+'/;
  if (!pattern.test(createAppSource)) {
    throw new Error('create-moss-app fallback dependency entry is missing');
  }
  fs.writeFileSync(
    createAppFile,
    createAppSource.replace(pattern, `'@rdk-moss/agent': '${internalRange}'`)
  );
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
}

function assertCreateMossAppFallback(version) {
  const file = path.join(repoRoot, 'packages/create-moss-app/index.mjs');
  const source = fs.readFileSync(file, 'utf8');
  // Update the offline-fallback range for @rdk-moss/agent in the
  // FALLBACK_VERSION_RANGE map. (The primary scaffold path queries npm for
  // the latest published version; this hardcoded map is the offline fallback
  // only, kept on a published version so a user's `npm install` always
  // resolves even when the local workspace version is an unpublished RC.)
  const pattern = /'@rdk-moss\/agent': '\^?[^']+'/;
  if (!pattern.test(source)) {
    fail(
      'packages/create-moss-app/index.mjs: missing FALLBACK_VERSION_RANGE @rdk-moss/agent entry'
    );
  }
  const range = releaseDependencyRange(version);
  if (!source.includes(`'@rdk-moss/agent': '${range}'`)) {
    throw new Error(`create-moss-app fallback must already be committed at ${range}`);
  }
}

function assertVersionsSynchronized(version) {
  const internalRange = releaseDependencyRange(version);
  for (const pkg of releasePackages) {
    const { json } = readPackageJson(pkg.dir);
    if (json.version !== version) {
      throw new Error(`${pkg.name} package version must already be committed at ${version}`);
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      if (!json[field]) continue;
      for (const depName of Object.keys(json[field])) {
        if (internalNames.has(depName) && json[field][depName] !== internalRange) {
          throw new Error(
            `${pkg.name} dependency ${depName} must be committed at ${internalRange}`
          );
        }
      }
    }
  }
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  for (const pkg of releasePackages) {
    const locked = lock.packages?.[pkg.dir]?.version;
    if (locked !== version) {
      throw new Error(`${pkg.name} lockfile version must already be committed at ${version}`);
    }
  }
  assertCreateMossAppFallback(version);
}

function assertPublishProvenance() {
  const coordinator = assertTrustedReleaseCoordinator(process.env);
  const expectedBranch = 'main';
  const head = capture('git', ['rev-parse', 'HEAD']);
  const branch = capture('git', ['branch', '--show-current']);
  assertOfficialReleaseRemote(
    capture('git', ['remote', 'get-url', 'origin']),
    officialRepositoryUrl
  );
  const remoteLine = capture('git', [
    'ls-remote',
    '--heads',
    officialRepositoryUrl,
    `refs/heads/${expectedBranch}`,
  ]);
  const remoteHead = remoteLine.split(/\s+/u)[0] || '';
  assertReleaseSourceState({
    status: capture('git', ['status', '--porcelain', '--untracked-files=all']),
    branch,
    expectedBranch,
    head,
    remoteHead,
  });
  if (head !== coordinator.sha) {
    throw new Error(
      `real publish requires HEAD to equal GITHUB_SHA: head=${head} sha=${coordinator.sha}`
    );
  }
  return { head, branch, remoteRef: `refs/heads/${expectedBranch}`, coordinator };
}

function assertPackedFileProvenance(packedPackages) {
  const generatedAllowlist = new Set(['zero-config-default.json', 'bundled-search-key.json']);
  for (const pkg of packedPackages) {
    for (const item of pkg.files ?? []) {
      if (item.path.startsWith('dist/') || generatedAllowlist.has(item.path)) continue;
      const repositoryPath = path.posix.join(pkg.dir, item.path);
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', repositoryPath], {
        cwd: repoRoot,
        stdio: 'ignore',
      });
      if (tracked.status !== 0) {
        throw new Error(
          `${pkg.name} would publish untracked or ignored input ${item.path}; ` +
            'commit it or add a narrowly reviewed generated-file provenance rule'
        );
      }
    }
  }
}

function assertSourceUnchanged(provenance) {
  if (!provenance) return;
  assertReleaseSourceState({
    status: capture('git', ['status', '--porcelain', '--untracked-files=all']),
    branch: capture('git', ['branch', '--show-current']),
    expectedBranch: provenance.branch,
    head: capture('git', ['rev-parse', 'HEAD']),
    remoteHead: provenance.head,
  });
}

function registryIntegrity(name, version, registry) {
  const result = spawnSync(
    'npm',
    [
      'view',
      `${name}@${version}`,
      'dist.integrity',
      '--json',
      '--prefer-online',
      '--registry',
      registry,
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (result.status === 0 && result.stdout.trim()) return JSON.parse(result.stdout);
  if (/E404|is not in this registry/iu.test(`${result.stdout}\n${result.stderr}`)) return null;
  fail(`cannot determine registry integrity for ${name}@${version}: ${result.stderr.trim()}`);
}

function packPackage(pkg, destination) {
  const output = capture('npm', [
    'pack',
    '--json',
    `--workspace=${pkg.name}`,
    `--pack-destination=${destination}`,
  ]);
  const [packed] = JSON.parse(output);
  if (!packed?.filename || !packed?.integrity)
    fail(`npm pack returned incomplete metadata for ${pkg.name}`);
  return { ...pkg, ...packed, tarball: path.join(destination, packed.filename) };
}

function writeTagJournal(journal, registry) {
  assertReleaseTagJournal(journal, releasePackages, registry);
  writeDurableFileAtomicSync(tagJournalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

function currentRegistry() {
  return canonicalRegistryUrl(capture('npm', ['config', 'get', 'registry']));
}

function readRegistryTag(name, tag, registry) {
  const output = capture('npm', [
    'view',
    name,
    `dist-tags.${tag}`,
    '--json',
    '--prefer-online',
    '--registry',
    registry,
  ]);
  if (!output || output === 'null') return null;
  return JSON.parse(output);
}

function stagingTagForVersion(version) {
  return `moss-staging-${version.replace(/[^0-9A-Za-z-]/g, '-')}`;
}

function recoverTagJournal() {
  assertTrustedReleaseCoordinator(process.env);
  if (!fs.existsSync(tagJournalPath)) fail('no interrupted tag promotion journal found');
  const journal = JSON.parse(fs.readFileSync(tagJournalPath, 'utf8'));
  const registry = currentRegistry();
  assertReleaseTagJournal(journal, releasePackages, registry);
  assertReleaseRecoverySource(journal.source, process.env);
  requireNpmAuth(registry);
  const registryOperations = {
    readTag: async (name, tag) => readRegistryTag(name, tag, registry),
    setTag: async (name, version, tag) =>
      run('npm', ['dist-tag', 'add', `${name}@${version}`, tag, '--registry', registry]),
    removeTag: async (name, tag) =>
      run('npm', ['dist-tag', 'rm', name, tag, '--registry', registry]),
  };
  return recoverReleaseSetTags(journal, registryOperations).then(async (result) => {
    await finalizeReleaseSet(
      releasePackages,
      stagingTagForVersion(journal.version),
      journal.version,
      {
        ...registryOperations,
        clearJournal: async () => clearDurableFileSync(tagJournalPath),
      }
    );
    console.error(
      result.outcome === 'committed'
        ? '[release] interrupted release was fully committed; formal tags retained and staging cleaned'
        : '[release] partial release rolled back and staging cleaned'
    );
    return result;
  });
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}
if (args.length === 1 && args[0] === '--recover-tags') {
  await recoverTagJournal();
  process.exit(0);
}

const version = args.find((arg) => !arg.startsWith('-'));
if (!version) {
  usage();
  fail('missing release version');
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`invalid semver-ish version: ${version}`);
}

const realPublish = args.includes('--publish');
const prepare = args.includes('--prepare');
const prepareTagJournal = args.includes('--prepare-tag-journal');
const unknownFlags = args.filter(
  (arg) =>
    arg.startsWith('-') &&
    arg !== '--publish' &&
    arg !== '--prepare' &&
    arg !== '--prepare-tag-journal'
);
if (unknownFlags.length > 0) fail(`unknown option: ${unknownFlags.join(', ')}`);
if ([realPublish, prepare, prepareTagJournal].filter(Boolean).length > 1) {
  fail('--prepare, --prepare-tag-journal, and --publish are mutually exclusive');
}
if (prepareTagJournal && fs.existsSync(tagJournalPath)) {
  fail('refusing to replace an existing tag journal');
}
if (realPublish && !fs.existsSync(tagJournalPath)) {
  fail('prepared tag journal is required before publishing');
}

if (prepare) {
  prepareReleaseVersions(version);
  console.error(
    `[release] prepared ${version}; review, commit, and push the version bump before dry-run or --publish`
  );
  process.exit(0);
}

const sourceProvenance = realPublish || prepareTagJournal ? assertPublishProvenance() : null;
assertVersionsSynchronized(version);

if (prepareTagJournal) {
  const registry = currentRegistry();
  requireNpmAuth(registry);
  const journal = await prepareReleaseSetTagJournal(
    releasePackages,
    version,
    releaseDistTag(version),
    {
      journalMetadata: {
        schema: RELEASE_TAG_JOURNAL_SCHEMA,
        transactionId: crypto.randomUUID(),
        registry,
        packages: releasePackages.map((pkg) => pkg.name),
        source: sourceProvenance.coordinator,
      },
      readTag: async (name, tag) => readRegistryTag(name, tag, registry),
    }
  );
  writeTagJournal(journal, registry);
  console.error(`[release] prepared durable tag journal for ${version}`);
  process.exit(0);
}

run('npm', ['run', 'verify']);

// Validate every tarball before the first irreversible registry write.
const packDir = fs.mkdtempSync(path.join(repoRoot, '.release-pack-'));
const packedPackages = releasePackages.map((pkg) => packPackage(pkg, packDir));
assertPackedFileProvenance(packedPackages);
assertSourceUnchanged(sourceProvenance);
let provenancePath = '';

if (realPublish && sourceProvenance) {
  const artifactsDir = path.join(repoRoot, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  provenancePath = path.join(artifactsDir, `release-provenance-${version}.json`);
  fs.writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        schema: 'rdk-moss.release-provenance.v1',
        ...sourceProvenance,
        version,
        createdAt: new Date().toISOString(),
        tarballs: packedPackages.map((pkg) => ({
          name: pkg.name,
          filename: pkg.filename,
          integrity: pkg.integrity,
          generatedInputs: (pkg.files ?? [])
            .filter((item) =>
              ['zero-config-default.json', 'bundled-search-key.json'].includes(item.path)
            )
            .map((item) => ({ path: item.path, bytes: item.size })),
        })),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

try {
  if (realPublish) {
    const registry = currentRegistry();
    requireNpmAuth(registry);
    const journal = JSON.parse(fs.readFileSync(tagJournalPath, 'utf8'));
    assertReleaseTagJournal(journal, releasePackages, registry);
    assertReleaseRecoverySource(journal.source, {
      MOSS_RECOVERY_SOURCE_SHA: sourceProvenance.coordinator.sha,
      MOSS_RECOVERY_SOURCE_RUN_ID: sourceProvenance.coordinator.runId,
      MOSS_RECOVERY_SOURCE_RUN_ATTEMPT: sourceProvenance.coordinator.runAttempt,
    });
    if (journal.version !== version || journal.tag !== releaseDistTag(version)) {
      fail('prepared tag journal version or target tag does not match this publish');
    }
    const stagingTag = stagingTagForVersion(version);
    for (const pkg of packedPackages) {
      const existingIntegrity = registryIntegrity(pkg.name, version, registry);
      if (existingIntegrity) {
        assertMatchingIntegrity(pkg.name, version, pkg.integrity, existingIntegrity);
        console.error(`[release] ${pkg.name}@${version} already exists with matching integrity`);
        continue;
      }
      run('npm', [
        'publish',
        pkg.tarball,
        '--access',
        'public',
        '--tag',
        stagingTag,
        '--registry',
        registry,
      ]);
      assertMatchingIntegrity(
        pkg.name,
        version,
        pkg.integrity,
        registryIntegrity(pkg.name, version, registry)
      );
    }
    await promoteReleaseSetFromJournal(journal, {
      readTag: async (name, tag) => readRegistryTag(name, tag, registry),
      setTag: async (name, tagVersion, tag) =>
        run('npm', ['dist-tag', 'add', `${name}@${tagVersion}`, tag, '--registry', registry]),
      removeTag: async (name, tag) =>
        run('npm', ['dist-tag', 'rm', name, tag, '--registry', registry]),
    });
    await finalizeReleaseSet(releasePackages, stagingTag, version, {
      readTag: async (name, tag) => readRegistryTag(name, tag, registry),
      removeTag: async (name, tag) =>
        run('npm', ['dist-tag', 'rm', name, tag, '--registry', registry]),
      clearJournal: async () => clearDurableFileSync(tagJournalPath),
    });
  } else {
    for (const pkg of packedPackages)
      run('npm', ['publish', pkg.tarball, '--access', 'public', '--dry-run']);
  }
} finally {
  fs.rmSync(packDir, { recursive: true, force: true });
}

console.error(
  `[release] ${realPublish ? 'published and promoted' : 'dry-run complete'} Moss release set ${version}`
);
if (provenancePath) console.error(`[release] provenance: ${provenancePath}`);
