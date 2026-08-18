#!/usr/bin/env node
/* global document, getComputedStyle, HTMLElement */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AxeBuilder from '@axe-core/playwright';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { installConfiguredPlugins } from '../dist/cli/plugins-runtime.js';

const browserCandidates = [
  process.env.MOSS_BROWSER_EXECUTABLE,
  chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

let browserExecutable;
for (const candidate of browserCandidates) {
  try {
    await fs.access(candidate);
    browserExecutable = candidate;
    break;
  } catch {}
}

const visualRoot = path.join(import.meta.dirname, 'visual');

async function assertVisual(name, buffer) {
  const baselinePath = path.join(visualRoot, 'baseline', `${name}.png`);
  if (process.env.MOSS_UPDATE_VISUALS === '1') {
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, buffer);
    return;
  }
  const expected = PNG.sync.read(await fs.readFile(baselinePath));
  const actual = PNG.sync.read(buffer);
  assert.equal(actual.width, expected.width, `${name} visual width changed`);
  assert.equal(actual.height, expected.height, `${name} visual height changed`);
  const diff = new PNG({ width: actual.width, height: actual.height });
  const changed = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
    threshold: 0.18,
  });
  const ratio = changed / (actual.width * actual.height);
  if (ratio > 0.08) {
    const diffPath = path.join(visualRoot, 'diff', `${name}.png`);
    await fs.mkdir(path.dirname(diffPath), { recursive: true });
    await fs.writeFile(diffPath, PNG.sync.write(diff));
  }
  assert.ok(ratio <= 0.08, `${name} visual changed by ${(ratio * 100).toFixed(2)}%`);
}

async function waitForColumns(page, expected) {
  await page.waitForFunction((widths) => {
    const actual = Array.from(
      document.querySelectorAll(
        '.moss-sidebar-column, .moss-conversation-column, .moss-details-column'
      ),
      (column) => Math.round(column.getBoundingClientRect().width)
    );
    return actual.every((width, index) => width === widths[index]);
  }, expected);
}

