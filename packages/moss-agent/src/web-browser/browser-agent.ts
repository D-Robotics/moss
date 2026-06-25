/**
 * Web Browser Agent — orchestrates multi-step browser automation tasks.
 *
 * Provides a structured interface for the agent to:
 * 1. Navigate to URLs
 * 2. Extract page content (text, links, forms)
 * 3. Interact with page elements (click, fill, submit)
 * 4. Take screenshots for visual analysis
 * 5. Execute JavaScript in page context
 *
 * Built on top of the existing Puppeteer-based browser-tools.
 *
 * @public
 */

export type BrowserAction =
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' }
  | { type: 'click'; selector: string; timeoutMs?: number }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction?: 'down' | 'up'; amount?: number }
  | { type: 'wait'; ms: number }
  | { type: 'waitForSelector'; selector: string; timeoutMs?: number }
  | { type: 'screenshot'; path?: string; fullPage?: boolean }
  | { type: 'extract'; mode: 'text' | 'html' | 'links' | 'forms' | 'tables' }
  | { type: 'evaluate'; script: string }
  | { type: 'submit'; selector?: string };

export interface WebBrowserStep {
  /** Description of what this step does (for logging). */
  description: string;
  /** The action to perform. */
  action: BrowserAction;
}

export interface WebBrowserTask {
  /** High-level goal of the browsing task. */
  goal: string;
  /** Starting URL (optional — can be specified in the first step). */
  startUrl?: string;
  /** Ordered list of steps to execute. */
  steps: WebBrowserStep[];
  /** Maximum time for the entire task in ms (default 60s). */
  timeoutMs?: number;
  /** Whether to take a screenshot after each step. */
  screenshotPerStep?: boolean;
}

export interface WebBrowserResult {
  /** Whether the task completed successfully. */
  success: boolean;
  /** Final page URL. */
  finalUrl?: string;
  /** Extracted text content from the final page. */
  extractedText?: string;
  /** Extracted links as { text, href } pairs. */
  links?: Array<{ text: string; href: string }>;
  /** Extracted form fields. */
  forms?: Array<{ selector: string; type: string; name: string; placeholder?: string }>;
  /** Screenshot paths if any were taken. */
  screenshots?: string[];
  /** Per-step results for debugging. */
  stepResults?: Array<{ description: string; ok: boolean; output: string }>;
  /** Error message if the task failed. */
  error?: string;
  /** Total execution time in ms. */
  durationMs?: number;
}

export interface WebBrowserAgentConfig {
  /** Path to Chromium/Chrome executable. */
  executablePath?: string;
  /** Default navigation timeout in ms. */
  timeoutMs?: number;
  /** Whether to run in headless mode (default true). */
  headless?: boolean;
  /** Block requests to private network IPs (SSRF protection). */
  blockPrivateNetwork?: boolean;
  /** Custom user-agent string. */
  userAgent?: string;
  /** Directory for saving screenshots and artifacts. */
  artifactDir?: string;
  /** Maximum text characters to extract per page. */
  maxTextChars?: number;
}

// Browser context evaluate scripts (plain JS strings executed in page context)
const EVAL_EXTRACT_TEXT = `(() => {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, [aria-hidden="true"]').forEach(function(el) { el.remove(); });
  let content = clone.innerText || '';
  content = content.replace(/\\n{3,}/g, '\\n\\n').trim();
  return content;
})()`;

const EVAL_EXTRACT_LINKS = `(() => {
  const links = [];
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach(function(a) {
    const text = (a.innerText || a.title || '').trim().slice(0, 200);
    const href = a.href;
    if (text && href && !href.startsWith('javascript:')) {
      const key = text + '|' + href;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ text: text, href: href });
      }
    }
  });
  return links.slice(0, 200);
})()`;

const EVAL_EXTRACT_FORMS = `(() => {
  const fields = [];
  document.querySelectorAll('input, textarea, select').forEach(function(el) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : tag;
    const name = el.name || el.id || '';
    const placeholder = el.placeholder || undefined;
    let selector = '';
    if (el.id) selector = '#' + el.id;
    else if (el.name) selector = tag + '[name="' + el.name + '"]';
    else if (el.className) selector = tag + '.' + el.className.split(' ')[0];
    else selector = tag;
    fields.push({ selector: selector, type: type, name: name, placeholder: placeholder });
  });
  return fields;
})()`;

