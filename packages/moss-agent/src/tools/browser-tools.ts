import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { isPrivateHost } from './web-fetch.js';
import { errorMessage } from '../errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_ARTIFACT_DIR = '.moss/browser-artifacts';
const BROWSER_ENV_VARS = [
  'MOSS_BROWSER_EXECUTABLE',
  'MOSS_CHROMIUM_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
];

type BrowserHandle = any;
type BrowserPage = any;
type BrowserRequest = any;
type BrowserStepAction = 'goto' | 'click' | 'fill' | 'press' | 'wait' | 'screenshot' | 'text';

interface BrowserStepInput {
  action?: BrowserStepAction;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  path?: string;
  waitMs?: number;
  timeoutMs?: number;
  fullPage?: boolean;
}

interface BrowserFetchInput {
  url: string;
  timeoutMs?: number;
  extraWaitMs?: number;
  maxTextChars?: number;
}

interface BrowserControlInput extends BrowserStepInput {
  steps?: BrowserStepInput[];
  extraWaitMs?: number;
}

export interface BrowserToolOptions {
  executablePath?: string;
  timeoutMs?: number;
  maxTextChars?: number;
  artifactDir?: string;
  blockPrivateNetwork?: boolean;
  userAgent?: string;
  headless?: boolean;
  userDataDir?: string;
}

export interface BrowserSearchPageResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  sourceName?: string;
}

export interface BrowserSearchPageSnapshot {
  finalUrl: string;
  text: string;
  results: BrowserSearchPageResult[];
}

interface BrowserLaunchConfig {
  executablePath: string;
  source: string;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cachedBrowserCandidates(): Promise<string[]> {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    path.join(os.homedir(), '.agent-browser/browsers'),
  ].filter((root): root is string => Boolean(root && root !== '0'));
  const candidates: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      if (!entry.startsWith('chromium-') && !entry.startsWith('chrome-')) continue;
      const base = path.join(root, entry);
      candidates.push(
        path.join(base, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(
          base,
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        ),
        path.join(base, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        path.join(base, 'chrome-linux/chrome'),
        path.join(base, 'chrome-linux64/chrome'),
        path.join(base, 'chrome-win/chrome.exe')
      );
    }
  }
  return candidates;
}

async function resolveBrowser(
  opts: BrowserToolOptions,
  toolName: string
): Promise<BrowserLaunchConfig | string> {
  if (opts.executablePath) {
    return (await exists(opts.executablePath))
      ? { executablePath: opts.executablePath, source: 'BrowserToolOptions.executablePath' }
      : `${toolName} 未执行: BrowserToolOptions.executablePath 不存在: ${opts.executablePath}`;
  }
  for (const envName of BROWSER_ENV_VARS) {
    const value = process.env[envName];
    if (!value) continue;
    return (await exists(value))
      ? { executablePath: value, source: envName }
      : `${toolName} 未执行: ${envName} 指向的浏览器不存在: ${value}`;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    ...(await cachedBrowserCandidates()),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { executablePath: candidate, source: 'auto-discovery' };
  }
  return (
    `${toolName} 未执行: 浏览器不存在。检查了以下路径:\n` +
    '  macOS:\n' +
    '    /Applications/Google Chrome.app\n' +
    '    /Applications/Chromium.app\n' +
    '    /Applications/Microsoft Edge.app\n' +
    '  Linux:\n' +
    '    /usr/bin/chromium-browser\n' +
    '    /usr/bin/chromium\n' +
    '    /usr/bin/google-chrome\n' +
    '    /usr/bin/google-chrome-stable\n' +
    '\n解决方案:\n' +
    '  1. 安装浏览器: 访问 https://google.com/chrome\n' +
    '  2. 或设置 MOSS_BROWSER_EXECUTABLE=/path/to/chrome (例如 /usr/bin/google-chrome)\n' +
    '  3. 或使用 Playwright 缓存路径: ~/.cache/ms-playwright/ 或 ~/Library/Caches/ms-playwright/\n' +
    '\n注意: puppeteer-core 不会自动下载浏览器。'
  );
}

