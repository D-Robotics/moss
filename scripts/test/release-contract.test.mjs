import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const releaseUrl = new URL('../release-rdk-moss.mjs', import.meta.url);
const releaseSource = fs.readFileSync(releaseUrl, 'utf8');
const releaseSafetySource = fs.readFileSync(
  new URL('../lib/release-safety.mjs', import.meta.url),
  'utf8'
);
const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8'
);
const scaffoldSource = fs.readFileSync(
  new URL('../../packages/create-moss-app/index.mjs', import.meta.url),
  'utf8'
);

function assertOfficialWorkflowContract(source) {
  assert.match(source, /^name: Publish Moss npm release set$/m);
  assert.match(source, /^\s{2}workflow_dispatch:$/m);
  assert.match(source, /^\s{6}version:$/m);
  assert.match(source, /^\s{6}mode:$/m);
  assert.match(source, /^\s{10}- publish$/m);
  assert.match(source, /^\s{10}- recover$/m);
  assert.match(source, /^\s{6}recovery_run_id:$/m);
  assert.match(source, /^\s{6}recovery_run_attempt:$/m);
  assert.doesNotMatch(source, /^\s{2}(?:push|pull_request):/m);
  assert.match(source, /^\s{2}group: moss-npm-release$/m);
  assert.match(source, /^\s{2}cancel-in-progress: false$/m);
  assert.match(
    source,
    /if: github\.repository == 'D-Robotics\/moss' && github\.ref == 'refs\/heads\/main'/
  );
  assert.match(source, /MOSS_RELEASE_COORDINATOR: github-actions-release-v1/);
  assert.match(source, /git switch -C main "\$GITHUB_SHA"/);
  assert.match(source, /git symbolic-ref --short HEAD/);
  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(source, /test -n "\$NODE_AUTH_TOKEN"/);
  assert.match(source, /if: inputs\.mode == 'publish'/);
  assert.match(source, /if: inputs\.mode == 'recover'/);
  assert.match(source, /node scripts\/release-rdk-moss\.mjs "\$MOSS_RELEASE_VERSION" --publish/);
  assert.match(source, /uses: actions\/download-artifact@v4/);
  assert.match(source, /run-id: \$\{\{ inputs\.recovery_run_id \}\}/);
  assert.match(source, /MOSS_RECOVERY_SOURCE_RUN_ID: \$\{\{ inputs\.recovery_run_id \}\}/);
  assert.match(
    source,
    /MOSS_RECOVERY_SOURCE_RUN_ATTEMPT: \$\{\{ inputs\.recovery_run_attempt \}\}/
  );
  assert.match(source, /MOSS_RECOVERY_SOURCE_SHA: \$\{\{ env\.MOSS_RECOVERY_SOURCE_SHA \}\}/);
  assert.match(source, /node scripts\/release-rdk-moss\.mjs --recover-tags/);
  assert.match(
    source,
    /actions\/runs\/\$\{MOSS_RECOVERY_RUN_ID\}\/attempts\/\$\{MOSS_RECOVERY_RUN_ATTEMPT\}/
  );
  assert.match(
    source,
    /node scripts\/release-rdk-moss\.mjs "\$MOSS_RELEASE_VERSION" --prepare-tag-journal/
  );
  assert.match(source, /uses: actions\/upload-artifact@v4/);
  assert.match(source, /artifacts\/release-provenance-\$\{\{ inputs\.version \}\}\.json/);
  assert.match(source, /\.release-tag-journal\.json/);
  assert.match(source, /include-hidden-files: true/);
  assert.match(source, /if: always\(\) && inputs\.mode == 'publish'/);
  assert.match(source, /^\s{2}actions: read$/m);
  assert.doesNotMatch(source, /npm publish/);
  assert.ok(
    source.indexOf('--prepare-tag-journal') <
      source.indexOf('name: moss-release-recovery-${{ github.run_id }}-${{ github.run_attempt }}'),
    'journal is prepared before its durable artifact upload'
  );
  assert.ok(
    source.indexOf('name: moss-release-recovery-${{ github.run_id }}-${{ github.run_attempt }}') <
      source.indexOf('node scripts/release-rdk-moss.mjs "$MOSS_RELEASE_VERSION" --publish'),
    'durable recovery artifact exists before the first registry mutation'
  );
  assert.match(source, /if-no-files-found: error/);
}