const EVAL_EXTRACT_TABLES = `(() => {
  const tables = document.querySelectorAll('table');
  const results = [];
  tables.forEach(function(t, i) {
    const rows = t.rows ? t.rows.length : 0;
    const cols = (t.rows && t.rows[0] && t.rows[0].cells) ? t.rows[0].cells.length : 0;
    results.push('Table ' + (i + 1) + ': ' + rows + ' rows x ' + cols + ' cols');
  });
  return results.join('\\n') || 'No tables found';
})()`;

const EVAL_SUBMIT_FORM = `((sel) => {
  const el = document.querySelector(sel);
  if (el && typeof el.submit === 'function') el.submit();
})`;

/**
 * High-level web browser agent that executes structured browsing tasks.
 *
 * Wraps Puppeteer to provide a task-oriented interface for the Moss agent.
 * Each task is a sequence of steps (navigate, click, fill, extract, screenshot)
 * executed in order against a headless browser.
 *
 * @public
 */
export class WebBrowserAgent {
  private config: Required<WebBrowserAgentConfig>;

  constructor(config: WebBrowserAgentConfig = {}) {
    this.config = {
      executablePath: config.executablePath ?? '',
      timeoutMs: config.timeoutMs ?? 30_000,
      headless: config.headless ?? true,
      blockPrivateNetwork: config.blockPrivateNetwork ?? true,
      userAgent: config.userAgent ?? '',
      artifactDir: config.artifactDir ?? '.moss/browser-artifacts',
      maxTextChars: config.maxTextChars ?? 50_000,
    };
  }

