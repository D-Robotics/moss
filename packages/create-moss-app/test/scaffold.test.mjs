import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const cli = path.join(packageRoot, 'index.mjs');
const EXPECTED_HELP = `
  create-moss-app <project-name> [--template <name>] [--skip-install]

  Templates:
    minimal   Minimal Moss agent with Anthropic API key support (default)
    openai    Agent with OpenAI-compatible provider
    plugin-tool OpenAI-compatible agent with a validated runtime tool plugin

  Examples:
    npx create-moss-app my-agent
    npx create-moss-app my-agent --template openai
    npx create-moss-app my-agent --template plugin-tool
    npx create-moss-app my-agent --skip-install
    npm create moss-app my-agent

`;

// The scaffold must write a PUBLISHED version range so the user's `npm install`
// resolves. mossVersionRange() queries npm for the latest published version
// (falling back to a hardcoded published range offline). The expected range is
// therefore the latest published version, NOT the local workspace version
// (which may be an unpublished RC — the bug this test guards against).
function latestPublishedVersion(packageName) {
  const result = spawnSync('npm', ['view', packageName, 'version'], {
    encoding: 'utf8',
    timeout: 10000,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return null;
  const v = result.stdout.trim();
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

const publishedAgent = latestPublishedVersion('@rdk-moss/agent');
const expectedMossDependencyRanges = {
  '@rdk-moss/agent': publishedAgent ? `^${publishedAgent}` : null,
};

test('prints usage', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), EXPECTED_HELP);
  assert.match(result.stdout, /create-moss-app <project-name>/);
  assert.match(result.stdout, /--skip-install/);
  assert.match(result.stdout, /Minimal Moss agent with Anthropic API key support/);
  assert.doesNotMatch(result.stdout, /D-Moss/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.description, /Moss agent project/);
  assert.doesNotMatch(packageJson.description, /D-Moss/);
});

test('published CLI manifest keeps its bin and file contract', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.bin, { 'create-moss-app': 'index.mjs' });
  assert.deepEqual(packageJson.files, ['index.mjs', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  assert.equal(
    packageJson.exports,
    undefined,
    'the JavaScript CLI is governed by its bin contract'
  );
});

test('scaffolds minimal project without installing dependencies', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-'));
  const result = spawnSync(process.execPath, [cli, 'demo-agent', '--skip-install'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'demo-agent');
  const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));

  assert.deepEqual(fs.readdirSync(target).sort(), [
    'README.md',
    'index.ts',
    'mcp.json.example',
    'package.json',
  ]);

  assert.equal(packageJson.name, 'demo-agent');
  // The scaffolded dep must be a PUBLISHED version range (so `npm install`
  // resolves). When online, that's the latest published version; when offline,
  // the hardcoded fallback. Never the local workspace version if unpublished.
  const agentDep = packageJson.dependencies['@rdk-moss/agent'];
  assert.deepEqual(
    Object.keys(packageJson.dependencies),
    ['@rdk-moss/agent'],
    'the scaffold relies on the agent package to select its compatible core dependency'
  );
  assert.match(agentDep, /^\^\d+\.\d+\.\d+/, '@rdk-moss/agent dep is a caret range');
  if (expectedMossDependencyRanges['@rdk-moss/agent']) {
    assert.equal(
      agentDep,
      expectedMossDependencyRanges['@rdk-moss/agent'],
      '@rdk-moss/agent dep matches the latest published version (online)'
    );
  }
  assert.equal(packageJson.scripts.typecheck.includes('tsc --noEmit'), true);
  assert.equal(fs.existsSync(path.join(target, 'index.ts')), true);
  assert.equal(fs.existsSync(path.join(target, 'mcp.json.example')), true);
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
  const source = fs.readFileSync(path.join(target, 'index.ts'), 'utf8');
  assert.match(source, /ANTHROPIC_API_KEY/);
  assert.match(source, /MOSS_API_KEY/);
  assert.match(source, /Promise\.allSettled\(mcpConnections\.map/);
  assert.match(source, /connection\.close\(\)/);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /A Moss agent project/);
  assert.match(readme, /Node\.js 22\.16 or newer/);
  assert.match(readme, /OpenSSH Client/);
  assert.match(readme, /Windows PowerShell/);
  assert.match(readme, /\$env:ANTHROPIC_API_KEY/);
  assert.match(readme, /Windows cmd\.exe/);
  assert.match(readme, /set ANTHROPIC_API_KEY=your-key && npm start/);
  assert.match(readme, /accepts `MOSS_API_KEY` as a compatibility fallback/);
  assert.match(readme, /Moss Documentation/);
  assert.doesNotMatch(readme, /D-Moss/);
  assert.match(readme, /Copy-Item mcp\.json\.example mcp\.json/);
  assert.match(readme, /copy mcp\.json\.example mcp\.json/);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('scaffolds openai template without installing dependencies', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-openai-'));
  const result = spawnSync(
    process.execPath,
    [cli, 'openai-agent', '--template', 'openai', '--skip-install'],
    {
      cwd,
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'openai-agent');
  const source = fs.readFileSync(path.join(target, 'index.ts'), 'utf8');
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /OpenAILLMProvider/);
  assert.match(source, /connectMcpServers/);
  assert.match(source, /Promise\.allSettled\(mcpConnections\.map/);
  assert.match(source, /connection\.close\(\)/);
  assert.equal(fs.existsSync(path.join(target, 'mcp.json.example')), true);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /OPENAI_API_KEY=your-key npm start/);
  assert.match(readme, /cp mcp\.json\.example mcp\.json/);
});

