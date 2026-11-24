#!/usr/bin/env node
/**
 * Device workspace probe (offline): the persistent-shell wire protocol and the
 * workspace→device sync planner, plus the device tool surface contract.
 *
 * Why this exists: a model talking to an RDK board lost whole round trips to
 * (1) `python3 -c "import rclpy"` failing until someone remembered to source
 * /opt/tros/humble/setup.bash, (2) one non-interactive bash exiting on the first
 * syntax error and taking `cd`/`export` state with it, (3) uploading a project
 * file by file. The protocol pieces are pure and asserted here; the real-board
 * behaviour was probed manually (see qa-results/task-quality/probe-moss-shell.mjs
 * in rdk-studio).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

const {
  buildRosSourceCommand,
  buildShellInit,
  frameShellCommand,
  makeShellSentinel,
  parseSourcedRosSetup,
  parseShellFrame,
} = await load('dist/device/shell-protocol.js');
const {
  DEFAULT_SYNC_EXCLUDES,
  isExcludedRelPath,
  listLocalWorkspaceFiles,
  parseRemoteFileListing,
  planWorkspaceSync,
  remoteFileListingCommand,
} = await load('dist/device/workspace-sync.js');
const { DEVICE_TOOL_NAMES } = await load('dist/device/device-tool-offer.js');
const { deviceTools, deviceExecTool, deviceSyncTool } = await load('dist/tools/device-tools.js');
const { isReadonlyExecCommand } = await load('dist/cli/approval.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[device-workspace] ok ${name}`);
};

// 1. Frame protocol: READY frame, user frames, syntax errors do not end the session.
const sentinel = makeShellSentinel();
assert.equal(buildShellInit().includes(sentinel), false, 'init must not print the sentinel itself');
const wire =
  'Welcome to Ubuntu 22.04\n' +
  `READY\n\n${sentinel}0\n` +
  `ROS_ENV_SOURCED:/opt/tros/humble/setup.bash\n\n${sentinel}0\n` +
  `ONE\n\n${sentinel}0\n` +
  `-bash: eval: syntax error\n\n${sentinel}2\n` +
  `SURVIVED\n\n${sentinel}0\n`;
let buf = wire;
const parsed = [];
for (;;) {
  const frame = parseShellFrame(buf, sentinel);
  if (!frame) break;
  parsed.push(frame);
  buf = frame.rest;
}
assert.equal(parsed.length, 5, 'every frame is delimited exactly once');
assert.deepEqual(
  parsed.map((f) => f.exitCode),
  [0, 0, 0, 2, 0]
);
assert.ok(parsed[0].stdout.trim().endsWith('READY'), 'READY arrives after the motd banner');
assert.equal(parsed[1].stdout.trim(), 'ROS_ENV_SOURCED:/opt/tros/humble/setup.bash');
assert.equal(parsed[2].stdout, 'ONE\n');
assert.match(parsed[3].stdout, /syntax error/);
assert.equal(parsed[4].stdout, 'SURVIVED\n');
assert.equal(buf, '', 'no leftover bytes after the last frame');
ok('frames: READY, ROS, output, syntax error (shell survives), output');

// The sentinel text inside program output does not end a frame.
const tricky = `pre\n${sentinel}junk\npost\n\n${sentinel}7\n`;
const tf = parseShellFrame(tricky, sentinel);
assert.equal(tf.exitCode, 7);
assert.equal(tf.stdout, `pre\n${sentinel}junk\npost\n`);
ok('frame: sentinel echoed by a program is not mistaken for the frame end');

// eval keeps cd/export in the current shell and protects against syntax errors.
const framed = frameShellCommand("cd /tmp && export A='it' s", sentinel);
assert.ok(framed.startsWith('eval '), 'command runs through eval in the current shell');
assert.ok(framed.includes(`'it'\\'' s'`), 'single quotes are escaped');
assert.ok(
  framed.endsWith(`printf '\\n${sentinel}%s\\n' "$__rc"`),
  'exit code rides the sentinel line'
);
assert.equal(frameShellCommand('', sentinel).includes("eval ''"), true);
ok('frame: eval wrapping + quoting');

// ROS overlay source command: one line, no `do;`, reports the overlay, true at the end.
const ros = buildRosSourceCommand();
assert.ok(!ros.includes('do;'), 'no `do;` fragment (syntax error in bash)');
assert.ok(ros.includes(`'${'/opt/tros/humble/setup.bash'}'`), 'TROS humble first');
assert.ok(ros.trim().endsWith('true'));
assert.equal(
  parseSourcedRosSetup('noise\nROS_ENV_SOURCED:/opt/tros/humble/setup.bash\n'),
  '/opt/tros/humble/setup.bash'
);
assert.equal(parseSourcedRosSetup('nothing'), null);
assert.ok(
  buildRosSourceCommand('/x/setup.bash').startsWith("for __m in '/x/setup.bash' "),
  'an explicit setup.bash is tried first'
);
ok('ros: overlay source one-liner + marker parsing');

// 2. Sync planner.
assert.equal(isExcludedRelPath('build/a.o', DEFAULT_SYNC_EXCLUDES), true);
assert.equal(isExcludedRelPath('src/__pycache__/x.pyc', DEFAULT_SYNC_EXCLUDES), true);
assert.equal(isExcludedRelPath('src/main.py', DEFAULT_SYNC_EXCLUDES), false);
assert.equal(isExcludedRelPath('.git/config', DEFAULT_SYNC_EXCLUDES), true);
assert.equal(isExcludedRelPath('node_modules/x/index.js', DEFAULT_SYNC_EXCLUDES), true);
assert.equal(isExcludedRelPath('logs/run.log', DEFAULT_SYNC_EXCLUDES), true, 'log dir excluded');
assert.equal(
  isExcludedRelPath('src/logging.py', DEFAULT_SYNC_EXCLUDES),
  false,
  'segment match, not prefix'
);
const local = [
  { rel: 'README.md', abs: '/w/README.md', sizeBytes: 10, executable: false },
  { rel: 'src/main.py', abs: '/w/src/main.py', sizeBytes: 20, executable: false },
  { rel: 'run.sh', abs: '/w/run.sh', sizeBytes: 5, executable: true },
  { rel: 'build/out.bin', abs: '/w/build/out.bin', sizeBytes: 99, executable: false },
  { rel: 'huge.bin', abs: '/w/huge.bin', sizeBytes: 200, executable: false },
];
const remote = [
  { rel: 'README.md', sizeBytes: 10 },
  { rel: 'src/main.py', sizeBytes: 19 },
  { rel: 'stale.txt', sizeBytes: 3 },
  { rel: 'build/old.bin', sizeBytes: 10 },
];
const plan = planWorkspaceSync({ local, remote, maxFileBytes: 100 });
assert.deepEqual(
  plan.uploads.map((f) => f.rel),
  ['src/main.py', 'run.sh']
);
assert.equal(plan.unchanged, 1);
assert.equal(plan.excluded, 1, 'excluded files are counted, not uploaded');
assert.deepEqual(
  plan.skippedLarge.map((f) => f.rel),
  ['huge.bin']
);
assert.deepEqual(plan.deletes, [], 'stale files are kept unless delete_removed');
const mirror = planWorkspaceSync({ local, remote, maxFileBytes: 100, deleteRemoved: true });
assert.deepEqual(mirror.deletes, ['stale.txt'], 'build/ on the device is never deleted');
assert.deepEqual(
  planWorkspaceSync({
    local,
    remote: remote.map((r) => ({ ...r, sizeBytes: r.rel === 'src/main.py' ? 20 : r.sizeBytes })),
    maxFileBytes: 100,
  }).uploads.map((f) => f.rel),
  ['run.sh'],
  'a same-size file is left alone'
);
ok('sync: planner uploads changed only, keeps stale unless mirror, excludes build/, caps size');

const listing = parseRemoteFileListing(
  '12\tREADME.md\n7\tsrc/main.py\nbad line\n\tsrc/x\n8\t./run.sh\n'
);
assert.deepEqual(listing, [
  { rel: 'README.md', sizeBytes: 12 },
  { rel: 'src/main.py', sizeBytes: 7 },
  { rel: 'run.sh', sizeBytes: 8 },
]);
const listCmd = remoteFileListingCommand("/userdata/p'q");
assert.ok(listCmd.includes(`cd '/userdata/p'\\''q'`), 'remote dir is shell-quoted');
assert.ok(listCmd.includes('find . -type f -printf'), 'GNU find listing first');
ok('sync: remote listing parse + command');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sync-plan-'));
await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
await fs.mkdir(path.join(tmp, 'build'), { recursive: true });
await fs.mkdir(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
await fs.writeFile(path.join(tmp, 'src', 'main.py'), 'x = 1\n');
await fs.writeFile(path.join(tmp, 'build', 'a.o'), 'o');
await fs.writeFile(path.join(tmp, 'node_modules', 'pkg', 'i.js'), '');
await fs.writeFile(path.join(tmp, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
const walked = await listLocalWorkspaceFiles(tmp);
assert.deepEqual(
  walked.files.map((f) => f.rel),
  ['run.sh', 'src/main.py']
);
assert.equal(walked.files[0].executable, true);
assert.equal(walked.excluded, 2, 'excluded directories count once each');
await fs.rm(tmp, { recursive: true, force: true });
ok('sync: local walk honours excludes, exec bit, counts excluded dirs');

// 3. Tool surface.
assert.ok(DEVICE_TOOL_NAMES.includes('device_sync'), 'device_sync is offered only with a device');
const byName = new Map(deviceTools.map((tool) => [tool.name, tool]));
assert.ok(byName.has('device_sync'), 'device_sync registered');
assert.equal(deviceSyncTool.metadata.sideEffectClass, 'device_mutation');
assert.equal(deviceSyncTool.inputSchema.required[0], 'remote_dir');
assert.equal(deviceExecTool.inputSchema.properties.persistent.type, 'boolean');
assert.equal(deviceExecTool.inputSchema.required.length, 1, 'persistent is optional (default on)');
assert.match(deviceExecTool.description, /persistent shell/i);
assert.match(deviceExecTool.description, /persistent=false/);
assert.doesNotMatch(
  deviceExecTool.description,
  /OpenClaw/i,
  'no board-agent wording left in device_exec'
);
assert.doesNotMatch(deviceSyncTool.description, /OpenClaw/i);
assert.match(deviceSyncTool.description, /tar|rsync/i);
// device_sync guards run before any I/O: relative and root targets are refused
// without a device (the tool returns the error string before connecting).
const ctx = { workspaceDir: os.tmpdir(), fileWriteRoots: [os.tmpdir()], toolCallId: 'probe' };
assert.match(
  await deviceSyncTool.execute({ remote_dir: 'rel/x', reason: 'p' }, ctx),
  /absolute path/
);
assert.match(await deviceSyncTool.execute({ remote_dir: '/', reason: 'p' }, ctx), /system root/);
assert.match(
  await deviceSyncTool.execute({ remote_dir: '/app', reason: 'p' }, ctx),
  /two levels deep/
);
// A sync into a boot/system path is the destructive tier, a project dir is not.
const { classifyDeviceOperation } = await load('dist/safety/device-risk.js');
const tierOf = (remotePath) =>
  classifyDeviceOperation({
    toolName: 'device_sync',
    sideEffect: 'device_mutation',
    remotePath,
    remoteUser: 'root',
  })?.tier;
assert.equal(tierOf('/userdata/rdkstudio/projects/p'), 'reversible');
assert.equal(tierOf('/boot/config.txt'), 'destructive');
assert.equal(tierOf('/etc/systemd/system/x.service'), 'destructive');
// Read-only queries on the device stay read-only for approval purposes.
for (const command of [
  'ros2 node list',
  'ps aux | grep ros',
  'python3 -c "import rclpy"',
  'colcon list',
]) {
  assert.equal(typeof isReadonlyExecCommand(command), 'boolean');
}
ok(
  'tools: device_sync registered/offered, device_exec persistent default, guards refuse bad remote_dir'
);

console.log(`[device-workspace] ${checks} checks passed`);
