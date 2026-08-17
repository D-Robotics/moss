#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';
import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';
import { installConfiguredPlugins } from '../dist/cli/plugins-runtime.js';

const browserCandidates = [
  process.env.MOSS_BROWSER_EXECUTABLE,
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

test(
  'React workbench survives a complete browser message turn',
  { skip: browserExecutable ? false : 'no Chromium-compatible browser installed' },
  async () => {
    const agent = new MossAgent({
      llmProvider: {
        id: 'web-browser-test',
        displayName: 'Web browser test',
        capabilities: { streaming: false },
        async complete() {
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
      domainPrompt: false,
      includeLanguagePolicyPrompt: false,
      includeAgentBehaviorPrompt: false,
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
      "export default { mount(root) { root.textContent = 'BROWSER_PLUGIN_UI_OK'; return () => { globalThis.__MOSS_FIRST_PLUGIN_DISPOSED__ = true; }; } };\n"
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
    const browser = await puppeteer.launch({ executablePath: browserExecutable, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.goto(web.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('.app-frame', { timeout: 10_000 });
      const desktopColumns = await page.$$eval(
        '.sidebar, .conversation-column, .details-panel',
        (columns) => columns.map((column) => Math.round(column.getBoundingClientRect().width))
      );
      assert.deepEqual(
        desktopColumns,
        [252, 868, 320],
        'desktop keeps the stable three-column frame'
      );
      const screenshot = await page.screenshot({ type: 'png' });
      assert.ok(
        screenshot.byteLength > 20_000,
        'fixed viewport produces a non-empty visual sample'
      );
      await page.click('.sidebar-footer > button');
      await page.click('.settings-tabs button:last-child');
      await page.waitForFunction(
        `Array.from(document.querySelectorAll('[data-moss-slot="settings.plugin"] > div'))
          .map((node) => node.shadowRoot?.textContent)
          .includes('BROWSER_PLUGIN_UI_OK') &&
         Array.from(document.querySelectorAll('[data-moss-slot="settings.plugin"] > div'))
          .map((node) => node.shadowRoot?.textContent)
          .includes('BROWSER_PLUGIN_UI_TWO_OK')`,
        { timeout: 10_000 }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.click('.new-task');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await page.evaluate('globalThis.__MOSS_FIRST_PLUGIN_DISPOSED__'), true);
      await page.waitForSelector('textarea');
      await page.type('textarea', 'Complete the browser turn.');
      await page.keyboard.press('Enter');
      await page.waitForFunction('document.body.textContent.includes("BROWSER_TURN_OK")', {
        timeout: 10_000,
      });
      assert.equal(await page.$$eval('.message', (messages) => messages.length), 2);
      await page.setViewport({ width: 740, height: 900, deviceScaleFactor: 1 });
      assert.equal(
        await page.$eval('.sidebar', (sidebar) => globalThis.getComputedStyle(sidebar).display),
        'none'
      );
      assert.ok(
        (await page.$eval('.details-panel', (panel) => panel.getBoundingClientRect().width)) <= 330,
        'tablet details panel becomes a bounded drawer'
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      await browser.close();
      await web.close();
      await agent.close();
    }
  }
);