  /**
   * Execute a structured browsing task.
   */
  async executeTask(task: WebBrowserTask): Promise<WebBrowserResult> {
    const startTime = Date.now();
    const timeoutMs = task.timeoutMs ?? this.config.timeoutMs * 2;
    const stepResults: WebBrowserResult['stepResults'] = [];
    const screenshots: string[] = [];

    let puppeteer: any;
    try {
      // Dynamic import to avoid requiring puppeteer at module load time
      try {
        puppeteer = await import('puppeteer-core');
      } catch {
        return {
          success: false,
          error: 'puppeteer-core is not installed. Install it to use the Web Browser Agent.',
          durationMs: Date.now() - startTime,
        };
      }

      const launchOpts: Record<string, unknown> = {
        headless: this.config.headless ? 'new' : false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        timeout: timeoutMs,
      };

      if (this.config.executablePath) {
        launchOpts.executablePath = this.config.executablePath;
      }

      const browser = await puppeteer.default.launch(launchOpts);
      const page = await browser.newPage();

      try {
        if (this.config.userAgent) {
          await page.setUserAgent(this.config.userAgent);
        }

        // Navigate to start URL if provided
        if (task.startUrl) {
          await page.goto(task.startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.config.timeoutMs,
          });
        }

        // Execute each step
        for (const step of task.steps) {
          const stepResult = await this.executeStep(page, step);
          stepResults.push(stepResult);

          if (step.action.type === 'screenshot' && stepResult.output) {
            screenshots.push(stepResult.output);
          }

          if (!stepResult.ok) {
            return {
              success: false,
              finalUrl: page.url(),
              stepResults,
              screenshots,
              error: `Step "${step.description}" failed: ${stepResult.output}`,
              durationMs: Date.now() - startTime,
            };
          }
        }

        // Extract final page state
        const extractedText = await this.extractPageText(page);
        const links = await this.extractLinks(page);
        const forms = await this.extractForms(page);

        return {
          success: true,
          finalUrl: page.url(),
          extractedText,
          links,
          forms,
          screenshots: screenshots.length > 0 ? screenshots : undefined,
          stepResults,
          durationMs: Date.now() - startTime,
        };
      } finally {
        await browser.close();
      }
    } catch (err) {
      return {
        success: false,
        error: `Browser task failed: ${err instanceof Error ? err.message : String(err)}`,
        stepResults,
        screenshots,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async executeStep(
    page: any,
    step: WebBrowserStep,
  ): Promise<{ description: string; ok: boolean; output: string }> {
    try {
      const action = step.action;
      switch (action.type) {
        case 'navigate': {
          await page.goto(action.url, {
            waitUntil: action.waitUntil ?? 'domcontentloaded',
            timeout: this.config.timeoutMs,
          });
          return { description: step.description, ok: true, output: `Navigated to ${action.url}` };
        }
        case 'click': {
          await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? 5000 });
          await page.click(action.selector);
          return { description: step.description, ok: true, output: `Clicked ${action.selector}` };
        }
        case 'fill': {
          await page.waitForSelector(action.selector, { timeout: 5000 });
          await page.type(action.selector, action.value, { delay: 10 });
          return { description: step.description, ok: true, output: `Filled ${action.selector} with value` };
        }
        case 'select': {
          await page.select(action.selector, action.value);
          return { description: step.description, ok: true, output: `Selected "${action.value}" in ${action.selector}` };
        }
        case 'press': {
          await page.keyboard.press(action.key);
          return { description: step.description, ok: true, output: `Pressed ${action.key}` };
        }
        case 'scroll': {
          const dir = action.direction ?? 'down';
          const amount = action.amount ?? 300;
          await page.evaluate(
            `((d, a) => window.scrollBy(0, d === 'down' ? a : -a))`,
            dir, amount,
          );
          return { description: step.description, ok: true, output: `Scrolled ${dir} by ${amount}px` };
        }
        case 'wait': {
          await new Promise((resolve) => setTimeout(resolve, action.ms));
          return { description: step.description, ok: true, output: `Waited ${action.ms}ms` };
        }
        case 'waitForSelector': {
          await page.waitForSelector(action.selector, {
            timeout: action.timeoutMs ?? this.config.timeoutMs,
          });
          return { description: step.description, ok: true, output: `Found ${action.selector}` };
        }
        case 'screenshot': {
          const filename = action.path ?? `screenshot-${Date.now()}.png`;
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const dir = path.dirname(filename);
          if (dir && dir !== '.') {
            await fs.mkdir(dir, { recursive: true });
          }
          await page.screenshot({
            path: filename,
            fullPage: action.fullPage ?? false,
          });
          return { description: step.description, ok: true, output: filename };
        }
        case 'extract': {
          let output: string;
          switch (action.mode) {
            case 'text':
              output = await this.extractPageText(page);
              break;
            case 'html':
              output = await page.content();
              break;
            case 'links': {
              const links = await this.extractLinks(page);
              output = links.map((l: { text: string; href: string }) => `${l.text}: ${l.href}`).join('\n');
              break;
            }
            case 'forms': {
              const forms = await this.extractForms(page);
              output = forms.map((f: { selector: string; type: string; name: string; placeholder?: string }) =>
                `${f.type} ${f.name} (${f.selector})${f.placeholder ? ' placeholder="' + f.placeholder + '"' : ''}`,
              ).join('\n');
              break;
            }
            case 'tables': {
              output = await page.evaluate(EVAL_EXTRACT_TABLES);
              break;
            }
            default:
              output = 'Unknown extract mode';
          }
          return { description: step.description, ok: true, output };
        }
        case 'evaluate': {
          const result = await page.evaluate(action.script);
          const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { description: step.description, ok: true, output };
        }
        case 'submit': {
          if (action.selector) {
            await page.evaluate(`${EVAL_SUBMIT_FORM}('${action.selector.replace(/'/g, "\\'")}')`);
          } else {
            await page.keyboard.press('Enter');
          }
          return { description: step.description, ok: true, output: 'Submitted form' };
        }
        default:
          return { description: step.description, ok: false, output: `Unknown action type: ${(action as any).type}` };
      }
    } catch (err) {
      return {
        description: step.description,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async extractPageText(page: any): Promise<string> {
    try {
      const text: string = await page.evaluate(EVAL_EXTRACT_TEXT);
      return text.slice(0, this.config.maxTextChars);
    } catch {
      return '';
    }
  }

  private async extractLinks(page: any): Promise<Array<{ text: string; href: string }>> {
    try {
      const links: Array<{ text: string; href: string }> = await page.evaluate(EVAL_EXTRACT_LINKS);
      return links;
    } catch {
      return [];
    }
  }

  private async extractForms(
    page: any,
  ): Promise<Array<{ selector: string; type: string; name: string; placeholder?: string }>> {
    try {
      const fields: Array<{ selector: string; type: string; name: string; placeholder?: string }> =
        await page.evaluate(EVAL_EXTRACT_FORMS);
      return fields;
    } catch {
      return [];
    }
  }
}