test('scaffolds a plugin tool with an executable validation contract', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-plugin-'));
  const result = spawnSync(
    process.execPath,
    [cli, 'plugin-agent', '--template', 'plugin-tool', '--skip-install'],
    { cwd, encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'plugin-agent');
  const source = fs.readFileSync(path.join(target, 'index.ts'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['validate-tool'], 'tsx index.ts');
  assert.match(source, /context\.registerTool/);
  assert.match(source, /sideEffectClass: 'readonly'/);
  assert.match(source, /runtime\.toolNames\.includes\('read_demo_clock'\)/);
  assert.match(source, /result\.toolCalls\.some/);
  assert.match(source, /CLOCK_FIXTURE=12:34/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]/);
});

test('rejects an unknown flag instead of silently ignoring it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-badflag-'));
  const result = spawnSync(process.execPath, [cli, 'demo-agent', '--skipinstall'], {
    cwd,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'unknown flag must exit non-zero');
  assert.match(result.stderr, /Unknown option: --skipinstall/);
  assert.equal(
    fs.existsSync(path.join(cwd, 'demo-agent')),
    false,
    'no project is scaffolded on a bad flag'
  );
});

test('--template requires a value', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-tmplval-'));
  const result = spawnSync(process.execPath, [cli, 'demo-agent', '--template'], {
    cwd,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--template requires a value/);
});

test('supports nested target paths and sanitizes package name from the leaf directory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-nested-'));
  const result = spawnSync(process.execPath, [cli, 'apps/My Agent', '--skip-install'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'apps', 'My Agent');
  const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'my-agent');
  assert.equal(fs.existsSync(path.join(cwd, 'My Agent')), false);
  assert.match(result.stdout, /cd "apps[\\/]+My Agent"/);
});

test('a prerelease create-app scaffolds its matching prerelease agent set', () => {
  const packageCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-next-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-moss-app-next-project-'));
  fs.copyFileSync(cli, path.join(packageCopy, 'index.mjs'));
  fs.writeFileSync(
    path.join(packageCopy, 'package.json'),
    JSON.stringify({ name: 'create-moss-app', version: '0.7.0-rc.1', type: 'module' })
  );
  const result = spawnSync(
    process.execPath,
    [path.join(packageCopy, 'index.mjs'), 'next-agent', '--skip-install'],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const generated = JSON.parse(
    fs.readFileSync(path.join(cwd, 'next-agent', 'package.json'), 'utf8')
  );
  assert.equal(generated.dependencies['@rdk-moss/agent'], '0.7.0-rc.1');
});
