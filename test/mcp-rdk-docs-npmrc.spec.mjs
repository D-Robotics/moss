/**
 * Built-in rdk-docs npx must use the user's registry (~/.npmrc) and must not
 * use a project .npmrc, even when TMPDIR points at the workspace.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { builtinRdkDocsServerConfig, rdkDocsNpxCwd } from '../dist/core/mcp/rdk-docs.js';
import { McpToolRegistry } from '../dist/core/mcp/registry.js';
import { isDotenvDeniedEnvKey } from '../dist/utils/dotenv-denied-env.js';
import { pinNpmUserConfig } from '../dist/utils/safe-child-env.js';
import { runProcess } from '../dist/utils/run-process.js';

const dependencyName = `moss-npmrc-probe-${process.pid}-${Date.now()}`;
let dependencyTarball;

async function packFixture(directory) {
  const packed = await runProcess(
    process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : 'npm',
    {
      args:
        process.platform === 'win32'
          ? ['/d', '/s', '/c', 'npm pack --ignore-scripts --json']
          : ['pack', '--ignore-scripts', '--json'],
      cwd: directory,
      timeout: 30000,
    }
  );
  return path.join(directory, JSON.parse(packed.stdout)[0].filename);
}

for (const key of ['TMPDIR', 'TMP', 'TEMP', 'npm_config_userconfig', 'NPM_CONFIG_USERCONFIG']) {
  assert.equal(isDotenvDeniedEnvKey(key), true, key);
}

function listen(bucket, hits) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      hits[bucket].push(`${req.method} ${req.url}`);
      if (bucket === 'user' && req.url === `/${dependencyName}`) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: dependencyName,
            'dist-tags': { latest: '0.0.0' },
            versions: {
              '0.0.0': {
                name: dependencyName,
                version: '0.0.0',
                dist: { tarball: `http://${req.headers.host}/${dependencyName}/-/probe.tgz` },
              },
            },
          })
        );
        return;
      }
      if (bucket === 'user' && req.url === `/${dependencyName}/-/probe.tgz`) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(dependencyTarball);
        return;
      }
      res.statusCode = 404;
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-npmrc-'));
const dependencyDir = path.join(root, 'dependency');
fs.mkdirSync(dependencyDir);
fs.writeFileSync(
  path.join(dependencyDir, 'package.json'),
  JSON.stringify({
    name: dependencyName,
    version: '0.0.0',
    main: 'index.js',
  })
);
fs.writeFileSync(
  path.join(dependencyDir, 'index.js'),
  'module.exports = "registry dependency installed";\n'
);
dependencyTarball = fs.readFileSync(await packFixture(dependencyDir));
const hits = { user: [], project: [] };
const userServer = await listen('user', hits);
const projectServer = await listen('project', hits);
const userPort = userServer.address().port;
const projectPort = projectServer.address().port;

const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const packageDir = path.join(root, 'rdk-docs-mcp');
const ran = path.join(root, 'ran.json');
const evilTmp = path.join(ws, 'evil-tmp');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(evilTmp, { recursive: true });
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(home, '.npmrc'), `registry=http://127.0.0.1:${userPort}/\n`);
fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'proj', version: '1.0.0' }));
fs.writeFileSync(path.join(ws, '.npmrc'), `registry=http://127.0.0.1:${projectPort}/\n`);
fs.writeFileSync(path.join(ws, '.env'), `TMPDIR=${evilTmp}\nTMP=${evilTmp}\nTEMP=${evilTmp}\n`);
fs.writeFileSync(
  path.join(packageDir, 'package.json'),
  JSON.stringify({
    name: 'rdk-docs-mcp',
    version: '0.0.0',
    bin: { 'rdk-docs-mcp': './probe.mjs' },
    dependencies: { [dependencyName]: '0.0.0' },
  })
);
fs.writeFileSync(
  path.join(packageDir, 'probe.mjs'),
  [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `import dependency from ${JSON.stringify(dependencyName)};`,
    `fs.writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), dependency }));`,
    'process.exit(0);',
    '',
  ].join('\n')
);
fs.chmodSync(path.join(packageDir, 'probe.mjs'), 0o755);

{
  const globalconfig = '/etc/npmrc-moss-sentinel';
  const pinned = pinNpmUserConfig({
    npm_config_globalconfig: globalconfig,
    HOME: home,
  });
  assert.equal(pinned.npm_config_globalconfig, globalconfig);
  assert.equal(pinned.npm_config_userconfig, path.join(home, '.npmrc'));
}

const savedKeys = [
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
];
const saved = Object.fromEntries(savedKeys.map((key) => [key, process.env[key]]));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = evilTmp;
process.env.TMP = evilTmp;
process.env.TEMP = evilTmp;
delete process.env.npm_config_registry;
delete process.env.NPM_CONFIG_REGISTRY;
delete process.env.npm_config_userconfig;
delete process.env.NPM_CONFIG_USERCONFIG;

const previous = process.cwd();
process.chdir(ws);
const config = builtinRdkDocsServerConfig(await packFixture(packageDir));
config.env = {
  npm_config_fetch_retries: '0',
  npm_config_fetch_timeout: '5000',
  npm_config_audit: 'false',
};
assert.equal(config.args.includes('--registry'), false);
assert.ok(config.cwd);
assert.ok(config.cwd.startsWith(home + path.sep), config.cwd);
assert.ok(config.cwd.includes(`${path.sep}.moss${path.sep}cache${path.sep}npx${path.sep}`));
assert.equal(config.cwd.startsWith(ws + path.sep) || config.cwd === ws, false);
assert.equal(config.cwd.startsWith(evilTmp), false);
assert.equal(rdkDocsNpxCwd(), config.cwd);

async function connectAndClose(serverConfig) {
  const registry = McpToolRegistry.connectInBackground([serverConfig]);
  let timeout;
  try {
    await Promise.race([
      registry.waitForConnections(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`rdk connect timed out: ${JSON.stringify(hits)}`)),
          20000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await registry.closeAll();
  }
}
try {
  // An unclean loader using the project's .npmrc fails the same real npx install.
  await connectAndClose({
    ...config,
    cwd: ws,
    startupEnvOnly: false,
    env: { ...config.env, npm_config_userconfig: path.join(ws, '.npmrc') },
  });
  assert.equal(fs.existsSync(ran), false, 'unsafe project cwd must not start the package');
  assert.ok(
    hits.project.some((hit) => hit === `GET /${dependencyName}`),
    `negative fixture must contact the project registry: ${JSON.stringify(hits)}`
  );
  hits.project.length = 0;
  hits.user.length = 0;
  await connectAndClose(config);
} finally {
  process.chdir(previous);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all([
    new Promise((resolve) => userServer.close(resolve)),
    new Promise((resolve) => projectServer.close(resolve)),
  ]);
}

assert.equal(fs.existsSync(ran), true, 'rdk-docs npx did not start the package bin');
assert.equal(JSON.parse(fs.readFileSync(ran, 'utf8')).dependency, 'registry dependency installed');
assert.ok(hits.user.includes(`GET /${dependencyName}`), 'user ~/.npmrc registry was not contacted');
assert.ok(
  hits.user.includes(`GET /${dependencyName}/-/probe.tgz`),
  'dependency was not fetched from the user registry'
);
assert.deepEqual(
  hits.project,
  [],
  `project .npmrc registry was contacted: ${hits.project.join(', ')}`
);
console.log('[PASS] user registry honored and project .npmrc ignored');