async function validateUrl(
  rawUrl: unknown,
  toolName: string,
  blockPrivateNetwork: boolean
): Promise<URL | string> {
  const raw = asString(rawUrl).trim();
  if (!raw) return `${toolName} 未执行: url is required.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${toolName} 未执行: invalid URL: ${raw}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `${toolName} 未执行: unsupported protocol ${url.protocol}; only http(s) URLs are allowed.`;
  }
  if (blockPrivateNetwork && (await isPrivateHost(url.hostname))) {
    return `${toolName} 未执行: 拒绝连接到私网或本地主机 "${url.hostname}"。出于安全考虑，默认阻止本地网络访问。\n要启用本地开发:\n  • 选项 1: 在工具配置中设置 blockPrivateNetwork: false\n  • 选项 2: 设置环境变量 MOSS_ALLOW_PRIVATE_NETWORK=1\n  • 选项 3: 使用公网隧道 (ngrok, expose, etc.) 来测试本地服务。`;
  }
  return url;
}

async function installRequestGuard(page: BrowserPage, blockPrivateNetwork: boolean): Promise<void> {
  await page.setRequestInterception(true);
  page.on('request', (request: BrowserRequest) => {
    void (async () => {
      if (request.isInterceptResolutionHandled?.()) return;
      try {
        const reqUrl = new URL(request.url());
        if (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') {
          await request.abort();
          return;
        }
        if (blockPrivateNetwork && (await isPrivateHost(reqUrl.hostname))) {
          await request.abort();
          return;
        }
        await request.continue();
      } catch {
        try {
          await request.abort();
        } catch {}
      }
    })();
  });
}

async function withBrowser<T>(
  toolName: string,
  opts: BrowserToolOptions,
  run: (browser: BrowserHandle, config: BrowserLaunchConfig) => Promise<T>
): Promise<T | string> {
  const config = await resolveBrowser(opts, toolName);
  if (typeof config === 'string') return config;
  let browser: BrowserHandle | undefined;
  try {
    const puppeteer = await import('puppeteer-core');
    const args = ['--disable-dev-shm-usage'];
    if (process.getuid?.() === 0) args.push('--no-sandbox', '--disable-setuid-sandbox');
    browser = await puppeteer.launch({
      executablePath: config.executablePath,
      headless: opts.headless ?? true,
      userDataDir: opts.userDataDir,
      args,
    });
    return await run(browser, config);
  } catch (err) {
    return `${toolName} 未执行: ${errorMessage(err)}`;
  } finally {
    try {
      if (browser) {
        const closePromise = browser.close();
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        });
        await Promise.race([closePromise, timeoutPromise]);
      }
    } catch {}
  }
}

export async function browseSearchPage(
  url: string,
  opts: BrowserToolOptions = {}
): Promise<BrowserSearchPageSnapshot | null> {
  const result = await withBrowser('web_search browser fallback', opts, async (browser) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const page = await newPage(browser, opts, timeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page
      .waitForSelector('li.b_algo, #b_results, main', { timeout: Math.min(timeoutMs, 8_000) })
      .catch(() => undefined);
    const snapshot = await page.evaluate(() => {
      const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const results =
        location.hostname === 'news.google.com'
          ? Array.from(document.querySelectorAll<HTMLAnchorElement>('a.JtKRv')).map((anchor) => {
              const container =
                anchor.closest('c-wiz') ?? anchor.parentElement?.parentElement?.parentElement;
              const time = container?.querySelector<HTMLTimeElement>('time');
              const aria = clean(anchor.getAttribute('aria-label'));
              const title = clean(anchor.textContent);
              const suffix = aria.startsWith(title)
                ? aria.slice(title.length).replace(/^\s*-\s*/, '')
                : '';
              const sourceName = suffix.split(/\s+-\s+/)[0]?.trim();
              return {
                title,
                url: anchor.href,
                snippet: clean(container?.textContent),
                ...(time?.dateTime ? { date: time.dateTime } : {}),
                ...(sourceName ? { sourceName } : {}),
              };
            })
          : Array.from(document.querySelectorAll('li.b_algo')).map((row) => {
              const anchor = row.querySelector<HTMLAnchorElement>('h2 a');
              const snippetNode = row.querySelector<HTMLElement>('.b_caption p, .b_snippet, p');
              const text = clean(row.textContent);
              const date = text.match(
                /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}\s+hours?\s+ago|\d{1,2}\s+days?\s+ago)/i
              )?.[0];
              return {
                title: clean(anchor?.textContent),
                url: anchor?.href ?? '',
                snippet: clean(snippetNode?.textContent),
                ...(date ? { date } : {}),
              };
            });
      return {
        finalUrl: location.href,
        text: clean(document.body?.innerText).slice(0, 20_000),
        results: results.filter((row) => row.title && /^https?:\/\//i.test(row.url)),
      };
    });
    return snapshot as BrowserSearchPageSnapshot;
  });
  return typeof result === 'string' ? null : result;
}

export async function browseSearchPages(
  urls: string[],
  opts: BrowserToolOptions = {}
): Promise<BrowserSearchPageSnapshot[]> {
  const result = await withBrowser('web_search browser fallback', opts, async (browser) => {
    return Promise.all(
      urls.map(async (url) => {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const page = await newPage(browser, opts, timeoutMs);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          await page
            .waitForSelector('a.JtKRv, li.b_algo, .res-list, #b_results, main', {
              timeout: Math.min(timeoutMs, 8_000),
            })
            .catch(() => undefined);
          return (await page.evaluate(() => {
            const clean = (value: string | null | undefined) =>
              (value ?? '').replace(/\s+/g, ' ').trim();
            const results =
              location.hostname === 'news.google.com'
                ? Array.from(document.querySelectorAll<HTMLAnchorElement>('a.JtKRv')).map(
                    (anchor) => {
                      const container =
                        anchor.closest('c-wiz') ??
                        anchor.parentElement?.parentElement?.parentElement;
                      const time = container?.querySelector<HTMLTimeElement>('time');
                      const aria = clean(anchor.getAttribute('aria-label'));
                      const title = clean(anchor.textContent);
                      const suffix = aria.startsWith(title)
                        ? aria.slice(title.length).replace(/^\s*-\s*/, '')
                        : '';
                      const sourceName = suffix.split(/\s+-\s+/)[0]?.trim();
                      return {
                        title,
                        url: anchor.href,
                        snippet: clean(container?.textContent),
                        ...(time?.dateTime ? { date: time.dateTime } : {}),
                        ...(sourceName ? { sourceName } : {}),
                      };
                    }
                  )
                : location.hostname === 'www.so.com'
                  ? Array.from(document.querySelectorAll('.res-list')).map((row) => {
                      const anchor = row.querySelector<HTMLAnchorElement>('h3 a');
                      const directUrl = anchor?.getAttribute('data-mdurl') || anchor?.href || '';
                      const snippetNode = row.querySelector<HTMLElement>(
                        '.res-desc, .res-list-summary, .so-rich-news'
                      );
                      const text = clean(row.textContent);
                      const date = text.match(
                        /(?:20\d{2}年\d{1,2}月\d{1,2}日|\d{1,2}\s*小时前|\d{1,2}\s*天前)/
                      )?.[0];
                      let sourceName = '';
                      try {
                        sourceName = new URL(directUrl).hostname.replace(/^www\./, '');
                      } catch {
                        sourceName = '';
                      }
                      return {
                        title: clean(anchor?.textContent),
                        url: directUrl,
                        snippet: clean(snippetNode?.textContent),
                        ...(date ? { date } : {}),
                        ...(sourceName ? { sourceName } : {}),
                      };
                    })
                  : Array.from(document.querySelectorAll('li.b_algo')).map((row) => {
                      const anchor = row.querySelector<HTMLAnchorElement>('h2 a');
                      const snippetNode = row.querySelector<HTMLElement>(
                        '.b_caption p, .b_snippet, p'
                      );
                      const text = clean(row.textContent);
                      const date = text.match(
                        /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}\s+hours?\s+ago|\d{1,2}\s+days?\s+ago)/i
                      )?.[0];
                      return {
                        title: clean(anchor?.textContent),
                        url: anchor?.href ?? '',
                        snippet: clean(snippetNode?.textContent),
                        ...(date ? { date } : {}),
                      };
                    });
            return {
              finalUrl: location.href,
              text: clean(document.body?.innerText).slice(0, 20_000),
              results: results.filter((row) => row.title && /^https?:\/\//i.test(row.url)),
            };
          })) as BrowserSearchPageSnapshot;
        } finally {
          await page.close().catch(() => undefined);
        }
      })
    );
  });
  return typeof result === 'string' ? [] : result;
}

async function newPage(
  browser: BrowserHandle,
  opts: BrowserToolOptions,
  timeoutMs: number
): Promise<BrowserPage> {
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  if (opts.userAgent) await page.setUserAgent(opts.userAgent);
  await installRequestGuard(page, opts.blockPrivateNetwork !== false);
  return page;
}

function trimText(text: string, maxChars: number): string {
  const normalized = text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n\n... (truncated, original length ${normalized.length} chars)`;
}