test(
  'Playwright workbench survives a complete browser message turn',
  {
    skip: browserExecutable ? false : 'no Chromium-compatible browser installed',
    timeout: 120_000,
  },
  async () => {
    const agent = new MossAgent({
      llmProvider: {
        id: 'web-browser-test',
        displayName: 'Web browser test',
        capabilities: { streaming: false },
        async complete(options) {
          const transcript = JSON.stringify(options.messages);
          const activeScenario = [
            ['tool', transcript.lastIndexOf('Run a browser tool.')],
            ['approval', transcript.lastIndexOf('Require browser approval.')],
            ['question', transcript.lastIndexOf('Ask a browser question.')],
          ]
            .filter(([, index]) => index >= 0)
            .sort((left, right) => right[1] - left[1])[0]?.[0];
          if (activeScenario === 'tool') {
            if (!transcript.includes('BROWSER_TOOL_OK')) {
              return {
                stopReason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'browser-tool', name: 'browser_delayed_tool', input: {} },
                ],
              };
            }
            return {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'BROWSER_TOOL_COMPLETE' }],
            };
          }
          if (activeScenario === 'approval') {
            if (!transcript.includes('APPROVAL_BROWSER_OK')) {
              return {
                stopReason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'browser-approval', name: 'browser_mutation', input: {} },
                ],
              };
            }
            return {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'APPROVAL_FLOW_COMPLETE' }],
            };
          }
          if (activeScenario === 'question') {
            if (!transcript.includes('QUESTION_BROWSER_OK:green')) {
              return {
                stopReason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'browser-question', name: 'browser_question', input: {} },
                ],
              };
            }
            return {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'QUESTION_FLOW_COMPLETE' }],
            };
          }
          return {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'BROWSER_TURN_OK' }],
          };
        },
        async stream() {
          throw new Error('streaming disabled');
        },
      },
      sessionStore: new InMemorySessionStore(),
      hooks: { onBeforeToolExec: createCliToolApprovalHook('workspace-write', {}) },
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
    });
    agent.tools.register({
      name: 'browser_delayed_tool',
      description: 'Return delayed browser fixture evidence.',
      metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return 'BROWSER_TOOL_OK';
      },
    });
    agent.tools.register({
      name: 'browser_mutation',
      description: 'Exercise the Web approval takeover.',
      metadata: { sideEffectClass: 'local_write', planMode: 'deny' },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return 'APPROVAL_BROWSER_OK';
      },
    });
    agent.tools.register({
      name: 'browser_question',
      description: 'Exercise the Web question takeover.',
      metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
      inputSchema: { type: 'object', properties: {} },
      async execute(_input, context) {
        const answer = await context.askUserQuestion?.('Which fixture color should Moss use?');
        return `QUESTION_BROWSER_OK:${answer ?? 'missing'}`;
      },
    });
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-browser-plugin-'));
    const pluginDir = path.join(configDir, 'browser-plugin');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'moss.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'browser/fixture',
        version: '1.0.0',
        runtime: { module: './plugin.mjs' },
        web: {
          contributions: [
            { id: 'shared-settings', slot: 'settings.plugin', module: './settings.js' },
          ],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, 'plugin.mjs'),
      "export default { id: 'browser/fixture', setup() {} };\n"
    );
    await fs.writeFile(
      path.join(pluginDir, 'settings.js'),
      "export default { async mount(root, context) { const ui = await import(context.componentsUrl); const dispose = ui.mountMossWebComponent(root, ui.createElement(ui.Card, null, ui.createElement('strong', null, 'BROWSER_PLUGIN_UI_OK'), ui.createElement(ui.Input, { label: 'Plugin setting', value: '', readOnly: true }), ui.createElement(ui.Button, null, 'Plugin action'))); return () => { dispose(); globalThis.__MOSS_FIRST_PLUGIN_DISPOSED__ = true; }; } };\n"
    );
    const pluginRegistry = new InstalledPluginRegistry({ configDir });
    await pluginRegistry.add(pluginDir);
    await pluginRegistry.enable('browser/fixture');
    const secondPluginDir = path.join(configDir, 'browser-plugin-two');
    await fs.mkdir(secondPluginDir, { recursive: true });
    await fs.writeFile(
      path.join(secondPluginDir, 'moss.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'browser/fixture-two',
        version: '1.0.0',
        runtime: { module: './plugin.mjs' },
        web: {
          contributions: [
            { id: 'shared-settings', slot: 'settings.plugin', module: './settings.js' },
          ],
        },
      })
    );
    await fs.writeFile(
      path.join(secondPluginDir, 'plugin.mjs'),
      "export default { id: 'browser/fixture-two', setup() {} };\n"
    );
    await fs.writeFile(
      path.join(secondPluginDir, 'settings.js'),
      "export default { async mount(root) { root.textContent = 'BROWSER_PLUGIN_UI_TWO_OK'; await new Promise((resolve) => setTimeout(resolve, 250)); return () => { throw new Error('EXPECTED_DISPOSER_FAILURE'); }; } };\n"
    );
    await pluginRegistry.add(secondPluginDir);
    await pluginRegistry.enable('browser/fixture-two');
    await installConfiguredPlugins(agent, configDir);
    const web = await startMossWebServer(agent, { port: 0, configDir });
    let browser;
    let browserContext;
    try {
      browser = await chromium.launch({
        executablePath: browserExecutable,
        headless: true,
        args: process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      });
      browserContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      const page = await browserContext.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(web.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('.app-frame', { timeout: 10_000 });
      await page.waitForFunction(
        'document.querySelector(".workbench-state[aria-busy=true]") === null',
        undefined,
        { timeout: 10_000 }
      );
      await waitForColumns(page, [252, 868, 320]);
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(() => globalThis.document.activeElement?.className),
        'moss-skip-link',
        'keyboard users reach the skip link first'
      );
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      const accessibility = await new AxeBuilder({ page }).analyze();
      assert.deepEqual(
        accessibility.violations.filter(
          ({ impact }) => impact === 'critical' || impact === 'serious'
        ),
        [],
        'workbench has no serious accessibility violations'
      );
      await assertVisual('desktop-home', await page.screenshot({ type: 'png' }));
      await page.setViewportSize({ width: 1120, height: 800 });
      await waitForColumns(page, [252, 560, 308]);
      await assertVisual('narrow-home', await page.screenshot({ type: 'png' }));
      await page.setViewportSize({ width: 820, height: 1180 });
      await waitForColumns(page, [64, 756, 0]);
      await assertVisual('tablet-home', await page.screenshot({ type: 'png' }));
      await page.setViewportSize({ width: 1440, height: 960 });
      await waitForColumns(page, [252, 868, 320]);
      assert.equal(
        await page.$eval('.moss-skip-link', (link) => link.getAttribute('href')),
        '#moss-main-content'
      );
      const desktopColumns = await page.$$eval(
        '.moss-sidebar-column, .moss-conversation-column, .moss-details-column',
        (columns) => columns.map((column) => Math.round(column.getBoundingClientRect().width))
      );
      assert.deepEqual(
        desktopColumns,
        [252, 868, 320],
        'desktop keeps the stable three-column frame'
      );
      assert.equal(await page.$$eval('[data-resize-handle]', (handles) => handles.length), 2);
      const sidebarHandle = await page.$('[data-resize-handle="sidebar"]');
      const sidebarHandleBox = await sidebarHandle.boundingBox();
      assert.ok(sidebarHandleBox);
      await page.mouse.move(sidebarHandleBox.x + sidebarHandleBox.width / 2, 200);
      await page.mouse.down();
      await page.mouse.move(sidebarHandleBox.x + 38, 200, { steps: 4 });
      await page.mouse.up();
      const resizedSidebar = await page.$eval('.moss-sidebar-column', (sidebar) =>
        Math.round(sidebar.getBoundingClientRect().width)
      );
      assert.ok(resizedSidebar > 252, 'sidebar drag increases the live column width');
      assert.match(
        await page.evaluate(() => localStorage.getItem('moss-layout-v1') ?? ''),
        /sidebarWidth/,
        'layout preference is durable'
      );
      await page.click('[aria-label="Toggle navigation panel"]');
      await page.waitForFunction(
        () =>
          Math.round(
            document.querySelector('.moss-sidebar-column').getBoundingClientRect().width
          ) === 64
      );
      assert.equal(
        await page.$eval('.moss-sidebar-column', (sidebar) =>
          Math.round(sidebar.getBoundingClientRect().width)
        ),
        64,
        'sidebar toggle keeps a compact mounted rail'
      );
      await page.click('[aria-label="Toggle navigation panel"]');
      await page.waitForFunction(
        (expected) =>
          Math.round(
            globalThis.document.querySelector('.moss-sidebar-column').getBoundingClientRect().width
          ) === expected,
        resizedSidebar
      );
      assert.equal(
        await page.$eval('.moss-sidebar-column', (sidebar) =>
          Math.round(sidebar.getBoundingClientRect().width)
        ),
        resizedSidebar,
        'expanding restores the persisted width'
      );
      const screenshot = await page.screenshot({ type: 'png' });
      assert.ok(
        screenshot.byteLength > 20_000,
        'fixed viewport produces a non-empty visual sample'
      );
      await page.click('.sidebar-footer > button');
      assert.equal(
        await page.$$eval('.settings-view > .moss-tabs button', (tabs) => tabs.length),
        7
      );
      for (const section of [
        'General',
        'Models',
        'Permissions',
        'Skills',
        'MCP',
        'Plugins',
        'Runtime',
      ]) {
        await page.getByRole('tab', { name: section }).click();
        await page.waitForFunction(
          (title) => document.querySelector('.settings-section > h3')?.textContent === title,
          section
        );
      }
      await page.getByRole('tab', { name: 'General' }).click();
      await assertVisual('desktop-settings', await page.screenshot({ type: 'png' }));
      await page.getByRole('tab', { name: 'Plugins' }).click();
      await page.waitForFunction(
        () => {
          const content = Array.from(
            document.querySelectorAll('[data-moss-slot="settings.plugin"] > div'),
            (node) => node.shadowRoot?.textContent ?? ''
          );
          return (
            content.some((text) => text.includes('BROWSER_PLUGIN_UI_OK')) &&
            content.some((text) => text.includes('BROWSER_PLUGIN_UI_TWO_OK'))
          );
        },
        undefined,
        { timeout: 10_000 }
      );
      const pluginSlotState = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('[data-moss-slot="settings.plugin"] > div'),
          (node) => ({
            generation: node.getAttribute('data-moss-plugin-generation'),
            text: node.shadowRoot?.textContent ?? '',
          })
        )
      );
      assert.equal(
        pluginSlotState.length,
        2,
        `each plugin owns a distinct slot host; page errors: ${pageErrors.join(' | ')}`
      );
      await assertVisual('desktop-plugins', await page.screenshot({ type: 'png' }));
      await page.getByRole('button', { name: /Run doctor/ }).click();
      await page.waitForFunction(() => document.body.textContent.includes('Doctor · generation'));
      await page.click('.new-task');
      await page.waitForSelector('.composer-shell textarea');
      await page.waitForFunction(() => globalThis.__MOSS_FIRST_PLUGIN_DISPOSED__ === true);
      assert.equal(await page.evaluate(() => globalThis.__MOSS_FIRST_PLUGIN_DISPOSED__), true);
      const notePath = path.join(configDir, 'browser-note.txt');
      await fs.writeFile(notePath, 'ATTACHMENT_BROWSER_OK');
      await page.locator('input[type="file"]').setInputFiles(notePath);
      await page.waitForFunction(() => document.body.textContent.includes('ready'));
      await page.type('textarea', 'Complete the browser turn.');
      assert.match(
        await page.evaluate(() => localStorage.getItem('moss-workbench-v2') ?? ''),
        /Complete the browser turn/
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.body.textContent.includes('BROWSER_TURN_OK'),
        undefined,
        { timeout: 10_000 }
      );
      assert.equal(await page.inputValue('textarea'), '', 'send clears the active session draft');
      assert.equal(await page.$$eval('.message', (messages) => messages.length), 2);
      await page.getByRole('tab', { name: 'Plan' }).click();
      await assertVisual('desktop-plan', await page.screenshot({ type: 'png' }));
      await page.type('textarea', 'Run a browser tool.');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.textContent.includes('Moss is working'));
      await assertVisual('desktop-running', await page.screenshot({ type: 'png' }));
      await page.waitForFunction(
        () =>
          document.querySelector('.tool-row.tool-running') !== null ||
          document.querySelector('.tool-row.tool-complete') !== null
      );
      await page.waitForSelector('.tool-row.tool-complete', { timeout: 10_000 });
      assert.equal(
        await page.inputValue('textarea'),
        '',
        'tool turns do not restore a stale draft'
      );
      await page.click('.tool-row.tool-complete');
      await page.waitForFunction(() => document.body.textContent.includes('BROWSER_TOOL_OK'));
      await page.waitForFunction(() => document.body.textContent.includes('BROWSER_TOOL_COMPLETE'));
      await assertVisual('desktop-tool', await page.screenshot({ type: 'png' }));
      await page.type('textarea', 'Require browser approval.');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="alertdialog"][aria-label="Approval required"]');
      await assertVisual('desktop-approval', await page.screenshot({ type: 'png' }));
      await page.getByRole('button', { name: 'Allow once' }).click();
      await page.waitForFunction(() =>
        document.body.textContent.includes('APPROVAL_FLOW_COMPLETE')
      );
      await page.type('textarea', 'Ask a browser question.');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="alertdialog"][aria-label="Moss has a question"]');
      await page.getByRole('textbox', { name: 'Answer' }).fill('green');
      await page.getByRole('button', { name: 'Answer' }).click();
      await page.waitForFunction(() =>
        document.body.textContent.includes('QUESTION_FLOW_COMPLETE')
      );
      await page.click('.new-task');
      await page.waitForSelector('.composer-shell textarea');
      await page.fill(
        '.composer-shell textarea',
        'Add plugin permission preview and a security gate across Web and CLI'
      );
      await page.waitForSelector('.send-button:not([disabled])');
      await page.press('.composer-shell textarea', 'Enter');
      await page.waitForFunction(
        () => document.body.textContent.includes('paused for structured clarification'),
        undefined,
        { timeout: 60_000 }
      );
      await page.getByRole('tab', { name: 'Plan' }).click();
      await page
        .getByLabel('What observable outcome must be true before this delivery is accepted?')
        .fill('The permission source and enforced safety gate are visible.');
      await page
        .getByLabel('Which modules or paths may be changed, and what must remain unchanged?')
        .fill('Web and CLI only; preserve plugin compatibility.');
      await page.getByLabel(/Confirm the detected delivery risk/).fill('Confirm');
      await page.getByRole('button', { name: 'Submit clarification' }).click();
      await page.getByRole('button', { name: 'Approve Proposal' }).waitFor();
      await page.getByRole('button', { name: 'Approve Proposal' }).click();
      await page.getByRole('button', { name: 'Start approved execution' }).click();
      await page.waitForFunction(() => document.body.textContent.includes('BROWSER_TURN_OK'));
      await page.setViewportSize({ width: 980, height: 900 });
      await page.waitForFunction(
        () =>
          Math.round(
            document.querySelector('.moss-sidebar-column').getBoundingClientRect().width
          ) === 64
      );
      await page.click('[aria-label="Toggle navigation panel"]');
      await page.waitForFunction(
        (expected) =>
          Math.round(
            globalThis.document.querySelector('.moss-sidebar-column').getBoundingClientRect().width
          ) === expected &&
          Math.round(
            globalThis.document.querySelector('.moss-details-column').getBoundingClientRect().width
          ) === 0,
        resizedSidebar
      );
      assert.equal(
        await page.$eval('.moss-sidebar-column', (sidebar) =>
          Math.round(sidebar.getBoundingClientRect().width)
        ),
        resizedSidebar,
        'narrow desktop allows an explicit sidebar expansion'
      );
      assert.equal(
        await page.$eval('.moss-details-column', (details) =>
          Math.round(details.getBoundingClientRect().width)
        ),
        0,
        'details concedes before the center column when the narrow sidebar expands'
      );
      await page.click('[aria-label="Toggle navigation panel"]');
      await page.waitForFunction(
        () =>
          Math.round(
            document.querySelector('.moss-sidebar-column').getBoundingClientRect().width
          ) === 64
      );
      await assertVisual('narrow-conversation', await page.screenshot({ type: 'png' }));
      await page.setViewportSize({ width: 740, height: 900 });
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-mobile-drawer="sidebar"]')).visibility ===
          'hidden'
      );
      assert.equal(
        await page.$eval(
          '[data-mobile-drawer="sidebar"]',
          (sidebar) => globalThis.getComputedStyle(sidebar).visibility
        ),
        'hidden'
      );
      await page.click('[aria-label="Toggle navigation panel"]');
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-mobile-drawer="sidebar"]')).visibility ===
          'visible'
      );
      assert.equal(
        await page.$eval(
          '[data-mobile-drawer="sidebar"]',
          (sidebar) => globalThis.getComputedStyle(sidebar).visibility
        ),
        'visible',
        'mobile navigation opens as a drawer'
      );
      await page.click('.moss-drawer-backdrop');
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-mobile-drawer="sidebar"]')).visibility ===
          'hidden'
      );
      await page.click('[aria-label="Toggle details panel"]');
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('[data-mobile-drawer="details"]')).visibility ===
          'visible'
      );
      assert.equal(
        await page.$eval(
          '[data-mobile-drawer="details"]',
          (details) => globalThis.getComputedStyle(details).visibility
        ),
        'visible',
        'mobile details opens independently as a drawer'
      );
      assert.ok(
        (await page.$eval(
          '[data-mobile-drawer="details"]',
          (panel) => panel.getBoundingClientRect().width
        )) <= 330,
        'tablet details panel becomes a bounded drawer'
      );
      await page.goto(`${web.url}/#gallery`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForSelector('[data-moss-component-gallery]');
      for (const primitive of [
        'button',
        'input',
        'tabs',
        'toast',
        'tooltip',
        'card',
        'disclosure',
        'code',
        'diff',
        'terminal',
        'menu',
      ]) {
        assert.ok(await page.$(`[data-moss-ui="${primitive}"]`), `gallery renders ${primitive}`);
      }
      await page.click('[data-gallery-action="dialog"]');
      await page.waitForSelector('[data-moss-ui="dialog"] [role="dialog"]');
      await assertVisual('tablet-gallery-dialog', await page.screenshot({ type: 'png' }));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[data-moss-ui="dialog"]') === null);
      await assertVisual('tablet-gallery', await page.screenshot({ type: 'png' }));
      assert.deepEqual(pageErrors, []);
    } finally {
      if (browserContext) await browserContext.close();
      if (browser) await browser.close();
      await web.close();
      await agent.close();
    }
  }
);