test('release entrypoint is syntactically valid', () => {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(releaseUrl)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('release preflights the complete package set before transactional promotion', () => {
  assert.match(releaseSource, /name: '@rdk-moss\/core'/);
  assert.match(releaseSource, /name: '@rdk-moss\/agent'/);
  assert.match(releaseSource, /name: 'create-moss-app'/);
  assert.ok(
    releaseSource.indexOf("run('npm', ['run', 'verify'])") <
      releaseSource.indexOf('const packedPackages'),
    'full verify runs before the first publish'
  );
  assert.ok(
    releaseSource.indexOf('const packedPackages') < releaseSource.indexOf("run('npm', ['publish'"),
    'all tarballs are inspected before registry writes'
  );
  assert.match(releaseSource, /moss-staging-/);
  assert.match(releaseSource, /assertMatchingIntegrity/);
  assert.match(releaseSource, /promoteReleaseSet/);
  assert.match(releaseSource, /--recover-tags/);
  assert.match(releaseSource, /\.release-tag-journal\.json/);
  assert.match(releaseSource, /releaseDistTag/);
  assert.match(releaseSource, /finalizeReleaseSet/);
  assert.match(releaseSource, /assertPublishProvenance/);
  assert.match(releaseSource, /assertTrustedReleaseCoordinator\(process\.env\)/);
  assert.match(releaseSource, /assertReleaseRecoverySource/);
  assert.match(releaseSource, /source: sourceProvenance\.coordinator/);
  assert.match(releaseSource, /promoteReleaseSetFromJournal/);
  assert.ok(
    releaseSource.indexOf('promoteReleaseSetFromJournal') <
      releaseSource.lastIndexOf('finalizeReleaseSet'),
    'formal promotion completes before staging cleanup'
  );
  assert.ok(
    releaseSafetySource.indexOf('await removeReleaseSetTag') <
      releaseSafetySource.indexOf('await operations.clearJournal()'),
    'staging cleanup completes before the durable journal is cleared'
  );
  assert.match(releaseSource, /--prepare-tag-journal/);
  assert.match(releaseSource, /prepared tag journal is required before publishing/);
  assert.match(releaseSource, /head !== coordinator\.sha/);
  assert.match(releaseSource, /--prepare/);
  assert.match(releaseSource, /'ls-remote'/);
  assert.match(releaseSource, /release-provenance-/);
  assert.match(releaseSource, /D-Robotics\/moss\.git/);
  assert.match(releaseSource, /assertPackedFileProvenance/);
  assert.doesNotMatch(releaseSource, /syncVersions/);
  assert.doesNotMatch(releaseSource, /skip-build/);
});

test('official publishing is serialized by one fixed manual workflow', () => {
  assertOfficialWorkflowContract(workflowSource);
});

test('official workflow contract rejects unsafe triggers and concurrency', () => {
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace('  workflow_dispatch:', '  push:\n  workflow_dispatch:')
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace(
        'actions/runs/${MOSS_RECOVERY_RUN_ID}/attempts/${MOSS_RECOVERY_RUN_ATTEMPT}',
        'actions/runs/${MOSS_RECOVERY_RUN_ID}'
      )
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace('git switch -C main "$GITHUB_SHA"', 'git checkout "$GITHUB_SHA"')
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace('cancel-in-progress: false', 'cancel-in-progress: true')
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace(
        'group: moss-npm-release',
        'group: moss-npm-release-${{ inputs.version }}'
      )
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace(
        "github.ref == 'refs/heads/main'",
        "github.ref == 'refs/heads/release'"
      )
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(workflowSource.replace('  actions: read', '  actions: none'))
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace('include-hidden-files: true', 'include-hidden-files: false')
    )
  );
  assert.throws(() =>
    assertOfficialWorkflowContract(
      workflowSource.replace(
        'run-id: ${{ inputs.recovery_run_id }}',
        'run-id: ${{ github.run_id }}'
      )
    )
  );
});

test('scaffold resolves one compatible runtime dependency set', () => {
  assert.match(scaffoldSource, /'@rdk-moss\/agent': '\^0\.6\.0'/);
  assert.doesNotMatch(scaffoldSource, /'@rdk-moss\/core': mossVersionRange/);
  assert.match(scaffoldSource, /'@rdk-moss\/agent': mossVersionRange/);
});
