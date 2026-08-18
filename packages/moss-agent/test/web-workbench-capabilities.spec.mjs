#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../src/web-ui/client');

test('workbench source keeps durable session and resumable stream contracts visible', async () => {
  const [api, preferences, workbench, urlState] = await Promise.all([
    fs.readFile(path.join(client, 'api-client.ts'), 'utf8'),
    fs.readFile(path.join(client, 'workbench-preferences.ts'), 'utf8'),
    fs.readFile(path.join(client, 'workbench.tsx'), 'utf8'),
    fs.readFile(path.join(client, 'workbench-url-state.ts'), 'utf8'),
  ]);
  assert.match(api, /EventSource/);
  assert.match(api, /after/);
  assert.match(api, /lastEventId/);
  assert.match(api, /\/api\/plugins\/events/);
  assert.match(api, /connectPluginComposition/);
  assert.match(preferences, /moss-workbench-v2/);
  assert.match(preferences, /draft/);
  assert.match(preferences, /scrollTop/);
  assert.match(workbench, /SessionSidebar/);
  for (const key of ['workspace', 'session', 'case', 'task', 'details', 'settings']) {
    assert.match(urlState, new RegExp(`['"]${key}['"]`));
  }
  assert.match(
    await fs.readFile(path.join(client, 'session-sidebar.tsx'), 'utf8'),
    /WorkspacePicker/
  );
});

test('plugin UI generations clear owned ShadowRoot content before remount', async () => {
  const source = await fs.readFile(path.join(client, 'plugin-slot.tsx'), 'utf8');
  assert.match(source, /mossPluginGeneration/);
  assert.match(source, /replaceChildren\(\)/);
  assert.match(source, /dispose/);
});

test('workbench exposes every planned control and settings surface', async () => {
  const files = await Promise.all(
    ['composer.tsx', 'session-sidebar.tsx', 'settings-center.tsx', 'details-panel.tsx'].map(
      (file) => fs.readFile(path.join(client, file), 'utf8')
    )
  );
  const source = files.join('\n');
  for (const label of [
    'plan',
    'acceptEdits',
    'queue',
    'steer',
    'General',
    'Models',
    'Permissions',
    'Skills',
    'MCP',
    'Plugins',
    'Runtime',
    'Trajectory',
    'Evidence',
    'Completion verdict',
  ]) {
    assert.ok(source.includes(label), `missing planned UI surface: ${label}`);
  }
});

test('delivery workbench renders the unified execution view with explicit async states', async () => {
  const [api, details, workbench, settings] = await Promise.all([
    fs.readFile(path.join(client, 'api-client.ts'), 'utf8'),
    fs.readFile(path.join(client, 'details-panel.tsx'), 'utf8'),
    fs.readFile(path.join(client, 'workbench.tsx'), 'utf8'),
    fs.readFile(path.join(client, 'settings-center.tsx'), 'utf8'),
  ]);
  assert.match(api, /\/api\/executions/);
  for (const label of [
    'Delivery Case',
    'Acceptance criteria',
    'Whole-change review',
    'Completion Report',
    'Retry loading',
  ]) {
    assert.ok(details.includes(label), `missing delivery surface: ${label}`);
  }
  assert.doesNotMatch(details, /JSON\.stringify\(task/);
  assert.doesNotMatch(`${workbench}\n${settings}`, /window\.(prompt|confirm)/);
  assert.match(`${workbench}\n${settings}`, /<Dialog/);
});

test('timeline includes rich tool renderers and complete stream states', async () => {
  const source = `${await fs.readFile(path.join(client, 'conversation-timeline.tsx'), 'utf8')}\n${await fs.readFile(path.join(client, 'workbench.tsx'), 'utf8')}`;
  for (const token of [
    'retry',
    'compaction',
    'usage',
    'context',
    'interrupted',
    'diff',
    'terminal',
    'read',
    'edit',
    'search',
    'web',
  ]) {
    assert.ok(source.toLowerCase().includes(token), `missing timeline capability: ${token}`);
  }
});

test('commands, attachments, CSRF and plugin lifecycle use real server contracts', async () => {
  const [api, composer, settings] = await Promise.all([
    fs.readFile(path.join(client, 'api-client.ts'), 'utf8'),
    fs.readFile(path.join(client, 'composer.tsx'), 'utf8'),
    fs.readFile(path.join(client, 'settings-center.tsx'), 'utf8'),
  ]);
  assert.match(api, /x-moss-csrf/);
  assert.match(api, /contentBase64/);
  assert.match(api, /attachmentIds/);
  assert.match(api, /workspaceRelativePath/);
  assert.match(composer, /if \(text\.startsWith\('\/'\)\) \{/);
  assert.match(composer, /onCommand\(text\)/);
  assert.doesNotMatch(composer, /text\.slice\(1\)/);
  for (const capability of ['addPlugin', 'doctorPlugins', 'pluginConfig', 'putPluginSecret']) {
    assert.ok(api.includes(capability), `missing plugin API: ${capability}`);
  }
  assert.match(
    settings,
    /Local path, exact npm package, official source, or compatible DSH package/
  );
  assert.match(settings, /Configured — write-only/);
});

test('plugins receive a self-contained controlled component browser entry', async () => {
  const source = await fs.readFile(path.join(client, 'moss-web-components.tsx'), 'utf8');
  assert.match(source, /mountMossWebComponent/);
  for (const component of ['Button', 'Input', 'Card', 'Menu', 'Modal']) {
    assert.ok(source.includes(component), `missing controlled component export: ${component}`);
  }
  const config = await fs.readFile(
    path.resolve(client, '../../../web-components-vite.config.mjs'),
    'utf8'
  );
  assert.match(config, /moss-web-components\.js/);
  assert.match(config, /emptyOutDir: false/);
});