function readInnerText(): string {
  const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
  return doc?.body?.innerText ?? '';
}

export function createBrowserFetchTool(opts: BrowserToolOptions = {}): Tool<BrowserFetchInput> {
  return {
    name: 'web_browser_fetch',
    description:
      'Open an http(s) URL in a real headless Chrome/Chromium browser, execute JavaScript, and return visible text (truncated to maxTextChars, default 20,000). Handles dynamic content and SPAs. Use this for single-page requests; use web_browser_control for multi-step workflows.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      permissionBoundary:
        'Runs a local headless browser for outbound HTTP(S); private, loopback, and link-local targets are blocked by default.',
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to render.' },
        timeoutMs: { type: 'number', description: 'Navigation timeout in milliseconds.' },
        extraWaitMs: { type: 'number', description: 'Optional extra wait after DOMContentLoaded.' },
        maxTextChars: { type: 'number', description: 'Maximum returned visible text characters.' },
      },
      required: ['url'],
    },
    async execute(input, _ctx) {
      const timeoutMs = asNumber(
        input?.timeoutMs,
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        1_000,
        120_000
      );
      const maxTextChars = asNumber(
        input?.maxTextChars,
        opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
        512,
        100_000
      );
      const checkedUrl = await validateUrl(
        input?.url,
        'web_browser_fetch',
        opts.blockPrivateNetwork !== false
      );
      if (typeof checkedUrl === 'string') return checkedUrl;
      return withBrowser('web_browser_fetch', opts, async (browser, config) => {
        const page = await newPage(browser, opts, timeoutMs);
        await page.goto(checkedUrl.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        const extraWaitMs = asNumber(input?.extraWaitMs, 250, 0, 30_000);
        if (extraWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, extraWaitMs));
        const title = await page.title();
        const text = await page.evaluate(readInnerText);
        return [
          'web_browser_fetch_ok',
          `url: ${checkedUrl.toString()}`,
          `title: ${title || '(untitled)'}`,
          `browser: ${config.source}`,
          '',
          trimText(text, maxTextChars),
        ].join('\n');
      }) as Promise<string>;
    },
  };
}

async function saveScreenshot(
  page: BrowserPage,
  inputPath: string | undefined,
  ctx: ToolContext,
  opts: BrowserToolOptions,
  fullPage: boolean
): Promise<string> {
  const relPath =
    inputPath && inputPath.trim()
      ? inputPath
      : path.join(opts.artifactDir ?? DEFAULT_ARTIFACT_DIR, `browser-${Date.now()}.png`);
  const { resolved } = await assertSandboxPath({
    filePath: relPath,
    cwd: ctx.workspaceDir,
    root: ctx.workspaceDir,
    extraRoots: ctx.extraAllowedRoots,
  });
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await page.screenshot({ path: resolved, fullPage });
  return path.relative(ctx.workspaceDir, resolved);
}

async function runStep(
  page: BrowserPage,
  step: BrowserStepInput,
  index: number,
  ctx: ToolContext,
  opts: BrowserToolOptions
): Promise<string> {
  const action = step.action ?? 'goto';
  const timeoutMs = asNumber(step.timeoutMs, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 120_000);
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  if (action === 'goto') {
    const checkedUrl = await validateUrl(
      step.url,
      'web_browser_control',
      opts.blockPrivateNetwork !== false
    );
    if (typeof checkedUrl === 'string') return `step ${index}: ${checkedUrl}`;
    await page.goto(checkedUrl.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return `step ${index}: goto ${checkedUrl.toString()}`;
  }
  if (action === 'click') {
    const selector = asString(step.selector).trim();
    if (!selector)
      return `step ${index}: web_browser_control 未执行: selector is required for click. Provide a CSS selector for the element to click, e.g., "button.submit" or "#login-btn".`;
    await page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
    await page.click(selector);
    return `step ${index}: click ${selector}`;
  }
  if (action === 'fill') {
    const selector = asString(step.selector).trim();
    if (!selector)
      return `step ${index}: web_browser_control 未执行: selector is required for fill. Provide a CSS selector for the input field, e.g., "input[name=email]" or ".search-box".`;
    await page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
    await page.focus(selector);
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('A');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.type(asString(step.value));
    return `step ${index}: fill ${selector}`;
  }
  if (action === 'press') {
    const key = asString(step.key).trim();
    if (!key)
      return `step ${index}: web_browser_control 未执行: key is required for press. Provide a keyboard key name, e.g., "Enter" or "Escape".`;
    await page.keyboard.press(key as any);
    return `step ${index}: press ${key}`;
  }
  if (action === 'wait') {
    const selector = asString(step.selector).trim();
    if (selector) {
      await page.waitForSelector(selector, { visible: true, timeout: timeoutMs });
      return `step ${index}: wait selector ${selector}`;
    }
    const waitMs = asNumber(step.waitMs, 1_000, 0, 60_000);
    if (waitMs <= 0)
      return `step ${index}: web_browser_control 未执行: wait requires either a CSS selector or waitMs > 0. Provide a CSS selector for the element to wait for visibility (e.g., ".modal"), or set waitMs to milliseconds to wait.`;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return `step ${index}: wait ${waitMs}ms`;
  }
  if (action === 'screenshot') {
    const saved = await saveScreenshot(page, step.path, ctx, opts, step.fullPage !== false);
    return `step ${index}: screenshot ${saved}`;
  }
  if (action === 'text') {
    const text = await page.evaluate(readInnerText);
    return `step ${index}: text\n${trimText(text, opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS)}`;
  }
  return `step ${index}: web_browser_control 未执行: unsupported action ${String(action)}.`;
}

export function createBrowserControlTool(opts: BrowserToolOptions = {}): Tool<BrowserControlInput> {
  return {
    name: 'web_browser_control',
    description:
      'Drive a real headless Chrome/Chromium browser with ordered steps: goto, click, fill, press, wait, screenshot, text.',
    metadata: {
      sideEffectClass: 'external_message',
      planMode: 'requires_user_confirmation',
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      permissionBoundary:
        'Can interact with external websites through a local browser; requires full-access policy and approval by default.',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['goto', 'click', 'fill', 'press', 'wait', 'screenshot', 'text'],
        },
        url: {
          type: 'string',
          description: 'URL for goto, or initial URL before other single actions.',
        },
        selector: { type: 'string', description: 'CSS selector for click/fill/wait actions.' },
        value: { type: 'string', description: 'Text for fill actions.' },
        key: { type: 'string', description: 'Keyboard key for press actions, e.g. Enter.' },
        path: { type: 'string', description: 'Workspace-relative screenshot path.' },
        waitMs: { type: 'number', description: 'Milliseconds for wait actions.' },
        timeoutMs: { type: 'number', description: 'Per-step timeout in milliseconds.' },
        fullPage: {
          type: 'boolean',
          description: 'Whether screenshots should capture the full page.',
        },
        steps: {
          type: 'array',
          description: 'Ordered browser steps. If omitted, action/url/etc. describe one step.',
          items: { type: 'object' },
        },
      },
    },
    async execute(input, ctx) {
      const steps =
        Array.isArray(input?.steps) && input.steps.length > 0
          ? input.steps
          : [{ ...input, action: input?.action ?? 'goto' }];
      const initialUrl = asString(input?.url).trim();
      const normalized =
        initialUrl && steps[0]?.action !== 'goto'
          ? [{ action: 'goto' as const, url: initialUrl }, ...steps]
          : steps;
      return withBrowser('web_browser_control', opts, async (browser) => {
        const timeoutMs = asNumber(
          input?.timeoutMs,
          opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          1_000,
          120_000
        );
        const page = await newPage(browser, opts, timeoutMs);
        const lines: string[] = [];
        let hasError = false;

        for (let i = 0; i < normalized.length; i++) {
          if (ctx.abortSignal?.aborted) {
            lines.push(`✗ step ${i + 1}: aborted`);
            hasError = true;
            break;
          }
          const result = await runStep(page, normalized[i] ?? {}, i + 1, ctx, opts);
          if (result.includes('未执行:')) {
            lines.push(`✗ ${result}`);
            hasError = true;
            break;
          }
          lines.push(`✓ ${result}`);
        }

        const extraWaitMs = asNumber(input?.extraWaitMs, 0, 0, 30_000);
        if (extraWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, extraWaitMs));

        const status = hasError ? '[web_browser_control_error]' : '[web_browser_control_ok]';
        return [status, ...lines, `final_url: ${page.url()}`].join('\n');
      }) as Promise<string>;
    },
  };
}

export function createBrowserTools(opts: BrowserToolOptions = {}): Tool[] {
  return [createBrowserFetchTool(opts), createBrowserControlTool(opts)];
}
